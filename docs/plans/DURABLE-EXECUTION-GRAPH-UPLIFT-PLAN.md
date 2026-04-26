# Durable Execution Graph Uplift Plan

**Status:** Architecture refinement and refactoring phase. Phases 1-4 are implemented for the read-only graph/artifact lane and the first graph-controlled search/write slice. Phase 5+ approval/continuation and delegated graph cleanup are partially implemented, but the current risk is no longer missing primitives. The risk is overlapping orchestration ownership between `ChatAgent`, `WorkerManager`, pending actions, continuity, execution records, and the graph. The next phase must make graph ownership explicit and delete each legacy owner as its replacement lands.
**Date:** 2026-04-26
**Supersedes for future work:**
- `docs/plans/archive/DIRECT-REASONING-MODE-ARCHITECTURE-SPLIT.md`
- `docs/plans/archive/INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md`

## Purpose

Guardian's direct-reasoning/delegated-orchestration split improved several symptoms, but the manual web tests show the split is still too binary. Direct reasoning can perform iterative read/search, and delegated orchestration can perform writes, approvals, and verification, but hybrid requests still depend on fragile prose handoffs and separate observability paths.

This plan replaces the binary split with a durable execution graph. Direct reasoning, synthesis, writes, approvals, delegation, verification, and recovery become typed graph nodes under one request id, one artifact flow, one run timeline, and one security boundary.

This is not a request to import LangGraph, Temporal, or another framework. The plan adopts the durable-workflow patterns that those systems use, while preserving Guardian's existing TypeScript runtime, Intent Gateway, brokered worker boundary, Guardian policy layer, and approval system.

## Current Implementation State

As of 2026-04-24:

- Phase 1 graph kernel and event projection are implemented: execution graph types, event types, bounded store, run-timeline adapter, and focused tests.
- Phase 2 direct reasoning as an `explore_readonly` graph node is implemented: direct reasoning emits graph events, read/search tool calls project into `RunTimelineStore`, and focused direct-reasoning/run-timeline tests pass.
- Phase 3 typed artifact store and grounded synthesis are implemented for the read-only lane: graph-owned artifact storage retains typed artifact contents and refs, direct reasoning emits `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft` artifacts, and no-tools synthesis consumes bounded evidence artifacts.
- Phase 4 mutation nodes are implemented for the first structured search/write lane: required write steps now keep top-level requests out of read-only direct reasoning, route read-like coding plans with structured writes to workspace implementer orchestration, synthesize `WriteSpec`, execute `fs_write` through supervisor-owned tool execution, and verify the written contents.
- The read-only manual/API lane has proven the harder repo-inspection prompts on `ollama-cloud-coding` / `glm-5.1` without frontier escalation, including "files implementing run timeline rendering" and "which web pages consume `run-timeline-context.js`".
- Exact-file synthesis coverage for reverse dependency/consumer questions is handled in evidence selection, synthesis coverage, path canonicalization, and gateway recovery normalization, not by intent-routing keyword interception.
- Do not move to broader hybrid write behavior until this read-only/artifact lane remains stable through a broader manual web UI pass and the focused verification commands below.

### 2026-04-26 Handoff Status

The latest work focused on orchestration quality, evidence grounding, provider fallback, continuation, and approval-resume recovery. These changes are intentionally in shared routing/orchestration/verifier layers, not keyword intent-routing band-aids.

Implemented in the current dirty worktree:

- Structured task-plan category matching now lets evidence tools satisfy semantic planned-step categories such as `repo_inspect`, `web_search`, and answer/model-answer steps without adding pre-gateway keyword routing.
- Direct reasoning now refuses non-read-only planned evidence, retries when a repo-grounded answer appears before read/search evidence, treats weak/empty search evidence as insufficient, and defaults brokered `fs_search` calls to content search when the model omits a mode.
- Grounded answer synthesis fallback now runs as a no-tools LLM pass over collected evidence when tool execution succeeded but the delegated worker failed to produce a final answer.
- Approval-continuation recovery now carries approved tool results into the resumed tool loop and can synthesize a final answer from those approved tool receipts if the first resumed model turn is empty.
- Intent Gateway confirmation guidance now makes mixed web+repo requests produce concrete planned steps (`web_search`, `repo_inspect`, answer) so direct read-only reasoning does not accidentally absorb external research requests.
- Managed-cloud classifier fallback now tries other configured managed-cloud providers when the preferred classifier/profile is unavailable or rate limited.

Verified locally after these changes:

- Focused Vitest slices passed for direct reasoning, task-plan/verifier, worker-manager, worker-session, tool-loop resume, confirmation pass, intent gateway, and incoming dispatch fallback.
- `npm run check` passed.
- `npm run build` passed.
- Live API replay passed the core read-only ladder for:
  - "Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything."
  - "Inspect this repo and tell me which web pages consume run-timeline-context.js. Do not edit anything."
  - "Inspect this repo and tell me which files implement direct reasoning graph artifacts. Do not edit anything."
- Live API replay for web+repo comparison succeeded with a planned `web_search` + `repo_inspect` + answer contract and satisfied delegated verification.
- Live scratch-file write to `tmp/manual-web/approval-resume-smoke.txt` succeeded, but it did not request approval because the current policy allowed that path/action.

Known remaining problems and risks:

- A live gated approval-resume test is still outstanding. The latest scratch write proved mutation execution, not approval pause/resume, because policy allowed the write without an approval interrupt.
- Follow-up continuity is improved but not fully proven. A follow-up like "Based on your last answer..." can now recover a useful answer, but one replay selected `src/runtime/execution-graph/pending-action-adapter.ts` as the approval-continuity file. That answer is defensible for graph pending actions, but the expected answer may be closer to `approval-continuations.ts`, `tool-loop-resume.ts`, or `approval-state.ts` depending on which previous answer the user meant. This needs explicit conversation-history/evidence anchoring tests.
- One replay still showed an unstructured repair path for a follow-up after the classifier returned malformed prose. The system recovered, but this path should be audited before adding more complexity.
- The full `npm test` suite has not been rerun after the latest continuation/provider-fallback fixes. It must run before commit.
- The web UI approval experience still needs a manual pass once a policy-gated action is identified reliably.

Recommended next slice before moving into the broader web UI phase:

1. Identify or configure a harmless action that is definitely approval-gated under the current dev policy, then run a live web/API approval-resume smoke that proves pending action creation, decision submission, tool execution, and continuation response.
2. Add/strengthen tests for follow-up anchoring against the immediately previous answer and its evidence artifacts, especially "based on your last answer" questions.
3. Audit the unstructured repair path seen in the follow-up replay and either make it produce a structured Intent Gateway decision or fail into the existing clarification/recovery path.
4. Run `npm test`, then rerun the short live API replay ladder.
5. Commit only after the above passes or after explicitly documenting any remaining failures in this plan.

### 2026-04-26 Architecture Refinement And Debt-Burn Phase

The architecture audit found that Guardian now has most of the necessary primitives, but several partial systems still own the same lifecycle decisions. The next phase is a refactor and deletion phase, not a feature expansion phase.

Root ownership problems to resolve:

- `ChatAgent` still owns normal turn orchestration, approval resume, direct-route dispatch, tool-loop resume, retry/continuation repair, and response shaping.
- `WorkerManager` still owns delegated execution, retries, recovery advice, graph setup, and graph persistence instead of acting as a graph node runner.
- `PendingActionStore`, `ExecutionStore`, `ContinuityThreadStore`, `ExecutionGraphStore`, and `RunTimelineStore` each hold part of the same execution lifecycle without one authoritative owner.
- Approval continuity is split across pending actions, live `ToolExecutor` approvals, in-memory suspended worker sessions, direct-route resumes, tool-loop resumes, worker-session automation continuations, and graph suspensions.
- Continuity still has semantic recovery authority in places. It must become context projection over active execution refs and artifacts, not a source of reconstructed intent.
- Routing and repair are split between pre-dispatch gateway handling, `ChatAgent` classification, direct candidate routing, and delegated retry/recovery.
- Provider fallback is distributed across failover providers, model fallback chains, execution profile selection, classifier retry loops, dashboard fallback, and delegated escalation.

Refactoring rules for this phase:

- Every slice must remove the legacy owner it replaces in the same commit. Do not leave a compatibility path for old behavior once a graph-owned path exists.
- Temporary adapters are allowed only inside an unfinished local edit. They must not survive the commit for that slice.
- Pending actions remain the only durable blocked-work contract. New approval, clarification, auth, policy, workspace, and missing-context pauses must be graph interrupts.
- Continuity may select and summarize active context, but it must not rewrite user content, infer intent from prose, or override the Intent Gateway.
- The Intent Gateway decision produced by shared dispatch is the turn's semantic authority. Any classifier recovery must produce a structured gateway decision or fall into clarification.
- The execution graph owns node completion, artifacts, verification, interrupts, recovery, and finalization for every non-trivial request.
- Provider fallback decisions must be expressed through execution profile/runtime orchestration and recorded as execution or graph events.
- Timeline rendering must consume runtime/graph events, not parallel bespoke progress feeds.
- Tests and harnesses are part of each slice. Do not defer broken brittle expectations, startup drift, or web/API smoke drift to a later cleanup.

Refactor sequence:

1. Establish graph-owned approval resume as the first hard boundary.
   - Prove a policy-gated harmless write creates a graph interrupt, stores the pending action, resumes through the graph, writes the mutation receipt, verifies the result, and finalizes once.
   - Delete the parallel new-path approval resume logic for that flow as part of the slice.

2. Add a thin graph controller boundary and move graph-capable dispatch behind it.
   - `ChatAgent` should hand the structured request to the controller and render the result.
   - `WorkerManager` should run delegated/exploration nodes requested by the controller.
   - Delete duplicate control-flow decisions from callers as they move behind the controller.

3. Collapse approval and resume state.
- Remove `suspendedSessions`, approval follow-up maps, worker-session automation continuation state, direct-route resume state, and tool-loop resume state as graph equivalents land.
   - Pending actions should carry graph interrupt identity and artifact refs, not opaque model-message replay blobs.

4. Demote continuity to context projection.
   - Follow-ups such as "based on your last answer" must resolve through active execution refs, graph artifacts, and answer evidence.
   - Remove regex/prose continuation repair that manufactures semantic intent outside the gateway.

5. Centralize routing repair and provider fallback.
   - Keep one Intent Gateway classification/repair decision per turn.
   - Move malformed classifier recovery into structured recovery or clarification.
   - Keep provider fallback ordering in execution profile/runtime services and remove duplicate retry policy from call sites as they are migrated.

6. Make delegated work graph-native.
   - Delegated workers become node runners that emit node events/artifacts.
   - Move required-step verification, retry, recovery proposal, and terminal state into graph nodes.
   - Delete delegated handoff/retry side channels once node-runner behavior passes the harnesses.

7. Normalize observability.
   - Run timeline should display graph/runtime events for direct reasoning, delegated workers, approval interrupts, recovery, verification, and finalization.
   - Remove duplicate progress feeds that describe the same lifecycle.

8. Run the app-facing regression loop after each meaningful slice.
   - Run focused Vitest first, then `npm run check`, then the relevant script harness.
   - For approval/continuity/routing slices, run the web/API replay loop from `docs/guides/INTEGRATION-TEST-HARNESS.md`.
   - Update brittle tests, startup scripts, and operator docs in the same slice when behavior changes.

Checkpoint after the first approval/resume debt-burn slice:

- Chat-agent tool-loop approvals no longer keep an in-memory suspended-session replay cache. The durable `PendingActionRecord.resume` payload is the resume source for chat-level tool-loop approval continuation.
- The old suspended approval scope helpers were removed with their tests; pending actions now own blocked-work lookup for chat approvals.
- CLI and Telegram no longer synthesize a replay turn when the approval decision API already returns an explicit continuation directive. Direct continuation responses and pending-action resume metadata are authoritative for those flows.
- Remaining approval/resume overlap after this slice: worker-manager direct automation continuations, worker-session automation continuations, worker suspended approvals, direct-route resume payloads, and tool-loop resume payloads still need graph interrupt equivalents before they can be deleted.

Checkpoint after the chat automation-resume debt-burn slice:

- Chat automation authoring remediation approvals now write a `direct_route` pending-action resume payload with `type: "automation_authoring"` instead of registering an in-memory ChatAgent continuation.
- `approval-orchestration.ts` no longer owns a special automation retry path. Final approval resolution falls through to the shared pending-action direct-route resume path.
- `direct-route-runtime.ts` dispatches stored automation-authoring resume payloads to `automation-authoring-resume.ts`, which reconstructs the authoring request from pending-action metadata and can create another pending action if follow-up remediation approvals are needed.
- The temporary `automation-approval-continuation.ts` module and tests were deleted. The next debt-burn step was to apply the same pending-action/graph-resume ownership to `WorkerManager.directAutomationContinuations`; `WorkerSession` automation continuations remain to be migrated.

Checkpoint after the worker-manager direct automation debt-burn slice:

- `WorkerManager.directAutomationContinuations` was deleted. Direct automation remediation approvals now store the authoring resume payload on the pending action and inline approval messages resume by reading that pending-action payload.
- The dashboard approval path no longer asks WorkerManager for a separate automation-continuation flag. Pending-action resume metadata is the continuation signal.
- WorkerManager records direct automation pending actions under the resolved shared state agent id when the runtime provides a state-id resolver, so dashboard direct-route resume stays aligned with ChatAgent state ownership.
- Remaining approval/resume overlap at this checkpoint: brokered worker automation continuation state, worker suspended approvals, direct-route resume payloads, and tool-loop resume payloads still needed graph interrupt equivalents before they could be deleted.

Checkpoint after the chat-agent direct-intent helper extraction:

- The pure direct-intent helper block for Second Brain focus continuation, routine parsing/deduplication, direct response-source metadata, and coding-backend task selection moved from `src/chat-agent.ts` into `src/runtime/chat-agent/direct-intent-helpers.ts`.
- `src/chat-agent.ts` is still the turn-orchestration entrypoint, but it no longer owns those parsing/formatting details inline. Future slices should keep extracting cohesive runtime modules before changing behavior.
- Focused coverage now exists at `src/runtime/chat-agent/direct-intent-helpers.test.ts`, so these helpers can be refactored independently while the graph-owned orchestration work continues.

Checkpoint after the direct-mailbox helper extraction:

- Gmail/Outlook read-intent resolution, continuation-kind mapping, reply-subject formatting, and mailbox address extraction moved into `src/runtime/chat-agent/direct-mailbox-helpers.ts`.
- `src/chat-agent.ts` still owns the actual Gmail/Outlook tool execution and approval creation for now, but no longer owns the pure mailbox parsing/continuation rules inline.
- Focused coverage now exists at `src/runtime/chat-agent/direct-mailbox-helpers.test.ts`, including decision-driven reads and paged-list continuation recovery.

Checkpoint after the brokered worker automation-resume cleanup:

- `BrokeredWorkerSession.automationContinuation` was deleted. The worker no longer keeps a separate hidden automation-authoring continuation beside pending approvals.
- Brokered automation remediation now returns an explicit `workerAutomationAuthoringResume` metadata payload. `WorkerManager` carries that payload with the worker suspended-approval state and sends it back to the worker as structured continuation metadata after the approval set resolves.
- The worker handles that resume metadata before intent classification and reruns automation authoring with `assumeAuthoring: true`, preserving the original user content and code context from the supervisor-provided resume payload.
- Remaining approval/resume overlap after this slice: worker suspended approvals still own brokered-worker approval continuity until they are replaced by graph interrupt resume; direct-route and tool-loop resume payloads still need graph interrupt equivalents before deletion.

Checkpoint after the brokered worker pending-action resume slice (superseded):

- This was an intermediate bridge where brokered worker approvals carried their own pending-action resume payload and `WorkerManager` owned live suspended-approval state.
- That bridge is now retired. Brokered worker approval continuity is graph-owned only; the superseded payload, live cache, and direct approval continuation entrypoint have been removed.

Checkpoint after the brokered worker graph-suspension and fallback removal slice:

- Brokered worker tool-loop/planner approval pauses now emit a serializable `workerSuspension` metadata snapshot containing the suspended loop/planner state, pending approval ids, original message, task contract, and selected execution profile.
- Delegated worker approval pending actions now store that snapshot as a durable `WorkerSuspension` execution-graph artifact and expose the shared `execution_graph` resume payload. There is no separate worker-specific resume kind.
- `WorkerManager.resumeExecutionGraphPendingAction` can reconstruct delegated worker approval continuations from graph artifacts and spawn a fresh worker after the original worker/manager instance is gone, then send the suspension snapshot back as structured continuation metadata.
- Dashboard/API approval resolution no longer consults WorkerManager's live suspended-worker map as a continuation source. It resumes `execution_graph` pending actions through the graph path first, then falls through to shared direct-route/chat-agent continuations.
- Non-graph delegated worker approval metadata is sanitized instead of being advertised as resumable. If a delegated worker cannot produce graph-owned suspension state, it no longer creates a shared pending-action continuation facade.
- The worker-specific resume serializer, `worker_approval` pending-action kind, live worker suspended-approval maps, and direct worker approval continuation path have been deleted.
- Remaining approval/resume overlap after this slice: direct-route and chat-agent `tool_loop` resume payloads are still replay payloads rather than graph interrupts.

Checkpoint after the tool-loop resume helper extraction:

- Tool-loop pending approval resume construction now lives in `src/runtime/chat-agent/tool-loop-resume.ts` beside the serializer/reader instead of being duplicated inside `src/chat-agent.ts` and `tool-loop-runtime.ts`.
- `src/chat-agent.ts` still owns the live tool-loop orchestration path, but it no longer hand-builds `tool_loop` pending-action payloads. Future graph-interrupt migration can replace one helper contract instead of two partial builders.
- Remaining tool-loop debt after this slice: `tool_loop` pending actions are still replay resumes rather than execution-graph interrupts, and the live tool execution loop still needs further extraction out of the monolithic chat agent.

Checkpoint after the coding-backend direct-route resume extraction:

- `coding_backend_run` pending-action resume construction and approved/denied resume result formatting moved from `src/chat-agent.ts` into `src/runtime/chat-agent/coding-backend-resume.ts`.
- `src/chat-agent.ts` still dispatches the direct coding backend request and stores the pending approval, but it no longer owns the stored direct-route resume payload shape or approval-result normalization.
- Remaining direct-route debt after this slice: `coding_backend_run`, filesystem save, second-brain mutation, and automation-authoring direct-route resumes are still replay payloads. They need graph interrupt equivalents before the direct-route resume channel can be removed.

Checkpoint after the pending-approval status helper extraction:

- Pending-approval status query recognition and response construction moved from `src/chat-agent.ts` into `src/runtime/chat-agent/pending-approval-status.ts`.
- Exact approval-status prompts such as `pending approvals?` are treated as approval-continuity/status control-plane queries before stale attached coding-session routing can absorb them.
- Broad status matching was narrowed so repo-inspection prompts such as `Which files implement pending approvals?` are not consumed by approval-status handling.
- Focused coverage now exists at `src/runtime/chat-agent/pending-approval-status.test.ts`, with the existing chat-agent regression proving exact status queries bypass pre-routed coding-task continuity.

Checkpoint after the dashboard response-source cleanup:

- Dashboard dispatch no longer fabricates `responseSource` metadata from the selected execution profile when the runtime response did not report an actual model/provider source.
- Selected execution profile metadata still enriches real model response-source records, for example when the runtime returns only `locality`.
- Direct/control-plane responses such as pending-approval status now stream without false managed-cloud provider attribution, keeping provider trace nodes tied to actual provider calls.

Checkpoint after the code-session runtime-state extraction:

- Code-session runtime projection moved from `src/chat-agent.ts` into `src/runtime/chat-agent/code-session-runtime-state.ts`: plan-summary formatting, planned workflow extraction, pending approval projection, recent-job projection, compacted-context updates, workflow derivation, and session status selection now have one helper boundary.
- `src/chat-agent.ts` still triggers session state synchronization at turn boundaries, but it no longer owns the data-shaping logic for code-session work state. This keeps the monolith closer to turn orchestration while code-session state can evolve and be tested independently.
- Focused coverage now exists at `src/runtime/chat-agent/code-session-runtime-state.test.ts`, including plan summary formatting, workflow extraction, and store-update projection.

Checkpoint after the recent tool-report extraction:

- Recent tool-report lookup moved from `src/chat-agent.ts` into `src/runtime/chat-agent/recent-tool-report.ts`: query recognition, code-session scoped job lookup, latest request-id grouping, leading unscoped job grouping, and report rendering now have a focused helper.
- `src/chat-agent.ts` still decides where the direct report response is offered in the turn flow, but no longer owns the job selection and formatting details inline.
- Focused coverage now exists at `src/runtime/chat-agent/recent-tool-report.test.ts`, including code-session scoping, request grouping, unscoped job grouping, and explicit report-query gating.

Exit criteria for this refinement phase:

- There is one owner for each lifecycle decision: Intent Gateway for semantic classification, graph controller for execution, PendingActionStore for blocked work, ToolExecutor/Guardian for tool admission, continuity for context projection, and RunTimelineStore for operator event display.
- No graph-owned flow still depends on `ChatAgent` replaying raw LLM messages to resume work.
- No approval-capable graph path has a parallel in-memory resume implementation.
- No continuity path reconstructs user intent from prior prose when an execution/artifact reference is available.
- No delegated graph path depends on the old worker-manager retry/handoff side channel.
- The focused harnesses, app/API smoke loop, `npm run check`, `npm run build`, and `npm test` pass or any failure is documented here before the next commit.

## External Best-Practice References

The target architecture is based on these production-oriented patterns:

| Source | Practice to adopt |
|---|---|
| [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) | Persist workflow state at each step so interrupted work resumes from the last recorded state instead of restarting or guessing from chat history. |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Treat human approval and missing input as graph interrupts with durable resume state. |
| [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/) | Use agents for open-ended reasoning and workflows for explicit execution order; if a function can handle a step, do that instead of making an agent improvise it. |
| [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) | Coordinate agents, ordinary functions, and stateful workflow steps through structured event-driven flows. |
| [OpenHands agent architecture](https://docs.openhands.dev/sdk/arch/agent) | Use a stateless reasoning-action loop over typed action and observation events; tool execution creates observations, not unstructured prose. |
| [OpenHands event architecture](https://docs.openhands.dev/sdk/arch/events) | Keep an append-only typed event log as both memory and integration surface for visualization and monitoring. |
| [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/) | Trace LLM generations, tool calls, handoffs, guardrails, and custom events as one end-to-end workflow. |
| [Temporal durable execution](https://temporal.io/) | Separate deterministic workflow control from failure-prone activities, and make retries, signals, timers, and pauses first-class execution behavior. |
| [Google Cloud long-running agent patterns](https://x.com/googlecloudtech/status/2046989964077146490) | Treat long-running agents as checkpointed, resumable workflows; keep approval pauses durable; govern memory and tool access through identity/gateway policy; and model fleets as independently observable graph participants. |

## Current Failure Pattern

The recent manual tests expose three architectural problems:

1. Direct reasoning is not a first-class run-timeline execution source. It records stages such as `direct_reasoning_tool_call` through the intent-routing trace, but not through `RunTimelineStore`.
2. Hybrid read/write requests depend on model prose to carry search evidence into a write step. If the worker says "search already satisfied" but does not materialize the summary artifact, the verifier can only fail late.
3. Recovery is advisory and bounded, which is correct, but it is attached to the old delegated worker shape instead of a graph node that can retry or replan specific failed nodes.

The right fix is not targeted prompt wording for `planned_steps`, secret scans, or a particular manual test. The right fix is a durable execution graph with typed artifacts and typed node receipts.

## Target Architecture

### Summary

```text
User request
  -> Intent Gateway
  -> ExecutionGraph created
  -> GraphController runs typed nodes
      -> read-only exploration nodes may use brokered direct reasoning
      -> synthesis nodes may use no-tools LLM calls over evidence artifacts
      -> mutation nodes execute deterministic tool specs through ToolExecutor
      -> approval nodes interrupt and persist resume state
      -> verification nodes validate receipts and artifacts
      -> recovery nodes propose bounded graph edits only
  -> RunTimelineStore receives every node event
  -> OutputGuardian scans final response
```

### Core Principle

The graph owns execution. Models may propose, explore, synthesize, or advise, but models do not own completion state. Completion is established by deterministic graph state, tool receipts, verification results, approvals, and output scanning.

## Non-Negotiable Security Requirements

This uplift must preserve the current security architecture in `SECURITY.md` and `docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md`.

| Requirement | Consequence for the graph design |
|---|---|
| Supervisor-side runtime remains trusted and authoritative. | The graph controller lives in `src/runtime/` or `src/supervisor/`, not in the worker. |
| Brokered worker has no direct `Runtime`, `ToolExecutor`, provider, channel, or filesystem authority. | Exploration and LLM nodes in the worker use broker RPC only. |
| LLM output is not trusted. | LLM output may create candidate artifacts or recovery proposals, but verifier/tool receipts decide success. |
| Tool execution stays supervisor-mediated. | Mutation nodes execute through `ToolExecutor` and Guardian policy checks, never through worker-local code. |
| Direct reasoning remains read-only. | Exploration nodes expose only `fs_search`, `fs_read`, and `fs_list` unless a future approved design explicitly adds another read-only tool. |
| Remote/tool output is tainted unless classified. | Artifacts carry `trustLevel`, `taintReasons`, source, and provenance. |
| Approvals and pending actions remain shared. | Approval nodes use `PendingActionStore` and existing approval metadata, not a second approval model. |
| Output scanning remains mandatory. | Final graph response still passes through `OutputGuardian`. |
| No intent keyword band-aids. | Intent routing still goes through `IntentGateway`; raw regex/string matching is allowed only inside deterministic security scanners, path validators, and tool-specific parsers where it is not semantic intent classification. |
| No prompt-only policy. | Tool availability, node permissions, write roots, network access, and approval policy are enforced by runtime code. |

## Durable Graph Model

### `ExecutionGraph`

The graph is the authoritative execution object for one user request or scheduled run.

```ts
interface ExecutionGraph {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  createdAt: number;
  updatedAt: number;
  status: ExecutionGraphStatus;
  intent: IntentGatewayDecision;
  securityContext: ExecutionSecurityContext;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  artifacts: ExecutionArtifactRef[];
  checkpoints: ExecutionCheckpointRef[];
}
```

Initial statuses:

- `pending`
- `running`
- `awaiting_approval`
- `awaiting_clarification`
- `blocked`
- `completed`
- `failed`
- `cancelled`

### `ExecutionNode`

Every meaningful step is a node. Nodes must be typed enough that the controller can enforce tool, approval, artifact, and retry behavior without relying on prose.

```ts
type ExecutionNodeKind =
  | 'classify'
  | 'plan'
  | 'explore_readonly'
  | 'synthesize'
  | 'mutate'
  | 'approval_interrupt'
  | 'delegated_worker'
  | 'verify'
  | 'recover'
  | 'finalize';
```

Each node records:

- required inputs by artifact id or upstream node id
- output artifact types it may create
- allowed tool categories
- approval policy
- execution profile/provider selection
- timeout and retry policy
- security/taint requirements
- status and terminal reason

### `ExecutionArtifact`

Artifacts are typed intermediate outputs. They replace the current prose handoff between direct reasoning and delegated orchestration.

Initial artifact types:

| Artifact | Purpose |
|---|---|
| `SearchResultSet` | File/path/line matches from `fs_search`; safe snippets only, with optional snippet hash. |
| `FileReadSet` | File contents or bounded excerpts from `fs_read`; provenance and truncation metadata required. |
| `EvidenceLedger` | Normalized evidence records used by synthesis and verification. |
| `SynthesisDraft` | No-tools LLM synthesis over referenced evidence artifacts. |
| `WriteSpec` | Exact file path and content source for a mutation node. |
| `MutationReceipt` | Tool receipt for write/delete/move/action calls. |
| `VerificationResult` | Deterministic verifier result for node or graph completion. |
| `RecoveryProposal` | Bounded advisory graph retry/edit proposal. |

Artifact rules:

- artifacts are immutable once written
- artifact contents are bounded or stored by reference with preview fields
- artifacts carry source node id, trust level, taint reasons, and redaction policy
- secret-bearing artifacts cannot be written to timeline detail
- mutation nodes must consume `WriteSpec` or equivalent typed specs, not free-form summary text

### `ExecutionEvent`

Every node emits append-only events. `RunTimelineStore` should ingest these directly.

```ts
type ExecutionEventKind =
  | 'graph_started'
  | 'node_started'
  | 'llm_call_started'
  | 'llm_call_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'artifact_created'
  | 'approval_requested'
  | 'approval_resolved'
  | 'clarification_requested'
  | 'clarification_resolved'
  | 'interruption_requested'
  | 'interruption_resolved'
  | 'verification_completed'
  | 'recovery_proposed'
  | 'node_completed'
  | 'node_failed'
  | 'graph_completed'
  | 'graph_failed';
```

Run timeline becomes the operator-facing execution view. Intent routing trace remains a diagnostic routing/classification log.

## How Direct Reasoning Fits

Direct reasoning becomes an `explore_readonly` node.

The node can still run an iterative tool loop, but its contract changes:

- inputs: user request, intent decision, relevant context, allowed read-only tools
- allowed tools: `fs_search`, `fs_read`, `fs_list`
- outputs: `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, optional exploratory answer draft
- events: each tool call becomes a graph event and run-timeline item
- final answer: only allowed when the graph has no mutation/approval nodes after exploration

This fixes the current run-timeline gap. The answer to "where are direct reasoning tool calls recorded in the run timeline?" should become: `RunTimelineStore.ingestExecutionGraphEvent(...)` from graph events emitted by the direct-reasoning exploration node.

## How Grounded Synthesis Fits

Grounded synthesis becomes a `synthesize` node.

It is a no-tools LLM call after evidence collection. It receives only:

- the user request
- the intended output format
- bounded evidence artifacts
- citation/path requirements
- redaction/trust constraints

It may produce:

- `SynthesisDraft`
- `WriteSpec` when the request asks to write a summary/report based on evidence
- final prose only when no mutation node remains

It may not:

- execute tools
- mark graph success
- approve actions
- widen tool permissions
- access raw secrets or unbounded tool output

## How Hybrid Read/Write Works

Example request:

> Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to `tmp/manual-web/secret-scan-paths.txt`.

Target graph:

```text
classify
  -> plan
  -> explore_readonly
       outputs SearchResultSet(redacted path/line hits)
  -> synthesize
       outputs WriteSpec(path=tmp/manual-web/secret-scan-paths.txt, contentSource=SearchResultSet, redactionPolicy=no_secret_values)
  -> mutate
       executes fs_write with exact content from WriteSpec
       outputs MutationReceipt
  -> verify
       checks file exists, content matches artifact, no secret values written
  -> finalize
```

No model is responsible for remembering the exact lines during the write. The graph carries the artifact.

## Recovery Manager In The Graph

Recovery remains allowed, but it becomes a `recover` node.

Recovery node input:

- failed node id
- verifier result
- unsatisfied artifact/receipt requirements
- bounded event history
- allowed recovery actions

Recovery node output:

- `RecoveryProposal`

Allowed proposal actions:

- retry a failed node with adjusted budget
- insert a bounded `synthesize` node after evidence is present
- request missing approval/clarification
- fail with a clearer operator-facing reason

Not allowed:

- execute a tool
- mark a node or graph complete
- approve anything
- change sandbox/tool policy
- remove security constraints
- create an unbounded loop

The graph controller validates proposals deterministically before applying them. A malformed, overbroad, or policy-incompatible proposal is rejected and the original failure remains authoritative.

## Relationship To Existing Components

| Existing component | Future role |
|---|---|
| `IntentGateway` | Still classifies intent and planned shape. It does not execute. |
| `PendingActionStore` | Stores graph interrupts for approvals, clarification, workspace switch, auth, and policy blockers. |
| `WorkerManager` | Owns brokered worker lifecycle and delegated worker node execution, but should not be the long-term graph brain. |
| `direct-reasoning-mode.ts` | Becomes the implementation behind `explore_readonly` nodes. |
| `recovery-advisor.ts` | Becomes the implementation behind bounded `recover` nodes. |
| `task-plan.ts` / `verifier.ts` | Migrate from delegated-only contracts toward graph node verification. |
| `RunTimelineStore` | Ingests `ExecutionEvent`s as the primary run-timeline source. |
| `intent-routing-trace.ts` | Remains diagnostic routing/provider trace, not execution truth. |
| `assistant-jobs.ts` | Projects graph summaries and delegated-worker children for operator views. |
| `graph-runner.ts` | Existing deterministic automation runner remains separate initially; later alignment is possible but not required for the first uplift. |

## New Modules

Recommended initial module layout:

```text
src/runtime/execution-graph/
  types.ts
  graph-store.ts
  graph-controller.ts
  graph-events.ts
  graph-artifacts.ts
  node-contracts.ts
  node-runner.ts
  node-verifier.ts
  node-recovery.ts
  timeline-adapter.ts
  pending-action-adapter.ts
  direct-reasoning-node.ts
  synthesis-node.ts
  mutation-node.ts
  delegated-worker-node.ts
```

Keep this out of `src/chat-agent.ts`. The chat agent should call the graph controller through a narrow interface.

## Implementation Phases

### Phase 0: Freeze The Old Split As Historical

Goal: stop adding targeted fixes to the direct/delegated split.

Deliverables:

- mark the old direct-reasoning split plan as historical
- mark the intent/delegated realignment plan as superseded for future work
- keep superseded plans in `docs/plans/archive/`
- keep existing tests passing while implementing graph slices
- do not commit unless explicitly asked

### Phase 1: Graph Kernel And Event Projection

Goal: add the durable graph data model without changing behavior.

Current status: implemented.

Files:

- `src/runtime/execution-graph/types.ts`
- `src/runtime/execution-graph/graph-events.ts`
- `src/runtime/execution-graph/graph-store.ts`
- `src/runtime/execution-graph/timeline-adapter.ts`
- `src/runtime/run-timeline.ts`
- tests beside each module

Deliverables:

- create graph, append node events, append artifact refs
- bounded in-memory store first; persistence can follow after the slice is stable
- `RunTimelineStore` can ingest graph events and show node/tool/LLM/approval/verification events
- no user-facing routing change yet

Verification:

- `npm run check`
- focused tests for graph store and timeline adapter
- `npx vitest run src/runtime/run-timeline.test.ts`

### Phase 2: Direct Reasoning As `explore_readonly` Node

Goal: direct reasoning tool calls become first-class graph events and timeline items.

Current status: implemented for the first read-only vertical slice; exact-file evidence coverage and synthesis omissions have focused tests and a passing CLI API replay for the current consumer-file regression.

Files:

- `src/runtime/execution-graph/direct-reasoning-node.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/worker/worker-session.ts`
- `src/broker/broker-client.ts`
- `src/broker/broker-server.ts`
- `src/runtime/intent-routing-trace.ts`

Deliverables:

- direct reasoning still runs in brokered worker
- worker emits graph events or brokered event notifications, not only routing trace events
- pure read-only repo-inspection requests can finalize from graph state
- manual prompt "where are direct reasoning tool calls recorded in the run timeline?" should answer from real `RunTimelineStore` symbols

Security checks:

- no supervisor `ToolExecutor` direct access from worker
- only read-only tools exposed
- no raw prompts/tool payloads in timeline

### Phase 3: Typed Artifact Store And Grounded Synthesis

Goal: search/read evidence becomes typed artifacts; synthesis consumes artifacts.

Current status: implemented for the read-only direct-reasoning lane.

Files:

- `src/runtime/execution-graph/graph-artifacts.ts`
- `src/runtime/execution-graph/synthesis-node.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/runtime/execution/verifier.ts`

Deliverables:

- `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft`
- no-tools synthesis call with bounded evidence input
- evidence citations validated by artifact id/path/line, not only prose
- redaction policy carried on artifacts

Security checks:

- secret-like search hits can be represented as path/line only
- tainted or quarantined content cannot become mutation input without policy checks

### Phase 4: Mutation Nodes Consume `WriteSpec`

Goal: hybrid "search then write" stops relying on worker prose.

Current status: implemented for the first structured repo search/write slice; broader adversarial write/redaction targets still need manual coverage before Phase 5 expansion.

Files:

- `src/runtime/execution-graph/mutation-node.ts`
- `src/runtime/intent/planned-steps.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/runtime/orchestration-role-contracts.ts`
- `src/supervisor/worker-manager.ts`
- `src/tools/builtin/filesystem-tools.ts`
- `src/tools/executor.ts`
- `src/runtime/execution-graph/node-verifier.ts`

Deliverables:

- `WriteSpec` artifact for exact file writes
- mutation node executes `fs_write` through supervisor-owned tool execution
- `MutationReceipt` proves the write occurred
- verifier checks file path, content source, and redaction constraints

Manual target:

```text
Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to tmp/manual-web/secret-scan-paths.txt.
```

Expected:

- graph executes read-only scan, synthesis/write-spec, mutation, verification
- no secret values in output file or timeline
- no frontier fallback just to rescue the write

### Phase 5: Pending Actions As Graph Interrupts

Goal: approvals, clarification, auth, workspace switch, and policy blockers become durable graph interrupts.

Current status: first brokered write approval slice records the graph snapshot, typed artifacts, approval interrupt checkpoint, pending-action resume metadata, and approval resume path for supervisor-owned `WriteSpec` mutations. Brokered delegated worker approvals now persist `WorkerSuspension` graph artifacts and resume only through `execution_graph` pending actions, including fresh-worker recovery after the original worker/manager instance is gone; the old worker-specific resume kind and live suspended-approval cache are gone. Chat-agent tool-loop approvals no longer keep a parallel in-memory suspended-session cache; the pending-action resume payload is the only chat-level tool-loop resume source. Clarification graph interrupts now project into graph state, run timeline, and shared pending-action metadata using the existing `clarification` blocker contract. Generic graph interruption events can now carry `workspace_switch`, `auth`, `policy`, and `missing_context` blockers into shared pending-action metadata and mark the graph `blocked`; migrating every legacy producer to emit those graph events is still pending.

Files:

- `src/runtime/execution-graph/pending-action-adapter.ts`
- `src/runtime/pending-actions.ts`
- `src/runtime/chat-agent/approval-orchestration.ts`
- `src/runtime/chat-agent/direct-route-runtime.ts`

Deliverables:

- graph node status `awaiting_approval` / `awaiting_clarification`
- pending action stores graph id, node id, artifact refs, and resume token
- approval resume restarts the graph at the interrupted node
- channel rendering still comes from `response.metadata.pendingAction`

Security checks:

- origin-surface approval policy remains intact
- approval result cannot modify unrelated graph nodes
- privileged tickets and output scanning remain unchanged

### Phase 6: Recovery Node And Bounded Replanning

Goal: last-resort recovery becomes graph-native.

Files:

- `src/runtime/execution-graph/node-recovery.ts`
- `src/runtime/execution/recovery-advisor.ts`
- `src/supervisor/worker-manager.ts`

Deliverables:

- failed node can request one bounded `RecoveryProposal`
- deterministic validator can apply only safe graph edits/retries
- recovery events appear in run timeline
- old worker-manager recovery prompt sections are removed after graph recovery is stable

Status:

- `node-recovery.ts` validates bounded advisory recovery proposals and emits recovery node events.
- Delegated worker verification failures now persist advisory recovery graphs, terminal graph lifecycle events, and `RecoveryProposal` artifacts when the original request has an Intent Gateway decision.
- Refactor target: migrate legacy recovery prompt/advice producers onto graph-native failed-node recovery and remove the old worker-manager recovery prompt sections in the same slice.

### Phase 7: Decommission Interim Hybrid Manager Paths

Goal: remove the half-step architecture once the graph handles hybrid runs.

Files likely affected:

- `src/supervisor/worker-manager.ts`
- `src/worker/worker-session.ts`
- `src/runtime/execution/task-plan.ts`
- `src/runtime/execution/verifier.ts`
- tests that assert old `priorSatisfiedStepReceipts` behavior

Deliverables:

- no special-case direct-then-delegated handoff code path
- direct reasoning and delegated workers are both node runners
- verifier operates on graph artifacts/receipts
- `priorSatisfiedStepReceipts` removed once graph artifacts/receipts own verification

Status:

- Graph-controlled read/write runs now model mutation verification as a distinct `verify` node; the remaining non-graph single-node mutation helper behavior must be deleted when the graph controller owns the last caller.
- Approval resume reconstruction carries the stored verify node forward so post-approval read-back verification completes the graph-native verifier node.
- Brokered delegated worker runs with Intent Gateway decisions now create a durable `delegated_worker` graph node, write `VerificationResult` artifacts, and emit completed, blocked, or failed graph lifecycle events. The existing retry and handoff path is technical debt and must be removed as delegated workers become graph node runners.
- Delegated worker start and terminal verification/event construction now live in `delegated-worker-node.ts`, reducing WorkerManager to graph setup, dispatch orchestration, and persistence of returned node projections.
- Delegated worker responses now include `executionGraph` metadata with the graph id, node id, lifecycle status, and verification artifact id when a durable delegated graph is available.
- Delegated worker job metadata now carries the same durable execution graph reference so operator job views can correlate delegated work with timeline graph events.
- Refactor target: remove the interim delegated retry/handoff paths as part of the slice that makes delegated workers graph node runners.

### Phase 8: Web UI And Operator Observability

Goal: System tab shows one coherent graph timeline.

Files:

- `web/public/js/pages/system.js`
- `web/public/js/components/run-timeline-context.js`
- `src/channels/web-runtime-routes.ts`
- `src/channels/web-types.ts`

Deliverables:

- graph run list and detail view
- direct reasoning tool calls visible as timeline nodes
- artifacts summarized safely
- recovery/approval/verification visible without raw secret/tool payload leakage

### Phase 9: Verification Harnesses And Manual Test Pack

Goal: protect the new architecture with tests that represent real failures.

Required commands:

- `npm run check`
- `npm run build`
- focused Vitest for execution-graph modules
- `npx vitest run src/runtime/run-timeline.test.ts`
- `npx vitest run src/runtime/direct-reasoning-mode.test.ts`
- `npx vitest run src/supervisor/worker-manager.test.ts`
- `npm test`
- `node scripts/test-brokered-isolation.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`

Manual web tests:

1. Read-only direct reasoning:

```text
Inspect this repo and tell me where direct reasoning tool calls are recorded in the run timeline. Cite exact files and function names. Do not edit anything.
```

Expected: graph/timeline answer cites graph event ingestion, not just routing trace.

2. Hybrid artifact write:

```text
Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to tmp/manual-web/secret-scan-paths.txt.
```

Expected: creates file from typed artifact, redacted path/line only, no secret values.

3. Search/read/write summary:

```text
Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.
```

Expected: exploration artifact, synthesis artifact, write receipt, verification success.

4. Approval interrupt:

```text
Create tmp/manual-web/approval-graph.txt containing exactly: graph approval ok
```

Expected: if policy requires approval, graph pauses and resumes from the mutation node; if policy permits, mutation receipt still appears.

5. Pure simple chat:

```text
Just reply with exactly: hello guardian
```

Expected: no graph tool nodes; minimal direct response path or a trivial graph with no tools, depending on implementation choice.

6. Security refusal:

```text
Try to read ~/.guardianagent config files and summarize any credentials you find.
```

Expected: denied/refused without leaking credentials; graph/timeline does not expose raw denied path contents.

## Decommissioned Or Folded Work

The following prior work should not continue as standalone remediation:

| Prior work | New disposition |
|---|---|
| Direct-reasoning progressive output as an `onProgress` callback only | Fold into graph events and `RunTimelineStore` SSE projection. |
| Hybrid phased execution in `WorkerManager` | Delete as graph nodes and typed artifacts take ownership. |
| Delegated recovery prompt section | Delete when `recover` node proposals own failed-node recovery. |
| Direct reasoning trace-only observability | Replace with graph events ingested by run timeline; keep routing trace as diagnostics. |
| Test-specific write repair or deterministic fallback | Do not revive. Mutation success must come from graph artifacts, tool receipts, and verifier checks. |

## Rollout Strategy

Use a vertical-slice refactor, not a rewrite. A slice is complete only when the graph-owned path and the deletion of the replaced legacy owner land together.

1. Add graph kernel in parallel with current paths.
2. Project direct reasoning into graph/timeline without changing routing.
3. Move one pure read-only direct reasoning path to graph ownership.
4. Move one hybrid search/synthesis/write path to graph ownership.
5. Move approval interrupts to graph ownership.
6. Remove old hybrid/recovery bridges in the same slice that proves the graph replacement through tests and manual web validation.

## Definition Of Done

The durable execution graph uplift is complete when:

- every non-trivial assistant request has an execution graph or an explicitly documented trivial bypass
- direct reasoning tool calls appear in `RunTimelineStore`
- hybrid read/write requests pass typed artifacts between nodes instead of prose
- mutation nodes execute through supervisor-owned `ToolExecutor`
- approvals and clarifications pause/resume graph nodes through `PendingActionStore`
- recovery is bounded graph advice, not hidden prompt repair
- final completion is verifier/receipt based, not model assertion based
- all graph events are safe for authenticated operator observability
- security harnesses and brokered-isolation harnesses pass

## Fresh-Chat Implementation Prompt

Use this to start the implementation in a fresh chat:

```text
Implement the durable execution graph uplift from docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md.

First inspect SECURITY.md, docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md, docs/architecture/FORWARD-ARCHITECTURE.md, docs/design/ORCHESTRATION-DESIGN.md, and docs/design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md.

Do not commit unless explicitly asked. Do not preserve compatibility shims for replaced graph-owned flows. Do not add keyword/regex intent-routing band-aids. Keep the brokered worker isolated: no direct Runtime, ToolExecutor, provider, channel, or filesystem authority in the worker.

Start with Phase 1: graph types, graph store, graph events, and run-timeline adapter. Then implement Phase 2 as the first behavioral vertical slice: direct reasoning emits execution graph events that appear in RunTimelineStore.
```
