# Direct Reasoning Mode Architecture Split

**Status:** Archived historical implementation record. Future work is superseded by `../DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md`.
**Date:** 2026-04-23
**Supersedes:** Workstream 3 Phase 3A in INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md
**Superseded by:** `../DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md`

> Cleanup note (2026-04-24): Phases 1, 2, 2B, and 2C remain useful historical context for the current direct-reasoning split. Do not continue the standalone Phase 3 progressive-output plan from this file. Progressive output, hybrid read/write composition, run-timeline projection, and recovery should be implemented through the durable execution graph plan instead.

## Problem

Repo-inspection and coding tasks (e.g., "Inspect this repo and tell me which files implement X") were routed through the Delegated Orchestration pipeline: Intent Gateway → PlannedTask → Worker Session → Verifier. This pipeline works well for structured multi-step orchestration tasks, but it produces poor answers for repo-inspection/coding tasks because:

1. The model gets a single shot at the answer after a fixed search→read→answer sequence
2. The verifier can check structural correctness (file references exist, symbols are named) but cannot verify *semantic* correctness (the cited files are actually the implementation, not just search hits)
3. "Do not edit anything" was misclassified as a required step rather than an answer constraint
4. `shouldPreferFrontier` promoted repo-grounded tasks to frontier (gpt-4o), making managed cloud models (GLM 5.1) unavailable even though the iterative tool loop makes them perfectly capable

## Architecture Split

### Direct Reasoning Mode (new)
- Routes `repo_grounded`/`inspect` operations through an iterative tool-call loop
- Model has access to `fs_search`, `fs_read`, `fs_list` and can call them multiple times
- Answer constraints (`requiresImplementationFiles`, `requiresSymbolNames`, `readonly`) are injected into the system prompt as behavioral guidance
- Progressive output: model produces final text answer after iterative exploration
- Runs inside the brokered worker by default; LLM calls and tools are reached only through broker RPC
- Uses the execution profile selected by the supervisor, including explicit provider overrides
- Fails closed for the direct-reasoning turn when the loop exhausts its budget instead of falling through to delegated orchestration

### Delegated Orchestration Mode (existing)
- Continues to handle write/search/write, multi-step tasks, approval-gated operations
- Uses the worker result envelope plus supervisor-owned tool job evidence during verification, so degraded worker text cannot drop already-observed successful tool receipts
- Still gets frontier preference via `preferFrontierForRepoGrounded` when applicable

### Hybrid Phased Execution Mode (new)
- Handles requests that require both repo exploration and side effects, for example "Search `src/runtime` for X, then write a summary file"
- The supervisor acts as the execution-mode manager:
  1. Classify once through the Intent Gateway
  2. Build the delegated task contract from the gateway decision
  3. Detect read/search steps followed by write/tool steps
  4. Run an internal direct-reasoning exploration phase with read-only tools
  5. Reconcile the supervisor-owned tool job ledger into satisfied `StepReceipt`s
  6. Dispatch delegated orchestration with `priorSatisfiedStepReceipts` and a concise exploration handoff
- The direct phase is not user-visible final output. It is evidence-gathering for the delegated phase.
- The delegated phase remains the only phase allowed to write, request approvals, mutate files, or produce the final user-facing completion.
- Verification remains supervisor-owned: the final delegated envelope is reconciled with all tool jobs observed under the request id, including read/search jobs from the direct phase and write jobs from the delegated phase.

### Recovery Manager / Advisor Mode (new)
- Handles last-resort recovery when the normal direct or delegated path has already failed to produce a valid terminal result
- Uses an extra no-tools LLM call only for bounded advice, never for execution, approval, verification, or contract satisfaction
- Direct reasoning uses it to compose a final answer from already-collected tool evidence when the loop hit the turn or time budget before producing final prose
- Delegated orchestration uses it after deterministic verification fails and ordinary profile retry/escalation has not produced a sufficient envelope
- WorkerManager validates every advisor proposal deterministically before it becomes prompt guidance:
  - actions may target only verifier-unsatisfied planned step ids
  - the strategy must match the planned-step kind
  - suggested tools must be in the allowlist for that strategy
  - a `give_up`, malformed, overbroad, or mismatched proposal is rejected and the original failure remains authoritative
- Recovery guidance is only an additional prompt section for one bounded retry. The delegated worker still has to execute the missing tool step and return receipts; the verifier still decides success or failure.
- Trace stages are explicit: `recovery_advisor_started`, `recovery_advisor_completed`, and `recovery_advisor_rejected`

### Routing decision
1. The Intent Gateway classifies repo-inspection as `executionClass: 'repo_grounded'`, `operation: 'inspect'`
2. `selectExecutionProfile` calls `shouldPreferFrontier` → `wouldUseDirectReasoningMode()` → returns `true` → **skips frontier preference** → selects managed cloud tier
3. `shouldHandleDirectReasoningMode` checks the gateway decision:
   - `executionClass === 'repo_grounded'` or `operation === 'inspect'` on `coding_task` route
   - Not mutations (`create`/`update`), security analysis, or tool orchestration
   - Tier is not `'local'` (local models use delegated pipeline)
   - Not already handled by direct-assistant inline path
4. ChatAgent marks the worker request with `directReasoning: true`
5. WorkerManager dispatches that explicit direct-reasoning request to the brokered worker instead of starting a delegated job
6. If direct reasoning fails or times out, the response is a controlled direct-reasoning failure, not an automatic delegated retry

For hybrid requests, step 4 does not set `directReasoning: true` as the terminal mode. Instead, WorkerManager keeps the delegated job as the owner and inserts a read-only direct-reasoning phase before the delegated write phase. This is deliberate: writes need the orchestration contract, approvals, run timeline, and verifier; large-repo exploration needs the iterative direct reasoning loop.

### Execution Mode Manager

WorkerManager owns execution-mode composition because it is the first layer that has all required context in one place:

- The Intent Gateway decision and delegated task contract
- The selected execution profile and explicit provider override
- Brokered worker dispatch
- Delegated job lifecycle, run timeline, audit logging, and verification
- The supervisor-owned tool job ledger used for evidence reconciliation

The manager chooses one of three shapes:

| Shape | Condition | Execution |
|-------|-----------|-----------|
| Pure direct reasoning | Read-only repo-grounded inspection/search | Brokered direct reasoning loop, final answer returned directly |
| Pure delegated orchestration | Mutations, approvals, security, automation, or ordinary planned tool execution | Delegated worker pipeline with verifier |
| Hybrid phased execution | Required read/search exploration plus required write/tool side effects | Direct reasoning read phase, then delegated mutation phase with carried-forward receipts |

When one of those shapes fails late, the manager may perform one recovery-advisor hop. That hop does not create a fourth execution shape; it is a bounded repair attempt attached to the current shape and current request id.

The hybrid phase must preserve the security boundary:

- Direct reasoning keeps the read-only tool set (`fs_search`, `fs_read`, `fs_list`)
- The supervisor derives satisfied read/search receipts from observed tool jobs, not from model prose
- Delegated orchestration receives only dependency-satisfied receipts; answer steps are not carried forward
- The delegated worker still has to execute the remaining write/approval/tool steps and return a typed envelope
- A degraded worker envelope cannot erase successful supervisor-observed tool evidence

### Execution-mode-aware tier selection (key architecture)

The tier selection pipeline:

```
incoming-dispatch.ts
  → selectExecutionProfile({ gatewayDecision, mode: 'auto' })
    → resolveSelectedTier()
      → chooseExternalTier()
        → shouldPreferFrontier()
          → wouldUseDirectReasoningMode(decision)?
            → yes: return false (skip frontier, use managed cloud)
            → no: check preferFrontierForRepoGrounded, security, quality_first...
        → if not frontier: shouldPreferManagedCloud() or default to managed_cloud
  → ctx.llm = managed cloud provider (e.g., GLM 5.1 on ollama-cloud)
```

The `wouldUseDirectReasoningMode()` function mirrors the logic in `shouldHandleDirectReasoningMode` but without the tier check (since tier isn't resolved yet at this point). It determines the execution mode from the gateway decision:
- Repo-grounded + read-like operation → direct reasoning → skip frontier
- Mutations, security analysis, tool orchestration → delegated pipeline → frontier preference applies

**Why not use `preferredAnswerPath` for this?** `preferredAnswerPath` describes answer structure (how the result is presented), not execution strategy (how the model arrives at the result). Conflating them means every new execution mode pollutes the gateway type. Computing execution mode locally in `chooseExternalTier` keeps the concerns separated — the gateway classifies intent, the profile resolver determines tier based on that intent and the execution mode it implies.

### Config override behavior

| Config | Effect on direct reasoning | Effect on delegated pipeline |
|--------|---------------------------|----------------------------|
| `preferFrontierForRepoGrounded: true` (default) | **No effect** — `wouldUseDirectReasoningMode` returns false before this flag is checked | Frontier preference applies normally |
| `preferFrontierForRepoGrounded: false` | No effect (already not frontier) | No frontier preference for repo-grounded tasks |
| `autoPolicy: 'quality_first'` | **No effect** — direct reasoning tasks bypass quality_first escalation | Quality-first forces frontier for high-pressure synthesis |
| Provider dropdown: explicit provider | **Always wins** — `forcedProviderName` bypasses `selectExecutionProfile` entirely | Same — explicit choice always wins |
| `preferFrontierForSecurity: true` | **No effect** — security analysis never routes through direct reasoning | Frontier preference for security tasks |

The key guarantee: **automatic tier selection routes direct reasoning tasks to managed cloud, but explicit user choice (provider dropdown) always wins.**

## Implementation Phases

### Phase 1: Routing ✅
- Added `shouldHandleDirectReasoningMode` function (now in `direct-reasoning-mode.ts`)
- Exported `isReadLikeOperation` from `orchestration-role-contracts.ts` with null guard
- Added routing check in main dispatch before delegated worker
- Added `wouldUseDirectReasoningMode()` in `execution-profiles.ts` to make tier selection execution-mode-aware
- Updated `shouldPreferFrontier` to skip frontier preference for direct reasoning tasks
- Updated 3 test files to reflect managed_cloud routing for repo-inspection
- **Files:** `src/runtime/direct-reasoning-mode.ts`, `src/runtime/orchestration-role-contracts.ts`, `src/runtime/execution-profiles.ts`, `src/runtime/execution-profiles.test.ts`, `src/runtime/incoming-dispatch.test.ts`, `src/runtime/runtime.test.ts`

### Phase 2: Direct Reasoning Loop ✅
- Extracted all direct reasoning methods to `src/runtime/direct-reasoning-mode.ts`
- `handleDirectReasoningMode` — orchestrates system prompt, tool set, loop execution, quality check
- `buildDirectReasoningSystemPrompt` — builds repo-inspection system prompt with answer-constraint guidance and explicit search→read→answer process
- `buildDirectReasoningToolSet` — provides `fs_search`, `fs_read`, `fs_list` as `ToolDefinition[]`
- `executeDirectReasoningLoop` — iterative brokered tool-call loop (up to 8 turns) using injected chat/tool dependencies
- `executeDirectReasoningToolCall` — executes tool calls, formats `output` data readably for model consumption
- `runDirectReasoningQualityCheck` — lightweight structural verification using `deriveAnswerConstraints`
- Added trace stages: `direct_reasoning_started`, `direct_reasoning_tool_call`, `direct_reasoning_completed`, `direct_reasoning_failed`
- Worker-side execution delegates to the extracted module via `DirectReasoningDependencies`
- ChatAgent only selects the route and passes an explicit direct-reasoning flag to WorkerManager; the old supervisor-side implementation was removed
- 150-second overall time budget and 60-second per-call budget to stay below the 300-second agent budget timeout
- **Files:** `src/runtime/direct-reasoning-mode.ts`, `src/chat-agent.ts`, `src/worker/worker-session.ts`, `src/supervisor/worker-manager.ts`, `src/broker/broker-client.ts`, `src/broker/broker-server.ts`, `src/runtime/intent-routing-trace.ts`

### Phase 2B: Hybrid Execution Manager ✅
- WorkerManager detects delegated task contracts containing required read/search steps plus required write/tool steps
- The manager derives a read-only gateway record for the direct-reasoning exploration phase without reclassifying the user request
- The direct phase runs inside the brokered worker with the same isolation guarantees as pure direct reasoning
- After the direct phase, WorkerManager drains the request's tool job ledger and converts successful read/search jobs into `priorSatisfiedStepReceipts`
- The delegated write phase receives those receipts plus a "Hybrid Direct Reasoning Handoff" context section, so it can write from grounded evidence instead of repeating large-repo discovery
- Final verification reconciles the delegated envelope with all observed tool jobs under the request id
- **Files:** `src/supervisor/worker-manager.ts`, `src/supervisor/worker-manager.test.ts`

### Phase 2C: Recovery Manager ✅
- Direct reasoning reserves final-answer budget after tool evidence is available so tool exploration cannot consume the entire request budget
- If direct reasoning collects tool evidence but stops before final prose, it performs one no-tools final-response recovery call grounded only in the existing conversation/tool transcript
- Delegated orchestration can request one recovery-advisor proposal after deterministic verification fails and ordinary retry/escalation has not repaired the missing evidence
- Recovery-advisor proposals are parsed and validated in `src/runtime/execution/recovery-advisor.ts`; only validated advice becomes a prompt section
- Advisor calls run through the brokered worker with no tools and JSON response format
- The verifier remains authoritative. Recovery guidance cannot mark a step satisfied, approve a blocked action, bypass sandbox policy, or erase required receipts.
- **Files:** `src/runtime/execution/recovery-advisor.ts`, `src/runtime/execution/recovery-advisor.test.ts`, `src/runtime/direct-reasoning-mode.ts`, `src/worker/worker-session.ts`, `src/supervisor/worker-manager.ts`

### Phase 3: Progressive Output (in design)
- **Goal:** Stream tool-call progress during the direct reasoning loop so the user sees live activity instead of a blank screen during multi-turn search/read cycles
- **Discovery:** The initial attempt to wire `emitSSE` through `AgentContext` was reverted. Here's why and what was learned:

#### What was attempted
Added `emitSSE` to `AgentContext`, passed it through `DirectReasoningDependencies`, and called it from the loop body to emit `chat.thinking` events after each tool call and before composing the final answer.

#### Why it was reverted
1. **Type impedance:** The dashboard callbacks `emitSSE` is typed `(event: SSEEvent) => void` where `SSEEvent.type` is a strict string union. The `AgentContext` (used by all channels including CLI) can't depend on web-specific SSE types without creating a circular dependency or a leaky abstraction.
2. **Coupling across layers:** Adding `emitSSE` to `AgentContext` means the agent layer depends on the web dashboard layer's event types. This violates the architecture — `AgentContext` is a runtime-level interface, not a channel-level one.
3. **Channel divergence:** CLI and web have very different rendering capabilities. CLI could use `console.log` or spinner updates; web uses SSE events. Neither should dictate the other's interface.
4. **The function exists but is unused:** `getActiveSSEEmitter()` was added inside `dashboard-runtime-callbacks.ts` closure to access the active stream's SSE emitter, but it's not exported or wired. It was the right intuition (the dispatch layer has the emitter) but the threading was wrong.

#### Architecture for progressive output (planned)

The correct approach follows the existing pattern for `onStreamDispatch`:

```
onStreamDispatch receives emitSSE at the dashboard callbacks layer
  → dispatchDashboardMessage calls into ChatAgent.handleDirectReasoningMode
    → handleDirectReasoningMode runs the loop
    → Loop emits progress via a callback/channel-level interface
  → The callback is wired at the dispatch layer, not injected through AgentContext
```

**Option A: Channel-agnostic callback on DirectReasoningDependencies**
Add an `onProgress` callback to `DirectReasoningDependencies`:
```typescript
interface DirectReasoningDependencies {
  // ... existing fields ...
  onProgress?: (event: DirectReasoningProgressEvent) => void;
}

type DirectReasoningProgressEvent =
  | { type: 'tool_call_start'; tool: string; args: Record<string, unknown>; turn: number }
  | { type: 'tool_call_result'; tool: string; resultPreview: string; turn: number }
  | { type: 'composing_answer'; turn: number };
```
The dashboard callbacks layer adapts `onProgress` to `emitSSE`; the CLI adapts it to `console.log` or spinner updates. No web types leak into the runtime.

**Option B: Use the existing routing trace for real-time events**
The `IntentRoutingTraceLog` already exists in the dependencies. Add streaming event emission alongside trace recording, and have the dashboard callbacks layer subscribe to trace events. Less clean — trace is diagnostic, not UX.

**Recommended: Option A** — the `onProgress` callback keeps dependencies clean, makes channel adaptation explicit, and doesn't pollute either `AgentContext` or the trace system with UX events. The `DirectReasoningDependencies` interface is already the injection point for channel-specific behavior.

#### Wiring path (web UI)

```
dashboard-runtime-callbacks.ts onStreamDispatch
  → receives emitSSE parameter
  → ChatAgent.handleDirectReasoningMode deps include:
      onProgress: (event) => {
        const sseType = progressEventToSSEType(event.type);
        emitSSE({ type: sseType, data: { requestId, ...event } });
      }
  → executeDirectReasoningLoop calls deps.onProgress after each tool call
  → web chat-panel.js renders chat.thinking / chat.tool_call events
```

#### Wiring path (CLI)

```
channels/cli.ts dispatch path
  → creates a CLI-specific onProgress that prints to stdout
  → e.g., tool_call_start → "🔍 Searching: query=..."
  → e.g., tool_call_result → "📄 Read: src/runtime/execution-profiles.ts"
  → composing_answer → "✍️ Composing answer..."
```

#### Frontend rendering (web UI)

The web chat panel already handles `chat.thinking` and `chat.done` SSE events. The progressive events would extend this:
- `chat.thinking` with `detail: "Searching: fs_search(query=...)"` — shown as a thinking indicator with tool description
- `chat.tool_call` with tool name and result preview — shown as a collapsible tool-result card
- `chat.thinking` with `detail: "Composing final answer..."` — shown before the final response arrives

The `SSEEvent` type already includes `chat.thinking` and `chat.tool_call` in its type union, so no web-types changes are needed. The `direct_reasoning_tool_call` trace stage can also be rendered in the system tab's run timeline.

### Phase 4: Documentation ✅
- Updated `INTENT-GATEWAY-ROUTING-DESIGN.md` with direct reasoning mode routing
- Updated `TOOLS-CONTROL-PLANE-DESIGN.md` with direct reasoning mode tool set visibility
- Updated web UI config hint for `preferFrontierForRepoGrounded`
- Updated `reference-guide.ts` to mention repo inspection uses managed cloud with iterative loop

## Key Design Decisions

1. **Answer constraints as prompt guidance, not verification gates.** The direct reasoning mode injects `requiresImplementationFiles`, `requiresSymbolNames`, and `readonly` as behavioral instructions in the system prompt. The lightweight quality check after the loop appends warnings but does not block the response.

2. **No automatic direct-to-delegated fallback for pure direct turns.** A pure direct-reasoning budget failure is terminal for that turn and is reported as a direct-reasoning failure. Hybrid phased execution is different: it is selected up front from the task contract, so the delegated phase is not a fallback after direct failure; it is the planned mutation phase.

3. **Provider selection is stable.** Direct reasoning uses the selected execution profile and does not run delegated escalation logic. Automatic tier selection still favors managed cloud for this mode, while explicit provider selection still wins.

4. **Read-only tool set.** The direct reasoning tool set (`fs_search`, `fs_read`, `fs_list`) is intentionally read-only. This matches the `readonly` answer constraint for repo-inspection tasks and prevents the model from making changes during an inspection request.

5. **Knowledge base injection.** The system prompt includes `globalContent`, `codingMemoryContent`, and knowledge-base material from `loadPromptKnowledgeBases`, giving the model the same context that the delegated pipeline uses.

6. **Execution-mode-aware tier selection.** `shouldPreferFrontier` calls `wouldUseDirectReasoningMode()` which computes the execution mode from the gateway decision. Direct reasoning tasks (iterative tool loop) skip frontier preference and use managed cloud — the loop compensates for model capability. Delegated tasks (one-shot contract) still get frontier preference where configured. This avoids conflating `preferredAnswerPath` (answer structure) with execution mode (routing strategy).

7. **Tool result formatting.** Tool outputs from `executeModelTool` are formatted as human-readable text (file paths, content, directory listings) instead of raw JSON. This lets the model reason over structured data like search matches and file contents, not opaque JSON blobs. The model was previously getting `undefined` from `result.message` — the correct field is `result.output`, which contains structured data that must be formatted per tool type.

8. **Config overrides respect execution mode.** `preferFrontierForRepoGrounded` and `autoPolicy: 'quality_first'` do not affect direct reasoning tasks — the execution mode check at the top of `shouldPreferFrontier` short-circuits before those flags are evaluated. Explicit provider selection (dropdown override) always wins regardless.

9. **Time budgets and turn limits.** The iterative loop is capped at 8 turns with a 150-second overall time budget and a 60-second per-call budget. This prevents the 300-second agent budget timeout from killing repo-inspection requests. The limit is enforced before each LLM call, and the LLM call receives an abort signal where the provider supports it.

10. **Brokered isolation boundary.** Direct reasoning is an execution mode inside the brokered worker, not a supervisor-side tool shortcut. The worker has no direct `Runtime`, `ToolExecutor`, or channel-adapter access. It calls `llm.chat` and read-only tools over broker RPC, and it sends trace events back through `trace.record`.

11. **Progressive output via dependencies, not AgentContext.** The `onProgress` callback pattern on `DirectReasoningDependencies` is the correct approach for progressive output, not threading `emitSSE` through `AgentContext`. This keeps the runtime layer channel-agnostic and lets each channel (web/CLI) adapt progress events to its own rendering model. The dashboard callbacks layer already receives `emitSSE` from `onStreamDispatch` and can wrap it into an `onProgress` callback without polluting any shared interfaces.

12. **Hybrid manager instead of binary routing.** The split is not "direct reasoning or orchestration forever." The correct abstraction is an execution-mode manager that can compose read-only direct reasoning with delegated mutation under one request id, one audit/timeline flow, and one final verifier. This preserves the reason the split exists (iterative repo exploration) without weakening the orchestration controls needed for writes.

13. **Recovery advice is advisory, not authoritative.** The extra LLM call is allowed only after a path is already stuck. It may suggest a bounded retry focus, but deterministic code validates the proposal and the normal verifier still requires real evidence receipts. This keeps the system more resilient without converting "model says it is fixed" into completion authority.

## Completed Changes — Phase 1, 2, And 2B

Files modified/created:

| File | Change |
|------|--------|
| `src/runtime/direct-reasoning-mode.ts` | **New** — extracted broker-friendly module with all direct reasoning logic |
| `src/runtime/orchestration-role-contracts.ts` | Exported `isReadLikeOperation` with null guard |
| `src/runtime/execution-profiles.ts` | Added `wouldUseDirectReasoningMode()`, updated `shouldPreferFrontier` |
| `src/runtime/execution-profiles.test.ts` | Updated tier expectations for repo-inspection (frontier→managed_cloud), added 2 new tests |
| `src/runtime/incoming-dispatch.test.ts` | Updated 2 test expectations (frontier→managed_cloud) |
| `src/runtime/runtime.test.ts` | Updated 1 test expectation (parentProfile frontier→managed_cloud) |
| `src/runtime/intent-routing-trace.ts` | Added direct reasoning trace stages including failure |
| `src/runtime/execution/recovery-advisor.ts` | Bounded recovery advisor parser, validator, and deterministic prompt-section builder |
| `src/chat-agent.ts` | Selects direct reasoning and passes an explicit flag to WorkerManager; removed the old supervisor-side direct loop |
| `src/worker/worker-session.ts` | Runs direct reasoning inside the brokered worker with brokered LLM/tool dependencies |
| `src/worker/worker-session.ts` | Runs no-tools recovery-advisor requests through the brokered worker |
| `src/supervisor/worker-manager.ts` | Dispatches explicit direct-reasoning worker requests without delegated job verification/retry |
| `src/supervisor/worker-manager.ts` | Adds hybrid phased execution for read/search plus write/tool requests |
| `src/supervisor/worker-manager.ts` | Owns recovery-advisor dispatch, deterministic validation, retry guidance, and trace stages |
| `src/broker/broker-client.ts` / `src/broker/broker-server.ts` | Added worker-to-supervisor trace forwarding and preserved tool request context such as `surfaceId`, `activeSkills`, and `toolContextMode` |
| `docs/plans/archive/DIRECT-REASONING-MODE-ARCHITECTURE-SPLIT.md` | This archived document |
| `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md` | Updated 3 sections to note direct reasoning mode bypasses frontier |
| `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md` | Added section on Direct Reasoning Mode tool set |
| `web/public/js/pages/config.js` | Updated `preferFrontierForRepoGrounded` description |
| `src/reference-guide.ts` | Updated auto-selection description for repo inspection |

### Reverted changes (not shipped)
- `AgentContext.emitSSE` — was added and reverted; progressive output will use `onProgress` on `DirectReasoningDependencies` instead
- `dashboard-runtime-callbacks.ts getActiveSSEEmitter()` — was added and removed; the emitter will be passed through `onStreamDispatch` as a dependency instead
- `DirectReasoningDependencies.emitSSE` and `requestId` — was added and reverted; will be replaced with `onProgress` callback
- `summarizeToolArgs` helper — was added to direct-reasoning-mode.ts and removed; will be needed again for `onProgress` event payloads

## Manual Web Baseline

Test these prompts in the web UI to verify the architecture:

1. **Repo inspection (primary target):** "Inspect this repo and tell me which files and functions define the delegated worker completion contract. Cite exact file names and symbol names."
   - Expected: Uses managed cloud (GLM 5.1), iterative search/read loop, grounded answer with file paths and symbol names

2. **Repo inspection with readonly constraint:** "Inspect this repo and tell me which files implement delegated worker progress and run-timeline rendering. Do not edit anything."
   - Expected: Uses managed cloud, read-only exploration, no file modifications

3. **Simple chat (regression check):** "Just reply hello back"
   - Expected: Simple reply, no tool calls, no quality warnings

4. **Multi-step orchestration (regression check):** "Write the current date and time to tmp/manual-web/current-time.txt. Search src/runtime for planned_steps. Write a short summary to tmp/manual-web/planned-steps-summary.txt."
   - Expected: Delegated worker pipeline, writes two files, remains stable

5. **Explicit provider override:** Set the coding assistant dropdown to a specific provider (e.g., anthropic), then run: "Which files define the IntentGateway route classifier?"
   - Expected: Uses the explicitly selected provider regardless of auto-tier logic
