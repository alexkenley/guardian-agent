# OpenDev/Koan Integration, Coding Assistant & Orchestration Improvements Proposal

**Status:** Proposed
**Date:** 2026-03-09 (updated 2026-03-14)
**Informed by:**
- [OpenDev](https://github.com/opendev-to/opendev) — open-source terminal coding agent (Python/MIT)
- [Building AI Coding Agents for the Terminal](https://arxiv.org/html/2603.05344v1) — Nghi D. Q. Bui (2026)
- [Koan](https://github.com/sukria/koan) — autonomous coding agent orchestrator (Python/GPL-3.0)
- `gru-ai` — TypeScript autonomous coding workflow framework reviewed locally at `S:\Development\gru-ai`
- `Broomy` — Electron multi-session coding workspace reviewed locally at `S:\Development\Broomy`
- GuardianAgent spec: `ORCHESTRATION-SPEC.md`

---

## Executive Summary

This proposal covers six areas informed by analysis of OpenDev, its accompanying research paper, Koan, gru-ai, and Broomy:

1. **Orchestration & Smart Routing Improvements** — targeted upgrades to existing systems based on validated patterns from the paper
2. **Coding Assistant Tab** — a new multi-session coding workspace with dedicated coding tools, file-aware context, embedded terminals, and full Guardian security
3. **OpenDev Integration Assessment** — why direct dependency integration is not viable and what to borrow instead
4. **Koan Integration Assessment** — architectural patterns from a production autonomous agent orchestrator
5. **Workflow State, Validation, and Operator UX** — durable work objects, mechanical workflow invariants, and live operations views informed by gru-ai and Broomy
6. **Autonomous Operation Improvements** — session tracking, budget-aware modes, graduated safety controls, and feedback loops informed by Koan's battle-tested patterns

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

## Part 2: Koan Integration Assessment

### Can We Use Koan as a Dependency?

**No — direct integration is not feasible.** Koan is:

- A **Python** project (requires Python 3.14+), not an npm/Node.js module
- **GPL-3.0 licensed** — copyleft would infect our codebase if used as a library
- Architecturally a CLI subprocess orchestrator (shells out to Claude Code/Copilot/local LLM CLIs), not an embeddable library
- Tightly coupled to file-based IPC (signal files, markdown queues, `fcntl.flock()`)

| Approach | Feasibility | Problems |
|----------|-------------|----------|
| npm dependency | Impossible | It's Python, not JS |
| Subprocess bridge | Inadvisable | We'd be wrapping an orchestrator that wraps an LLM CLI — double indirection for no benefit |
| Port codebase | Inadvisable | GPL-3.0, different architecture (file-based IPC vs event-driven) |
| Adopt patterns | **Best option** | Port *design patterns and algorithms* to TypeScript. Patterns are not copyrightable |

### What Koan Gets Right

Koan represents ~2 years of production autonomous agent operation. Its value is not in code but in **operational wisdom** — patterns that only emerge after running an agent autonomously for thousands of sessions:

1. **Session outcome tracking** — classifying sessions as productive/empty/blocked and using rolling history to detect staleness
2. **Budget-aware mode adaptation** — dynamically downgrading work intensity (deep → implement → review → wait) based on remaining quota
3. **Graduated emergency controls** — three-level e-stop (FULL/READONLY/PROJECT_FREEZE) instead of binary kill switch
4. **Drift detection** — warning the agent when the codebase has changed since its last session
5. **Post-execution quality gates** — scanning agent output for debug patterns, TODOs, secrets, large changes before auto-merge
6. **PR review learning** — extracting lessons from human code reviews and feeding them back into the agent's context
7. **Pre-task specification** — generating a spec before complex tasks to anchor scope
8. **Dual-sided security** — input guard (prompt injection) + output guard (credential leak before channel send)

### What Koan Lacks (Our Advantages)

Koan's security model is shallow compared to ours:

| Capability | GuardianAgent | Koan |
|------------|---------------|------|
| Per-agent capability system | Yes (CapabilityController) | No |
| Runtime admission pipeline | Yes (composable controllers) | No (relies on CLI's built-in safety) |
| Secret scanning (30+ patterns) | Yes (SecretScanController) | Basic (outbox scanner, ~10 patterns) |
| PII detection | Yes (PiiScanController) | No |
| SSRF protection | Yes (SsrfController) | No |
| Inline LLM evaluation | Yes (GuardianAgentService) | No |
| Policy-as-code engine | Yes (compiled matchers, shadow mode) | No |
| Rate limiting | Yes (per-agent sliding windows) | No |
| Multi-agent orchestration | Yes (Sequential/Parallel/Loop/Conditional) | No (single agent) |
| Prompt injection detection | Yes (InputSanitizer + invisible Unicode stripping) | Basic (regex patterns) |

Koan compensates for weak runtime security by using **architectural constraints** (branch isolation, tool restriction by context, LLM alignment instructions). This works for a single-user autonomous agent but would not scale to our multi-agent, multi-channel model.

### Patterns Worth Adopting

The following Koan patterns are directly applicable and are detailed in Parts 3 and 5 of this proposal:

| Pattern | Koan Implementation | GuardianAgent Adaptation |
|---------|---------------------|--------------------------|
| Session outcome tracking | JSON file with rolling window, keyword-based classification | `SessionOutcomeService` in runtime, SQLite-backed (§6.1) |
| Budget-aware modes | Percentage parsing from CLI output, mode downgrade thresholds | Extend `BudgetTracker` with mode selection tied to provider quotas (§6.2) |
| Graduated e-stop | Signal files + JSON state with 3 severity levels | `EmergencyStopService` with EventBus integration (§6.3) |
| Drift detection | Git log since last session timestamp | Inject drift summary into system prompt at session start (§6.4) |
| Post-execution quality gates | Code scanning + test verification + gated auto-merge | `QualityGateService` for coding assistant output (§6.5) |
| PR review learning | GitHub API → Claude analysis → learnings.md | Extend `AgentMemoryStore` with structured feedback extraction (§6.6) |
| Pre-task specification | Read-only Claude call to generate scope doc | `SpecGeneratorTool` for complex tasks (§6.7) |

---

## Part 3: Orchestration & Smart Routing Improvements

### 3.1 Event-Driven System Reminders (High Priority)

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

**Implementation:** New `SystemReminderService` in `src/runtime/` with event-driven hooks into the ChatAgent tool loop. Reminders are injected as system messages, not user messages, to preserve conversation flow. Staleness warnings from `SessionOutcomeService` (§6.1) feed into the stale context monitor.

### 3.2 Five-Stage Adaptive Context Compaction (High Priority)

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

### 3.3 Schema-Level Tool Enforcement for Sub-Agents (High Priority)

**Problem:** GuardianAgent enforces capabilities at runtime via `CapabilityController`. The paper argues convincingly that removing tools from the LLM's visible schema is more robust — if the model never sees `fs_write` in its tool definitions, it cannot attempt to call it.

**Proposal:** When orchestration agents dispatch to sub-agents, filter the tool definitions sent to the LLM based on the sub-agent's granted capabilities, **in addition to** the existing runtime checks.

```
Current:  LLM sees all tools → calls tool → CapabilityController blocks at runtime
Proposed: LLM sees only permitted tools → calls tool → CapabilityController validates (defense in depth)
```

This is a **defense-in-depth** addition, not a replacement. The runtime check remains as a safety net.

**Implementation:** Add a `filterToolsByCapabilities(tools, capabilities)` step in the agent context setup within `Runtime.createAgentContext()`.

### 3.4 Per-Workflow Model Roles (Medium Priority)

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

### 3.5 Parallel Execution Conflict Detection (Medium Priority)

**Problem:** We run all tool calls concurrently via `Promise.allSettled()`. This can cause race conditions when multiple tools write to the same file.

**Proposal:** Adopt OpenDev's file-level conflict detection:
- **Read-only tools**: Always parallel
- **Write tools targeting different files**: Parallel
- **Write tools targeting the same file**: Sequential
- **Non-file write tools** (shell commands, network): Sequential

**Implementation:** Before `Promise.allSettled()`, partition tool calls into conflict-free groups. Execute groups sequentially, tools within each group in parallel.

### 3.6 Doom-Loop Detection (Medium Priority)

**Problem:** The ReAct loop can enter cycles where the LLM repeatedly calls the same tool with the same arguments, burning tokens without progress.

**Proposal:** Track recent tool calls in a sliding window. If the same `(toolName, argsHash)` appears 3+ times consecutively without meaningful state change, break the loop and inject a system reminder to try a different approach.

**Implementation:** Add a `DoomLoopDetector` to the ChatAgent tool loop. Hash tool call arguments, track in a circular buffer of the last 10 calls. On detection, inject a system-level message and force the LLM to respond without tool calls for one turn.

### 3.7 Max Dispatch Depth (Low Priority — Already Planned)

The orchestration spec already recommends adding `maxDispatchDepth` to prevent circular invocation. This should be implemented as a counter threaded through `ctx.dispatch()`:

```typescript
// In dispatch context
dispatch: (targetAgentId, message, depth = 0) => {
  if (depth >= MAX_DISPATCH_DEPTH) throw new Error('Max dispatch depth exceeded');
  return this.dispatchMessage(targetAgentId, message, depth + 1);
}
```

Default `MAX_DISPATCH_DEPTH`: 5.

### 3.8 Smart Error Classification and Nudging (Low Priority)

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

## Part 4: Coding Assistant Tab

### 4.1 Overview

Add a dedicated **Code** tab to the web UI that provides an integrated coding assistant experience. This is not a separate agent — it's a specialized UI and tool configuration layered on top of the existing ChatAgent, with coding-specific tools enabled and Guardian security fully active.

### 4.2 Why a Separate Tab?

The current Chat panel is general-purpose. A dedicated coding tab provides:

1. **Persistent file + terminal context** — open files, diffs, terminal tabs, and recent activity stay attached to the coding session
2. **Multi-project session switching** — borrow Broomy's strongest idea: multiple active coding sessions across different repositories, each with isolated history and workspace state
3. **Code-specific tools always loaded** — no need to discover coding tools via `find_tools`
4. **Workspace-scoped security** — Guardian policies tuned for coding (allow file writes within project, block writes outside)
5. **Visual diff and edit preview** — see proposed changes before applying them
6. **Session isolation** — coding sessions don't pollute general assistant conversation history or approvals

### 4.3 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Web UI — Code Workspace                        │
│  ┌──────────────┐ ┌──────────────────────────────┐ ┌───────────────┐ │
│  │ Session Rail │ │   Workspace Surface          │ │ Code Chat /   │ │
│  │ repo/branch  │ │  ┌────────────────────────┐  │ │ approvals /   │ │
│  │ status/unread│ │  │ File tree + editor/diff│  │ │ quality gates │ │
│  │ waiting-input│ │  └────────────────────────┘  │ │ activity      │ │
│  │ + new sess.  │ │  ┌────────────────────────┐  │ └──────┬────────┘ │
│  └──────┬───────┘ │  │ Terminal dock          │  │        │          │
│         │         │  │ Agent tab + user tabs  │  │        │          │
│         └─────────┼──┴────────────────────────┴──┼────────┘          │
│                   ▼                                ▼                   │
│          POST /api/code/message          POST /api/code/terminals/*   │
│          GET  /api/code/sessions         GET  /api/code/workspace     │
└──────────────────────────────┬────────────────────────────────────────┘
                               │
                               ▼
                     ┌──────────────────────┐
                     │ Runtime + Code APIs  │
                     │ session store        │
                     │ terminal manager     │
                     │ full Guardian stack  │
                     └──────────────────────┘
```

**Session model:**

- Each `CodeSession` is bound to a single `workspaceRoot`, branch, agent configuration, approval history, terminal set, and UI layout state.
- Multiple coding sessions can stay alive in parallel. Switching sessions does **not** discard chat history, open files, or terminal buffers.
- Each session gets one primary **agent terminal** plus zero or more **user terminal** tabs for manual commands, background servers, or inspection work.
- Global panels (session rail, settings) are shared; file viewer/editor state, terminal tabs, and layout sizes are persisted per session, following Broomy's global-vs-per-session panel split.

### 4.4 New Coding Tools

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

### 4.5 Fuzzy Edit Matching (Ported from Paper)

The paper documents a 9-pass progressive matching strategy for `code_edit`. LLMs frequently generate edit strings that don't exactly match the source due to whitespace, indentation, or minor formatting differences.

**Proposed matching cascade for `code_edit`:**

1. Exact string match
2. Whitespace-normalized match (collapse runs of whitespace)
3. Leading/trailing whitespace trimmed per line
4. Levenshtein distance ≤ 3 edits per line
5. Indentation-insensitive match (strip leading whitespace, match content)
6. Surrounding-context match (use lines above/below to locate region)

If no match is found after all passes, return a structured error with the closest candidate and its location, so the LLM can retry with corrected content.

### 4.6 Workspace Configuration

```yaml
assistant:
  coding:
    enabled: true
    workspaceRoot: '.'              # Restrict file operations to this directory
    maxOpenSessions: 8              # Concurrent coding sessions across repos/projects
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
    persistSessionLayouts: true     # Save panel visibility, open files, terminal tabs
    terminalTabs:
      enabled: true
      maxPerSession: 6
      allowUserTerminals: true
```

### 4.7 Web UI Design

Borrow the core interaction model from Broomy, but implement it as a Guardian web workspace rather than an Electron desktop shell.

**Layout:** Four-region layout within the Code tab:

- **Session rail (260px):** List of active coding sessions grouped by project/repo. Each row shows repo name, branch, agent, status, unread state, waiting-input badge, and changed-file count. Sessions remain open concurrently.
- **Workspace left panel (240px):** File tree and git-aware explorer for the active session. Shows modified/untracked files and recent files.
- **Workspace center (flexible):** Editor + diff surface above a terminal dock. The upper area shows file contents or diffs; the lower dock contains the **Agent** terminal and multiple **User** terminal tabs.
- **Right panel (420px):** Code chat, approvals, plan/spec, quality reports, and activity timeline for the active session.

**Terminal behavior:**

- Every session has one persistent **Agent** terminal for tool-driven agent execution.
- Users can open additional terminal tabs inside the same session for manual commands, dev servers, logs, or verification steps.
- Background tasks detected by §5.2 appear as terminal tabs with stop/reconnect controls rather than blocking the chat loop.
- Terminal output is session-scoped and survives tab switches so the user can move between projects without losing context.

**Panel behavior:**

- Session rail and settings are **global** panels.
- Explorer, file viewer position, terminal dock, and right-side activity panels are **per-session** and persist across reloads.
- Layout sizes are saved per session so a frontend-heavy workspace can keep a large preview, while a debugging session can bias toward terminals.

**Key interactions:**

- Click a session in the rail → restore its open files, terminal tabs, chat history, and pending approvals
- Click file in tree → opens in center panel + injects file context into chat
- LLM proposes edit → diff preview shown in center panel with Approve/Deny buttons
- Add user terminal tab → run manual validation without leaving the coding workspace
- Test/build results → formatted output in chat panel with collapsible sections and linked terminal output
- Waiting-input or error state in any non-active session → badge on the session rail, so the user can jump directly to the blocked project

### 4.8 Code-Specific System Prompt

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

### 4.9 Security Integration

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
- Each code session is bound to exactly one workspace root; no cross-session file access
- Terminal actions are attributed as either `agent` or `human` in the audit log
- Background terminal tasks receive explicit IDs and stop controls; they are not hidden side effects

---

## Part 5: Additional Product & Workflow Improvements

### 5.1 Approval Persistence with Pattern Learning

**Current state:** `approve_by_policy` auto-approves read-only shell commands. All other approvals are per-request.

**Improvement:** When a user repeatedly approves the same tool+argument pattern (e.g., `fs_write` to files under `src/`), offer to save it as a persistent approval rule. This reduces approval fatigue without sacrificing security.

**Implementation:** Track approval decisions in `ToolApprovalStore`. After 3 approvals of the same `(toolName, argPattern)`, suggest creating a policy rule. User confirms via the existing policy UI.

### 5.2 Background Task Detection

**Problem:** If the LLM runs a server-like command via `shell_safe` (e.g., `npm start`, `python -m http.server`), it blocks the agent loop.

**Improvement:** Detect server-like commands (port binding, framework keywords like "listening on", "server started") and automatically spawn them as background tasks with output capture, rather than blocking the tool loop.

### 5.3 Artifact Index Preservation

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

### 5.4 Playbook Memory with Effectiveness Scoring (Future)

An evolution of the current `AgentMemoryStore` (raw markdown facts) toward curated strategy entries with feedback:

- Each memory entry gets `helpful` / `harmful` / `neutral` counters
- Entries are ranked by effectiveness score when retrieved
- Ineffective strategies are automatically pruned after threshold
- Effective strategies are promoted and included more often in context

This is a larger effort that builds on the existing memory system. Flagged as future enhancement.

### 5.5 Durable Work-State Model (Borrowed from gru-ai)

**Problem:** The current proposal treats the coding assistant primarily as a session-oriented chat/tool loop. That is fine for small tasks, but larger efforts need a durable work object that survives session restarts, supports decomposition, and can be inspected outside the conversation transcript.

**Proposal:** Introduce a first-class work-state model:

```typescript
interface WorkDirective {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'failed';
  workspaceRoot: string;
  branch?: string;
  currentStep?: string;
  projects: WorkProject[];
}

interface WorkProject {
  id: string;
  title: string;
  reviewers: string[];
  tasks: WorkTask[];
}

interface WorkTask {
  id: string;
  title: string;
  ownerAgent?: string;
  status: 'pending' | 'in_progress' | 'review' | 'done';
  definitionOfDone: string[];
  artifacts: string[];
}
```

**Storage model:** SQLite-backed canonical state in Guardian, with optional export of human-readable markdown/json snapshots into the workspace for auditability and recovery.

**Why this matters:** This captures the strongest practical idea from gru-ai: work should be represented as durable state, not just inferred from the chat log. The coding assistant, dashboard, scheduled jobs, and approvals UI all read the same source of truth.

### 5.6 Workflow Invariant Validator (Borrowed from gru-ai)

**Problem:** Prompting agents to "make sure another agent reviews this" is not enough. Review separation, DOD completion, and step transitions should be mechanically enforced.

**Proposal:** Add a `WorkflowInvariantService` that validates workflow state transitions before a directive or task can advance:

- Builder and reviewer cannot be the same agent
- Required Definition of Done items must be checked before completion
- Approval-gated steps cannot advance without explicit approval record
- Required artifacts (diff, test result, review summary) must exist before wrap-up
- Illegal state transitions are blocked with structured error messages

This extends the quality-gate direction in §6.5 with workflow-level, non-LLM validation.

### 5.7 Live Operations Monitor (Borrowed from gru-ai and Broomy)

**Problem:** Once multiple coding sessions are active, the user needs an operator view, not just a single active chat.

**Proposal:** Add a live operations monitor backed by the new `CodeSession` model:

- Session list with status, branch, last activity, waiting-input/error badges, unread state, and active workspace
- Fast intervention actions: focus session, send input, approve/deny pending action, stop background task
- Event stream showing latest tool actions, file edits, test runs, and approval requests per session
- Filters for active/blocked/review-ready sessions

This should share backend state with the Code tab's session rail rather than becoming a second disconnected UI.

### 5.8 Stratified Memory: Design vs Lessons (Borrowed from gru-ai)

**Problem:** `AgentMemoryStore` currently trends toward a single pool of facts. That mixes stable design rationale with reactive "don't do this again" corrections, which harms retrieval quality.

**Proposal:** Split long-lived memory into two strata:

- **Design memory:** Architecture rationale, workflow principles, project constraints, and why the system is structured a certain way
- **Lessons memory:** Failures, review feedback, user corrections, recurring pitfalls, and operational gotchas

Retrieval can then be role- and workflow-aware. Planning/review flows prefer design memory; implementation/recovery flows prefer lessons memory.

### 5.9 Platform Adapter Layer for External Coding Engines (Optional; Borrowed from gru-ai and Broomy)

**Problem:** If Guardian continues to support multiple coding engines or shells, platform-specific session spawning and monitoring will sprawl through the runtime.

**Proposal:** Define a narrow `CodingPlatformAdapter` boundary for:

- session spawn/stop
- terminal/session monitoring
- identity resolution
- platform capability flags
- optional MCP/session metadata hooks

This is not required for the first version of the Code tab, but it is the right abstraction if we want Claude/Codex/Gemini/Aider support without baking engine-specific behavior into the core runtime.

---

## Part 6: Autonomous Operation Improvements (Informed by Koan)

These improvements are derived from Koan's production experience running an autonomous agent across thousands of sessions. They address gaps in GuardianAgent's ability to operate autonomously, self-monitor, and learn from outcomes.

### 6.1 Session Outcome Tracking & Staleness Detection (High Priority)

**Problem:** GuardianAgent has no concept of session productivity. The Watchdog detects stalls (60s inactivity), but there's no tracking of whether a session *accomplished* anything. If the agent churns through 10 sessions on the same problem without progress, we have no mechanism to detect or intervene.

**Koan's approach:** `SessionTracker` classifies each session as `productive`, `empty`, or `blocked` using keyword analysis on the session journal. Rolling JSON window (200 entries) tracks consecutive outcomes per project. Staleness score = consecutive non-productive sessions. At 3+ stale sessions: WARNING injected into prompt. At 5+: CRITICAL, project deprioritized.

**Proposal:** New `SessionOutcomeService` in `src/runtime/`:

```typescript
interface SessionOutcome {
  sessionId: string;
  agentId: string;
  timestamp: number;
  durationMs: number;
  outcome: 'productive' | 'empty' | 'blocked' | 'error';
  toolCallCount: number;
  mutatingToolCount: number;
  errorCount: number;
  summary: string;          // First 200 chars of final response
}

interface StalenessReport {
  agentId: string;
  consecutiveNonProductive: number;
  level: 'fresh' | 'warning' | 'critical';
  recommendation: string;
}
```

**Classification heuristics:**
- **Productive:** At least one mutating tool call succeeded, OR meaningful content generated (>500 chars non-error response)
- **Empty:** No tool calls, or only read-only tool calls with no substantive output
- **Blocked:** >50% of tool calls failed, or session ended with an unresolved approval
- **Error:** Session terminated by error, watchdog, or budget exhaustion

**Integration points:**
- `AssistantOrchestrator` records outcome at session end
- `SystemReminderService` (§3.1) injects staleness warnings into system prompt
- Dashboard shows per-agent staleness indicators
- Staleness data feeds into the per-workflow model roles system (§3.4) — stale sessions might benefit from a different model

**Storage:** SQLite table in the existing analytics DB, with FTS5 index on summary field.

### 6.2 Budget-Aware Mode Adaptation (Medium Priority)

**Problem:** Our `BudgetTracker` tracks per-agent wall-clock time and kills stalled invocations, but it doesn't adapt agent *behavior* based on remaining budget. An agent with 5% remaining quota runs identically to one with 90%.

**Koan's approach:** `UsageTracker` parses session/weekly usage percentages and selects one of four modes: DEEP (heavy analysis, >40% remaining), IMPLEMENT (standard, 15-40%), REVIEW (read-only, <30%), WAIT (halt, <15%). Cost multipliers per mode (deep=2x, implement=1x, review=0.5x) enable affordability checks.

**Proposal:** Extend `BudgetTracker` with mode selection:

```typescript
type AgentMode = 'deep' | 'standard' | 'conservative' | 'readonly';

interface BudgetModeConfig {
  deep: { minRemaining: 0.4 };         // >40% → full capabilities
  standard: { minRemaining: 0.15 };    // 15-40% → standard ops
  conservative: { minRemaining: 0.05 };// 5-15% → prefer cheap models, skip optional steps
  readonly: { minRemaining: 0 };       // <5% → read-only tools only
}
```

**How mode affects behavior:**
- **Tool filtering:** In `readonly` mode, filter mutating tools from LLM's visible schema (composing with §3.3 schema-level enforcement)
- **Model selection:** In `conservative` mode, prefer local/cheap models via workflow routing (§3.4)
- **System prompt:** Inject budget-awareness reminder: "Budget is low. Prefer targeted, minimal changes."
- **Quality gates:** In `deep` mode, run post-execution quality checks (§6.5). In other modes, skip them.

**Budget sources:** Provider-specific quota APIs (Anthropic usage endpoint, Ollama is free/local), plus the existing per-agent wall-clock tracking.

**Config:**
```yaml
assistant:
  budget:
    modeAdaptation: true
    thresholds:
      deep: 0.4
      standard: 0.15
      conservative: 0.05
```

### 6.3 Graduated Emergency Stop (High Priority)

**Problem:** GuardianAgent has no emergency stop mechanism beyond killing the process. If an agent is misbehaving (generating harmful content, stuck in a loop burning tokens, writing bad files), the only option is to shut down the entire runtime.

**Koan's approach:** Three-level e-stop system: FULL (halt immediately, kill subprocess), READONLY (restrict all agents to read-only tools), PROJECT_FREEZE (block specific projects/agents while others continue). Never auto-resumes — always requires explicit human `/resume`. State persisted in JSON file, survives restarts.

**Proposal:** New `EmergencyStopService` in `src/runtime/`:

```typescript
type EStopLevel = 'full' | 'readonly' | 'agent_freeze';

interface EStopState {
  active: boolean;
  level: EStopLevel;
  frozenAgents: string[];     // For agent_freeze level
  reason: string;
  triggeredBy: string;        // 'user' | 'sentinel' | 'guardian_agent' | 'budget'
  triggeredAt: number;
  resumedBy?: string;
  resumedAt?: number;
}
```

**Severity levels:**
- **`full`:** All agent processing halts. Pending tool calls cancelled. All channels return "System paused — emergency stop active." Runtime stays alive for monitoring but processes no messages.
- **`readonly`:** All agents restricted to read-only tools. Schema-level enforcement (§3.3) removes mutating tools. Runtime admission pipeline rejects any mutating tool calls as defense-in-depth. Agents can still answer questions and read files.
- **`agent_freeze`:** Specific agents frozen (reject all messages). Other agents continue normally. Useful when one agent is misbehaving but others are fine.

**Trigger sources:**
- **Manual:** `/estop [level] [reason]` via CLI, Telegram command, or Web API `POST /api/estop`
- **Automatic:** SentinelAuditService detects anomaly above threshold → triggers `readonly`
- **Automatic:** BudgetTracker exhaustion → triggers `readonly` for the specific agent
- **Automatic:** GuardianAgentService rejects >5 consecutive tool calls → triggers `agent_freeze` on that agent

**Resume:** Always manual. `/resume` via CLI/Telegram/Web. Logged to audit trail. E-stop state persisted to `~/.guardianagent/estop.json`, survives restarts.

**Integration:**
- `Runtime.dispatch()` checks e-stop state before routing any message
- EventBus emits `estop_activated` / `estop_resumed` events
- Dashboard shows e-stop banner with level, reason, and resume button
- Audit log records all e-stop events

### 6.4 Drift Detection & Context Freshness (Medium Priority)

**Problem:** When a session starts (especially in autonomous/scheduled mode), the agent has no awareness of what changed in the codebase since its last interaction. It may operate on stale assumptions — referencing deleted files, missing new APIs, or conflicting with recent changes.

**Koan's approach:** `session_tracker.get_drift_summary()` runs `git log --oneline --since=<last_session_timestamp>` to count commits since the agent's last session. If 3+ commits landed, a drift warning with the commit list is injected into the prompt. Also detects if the agent's working branch has diverged from main.

**Proposal:** Add drift detection to the session startup flow:

```typescript
interface DriftReport {
  commitsSinceLastSession: number;
  lastSessionTimestamp: number;
  recentCommits: Array<{ hash: string; message: string; author: string }>;
  branchDivergence?: {
    ahead: number;
    behind: number;
    conflictingFiles: string[];
  };
  level: 'none' | 'minor' | 'significant';  // 0, 1-5, 6+ commits
}
```

**Implementation:**
- At session start, `DriftDetector` queries git for changes since the last `SessionOutcome` timestamp (§6.1)
- If `commitsSinceLastSession >= 3`, inject a system message:
  ```
  ⚠ Codebase drift: {N} commits landed since your last session ({timeAgo}).
  Recent changes:
  - {hash} {message}
  - ...
  Review these changes before modifying affected files.
  ```
- If branch divergence detected, additionally warn: "Your working context may reference files that have changed. Re-read before editing."
- For coding assistant (Part 4), show drift indicator in the file tree (files changed since last session highlighted)

**Config:**
```yaml
assistant:
  driftDetection:
    enabled: true
    minCommitsToWarn: 3
    checkBranchDivergence: true
```

### 6.5 Post-Execution Quality Gates (Medium Priority)

**Problem:** When the coding assistant (Part 4) or autonomous agents make changes, there's no automated quality check before the changes are presented to the user or auto-committed. The Guardian pipeline validates *security* (secrets, PII, capabilities) but not *code quality*.

**Koan's approach:** Post-mission quality pipeline scans for debug patterns (`console.log`, `debugger`, `TODO`, `FIXME`), validates branch hygiene, checks commit messages, optionally runs tests (120s timeout), and gates auto-merge on three independent checks (quality/lint/verification).

**Proposal:** New `QualityGateService` for coding assistant output:

```typescript
interface QualityReport {
  passed: boolean;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    details: string;
  }>;
}
```

**Quality checks:**

| Check | Type | Detection |
|-------|------|-----------|
| Debug artifacts | warn | `console.log`, `debugger`, `print()`, `dump()` in new/modified lines |
| Incomplete markers | warn | `TODO`, `FIXME`, `HACK`, `XXX` in new lines |
| Large change | warn | >500 lines changed in a single operation |
| Test regression | fail | If `code_test` was available and tests fail after changes |
| Lint violations | warn/fail | If `code_lint` was available and new violations introduced |
| Secret in diff | fail | SecretScanController applied to the git diff of changes |

**Integration:**
- Runs automatically after coding assistant tool calls that modify files
- Results shown in the code chat panel as a collapsible quality report
- `fail` checks block auto-commit (require explicit user override)
- `warn` checks are informational — shown but don't block
- Quality reports logged to analytics for trend analysis

**Config:**
```yaml
assistant:
  coding:
    qualityGates:
      enabled: true
      blockOnFail: true
      runTests: true
      testTimeout: 120000    # 2 minutes
      checks:
        debugArtifacts: warn
        incompleteMarkers: warn
        largeChange: warn
        testRegression: fail
        lintViolations: warn
        secretInDiff: fail
```

### 6.6 Feedback Learning from User Corrections (Low Priority)

**Problem:** When a user denies an approval, corrects the agent's output, or reverts a change, that feedback is lost. The agent makes the same mistakes in future sessions.

**Koan's approach:** `pr_review_learning.py` fetches GitHub PR review comments via `gh` API, sends them through a lightweight Claude call to extract actionable lessons, deduplicates against existing learnings, and persists to per-project `learnings.md`. These learnings are injected into future prompts, creating a genuine feedback loop.

**Proposal:** Extend `AgentMemoryStore` with structured feedback extraction:

**Feedback sources (in priority order):**
1. **Approval denials** — when a user denies a tool call, extract the tool name, args, and reason (if provided). Persist as a "don't do this" learning.
2. **User corrections** — when a user's next message after an agent response contains correction language ("no", "wrong", "instead", "actually"), extract the correction pattern.
3. **PR review comments** — if GitHub integration is configured, periodically fetch review comments on agent-created PRs (same approach as Koan).

**Learning extraction:**
```typescript
interface AgentLearning {
  source: 'approval_denial' | 'user_correction' | 'pr_review';
  agentId: string;
  timestamp: number;
  context: string;        // What the agent was doing
  lesson: string;         // What to do differently
  contentHash: string;    // For deduplication
}
```

**Implementation:**
- `LearningExtractor` service processes feedback events asynchronously
- For PR reviews: scheduled task (daily) fetches via `gh api` and runs lightweight LLM analysis
- Learnings stored in `AgentMemoryStore` with `[learning]` tag for retrieval
- Injected into system prompt in a `<learnings>` block (max 2000 chars, most recent first)
- Content-hash deduplication prevents duplicate entries

**Config:**
```yaml
assistant:
  learning:
    enabled: true
    sources:
      approvalDenials: true
      userCorrections: true
      prReviews: false        # Requires GitHub CLI configured
    maxLearnings: 50
    prReviewSchedule: '0 6 * * *'  # Daily at 6am
```

### 6.7 Pre-Task Specification for Complex Operations (Low Priority)

**Problem:** When agents tackle complex multi-step tasks (refactoring across multiple files, implementing a new feature, debugging a subtle issue), they often start executing immediately without a plan, leading to scattered changes and missed edge cases.

**Koan's approach:** `spec_generator.py` runs a separate, short Claude call with read-only tools to generate a specification document (Goal, Scope, Approach, Out of Scope) before the main implementation call. The spec is persisted and loaded into the agent's context, anchoring the work to a defined plan.

**Proposal:** Add optional spec generation to the coding assistant workflow:

**Trigger:** When a coding task is estimated to be complex (heuristic: user message contains >50 words, or mentions multiple files, or uses words like "refactor", "implement", "redesign").

**Flow:**
1. User submits complex coding request
2. Agent makes a short planning call (read-only tools, max 5 turns, lightweight model via §3.4)
3. Generates a structured spec: Goal, Scope (files to touch), Approach (ordered steps), Out of Scope
4. Spec shown to user for confirmation before proceeding
5. On confirmation, spec injected into the implementation call's context

**Implementation:** `SpecGeneratorTool` registered in the coding category:

```typescript
// code_plan tool
{
  name: 'code_plan',
  risk: 'read_only',
  description: 'Generate a structured implementation plan before making complex changes',
  args: { task: string, workspaceRoot: string },
  // Uses lightweight model, read-only tools only, max 5 turns
}
```

The spec is ephemeral (per-session, not persisted to memory), but the user can save it via the existing `memory_save` pathway if desired.

---

## Implementation Priority

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **P0** | Event-driven system reminders (3.1) | Medium | High — directly addresses instruction degradation |
| **P0** | Doom-loop detection (3.6) | Small | High — prevents token waste, easy to implement |
| **P0** | Graduated emergency stop (6.3) | Medium | High — critical safety control, no current equivalent |
| **P1** | Schema-level tool enforcement (3.3) | Small | High — defense-in-depth, small code change |
| **P1** | Five-stage context compaction (3.2) | Large | High — replaces blunt compaction with graduated approach |
| **P1** | Session outcome tracking (6.1) | Medium | High — enables staleness detection, feeds other systems |
| **P1** | Coding tools registration (4.4) | Medium | High — enables coding assistant functionality |
| **P1** | Fuzzy edit matching (4.5) | Medium | High — makes LLM-driven edits reliable |
| **P1** | Durable work-state model (5.5) | Medium | High — makes complex coding work resumable and inspectable |
| **P1** | Workflow invariant validator (5.6) | Medium | High — enforces review separation and DOD mechanically |
| **P2** | Code tab web UI (4.7) | Large | Medium — UX layer on top of coding tools |
| **P2** | Multi-session workspace UX + terminal tabs (4.3, 4.7) | Large | High — matches real coding workflows across projects |
| **P2** | Parallel execution conflict detection (3.5) | Small | Medium — prevents file write races |
| **P2** | Smart error classification (3.8) | Small | Medium — improves LLM error recovery |
| **P2** | Per-workflow model roles (3.4) | Medium | Medium — cost optimization |
| **P2** | Drift detection (6.4) | Small | Medium — prevents stale-context errors |
| **P2** | Post-execution quality gates (6.5) | Medium | Medium — code quality safety net for coding assistant |
| **P2** | Budget-aware mode adaptation (6.2) | Medium | Medium — cost optimization, graceful degradation |
| **P2** | Live operations monitor (5.7) | Medium | Medium — makes multiple active sessions operable |
| **P3** | Max dispatch depth (3.7) | Small | Low — safety net, already planned |
| **P3** | Approval persistence (5.1) | Medium | Medium — reduces approval fatigue |
| **P3** | Background task detection (5.2) | Small | Low — edge case improvement |
| **P3** | Artifact index preservation (5.3) | Small | Medium — preserves awareness through compaction |
| **P3** | Stratified memory (5.8) | Medium | Medium — improves retrieval quality over raw memory dumps |
| **P3** | Feedback learning (6.6) | Medium | Medium — closes the feedback loop |
| **P3** | Platform adapter layer (5.9) | Medium | Low — only needed if multi-engine support remains in scope |
| **P3** | Pre-task specification (6.7) | Small | Medium — improves complex task outcomes |
| **P4** | Playbook memory with scoring (5.4) | Large | Medium — longer-term memory evolution |

---

## Summary of Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Integrate OpenDev as dependency? | **No** | Python package, no npm module, early-stage, tight coupling |
| Port OpenDev code directly? | **No** | Port *patterns and algorithms* to TypeScript instead |
| Integrate Koan as dependency? | **No** | Python, GPL-3.0, CLI subprocess architecture incompatible with our event-driven model |
| Port Koan code directly? | **No** | GPL-3.0, different runtime model. Adopt *design patterns* (not copyrightable) |
| Adopt Koan's file-based IPC? | **No** | Our EventBus + SQLite approach is more robust for multi-agent. File-based IPC suits single-agent CLI tools |
| Adopt Koan's session tracking? | **Yes** | Production-proven pattern for detecting non-productive sessions. Port to SQLite-backed service |
| Adopt Koan's e-stop system? | **Yes — enhanced** | Our multi-agent model needs graduated controls. Koan's three-level approach is a solid foundation; add EventBus integration and automatic triggers from Guardian pipeline |
| Adopt Koan's drift detection? | **Yes** | Simple, high-value. Git-based, no new dependencies |
| Adopt Koan's quality gates? | **Yes — for coding assistant** | Complements our security pipeline with code quality checks |
| Adopt Koan's PR review learning? | **Yes — as optional integration** | Valuable feedback loop, but requires GitHub CLI. Make it opt-in |
| Overhaul smart routing? | **No — extend it** | Our per-category routing is validated by the paper; add per-workflow roles as a complementary layer |
| Overhaul orchestration agents? | **No — augment** | Add dispatch depth, doom-loop detection, schema-level enforcement. Core Sequential/Parallel/Loop design is sound |
| Adopt gru-ai's durable work-state model? | **Yes — but SQLite-first** | Valuable for resumability and operator visibility. Keep Guardian's event-driven runtime; use file exports as audit artifacts, not as IPC |
| Adopt gru-ai's invariant-driven workflow checks? | **Yes** | Review separation, DOD completion, and approval checkpoints should be mechanically enforced |
| Build coding assistant? | **Yes — as a multi-session workspace tab** | Dedicated UI + coding tools + workspace scoping + embedded terminals, all through existing Guardian pipeline |
| Borrow Broomy's multi-session/terminal UX? | **Yes — in web form** | Multiple active project sessions and per-session terminal tabs match real coding workflows better than a single chat pane |
| New security model for coding? | **No** | Use existing Guardian pipeline. Add workspace-root enforcement and command allowlist as tool-level policies |

---

## References

- [OpenDev GitHub](https://github.com/opendev-to/opendev) — MIT license, Python terminal coding agent
- [Building AI Coding Agents for the Terminal](https://arxiv.org/html/2603.05344v1) — Nghi D. Q. Bui, 2026
- [Koan GitHub](https://github.com/sukria/koan) — GPL-3.0, Python autonomous coding agent orchestrator
- `gru-ai` local review — `S:\Development\gru-ai`
- `Broomy` local review — `S:\Development\Broomy`
- [GuardianAgent Orchestration Spec](../specs/ORCHESTRATION-SPEC.md)
- [GuardianAgent Brokered Isolation Proposal](./BROKERED-AGENT-ISOLATION-PROPOSAL.md)
