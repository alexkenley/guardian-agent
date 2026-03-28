# Coding Assistant Curated Uplifts — Implementation Plan

**Status:** Draft  
**Date:** 2026-03-27  
**Primary source proposal:** [Coding Assistant Curated Uplifts Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md)  

**Current implementation scope:** phases 1 through 5 only. Broader autonomous-operation follow-on work remains deferred unless explicitly pulled into a later plan.

## Objective

Deliver the near-term coding-assistant uplift as one bounded program that:

1. strengthens curated coding-process discipline
2. adds shared live progress feedback in web chat, Code UI, and CLI
3. adds curated task-style subagents for coding work
4. preserves Guardian's existing runtime safety and approval model

## Proposal Review

### Source of truth

Use [CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md) as the implementation authority for scope, sequencing, and product shape.

### What to carry forward from the broader OpenDev proposal

The OpenDev proposal is still useful, but only a small subset should shape the initial build:

- schema-level tool filtering for subagents (`§3.3`)
- task-style subagents (`§3.3A`)
- coding-tool and task-UX direction (`§4.4`, `§4.4A`)
- minimal durable work-state concepts (`§5.5`)
- workflow invariant validation (`§5.6`)
- post-execution quality gates (`§6.5`)

### What to defer from the broader OpenDev proposal

Do not pull these into the first implementation plan:

- full multi-session Code tab redesign from scratch
- five-stage context compaction rewrite
- per-workflow model routing
- background task detection
- playbook-memory scoring
- live operations monitor as a separate product surface
- budget-aware modes, graduated e-stop, drift detection, and learning extraction
- pre-task specification tooling

Those remain valid future candidates, but they should not delay the narrower uplift now agreed.

## Sequencing Principles

- **Process before autonomy.** Tighten planning, review, and verification rules before adding new child-task behaviors.
- **Visibility before delegation.** Make existing runs readable and live before enabling task subagents for end-user coding turns.
- **Shared transport, different surface depth.** Ship one feedback backbone for all channels, but keep general Guardian chat thinner while coding gets the richer task-aware UX first.
- **Reuse current read models.** Build on `run.timeline`, current Code Activity, and current code-session work-state rather than creating a second execution log.
- **Curated over generic.** Start with a first-party `task` primitive and curated roles, not a generic worker-side `dispatch.agent` surface.
- **Parent owns approvals.** Child tasks may analyze, implement, or review, but the parent remains the user-facing approval and synthesis point.
- **Ship shallow first.** Max depth `2`, max concurrent child tasks `2`, reviewer default read-only.

## Scope

### In scope

- first-party skill updates for coding-process discipline
- harness coverage for workflow integrity
- `run.timeline` metadata extensions for parent/child runs and progress labels
- minimal general Guardian chat live feedback
- web-chat live activity via `/api/message/stream`
- Code UI progress strip and grouped activity tree
- CLI progress sink for interactive dispatch
- supervisor-owned `task` tool with curated roles
- schema-level tool filtering for child tasks
- minimal durable task state attached to code sessions
- workflow invariants and post-execution quality checks for coding flows
- route-aware layout guardrails for wider chat and coding panels

### Out of scope

- third-party skill imports or plugins
- Telegram streaming or live task UI
- raw prompt / chain-of-thought exposure
- generic manager-of-managers orchestration
- a full `WorkDirective` platform or separate operations dashboard in the first pass

## Target End State

By the end of this plan, Guardian should support:

- stronger first-party planning and verification rules for coding work
- live progress feedback for pending turns in web chat, Code UI, and CLI, with thinner general chat feedback and richer coding feedback
- bounded task subagents with curated roles:
  - `researcher`
  - `implementer`
  - `reviewer`
  - `triager`
- session-linked task visibility without merging raw child transcripts into the parent thread
- mechanical checks for review separation, required artifacts, and completion quality

## Phase 1: Process And Eval Baseline

### Goal

Strengthen the first-party coding process before runtime expansion.

### Deliver

- updated first-party process skills:
  - [skills/writing-plans/SKILL.md](/mnt/s/Development/GuardianAgent/skills/writing-plans/SKILL.md)
  - [skills/writing-plans/templates/implementation-plan.md](/mnt/s/Development/GuardianAgent/skills/writing-plans/templates/implementation-plan.md)
  - [skills/test-driven-development/SKILL.md](/mnt/s/Development/GuardianAgent/skills/test-driven-development/SKILL.md)
  - [skills/verification-before-completion/SKILL.md](/mnt/s/Development/GuardianAgent/skills/verification-before-completion/SKILL.md)
  - [skills/code-review/SKILL.md](/mnt/s/Development/GuardianAgent/skills/code-review/SKILL.md)
  - [skills/coding-workspace/SKILL.md](/mnt/s/Development/GuardianAgent/skills/coding-workspace/SKILL.md)
- implementation-plan template updated for:
  - explicit acceptance gates
  - existing checks to reuse
  - broader verification
- harness additions in [scripts/test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs) for:
  - acceptance-gate preservation
  - existing-check reuse
  - full legitimate green
  - anti-test-weakening

### Likely implementation areas

- `skills/writing-plans/*`
- `skills/test-driven-development/SKILL.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/code-review/SKILL.md`
- `skills/coding-workspace/SKILL.md`
- `scripts/test-coding-assistant.mjs`

### Exit criteria

- coding plans consistently surface acceptance gates
- the assistant no longer defaults to inventing narrower tests when a stronger existing check exists
- completion claims require evidence matching the real proof surface
- harness coverage fails when those behaviors regress

## Phase 2: Progress Transport And Timeline Backbone

### Goal

Make live execution state available to all surfaces from one shared model.

### Deliver

- extend `run.timeline` summaries and items with:
  - `rootRunId`
  - consistent `parentRunId`
  - safe progress labels
  - child-run correlation metadata
- implement `onStreamDispatch` in [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- update `/api/message/stream` usage so the client gets immediate `requestId` and `runId`
- add CLI progress dispatch hooks without waiting for worker token streaming
- keep progress structural and safe; do not expose raw prompts or scratchpads

### Likely implementation areas

- [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts)
- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
- [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts)

### Exit criteria

- web chat can subscribe to a live run before the final response completes
- CLI can print meaningful progress lines during a turn
- parent/child run grouping is available from the read model even before child tasks are enabled

## Phase 3: Surface The Progress In General Chat And Code UI

### Goal

Turn the shared progress model into readable product feedback without forcing one UX depth across every surface.

### Deliver

- minimal general chat live activity block in [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- general chat states kept intentionally thin, for example:
  - `Thinking`
  - `Using tools`
  - `Researching`
  - `Waiting for approval`
  - `Done`
- richer Code chat progress strip for active pending turns in [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- grouped Code Activity tree using `parentRunId` / `rootRunId`
- coding-specific session-rail attention badges for:
  - waiting approval
  - active child task
  - review findings
  - unread completion
- reference-guide updates for new chat/activity behavior

### Layout guardrails

The current web shell and coding layout mean panel-width changes must be route-aware:

- the main app shell currently uses `var(--sidebar-width, 200px) 1fr 390px` in [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- the code shell currently uses `clamp(372px, 24vw, 408px)` for the left side panel and `clamp(420px, 28vw, 480px)` for the right assistant panel in [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- table-heavy pages such as Automations already depend on the remaining center-column width, especially the catalog and execution timeline tables rendered from [web/public/js/pages/automations.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/automations.js)

Implementation rule:

- do not widen the global web chat sidebar unconditionally across every route
- introduce route-aware width tokens in [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css), coordinated from [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js)
- allow slightly wider chat-heavy surfaces and coding panels where the viewport comfortably supports it
- keep Automations, Config, and other table-dense pages at the current width unless verification shows no new cramping
- verify the 1500px, 1280px, 1024px, and 900px breakpoints before widening defaults

### Likely implementation areas

- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- [web/public/js/pages/automations.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/automations.js)
- [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js)
- [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

### Exit criteria

- general Guardian chat shows useful structural live activity without relying on final-response polling
- general chat does not yet attempt to mirror coding-specific task trees or review artifacts
- Code chat no longer shows only a generic thinking state for long-running turns
- Code Activity reads as one parent/child execution story instead of unrelated rows
- wider chat and coding panels do not introduce obvious new cramping on Automations or other dense pages

## Phase 4: Curated Task Subagents

### Goal

Add bounded child-task delegation for coding and research work.

### Deliver

- supervisor-owned `task` tool as the first shipping primitive
- curated roles:
  - `researcher`
  - `implementer`
  - `reviewer`
  - `triager`
- schema-level tool filtering for child task contexts
- child-run correlation into `run.timeline` and code-session state
- initial role defaults:
  - reviewer read-only
  - researcher read/search only
- safety limits:
  - max depth `2`
  - max concurrent child tasks per parent `2`

### Minimal durable task state

Do not build the full `WorkDirective` system in the first pass. Add a lighter code-session-linked task record first, for example:

```ts
interface CodeSessionTaskEntry {
  id: string;
  parentRunId: string;
  runId: string;
  role: 'researcher' | 'implementer' | 'reviewer' | 'triager';
  title: string;
  status: 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
  summary?: string;
  artifactRefs: string[];
}
```

This gives the UI durable child-task visibility without blocking on the heavier `WorkDirective` design.

### Likely implementation areas

- [src/runtime/runtime.ts](/mnt/s/Development/GuardianAgent/src/runtime/runtime.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- new `src/runtime/coding-task-runner.ts` or equivalent
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)

### Exit criteria

- the coding assistant can launch a bounded task and receive a structured result
- users can see which child task is active and why
- child tasks cannot silently widen authority beyond their curated role
- parent remains the approval-facing actor

## Phase 5: Workflow Invariants And Quality Gates

### Goal

Prevent weak review loops and weak completion claims after task delegation lands.

### Deliver

- minimal `WorkflowInvariantService` that enforces:
  - builder and reviewer cannot be the same role/agent where review is required
  - required artifacts must exist before completion
  - approval-gated transitions need an approval record
- post-execution coding quality checks for mutating flows:
  - debug artifacts
  - incomplete markers
  - secret-in-diff
  - optional lint/test/build status integration
- UI surfacing for quality/invariant failures in Code Activity or the right-side assistant panel
- harness additions for:
  - reviewer separation
  - child-task failure visibility
  - blocked completion when required artifacts or reviews are missing

### Likely implementation areas

- new `src/runtime/workflow-invariant-service.ts`
- new `src/runtime/quality-gate-service.ts`
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- [scripts/test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs)
- [scripts/test-code-ui-smoke.mjs](/mnt/s/Development/GuardianAgent/scripts/test-code-ui-smoke.mjs)

### Exit criteria

- substantial implementation work can require a separate reviewer task
- completion is blocked when required evidence is missing
- quality failures are visible without reading raw logs

## Deferred Follow-Ups

These are explicitly out of the current implementation plan, but should be kept as future backlog references:

- five-stage context compaction rewrite
- workflow-role model routing
- full `WorkDirective` system
- live operations monitor as a separate page/surface
- richer general Guardian chat task/workflow UI beyond thin structural status
- budget-aware modes
- emergency stop system
- drift detection
- learning extraction from corrections and PR reviews
- pre-task spec generation
- worker token streaming beyond structural progress events

## Verification Order

Run focused checks during each phase, then broader coverage before completion.

### Focused checks

- `npx vitest run src/runtime/run-timeline.test.ts`
- `npx vitest run src/channels/channels.test.ts`
- any new task-runner / invariant / quality-gate tests

### Harnesses

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs` when changes touch approval/security behavior

### Final regression pass

- `npm run check`
- `npm test`

## Success Criteria

This plan is complete when Guardian can:

- plan and verify coding work against explicit acceptance gates
- show live progress for active turns in web chat, Code UI, and CLI
- launch bounded child tasks with curated roles and visible status
- preserve review separation and completion quality mechanically
- do all of the above without introducing a second orchestration runtime or exposing raw chain-of-thought
