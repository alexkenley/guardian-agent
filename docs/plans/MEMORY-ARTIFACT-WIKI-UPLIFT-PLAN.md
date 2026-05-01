# Memory Artifact and Operator Wiki Uplift Plan

**Status:** Proposed
**Date:** 2026-04-04
**Origin:** Post-uplift review of Guardian memory architecture compared against inspectable markdown-wiki knowledge-base patterns, with emphasis on preserving Guardian security layers and operator control
**Companion docs:** [MEMORY-SYSTEM-DESIGN.md](../design/MEMORY-SYSTEM-DESIGN.md), [Context, Memory, and Orchestration Uplift Plan](CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md), [ORCHESTRATION-DESIGN.md](../design/ORCHESTRATION-DESIGN.md), [TOOLS-CONTROL-PLANE-DESIGN.md](../design/TOOLS-CONTROL-PLANE-DESIGN.md), [FORWARD-ARCHITECTURE](../architecture/FORWARD-ARCHITECTURE.md)

## Objective

Add an inspectable, persistent, operator-visible knowledge-artifact layer on top of Guardian's existing trust-aware memory system without weakening the current security model.

The target state is a Guardian runtime that:

1. keeps the current scoped memory architecture and trust boundaries intact
2. surfaces all durable memory through a unified operator-facing Memory/Wiki experience
3. maintains derived indexes and wiki-style navigation pages without turning raw markdown into the source of truth
4. lets an authorized operator explicitly add, edit, promote, demote, or remove memory content through guarded product surfaces
5. keeps all operator edits persistent, attributable, reviewable, and audit-visible
6. treats memory hygiene, wiki refresh, and artifact linting as bounded orchestration work rather than invisible prompt work
7. avoids the failure mode of letting the model freely rewrite its own durable memory without controls
8. distinguishes clearly between surfaced memory, derived artifacts, review-only material, and directly editable operator-curated pages

## Why this uplift exists

Guardian's current memory direction is already stronger than ad hoc markdown-wiki setups on scope separation, trust, quarantine, and retrieval discipline. What it lacks is a first-class artifact layer that is:

- more inspectable in the web UI
- easier for operators to curate deliberately
- easier to navigate by topic/entity/decision/run
- better at linking saved outputs back into reusable knowledge
- explicit about what was model-derived, operator-authored, system-extracted, quarantined, or stale

This uplift is therefore about **operator-visible knowledge artifacts**, not about replacing the existing memory store with a free-form wiki vault.

## Planning Principles

- **Security remains primary.** Guardian's capability checks, approvals, trust/quarantine semantics, control-plane boundaries, and audit logging remain more important than edit convenience.
- **Canonical state stays structured.** The sidecar/index-backed memory store remains the source of truth. Markdown/wiki views are derived or mediated, not free-form authoritative state.
- **Operator editing is explicit and attributable.** User edits must be performed through dedicated control-plane paths with actor identity, timestamps, and change reason metadata.
- **No silent self-rewrite authority.** The assistant may propose edits or create bounded derived artifacts, but unrestricted autonomous durable-memory rewriting remains out of scope.
- **Derived artifacts must be bounded and refreshable.** Index pages, topic pages, and navigation summaries are maintained artifacts with clear refresh rules and provenance.
- **Editable does not mean untrusted by default.** Operator-authored content can be trusted according to existing local/trusted semantics, but all other sources retain provenance and quarantine handling.
- **Inspectability beats hidden cleverness.** If a page, index, summary, or lint finding affects retrieval, operators should be able to inspect why it exists.
- **Reference Guide and memory wiki stay distinct.** The Reference Guide remains product documentation; the memory wiki is runtime knowledge state.

## Current Baseline

| Area | Current state | Notes |
|---|---|---|
| Persistent scoped memory | Strong | Global and code-session memory already exist with trust-aware sidecar metadata and markdown views. |
| Prompt-time retrieval | Strong partial | Signal-aware selection and diagnostics exist, with metadata-first and non-blocking improvements already planned. |
| Background memory hygiene | Partial | Flush exists; richer extraction and consolidation are planned but not yet first-class maintenance lanes. |
| Operator inspectability | Weak partial | Markdown views exist on disk, but there is no first-class web UI for navigating, curating, and auditing memory artifacts. |
| Operator memory editing | Weak | Users can save memory through tools, but there is no structured wiki/editor surface for persistent manual curation. |
| Artifact linking | Weak partial | Automation output references exist, but broader knowledge links between memory, decisions, outputs, and sessions are limited. |
| Security boundary around edits | Strong partial | The underlying system is trust-aware, but dedicated editing surfaces and workflows still need explicit design. |

## Scope

This plan covers:

- surfacing all durable memory through a unified Memory/Wiki experience
- operator-visible memory artifact and wiki views
- derived topic/entity/decision/output indexes over existing memory scopes
- operator editing flows for curated memory content
- persistent storage and provenance for operator-authored additions/edits/removals
- linking automation outputs and other durable artifacts into memory navigation
- web UI additions for browsing, searching, editing, and auditing memory artifacts
- memory linting, stale-content detection, and duplicate/orphan detection
- security and approval rules for all memory artifact mutations

This plan does not cover:

- replacing Guardian's structured memory store with raw Obsidian-style file authority
- allowing filesystem tools to edit `~/.guardianagent/` memory files directly
- removing trust/quarantine distinctions for convenience
- granting the assistant autonomous permission to rewrite durable memory arbitrarily
- using memory wiki pages as a bypass around the Intent Gateway, approval flows, or tool control plane

## Proposed Target Model

Guardian keeps the current persistent memory scopes and adds a higher-level artifact layer with three classes of material.

All durable memory should be surfaced through the Memory/Wiki experience, but surfaced does not mean uniformly editable. The UI and retrieval model should distinguish between inspectable canonical entries, refreshable derived artifacts, operator-curated pages, and review-only quarantined material.

### 1. Canonical memory entries

The current structured entries in the signed sidecar/index remain authoritative.

Examples:
- user/operator-authored durable facts
- reviewed decisions
- context-flush summaries
- automation output references
- extracted summaries

### 2. Derived memory artifacts

These are runtime-maintained, inspectable views built from canonical entries.

Examples:
- topic index pages
- entity/concept pages
- active decisions page
- automation knowledge index
- session summary artifacts
- duplicate/stale/orphan lint reports

These artifacts are persistent, but explicitly marked as derived and refreshable.

### 3. Operator-curated wiki pages

These are explicit user-authored or operator-authored persistent knowledge pages that the runtime can retrieve alongside canonical memory.

Examples:
- "Things Guardian should always remember about this user"
- project-specific standing instructions
- high-value glossary/mental model pages
- approved hand-curated decision summaries
- curated runbooks or operator notes tied to a workspace or session

These pages must be first-class persisted records with provenance and review metadata, not arbitrary loose markdown files.

## Security Model Requirements

This section is load-bearing. The entire uplift must preserve Guardian's security layers.

### Security invariants

- memory mutations still flow through Guardian-controlled APIs/tools/services rather than direct filesystem editing
- `DeniedPathController` protections for `.guardianagent/` remain intact; the new UI must not create a backdoor around them
- trust status, provenance, review state, and quarantine semantics remain attached to both canonical entries and curated wiki pages
- assistant-authored durable mutations still require explicit user/operator intent or an approved bounded maintenance job
- derived artifacts cannot silently promote quarantined/unreviewed content into active prompt context
- operator edits are audit logged with actor, scope, before/after summary, and reason metadata
- retrieval diagnostics must expose whether a surfaced fact came from canonical memory, derived artifacts, or operator-curated wiki pages
- cross-scope rules remain explicit; a global-memory edit must not implicitly rewrite a code-session memory scope, or vice versa
- browser/web UI editing must follow the same approval, auth, and identity controls as other mutating control-plane actions
- brokered worker paths must preserve memory-scope and actor metadata so approvals and auditing remain correct across boundaries

### Editing permissions

Recommended policy:
- **read**: normal operator surfaces may browse surfaced durable memory they are authorized to view, including canonical entries, derived artifacts, linked output references, and operator-curated pages
- **curate**: trusted Slash Operator / web operator may add or edit operator-curated wiki pages and manually maintained summaries
- **review/promote/quarantine**: privileged operator action for changing trust/review state on non-operator-derived entries and for deciding whether a derived page should become curated editable content
- **delete/archive**: explicit operator action with confirmation and audit trail, preferably soft-delete/archive first
- **assistant propose only**: assistant can suggest edits, draft summary replacements, or prepare merge candidates, but should not self-apply durable wiki rewrites without explicit approval

## Web UI Recommendation

Yes — this uplift should add a dedicated web UI area.

The Reference Guide should remain product documentation. It should not be overloaded with live memory state.

### Recommended UI addition

Add a new sidebar page or major panel: **Memory**

The Memory page should surface **all durable memory**, not just operator-curated pages. The user should be able to browse the whole memory landscape from one place while the UI still respects source class and trust state when deciding what is editable.

Suggested tabs:

1. **Browse**
   - unified view over canonical entries, derived indexes, operator-curated pages, and linked durable outputs
   - topic/entity/decision/output indexes
   - scope switcher: global vs code-session
   - filters: active, operator-authored, system-extracted, derived, quarantined, stale

2. **Wiki**
   - wiki-style navigation over all surfaced memory classes
   - operator-curated pages editable in place when authorized
   - derived pages rendered as refreshable/read-only unless explicitly promoted into a curated page
   - explicit save/publish/archive actions
   - provenance and retrieval visibility per page

3. **Entries**
   - canonical memory entries
   - raw/structured entry inspector
   - trust, tags, summary, source type, timestamps
   - review-only handling for quarantined or unreviewed entries

4. **Lint / Hygiene**
   - duplicates
   - stale pages
   - orphan references
   - oversized/low-signal artifacts
   - broken links between artifacts

5. **Audit / Maintenance**
   - recent maintenance jobs
   - wiki refreshes
   - extraction/consolidation jobs
   - operator edit history
   - promotion/quarantine actions

This should be a dedicated runtime state surface, not folded into the Reference Guide.

## Slash Operator Editing Model

The user suggestion makes sense and should be part of the plan.

Guardian should support a persistent **Agent Memory Wiki** that an authorized Slash Operator can edit through dedicated product surfaces and tools.

Recommended behavior:
- Slash Operator can create curated pages and notes that the agent is allowed to retrieve later
- Slash Operator can correct or remove outdated operator-authored content
- Slash Operator can propose promotion or demotion of derived summaries
- Slash Operator can annotate why a page matters so prompt-time retrieval gets a better signal
- Slash Operator edits persist in the structured memory store with a rendered wiki view

Important constraint:
- Slash Operator should not be editing raw `.index.json` or underlying markdown files directly
- edits should go through a dedicated memory-control API or memory wiki tool layer

## Retrieval Model

Prompt-time retrieval should treat the new artifact layer as additive and bounded.

Preferred order:

1. canonical high-signal active entries
2. maintained summary/index artifacts
3. operator-curated wiki pages
4. full entry bodies or raw linked output only when needed

Retrieval rules:
- wiki/index artifacts are candidate signals, not unconditional prompt payload
- derived pages can improve routing and drilldown without replacing underlying provenance
- retrieval diagnostics should show when an answer relied on a wiki page versus a canonical entry
- low-signal or stale artifacts should be penalized or excluded
- quarantined content can appear in explicit inspection flows but not normal prompt context

## Artifact Types to Add

### Maintained indexes

- topic index
- entity/person/system/service index
- decision index
- automation result index
- project/workspace note index

### Curated operator pages

- user preferences and collaboration style
- standing project instructions
- glossaries and mental models
- incident or constraint summaries
- approved "remember this" pages

### Derived reports

- duplicate candidate report
- stale-content report
- orphaned artifact/reference report
- retrieval-coverage report
- compaction and summary drift report

## Phased Plan

## Phase 0: Security and Data Model Baseline

### Goal

Define the artifact model and edit boundaries before any UI or automation is added.

### Deliver

- canonical terminology for entries, derived artifacts, and operator-curated wiki pages
- storage/provenance schema updates for curated pages and derived artifacts
- edit permission model and audit requirements
- explicit no-bypass rules for filesystem access and direct memory-file mutation
- retrieval-source labeling model for diagnostics

### Likely files

- `src/runtime/agent-memory-store.ts`
- `src/tools/types.ts`
- `src/tools/executor.ts`
- `src/runtime/context-assembly.ts`
- memory-related types/tests
- relevant docs/specs

### Exit criteria

- the source of truth remains the structured store, not loose markdown
- every artifact class has explicit provenance and trust semantics
- edit and delete actions have an approved security model before UI work starts

## Phase 1: Persistent Artifact Layer and Storage Contracts

### Goal

Add durable storage support for derived artifacts and operator-curated wiki pages.

### Deliver

- persisted artifact record types for indexes, reports, and curated pages
- per-scope storage rules for global and code-session artifact material
- refresh metadata: last built, source set, staleness markers, content hash/version
- operator-authored page metadata: author, reason, tags, retrieval hints, review state
- archive/tombstone behavior instead of immediate destructive deletion where appropriate

### Likely files

- `src/runtime/agent-memory-store.ts`
- `src/runtime/code-sessions.ts`
- `src/runtime/conversation.ts`
- storage tests

### Exit criteria

- curated pages and derived artifacts persist across restarts
- scopes remain isolated correctly
- operator changes and maintenance refreshes are distinguishable in storage and audit

## Phase 2: Derived Wiki and Index Generation

### Goal

Build inspectable wiki/index artifacts over the existing memory system.

### Deliver

- topic index generation
- entity/concept page generation
- decisions and constraints page generation
- automation output knowledge index
- refresh strategy that uses summaries/metadata first and loads full bodies selectively
- explicit artifact labels such as `derived`, `operator_curated`, `system_extracted`

### Likely files

- `src/runtime/agent-memory-store.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/assistant-jobs.ts`
- retrieval/context tests

### Exit criteria

- operators can browse generated indexes without reading raw store files
- derived pages are refreshable and bounded
- derived artifacts do not duplicate large low-signal raw memory bodies

## Phase 3: Operator-Curated Memory Wiki

### Goal

Let trusted operators add and edit persistent memory intentionally.

### Deliver

- dedicated APIs/tools for curated page create/read/update/archive
- save flow with actor identity, reason, timestamps, and scope
- optional structured templates for preferences, standing instructions, glossary terms, and project notes
- retrieval hints per page to improve matching without bloating prompts
- safe merge/replace flow for assistant-proposed wiki edits that require operator approval

### Likely files

- `src/tools/executor.ts`
- `src/runtime/agent-memory-store.ts`
- `src/index.ts`
- control-plane handlers/routes
- tool and API tests

### Exit criteria

- Slash Operator can add, edit, archive, and inspect curated pages
- edits persist durably and show clear provenance
- assistant-proposed edits never self-apply without explicit authorization

## Phase 4: Web UI Memory Surface

### Goal

Expose the artifact and wiki layer through a first-class operator UI.

### Deliver

- new **Memory** page/panel in the web app
- Browse, Wiki, Entries, Lint/Hygiene, and Audit/Maintenance tabs
- scope switcher, filters, diff views, and provenance/trust badges
- editor for operator-curated wiki pages
- read-only rendering for derived artifacts and quarantined material unless elevated review mode is used

### Likely files

- `web/public/index.html`
- `web/public/js/app.js`
- `web/public/js/pages/` new memory page module
- web server/API wiring in `src/channels/web.ts`
- `src/reference-guide.ts`

### Exit criteria

- memory state is inspectable from the web UI without filesystem access
- operators can curate pages in-product
- trust state and source class are visible in the UI

## Phase 5: Memory Linting and Hygiene Reports

### Goal

Make knowledge quality issues visible and repairable.

### Deliver

- duplicate memory detection
- stale artifact detection
- orphan-link detection
- low-signal/oversized artifact detection
- inconsistent summary/report detection
- lint findings surfaced both in UI and maintenance timeline

### Likely files

- `src/runtime/assistant-jobs.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/agent-memory-store.ts`
- UI surfaces and tests

### Exit criteria

- operators can see concrete hygiene issues
- linting never auto-destroys content silently
- maintenance recommendations are explicit and auditable

## Phase 6: Retrieval and Prompt Integration

### Goal

Use the artifact layer to improve retrieval without raising prompt weight or trust risk.

### Deliver

- summary/index-first retrieval policy incorporating curated wiki pages
- source-aware ranking weights for canonical entries vs derived artifacts vs curated pages
- stronger diagnostics for why an artifact won context
- bounded fallback behavior when artifact refresh is stale or unavailable
- compatibility with the existing context-memory-orchestration uplift work

### Likely files

- `src/runtime/context-assembly.ts`
- `src/chat-agent.ts`
- `src/runtime/agent-memory-store.ts`
- retrieval tests and harnesses

### Exit criteria

- prompt-time retrieval can benefit from the artifact layer without defaulting to larger prompts
- diagnostics identify source class and win reasons clearly
- stale or quarantined artifacts do not silently pollute normal context

## Phase 7: Maintenance Lane and Audit Visibility

### Goal

Run artifact refresh and hygiene as explicit orchestration jobs.

### Deliver

- bounded wiki/index refresh jobs
- bounded lint/consolidation jobs
- idempotency and locking rules
- timeline and audit surfaces for all maintenance runs
- failure handling that degrades safely and preserves prior valid artifacts

### Likely files

- `src/runtime/orchestrator.ts`
- `src/runtime/assistant-jobs.ts`
- `src/runtime/conversation.ts`
- operator timeline surfaces

### Exit criteria

- memory artifact maintenance is observable and bounded
- failures do not corrupt canonical memory or wipe operator pages
- operators can see what changed and why

## Phase 8: Rollout Guardrails and Verification

### Goal

Ship incrementally with clear safety and quality gates.

### Deliver

- feature flags or staged enablement for artifact retrieval, wiki editing, and lint maintenance
- regression tests for scope isolation, trust handling, audit logging, and UI editing
- integration harness coverage for operator edit flows and retrieval behavior
- documentation updates for operator workflows and security model

### Likely files

- harness scripts under `scripts/`
- `src/reference-guide.ts`
- docs/design/guides as needed
- test files across runtime/tools/web

### Exit criteria

- no regression in trust/quarantine or scope isolation
- operator edit flows are tested end-to-end
- rollout can be enabled safely in phases rather than all at once

## Recommended Sequence

1. Phase 0 first. Do not add editing until the security and provenance contract is explicit.
2. Phase 1 next. Storage/persistence must exist before UI or retrieval depends on the new artifact layer.
3. Phase 2 before broad editing. Derived indexes give immediate inspectability and help shape the UI/data model.
4. Phase 3 and Phase 4 together or back-to-back. Editing and UI should land with one coherent operator workflow.
5. Phase 5 after the first artifact layer exists. Linting without artifacts is premature.
6. Phase 6 after artifact semantics are stable. Retrieval should consume a mature model, not a moving target.
7. Phase 7 and Phase 8 throughout, but formalize them before rollout.

## Verification Expectations

- unit coverage for new artifact schemas, provenance, scope isolation, and retrieval ranking
- security tests proving no direct filesystem bypass of memory authority is introduced
- audit-log verification for create/edit/archive/promote/quarantine actions
- web UI tests for browse, edit, archive, diff, and filter flows
- integration tests for Slash Operator edit persistence and subsequent retrieval
- maintenance job tests for bounded refresh/lint behavior and failure handling
- `npm run build`
- relevant harness scripts for web UI, coding assistant, and memory-related flows

## Product Recommendation Summary

### Should there be an additional web UI panel?

Yes. Add a dedicated **Memory** page/panel rather than merging this into the Reference Guide.

### Should all memory be surfaced in the wiki experience?

Yes. All durable memory should be surfaced through the unified Memory/Wiki experience, with clear distinctions between canonical entries, derived artifacts, operator-curated pages, linked outputs, and review-only quarantined material.

### Should there be an agent memory wiki editable by the user Slash Operator?

Yes, but as a **guarded operator-curated layer** over the existing structured memory system, not as unrestricted direct file editing. Surfaced does not mean universally editable.

### Should it persist?

Yes. Curated wiki pages, derived artifacts, review state, and audit metadata should all persist through the existing durable memory/control-plane architecture.

## Relationship to Existing Plans

This plan builds on, rather than replaces, the current memory uplift direction.

It should be treated as the artifact-layer and operator-curation companion to:

- [Context, Memory, and Orchestration Uplift Plan](CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md)
- [Memory System Uplift Plan](MEMORY-SYSTEM-UPLIFT-PLAN.md)
- [Background Delegation Uplift Plan](BACKGROUND-DELEGATION-UPLIFT-PLAN.md)

Those plans define the underlying memory/runtime direction. This document adds the missing operator-facing, inspectable, persistent knowledge-artifact and curated-wiki layer while preserving Guardian's security model.
