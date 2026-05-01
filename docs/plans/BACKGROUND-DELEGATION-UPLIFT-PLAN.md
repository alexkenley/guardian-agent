# Background Delegation Uplift Plan

> The combined prompt/context/memory implementation sequence now lives in [Context, Memory, and Orchestration Uplift Plan](/mnt/s/Development/GuardianAgent/docs/plans/CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md). This document remains the narrower delegation-specific reference.

**Date:** 2026-03-31
**Status:** In progress
**Origin:** Long-running and delegated orchestration review
**Key files:** `src/agent/orchestration.ts`, `src/agent/recipes.ts`, `src/runtime/shared-state.ts`, `src/runtime/workflows.ts`, `src/worker/worker-session.ts`, `src/index.ts`
**Primary specs impacted:** `docs/design/ORCHESTRATION-DESIGN.md`, `docs/design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md`, `docs/design/AUDIT-PERSISTENCE-DESIGN.md`

---

## Goal

Strengthen Guardian's model for delegated and background work so long-running tasks can:

- be decomposed more reliably
- report back into the right user-visible thread
- remain auditable
- preserve security boundaries
- avoid feeling like detached side jobs

This plan is not about making delegation looser. It is about making it more legible and better bounded.

---

## Why This Should Follow The Continuity Work

Delegated work magnifies state-management quality.

If Guardian starts more background work before continuity, memory, and context assembly are improved, the likely outcome is:

- more fragmented user experience
- more unclear resumptions
- weaker traceability from user request to delegated outcome
- more hidden context loss

The first implementation wave for this plan should therefore follow the continuity and context foundations.

---

## Problems

- current orchestration patterns are strong for in-invocation multi-agent flows, but weaker for user-visible long-running delegated work
- delegated or background work does not yet have one clear user-facing continuity contract
- follow-up behavior after long-running work is harder to reason about across surfaces
- run lineage, event timeline, and summarised results are present but not yet shaped around continuity-aware user experience

---

## Design Principles

1. Delegated work must preserve lineage to the originating request.
2. Delegated work must not create new authority.
3. Background runs need explicit summary handoff back into user continuity.
4. Operator-visible state should match runtime state.
5. Delegation must stay compatible with approval, trust, and policy enforcement.

---

## Uplift Areas

### 1. Delegated Run Identity

Each delegated/background run should carry:

- origin continuity key
- origin pending action id, if any
- origin execution context reference
- origin surface metadata
- dispatch lineage

This allows Guardian to explain:

- what started the run
- where it belongs
- whether it can safely report back across surfaces

### 2. Result Handoff Contract

Every long-running delegated task should produce a bounded handoff object such as:

- final summary
- files or artifacts changed
- approvals encountered
- unresolved blockers
- suggested next action

This should be explicit runtime state, not just arbitrary assistant prose.

### 3. Continuity-Aware Follow-Up

When a background run completes, Guardian should decide:

- auto-announce into the origin continuity thread
- hold for operator inspection
- attach as status-only output

This decision must stay server-owned and policy-aware.

### 4. Timeline And Audit Uplift

Delegated runs should appear in:

- unified run timeline
- audit log
- continuity thread inspection

The user should be able to understand the path from:

request -> delegated run -> tool actions -> final result

### 5. Delegation Policy Classes

Different delegated work classes should have different defaults:

- in-invocation orchestration
- short-lived delegated helper runs
- long-running background runs
- automation-owned delegated runs

These classes should differ in:

- visibility
- timeout
- allowed follow-up behavior
- summary requirements

---

## Relationship To Other Plans

### Cross-Surface Continuity

Background work must report into a continuity thread instead of inventing a separate user-facing thread model.

### Context Assembly

Delegated tasks need the same structured context builder as primary chat turns.

### Memory System Uplift

Delegated work should be able to use bounded durable memory and also contribute durable summaries where safe.

---

## Proposed Work

### Phase 1: Design And State Model

- define delegated run metadata extensions
- define result handoff schema
- align run timeline and audit surfaces

### Phase 2: Runtime Integration

- propagate continuity and lineage references into delegated runs
- add server-owned follow-up policy
- add bounded result handoff state

### Phase 3: UI And Operator Visibility

- show delegated run lineage in timeline and status views
- show whether the result was auto-announced, held, or blocked
- expose unresolved blockers and next actions

### Phase 4: Policy And Safety Hardening

- add explicit controls for which delegated classes can auto-report
- verify approval and trust boundaries remain intact

## Current As-Built Progress

The first runtime-foundation slice is now landed:

- brokered worker dispatch records delegated lineage in shared assistant job state
- delegated jobs capture bounded handoff summaries instead of leaving outcome shape implicit in freeform prose
- assistant-state operator views now merge primary assistant jobs and delegated-worker jobs into one recent-jobs feed
- Dashboard `Agent Runtime` and CLI `/assistant jobs` expose delegated origin and outcome summaries plus explicit follow-up labels
- audit breadcrumbs now record delegated worker start, completion, and failure
- delegated completion now follows a server-owned follow-up policy with `inline_response`, `held_for_approval`, and `status_only`
- delegated follow-up state now projects into assistant-dispatch traces and timeline items through bounded `Delegated follow-up` handoff nodes
- clarification and workspace-switch delegated blockers can now downgrade to status-only operator messaging while approval blockers stay inline and approval-held
- delegated run classes now exist for `in_invocation`, `short_lived`, `long_running`, and `automation_owned`
- held delegated results can now stay operator-held with bounded replay, keep-held, and dismiss controls exposed through Dashboard, web API, and CLI

This means the plan has moved beyond design-only status.

## Implemented So Far

- delegated lineage is durable enough to explain where brokered delegated work came from and which continuity thread or code session it belongs to
- delegated completions now produce bounded handoff state instead of relying on raw assistant prose
- delegated follow-up policy is now explicit and server-owned
- approval blockers, clarification blockers, and workspace-switch blockers now have different delegated follow-up behavior instead of one generic path
- delegated status is visible in assistant job views, dispatch traces, and the unified execution timeline
- longer-running delegated classes can now hold results for operator review instead of always forcing immediate inline reporting
- operators can replay, keep held, or dismiss those held delegated results through bounded controls

## Still To Do For Future Uplift

- use delegated run classes more broadly outside the current brokered worker metadata path
- define stronger defaults for which delegated classes should auto-report, stay held, or remain status-only
- improve query and filtering affordances so delegated lineage and held-result decisions are easier to inspect at scale
- extend the class model into richer long-running/background delegation behavior rather than only bounded completion handling
- add more explicit operator controls for deferred follow-up and replay decisions as the runtime grows

The next implementation slice should focus on:

- broader producer adoption for delegated run classes beyond the current brokered worker path
- delegation-class defaults that decide when follow-up can auto-report versus stay held
- timeline/query affordances that make delegated lineage easier to isolate at scale

---

## Tests

- delegated lineage tests
- delegated result handoff tests
- continuity-aware completion tests
- audit and timeline event tests
- safety tests for approval and policy boundaries

---

## Recommendation

Keep implementation incremental.

The continuity, memory, and context foundations are now strong enough for the delegation uplift to proceed, but the runtime should continue to grow through bounded shared state and shared operator surfaces rather than a second monolithic delegation subsystem.
