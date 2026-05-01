# Execution State Design

> Current convergence of gateway routing, delegated completion, verifier authority, execution-state boundaries, and durable graph projection is tracked in [ORCHESTRATION-DESIGN.md](./ORCHESTRATION-DESIGN.md). The earlier realignment record is archived in [INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md](../plans/archive/INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md).

**Status:** Implemented current architecture

This spec defines Guardian's first-class execution model for user work.

It is the authoritative spec for:
- durable request identity
- execution scope, intent, blocker, and status state
- retry, resume, correction, and continuation resolution
- parent/root/retry lineage across delegated work
- the relationship between execution state, pending actions, continuity, and run timeline projection

## Primary Files

- `src/runtime/executions.ts`
- `src/runtime/continuity-threads.ts`
- `src/runtime/pending-actions.ts`
- `src/runtime/chat-agent/intent-gateway-orchestration.ts`
- `src/runtime/assistant-jobs.ts`
- `src/supervisor/worker-manager.ts`
- `src/runtime/run-timeline.ts`
- `web/public/js/chat-run-tracking.js`

## Goals

- Give every meaningful user request a durable execution identity.
- Make resume, retry, clarification, and correction bind to execution state instead of transcript guesswork.
- Preserve lineage when work is delegated to a brokered worker or child task.
- Keep operator-facing blocker UX and continuity views as projections of execution state rather than competing sources of truth.

## Non-Goals

- Reconstructing older requests from chat text alone when execution state is missing.
- Treating continuity summaries as authoritative semantic routing input.
- Defining the full orchestration convergence program here. Active orchestration and durable-graph ownership lives in [ORCHESTRATION-DESIGN.md](./ORCHESTRATION-DESIGN.md).

## Core Model

`ExecutionStore` persists `ExecutionRecord` objects keyed by `executionId`.

Each execution record currently carries:
- identity: `executionId`, `requestId`, `rootExecutionId`
- lineage: optional `parentExecutionId`, optional `retryOfExecutionId`
- scope: assistant id, user id, channel, surface id, optional code session id, optional continuity key
- intent: route, operation, summary, turn relation, resolution, missing fields, original user content, optional resolved content, provenance, and entities
- status: `running`, `blocked`, `completed`, `failed`, or `cancelled`
- blocker: optional structured blocker with prompt, kind, field, options, approvals, workspace-switch details, and metadata
- timestamps and last user content

Execution intent is the durable version of "what this request actually is." When a later turn says "retry", "use Claude Code instead", or "did that work?", the runtime should resolve that against the execution record before looking at raw chat history.

Execution creation rule:
- the first creation of a new execution record must persist the current classified intent fields, not only `originalUserContent`
- continuity execution refs and operator summaries should therefore read from the same durable execution intent instead of falling back to placeholder labels such as "No classification summary provided."
- internal fallback summaries such as unstructured-gateway copy or harness-only placeholder labels must be filtered at the execution, pending-action, and continuity storage boundaries so they never become durable operator-facing state

## Lifecycle

Normal flow:

```text
Incoming user turn
  -> Intent Gateway classification
  -> create or update execution record
  -> execute directly or delegate
  -> update execution status as running / blocked / completed / failed
```

Blocked flow:

```text
Execution running
  -> prerequisite discovered
  -> attach structured blocker to execution
  -> create/update pending action for operator UX
  -> execution becomes blocked
  -> user resolves blocker
  -> clear blocker and resume the same execution
```

Delegated flow:

```text
Parent execution
  -> delegated worker or child task starts
  -> child run keeps parent/root execution lineage
  -> coordinator resolves an effective delegated intent from routed gateway state plus the orchestration role when needed
  -> child execution profile may be specialized from the parent profile plus structured delegated role/workload data
  -> worker emits progress + bounded handoff metadata
  -> if the child returns a progress-only non-terminal response or an insufficient exact-file repo answer, coordinator may retry once on a stronger eligible profile
  -> parent and child timeline views stay correlated by execution lineage
```

Delegated-profile rule:
- explicit request-scoped provider overrides stay bound to the execution across child handoff
- otherwise the coordinator may choose different provider profiles for different child tasks when their structured delegated workloads differ

## Continuation Rules

Guardian should resolve follow-up turns in this order:

1. active pending action, when the user is clearly satisfying a blocker
2. active execution intent, when the turn is a retry, status check, or correction
3. continuity-thread fallback such as `lastActionableRequest`, only when execution-backed state is unavailable
4. clarification or inspect-first handling if the request is still ambiguous

Key rules:
- a short turn does not automatically inherit the previous task
- a `new_request` should remain a new request unless the runtime has explicit evidence that the user is correcting or resuming the same execution
- the gateway may produce `resolvedContent` for a correction or clarification answer; downstream execution should use that repaired content
- top-level route confirmations should preserve the original request content and only replace the missing route choice, so a reply like `Repo work` or `Guardian page` resumes the stored request instead of becoming the new task body
- retry/resume resolution should prefer `resolveExecutionIntentContent(...)` from the active execution record over transcript heuristics
- continuity is a projection and fallback aid, not the main semantic engine

## Older Message References

When the user refers back to older work such as:
- `did that work?`
- `try that again`
- `use Claude Code instead`
- `break that down first`

Guardian should not scan assistant prose and guess.

Instead:
- if there is an active execution, use its stored intent
- if the turn is satisfying a blocker, resume the blocked execution
- if the active execution is missing but the continuity thread still carries a valid last actionable request, use that as a bounded fallback
- if the reference cannot be resolved safely, ask for clarification instead of silently resuming the wrong task

The same rule applies when the user is clarifying route intent:
- if Guardian asked "Did you mean repo work or workspace/session control?", the follow-up answer must bind to the stored execution and original request
- Guardian should not answer the short clarification reply in isolation

## Relationship To Pending Actions

Pending actions are the operator-facing blocker contract.

Execution state is the durable request-state contract.

The intended relationship is:
- execution record owns the blocked request and blocker semantics
- pending action projects the blocker into channel-safe UX and recovery metadata
- clearing or satisfying the pending action should clear or update the execution blocker, not create a second independent resume model

## Relationship To Continuity Threads

Continuity threads still matter, but they are not the primary source of semantic truth.

They currently provide:
- continuity key
- linked surfaces
- optional active execution refs
- optional continuation-state summary
- optional human-facing focus summary and last actionable request

Current rule:
- the classifier may use structured continuity projection such as continuity key, linked surfaces, continuation state, and active execution refs
- free-text continuity summaries should not become a shadow classifier
- human-friendly continuity summaries remain useful for operators, debug output, and fallback recovery, but execution state owns continuation correctness

## Delegated Worker Handoff

Current as-built delegated worker completion uses a bounded `DelegatedWorkerHandoff` derived from worker result metadata.

That handoff currently carries:
- summary
- unresolved blocker kind
- approval count
- run class
- next action
- reporting mode
- optional operator state

Current reporting modes:
- `inline_response`
- `held_for_approval`
- `status_only`
- operator-held review for long-running or automation-owned delegated runs

Important current limitation:
- the worker handback still normalizes around `result.content` plus metadata and bounded handoff state
- the final split into separate typed channels such as `evidence`, `userSummary`, `progressEvents`, and `nextAction` is still follow-on work

## Run Timeline And UI Correlation

Run and delegated-task timeline entries may carry:
- `executionId`
- `parentExecutionId`
- `rootExecutionId`
- `continuityKey`
- `activeExecutionRef(s)`

The web run-matching path now correlates by execution lineage as well as run id and code session id. This prevents chat/timeline views from attaching only to the parent run when the useful work is happening in a delegated child run.

## Current Constraint

Guardian now has first-class execution records, but it does not yet expose a fully general execution DAG with rich node-level child-task state everywhere.

Current as-built lineage is:
- request-level execution records
- parent/root/retry links
- delegated child run correlation in assistant jobs and run timeline

That is enough to make continuation and delegation materially safer and more understandable without pretending the broader graph problem is already finished.

## Related Designs

- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`
- `docs/design/ORCHESTRATION-DESIGN.md`
- `docs/design/PENDING-ACTION-ORCHESTRATION-DESIGN.md`
- `docs/design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md`
