# Assistant Capability Uplift Roadmap

**Date:** 2026-03-31  
**Status:** Active roadmap  
**Scope:** Sequencing and dependency guide for the current uplift workstreams  
**Live status tracker:** [ASSISTANT-CAPABILITY-UPLIFT-STATUS.md](/mnt/s/development/guardianagent/plans/ASSISTANT-CAPABILITY-UPLIFT-STATUS.md)  
**Companion plans:** [CROSS-SURFACE-CONTINUITY-UPLIFT-PLAN.md](/mnt/s/development/guardianagent/plans/CROSS-SURFACE-CONTINUITY-UPLIFT-PLAN.md), [MEMORY-SYSTEM-UPLIFT-PLAN.md](/mnt/s/development/guardianagent/plans/MEMORY-SYSTEM-UPLIFT-PLAN.md), [CONTEXT-ASSEMBLY-UPLIFT-PLAN.md](/mnt/s/development/guardianagent/plans/CONTEXT-ASSEMBLY-UPLIFT-PLAN.md), [BACKGROUND-DELEGATION-UPLIFT-PLAN.md](/mnt/s/development/guardianagent/plans/BACKGROUND-DELEGATION-UPLIFT-PLAN.md), [MINIMAL-EMBEDDABLE-AGENT-KERNEL-UPLIFT-PLAN.md](/mnt/s/development/guardianagent/plans/MINIMAL-EMBEDDABLE-AGENT-KERNEL-UPLIFT-PLAN.md)

---

## Goal

Define which major uplifts should run in parallel, which should remain separate, and how the layered intelligence work should support them.

This roadmap treats the current effort as four companion workstreams:

1. cross-surface continuity
2. memory system uplift
3. context assembly uplift
4. background delegation uplift

The layered intelligence architecture and the minimal embeddable kernel posture are cross-cutting enablers, not isolated product features.

---

## Current As-Built Position

The roadmap is no longer hypothetical. The core foundation work is now landed.

What is already done:

- cross-surface continuity thread state
- shared pending-action portability rules and resume semantics
- shared bounded context assembly for main chat, coding-session chat, and worker handoff
- structured memory flush, query-aware retrieval, and explainability metadata
- stronger operator visibility through routing trace, execution timeline, matched-run correlation, and deep links into coding sessions and exact events
- delegated worker lineage, bounded handoff summaries, and explicit follow-up policy
- delegated run classes for `in_invocation`, `short_lived`, `long_running`, and `automation_owned`
- bounded operator controls for held delegated results: replay, keep-held, and dismiss

What is not fully done yet:

- final continuity polish around edge-case cross-surface behavior
- broader producer adoption for delegated run classes beyond the current brokered-worker metadata path
- better timeline/query affordances for delegated lineage and held-result decisions
- delegated runtime defaults for when classes should auto-report, stay held, or remain status-only
- richer continuity-aware long-running/background delegation behavior
- minimal embeddable kernel cleanup and intelligence-in-depth runtime rollout

Important current boundary:

- the held delegated-result controls are implemented, but they are not yet broadly reachable from normal product requests until more producers emit `long_running` or `automation_owned` delegated runs

Current recommendation:

- treat the foundation uplift as ready for manual testing now
- use testing to decide which remaining uplift items actually matter next
- defer the broader intelligence-in-depth rollout until after stabilization unless testing shows it is urgently needed

---

## Recommended Workstream Split

### Parallel now

- Cross-surface continuity
- Memory system uplift
- Context assembly uplift
- Intelligence-in-depth design and interface work

### Mostly separate implementation

- Background delegation uplift

Background delegation can start design work now, but its heavier runtime implementation should follow the first three workstreams because it depends on:

- reliable continuity state
- stronger memory and retrieval
- better prompt/context packing
- clearer run/audit surfaces

---

## Why These Three Belong Together

### 1. Continuity

This gives Guardian a bounded model of the current user objective across linked surfaces.

Without it, the system keeps losing the thread when the operator changes channels.

### 2. Memory

This gives Guardian better durable recall and structured state retrieval.

Without it, continuity collapses into a thin recent-history trick.

### 3. Context Assembly

This gives Guardian better packaging of the right context into each turn.

Without it, both continuity and memory improvements leak value because the model still sees noisy or weakly prioritised prompts.

These three together improve:

- continuity across channels
- continuity across turns
- continuity across degraded or resumed executions

---

## Why Background Delegation Should Follow

Delegated and background work amplifies orchestration quality.

If the base continuity and context model are weak, adding more delegation tends to produce:

- more fragmented state
- harder-to-debug follow-up behavior
- more cross-run confusion
- more mismatch between user-visible thread and actual execution lineage

Background delegation should therefore build on:

- continuity thread state
- stronger memory retrieval
- stronger bounded prompt assembly
- clear event timeline and audit linkage

---

## Cross-Cutting Layered Intelligence Guidance

The layered intelligence framework should be implemented as a supporting architecture across the first three workstreams.

### Layer 0

Owns:

- deterministic resumes
- approvals
- policy enforcement
- exact control-plane operations

### Layer 1

Owns degraded fallback for:

- continuity-sensitive routing
- blocker-resolution classification
- bounded operator guidance

### Layer 2

Should become the preferred lane for:

- Intent Gateway classification
- continuity relation judgment
- portable vs origin-bound blocker classification
- compact routing and safety decisions

### Layer 3 and Layer 4

Remain the main assistant execution lanes for:

- tool loops
- synthesis
- coding
- complex task execution

---

## Cross-Cutting Kernel Guidance

The minimal embeddable agent-kernel plan should constrain how the other uplifts land.

That means:

- keep shared state in the kernel
- keep capability-specific behavior outside the kernel where possible
- strengthen the session contract instead of growing more main-loop branching
- keep surfaces transport-neutral at the orchestration level
- preserve policy, approvals, trust, and audit as kernel-owned boundaries

---

## Dependency Matrix

| Workstream | Can start now | Depends on | Notes |
|---|---|---|---|
| Cross-surface continuity | Yes | Current orchestration model | Primary state-model change |
| Memory system uplift | Yes | Existing memory architecture | Existing plan already covers this |
| Context assembly uplift | Yes | Current prompt and conversation layers | Should align with continuity summaries |
| Background delegation uplift | Design now, implementation later | Continuity + memory + context + timeline | Highest coupling risk |
| Intelligence-in-depth | Yes | Interface and routing changes | Cross-cutting support track |

---

## Recommended Delivery Order

### Wave 1

- continuity thread model
- memory retrieval and packing improvements
- context assembly refactor
- intelligence-layer interface changes for classification/routing

### Wave 2

- pending-action transfer-policy support
- continuity-aware UI and traces
- continuity-aware coding-session integration
- continuity-aware prompt assembly across surfaces

### Wave 3

- delegated/background run model
- delegated follow-up summaries
- delegated run visibility and operator controls
- continuity-aware long-running work

---

## Recommended Next Phase

Do not treat the remaining roadmap items as pre-test blockers.

Recommended next step:

- move into manual testing and stabilization on the landed capability foundation

Use the remaining roadmap items mainly as:

- follow-up uplift work after test feedback
- architecture guardrails so future changes do not regress the shared model

Prioritize fixes found during testing over continuing to widen the architecture speculatively.

---

## Recommendation

Run continuity, memory, and context assembly as one coordinated uplift set.

Treat background delegation as the next major workstream built on top of that foundation.

Treat intelligence-in-depth as a parallel architecture lane that should shape routing and bounded-decision interfaces now, even if the full runtime rollout lands incrementally.
