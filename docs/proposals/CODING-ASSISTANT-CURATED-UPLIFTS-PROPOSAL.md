# Coding Assistant Curated Uplifts Proposal

**Status:** Draft
**Date:** 2026-03-27
**Primary Guardian files:** [src/index.ts](../../src/index.ts), [src/runtime/runtime.ts](../../src/runtime/runtime.ts), [src/runtime/message-router.ts](../../src/runtime/message-router.ts), [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts), [src/channels/web.ts](../../src/channels/web.ts), [src/channels/cli.ts](../../src/channels/cli.ts), [src/broker/broker-server.ts](../../src/broker/broker-server.ts), [src/worker/worker-llm-loop.ts](../../src/worker/worker-llm-loop.ts), [web/public/js/chat-panel.js](../../web/public/js/chat-panel.js), [web/public/js/pages/code.js](../../web/public/js/pages/code.js), [web/public/js/pages/automations.js](../../web/public/js/pages/automations.js), [web/public/css/style.css](../../web/public/css/style.css)
**Related docs:** [CODING-WORKSPACE-DESIGN.md](../design/CODING-WORKSPACE-DESIGN.md), [BROKERED-AGENT-ISOLATION-DESIGN.md](../design/BROKERED-AGENT-ISOLATION-DESIGN.md), [RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md](../design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md), [EVENTBUS-DESIGN.md](../design/EVENTBUS-DESIGN.md), [UI-TARS-UPLIFT-ROADMAP.md](../plans/UI-TARS-UPLIFT-ROADMAP.md)

## Current Note

For the current direction around general chat as the canonical coding surface, Code as a workbench, and optional Claude Code/Codex orchestration, use [GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md](GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md).

## Goal

Refocus the Coding Assistant uplift around a narrower, more defensible product shape:

- make Guardian a safe, grounded coding operator
- improve coding-process discipline and repo-grounded answers
- make routing and provider behavior legible and reliable
- keep live progress visible across web chat, Code UI, and CLI
- defer more ambitious task-subagent work until the bounded operator experience is strong enough to justify it

This should stay:

- first-party and curated
- compatible with Guardian’s existing runtime controls
- lighter than a new orchestration runtime
- explicit about what the agent is doing

## Product Posture

Guardian should not try to become a full replacement for terminal-first coding agents such as Claude Code or Codex.

The Coding Assistant should instead be good at:

- safe execution of coding-adjacent operations
- approvals, auditability, and visible state
- bounded repository inspection
- grounded implementation planning when the repo evidence is available
- routing stronger synthesis and review work to external models when needed

This means:

- `Local` is best for bounded operator tasks, repo facts, and safe file/build/test/install flows
- `External` is best for planning, review, repo-wide inspection, and verification-heavy turns
- `Auto` should prefer external for higher-judgment coding turns
- forced `Local` or `External` must stay respected
- same-tier fallback is acceptable; cross-tier silent fallback is not

## Current State

Important foundations are already in place or partially landed:

- curated first-party process skills already exist under [skills/](../../skills)
- `run.timeline` already exists and is streamed into web chat and Code activity
- web chat, Code UI, and CLI now have live structural progress rather than only dead pending states
- mode selection and response-source badging now reflect the actual answering side more reliably
- tier-provider rebinding now follows provider-default changes without requiring a rebuild

The remaining problems are more about quality and scope than transport:

- repo-specific planning still too easily becomes generic or hallucinates likely files/subsystems
- weaker local models handle bounded factual prompts much better than open-ended planning
- `Auto` still needs stronger biasing toward external on planning/review/verification-heavy turns
- overloaded external providers do not yet fail over cleanly to another external provider
- bounded task subagents are still unproven relative to the simpler routing-and-grounding work

## What To Borrow

### From trycycle

Borrow:

- explicit acceptance-gate discipline
- preferring existing high-fidelity failing checks
- “full legitimate green” before claiming completion
- anti-test-weakening language

Do not borrow:

- the full orchestration layer
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
- keep runtime execution tasks distinct from planning/todo items

### Multi-agent guardrail

Borrow the guardrail:

- do not make nested agent hierarchies the default architecture

Borrow only later if justified:

- very shallow, bounded helper-task patterns

## Unified Recommendation

Deliver the near-term uplift as four bounded workstreams.

## Workstream 1: Curated Process And Grounded Planning

Strengthen the existing first-party coding skills and make repo-specific planning evidence-first.

### Files to update

- [skills/writing-plans/SKILL.md](../../skills/writing-plans/SKILL.md)
- [skills/writing-plans/templates/implementation-plan.md](../../skills/writing-plans/templates/implementation-plan.md)
- [skills/test-driven-development/SKILL.md](../../skills/test-driven-development/SKILL.md)
- [skills/verification-before-completion/SKILL.md](../../skills/verification-before-completion/SKILL.md)
- [skills/code-review/SKILL.md](../../skills/code-review/SKILL.md)
- [skills/coding-workspace/SKILL.md](../../skills/coding-workspace/SKILL.md)
- [scripts/test-coding-assistant.mjs](../../scripts/test-coding-assistant.mjs)

### Core changes

- Require plans to name explicit acceptance gates.
- Prefer existing failing harnesses, scenario tests, or integration checks before inventing new narrow tests.
- Require “full legitimate green” wording in completion guidance.
- Treat test weakening, proof-surface narrowing, and skipped broader checks as real failures.
- Require repo-specific file or subsystem mentions to come from actual workspace inspection, not guesses.
- If the assistant lacks enough repo evidence for a grounded plan, it should inspect first or say what remains unknown rather than inventing structure.
- Add harness coverage that fails when plans invent files, layers, or checks not supported by the inspected repo.

### Why first

This is the highest-value uplift for both normal Guardian coding turns and the dedicated Code UI, and it does not depend on deeper orchestration work.

## Workstream 2: Routing And Provider Reliability

Make model selection reflect the task shape and keep provider behavior legible.

### Core changes

- Keep forced `Local` and forced `External` as true forced lanes when those lanes are available.
- Make `Auto` prefer external for:
  - repo-grounded planning
  - review and critique
  - verification-heavy turns
  - repo-wide inspection/synthesis
- Keep `Local` acceptable for:
  - direct repo facts
  - bounded search/read/diff tasks
  - package install, build, lint, and test operator flows
  - small direct edit tasks where the user explicitly forces local
- Add external-tier failover for retryable provider-side overloads or 5xx errors.
- Preserve the badge as the actual final answer source, with optional fallback notation when a second external provider answered.
- Do not silently fall from forced `External` to local.

### Why second

This directly addresses the biggest gap exposed by live-model testing: a weaker local model can be useful, but it should not be carrying the hardest planning and synthesis turns in `Auto`.

## Workstream 3: Visibility, Feedback, And UX Guardrails

Keep the current live-feedback work structural and readable rather than making the assistant noisier.

### Core changes

- Continue using [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts) as the shared progress backbone.
- Drive coding visibility from backend-owned session/task state rather than surface-local heuristics.
- Keep general Guardian chat feedback thin and structural.
- Keep Code feedback richer, but still concise and task-oriented.
- Make approval-backed mutations artifact-aware: concise summaries in chat/CLI, richer diff/log review in Code.
- Show when `Auto` selected external because the turn needed stronger reasoning.
- Show when a second external provider answered after a retryable overload.
- Preserve route-aware layout guardrails so wider chat surfaces do not crowd Automations, Config, or other dense pages.

### Explicit non-goal

Do not expose raw chain-of-thought, full prompts, or full tool arguments. Feedback should remain concise, safe, and structural.

## Workstream 4: Optional Bounded Helper Tasks

Do not treat task subagents as part of the near-term must-have scope.

### Recommendation

Defer bounded helper-task work until the narrower operator model proves insufficient.

If subagent-style helpers are revisited later, they should start as:

- shallow
- supervisor-owned
- tightly role-bounded
- visible through the same run/timeline model

The likely first candidates would be read-mostly helpers such as:

- `researcher`
- `reviewer`

Only later, if the narrower helper shapes prove valuable:

- `implementer`
- `verifier`

Not the first candidates:

- a generic multi-agent runtime surface
- deep task trees
- manager-of-managers orchestration

Isolation note:

- do not adopt worktree-centered rituals as the default coding model
- if isolated helper execution is ever justified later, keep it opt-in and limited to write-capable delegated coding jobs after backend-owned session/task state is in place

## Delivery Order

### Phase 1: Grounding first

- finish the process-skill uplift
- add evidence-first repo-planning rules
- extend the harness to reject invented repo structure

### Phase 2: Routing reliability

- strengthen `Auto` routing toward external for higher-judgment turns
- add same-tier external failover
- keep badges and routing notices aligned with the actual final source

### Phase 3: UX refinement

- keep live progress clear in web chat, Code UI, and CLI
- make approval and artifact rendering session-backed rather than ad hoc per surface
- add minimal routing/fallback notices where useful
- keep route-aware width/layout guardrails in place

### Phase 4: Reassess helper-task need

- finish backend-owned session/task state before adding helper-task execution paths
- only revisit bounded helper tasks if grounded planning, routing, and visibility still leave a meaningful gap

## Out Of Scope

This uplift does not include:

- importing third-party skills
- plugin systems or runtime installers
- parity-chasing against terminal-first coding agents
- trying to make weaker local models excel at broad architectural planning by prompt tweaks alone
- generic manager-of-managers orchestration
- Telegram streaming in the first phase
- raw prompt or chain-of-thought exposure
- recreating trycycle’s orchestration runtime

## Verification

### Harness and test updates

- extend [scripts/test-coding-assistant.mjs](../../scripts/test-coding-assistant.mjs) with grounded-planning and routing cases
- extend [scripts/test-code-ui-smoke.mjs](../../scripts/test-code-ui-smoke.mjs) for live activity and source/fallback visibility
- extend focused routing/runtime tests for:
  - forced lane preservation
  - `Auto` external preference on planning/review turns
  - same-tier external failover
  - source badge correctness after failover

### Key scenarios

- a repo-specific implementation plan names only files/subsystems that can be supported by inspected workspace evidence
- `Auto` chooses external for planning/review/verification-heavy coding turns
- forced `External` remains external even when the preferred external provider is overloaded
- forced `Local` stays local when available
- general chat, Code UI, and CLI show progress without leaking raw reasoning

## Recommendation

Use this as the current source of truth for near-term Coding Assistant uplift work.

The implementation order should be:

1. strengthen curated process skills and grounded planning
2. improve `Auto` routing and same-tier external failover
3. keep live feedback and UX guardrails clean
4. only then decide whether bounded helper-task work is still worth the added complexity
