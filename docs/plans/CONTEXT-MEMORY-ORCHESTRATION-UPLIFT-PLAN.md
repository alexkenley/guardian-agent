# Context, Memory, and Orchestration Uplift Plan

**Status:** Published
**Date:** 2026-04-03
**Origin:** Guardian repo architecture review plus comparative analysis of external agent-runtime patterns for prompt weight, memory hygiene, and orchestration structure
**Companion designs:** [CONTEXT-ASSEMBLY-DESIGN.md](../design/CONTEXT-ASSEMBLY-DESIGN.md), [MEMORY-SYSTEM-DESIGN.md](../design/MEMORY-SYSTEM-DESIGN.md), [ORCHESTRATION-DESIGN.md](../design/ORCHESTRATION-DESIGN.md), [TOOLS-CONTROL-PLANE-DESIGN.md](../design/TOOLS-CONTROL-PLANE-DESIGN.md)

## Objective

Reduce prompt weight and retrieval latency while improving continuity quality, memory hygiene, and orchestration visibility.

The target state is a Guardian runtime that:

1. sends less default context to both local and external models
2. makes deferred discovery and drilldown more reliable
3. uses maintained summaries instead of repeatedly re-summarizing raw history
4. retrieves memory/evidence in a more selective and less blocking way
5. runs memory hygiene as explicit bounded maintenance work instead of hidden prompt work
6. preserves protocol correctness and operator visibility as context gets more compact

## Planning Principles

- **Correctness before compression.** Compaction must preserve tool-call/result structure, current objectives, and blocker state before we make it more aggressive.
- **Compact inventory plus explicit drilldown.** The model should know what exists without receiving every schema, catalog, or profile body up front.
- **Shared semantics across local and external.** The context model can differ in formatting or description length, but capability availability must not diverge by provider tier.
- **Maintained artifacts beat repeated summarization.** Reusable summaries should be refreshed incrementally and treated as first-class runtime state.
- **Retrieval should help without always blocking.** Memory and evidence loading should be consume-if-ready when possible.
- **Background hygiene must stay observable.** Extraction, consolidation, and summary refresh are orchestration concerns, not invisible model-side magic.
- **Preserve Guardian's existing strengths.** Trust-aware memory, scope separation, approvals, durable traces, and brokered worker boundaries remain intact.

## Current Baseline

| Area | Current state | Notes |
|---|---|---|
| Shared context assembly contract | Strong partial | Central contract exists, but several producers still emit heavier or overlapping sections than necessary. |
| Deferred tool discovery | Partial | Compact inventory exists, but search quality and weaker-model discovery reliability still need work. |
| Tool-definition payload stability | Weak partial | Tool schemas are regenerated frequently and can churn between adjacent rounds. |
| Maintained session summaries | Partial | Code sessions already keep `focusSummary`, `planSummary`, and `compactedSummary`, but the compacted summary is still too incidental. |
| Prompt-time memory selection | Strong partial | Signal-aware packing and diagnostics exist, but retrieval timing and full-entry loading can still be improved. |
| Background memory hygiene | Weak partial | Flush exists, but extraction and consolidation are not yet first-class bounded maintenance jobs. |
| Compaction correctness | Partial | Current compaction has diagnostics, but invariant preservation needs to be stronger. |
| Orchestration visibility for maintenance work | Weak partial | Shared job/timeline infrastructure exists, but memory/context hygiene is not yet modeled as an explicit maintenance lane. |

## Scope

This plan covers:

- shared execution-context assembly
- deferred tool discovery and tool-definition shaping
- provider/model, cloud, browser, and allowlist context slimming
- maintained session summary artifacts
- prompt-time memory retrieval and packing
- background extraction, consolidation, and summary refresh
- orchestration and diagnostics needed to make the above safe and inspectable

This plan does not cover:

- replacing the Intent Gateway
- replacing Guardian's trust-aware memory store with file-based ad hoc memory
- weakening approval, trust, quarantine, or scope boundaries for convenience
- silently promoting deferred tools to always-loaded just to work around discovery bugs

## Phase 0: Correctness and Observability Baseline

### Goal

Stabilize the boundaries that later optimization will rely on.

### Deliver

- compaction invariant rules for assistant tool calls and tool results
- preservation of current objective, blocker state, and active execution refs during aggressive trim
- clearer compaction diagnostics for what was summarized versus removed
- baseline metrics for section footprint and tool-definition payload size

### Likely files

- `src/util/context-budget.ts`
- `src/chat-agent.ts`
- `src/runtime/context-assembly.ts`
- `src/util/context-budget.test.ts`

### Exit criteria

- aggressive compaction no longer risks leaving orphaned tool results or half-preserved tool-call sequences
- diagnostics can explain which stages ran and what summary artifact was produced
- prompt-footprint regression tests exist for at least one normal chat path and one coding-session path

## Phase 1: Deferred Discovery and Compact Inventory Reliability

### Goal

Make hidden capability discovery reliable without re-expanding the full tool payload.

### Deliver

- stronger `find_tools` matching:
  - exact tool name
  - family prefix
  - category keyword
  - bounded description/keyword fallback
- compact deferred inventory improvements:
  - stable category grouping
  - short routing-relevant hints where justified
  - no full parameter schemas
- provider/model inventory compaction using the same drilldown pattern
- regression coverage for weaker-model discovery phrasing

### Likely files

- `src/tools/registry.ts`
- `src/tools/executor.ts`
- `src/chat-agent.ts`
- `src/tools/registry.test.ts`
- `src/tools/executor.test.ts`

### Exit criteria

- deferred tools remain deferred
- discovery works for direct tool names and common family/category phrasing
- provider/model switching flows no longer depend on ad hoc tool promotion

## Phase 2: Stable Tool Payloads and Canonical Catalogs

### Goal

Reduce prompt churn between adjacent rounds and remove duplicate catalog sections.

### Deliver

- session-stable tool-definition shaping within the active tool loop
- one canonical compact skill catalog
- removal of overlapping skill/tool catalog duplication in prompt assembly
- provider-locality aware rendering that changes only when locality or loaded tools actually change

### Likely files

- `src/chat-agent.ts`
- `src/chat-agent-helpers.ts`
- `src/runtime/context-assembly.ts`
- `src/skills/prompt.ts`
- `src/worker/worker-session.ts`

### Exit criteria

- adjacent tool rounds do not rebuild materially different tool payloads without cause
- skill availability appears once in a canonical compact form
- prompt assembly diagnostics can show the catalog sections that were included

## Phase 3: Operational Context Slimming

### Goal

Shrink the heavy default operational sections that do not need to be fully expanded every turn.

### Deliver

- compact cloud profile inventory
- compact provider/model role summary
- capped allowlist summaries for paths, commands, and domains
- tighter browser capability summary with detailed behavior behind drilldown
- request-aware matching so obviously relevant allowlist/profile items can still be surfaced directly

### Likely files

- `src/tools/executor.ts`
- future extraction around `src/tools/tool-context.ts`
- provider control-plane helpers
- relevant tool-context tests

### Exit criteria

- `<tool-context>` stays informative without being dominated by profile/config lists
- control-plane details remain available through explicit lookup paths
- local and external providers see the same operational availability semantics

## Phase 4: Maintained Session Summaries

### Goal

Promote bounded summaries from incidental by-products to first-class runtime artifacts.

### Deliver

- maintained session summary contract for code sessions
- incremental refresh rules for `focusSummary`, `planSummary`, and `compactedSummary` successors
- summary selection order that prefers maintained artifacts over raw-history re-summarization
- memory-flush alignment so dropped context and maintained summaries reinforce each other instead of duplicating work

### Likely files

- `src/runtime/code-sessions.ts`
- `src/chat-agent.ts`
- `src/runtime/memory-flush.ts`
- `src/runtime/code-sessions.test.ts`
- `src/runtime/memory-flush.test.ts`

### Exit criteria

- coding sessions keep a bounded maintained summary that survives context pressure
- prompt compaction reuses that artifact before generating new ad hoc summary text
- memory flush and maintained summaries do not create repetitive low-signal duplication

## Phase 5: Prompt-Time Memory Retrieval Optimization

### Goal

Improve retrieval quality and latency without weakening trust boundaries.

### Deliver

- metadata-first candidate scan over sidecar summaries/tags/category signals
- non-blocking prefetch and consume-if-ready retrieval behavior
- smaller winning-set loading of full entry content
- stronger section-level selection diagnostics
- preserved trust, provenance, and quarantine handling for all retrieved material

### Likely files

- `src/runtime/agent-memory-store.ts`
- `src/runtime/conversation.ts`
- `src/runtime/context-assembly.ts`
- `src/index.ts`
- memory selection tests

### Exit criteria

- prompt-time memory loading becomes more selective and less blocking
- retrieval still explains why an entry won context
- missing or slow retrieval does not stall ordinary turns unnecessarily

## Phase 6: Background Memory Hygiene and Consolidation

### Goal

Move heavier memory maintenance work into explicit bounded runtime jobs.

### Deliver

- thresholded extraction of durable facts from richer recent context
- coalescing of overlapping extracted summaries
- periodic consolidation of stale or redundant memory
- locking/idempotency rules to prevent transcript races
- shared job/timeline/audit visibility for maintenance runs

### Likely files

- `src/runtime/agent-memory-store.ts`
- `src/runtime/conversation.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/assistant-jobs.ts`
- operator/timeline surfaces as needed

### Exit criteria

- extraction and consolidation are explicit maintenance jobs, not hidden prompt work
- maintenance failures degrade safely without corrupting durable state
- operators can see when maintenance ran and what artifact class it produced

## Phase 7: Coding Evidence Budgeting and Retrieval-Backed Working Sets

### Goal

Keep coding-session prompts grounded while reducing raw file payload.

### Deliver

- tighter budgeting for working-set evidence
- summary-first code evidence selection
- preference for path/symbol/manifest context over large raw snippets
- deeper file content retrieval only when the active task requires it

### Likely files

- `src/chat-agent.ts`
- code-session working-set builders
- `src/util/context-budget.ts`
- coding-session prompt tests

### Exit criteria

- coding-session prompts preserve trust, identity, repo shape, and active task context with lower raw text volume
- working-set evidence remains retrieval-backed instead of defaulting to broad file excerpts

## Phase 8: Section Budgets, Diagnostics, and Rollout Guardrails

### Goal

Make the new compact behavior measurable and safe to roll out.

### Deliver

- section-level prompt-footprint diagnostics
- regression budgets for:
  - tool payload
  - tool context
  - memory context
  - coding evidence
- harness coverage for deferred discovery, maintained-summary reuse, and retrieval latency/fallback behavior
- rollout flags or staged enablement where needed for riskier changes

### Likely files

- `src/runtime/context-assembly.ts`
- `src/chat-agent.ts`
- `src/tools/executor.test.ts`
- harness scripts under `scripts/`

### Exit criteria

- each major section has observable footprint and compaction diagnostics
- new behavior can be enabled incrementally without blind regressions
- at least one real-model or integration harness covers the main discovery and summary paths

## Recommended Sequence

1. Phase 0 first. Compaction correctness is the prerequisite for everything else.
2. Phase 1 and Phase 3 next. They directly reduce prompt weight and fix the current deferred-discovery reliability risk.
3. Phase 2 after discovery is stable. There is no value in caching or stabilizing poor discovery behavior.
4. Phase 4 before Phase 6. Maintained summary artifacts should exist before broader background maintenance starts refreshing them.
5. Phase 5 before or alongside Phase 7. Memory retrieval and coding evidence budgeting both depend on the same retrieval-backed philosophy.
6. Phase 8 throughout, but formalize the diagnostics before large rollout.

## Verification Expectations

- unit coverage for registry search, compaction invariants, session-summary updates, and memory selection
- focused integration tests for deferred discovery and provider/model drilldown
- coding-session smoke validation for prompt compaction and maintained-summary reuse
- timeline/audit verification for background maintenance jobs
- `npm run build`

## Relationship to Existing Plans

This plan consolidates the active implementation direction from:

- [Context Assembly Design](../design/CONTEXT-ASSEMBLY-DESIGN.md)
- [Memory System Uplift Plan](MEMORY-SYSTEM-UPLIFT-PLAN.md)
- [Background Delegation Uplift Plan](BACKGROUND-DELEGATION-UPLIFT-PLAN.md)

Those documents remain useful history and narrower references. This document is the authoritative phased plan for the combined uplift.
