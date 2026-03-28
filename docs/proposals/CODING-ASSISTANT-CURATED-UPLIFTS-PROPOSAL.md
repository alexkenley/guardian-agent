# Coding Assistant Curated Uplifts Proposal

**Status:** Draft  
**Date:** 2026-03-26  
**Primary Guardian files:** [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts), [src/runtime/runtime.ts](/mnt/s/Development/GuardianAgent/src/runtime/runtime.ts), [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts), [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts), [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts), [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js), [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js), [web/public/js/pages/automations.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/automations.js)  
**Related docs:** [CODING-ASSISTANT-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-ASSISTANT-SPEC.md), [BROKERED-AGENT-ISOLATION-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md), [RUN-TIMELINE-AND-EVENT-VIEWER-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/RUN-TIMELINE-AND-EVENT-VIEWER-SPEC.md), [EVENTBUS-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/EVENTBUS-SPEC.md), [UI-TARS-UPLIFT-ROADMAP.md](/mnt/s/Development/GuardianAgent/plans/UI-TARS-UPLIFT-ROADMAP.md)

## Goal

Unify the current coding-assistant uplift direction into one bounded plan:

- improve curated coding process discipline
- add visible live feedback across web chat, Code UI, and CLI
- add curated task-style subagents for coding work

This should stay:

- first-party and curated
- compatible with Guardian’s existing runtime controls
- lighter than a new orchestration runtime
- explicit about what the agent is doing

## Current State

Guardian already has important building blocks:

- general multi-agent orchestration exists through runtime dispatch and recipe agents
- handoff validation, lineage tracking, and depth limits already exist
- `run.timeline` already exists and is streamed over SSE
- Code `Activity` and Automations `Execution Timeline` already consume `run.timeline`
- curated first-party process skills already exist under [skills/](/mnt/s/Development/GuardianAgent/skills)

The gaps are product-facing:

- coding runtime still lacks dedicated `task` subagent orchestration
- web chat streaming is scaffolded but `onStreamDispatch` is still unwired
- Code chat and CLI are still mostly request/response with generic pending feedback
- current UI is chronological, not yet a clear parent/child task view
- process guidance is still weaker than it should be around acceptance gates and verification discipline

## What To Borrow

### From trycycle

Borrow:

- explicit acceptance-gate discipline
- preferring existing high-fidelity failing checks
- “full legitimate green” before claiming completion
- anti-test-weakening language

Do not borrow:

- the full Python orchestration layer
- worktree-centered rituals
- a monolithic meta-skill

### From UI-TARS

Borrow:

- treat execution visibility as a product surface
- make event streams readable and live

Do not borrow:

- screenshot-first control as Guardian’s default path

### From prior coding workspace analysis

Borrow:

- durable task/session state
- parent/child task visibility
- small attention signals such as working, blocked, unread, waiting

### Multi-agent guardrail

Borrow the guardrail:

- do not make nested agent hierarchies the default architecture

## Unified Recommendation

Deliver this as three coordinated workstreams.

## Workstream 1: Curated Process Uplift

Strengthen the existing first-party skills instead of importing a third-party skill package.

### Files to update

- [skills/writing-plans/SKILL.md](/mnt/s/Development/GuardianAgent/skills/writing-plans/SKILL.md)
- [skills/writing-plans/templates/implementation-plan.md](/mnt/s/Development/GuardianAgent/skills/writing-plans/templates/implementation-plan.md)
- [skills/test-driven-development/SKILL.md](/mnt/s/Development/GuardianAgent/skills/test-driven-development/SKILL.md)
- [skills/verification-before-completion/SKILL.md](/mnt/s/Development/GuardianAgent/skills/verification-before-completion/SKILL.md)
- [skills/code-review/SKILL.md](/mnt/s/Development/GuardianAgent/skills/code-review/SKILL.md)
- [skills/coding-workspace/SKILL.md](/mnt/s/Development/GuardianAgent/skills/coding-workspace/SKILL.md)

### Core changes

- Require plans to name explicit acceptance gates.
- Prefer existing failing harnesses, scenario tests, or integration checks before inventing new narrow tests.
- Require “full legitimate green” wording in completion guidance.
- Treat test weakening, proof-surface narrowing, and skipped broader checks as real failures.
- Make review compare implementation and evidence against the promised plan, not only the diff.

### Why first

This is the lowest-complexity uplift and improves coding quality immediately, even before any runtime work lands.

## Workstream 2: Live Feedback And Visibility

Use [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts) as the shared backbone instead of inventing a second event system.

### Recommended runtime changes

- Extend run summaries and timeline items with consistent parent/child task metadata.
- Use `parentRunId` and `rootRunId` consistently in the UI.
- Add safe progress labels such as:
  - `Planning`
  - `Launching reviewer`
  - `Running tests`
  - `Waiting for approval`
  - `Reviewer found 2 issues`

### Web chat

- Wire `onStreamDispatch` in [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts).
- Let `/api/message/stream` return an immediate `requestId` and `runId`.
- Show a compact live activity block under the pending assistant message.
- Drive it from `run.timeline`, not raw model chain-of-thought.

### Code UI

- Keep `Activity` as the canonical detailed run view.
- Add a compact live progress strip inside the chat thread for the active pending turn.
- Group child runs under the parent run instead of rendering them as unrelated siblings.
- Add session-rail attention badges for waiting approval, active child task, review findings, and unread completion.

### CLI

- Add a progress sink for interactive dispatch in [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts).
- Print throttled progress lines for meaningful state changes only.

Example:

```text
[plan] Understanding the request
[task:reviewer] Started review task
[verify] Running tests
[wait] Approval required for fs_write
```

### Explicit non-goal

Do not expose raw chain-of-thought, full prompts, or full tool args. Feedback should be concise, safe, and structural.

## Workstream 3: Curated Task Subagents

Add subagents as a bounded first-party primitive for coding and research work.

### Recommendation

Start with a **supervisor-owned `task` tool**, not a generic worker-side `dispatch.agent` API.

Why:

- narrower surface area
- easier to audit
- simpler fit with the brokered worker model
- better aligned with Guardian’s curated runtime

### Initial roles

- `researcher`
- `implementer`
- `reviewer`
- `triager`

### Initial execution rules

- Parent agent owns user interaction, approvals, and final synthesis.
- Child task gets a scoped brief, narrower tool set, and a dedicated context window.
- Child returns a structured result, not a raw transcript.
- Child runs are correlated into `run.timeline` and code-session activity.
- Default depth stays shallow and concurrency stays small.

### Initial safety limits

- max task depth: `2`
- max concurrent child tasks per parent: `2`
- reviewer defaults to read-only
- researcher defaults to read/search only
- parent remains approval-facing

## Delivery Order

### Phase 1: Visibility first

- finish `onStreamDispatch`
- expose live progress in web chat, Code UI, and CLI
- improve parent/child grouping in the timeline
- do not enable end-user child-task launches yet

### Phase 2: Curated task tool

- add bounded `task` subagents
- ship curated roles and narrower tool filtering
- surface child task status everywhere from the same run/timeline model

### Phase 3: Richer streaming

- add worker incremental response streaming later
- keep progress streaming separate from token streaming
- consider generic `dispatch.agent` only after the `task` tool proves too restrictive

## Out Of Scope

This uplift does not include:

- importing third-party skills
- plugin systems or runtime installers
- a manager-of-managers default architecture
- Telegram streaming in the first phase
- raw prompt or chain-of-thought exposure
- recreating trycycle’s orchestration runtime

## Verification

### Skill and harness updates

- extend [scripts/test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs) with workflow-integrity cases
- extend [scripts/test-code-ui-smoke.mjs](/mnt/s/Development/GuardianAgent/scripts/test-code-ui-smoke.mjs) for live activity visibility
- add focused channel tests for `/api/message/stream` and CLI progress output
- add runtime tests for child-task timeline correlation and depth/concurrency limits

### Key scenarios

- user-named acceptance gate is preserved through planning and completion
- web chat shows live activity before the final response lands
- Code Activity groups child work under the parent run
- CLI prints useful progress without spamming
- child task failure is visible without leaking raw child reasoning

## Recommendation

Use this as the current source of truth for near-term coding-assistant uplift work.

The implementation order should be:

1. strengthen curated process skills
2. finish live feedback plumbing
3. add curated `task` subagents
4. only then decide whether broader streaming or generic broker dispatch is worth the extra complexity
