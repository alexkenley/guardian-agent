# Minimal Embeddable Agent Kernel Uplift Plan

**Date:** 2026-03-30  
**Status:** Draft  
**Origin:** Review of modern minimal coding-agent kernel patterns and extensible agent runtimes  
**Key files:** `src/index.ts`, `src/worker/worker-session.ts`, `src/supervisor/worker-manager.ts`, `src/runtime/context-assembly.ts`, `src/runtime/conversation.ts`, `src/runtime/continuity-threads.ts`, `src/runtime/pending-actions.ts`, `src/runtime/code-sessions.ts`, `src/skills/`, `src/prompts/`  
**Primary specs impacted:** `docs/specs/ORCHESTRATION-SPEC.md`, `docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md`, `docs/specs/INTELLIGENCE-IN-DEPTH-SPEC.md`, `docs/specs/CODING-WORKSPACE-SPEC.md`, `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`

---

## Goal

Make Guardian easier to evolve, embed, and adapt by converging on a smaller agent kernel with stronger primitives and fewer hard-wired workflow assumptions in the core runtime.

The target outcome is:

- a compact core assistant/session runtime
- composable primitives instead of feature-specific branching in the kernel
- extension-friendly capability surfaces
- transport-neutral session behavior across web, CLI, Telegram, and future surfaces
- customization points for prompts, tools, memory packing, and operator workflow without weakening security posture

This is not a proposal to make Guardian more permissive. It is a proposal to make Guardian more modular.

---

## Non-Goals

- removing Guardian’s approval, policy, trust, or audit boundaries
- collapsing orchestration, security, and agent execution into a single monolith
- replacing the current shared orchestration model with channel-local agent wrappers
- turning the runtime into a plugin free-for-all with unbounded execution hooks
- rebuilding every current subsystem before continuing delivery

---

## Why This Work Matters

Guardian’s current uplift work is improving continuity, memory, and context quality, but those improvements can still accumulate technical debt if the core assistant runtime keeps absorbing special cases.

The system should be able to grow by adding or swapping:

- tool surfaces
- prompt assembly rules
- memory retrieval strategies
- delegated worker behavior
- UI affordances
- domain-specific skills

without forcing each new capability to patch the main assistant loop directly.

The core runtime should own only the things that must be shared:

- session lifecycle
- message orchestration
- continuity state
- pending/blocker state
- approval and policy boundaries
- prompt/context assembly primitives
- worker delegation contracts

Everything else should be built on those primitives.

---

## Design Principles

1. Keep the kernel small.
2. Prefer primitives over product-specific behavior.
3. Keep session semantics transport-neutral.
4. Make customization explicit and bounded.
5. Security boundaries remain in the kernel, not in optional extensions.
6. New capabilities should compose with continuity, memory, and approvals rather than bypass them.

---

## Target Runtime Shape

Guardian should increasingly resemble a layered agent kernel with five stable surfaces:

### 1. Session Kernel

Owns:

- message/session lifecycle
- turn state
- branching/continuation hooks
- compaction checkpoints
- run metadata

### 2. Shared Orchestration Layer

Owns:

- Intent Gateway classification
- continuity thread state
- pending actions and transfer policy
- approval routing
- auth and prerequisite blockers

### 3. Context Assembly Layer

Owns:

- bounded prompt sections
- history selection
- durable memory packing
- workspace evidence packing
- runtime notices and execution-state packaging

### 4. Capability Layer

Owns:

- tools
- skills
- extension packages
- delegated workers
- prompt templates
- channel-specific affordances

### 5. Surface Adapters

Owns:

- web rendering
- CLI rendering
- Telegram rendering
- future app/channel adapters

Surface adapters should not redefine orchestration semantics. They render and collect input; the kernel remains authoritative.

---

## Uplift Areas

### Uplift 0: Define the Kernel Boundary

### Problem

The current runtime has strong shared systems, but it is still easy for feature work to bleed into:

- `src/index.ts`
- worker session handling
- channel glue
- prompt assembly

without a crisp rule for what belongs in the kernel versus a capability module.

### Solution

Adopt an explicit kernel boundary:

Kernel responsibilities:

- sessions
- orchestration
- continuity
- approvals/policy
- prompt assembly primitives
- worker/session contracts

Non-kernel responsibilities:

- automation-specific authoring behavior
- channel rendering specifics
- package/domain heuristics
- optional domain workflows
- UI-only convenience logic

### Required outcome

Every new behavior should answer:

1. Is this shared assistant state?
2. Is this a capability built on shared state?
3. Is this only a rendering concern?

If the answer is `2` or `3`, it should not be implemented as new kernel branching by default.

---

### Uplift 1: Stable Agent Session Contract

### Problem

The assistant runtime and worker runtime are converging, but the session contract is still partly implicit and partly distributed across:

- supervisor message envelopes
- worker prompt assembly
- conversation history
- code-session context

### Solution

Define and stabilize an `AgentSession`-style contract for Guardian’s core runtime.

Recommended session inputs:

- current message
- selected recent history
- continuity summary
- active blocker summary
- durable memory excerpts
- selected workspace evidence
- granted capabilities
- execution context metadata

Recommended session outputs:

- assistant content
- tool calls
- pending-action metadata
- response-source metadata
- continuation metadata
- compaction/update hints

This does not require a public SDK immediately, but the internal contract should be treated as if it could be embedded or reused.

---

### Uplift 2: Extension-First Capability Model

### Problem

Some current behavior still trends toward “feature embedded in the main assistant path” instead of “capability built on shared primitives.”

### Solution

Keep pushing features outward into bounded modules:

- skills remain instruction packages
- tools remain declarative capability surfaces
- automation authoring/control stays outside the kernel
- domain-specific workflows become extension-style modules over shared orchestration

Recommended direction:

- keep new domain behaviors in `src/runtime/*-prerouter.ts`, tool modules, or skills when possible
- keep prompt overlays in `src/prompts/` and context builders, not inline branch logic
- avoid turning the main assistant loop into a registry of feature exceptions

This is compatible with the current uplift work and should constrain future implementation choices.

---

### Uplift 3: Transport-Neutral Session Semantics

### Problem

Different surfaces naturally want different UX, but that can lead to divergent assistant semantics if the runtime is not strict.

### Solution

Keep these semantics shared across surfaces:

- continuity ownership
- pending-action ownership
- approval metadata
- branch/restore behavior
- compaction semantics
- memory flush behavior

Allow these to vary by surface:

- rendering
- interaction affordances
- disclosure depth
- transient UI helper text

This keeps Guardian embeddable across surfaces without forcing a single transcript presentation.

---

### Uplift 4: File-Based and Package-Based Customization Points

### Problem

Guardian already has prompts, skills, policies, and config, but customization surfaces are still uneven.

### Solution

Standardize supported customization points instead of letting them emerge ad hoc:

- prompt templates/system overlays
- skills
- tool bundles / extension packages
- themes/render presets
- channel-specific presentation config
- future delegated agent profiles

These should be treated as supported extension seams, not accidental implementation detail.

Important constraint:

- customization may shape behavior
- customization may not bypass policy, approvals, trust, or audit controls

---

### Uplift 5: Compaction and Branching as First-Class Session Behavior

### Problem

Compaction exists, but should be treated as session infrastructure rather than an emergency budget trick.

### Solution

Continue moving toward first-class session operations:

- structured compaction summaries
- branch/restore aware history
- durable flush summaries
- continuation-safe condensed state

This aligns with the continuity and memory uplifts already in flight and keeps long-running work manageable without bloating the active prompt.

---

### Uplift 6: Security-Retained Minimalism

### Problem

Minimal agent kernels often feel powerful because they remove friction entirely. Guardian cannot adopt that posture wholesale.

### Solution

Adopt the good parts of minimalism:

- smaller core
- clearer primitives
- easier embedding
- fewer accidental abstractions

Do not adopt the unsafe parts:

- unrestricted command execution by default
- no-approval mutation posture
- weak trust boundaries
- unscoped prompt injection exposure

Guardian’s kernel should remain the home of:

- policy enforcement
- approval enforcement
- trust state
- audit logging
- scoped capability grants

---

## Relationship To Other Plans

### Cross-Surface Continuity

This plan reinforces the idea that continuity belongs to the shared kernel, not to channel-specific glue.

### Memory System Uplift

Memory should plug into the kernel as a bounded retrieval/packing primitive, not as a second ad hoc context path.

### Context Assembly Uplift

Context assembly becomes one of the kernel’s core primitives and must remain reusable across main chat, code sessions, workers, and future delegates.

### Background Delegation

Delegated workers should consume the same session contract and context assembly inputs rather than inventing a parallel agent architecture.

### Intelligence-in-Depth

Layered intelligence should sit above the kernel boundary decisions and below capability-specific behavior, not be entangled with product-specific features.

---

## Implementation Guidance

Use this plan as a constraint during the current uplifts:

1. When adding continuity or memory behavior, prefer shared primitives over new main-loop branches.
2. When adding worker/delegation behavior, extend the session contract instead of forking orchestration semantics.
3. When adding channel UX, keep it in render/adaptor code unless it changes canonical runtime state.
4. When adding customization points, keep them bounded and policy-aware.
5. When in doubt, shrink the kernel and strengthen the contract instead of adding another cross-cutting special case.

---

## Recommendation

Treat this as a cross-cutting architectural guardrail for the current uplift set, not as a separate delivery wave.

The continuity, memory, context-assembly, and delegation work should all move Guardian toward:

- a smaller kernel
- a stronger session contract
- extension-first capability growth
- transport-neutral orchestration
- security-retained modularity
