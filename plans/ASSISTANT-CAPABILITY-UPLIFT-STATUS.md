# Assistant Capability Uplift Status

**Date:** 2026-03-31  
**Status:** Active tracker  
**Companion roadmap:** [ASSISTANT-CAPABILITY-UPLIFT-ROADMAP.md](/mnt/s/development/guardianagent/plans/ASSISTANT-CAPABILITY-UPLIFT-ROADMAP.md)

---

## Purpose

This is the live implementation-status companion to the uplift roadmap.

Use it to track:
- what has landed
- what is currently being worked
- what still remains

Keep this document short and current. The roadmap explains why and sequencing; this tracker explains status.

---

## Overall Status

Current state:
- foundation uplift is substantially in place
- continuity, memory, context assembly, and operator trace visibility are no longer just design work
- background delegation is now in progress, with the runtime foundation slice landed

Recommended reading order:
1. this status tracker
2. the roadmap
3. the companion plan for the specific workstream

---

## Workstream Status

| Workstream | Status | Notes |
|---|---|---|
| Cross-surface continuity | In progress | Core model landed; some polish remains |
| Memory system uplift | In progress | Retrieval/flush foundation and signal-aware ranking landed; broader recall quality still remains |
| Context assembly uplift | In progress | Shared packer landed; further refinement remains |
| Routing / trace observability | In progress | Strong operator visibility now exists, including Code workbench exact-event drill-down |
| Background delegation uplift | In progress | Delegated lineage, bounded handoff summaries, follow-up policy, run classes, replay controls, timeline projection, and operator job visibility landed; broader producer adoption and long-running flows still remain |
| Minimal embeddable kernel posture | Design only | Should keep shaping implementation choices |
| Intelligence-in-depth alignment | Design only | Architectural guidance in place; runtime rollout still pending |

---

## Landed

### Continuity and blocked-work foundation

- bounded continuity-thread store across linked first-party surfaces
- shared pending-action model remains canonical for blocked work
- transfer-policy support for portable blocked work across linked surfaces for the same assistant and user
- workspace-switch resume flow built on the shared pending-action model

### Shared context assembly

- one shared bounded context builder for main chat, Code-session chat, and worker handoff
- structured continuity, blocker, memory, and evidence packing instead of ad hoc prompt concatenation
- continuity/context metadata carried into traces and operator surfaces

### Memory uplift foundation

- incremental structured conversation flush into durable memory
- query-aware prompt-time memory selection
- structured signal-aware retrieval using text, focus phrases, tags, category hints, and identifiers
- entry-aware prompt packing that prefers explicit durable memory over low-signal flush artifacts
- explainability metadata for selected and omitted memory entries, including compact match reasons

### Operator visibility and drill-down

- execution timeline for recent assistant, automation, code-session, and scheduled-task runs
- continuity-key and active-execution-ref filters in Automations, CLI traces, and Dashboard routing trace
- durable routing-trace inspector in Dashboard
- routing-trace correlation to matched runs
- routing-trace deep links to matched runs, exact timeline events, and related coding sessions
- Coding Workspace deep links with inspection-safe `VIEWING` mode instead of silently retargeting Guardian chat
- Code workbench activity deep links now support exact event targeting with bounded nearby context, not just run-level focusing
- Dashboard `Agent Runtime` and CLI `/assistant jobs` now show merged assistant and delegated-worker job state with bounded origin, outcome, and follow-up summaries

### Documentation alignment

- orchestration, routing, run-timeline, coding-workspace, memory, and reference-guide docs updated to reflect the current architecture

### Background delegation foundation

- brokered worker dispatch now records delegated lineage including origin channel/surface, continuity key, active execution refs, pending action id, and code-session id when present
- delegated-worker jobs now carry a bounded handoff object with summary, unresolved blocker kind, approval count, next action, and reporting mode
- assistant-state job views now merge primary assistant jobs with delegated-worker jobs into one operator-facing feed and derive bounded display summaries for origin, outcome, and follow-up state
- delegated-worker lifecycle breadcrumbs are recorded in audit as `delegated_worker_started`, `delegated_worker_completed`, and `delegated_worker_failed`
- delegated completion now follows an explicit server-owned follow-up policy: `inline_response`, `held_for_approval`, and `status_only`
- clarification and workspace-switch delegated blockers can now downgrade to status-only operator messaging while approval blockers stay inline and approval-held
- delegated follow-up state now projects into assistant-dispatch traces and the unified execution timeline through bounded handoff nodes instead of only raw delegated prose
- delegated run classes now exist for `in_invocation`, `short_lived`, `long_running`, and `automation_owned` work, with `long_running` and `automation_owned` able to hold results for operator review
- Dashboard `Agent Runtime`, the web assistant API, and CLI `/assistant jobs followup <jobId> <replay|keep_held|dismiss>` now expose bounded operator controls for held delegated results

---

## Current Focus

Recommended current implementation focus:
- producer adoption and timeline/query refinement for delegated run classes on top of the new lineage/handoff foundation

Why this is next:
- the class model and operator controls now exist, so the next step is using those classes more broadly and making delegated lineage easier to isolate and reason about at scale
- background delegation is still the largest unfinished capability lane

---

## Remaining Major Work

### Near-term

- final continuity polish around any remaining surface drift or noisy resume cases
- broader producer adoption for delegated run classes beyond the current brokered worker metadata path
- timeline/query affordances that make delegated lineage and held-result decisions easier to isolate at scale

### Medium-term

- background delegation runtime
- delegated run class policies and runtime defaults
- continuity-aware long-running delegated work

### Later cleanup

- final spec consolidation once implementation shape settles
- implementation-order breakdown from roadmap into smaller execution batches if needed

---

## Update Rule

When work lands:
- move it into `Landed`
- adjust the workstream status table
- update `Current Focus`
- keep `Remaining Major Work` short and real

Do not turn this into a historical changelog.
