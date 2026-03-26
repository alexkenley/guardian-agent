# Orchestration Specification

**Status:** Implemented current architecture

Guardian has distinct orchestration layers. They solve different problems and should not be collapsed into one vague “orchestrator” concept.

## 1. Intent Gateway

**Primary files:** `src/runtime/intent-gateway.ts`, `src/runtime/direct-intent-routing.ts`, `src/index.ts`, `src/worker/worker-session.ts`

This layer owns top-level direct-action route selection.

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
- heuristic intent parsing exists only as a fail-safe when the gateway is unavailable

## 2. Automation Authoring And Control

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

## 3. Request Orchestration

**Primary files:** `src/runtime/orchestrator.ts`, `src/runtime/assistant-jobs.ts`

This is the session-level admission and queueing layer.

It:
- serializes requests per session identity
- allows unrelated sessions to run in parallel
- tracks queue depth, latency, and job state
- owns request scheduling and observation, not automation definition shape

## 4. Deterministic Workflow Runtime

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

## 5. Scheduled And Manual Automation Runtime

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

## 6. Agent Composition

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

## Runtime Model

```text
User message / scheduled trigger / manual automation trigger
  -> IntentGateway
  -> Optional automation authoring or automation control layer
  -> Request orchestration
  -> Optional deterministic workflow runtime
  -> Runtime dispatch
  -> Optional agent composition
  -> Tools / providers / sub-agents
```

## Guidance

- Use the intent gateway for top-level route selection.
- Use the automation authoring/compiler path for conversational automation creation and updates.
- Use automation control tools for saved automation operations.
- Use the deterministic workflow runtime for explicit repeatable step graphs.
- Use assistant automations when runtime inspection and synthesis must remain adaptive.
- Use agent recipes for developer-authored multi-agent flows inside one request, not as a second end-user automation system.
