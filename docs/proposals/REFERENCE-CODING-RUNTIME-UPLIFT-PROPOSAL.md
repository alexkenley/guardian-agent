# Reference Coding Runtime Uplift Proposal

**Status:** Draft
**Date:** 2026-04-02
**Primary Guardian files:** [src/tools/executor.ts](../../src/tools/executor.ts), [src/tools/registry.ts](../../src/tools/registry.ts), [src/tools/mcp-client.ts](../../src/tools/mcp-client.ts), [src/runtime/context-assembly.ts](../../src/runtime/context-assembly.ts), [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts), [src/sandbox/types.ts](../../src/sandbox/types.ts), [docs/architecture/FORWARD-ARCHITECTURE.md](../architecture/FORWARD-ARCHITECTURE.md)
**Related docs:** [BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md](../implemented/BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md), [GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md](./GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md), [CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md](./CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md), [RUNTIME-INTELLIGENCE-UPLIFTS-PROPOSAL.md](./RUNTIME-INTELLIGENCE-UPLIFTS-PROPOSAL.md), [CODING-WORKSPACE-DESIGN.md](../design/CODING-WORKSPACE-DESIGN.md)

## Goal

Use the inspected reference repository as an architectural benchmark for Guardian’s coding/runtime surfaces without copying its product identity, transport posture, or feature sprawl.

The useful lesson from that reference tree is not "become that product." The useful lesson is that a coding agent becomes much easier to reason about when its runtime spine is explicit:

- one narrow conversation/tool loop
- one typed session transcript model
- one manifest-driven registry story for tools and commands
- one prompt assembly boundary
- one typed bootstrap story for config, MCP, remote backends, and sandbox state

Guardian already has stronger security and broader orchestration than the reference tree. The uplift here is therefore packaging and clarity, not replacement.

## Assessment Summary

The inspected reference repo is strongest in six areas:

1. a transport-neutral conversation runtime that owns the user turn, tool loop, permission checks, hooks, usage accounting, and compaction
2. manifest-style tool and slash-command registries with explicit metadata instead of scattered command knowledge
3. typed session artifacts for transcript persistence, tool results, and usage
4. prompt assembly that treats instruction files, environment state, and git context as a bounded, explicit input set
5. typed bootstrap/config models for MCP transports, sandbox state, and remote execution setup
6. a compatibility harness that extracts reference command/tool/bootstrap surfaces without copying implementation

The same reference repo is much less compelling in areas Guardian should not copy:

- plugin-style extensibility as a primary first-party architecture
- worktree-first or terminal-ritual-first UX as the default coding model
- breadth-chasing CLI parity
- alternate runtimes that bypass the main shared orchestration and approval model

## Guardian Fit

Guardian is already ahead in several important areas:

- backend-owned coding sessions already exist
- shared approvals and pending-action orchestration already exist
- the run timeline already exists as a shared operator-visible activity surface
- tool registration is already first-party and category-based
- Guardian owns security chokepoints that the reference runtime does not

The remaining gap is that some of Guardian’s core coding/runtime seams are still more implicit than they should be:

- [src/tools/executor.ts](../../src/tools/executor.ts) still owns too much orchestration detail
- [src/tools/registry.ts](../../src/tools/registry.ts) is intentionally simple but too thin to carry richer execution metadata cleanly
- [src/tools/mcp-client.ts](../../src/tools/mcp-client.ts) and sandbox/runtime startup state are still more stringly and transport-specific than ideal
- [src/runtime/context-assembly.ts](../../src/runtime/context-assembly.ts) builds good structured prompt sections, but source budgeting and source provenance can be made more explicit
- compaction exists in multiple places, but Guardian still benefits from a more explicit compaction contract that can be reused across chat, coding sessions, brokered workers, and external coding backends

## Unified Recommendation

Adopt the reference repo’s strongest patterns as six bounded Guardian-fit workstreams.

## Workstream 1: Extract A Narrow Runtime Core For Coding Turns

Guardian should extract a more explicit runtime-core boundary for coding and coding-adjacent turns.

That runtime core should own:

- session transcript mutation
- assistant/tool iteration loop
- usage accounting
- compaction entry points
- permission and approval handoff points
- result normalization before reinjection

This does **not** mean replacing the Intent Gateway, shared pending-action model, Guardian enforcement, or the existing runtime dispatch contract.

It means pulling the reusable coding-turn mechanics into a narrower core so CLI, web chat, Code workbench, brokered workers, and optional external coding backends all consume the same turn runtime instead of each depending on wider monoliths.

### Desired features

- one authoritative coding-turn runtime contract
- cleaner session resume and continuation behavior
- cleaner integration point for optional external coding backends
- fewer feature edits landing directly in large composition files

## Workstream 2: Promote Tool And Command Registries Into Rich Contracts

Guardian should keep curated first-party registries, but the registry contracts should become richer and more explicit.

For tools, the registry contract should grow beyond `name`, `description`, `risk`, and `parameters` to also model:

- approval posture
- expected sandbox posture
- required backing services
- surface availability
- resumability / long-running behavior
- artifact output shape
- operator-facing summary labels

For commands and control actions, Guardian should introduce a typed registry similar to the reference repo’s slash-command catalog:

- category
- argument hint
- resume support
- surface availability
- operator-safe help text

This fits Guardian’s forward architecture because tool execution should own registry lifecycle, execution policy, and result shaping. It also fits the existing "later declarative provisioning" direction without becoming a plugin free-for-all.

### Desired features

- more reliable tool exposure across chat, Code, CLI, and dashboard surfaces
- cleaner help, diagnostics, and availability reporting
- fewer one-off `if toolName === ...` branches in runtime orchestration

## Workstream 3: Add Typed Bootstrap Models For MCP, Sandbox, And Remote Backends

Guardian should adopt a more explicit bootstrap/state model for runtime-managed external processes and transports.

Three places matter most:

1. MCP server bootstrap
2. sandbox posture and fallback state
3. external coding backend startup

Instead of loose startup state, Guardian should have typed descriptors for:

- requested mode
- supported mode
- active mode
- fallback reason
- transport kind
- auth mode
- tool prefix / namespacing
- config source / provenance

This is particularly valuable for [src/tools/mcp-client.ts](../../src/tools/mcp-client.ts) and [src/sandbox/types.ts](../../src/sandbox/types.ts), where the runtime needs to explain not just what is configured, but what is truly available right now.

### Desired features

- operator-visible "why this backend/tool is unavailable" diagnostics
- more trustworthy sandbox state reporting
- safer MCP and coding-backend startup
- better control-plane introspection for transport/auth/runtime state

## Workstream 4: Make Prompt Assembly Budgeted, Source-Aware, And Inspectable

The reference repo’s prompt builder is good because it treats project context as an explicit, budgeted input rather than an accidental pile of strings.

Guardian should apply that same discipline to coding-session prompt assembly:

- explicit budget caps per source class
- explicit ordering rules
- explicit provenance for loaded sources
- explicit omission reasons when a source is skipped or truncated

Guardian’s source classes differ from the reference tree and should stay Guardian-native:

- `AGENTS.md` and related workspace instructions
- active skills
- coding-session memory
- global memory where appropriate
- workspace trust review
- workspace profile / map summaries
- git status / diff summaries when safe and useful
- pending-action and approval context

This builds directly on [src/runtime/context-assembly.ts](../../src/runtime/context-assembly.ts) rather than replacing it.

### Desired features

- "show me which instruction sources were loaded for this coding turn"
- bounded prompt growth on large repos
- fewer hidden prompt-shape regressions
- better routing-trace and run-timeline diagnostics for context assembly

## Workstream 5: Make Compaction A First-Class Runtime Artifact

Guardian already tracks compacted coding-session summaries and context-assembly diagnostics. The next step is to make compaction a reusable runtime artifact with one shared contract.

That contract should include:

- summary text
- preserved recent context count
- removed context count
- continuation message or continuation instructions
- whether direct resume is allowed
- source session / conversation identity
- diagnostics safe for timeline and trace surfaces

This should be usable across:

- normal Guardian chat
- backend-owned coding sessions
- brokered worker turns
- optional external coding backend integrations
- automation or scheduled continuation paths that need bounded resume context

### Desired features

- consistent auto-compaction behavior across surfaces
- a clean "compact now" or "resume from compacted state" operator story
- fewer silent context-loss bugs
- better durable summaries for cross-surface continuation

## Workstream 6: Build A Read-Only Compatibility Harness

One of the strongest ideas in the reference repo is its compatibility harness: it extracts tool, command, and bootstrap surfaces from another implementation without copying the implementation itself.

Guardian should adopt that pattern for external coding runtimes and other benchmark systems.

The harness should stay read-only and comparative. Its job is to answer questions like:

- which command/control surfaces exist in the benchmark runtime
- which tool families exist there
- which bootstrap phases exist there
- which Guardian-native equivalents already exist
- which gaps are strategically useful versus noise

This is a better way to evaluate external coding backends than ad hoc note-taking or parity-chasing.

### Desired features

- repeatable benchmark reports
- cleaner roadmap decisions for optional external coding backends
- regression checks for Guardian’s adapter layer without importing third-party code

## Explicit Non-Adoptions

Guardian should **not** adopt the following from the reference repo:

- plugin-style dynamic loading for first-party core behavior
- worktree-first or terminal-ritual-first coding UX as the default operator path
- broad command-surface parity as a goal by itself
- a second orchestration runtime that bypasses the Intent Gateway, shared pending actions, shared approvals, or Guardian-owned execution controls
- breadth-first tool expansion without first-class policy, approval, and availability metadata

## Delivery Order

### Phase 1: Runtime boundaries first

- extract the narrow coding-turn runtime core
- enrich tool and command registry contracts

### Phase 2: Bootstrap truthfulness

- typed MCP bootstrap descriptors
- typed sandbox requested/supported/active reporting
- typed external coding-backend startup state

### Phase 3: Context discipline

- budgeted prompt assembly by source class
- source provenance and omission reporting
- shared compaction artifact contract

### Phase 4: Comparative leverage

- read-only compatibility harness
- benchmark reports for external coding runtimes and adapters

## Why This Is Worth Doing

Guardian does not need to copy a terminal-first coding product to benefit from its runtime packaging lessons.

The highest-value borrowings are the boring ones:

- tighter runtime seams
- typed bootstrap state
- richer manifest contracts
- reusable compaction and session artifacts
- evidence-driven comparative analysis

Those are exactly the kinds of changes that make Guardian easier to extend while staying aligned with [FORWARD-ARCHITECTURE.md](../architecture/FORWARD-ARCHITECTURE.md): composition roots stay thinner, shared orchestration stays central, and new features stop leaking across the same large files.
