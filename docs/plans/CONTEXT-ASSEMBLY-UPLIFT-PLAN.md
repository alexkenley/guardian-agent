# Context Assembly Uplift Plan

> Superseded as the primary implementation sequence by [Context, Memory, and Orchestration Uplift Plan](/mnt/s/Development/GuardianAgent/docs/plans/CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md). This document remains as narrower historical planning context.

**Date:** 2026-03-30  
**Status:** Draft  
**Origin:** Prompt-grounding and context-packaging review  
**Key files:** `src/runtime/conversation.ts`, `src/index.ts`, `src/prompts/guardian-core.ts`, `src/prompts/code-session-core.ts`, `src/runtime/code-workspace-map.ts`, `src/runtime/code-sessions.ts`  
**Primary specs impacted:** `docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md`, `docs/specs/CODING-WORKSPACE-SPEC.md`, `docs/specs/ORCHESTRATION-SPEC.md`, `docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md`

---

## Goal

Improve how Guardian packages conversation history, continuity state, memory retrieval, and execution context into model-facing prompts.

The target is not "more prompt". The target is:

- less irrelevant context
- better prioritised context
- bounded continuity summaries
- clearer distinction between current request, recent history, durable memory, and execution state

---

## Problems

Current architecture has the right components, but the packing strategy is still too coarse in several places:

- recent conversation and repaired intent are strong for short local follow-ups, but weaker for linked-surface continuity
- memory improvements do not help enough unless prompt assembly knows how to rank and pack them
- execution context, blocker state, and recent objective are not yet consistently treated as first-class prompt sections
- code-session prompt assembly is stronger than main-chat prompt assembly, but the two do not yet share one bounded context model

---

## Design Principles

1. Current request should always dominate the prompt.
2. Continuity summary should beat raw history when they conflict.
3. Durable memory should be selected evidence, not a dumped archive.
4. Execution state should be represented structurally, not as accidental prose.
5. Untrusted repo or remote content must remain marked as data, not instructions.

---

## Uplift Areas

### 1. Prompt Context Sections

Standardise prompt assembly into explicit bounded sections:

- current request
- continuity summary
- active blocker summary
- current execution context
- selected recent history
- selected durable memory
- selected retrieved workspace evidence

This should apply to:

- main Guardian chat
- code-session turns
- worker-side prompt assembly
- delegated/background follow-up synthesis

### 2. Context Ranking

Introduce explicit ranking rules so prompt assembly prefers:

1. current actionable request
2. continuity focus summary
3. active blocker and execution references
4. recent local turns
5. durable memory and retrieved evidence

This avoids low-value raw history pushing out the higher-signal state.

### 3. Shared Bounded Context Objects

Prompt assembly should consume structured objects rather than loosely coupled strings.

Suggested shapes:

```ts
interface ContinuityPromptState {
  focusSummary?: string;
  lastActionableRequest?: string;
  activeBlockers?: string[];
  executionRefs?: string[];
}

interface PromptAssemblyInput {
  currentRequest: string;
  continuity?: ContinuityPromptState;
  recentHistory?: Array<{ role: string; content: string }>;
  durableMemory?: Array<{ title: string; summary: string; content?: string }>;
  workspaceEvidence?: Array<{ path: string; summary: string; trust: string }>;
}
```

### 4. History Compaction Strategy

Compaction should produce bounded reusable summaries that preserve:

- current objective
- unresolved blocker state
- active execution references
- key user corrections

Compaction should stop treating all dropped history as generic summary text.

### 5. Surface-Aware Assembly

Different surfaces can keep different render histories, but prompt assembly should receive the same continuity-aware state.

That means:

- same user objective can survive surface switches
- UI transcript differences do not cause routing drift
- approval and trust boundaries remain surface-sensitive

---

## Relationship To Other Plans

### Cross-Surface Continuity

This plan depends on the continuity thread model for high-quality cross-channel packaging.

### Memory System Uplift

This plan depends on stronger memory ranking, summaries, and retrieval so durable memory can enter the prompt as selected evidence rather than raw text.

### Background Delegation

Delegated runs should use the same structured context assembly rules rather than inventing their own prompt packing logic.

---

## Proposed Work

### Phase 1: Prompt Assembly Refactor

- identify the current prompt assembly call sites
- normalize them around one structured context builder
- separate recent history, durable memory, and execution state into explicit sections

### Phase 2: Ranking And Budgeting

- add section budgets
- add ranking rules for continuity vs recent history vs durable memory
- prefer summaries before full content when budget is tight

### Phase 3: Shared Summary Types

- define reusable summary shapes for continuity, blocker state, workspace evidence, and memory evidence
- ensure worker-side and code-session prompt assembly use the same types

### Phase 4: Compaction Alignment

- update compaction outputs to preserve actionable state
- prevent compaction from erasing the current user objective

---

## Tests

- prompt assembly unit tests for main Guardian chat
- prompt assembly unit tests for code-session turns
- continuity-aware history selection tests
- compaction summary tests
- trust-aware workspace evidence tests

---

## Recommendation

Implement this in parallel with cross-surface continuity and the memory uplift.

It is a foundation-level improvement. Delaying it would leave continuity and memory with weaker model-facing impact than they should have.
