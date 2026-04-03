# Run Timeline And Event Viewer Spec

**Status:** Implemented current architecture
**Date:** 2026-03-31
**Roadmap:** [UI-TARS Uplift Roadmap](/mnt/s/Development/GuardianAgent/docs/plans/UI-TARS-UPLIFT-ROADMAP.md)
**Primary Runtime:** [orchestrator.ts](/mnt/s/Development/GuardianAgent/src/runtime/orchestrator.ts), [run-events.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-events.ts), [code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts), [index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
**Primary Web Surface:** [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts), [web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts), [app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js), [dashboard.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/dashboard.js), [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)

## Purpose

Phase 1 of the UI-TARS uplift should make Guardian's existing execution traces readable and live.

The goal is operator visibility, not a new execution engine. Guardian already has useful orchestration state, approval state, code-session work state, and deterministic workflow events. The missing piece is a first-class read model and UI surface that presents those events in the order the user actually cares about.

Current as-built deltas:
- the timeline projection is implemented as `src/runtime/run-timeline.ts`
- the Dashboard exposes a compact Routing Trace inspector alongside the execution timeline
- run and routing views support `continuityKey` and `activeExecutionRef` filters
- routing-trace rows can deep-link to the matched run, a best-fit timeline event, and the related coding session
- Automations history deep links support `assistantRunId` and `assistantRunItemId` so a caller can land on a specific timeline event instead of only the run row
- Coding Workspace deep links support `sessionId`, `assistantRunId`, and `assistantRunItemId` so a caller can land on the exact session-local activity event instead of only the run card
- Dashboard `Agent Runtime` and CLI `/assistant jobs` now expose merged assistant and delegated-worker jobs with bounded origin, outcome, and follow-up summaries, including replay controls for held delegated results
- delegated worker follow-up is now projected into assistant-dispatch traces and the global execution timeline as `Delegated follow-up` handoff nodes, including blocked approval-held and status-only outcomes
- assistant-dispatch runs now project bounded `provider_call` nodes so operators can see final model provenance, model id, duration, and token/cache usage without exposing raw prompts
- context-assembly nodes now carry bounded compaction diagnostics, including pre/post prompt size, applied stages, and compacted-summary preview when context had to be shortened for budget

## Problem Statement

Current behavior is functional but fragmented:

- `GET /api/assistant/state` exposes orchestrator summary and recent traces, but not a run-centric timeline model.
- [run-events.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-events.ts) defines `OrchestrationRunEvent`, but those events are not a typed, operator-facing web contract.
- The Code page refreshes `pendingApprovals`, `recentJobs`, and `verification` from the session snapshot, but those lists are not correlated into one ordered execution view.
- SSE currently streams chat, terminal, and security events, but there is no run lifecycle event family.

The result is that Guardian can tell the user that work happened, but it does not yet let the user reconstruct what happened in order, why the agent is paused, or what changed between steps.

## Goals

- expose a unified run timeline across assistant dispatch, deterministic workflow events, and coding-session activity
- provide typed HTTP and SSE contracts for recent runs and per-run detail
- add a dashboard surface for recent runs and live run status
- add a Code-page activity surface for approvals, tool jobs, and verification in one ordered stream
- keep the implementation bounded, read-only, and compatible with Guardian's current security model

## Non-Goals

- browser screenshots, visual grounding, or hybrid browser control
- human takeover and resume
- exportable or shareable run artifacts
- replacing the current orchestrator, code-session store, or workflow runtime
- adding a second durable database table just for timeline history
- removing the existing approvals/jobs/checks UI on day one

## Existing Sources Of Truth

Phase 1 should reuse current runtime data instead of inventing new semantics:

- [orchestrator.ts](/mnt/s/Development/GuardianAgent/src/runtime/orchestrator.ts)
  - `AssistantDispatchTrace`
  - `WorkflowTraceNode`
  - request lifecycle status and message previews
- [run-events.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-events.ts)
  - deterministic workflow and resume lifecycle events
- [code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
  - `pendingApprovals`
  - `recentJobs`
  - `verification`
- [index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
  - existing assembly of dashboard assistant state
  - current code-session mutations after tool execution and approvals
- [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
  - existing authenticated JSON endpoints
  - existing SSE transport

The Phase 1 job is to project these sources into one consistent read model.

Current delegation-related sources of truth also include:

- [assistant-jobs.ts](/mnt/s/Development/GuardianAgent/src/runtime/assistant-jobs.ts)
  - mutable high-level assistant and delegated-worker job records
  - merged operator-facing recent-job state
  - derived display state for delegated origin, outcome, and follow-up labels
- [worker-manager.ts](/mnt/s/Development/GuardianAgent/src/supervisor/worker-manager.ts)
  - delegated lineage metadata
  - bounded handoff summaries for brokered worker completions and failures
  - server-owned delegated follow-up policy (`inline_response`, `held_for_approval`, `status_only`)
  - held-result replay, keep-held, and dismiss controls for operator-held delegated completions

## Proposed Architecture

### 1. Add A Bounded Run-Timeline Projection

Add a new runtime module:

- `src/runtime/run-timeline.ts`

This module should be a bounded in-memory projection, not a new durable store.

Responsibilities:

- normalize live updates from orchestrator traces, workflow run events, and code-session work-state changes
- materialize recent run summaries for dashboard and Code UI queries
- materialize per-run ordered timeline items
- support incremental subscriptions so the web layer can emit SSE deltas

Recommended retention defaults:

- keep the most recent 200 runs in memory
- keep at most 300 timeline items per run
- evict completed runs after 24 hours unless they are still referenced by an active code session

Those numbers are deliberately modest. Phase 1 needs useful visibility, not a forever log.

### 2. Use A Derived Read Model, Not A New Execution Model

The timeline module should not become a second orchestrator.

It should derive from existing sources and stay secondary to them:

- orchestrator remains authoritative for assistant dispatch state
- deterministic workflow runtime remains authoritative for workflow run events
- code-session store remains authoritative for approvals, recent jobs, and verification state

If timeline projection state is lost on restart, the system should still function. The UI may show less history until new runs occur or a snapshot is reconstructed from existing persisted sources.

## Data Model

### Run Summary

Add a typed web-facing run summary shape in [web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts):

```ts
type DashboardRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'verification_pending'
  | 'blocked'
  | 'interrupted'
  | 'completed'
  | 'failed';

type DashboardRunKind =
  | 'assistant_dispatch'
  | 'automation_run'
  | 'code_session'
  | 'scheduled_task';

interface DashboardRunSummary {
  runId: string;
  parentRunId?: string;
  groupId: string;
  kind: DashboardRunKind;
  status: DashboardRunStatus;
  title: string;
  subtitle?: string;
  agentId?: string | null;
  channel?: string;
  sessionId?: string;
  codeSessionId?: string;
  requestType?: string;
  startedAt: number;
  completedAt?: number;
  lastUpdatedAt: number;
  durationMs?: number;
  pendingApprovalCount: number;
  verificationPendingCount: number;
  error?: string;
  tags: string[];
}
```

Notes:

- `groupId` should group related work. For assistant dispatch this maps naturally to `sessionId`.
- `title` should be user-facing and built from safe preview text already available in runtime state.
- Phase 1 should reserve `takeover_required` for a later phase, but it should not emit that state yet.

### Timeline Item

Add a bounded item shape for ordered event playback:

```ts
type DashboardRunTimelineItemType =
  | 'run_queued'
  | 'run_started'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'handoff_started'
  | 'handoff_completed'
  | 'verification_pending'
  | 'verification_completed'
  | 'note'
  | 'run_completed'
  | 'run_failed';

interface DashboardRunTimelineItem {
  id: string;
  runId: string;
  timestamp: number;
  type: DashboardRunTimelineItemType;
  status: 'info' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'warning';
  source: 'orchestrator' | 'workflow' | 'code_session' | 'system';
  title: string;
  detail?: string;
  nodeId?: string;
  toolName?: string;
  approvalId?: string;
  verificationKind?: 'test' | 'lint' | 'build' | 'manual';
  contextAssembly?: DashboardRunTimelineContextAssembly;
}
```

Rules:

- `detail` must stay within the existing safe preview boundary. Use `messagePreview`, `argsPreview`, `resultPreview`, and short verification summaries.
- `contextAssembly` is the typed operator-facing payload for bounded continuity, memory-scope, memory-selection, and knowledge-base diagnostics. Raw tool arguments or model prompts still do not belong here.
- `provider_call` nodes are operator-facing provenance only. They may include provider/model names, duration, and token/cache counts, but they must not include raw prompt bodies or unbounded tool payloads.
- `handoff_started` and `handoff_completed` items are also used for delegated-worker follow-up projection, not only deterministic workflow handoffs.
- Use stable ids from underlying entities where possible:
  - workflow event id
  - approval id
  - recent job id
  - verification id
  - synthetic ids for trace lifecycle items such as `trace:<requestId>:started`

### Run Detail

Expose a detailed shape that combines the run summary and ordered items:

```ts
interface DashboardRunDetail {
  summary: DashboardRunSummary;
  items: DashboardRunTimelineItem[];
}
```

This should be the payload returned by the run-detail endpoint and the base shape merged by the UI when it opens a run drawer or activity panel.

## Correlation Rules

The main implementation risk in Phase 1 is correlation.

`pendingApprovals`, `recentJobs`, and `verification` entries need deterministic attachment to a run. Without that, the Code UI would show interleaved session activity but not a per-run story.

### Required Correlation Fields

Extend code-session work-state entries with optional correlation metadata:

- `CodeSessionPendingApproval`
  - `runId?: string`
  - `requestId?: string`
  - `nodeId?: string`
- `CodeSessionRecentJob`
  - `runId?: string`
  - `requestId?: string`
  - `nodeId?: string`
- verification entries
  - `runId?: string`
  - `requestId?: string`
  - `jobId?: string`

These fields should be populated at the time Guardian mutates the code session, not retroactively guessed in the UI.

### Correlation Order

The projector should attach entries using this order:

1. explicit `runId`
2. explicit `requestId`
3. session-scoped fallback bucket `code-session:<sessionId>:unscoped`

Fallback buckets are acceptable for old sessions and migration gaps, but Phase 1 code paths should prefer explicit run correlation everywhere new state is written.

## Runtime Integration

### 1. Orchestrator Hooks

Add a small subscription surface to [orchestrator.ts](/mnt/s/Development/GuardianAgent/src/runtime/orchestrator.ts) so trace changes can be pushed, not polled.

Recommended shape:

- `subscribe(listener)`
- emit on:
  - trace queued
  - trace started
  - trace completed
  - trace failed
  - node added or updated

This is preferable to repeatedly diffing `orchestrator.getState()` from [index.ts](/mnt/s/Development/GuardianAgent/src/index.ts).

### 2. Workflow Run Event Hooks

Where Guardian currently creates or persists `OrchestrationRunEvent`, also forward the event to the timeline projector.

Phase 1 should reuse current event types:

- `run_created`
- `node_started`
- `node_completed`
- `approval_requested`
- `approval_denied`
- `run_interrupted`
- `run_resumed`
- `handoff_started`
- `handoff_completed`
- `verification_pending`
- `verification_completed`
- `run_completed`
- `run_failed`

Do not invent a second workflow-event vocabulary.

### 3. Code-Session Hooks

When code-session work state is updated, forward only timeline-relevant deltas:

- approval additions and removals
- recent job additions and status changes
- verification additions and status changes

This is the only new coupling Phase 1 needs between [code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts) and the run-timeline projection.

## Web API

Phase 1 should add dedicated endpoints instead of overloading `GET /api/assistant/state`.

### `GET /api/assistant/runs`

Purpose:

- recent run list for dashboard and other overview surfaces

Suggested query params:

- `limit`
- `status`
- `kind`
- `channel`
- `agentId`
- `codeSessionId`
- `continuityKey`
- `activeExecutionRef`

Response shape:

```ts
interface DashboardRunListResponse {
  runs: DashboardRunDetail[];
}
```

### `GET /api/assistant/runs/:runId`

Purpose:

- detail view for a selected run

Response shape:

```ts
DashboardRunDetail
```

### `GET /api/code/sessions/:id/timeline`

Purpose:

- session-scoped activity view for the Code page

Response shape:

```ts
interface DashboardCodeSessionTimelineResponse {
  codeSessionId: string;
  runs: DashboardRunSummary[];
}
```

Why a dedicated Code endpoint:

- the Code page already thinks in session scope
- it avoids turning the code UI into a generic assistant overview page
- it keeps code-session authorization checks aligned with the existing Code API path

## Deep-Link Semantics

Current operator deep-link semantics:
- `#/automations?assistantRunId=<runId>` opens the History & Timeline tab and highlights the matching run row
- `#/automations?assistantRunId=<runId>&assistantRunItemId=<itemId>` opens the same view and highlights the exact matching event card when present
- `#/code?sessionId=<sessionId>&assistantRunId=<runId>` opens the inspected Coding Workspace session in the `Activity` panel and highlights the matching run card
- `#/code?sessionId=<sessionId>&assistantRunId=<runId>&assistantRunItemId=<itemId>` opens the same view and highlights the exact matching session-local activity event when present
- routing-trace correlations are expected to use those same query parameters instead of inventing a second drill-down surface

## SSE Contract

Extend [web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts) and [app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js) with a new event type:

- `run.timeline`

Recommended payload:

```ts
interface DashboardRunTimelineSseEvent {
  runId: string;
  codeSessionId?: string;
  summary: DashboardRunSummary;
  items: DashboardRunTimelineItem[];
}
```

Semantics:

- every emission is an upsert for the summary
- `items` contains only newly appended or newly materialized timeline items
- the client deduplicates by item id
- full history comes from HTTP, not SSE replay

This matches the current web architecture:

- page loads fetch an initial JSON snapshot
- SSE carries live deltas

Do not send the full run payload on every event.

## UI Plan

### Dashboard

Add a recent-runs section to [dashboard.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/dashboard.js):

- show run title, status, source kind, agent, and relative time
- show badges for approvals pending and verification pending
- show last event detail or failure reason when present
- allow opening run detail inline or in a lightweight drawer

The dashboard should remain summary-first. It does not need full code-session detail density.

### Code Page

Add a new activity panel or activity tab to [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js):

- filter to the active `codeSessionId`
- group recent runs for that session
- render approvals, tool jobs, verification, and workflow markers in one ordered list
- keep the existing approvals and checks surfaces during the transition

Phase 1 should not try to delete or fully redesign the current Code page. The timeline is an additive operator aid first.

### Chat Surface

No new dedicated chat-page run viewer is required in Phase 1.

The dashboard and Code page are enough to validate the model before expanding it further.

## Security And Privacy Constraints

Phase 1 must preserve Guardian's current trust boundary.

- do not stream raw prompts, full tool arguments, or raw tool output into the timeline
- use only already-bounded preview fields and user-facing summaries
- keep all timeline endpoints behind the existing authenticated web surface
- enforce code-session ownership and attachment rules on `GET /api/code/sessions/:id/timeline`
- treat any future screenshot or browser artifact support as Phase 2 or later work

This is a visibility feature, not a new side channel.

## Implementation Breakdown

### Step 1. Add Timeline Types And Projection

Files:

- `src/runtime/run-timeline.ts` new
- `src/channels/web-types.ts`

Deliver:

- runtime projection API
- web-facing summary/detail/item types
- bounded retention rules

### Step 2. Add Runtime Producers

Files:

- `src/runtime/orchestrator.ts`
- `src/runtime/run-events.ts`
- `src/index.ts`
- `src/runtime/code-sessions.ts`

Deliver:

- orchestrator subscription hook
- workflow event forwarding
- code-session correlation fields
- code-session delta forwarding for approvals, recent jobs, and verification

### Step 3. Add Web Endpoints And SSE

Files:

- `src/channels/web.ts`
- `src/channels/web-types.ts`
- `web/public/js/api.js`
- `web/public/js/app.js`

Deliver:

- recent-runs endpoint
- run-detail endpoint
- code-session timeline endpoint
- `run.timeline` SSE event wiring

### Step 4. Add Dashboard UI

Files:

- `web/public/js/pages/dashboard.js`

Deliver:

- recent-runs summary panel
- live updates from `run.timeline`
- detail view for one selected run

### Step 5. Add Code UI

Files:

- `web/public/js/pages/code.js`

Deliver:

- session activity panel
- live merge of HTTP snapshot plus SSE deltas
- phase-one parity for approvals, recent jobs, and verification display

## Verification Plan

Required checks after implementation:

- `npm run check`
- `npx vitest run src/runtime/run-timeline.test.ts`
- `npx vitest run src/runtime/code-sessions.test.ts`
- any web endpoint or page tests added for the new contract
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`

If workflow surfaces are touched beyond read-model wiring, add targeted runtime coverage for those paths too.

## Risks And Mitigations

### Risk: Correlation Drift

Approvals and jobs might appear under the wrong run if correlation is inferred after the fact.

Mitigation:

- write correlation fields when the session state is mutated
- treat fallback session buckets as a compatibility path, not the default

### Risk: Web Payload Bloat

Sending whole trace snapshots repeatedly would make the UI slow and the SSE stream noisy.

Mitigation:

- keep full history on HTTP
- keep SSE delta-only
- bound item counts and preview length

### Risk: Leaking Too Much Execution Detail

Timeline work can accidentally become a prompt or tool-output leak.

Mitigation:

- reuse existing preview fields only
- avoid raw args and raw model content
- keep browser visuals out of Phase 1

## Open Questions

- Should deterministic scheduled-task history and assistant dispatch runs share one recent-runs list in the initial dashboard release, or should scheduled-task-only rows wait for a follow-up?
- Should the run-detail UI live as a shared component across dashboard and Code page, or should Phase 1 allow each page to render the same data differently?
- If a code-session run spans multiple assistant dispatch traces, should the Code page show them as separate runs or a grouped session activity cluster by default?

## Recommendation

Implement Phase 1 as a derived read model with explicit correlation and delta streaming.

That gives Guardian the UI-TARS-style operator visibility it is currently missing, while keeping the execution and trust model exactly where it already belongs.
