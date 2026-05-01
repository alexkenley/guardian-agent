# Skills Progressive Disclosure Uplift Plan

**Status:** Implemented (core phases delivered; deferred phase 6 items remain intentionally deferred)  
**Date:** 2026-04-04  
**Origin:** Follow-on plan from `docs/research/GOOGLE-ADK-SKILLS-COMPARISON-2026-04-04.md`, revised after alignment with the Context/Memory/Orchestration uplift and the Memory Artifact/Wiki uplift  
**Primary specs impacted:** `docs/design/SKILLS-DESIGN.md`, `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`, `docs/design/ORCHESTRATION-DESIGN.md`, `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`  
**Companion specs/plans:** `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md`, `docs/plans/CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md`, `docs/plans/MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md`, `docs/plans/ASSISTANT-CAPABILITY-UPLIFT-ROADMAP.md`

---

## Goal

Improve Guardian's skills system so it is more efficient, more selective, and more useful to weaker local models **without** introducing a second routing system, a second orchestration stack, or unnecessary control-plane surface area.

The target outcome is:

1. lower prompt weight for skill usage
2. better skill activation accuracy from existing structured runtime signals
3. bounded progressive disclosure of skill material
4. stronger observability into what skill material actually influenced a request
5. clean interoperability with the new memory artifact/wiki layer without collapsing skills and memory into one thing

---

## Why this revision exists

The earlier version of this plan was intentionally exploratory. Since then, the surrounding architecture has become clearer:

- the **Context, Memory, and Orchestration Uplift Plan** already establishes compact inventory + explicit drilldown, maintained artifacts, metadata-first retrieval, and prompt-footprint discipline
- the **Tools Control Plane Spec** already warns against solving discovery problems by expanding the always-loaded surface
- the **Orchestration Spec** is explicit that top-level routing, blocked-work handling, and continuity are shared runtime responsibilities, not ad hoc prompt behaviors
- the **Memory Artifact/Wiki Uplift Plan** now gives Guardian a durable artifact layer with provenance, retrieval hints, and bounded retrieval semantics

That means the skills plan should now be narrower and more opinionated.

The right direction is not "add more skill features." The right direction is:

- use the new shared runtime signals better
- make skill drilldown cheaper and more explicit
- avoid duplicating what the memory and context uplifts already own

---

## Executive recommendation

### What is justified now

The justified skills uplifts are the ones that clearly do one or more of the following:

- improve **local-model performance or reliability**
- improve **skill-selection intelligence** by reusing structured runtime state that already exists
- improve **debuggability/observability** with low added risk
- reduce prompt churn and unnecessary bundle reads

### What is not justified now

The following do **not** currently justify the added complexity or risk:

- autonomous skill self-generation or self-enablement
- a separate skill planner or skill-specific orchestration lane
- broad new model-facing skill tools if they increase prompt size more than they help
- deep skills-memory convergence
- large reporting/dashboard work before backend semantics stabilize

### Solid direction

Implement in this order:

1. **canonical compact skill catalog aligned with context assembly**
2. **gateway-aware skill resolution**
3. **runtime-owned bounded skill drilldown and request-local caching**
4. **progressive disclosure telemetry and enforcement**
5. **narrow memory-artifact integration through reviewed pointers and retrieval hints**
6. **defer proposal/import workflow and dashboards until later**

This is the lowest-risk path that still meaningfully improves intelligence and local-model behavior.

---

## Alignment with existing uplifts

## 1. Context/Memory/Orchestration uplift

The skills uplift should explicitly build on the already-published shared direction:

- **compact inventory + explicit drilldown**
- **maintained artifacts over repeated summarization**
- **metadata-first candidate selection**
- **shared orchestration visibility**
- **prompt-footprint discipline**

For skills, that means:

- one canonical compact skill catalog in prompt assembly
- bounded drilldown only for winning skills/resources
- no duplicate skill catalogs in multiple prompt sections
- request-local reuse instead of repeated bundle rereads

## 2. Tools control plane

The tool control plane already warns against expanding the always-loaded tool surface just to work around discoverability issues.

That principle applies here too.

**Implication:** wave 1 should **not** add multiple always-loaded skill tools. If skills need a cleaner drilldown lane, the first implementation should prefer a runtime-owned loader rather than a new large model-facing tool surface.

## 3. Orchestration

The Orchestration Spec already assigns ownership:

- Intent Gateway owns top-level turn interpretation
- Pending Action orchestration owns blocked-work state
- continuity/context assembly owns bounded cross-surface state

**Implication:** skills should consume those outputs as ranking signals. They should not create a new routing tier or pre-gateway interception path.

## 4. Memory artifact/wiki uplift

The memory uplift now defines:

- canonical entries
- derived artifacts
- operator-curated wiki pages
- retrieval-source labeling
- retrieval hints
- bounded retrieval order

**Implication:** skills can reference that artifact layer, but should not absorb it.

The correct relationship is:

- skills may point to reviewed knowledge artifacts
- memory artifacts may improve skill selection through hints
- neither replaces the other as the source of truth

---

## Current baseline

Guardian already has a strong skills foundation:

- local skill bundles under `skills/<skill-id>/`
- `SKILL.md` plus `references/`, `templates/`, `scripts/`, `assets/`, `examples/`
- activation through `SkillRegistry` and `SkillResolver`
- compact active-skill catalog injection in prompt context
- clear separation between skills and execution authority
- telemetry for skill resolution, prompt injection, bundle reads, and tool use while skills are active

This means the next wave should be an uplift, not a redesign.

---

## Core problems to solve

### 1. Skill activation underuses Guardian's strongest signals

`SkillResolver` currently relies mostly on mentions, triggers, descriptions, and applicability metadata.

Guardian already has stronger information available:

- Intent Gateway route
- gateway entities
- turn relation
- blocker kind
- continuity summary
- coding-session attachment and repo-local context

Not using these signals leaves accuracy on the table.

### 2. Skill drilldown is still too file-mechanical

Today the model often reaches skill content via bundle-path `fs_read` behavior.

That creates avoidable problems:

- weaker local models spend effort on path mechanics
- L1/L2/L3 loading is harder to trace
- repeated reads are harder to normalize and cache
- bundle-boundary enforcement is less semantic than it should be

### 3. Progressive disclosure is more convention than contract

The current skills model already points in the right direction, but the runtime should make progressive disclosure:

- bounded
- measurable
- cache-aware
- explainable in traces/diagnostics

### 4. Skills need to benefit from the artifact/wiki uplift without becoming memory

Now that the memory artifact/wiki work is real, the skills layer needs an explicit interoperability rule so these systems do not drift into overlap.

---

## Design principles

### 1. Keep the Intent Gateway authoritative

Skills must stay downstream of structured routing. No pre-gateway skill interception. No skill-driven top-level routing.

### 2. Keep skills advisory-only

Skills remain reusable process/domain guidance. They do not gain direct execution authority, new capabilities, or silent control-plane mutation powers.

### 3. Prefer runtime-owned drilldown over new model-facing tools in wave 1

For local-model performance, the cheapest solution is often the one that adds the least new tool surface.

A runtime-owned bounded loader:

- avoids prompt growth from extra tool schemas
- removes some tool-selection burden from weaker models
- still allows explicit diagnostics if instrumented properly

### 4. Reuse compact-inventory-plus-drilldown as a pattern, not necessarily as a new tool

The skill system should adopt the same **shape** as deferred tools:

- compact catalog first
- bounded drilldown only when needed

But it does **not** need to become part of ToolExecutor in the first wave.

### 5. Do not merge skills and memory

- **skills** = reusable procedural/domain guidance
- **memory/artifacts** = durable facts, decisions, summaries, curated references, and derived indexes

They may reference each other, but they should not collapse into a shared mutable substrate.

### 6. Favor evidence-backed additions

If a proposed change does not improve local-model behavior, selection quality, or observability in a measurable way, it should probably stay out of the first implementation wave.

---

## Proposed target model

Guardian should formalize a three-level skills contract.

### L1: compact skill catalog

Always available in bounded form when skills are enabled.

Contains:

- `skillId`
- name
- short trigger-oriented description
- role (`process` / `domain`)
- compact hint fields only when they materially help ranking, such as major intents, tool categories, or domains

This should be the **one canonical skill catalog** in prompt assembly.

### L2: bounded skill instructions

Loaded only for selected skills.

Contains:

- a bounded rendering of `SKILL.md`
- optionally section-aware excerpts later, but not required for the first wave

### L3: bounded skill resources

Loaded only when directly relevant.

Contains:

- individual references
- templates
- examples
- assets metadata
- scripts metadata or reviewed helper entrypoint metadata

The assistant should not dump an entire bundle into context.

---

## Solid implementation direction

## 1. Make the compact skill catalog canonical

This is the first thing to fix because it aligns directly with the broader context-assembly uplift.

### Recommendation

- keep **one** compact skill catalog in prompt assembly
- remove overlapping or duplicated skill catalog shaping across callers
- make catalog ordering stable within a request unless resolver inputs actually change

### Why this matters

- lower prompt churn
- cleaner local-model grounding
- better traceability
- direct alignment with `CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md`

---

## 2. Upgrade `SkillResolver` to use structured runtime signals

This is the best cost-to-value skills improvement.

### Recommended new resolver inputs

- Intent Gateway `route`
- Intent Gateway `entities`
- `turnRelation`
- `resolution`
- pending-action blocker kind
- continuity summary focus / last actionable request
- coding-session attachment state
- selected provider locality when helpful for tie-breaking, not as the primary signal

### Example effects

- `security_task` strongly boosts security/domain skills
- `coding_task` plus debugging-shaped entities boosts `systematic-debugging` and `verification-before-completion`
- clarification-answer turns suppress unnecessary skill churn
- approval resumes prefer preserving prior relevant skills when the task has not changed
- coding-session routes can bias process skills that improve repo-grounded workflows

### Guardrail

This is a ranking improvement inside the skills layer only. It must not become a second router.

---

## 3. Add a runtime-owned bounded skill drilldown lane

This is the major architectural change, but it should stay narrow.

### Recommendation

For wave 1, **do not** introduce multiple new model-facing skill tools.

Instead, add a runtime-owned loader that:

- reads bounded L2 instructions for selected skills
- reads bounded L3 resources only when selected instructions or resolver hints justify them
- enforces bundle-boundary rules semantically
- records what was loaded and why
- supports request-local cache reuse

### Why this is the solid direction

Compared with a new `skill_read` tool in wave 1, this is:

- lower prompt overhead
- lower control-plane complexity
- better for weaker local models that struggle with unnecessary tool-choice burden
- easier to align with shared context assembly and catalog stability work

### Important constraint

This loader must be **visible** in diagnostics. It cannot become hidden prompt magic.

At minimum, traces/metadata should show:

- selected skill ids
- whether L2 instructions were loaded
- whether L3 resources were loaded
- why the loader chose them
- cache hits/misses

### Decision

For this implementation plan, skill drilldown stays runtime-owned. A model-facing skill drilldown tool is out of scope for this plan and should not be introduced during this uplift.

---

## 4. Add request-local caching and preindexed bundle metadata

This is a performance-oriented uplift with modest risk.

### Recommendation

At registry/load time, precompute cheap bundle metadata such as:

- available resource types
- stable resource inventory
- headings or section markers from `SKILL.md`
- compact bundle stats useful for bounded loading

During one request/tool loop:

- cache L2 and L3 loads
- reuse them if the same material is needed again
- expose cache hits in trace metadata

### Why this helps

- fewer redundant disk reads
- cleaner bounded loading
- better local-model latency and stability
- easier reasoning about what was injected

### Guardrail

Start request-local only. Do not add a more complicated persistent skill cache in the first wave.

---

## 5. Make progressive disclosure enforceable

Guardian should move from guidance to contract.

### Contract rules

- L1 catalog is compact and bounded
- only a small number of L2 loads happen per request by default
- L3 loads are specific, not bulk bundle dumps
- repeated loads reuse request-local cache when possible
- traces/metadata record what entered context

### Suggested initial limits

Start small and tune later:

- up to 2 L2 loads per request by default
- up to 2 L3 loads before the next reasoning boundary
- char/token caps per loaded artifact

These limits should be validated against representative local-model tasks before expansion.

---

## 6. Integrate with the memory artifact/wiki layer narrowly and explicitly

Now that the memory artifact/wiki uplift is materially real, the skills plan should stop treating this as hypothetical. But the integration still needs to stay narrow.

### Recommended first integration

Allow skills to reference reviewed artifact-layer material through explicit pointers, for example:

- operator-curated wiki pages
- approved glossary/mental model pages
- approved standing instruction pages
- selected derived indexes only when they are explicitly marked as skill-usable references

### Rules

- pointers must preserve provenance and source class
- normal prompt-time retrieval order for memory artifacts remains owned by the memory/context system
- skills should not perform generic search over all memory artifacts as part of ordinary activation
- derived or curated pages do not become executable skill bodies
- quarantined or stale artifacts must not silently become skill context

### Why this is now justified

The memory uplift explicitly adds retrieval hints, source-aware ranking, and durable operator-curated pages. Skills can benefit from that work without redefining it.

### Dependency boundary

This phase depends on the memory artifact backend contracts and retrieval semantics being stable enough. It should not wait for every last UI polish item, but it should wait for the provenance and retrieval model to be settled.

---

## What should stay deferred

## 1. Reviewed skill proposal/import workflow

Potentially valuable, but still higher risk and broader in scope than the core performance/relevance work.

Why defer:

- operator workflow complexity
- review/eval/import semantics
- enablement lifecycle
- not required for local-model performance wins

## 2. Skill dashboards and under-triggering reports

Useful only after the runtime semantics are stable and telemetry exists.

Why defer:

- easy to build noisy dashboards on unstable definitions
- not needed to land the core intelligence/performance uplift

## 3. Deep skills-memory convergence

Do not pursue this as an active workstream.

Why defer:

- blurs boundaries the memory uplift worked hard to make explicit
- increases security and retrieval complexity
- does not clearly outperform narrow reviewed-pointer integration

## 4. Broad model-facing skill tools

Do not start here.

Why defer:

- increases prompt surface
- increases model choice burden
- adds tool/control-plane complexity before we know it is necessary

---

## Risk / benefit analysis

## Candidate A: canonical compact catalog + stable shaping

### Benefit

High.

- direct prompt-footprint improvement
- lower churn
- aligns with existing shared uplift direction

### Risk

Low.

### Recommendation

**Do it first.**

---

## Candidate B: gateway-aware skill resolution

### Benefit

High.

- reuses strong existing signals
- improves relevance without expanding prompt size
- makes the agent more intelligent in a focused way

### Risk

Low to moderate.

### Recommendation

**Do it early.** This is one of the strongest uplifts in the whole plan.

---

## Candidate C: runtime-owned skill drilldown lane

### Benefit

High.

- improves local-model behavior
- reduces file-mechanical reasoning
- avoids extra always-loaded tool surface
- gives a cleaner place for caching and instrumentation

### Risk

Moderate but bounded.

- touches context assembly / skills runtime behavior
- must stay observable to avoid hidden prompt magic

### Recommendation

**Do it after the catalog and resolver work.** This is the main performance-oriented uplift.

---

## Candidate D: request-local caching and bundle preindexing

### Benefit

Medium to high.

- lowers redundant reads
- supports local-model performance and latency
- low architectural risk

### Risk

Low.

### Recommendation

**Do it together with the drilldown lane.**

---

## Candidate E: telemetry and limits

### Benefit

Medium to high.

- keeps the new behavior bounded
- enables evidence-based tuning
- prevents prompt bloat drift

### Risk

Low.

### Recommendation

**Do it in the same wave or immediately after drilldown.**

---

## Candidate F: memory artifact pointer integration

### Benefit

Medium.

- useful leverage from the new artifact/wiki system
- improves quality for curated knowledge areas

### Risk

Moderate if done too early.

### Recommendation

**Do it after the backend artifact semantics settle, but before any deep skills-memory ideas are considered.**

---

## Phased implementation plan

## Phase 0: Contract and alignment baseline

### Goal

Lock the skills contract to the surrounding architecture before adding new behavior.

### Deliver

- update `docs/design/SKILLS-DESIGN.md` to define the canonical L1/L2/L3 contract more explicitly
- align the skills plan with the published context/memory/orchestration and memory-artifact contracts
- define success metrics focused on local-model performance and selection quality
- define diagnostics/metadata fields for selected skills and loaded material

### Exit criteria

- there is one explicit skills contract
- no ambiguity about whether skills are becoming a second tool plane or a runtime retrieval layer
- metrics exist before runtime behavior expands

---

## Phase 1: Canonical compact catalog and stable shaping

### Goal

Make skill availability compact, canonical, and stable.

### Deliver

- one canonical compact skill catalog in shared context assembly
- stable ordering/shaping within a request unless resolver inputs change
- removal of overlapping or duplicate skill catalog sections
- compact hint fields only where they materially improve selection

### Likely files

- `src/skills/prompt.ts`
- `src/runtime/context-assembly.ts`
- `src/index.ts`
- worker-side prompt assembly as needed
- prompt tests/spec docs

### Exit criteria

- skill availability appears once in a compact canonical form
- adjacent rounds do not churn skill catalog shape without cause
- prompt-footprint diagnostics can show the catalog section clearly

---

## Phase 2: Gateway-aware skill resolution

### Goal

Improve skill activation accuracy using structured runtime signals.

### Deliver

- resolver input expansion for route, entities, turn relation, blocker kind, and continuity summary
- deterministic ranking and tie-breaking
- diagnostics explaining why a skill was selected or suppressed
- stable preservation behavior across clarification/approval resume turns

### Likely files

- `src/skills/resolver.ts`
- `src/runtime/intent-gateway.ts`
- `src/runtime/context-assembly.ts`
- `src/index.ts`
- relevant tests/docs

### Exit criteria

- selected skills align better with route/task type
- clarification and resume turns do not churn unrelated skills unnecessarily
- selection reasons are inspectable

---

## Phase 3: Runtime-owned bounded skill drilldown and caching

### Goal

Replace most raw bundle-path skill reads with a bounded semantic loader.

### Deliver

- runtime-owned L2/L3 loading path for selected skills
- request-local cache for repeated skill material loads
- bundle metadata preindexing sufficient for bounded drilldown
- no change to execution authority or approval boundaries

### Likely files

- `src/skills/registry.ts`
- `src/skills/resolver.ts`
- `src/skills/types.ts`
- `src/skills/prompt.ts`
- `src/index.ts`
- possibly helper modules under `src/skills/`
- relevant tests/docs

### Guardrails

- no multiple always-loaded model-facing skill tools in wave 1
- no unrestricted directory traversal inside bundles
- all loading remains bounded to registered bundle contents

### Exit criteria

- common skill usage no longer relies primarily on raw bundle-path `fs_read`
- traces show L2/L3 loads and cache reuse
- local-model behavior is same-or-better on representative skill-heavy tasks

---

## Phase 4: Progressive disclosure enforcement and observability

### Goal

Make skill loading bounded, measurable, and tunable.

### Deliver

- explicit L1/L2/L3 classification in metadata/traces
- bounded per-request load limits
- char/token caps for loaded skill material
- cache hit/miss telemetry
- diagnostics for under-loading and over-loading during debugging

### Likely files

- `src/skills/prompt.ts`
- `src/runtime/context-assembly.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/run-timeline.ts`
- analytics/tests as needed

### Exit criteria

- progressive disclosure is enforceable, not just prompt advice
- operators/developers can inspect what skill material influenced context
- prompt weight stays bounded in multi-skill requests

---

## Phase 5: Narrow memory artifact integration

### Goal

Let skills benefit from the new artifact/wiki layer without blurring ownership boundaries.

### Deliver

- reviewed pointers from skills to curated/operator-visible artifact pages
- provenance/source-class display in diagnostics when an artifact-backed reference is used
- limited use of retrieval hints for choosing between overlapping skills
- explicit exclusion of quarantined/stale artifact content from normal skill context

### Dependencies

This phase should follow stable backend delivery of the artifact-layer provenance and retrieval semantics from `MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md`. Final UI polish is not the blocker; backend semantics are.

### Exit criteria

- skills can use curated artifact references safely
- memory retrieval and skill activation remain separate concerns
- provenance remains explicit end to end

---

## Phase 6: Deferred enhancements

These should not block the first five phases.

### Deferred candidate A: reviewed skill proposal/import workflow

Safe version of the skill-factory idea:

- assistant drafts a candidate skill bundle
- operator reviews it
- evals run
- explicit enable/import follows

### Deferred candidate B: skill quality dashboards

Only after telemetry stabilizes.

Possible metrics:

- under-triggered skills
- over-read skills
- dead reference trees
- imported skill activation quality

### Deferred candidate C: richer structured `SKILL.md` section semantics

Useful later, not required for the first solid wave.

---

## Recommended sequence

1. **Phase 0** first — lock the contract and dependencies.
2. **Phase 1** next — canonical compact catalog and stable shaping.
3. **Phase 2** next — gateway-aware resolver.
4. **Phase 3** next — runtime-owned drilldown plus caching.
5. **Phase 4** immediately after — enforce bounds and add diagnostics.
6. **Phase 5** after the artifact backend semantics are stable enough to integrate cleanly.
7. **Phase 6** only after the core behavior is proven.

---

## Verification expectations

Minimum verification should include:

- unit tests for resolver ranking changes
- unit tests for catalog stability and prompt-footprint budgets
- unit tests for bounded skill loading and bundle-boundary enforcement
- tests for request-local cache behavior
- integration tests for local-model skill-heavy workflows
- regression tests proving the Intent Gateway remains authoritative
- documentation updates in `SKILLS-DESIGN.md` and any affected context/orchestration specs

Recommended manual/harness validation:

- skill-heavy coding/debugging workflow on a local model
- security/domain workflow with route-aware activation
- clarification/resume workflow where active skills should remain stable
- multi-skill request where prompt bloat would previously have been likely
- artifact-backed skill reference workflow once phase 5 begins

---

## Final recommendation

The solid direction is now clearer than before:

- **yes** to a canonical compact skill catalog
- **yes** to gateway-aware skill selection
- **yes** to runtime-owned bounded skill drilldown and request-local caching
- **yes** to progressive disclosure telemetry and limits
- **yes** to narrow reviewed-pointer integration with the memory artifact/wiki layer
- **no** to model-facing skill drilldown tools in this implementation plan
- **not yet** to autonomous skill factories or deep skills-memory convergence

If a proposed skills uplift does not improve local-model performance, skill-selection quality, or bounded observability, it should stay out of the first implementation wave.
