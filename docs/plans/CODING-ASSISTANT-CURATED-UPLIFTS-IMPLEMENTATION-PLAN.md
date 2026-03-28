# Coding Assistant Curated Uplifts — Implementation Plan

**Status:** Draft  
**Date:** 2026-03-27  
**Primary source proposal:** [Coding Assistant Curated Uplifts Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md)  
**Supporting proposal:** [OpenDev/Koan Integration, Coding Assistant & Orchestration Improvements Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/OPENDEV-INTEGRATION-AND-CODING-ASSISTANT-PROPOSAL.md)

## Current Note

For the current implementation direction around general chat as the canonical coding surface, Code as a workbench, and external coding backends, use [GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md).

## Objective

Deliver the near-term Coding Assistant uplift as a narrower program that:

1. strengthens curated coding-process discipline
2. makes repo-specific planning and review evidence-first
3. improves `Auto` routing and external-provider reliability
4. preserves live progress visibility in web chat, Code UI, and CLI
5. defers heavier task-subagent work until the bounded operator model proves insufficient

## Proposal Review

### Source of truth

Use [CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md) as the implementation authority for scope, sequencing, and product shape.

### What to carry forward from the broader OpenDev proposal

The broader proposal remains useful as a pattern bank, but only a narrow subset belongs in this implementation plan:

- schema-level tool filtering ideas where they help grounding and bounded execution
- stronger routing patterns for higher-judgment turns
- workflow-integrity evals
- durable, readable run state instead of opaque pending states

### What to defer from the broader OpenDev proposal

Do not pull these into the near-term implementation plan:

- full multi-session Code redesign from scratch
- large context-compaction rewrites
- generic task-subagent platform work
- background-work detection
- budget-aware modes
- emergency-stop systems
- drift detection
- pre-task spec tooling
- live operations monitor as a separate product surface

## Sequencing Principles

- **Grounding before autonomy.** Fix repo evidence and plan quality before adding more delegation surfaces.
- **Routing before cleverness.** Make `Auto` choose better lanes before trying to rescue weaker local models with more prompt complexity.
- **Visibility stays structural.** Keep live feedback readable and useful without exposing raw reasoning.
- **Forced modes stay forced.** If the user selects `Local` or `External`, stay in that lane when available.
- **Same-tier fallback is acceptable.** If the preferred external provider is overloaded, retry another external provider rather than silently crossing tiers.
- **Curated over generic.** If helper-task work is revisited later, start with bounded first-party roles, not a generic subagent runtime.

## Current Implementation Status

### Foundations already landed or partially landed

- web chat, Code UI, and CLI now have shared structural live feedback
- mode/source badging is wired through to the UI
- forced lane behavior and tier-provider rebinding have been tightened
- the initial process-skill uplift has already started
- route-aware layout guardrails for wider chat surfaces have already started

### Main remaining gaps

- repo-specific plans still hallucinate files, layers, or workflows too easily
- local models remain acceptable for bounded repo facts but weak on open-ended planning
- `Auto` still needs stronger external preference for planning/review/verification-heavy turns
- external-tier retry/failover is still missing
- helper-task/subagent work is not yet justified by the current product posture

## Scope

### In scope

- first-party skill updates for stronger process discipline and grounded planning
- harness coverage for workflow integrity and invented-repo-structure failures
- `Auto` routing updates for higher-judgment coding turns
- same-tier external failover and clearer routing/source notices
- continued live progress refinement in web chat, Code UI, and CLI
- route-aware width/layout guardrails for chat-heavy surfaces

### Out of scope

- third-party skill imports or plugins
- parity-chasing with terminal-first coding agents
- attempts to make weak local models good at broad architecture planning by prompt tweaks alone
- a generic task-subagent platform in the near-term plan
- Telegram streaming or richer live task UI outside the main web surfaces
- raw prompt or chain-of-thought exposure

## Target End State

By the end of this plan, Guardian should behave like a safe, grounded coding operator:

- plans and reviews for coding work are structured and evidence-first
- repo-specific claims are tied to inspected files or clearly marked as unknown
- `Auto` routes harder planning/review/verification turns to external
- forced `External` stays external, even if the preferred provider needs same-tier fallback
- live progress remains visible and understandable in web chat, Code UI, and CLI

## Phase 1: Grounded Process And Eval Baseline

### Goal

Finish the process-discipline uplift and make repo-grounded planning non-optional for repo-specific turns.

### Deliver

- updated first-party process skills:
  - [skills/writing-plans/SKILL.md](/mnt/s/Development/GuardianAgent/skills/writing-plans/SKILL.md)
  - [skills/writing-plans/templates/implementation-plan.md](/mnt/s/Development/GuardianAgent/skills/writing-plans/templates/implementation-plan.md)
  - [skills/test-driven-development/SKILL.md](/mnt/s/Development/GuardianAgent/skills/test-driven-development/SKILL.md)
  - [skills/verification-before-completion/SKILL.md](/mnt/s/Development/GuardianAgent/skills/verification-before-completion/SKILL.md)
  - [skills/code-review/SKILL.md](/mnt/s/Development/GuardianAgent/skills/code-review/SKILL.md)
  - [skills/coding-workspace/SKILL.md](/mnt/s/Development/GuardianAgent/skills/coding-workspace/SKILL.md)
- updated implementation-plan template for:
  - explicit acceptance gates
  - existing checks to reuse
  - broader verification
  - evidence sources or inspected files
- runtime/prompt guidance for repo-specific planning:
  - inspect first when needed
  - do not invent files, endpoints, tables, or subsystems
  - say what remains unknown instead of guessing
- harness additions in [scripts/test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs) for:
  - acceptance-gate preservation
  - existing-check reuse
  - full legitimate green
  - anti-test-weakening
  - invented-repo-structure failure cases

### Likely implementation areas

- `skills/writing-plans/*`
- `skills/test-driven-development/SKILL.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/code-review/SKILL.md`
- `skills/coding-workspace/SKILL.md`
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/worker/worker-llm-loop.ts](/mnt/s/Development/GuardianAgent/src/worker/worker-llm-loop.ts)
- [scripts/test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs)

### Exit criteria

- repo-specific plans stop naming obviously invented files, APIs, or data layers
- the assistant inspects before planning when the prompt requires repo grounding
- completion claims require evidence matching the real proof surface
- harness coverage fails when these behaviors regress

## Phase 2: Routing And External-Tier Reliability

### Goal

Make model selection better match the actual difficulty and failure modes of coding turns.

### Deliver

- update `Auto` routing heuristics so that planning/review/verification-heavy turns prefer external
- preserve forced lane behavior in chat and Code
- add retryable same-tier external failover for overload/5xx provider errors
- preserve accurate response-source badging after failover
- add minimal notices when:
  - `Auto` chose external for a harder turn
  - a second external provider answered after retry

### Likely implementation areas

- [src/runtime/message-router.ts](/mnt/s/Development/GuardianAgent/src/runtime/message-router.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/runtime/runtime.ts](/mnt/s/Development/GuardianAgent/src/runtime/runtime.ts)
- provider clients under [src/llm/](/mnt/s/Development/GuardianAgent/src/llm)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)

### Exit criteria

- `Auto` no longer defaults weaker local models into open-ended planning turns when an external lane is available
- forced `External` never silently becomes local
- retryable external-provider overloads can fall through to another configured external provider
- the badge remains the actual final answering source

## Phase 3: Feedback And Layout Refinement

### Goal

Keep the live-feedback work useful and readable while the routing and grounding changes land.

### Deliver

- keep general chat feedback thin and structural
- keep Code feedback richer but concise
- align routing/fallback notices with the final response-source badge
- continue CLI progress output for meaningful state changes only
- preserve route-aware width/layout guardrails

### Layout guardrails

The current web shell and coding layout mean panel-width changes must stay route-aware:

- the main app shell currently uses route-sensitive width tokens in [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- the code shell already carries its own panel clamps in [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- table-heavy pages such as Automations still depend on the center-column width from [web/public/js/pages/automations.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/automations.js)

Implementation rule:

- do not widen the global web chat sidebar unconditionally across every route
- keep Automations, Config, and other dense pages at current widths unless verification shows no regression
- verify the 1500px, 1280px, 1024px, and 900px breakpoints before widening any defaults further

### Likely implementation areas

- [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js)
- [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)

### Exit criteria

- progress remains clear without becoming noisy
- routing/fallback choices are visible enough to explain behavior without leaking internals
- wider chat and coding panels do not introduce obvious new cramping on dense pages

## Phase 4: Reassess Bounded Helper Tasks

### Goal

Make an explicit go/no-go decision on helper-task work after grounding and routing have improved.

### Recommendation

Do not start this phase by default. Revisit it only if the narrower operator model still leaves a meaningful product gap.

If revisited later, start with:

- supervisor-owned helper tasks
- shallow depth
- read-mostly roles first
- the same run/timeline visibility model

### Not part of this near-term plan

- generic subagent runtime work
- deep task trees
- manager-of-managers orchestration
- a large durable work-object platform

## Verification Order

Run focused checks during each phase, then broader coverage before completion.

### Focused checks

- `npx vitest run src/runtime/message-router.test.ts`
- `npx vitest run src/runtime/runtime.test.ts`
- `npx vitest run src/channels/channels.test.ts`
- any new routing/provider-client tests
- any new coding-assistant grounding tests

### Harnesses

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs` when changes touch approval/security behavior
- real-model lanes from [INTEGRATION-TEST-HARNESS.md](/mnt/s/Development/GuardianAgent/docs/guides/INTEGRATION-TEST-HARNESS.md):
  - real Ollama lane for bounded local behavior
  - configured external-provider lane for routing/fallback validation

### Final regression pass

- `npm run check`
- `npm test`

## Success Criteria

This plan is complete when Guardian can:

- produce structured coding plans and reviews without inventing repo structure
- route harder coding turns toward external by default in `Auto`
- keep forced `Local` and `External` behavior trustworthy
- survive retryable external-provider overloads without silently crossing tiers
- show live progress clearly in web chat, Code UI, and CLI
- do all of the above without turning the Coding Assistant into an overengineered orchestration system
