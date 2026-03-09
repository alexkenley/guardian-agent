# OpenDev Integration, Coding Assistant & Orchestration Improvements Proposal

**Status:** Proposed
**Date:** 2026-03-09
**Informed by:**
- [OpenDev](https://github.com/opendev-to/opendev) — open-source terminal coding agent (Python/MIT)
- [Building AI Coding Agents for the Terminal](https://arxiv.org/html/2603.05344v1) — Nghi D. Q. Bui (2026)
- GuardianAgent specs: `ORCHESTRATION-AGENTS-SPEC.md`, `ASSISTANT-ORCHESTRATOR-SPEC.md`

---

## Executive Summary

This proposal covers three areas informed by analysis of OpenDev and the accompanying research paper:

1. **Orchestration & Smart Routing Improvements** — targeted upgrades to existing systems based on validated patterns from the paper
2. **Coding Assistant Tab** — a new web UI tab with dedicated coding tools, LSP integration, and file-aware context, running through the full Guardian security pipeline
3. **OpenDev Integration Assessment** — why direct dependency integration is not viable and what to borrow instead

---

## Part 1: OpenDev Integration Assessment

### Can We Use OpenDev as a Dependency?

**No — direct integration is not feasible.** OpenDev is:

- A **Python** package (`pip install opendev`), not an npm/Node.js module
- Tightly coupled to its own runtime (Textual TUI, FastAPI server, pydantic models)
- Early-stage (v0.1.7, 59 stars, 2 contributors) with no stable public API contract

Possible but inadvisable integration paths:

| Approach | Feasibility | Problems |
|----------|-------------|----------|
| npm dependency | Impossible | It's Python, not JS |
| Subprocess bridge | Technically possible | Two runtimes, dual config, IPC overhead, version coupling |
| MCP server wrapper | Possible | OpenDev can be an MCP server, but we'd inherit its full runtime for limited benefit |
| Port specific algorithms | Best option | MIT license allows free adoption; port to TypeScript as needed |

### What to Borrow (Conceptual Adoption)

OpenDev's security model is shallow compared to ours (no secret scanning, no PII detection, no capability system, no policy engine). Its value lies in **context engineering** and **execution coordination** patterns, all of which we can implement natively in TypeScript.

The paper validates several of our existing design choices (deferred tool loading, parallel execution, per-category provider routing, memory system) while identifying concrete improvements worth adopting.

---

## Part 2: Orchestration & Smart Routing Improvements

### 2.1 Event-Driven System Reminders (High Priority)

**Problem:** The paper demonstrates that static system prompt instructions degrade after 10–15 turns. GuardianAgent relies on a static system prompt in `guardian-core.ts` that can lose effectiveness in long sessions.

**Proposal:** Add runtime monitors that inject targeted reminders into the message history at critical decision points.

**Monitors to implement:**

| Monitor | Trigger | Reminder |
|---------|---------|----------|
| Low tool diversity | Same tool called >5 consecutive turns | "Consider using other tools: [relevant suggestions]" |
| High error rate | >30% of recent turns produce errors | "Error recovery: try a different approach or use find_tools" |
| Stale context | >15 turns since session start without compaction | "Review your approach — consider summarizing progress so far" |
| Repeated edits | Same file edited >3 times in sequence | "Step back and plan the full change before making more edits" |
| Doom loop | Identical tool call repeated with same args, no state change | Break the loop, inject: "This action isn't making progress. Try an alternative." |

**Guardrails:** Max 3 reminder injections per category per session to prevent reminder fatigue.

**Implementation:** New `SystemReminderService` in `src/runtime/` with event-driven hooks into the ChatAgent tool loop. Reminders are injected as system messages, not user messages, to preserve conversation flow.

### 2.2 Five-Stage Adaptive Context Compaction (High Priority)

**Problem:** Our current context budget system does a single-pass compaction at 80% capacity — summarize oldest tool results to 200 chars. This is blunt and loses important context.

**Proposal:** Replace with a graduated five-stage pipeline:

| Stage | Threshold | Action | Token Reduction |
|-------|-----------|--------|-----------------|
| 1 | 70% | Warning logged, no action. Preserve recent N turns verbatim. | 0% |
| 2 | 80% | Summarize old tool results (current behavior, refined) | ~20% |
| 3 | 85% | Collapse multi-turn tool call threads into brief summaries | ~40% |
| 4 | 90% | Extract key learnings to agent memory (AgentMemoryStore) before discarding | ~10% |
| 5 | 95% | Aggressive trim — keep system prompt + last 5 messages + extracted memory | remainder |

**Key additions over current system:**
- **Artifact index preservation** — maintain a metadata summary of all file operations performed (file path, operation type, timestamp) that survives compaction
- **Memory extraction before discard** — stage 4 uses the existing `memory_save` pathway to persist important findings before they're trimmed, rather than losing them
- **Full conversation archival** — before stage 5, serialize the full conversation to disk for potential recovery

### 2.3 Schema-Level Tool Enforcement for Sub-Agents (High Priority)

**Problem:** GuardianAgent enforces capabilities at runtime via `CapabilityController`. The paper argues convincingly that removing tools from the LLM's visible schema is more robust — if the model never sees `fs_write` in its tool definitions, it cannot attempt to call it.

**Proposal:** When orchestration agents dispatch to sub-agents, filter the tool definitions sent to the LLM based on the sub-agent's granted capabilities, **in addition to** the existing runtime checks.

```
Current:  LLM sees all tools → calls tool → CapabilityController blocks at runtime
Proposed: LLM sees only permitted tools → calls tool → CapabilityController validates (defense in depth)
```

This is a **defense-in-depth** addition, not a replacement. The runtime check remains as a safety net.

**Implementation:** Add a `filterToolsByCapabilities(tools, capabilities)` step in the agent context setup within `Runtime.createAgentContext()`.

### 2.4 Per-Workflow Model Roles (Medium Priority)

**Problem:** Our smart routing maps tool **categories** to providers (local/external). The paper identifies five distinct **workflow roles** that benefit from independent model selection, which is orthogonal to per-tool routing.

**Current routing:** Tool category → provider (local filesystem ops use local LLM, web ops use external LLM)

**Proposed addition:** Workflow role → provider/model override

| Workflow Role | Purpose | Default Binding |
|---------------|---------|-----------------|
| `reasoning` | Primary task execution | Default provider |
| `compaction` | Context summarization (stage 3+) | Prefer cheapest available |
| `critique` | Self-verification passes | Prefer fast model |
| `planning` | Plan-mode analysis | Default provider |
| `vision` | Image understanding | VLM-capable provider |

**Config extension:**
```yaml
assistant:
  tools:
    workflowRouting:
      compaction: local    # Use cheap local model for summarization
      critique: local      # Use fast local model for verification
      vision: external     # Use VLM-capable external model
```

**Interaction with existing routing:** Workflow routing applies to the LLM call itself. Tool-category routing applies to which LLM synthesizes tool results. They compose: a `compaction` workflow call routes to the compaction model regardless of which tools were involved.

### 2.5 Parallel Execution Conflict Detection (Medium Priority)

**Problem:** We run all tool calls concurrently via `Promise.allSettled()`. This can cause race conditions when multiple tools write to the same file.

**Proposal:** Adopt OpenDev's file-level conflict detection:
- **Read-only tools**: Always parallel
- **Write tools targeting different files**: Parallel
- **Write tools targeting the same file**: Sequential
- **Non-file write tools** (shell commands, network): Sequential

**Implementation:** Before `Promise.allSettled()`, partition tool calls into conflict-free groups. Execute groups sequentially, tools within each group in parallel.

### 2.6 Doom-Loop Detection (Medium Priority)

**Problem:** The ReAct loop can enter cycles where the LLM repeatedly calls the same tool with the same arguments, burning tokens without progress.

**Proposal:** Track recent tool calls in a sliding window. If the same `(toolName, argsHash)` appears 3+ times consecutively without meaningful state change, break the loop and inject a system reminder to try a different approach.

**Implementation:** Add a `DoomLoopDetector` to the ChatAgent tool loop. Hash tool call arguments, track in a circular buffer of the last 10 calls. On detection, inject a system-level message and force the LLM to respond without tool calls for one turn.

### 2.7 Max Dispatch Depth (Low Priority — Already Planned)

The orchestration spec already recommends adding `maxDispatchDepth` to prevent circular invocation. This should be implemented as a counter threaded through `ctx.dispatch()`:

```typescript
// In dispatch context
dispatch: (targetAgentId, message, depth = 0) => {
  if (depth >= MAX_DISPATCH_DEPTH) throw new Error('Max dispatch depth exceeded');
  return this.dispatchMessage(targetAgentId, message, depth + 1);
}
```

Default `MAX_DISPATCH_DEPTH`: 5.

### 2.8 Smart Error Classification and Nudging (Low Priority)

**Problem:** Tool failures currently return generic error strings. The LLM often retries the same failing approach.

**Proposal:** Classify tool errors into categories and inject error-type-specific guidance:

| Error Type | Detection | Nudge |
|------------|-----------|-------|
| `permission_denied` | Error message pattern | "This path requires elevated permissions. Try an alternative approach." |
| `file_not_found` | Error message pattern | "File doesn't exist. Use fs_list or fs_search to find the correct path." |
| `rate_limited` | Rate limiter rejection | "Rate limited. Wait before retrying or try a different tool." |
| `timeout` | Budget/watchdog | "Operation timed out. Consider a simpler approach." |
| `edit_mismatch` | Edit tool failure | "Content didn't match. Re-read the file first, then retry with exact content." |

---

## Part 3: Coding Assistant Tab

### 3.1 Overview

Add a dedicated **Code** tab to the web UI that provides an integrated coding assistant experience. This is not a separate agent — it's a specialized UI and tool configuration layered on top of the existing ChatAgent, with coding-specific tools enabled and Guardian security fully active.

### 3.2 Why a Separate Tab?

The current Chat panel is general-purpose. A dedicated coding tab provides:

1. **Persistent file context** — file tree, open files, and edit history visible alongside the chat
2. **Code-specific tools always loaded** — no need to discover coding tools via `find_tools`
3. **Workspace-scoped security** — Guardian policies tuned for coding (allow file writes within project, block writes outside)
4. **Visual diff and edit preview** — see proposed changes before applying them
5. **Session isolation** — coding sessions don't pollute general assistant conversation history

### 3.3 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Web UI — Code Tab                     │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ File Tree │  │ Editor View  │  │  Code Chat Panel  │  │
│  │ (read    │  │ (read-only   │  │  (messages +      │  │
│  │  only)   │  │  + diff view)│  │   tool results)   │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘  │
│       │               │                    │             │
│       └───────────────┼────────────────────┘             │
│                       ▼                                  │
│              POST /api/code/message                      │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │   WebChannel     │
              │   (existing)     │
              │                  │
              │  Routes to       │
              │  coding agent    │
              │  config          │
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │   Runtime        │
              │   (existing)     │
              │                  │
              │  Full Guardian   │
              │  pipeline        │
              └──────────────────┘
```

### 3.4 New Coding Tools

Register a `coding` tool category with these tools:

| Tool | Risk | Description |
|------|------|-------------|
| `code_edit` | mutating | Apply a targeted edit to a file (old_string → new_string with fuzzy matching) |
| `code_patch` | mutating | Apply a unified diff patch to a file |
| `code_create` | mutating | Create a new file with content |
| `code_symbol_search` | read_only | Search for symbol definitions/references (via tree-sitter or basic AST) |
| `code_lint` | read_only | Run configured linter on a file and return results |
| `code_test` | read_only | Run test command and return results |
| `code_build` | read_only | Run build command and return results |
| `code_git_diff` | read_only | Show git diff for working tree or staged changes |
| `code_git_commit` | mutating | Stage and commit changes with a message |

**Security considerations:**
- All tools pass through the full Guardian admission pipeline
- `code_edit` and `code_patch` are `mutating` risk → require approval (or policy rule)
- `code_test` and `code_build` execute shell commands → approval-gated, allowlisted commands only
- File operations scoped to a configurable workspace root (default: cwd)
- DeniedPathController blocks edits to `.env`, `*.pem`, credentials files
- SecretScanController scans file content being written for leaked credentials

### 3.5 Fuzzy Edit Matching (Ported from Paper)

The paper documents a 9-pass progressive matching strategy for `code_edit`. LLMs frequently generate edit strings that don't exactly match the source due to whitespace, indentation, or minor formatting differences.

**Proposed matching cascade for `code_edit`:**

1. Exact string match
2. Whitespace-normalized match (collapse runs of whitespace)
3. Leading/trailing whitespace trimmed per line
4. Levenshtein distance ≤ 3 edits per line
5. Indentation-insensitive match (strip leading whitespace, match content)
6. Surrounding-context match (use lines above/below to locate region)

If no match is found after all passes, return a structured error with the closest candidate and its location, so the LLM can retry with corrected content.

### 3.6 Workspace Configuration

```yaml
assistant:
  coding:
    enabled: true
    workspaceRoot: '.'              # Restrict file operations to this directory
    allowedCommands:                # Shell commands the coding assistant can run
      - 'npm test'
      - 'npm run build'
      - 'npm run lint'
      - 'npx vitest'
      - 'git status'
      - 'git diff'
      - 'git log'
    gitIntegration: true            # Enable git tools
    autoApproveReads: true          # Auto-approve read-only coding tools
    maxFileSize: 1048576            # Max file size to read (1MB)
```

### 3.7 Web UI Design

**Layout:** Three-panel layout within the Code tab:

- **Left panel (250px):** File tree browser showing the workspace. Click to view file. Shows git status indicators (M/A/D/U) next to modified files.
- **Center panel (flexible):** File viewer with syntax highlighting (highlight.js). Toggle between source view and diff view. Read-only — edits are made by the LLM through tools.
- **Right panel (400px):** Code chat panel. Same message format as main chat, but with coding-specific system prompt and always-loaded coding tools.

**Key interactions:**
- Click file in tree → opens in center panel + injects file context into chat
- LLM proposes edit → diff preview shown in center panel with Approve/Deny buttons
- Test/build results → formatted output in chat panel with collapsible sections

### 3.8 Code-Specific System Prompt

A coding-focused system prompt injected when the coding tab is active:

```
You are a coding assistant with access to the project workspace at {workspaceRoot}.

Available capabilities:
- Read and search files in the workspace
- Edit files using targeted string replacement (code_edit) or patches (code_patch)
- Create new files (code_create)
- Search for code symbols and references (code_symbol_search)
- Run tests, builds, and linters
- Git operations (diff, status, commit)

Guidelines:
- Always read a file before editing it
- Use code_symbol_search to understand code structure before making changes
- Run tests after making changes to verify correctness
- Show diffs for review before committing
- Never modify files outside the workspace root
```

### 3.9 Security Integration

The coding assistant runs through the **identical** Guardian pipeline as all other agent interactions:

1. **InputSanitizer** — prompt injection detection on user messages
2. **RateLimiter** — per-agent burst/minute/hour limits
3. **CapabilityController** — coding agent granted: `read_files`, `write_files`, `execute_commands`, `search_code`
4. **SecretScanController** — scans file content being written for credentials
5. **PiiScanController** — scans tool arguments
6. **DeniedPathController** — blocks access to `.env`, `*.pem`, `*.key`, `credentials.*`
7. **GuardianAgentService** — LLM evaluation of mutating operations (writes, commits)
8. **OutputGuardian** — scans responses for leaked secrets before showing in UI
9. **Policy Engine** — policy-as-code rules apply to coding tools

**Additional coding-specific policies:**
- Workspace root enforcement: file operations outside `workspaceRoot` are denied at the tool level
- Command allowlist: `code_test` and `code_build` only execute commands from the configured allowlist
- Git operations require explicit capability grant

---

## Part 4: Additional Improvements from Research

### 4.1 Approval Persistence with Pattern Learning

**Current state:** `approve_by_policy` auto-approves read-only shell commands. All other approvals are per-request.

**Improvement:** When a user repeatedly approves the same tool+argument pattern (e.g., `fs_write` to files under `src/`), offer to save it as a persistent approval rule. This reduces approval fatigue without sacrificing security.

**Implementation:** Track approval decisions in `ToolApprovalStore`. After 3 approvals of the same `(toolName, argPattern)`, suggest creating a policy rule. User confirms via the existing policy UI.

### 4.2 Background Task Detection

**Problem:** If the LLM runs a server-like command via `shell_safe` (e.g., `npm start`, `python -m http.server`), it blocks the agent loop.

**Improvement:** Detect server-like commands (port binding, framework keywords like "listening on", "server started") and automatically spawn them as background tasks with output capture, rather than blocking the tool loop.

### 4.3 Artifact Index Preservation

When context compaction occurs, maintain a lightweight metadata index of all tool operations performed during the session:

```typescript
interface ArtifactIndex {
  files: Array<{
    path: string;
    operations: Array<'read' | 'write' | 'create' | 'delete'>;
    lastModified: number;
  }>;
  commands: Array<{
    command: string;
    exitCode: number;
    timestamp: number;
  }>;
}
```

This index survives compaction and is injected into the system prompt, preserving workspace awareness even after aggressive context trimming.

### 4.4 Playbook Memory with Effectiveness Scoring (Future)

An evolution of the current `AgentMemoryStore` (raw markdown facts) toward curated strategy entries with feedback:

- Each memory entry gets `helpful` / `harmful` / `neutral` counters
- Entries are ranked by effectiveness score when retrieved
- Ineffective strategies are automatically pruned after threshold
- Effective strategies are promoted and included more often in context

This is a larger effort that builds on the existing memory system. Flagged as future enhancement.

---

## Implementation Priority

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Event-driven system reminders (2.1) | Medium | High — directly addresses instruction degradation |
| P0 | Doom-loop detection (2.6) | Small | High — prevents token waste, easy to implement |
| P1 | Schema-level tool enforcement (2.3) | Small | High — defense-in-depth, small code change |
| P1 | Five-stage context compaction (2.2) | Large | High — replaces blunt compaction with graduated approach |
| P1 | Coding tools registration (3.4) | Medium | High — enables coding assistant functionality |
| P1 | Fuzzy edit matching (3.5) | Medium | High — makes LLM-driven edits reliable |
| P2 | Code tab web UI (3.7) | Large | Medium — UX layer on top of coding tools |
| P2 | Parallel execution conflict detection (2.5) | Small | Medium — prevents file write races |
| P2 | Smart error classification (2.8) | Small | Medium — improves LLM error recovery |
| P2 | Per-workflow model roles (2.4) | Medium | Medium — cost optimization |
| P3 | Max dispatch depth (2.7) | Small | Low — safety net, already planned |
| P3 | Approval persistence (4.1) | Medium | Medium — reduces approval fatigue |
| P3 | Background task detection (4.2) | Small | Low — edge case improvement |
| P3 | Artifact index preservation (4.3) | Small | Medium — preserves awareness through compaction |
| P4 | Playbook memory with scoring (4.4) | Large | Medium — longer-term memory evolution |

---

## Summary of Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Integrate OpenDev as dependency? | **No** | Python package, no npm module, early-stage, tight coupling |
| Port OpenDev code directly? | **No** | Port *patterns and algorithms* to TypeScript instead |
| Overhaul smart routing? | **No — extend it** | Our per-category routing is validated by the paper; add per-workflow roles as a complementary layer |
| Overhaul orchestration agents? | **No — augment** | Add dispatch depth, doom-loop detection, schema-level enforcement. Core Sequential/Parallel/Loop design is sound |
| Build coding assistant? | **Yes — as a new tab** | Dedicated UI + coding tools + workspace scoping, all through existing Guardian pipeline |
| New security model for coding? | **No** | Use existing Guardian pipeline. Add workspace-root enforcement and command allowlist as tool-level policies |

---

## References

- [OpenDev GitHub](https://github.com/opendev-to/opendev) — MIT license, Python terminal coding agent
- [Building AI Coding Agents for the Terminal](https://arxiv.org/html/2603.05344v1) — Nghi D. Q. Bui, 2026
- [GuardianAgent Orchestration Spec](../specs/ORCHESTRATION-AGENTS-SPEC.md)
- [GuardianAgent Assistant Orchestrator Spec](../specs/ASSISTANT-ORCHESTRATOR-SPEC.md)
- [GuardianAgent Brokered Isolation Proposal](./BROKERED-AGENT-ISOLATION-PROPOSAL.md)
