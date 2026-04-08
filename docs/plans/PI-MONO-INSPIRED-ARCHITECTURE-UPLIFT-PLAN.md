# Pi-Mono Inspired Architecture Uplift Plan

**Date:** 2026-04-08  
**Status:** Draft  
**Source review:** `badlogic/pi-mono` at `main@f10cce94`  
**Primary Guardian inputs:** [docs/proposals/REFERENCE-CODING-RUNTIME-UPLIFT-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/REFERENCE-CODING-RUNTIME-UPLIFT-PROPOSAL.md), [docs/plans/MINIMAL-EMBEDDABLE-AGENT-KERNEL-UPLIFT-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/MINIMAL-EMBEDDABLE-AGENT-KERNEL-UPLIFT-PLAN.md), [docs/plans/CORE-ARCHITECTURE-MODULARIZATION-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/CORE-ARCHITECTURE-MODULARIZATION-PLAN.md), [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [docs/specs/CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md), [docs/specs/CONTEXT-ASSEMBLY-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXT-ASSEMBLY-SPEC.md)

---

## Purpose

Adopt the useful architectural patterns from `pi-mono` without importing its product posture, plugin openness, or terminal-first assumptions.

This plan is intentionally narrower than the comparative proposal. It includes only the slices that are likely to improve Guardian in one or more of these areas:

- architecture clarity
- runtime performance
- execution safety
- operator diagnosability
- cross-surface consistency

This is a packaging and runtime-discipline plan, not a product-parity plan.

---

## Why This Plan Exists

The `pi-mono` review confirmed three things:

1. Guardian is already ahead on security, approvals, trust boundaries, shared orchestration, and backend-owned session state.
2. Guardian is still carrying too much runtime weight in a few large files, especially [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts) and [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts).
3. Pi’s strongest ideas are not its UX rituals. They are its narrower runtime seams, clearer event/session contracts, and cleaner packaging boundaries.

Current pressure points:

- [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts) is 10k+ lines
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts) is 6k+ lines even after registrar extraction
- prompt/context budgeting is improving, but still needs more explicit source contracts
- sandbox, MCP, and backend state are not always surfaced as clearly as their operational importance warrants

---

## Non-Negotiable Invariants

- Intent routing stays gateway-first.
- Pending actions, approvals, and continuation semantics remain shared runtime primitives.
- Security choke points remain supervisor-owned.
- Tool execution does not gain a bypass path around Guardian, policy, sandbox, or audit controls.
- Backend-owned coding sessions remain canonical; the browser does not become the source of truth.
- First-party core behavior does not become plugin-driven.
- Degraded or unavailable sandbox/backend states remain fail-closed where required.

---

## What To Adopt

This plan recommends adopting six bounded ideas.

### 1. A narrower assistant turn runtime

Adopt the pattern of a compact, transport-neutral turn loop, but keep Guardian routing, approvals, and security outside the loop where they belong.

What Guardian should gain:

- one reusable assistant-turn runtime for chat, Code, worker paths, and future backend adapters
- cleaner separation between turn execution and feature-specific routing branches
- smaller blast radius for coding/runtime changes

### 2. One canonical run-event contract

Adopt the idea that every surface should consume the same authoritative run events rather than reconstructing state from transcript text or surface-local heuristics.

What Guardian should gain:

- shared event vocabulary for web, CLI, Code, and worker consumers
- thinner rendering adapters
- better progress visibility without leaking prompt internals

### 3. Richer tool and control-plane descriptors

Adopt richer metadata contracts around tools and operator-visible actions.

What Guardian should gain:

- better availability and diagnostics
- less ad hoc branching on tool names
- cleaner UI and CLI affordances for the same underlying capability contracts

### 4. Typed runtime availability descriptors

Adopt explicit descriptors for MCP, sandbox, and external coding/backend startup state.

What Guardian should gain:

- truthful requested vs supported vs active state
- explicit fallback reasons
- better operator understanding of degraded runtime posture

### 5. Budgeted prompt-source contracts and shared compaction artifacts

Adopt the discipline of explicit context inputs, explicit budgets, and explicit omission reasons.

What Guardian should gain:

- lower prompt-cost drift
- fewer hidden context regressions
- safer compaction and better run-timeline evidence

### 6. Repo write-path hardening

Adopt pi’s same-file mutation serialization idea, adapted to Guardian’s structured file and coding tools.

What Guardian should gain:

- fewer race-condition overwrites
- cleaner multi-surface or future multi-worker coding behavior
- more deterministic repo mutation outcomes

### 7. Interactive approval dedupe tightening

Adopt only the narrow version of approval coalescing: reduce duplicate approval prompts caused by chat-turn retries or model confusion, without creating a broad session-level approval bypass.

What Guardian should gain:

- fewer repeated approval prompts for the same interactive action
- less friction from duplicate tool retries in the same chat or code-session flow
- no loosening for scheduled, background, or automation-driven mutation paths

---

## What Not To Adopt

Do not adopt the following from `pi-mono`:

- plugin-style dynamic loading for first-party core behavior
- terminal-first product assumptions as the default Guardian operator model
- browser-owned session persistence as the source of truth
- command-surface sprawl for its own sake
- a second assistant runtime that bypasses Intent Gateway, pending actions, or approvals
- full session-tree UX parity
- `pods`-style GPU deployment management as part of Guardian core
- session-wide "approve once, mutate freely" behavior
- approval reuse for automations, routines, scheduled tasks, or background runs

---

## Workstreams

## Workstream 1: Extract A Narrow Assistant Turn Runtime

### Goal

Move reusable turn mechanics out of [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts) and away from surface-specific orchestration paths.

### Scope

- assistant message accumulation
- tool-round iteration
- usage accounting
- compaction entry points
- normalized result shaping before reinjection
- stable hooks for pending approval, pending action, continuation, and degraded fallback decisions

### Not in scope

- Intent Gateway ownership
- preregistration of direct routes
- policy engine ownership
- channel-specific rendering

### Likely implementation areas

- [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts)
- [src/chat-agent-helpers.ts](/mnt/s/Development/GuardianAgent/src/chat-agent-helpers.ts)
- new `src/runtime/assistant-turn/` module family
- [src/worker/worker-llm-loop.ts](/mnt/s/Development/GuardianAgent/src/worker/worker-llm-loop.ts)
- [src/runtime/dashboard-dispatch.ts](/mnt/s/Development/GuardianAgent/src/runtime/dashboard-dispatch.ts)

### Architecture benefit

- fewer feature branches in the core chat path
- cleaner reuse between main chat, Code, and worker execution

### Performance benefit

- fewer duplicated turn-shaping paths
- easier profiling of prompt, tool, and compaction overhead

### Security benefit

- approval and policy handoff become more explicit contracts instead of ambient behavior

### Exit criteria

- the assistant-turn loop exists as a dedicated runtime unit
- web, CLI, and worker paths consume the same turn-runtime contract
- [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts) shrinks materially and loses turn-loop ownership rather than just delegating helper calls

---

## Workstream 2: Canonical Run Events Across Surfaces

### Goal

Make progress, pending, and completion state backend-authored and transport-neutral.

### Scope

- define one event family for:
  - run start/end
  - turn start/end
  - tool execution start/update/end
  - approval wait/resume
  - pending-action block/switch
  - compaction start/end
  - verification status
- map those events into run timeline, web chat, Code UI, and CLI
- stop relying on text-shape inference where structured metadata should exist

### Likely implementation areas

- [src/runtime/run-events.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-events.ts)
- new `src/runtime/assistant-run-events.ts` or equivalent
- [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- [docs/specs/RUN-TIMELINE-AND-EVENT-VIEWER-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/RUN-TIMELINE-AND-EVENT-VIEWER-SPEC.md)

### Architecture benefit

- surface adapters render shared runtime state instead of inventing state

### Performance benefit

- fewer duplicate formatting and polling paths
- cleaner incremental UI updates

### Security benefit

- reduced chance of approval or blocked-work UI drift caused by transcript parsing

### Exit criteria

- web chat, Code UI, and CLI can explain active/pending/completed work from shared event metadata
- approval and pending-action rendering does not require fallback parsing except for legacy compatibility

---

## Workstream 3: Richer Tool And Control Descriptors

### Goal

Promote Guardian’s registries from “callable schema holders” into stronger runtime contracts.

### Scope

For tools:

- approval posture
- expected sandbox posture
- backing service dependencies
- surface availability
- resumability / long-running behavior
- operator-facing action labels
- output artifact family
- degraded-mode behavior

For operator-visible controls:

- stable id
- category
- availability by surface
- resumability
- help and argument metadata

### Likely implementation areas

- [src/tools/types.ts](/mnt/s/Development/GuardianAgent/src/tools/types.ts)
- [src/tools/registry.ts](/mnt/s/Development/GuardianAgent/src/tools/registry.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [src/channels/cli-command-guide.ts](/mnt/s/Development/GuardianAgent/src/channels/cli-command-guide.ts)
- [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)

### Architecture benefit

- fewer `if toolName === ...` style branches
- clearer ownership of availability and execution semantics

### Performance benefit

- better tool-set shaping and smaller dynamic decision surfaces
- cleaner inventory and drilldown generation for prompt context

### Security benefit

- availability and degraded behavior become declared and reviewable
- approval semantics are less likely to drift across tools

### Exit criteria

- `/api/tools`, CLI help, and runtime selection all draw from the same richer descriptors
- new tools can expose availability, approval, and artifact behavior without executor-local ad hoc branches

---

## Workstream 4: Typed MCP, Sandbox, And Backend Availability State

### Goal

Make runtime availability truthful, inspectable, and safe to reason about.

### Scope

- MCP server requested/supported/active/fallback state
- sandbox requested/supported/active posture
- external coding backend requested/supported/active state
- auth mode, transport mode, provenance, and failure reason fields

### Likely implementation areas

- [src/tools/mcp-client.ts](/mnt/s/Development/GuardianAgent/src/tools/mcp-client.ts)
- [src/sandbox/types.ts](/mnt/s/Development/GuardianAgent/src/sandbox/types.ts)
- [src/sandbox/security-controls.ts](/mnt/s/Development/GuardianAgent/src/sandbox/security-controls.ts)
- external coding backend startup modules under [src/runtime/](/mnt/s/Development/GuardianAgent/src/runtime)
- control-plane callbacks under [src/runtime/control-plane/](/mnt/s/Development/GuardianAgent/src/runtime/control-plane)

### Architecture benefit

- runtime state becomes a typed object model, not scattered interpretation

### Performance benefit

- faster diagnosis of unavailable/degraded states
- fewer retries against unavailable transports or unsupported backends

### Security benefit

- degraded execution posture is explicit and auditable
- fail-closed behavior is easier to prove and render

### Exit criteria

- the operator can answer “what was requested, what is supported, what is active, and why not” for MCP, sandbox, and coding backends from shared runtime state

---

## Workstream 5: Budgeted Prompt Inputs And Shared Compaction Artifacts

### Goal

Turn context assembly and compaction into stable runtime contracts instead of pressure-driven side effects.

### Scope

- explicit budget caps by source class
- explicit load order
- explicit provenance for each loaded source
- explicit omission or truncation reasons
- reusable compaction artifact shape across chat, code sessions, and workers
- maintained summaries before ad hoc re-summarization where possible

### Guardian source classes

- workspace instructions such as `AGENTS.md`
- active skills
- coding-session state and memory
- global memory when appropriate
- workspace trust review
- workspace map and working set
- approval and pending-action context
- provider/tool inventory summaries

### Likely implementation areas

- [src/runtime/context-assembly.ts](/mnt/s/Development/GuardianAgent/src/runtime/context-assembly.ts)
- [src/util/context-budget.ts](/mnt/s/Development/GuardianAgent/src/util/context-budget.ts)
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/runtime/agent-memory-store.ts](/mnt/s/Development/GuardianAgent/src/runtime/agent-memory-store.ts)
- [docs/specs/CONTEXT-ASSEMBLY-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXT-ASSEMBLY-SPEC.md)
- [docs/specs/CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md)

### Architecture benefit

- prompt shape becomes explainable and reviewable
- compaction becomes a reusable artifact contract rather than scattered behavior

### Performance benefit

- bounded prompt growth
- lower token waste from accidental source accretion
- easier per-source cost accounting

### Security benefit

- untrusted or quarantined content remains visible as a distinct source class
- prompt assembly can explain why risky context was omitted or downgraded

### Exit criteria

- run timeline and diagnostics can show loaded sources, omitted sources, per-source footprint, and compaction outcomes
- chat, code sessions, and worker turns use the same compaction artifact contract

---

## Workstream 6: Repo Mutation Concurrency Hardening

### Goal

Prevent same-path races and reduce non-deterministic repo mutations.

### Scope

- serialize same-file writes for structured file mutation tools
- preserve parallelism across different files
- surface conflict or queue metadata in job/run diagnostics where useful
- extend the same discipline to code-session mutation paths that converge on the same file

### Likely implementation areas

- [src/tools/builtin/filesystem-tools.ts](/mnt/s/Development/GuardianAgent/src/tools/builtin/filesystem-tools.ts)
- [src/tools/builtin/coding-tools.ts](/mnt/s/Development/GuardianAgent/src/tools/builtin/coding-tools.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- shared helper such as new `src/tools/file-mutation-queue.ts`
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts) for surfaced recent-job semantics

### Architecture benefit

- repo mutations become governed by shared write-path behavior instead of tool-local luck

### Performance benefit

- removes avoidable retry churn and broken-write recovery work

### Security benefit

- lowers accidental overwrite risk across concurrent assistant or operator actions
- makes mutation sequencing auditable

### Exit criteria

- concurrent writes to the same file no longer race
- writes to different files still run concurrently
- the write queue behavior is covered by unit tests

---

## Workstream 7: Interactive Approval Dedupe Tightening

### Goal

Reduce duplicate approval prompts for interactive chat and code-session retries without broadening mutation authority.

### Scope

- keep approval dedupe restricted to interactive user-driven turns:
  - normal web chat
  - CLI chat
  - attached code sessions
- same principal
- same logical session or code session
- short TTL
- same tool family and same normalized mutation intent
- exact or materially equivalent targets only

### Explicit exclusions

- automations
- routines
- scheduled tasks
- playbooks
- background delegation
- cross-session or cross-principal reuse
- broad destructive classes where exact-intent matching is weak

### Guardrails

This is dedupe, not approval amortization.

Allowed direction:

- exact duplicate interactive retries
- normalized duplicates caused by model replay after an approval wait
- same pending approval reused while it is still pending

Not allowed:

- "same file, therefore all later edits are approved"
- "same session, therefore similar commands are approved"
- reuse across different content payloads, materially different shell commands, or different target classes
- reuse for automation or routine execution, even when the textual request looks similar

### Likely implementation areas

- [src/tools/approvals.ts](/mnt/s/Development/GuardianAgent/src/tools/approvals.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [src/runtime/approval-continuations.ts](/mnt/s/Development/GuardianAgent/src/runtime/approval-continuations.ts)
- [src/runtime/pending-actions.ts](/mnt/s/Development/GuardianAgent/src/runtime/pending-actions.ts)
- [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)

### Architecture benefit

- approval semantics stay shared and explicit instead of becoming surface-local UX tricks

### Performance benefit

- fewer redundant approval waits and duplicate tool-loop retries in interactive flows

### Security benefit

- coalescing stays bounded to the lowest-risk reuse case: interactive duplicate requests from the same user in the same live context
- scheduled or autonomous paths do not inherit looser semantics

### Exit criteria

- duplicate interactive approval prompts are reduced for exact or normalized replays
- automation, routine, and scheduled execution still always use their own approval path
- tests prove no cross-session, cross-principal, or cross-automation approval reuse

---

## Optional Workstream 8: Read-Only Comparative Harness

### Goal

Make future benchmark comparisons repeatable without importing third-party implementation choices into Guardian by accident.

### Scope

- read-only extraction of external runtime shapes:
  - command families
  - tool families
  - event model
  - bootstrap model
  - session artifact model
- generated comparison reports against Guardian-native equivalents

### Why this is optional

This is useful for roadmap discipline, but it does not unblock the main runtime improvements.

### Likely implementation areas

- `scripts/` comparative analysis helpers
- `docs/research/` generated comparison reports

### Exit criteria

- the next external runtime comparison can be repeated from scripts and produces a structured report instead of one-off notes

---

## Delivery Order

## Phase 1: Runtime Contract First

- Workstream 1
- Workstream 2

Reason:

- this gives Guardian the biggest architecture win and unlocks thinner surface adapters

## Phase 2: Runtime Truthfulness And Governance

- Workstream 3
- Workstream 4

Reason:

- richer descriptors and typed availability state improve both operator trust and secure degraded-mode behavior

## Phase 3: Context Cost And Resume Discipline

- Workstream 5

Reason:

- prompt-cost drift and compaction correctness are already active pressure areas

## Phase 4: Mutation Reliability

- Workstream 6
- Workstream 7

Reason:

- repo mutation correctness and narrowly scoped interactive approval dedupe fit together, but both stay explicitly out of automation and routine execution paths

## Phase 5: Comparative Tooling

- Optional Workstream 8

---

## Verification Requirements

For each landed slice:

- `npm run check`
- focused Vitest coverage for the touched module set
- `npm test`
- `node scripts/test-coding-assistant.mjs` when the coding/runtime path changes
- `node scripts/test-code-ui-smoke.mjs` when web chat or Code UI consumers change
- `node scripts/test-contextual-security-uplifts.mjs` when approval, sandbox, trust, or degraded-host behavior changes

Additional required checks by workstream:

- Workstreams 1 and 2:
  - route and approval continuation tests
  - run timeline rendering assertions
- Workstream 4:
  - degraded sandbox and unavailable backend assertions
  - control-plane status rendering checks
- Workstream 5:
  - compaction invariant tests
  - prompt-source footprint diagnostics tests
- Workstream 6:
  - concurrent same-file mutation tests
  - changed-files and recent-jobs correctness tests
- Workstream 7:
  - duplicate interactive approval replay tests
  - explicit non-reuse tests for automations, routines, and scheduled tasks

---

## Success Criteria

This plan is successful when:

- Guardian’s assistant runtime is easier to evolve without repeatedly editing the same monoliths
- shared runtime events drive web, CLI, and Code progress behavior
- tool and runtime availability are explicit enough that degraded states are obvious and auditable
- prompt assembly and compaction become inspectable contracts instead of hidden heuristics
- repo writes are more deterministic under concurrent activity
- none of the above weakens the current security, approval, or orchestration model

---

## Relationship To Existing Plans

This plan does not replace the broader modularization or kernel plans.

It narrows them by selecting the `pi-mono` ideas that are actually worth carrying forward:

- narrower runtime seams
- canonical events
- richer descriptors
- typed availability state
- budgeted context inputs
- safer repo mutation behavior

It explicitly excludes the `pi-mono` ideas that do not fit Guardian:

- plugin-first core architecture
- terminal-first product assumptions
- browser-owned session truth
- command sprawl
- parity-chasing UX work
