# Orchestration Design

**Status:** Implemented current architecture, including the durable execution-graph baseline

Guardian has distinct orchestration layers. They solve different problems and should not be collapsed into one vague “orchestrator” concept.

## Consolidated Scope

This document is now the active design contract for several previously separate implemented slice docs:

- agent orchestration recipes (`src/agent/recipes.ts`)
- shared orchestration state (`src/runtime/shared-state.ts`)
- multi-agent workflow hardening (`src/agent/orchestration.ts`, `src/runtime/orchestration-role-contracts.ts`, `src/supervisor/worker-manager.ts`)
- brokered DAG planning (`src/runtime/planner/`, `src/worker/worker-session.ts`)
- deterministic playbook resume (`src/runtime/graph-runner.ts`, `src/runtime/run-state-store.ts`, `src/runtime/graph-checkpoints.ts`)
- evidence-grounded deterministic playbook instruction steps (`src/runtime/connectors.ts`)

The older standalone docs have been moved to `docs/archive/design/` because their important current rules are captured here.

## 1. Intent Gateway

**Primary files:** `src/runtime/intent-gateway.ts`, `src/runtime/direct-intent-routing.ts`, `src/index.ts`, `src/worker/worker-session.ts`

This layer owns top-level turn interpretation and direct-action route selection.

Dedicated implementation spec: `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`

It classifies requests into routes such as:
- `automation_authoring`
- `automation_control`
- `ui_control`
- `browser_task`
- `workspace_task`
- `email_task`
- `search_task`
- `filesystem_task`
- `coding_task`
- `security_task`
- `general_assistant`

Key rules:
- classification is structured, not freeform prose
- no tool execution happens during classification
- the gateway is authoritative in the normal path
- in Auto tier mode, the local vs external tier decision is made from the structured gateway result, not from raw-text heuristics
- the gateway also determines whether the current turn is a new request, follow-up, clarification answer, or correction
- typed clarification state is resolved through the gateway, not by raw keyword interception
- if the gateway cannot safely choose between top-level routes, it should emit an `intent_route` clarification through shared pending-action orchestration instead of silently picking the most likely route
- pre-gateway interception is limited to slash-command parsing and real approval/continuation control-plane resumes
- direct capability lanes only run from explicit structured gateway decisions
- gateway-unavailable and low-confidence `general_assistant` / `unknown` results fall back to normal assistant or bounded degraded handling instead of heuristic capability capture

## 2. Execution State And Pending Action Orchestration

**Primary files:** `src/runtime/executions.ts`, `src/runtime/pending-actions.ts`, `src/runtime/chat-agent/intent-gateway-orchestration.ts`, `src/index.ts`, `src/runtime/intent-gateway.ts`

This layer owns durable request identity, blocked-work state, resume behavior, and cross-turn continuation correctness across channels and routes.

Dedicated implementation specs:
- `docs/design/EXECUTION-STATE-DESIGN.md`
- `docs/design/PENDING-ACTION-ORCHESTRATION-DESIGN.md`

It provides one canonical model for:
- request identity and lineage
- approval required
- clarification required
- workspace switch required
- missing auth
- policy changes
- other recoverable missing-context blockers

Key rules:
- every meaningful user request should have a durable execution record
- one active pending action per logical surface, with explicit transfer policy deciding whether the blocked work may also resolve from linked surfaces for the same assistant and user
- pending actions are the operator-facing blocker projection over that execution state and are scoped by logical assistant, canonical user, channel, and surface
- follow-up turns should resolve against the stored pending action and active execution before trying any continuity fallback
- route-confirmation questions are just another shared clarification blocker; they do not create a second route-resolution subsystem
- unrelated turns do not clear the active pending slot
- a colliding new blocked request requires explicit switch confirmation before it replaces the current slot
- approvals and policy mutations remain origin-surface only even when other blocker kinds are portable
- user-facing blocked-work metadata uses `response.metadata.pendingAction`
- channel adapters render blocker-specific UX from the same shared metadata contract
- channels only inline blocked-work UI when the current response itself carries `response.metadata.pendingAction`; durable slot state is still available for explicit recovery/status views

## 3. Cross-Surface Continuity And Shared Context Assembly

**Primary files:** `src/runtime/continuity-threads.ts`, `src/runtime/context-assembly.ts`, `src/runtime/conversation.ts`, `src/runtime/agent-memory-store.ts`, `src/index.ts`

This layer owns the bounded state that lets linked first-party surfaces behave like one continuing task without collapsing them into one giant session model.

Authoritative shared prompt/context contract:
- `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`

It provides:
- one continuity thread per logical assistant and canonical user
- linked-surface summaries and active execution refs
- shared prompt/context packing for main chat, coding-session chat, and brokered workers
- incremental structured conversation flush into durable memory when prompt history is compacted
- signal-aware prompt-time memory selection with traceable selection metadata and compact match reasons

### Shared Orchestration State

`SharedState` is the transient inter-agent data-passing primitive used by orchestration agents.

Current contract:
- owned by the orchestrator, not by sub-agents
- scoped to one orchestration invocation
- supports regular keys and `temp:` keys
- stores per-key metadata (`producerAgent`, timestamp, schema validation status, taint reasons)
- enforces a bounded `maxStateBytes` capacity, defaulting to 10 MB
- exposes read-only views through `SharedStateView` when a caller explicitly needs that shape
- does not persist to SQLite or disk

Sub-agents should receive only the bounded input the orchestrator chooses to dispatch. Shared state is not a general cross-agent memory bus.

Key rules:
- continuity is bounded state, not an unbounded shared transcript bus
- continuity is a projection of the active task, not the primary semantic authority for continuation
- portability decisions use explicit blocker transfer policy plus continuity linkage, not raw channel guessing
- prompt assembly is shared and structured; new orchestration context should be added there rather than appended ad hoc in one caller
- approvals, auth, workspace trust, and code-session execution boundaries remain explicit even when continuity links multiple surfaces

## 4. Automation Authoring And Control

**Primary files:** `src/runtime/automation-authoring.ts`, `src/runtime/automation-prerouter.ts`, `src/runtime/automation-control-prerouter.ts`, `src/runtime/automation-save.ts`, `src/runtime/automation-runtime-service.ts`

This layer turns routed automation requests into canonical control-plane operations.

### Authoring

Authoring flow:

```text
IntentGateway -> AutomationIR -> repair + validation -> draft or ready -> automation_save
```

Outcomes:
- `workflow`
- `assistant_task`
- `standalone_task`
- draft clarification when required fields are missing

### Control

Control requests operate on the canonical automation catalog:
- inspect
- run
- enable
- disable
- delete

These paths use:
- `automation_list`
- `automation_run`
- `automation_set_enabled`
- `automation_delete`

## 5. Request Orchestration

**Primary files:** `src/runtime/orchestrator.ts`, `src/runtime/assistant-jobs.ts`, `src/supervisor/worker-manager.ts`

This is the session-level admission and queueing layer.

It:
- serializes requests per session identity
- allows unrelated sessions to run in parallel
- tracks queue depth, latency, and job state
- owns request scheduling and observation, not automation definition shape
- supports backend-enforced request cancellation by passing standard `AbortSignal` primitives from the channel endpoints through the orchestrator queue, agent handlers, and intent gateways down to the underlying LLM provider fetch calls
- on cancellation, instantly kills the underlying execution, aborts in-flight network requests, clears any pending items queued behind the canceled request, and resets the orchestration session to prevent blocked queues and leaked execution context

Current as-built delegation foundations:
- brokered worker dispatch records delegated lineage into assistant job state rather than leaving it as ad hoc log-only state
- delegated child runs preserve execution lineage through `executionId`, `parentExecutionId`, and `rootExecutionId` correlation where available
- delegated child work now receives a server-selected execution profile derived from the parent execution profile, the routed workload shape when present, and the target orchestration role descriptor
- explicit request-scoped provider overrides stay sticky across delegated handoff, while auto-selected turns may specialize different child roles onto different configured providers concurrently
- delegated retry policy now keys off the effective delegated workload, not only the happy-path handoff metadata; Guardian derives the child intent from the routed decision plus the orchestration role when needed so the coordinator can still enforce repo-grounded sufficiency and escalation rules
- delegated verification reconciles typed worker result envelopes against the server-owned tool job ledger before deciding success, retry, or failure; degraded worker prose cannot erase successful tool evidence already observed by the supervisor
- exact repo-grounded delegated inspections now pass through a server-owned sufficiency gate; if the first completed child answer still admits truncation or uncertainty without returning the exact file references requested, orchestration may retry once on a stronger eligible execution profile and otherwise fails the delegated outcome instead of accepting the weak answer
- retry directives are shaped by the unsatisfied planned-step kind; for example, failed filesystem write steps retry as filesystem mutation work instead of broad repo-inspection work
- hybrid read/write turns are managed as one delegated job with a read-only direct-reasoning exploration phase followed by delegated mutation; WorkerManager derives satisfied read/search receipts from the supervisor-owned tool job ledger and passes them into the delegated write phase as `priorSatisfiedStepReceipts`
- last-resort recovery is manager-owned and advisory: after deterministic verification still finds missing evidence, WorkerManager may ask the brokered worker for a no-tools JSON recovery proposal, validate it against the unsatisfied planned steps, and use it only as one retry guidance section
- recovery-advisor output never satisfies a contract, approves a blocked action, changes sandbox/tool policy, or bypasses receipts; the normal verifier remains the authority
- non-terminal delegated completions such as progress-only replies are also treated as retryable coordinator failures; Guardian may escalate those once onto a stronger eligible profile before surfacing a terminal failure to the operator
- operator-facing assistant job views now merge primary assistant jobs with delegated-worker jobs
- delegated run classes now exist for `in_invocation`, `short_lived`, `long_running`, and `automation_owned`
- delegated worker setup can attach structured orchestration role descriptors such as coordinator, explorer, implementer, and verifier, and known capabilities narrow against runtime-owned contracts before the worker runs
- delegated jobs carry a bounded handoff object with summary, unresolved blocker kind, approval count, next action, and reporting mode
- operator-facing assistant job summaries derive bounded display state for delegated origin, outcome, and follow-up instead of forcing channels to parse raw delegated metadata
- delegated completion now follows a server-owned reporting policy: `inline_response`, `held_for_approval`, `status_only`, or operator-held review
- clarification and workspace-switch delegated blockers can downgrade to status-only operator messaging while approval blockers stay inline and approval-held
- operator-held delegated results can be replayed, kept held, or dismissed through bounded operator controls instead of forcing a fresh worker run
- delegated follow-up state is projected into both assistant-job views and assistant-dispatch trace/timeline nodes instead of being implicit in raw worker prose
- delegated-worker lifecycle breadcrumbs are also recorded in audit

Brokered DAG planning:
- `complex_planning_task` is preserved as a gateway route and handled inside the brokered worker
- planner components live under `src/runtime/planner/` and are instantiated by `src/worker/worker-session.ts`
- planner LLM calls use the worker's brokered chat path; the worker remains network-disabled
- executable planner actions are currently `tool_call` and `execute_code`
- unsupported planner actions fail closed instead of being emulated by the supervisor
- tool execution still crosses the supervisor-owned `ToolExecutor`, Guardian, approvals, sandbox, audit, and taint path
- approval pauses keep planner node metadata, approval IDs, job IDs, and trust state so resume continues the existing plan

Agent orchestration recipes:
- `planner -> executor -> validator`
- `researcher -> writer -> reviewer`
- `research -> draft -> verify`

Recipes are thin wrappers over existing orchestration primitives. They do not create persisted automation definitions, new authority, or a separate user-facing workflow builder.

Current limitation:
- delegated worker completion is still normalized around bounded handoff metadata plus result content
- the sufficiency gate and retry policy prevent weak delegated completions from being treated as success, but they do not by themselves remove upstream tool-result truncation or guarantee that the first worker picked the best possible tool plan
- recovery-advisor retry can repair some late failures, but it is intentionally bounded to one validated retry and should not become a second planner or an unbounded loop
- the stronger split into distinct user-facing summary, evidence bundle, and machine-readable next-action channels is still follow-on work

## 5b. Durable Execution Graph

**Primary files:** `src/runtime/execution-graph/`, `src/runtime/graph-checkpoints.ts`, `src/runtime/run-timeline.ts`

The durable execution-graph baseline is now implemented as a shared runtime module. It does not replace every legacy orchestrator path yet, but it is the current owner for graph-shaped node execution, typed artifacts, checkpointable transitions, worker suspension/resume, pending-action adaptation, timeline projection, node recovery, and delegated-worker verification/retry behavior.

Implemented graph concepts:

- request-scoped execution graph identity
- typed graph/node/run/artifact contracts in `src/runtime/execution-graph/types.ts`
- graph controller, store, event, artifact, and checkpoint support
- node runners for direct reasoning, synthesis, mutation, delegated-worker execution, verification, and recovery
- pending-action adaptation for graph blockers
- worker suspension/resume artifacts for interrupted delegated work
- run-timeline projection from graph lifecycle events
- bounded recovery and retry rules that cannot approve actions or mark work complete without verifier evidence

Direct reasoning becomes an `explore_readonly` node. Delegated workers become `delegated_worker` or `mutate` node runners. Grounded synthesis becomes a no-tools `synthesize` node over typed evidence artifacts. Hybrid read/write requests should pass artifacts between nodes instead of prose between workers.

Security invariants remain unchanged:

- the Intent Gateway remains the only semantic route classifier
- brokered workers cannot access supervisor `Runtime`, `ToolExecutor`, provider objects, channel adapters, or raw filesystem authority
- all mutations execute through supervisor-owned `ToolExecutor`, Guardian policy, approvals, and audit
- graph events and run-timeline payloads must use bounded previews and must not expose raw prompts, raw secrets, or unbounded tool output

Current limitation:
- legacy assistant dispatch, deterministic workflows, and older delegated-worker handoff code still coexist with the graph module
- future work should migrate remaining prompt-specific repair paths into graph-native node contracts instead of adding another orchestration adapter

## 5a. System-Owned Background Maintenance

**Primary files:** `src/runtime/orchestrator.ts`, `src/runtime/assistant-jobs.ts`, `src/runtime/conversation.ts`, `src/runtime/agent-memory-store.ts`

This layer owns bounded runtime hygiene work that should not run as ad hoc prompt logic or as a second hidden assistant.

Companion contracts:
- `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`
- `docs/design/MEMORY-SYSTEM-DESIGN.md`

Representative jobs:
- maintained session-summary refresh
- memory extraction from compacted/dropped context
- periodic consolidation or coalescing of durable memory
- non-blocking retrieval prefetch or cache refresh work when surfaced as explicit runtime jobs

Key rules:
- these jobs are server-owned and do not create new user-facing authority
- they run with explicit budgets, locking, and idempotent retry/skip behavior
- they must remain visible in shared job/timeline/audit surfaces instead of becoming invisible background prompt work
- their outputs enter user-facing context only through bounded artifacts such as maintained summaries, reviewed memory entries, or trace-safe diagnostics
- they do not bypass approval, trust, or memory-scope boundaries

## 6. Deterministic Workflow Runtime

**Primary files:** `src/runtime/connectors.ts`, `src/runtime/graph-runner.ts`, `src/runtime/graph-types.ts`, `src/runtime/run-state-store.ts`, `src/runtime/run-events.ts`

This layer executes saved step-based automations.

It provides:
- graph-backed workflow execution
- stable `runId`
- node-level orchestration events
- checkpointed transitions
- persisted bounded resume context
- approval-safe deterministic resume

Resume state:
- `RunStateStore` persists checkpoints through `InMemoryRunStateStore` or `JsonFileRunStateStore`
- the runtime wires JSON persistence at `~/.guardianagent/playbook-run-state.json`
- `GraphRunCheckpoint` records `nextNodeId`, pending approval IDs, and bounded resume context
- `ConnectorPlaybookService.continueAfterApprovalDecision(...)` resumes the same graph run after approval decisions resolve

Evidence-grounded instruction steps:
- instruction steps support `evidenceMode: none | grounded | strict`
- instruction steps support `citationStyle: sources_list | inline_markers`
- prior tool outputs are normalized into citations/evidence when available
- `strict` mode fails early when no prior evidence exists and validates required citation/source output
- run history carries citations and evidence for inspection and evals

Supported workflow step types:
- `tool`
- `instruction`
- `delay`

## 7. Scheduled And Manual Automation Runtime

**Primary files:** `src/runtime/scheduled-tasks.ts`, `src/runtime/automation-runtime-service.ts`

This layer executes task-backed automations and schedules workflow runs.

It supports:
- manual-only assistant automations via automation-scoped event triggers
- manual-only standalone tool automations via automation-scoped event triggers
- scheduled workflow runs via linked task records
- scheduled assistant runs via cron
- `runOnce` execution
- active-run locking
- bounded authority, scope, and budget enforcement

Important distinction:
- a saved automation is the product object
- schedule, manual trigger, and run history are execution properties of that object

## 8. Agent Composition

**Primary files:** `src/agent/orchestration.ts`, `src/agent/conditional.ts`, `src/agent/recipes.ts`

This is structured multi-agent composition inside one invocation.

Available primitives:
- `SequentialAgent`
- `ParallelAgent`
- `LoopAgent`
- `ConditionalAgent`

Recipes build on those primitives for repeatable flows such as:
- `planner -> executor -> validator`
- `researcher -> writer -> reviewer`
- `research -> draft -> verify`

Sub-agent work still flows through runtime dispatch, so approval, capability, taint, and handoff-contract controls remain supervisor-owned.

## Background Delegation Guidance

Brokered worker delegation is not a second user-facing orchestration system.

It should continue to follow these rules:
- preserve lineage back to the originating request, continuity thread, and code session when present
- keep delegated model-profile selection server-owned and deterministic instead of letting workers self-select providers or infer them from prose
- allow child tasks to use different configured providers when the request is in auto-selection mode and the structured child workload meaningfully differs from the parent
- let the coordinator promote a delegated task onto a stronger eligible profile when the first child run returns a non-terminal progress update or an insufficient exact-file repo answer
- keep completion handoff state bounded and structured instead of treating delegated outcome as arbitrary prose
- surface delegated status through the same operator views that already expose assistant jobs, traces, and timeline state
- normalize delegated follow-up policy on the server so clarification/workspace blockers can downgrade to status-only operator messaging while approval blockers stay approval-held
- derive bounded delegated display summaries centrally so channels render the same operator-facing follow-up semantics instead of inventing their own string parsing
- keep held-result replay under the same bounded output-guard path rather than letting delegated results bypass normal response sanitization
- keep follow-up policy server-owned so delegated work does not gain new authority or silently cross trust boundaries

## Runtime Model

```text
User message / scheduled trigger / manual automation trigger
  -> IntentGateway
  -> Execution record create/update
  -> PendingAction prerequisite resolution / resume
  -> Optional tier selection from structured intent result
  -> Optional automation authoring or automation control layer
  -> Request orchestration
  -> Optional deterministic workflow runtime
  -> Runtime dispatch
  -> Optional agent composition
  -> Tools / providers / sub-agents
```

## Guidance

- Use the intent gateway for top-level route selection.
- Use the pending-action layer for blocked execution, approvals, clarifications, and resume semantics.
- Use the automation authoring/compiler path for conversational automation creation and updates.
- Use automation control tools for saved automation operations.
- Use the deterministic workflow runtime for explicit repeatable step graphs.
- Use assistant automations when runtime inspection and synthesis must remain adaptive.
- Use agent recipes for developer-authored multi-agent flows inside one request, not as a second end-user automation system.
- Use system-owned background maintenance for bounded summary refresh, extraction, consolidation, and other hygiene work instead of hiding those behaviors inside ad hoc prompt assembly.
