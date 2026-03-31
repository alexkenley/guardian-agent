# Orchestration Specification

**Status:** Implemented current architecture

Guardian has distinct orchestration layers. They solve different problems and should not be collapsed into one vague “orchestrator” concept.

## 1. Intent Gateway

**Primary files:** `src/runtime/intent-gateway.ts`, `src/runtime/direct-intent-routing.ts`, `src/index.ts`, `src/worker/worker-session.ts`

This layer owns top-level turn interpretation and direct-action route selection.

Dedicated implementation spec: `docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md`

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
- pre-gateway interception is limited to slash-command parsing and real approval/continuation control-plane resumes
- deterministic fallbacks are allowed only when the gateway is unavailable or after a structured gateway decision has already narrowed the request

## 2. Pending Action Orchestration

**Primary files:** `src/runtime/pending-actions.ts`, `src/index.ts`, `src/runtime/intent-gateway.ts`

This layer owns blocked-work state across channels and routes.

Dedicated implementation spec: `docs/specs/PENDING-ACTION-ORCHESTRATION-SPEC.md`

It provides one canonical model for:
- approval required
- clarification required
- workspace switch required
- missing auth
- policy changes
- other recoverable missing-context blockers

Key rules:
- one active pending action per logical surface, with explicit transfer policy deciding whether the blocked work may also resolve from linked surfaces for the same assistant and user
- pending actions are durable and scoped by logical assistant, canonical user, channel, and surface
- follow-up turns should resolve against the stored pending action before trying to reconstruct intent from bounded history
- approvals and policy mutations remain origin-surface only even when other blocker kinds are portable
- user-facing blocked-work metadata uses `response.metadata.pendingAction`
- channel adapters render blocker-specific UX from the same shared metadata contract

## 3. Cross-Surface Continuity And Shared Context Assembly

**Primary files:** `src/runtime/continuity-threads.ts`, `src/runtime/context-assembly.ts`, `src/runtime/conversation.ts`, `src/runtime/agent-memory-store.ts`, `src/index.ts`

This layer owns the bounded state that lets linked first-party surfaces behave like one continuing task without collapsing them into one giant session model.

It provides:
- one continuity thread per logical assistant and canonical user
- linked-surface summaries, focus summaries, last actionable request, and active execution refs
- shared prompt/context packing for main chat, coding-session chat, and brokered workers
- incremental structured conversation flush into durable memory when prompt history is compacted
- signal-aware prompt-time memory selection with traceable selection metadata and compact match reasons

Key rules:
- continuity is bounded state, not an unbounded shared transcript bus
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

Current as-built delegation foundations:
- brokered worker dispatch records delegated lineage into assistant job state rather than leaving it as ad hoc log-only state
- operator-facing assistant job views now merge primary assistant jobs with delegated-worker jobs
- delegated run classes now exist for `in_invocation`, `short_lived`, `long_running`, and `automation_owned`
- delegated jobs carry a bounded handoff object with summary, unresolved blocker kind, approval count, next action, and reporting mode
- operator-facing assistant job summaries derive bounded display state for delegated origin, outcome, and follow-up instead of forcing channels to parse raw delegated metadata
- delegated completion now follows a server-owned reporting policy: `inline_response`, `held_for_approval`, `status_only`, or operator-held review
- clarification and workspace-switch delegated blockers can downgrade to status-only operator messaging while approval blockers stay inline and approval-held
- operator-held delegated results can be replayed, kept held, or dismissed through bounded operator controls instead of forcing a fresh worker run
- delegated follow-up state is projected into both assistant-job views and assistant-dispatch trace/timeline nodes instead of being implicit in raw worker prose
- delegated-worker lifecycle breadcrumbs are also recorded in audit

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

## 7. Agent Composition

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
