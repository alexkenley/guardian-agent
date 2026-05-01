# Proposal: Research Capability

**Status:** Draft
**Date:** 2026-04-11
**Inspired by:** [getcompanion-ai/feynman](https://github.com/getcompanion-ai/feynman)
**Related:**
- [Capability Authoring Guide](../guides/CAPABILITY-AUTHORING-GUIDE.md)
- [Tools Control Plane Spec](../design/TOOLS-CONTROL-PLANE-DESIGN.md)
- [Native Skills Specification](../design/SKILLS-DESIGN.md)
- [Orchestration Specification](../design/ORCHESTRATION-DESIGN.md)
- [Agent Orchestration Recipes Spec](../archive/design/AGENT-ORCHESTRATION-RECIPES-DESIGN.md)
- [WebUI Design Spec](../design/WEBUI-DESIGN.md)
- [Evidence-Grounded Playbooks Spec](../archive/design/EVIDENCE-GROUNDED-PLAYBOOKS-DESIGN.md)
- [Memory Artifact and Operator Wiki Uplift Plan](../plans/MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md)
- [Skills Progressive Disclosure Uplift Plan](../archive/plans/SKILLS-PROGRESSIVE-DISCLOSURE-UPLIFT-PLAN.md)
- [Runtime Intelligence Uplifts Proposal](./RUNTIME-INTELLIGENCE-UPLIFTS-PROPOSAL.md)
- [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts)
- [src/agent/recipes.ts](../../src/agent/recipes.ts)
- [src/runtime/connectors.ts](../../src/runtime/connectors.ts)
- [src/runtime/agent-memory-store.ts](../../src/runtime/agent-memory-store.ts)
- [src/runtime/automation-output-store.ts](../../src/runtime/automation-output-store.ts)

---

## Executive Summary

Guardian should add a first-class **Research** capability inspired by the strongest product ideas in Feynman, while deliberately avoiding the parts of Feynman that would weaken Guardian's architecture.

The right lesson from Feynman is not:

- switch Guardian to Pi
- make file-based markdown the source of truth
- add a second runtime
- bury product behavior inside prompt files alone

The right lesson is:

- package research work as a clear user-facing capability
- give that capability a durable artifact model
- use explicit role-separated workflows for evidence collection, drafting, verification, and review
- make outputs browsable and resumable
- make research feel like a product area, not just "chat plus web_search"

This proposal recommends a Guardian-native **Research capability** with:

1. a dedicated `research_task` route beneath the Intent Gateway
2. bounded research orchestration built on existing recipes and shared runtime controls
3. a Guardian artifact model for plans, evidence bundles, drafts, verified briefs, and provenance
4. research-specific skills and templates that remain advisory-only
5. a future first-class **Research** page in the left nav if, and only if, the capability is accepted as a real product domain rather than a glorified prompt preset

The strongest recommendation in this document is:

**Yes, Research should probably become its own left-nav panel, but only if Guardian commits to it as a first-class domain with canonical ownership, durable artifacts, and bounded runtime semantics.**

If it remains only a chat mode or a handful of prompt templates, it should not become a top-level page.

---

## Problem

Guardian already has many of the ingredients needed for research work:

- `web_search` and `web_fetch`
- document search and memory retrieval
- browser tooling
- multi-agent recipes
- evidence-grounded instruction steps
- durable artifact and memory infrastructure
- long-running job, run history, and automation support

What it does not yet have is a coherent **research-shaped product surface**.

Today, broad research work in Guardian risks collapsing into one of four unsatisfying modes:

1. ordinary chat with ad hoc tool use
2. narrow `search_task` behavior that is good for finding an answer, but not for producing a durable research artifact
3. generic automation flows that are too mechanical for adaptive evidence gathering
4. hidden multi-step orchestration with weak user-facing structure and weak artifact discipline

That leaves a product gap:

- no canonical "Research" capability
- no durable research artifact lifecycle
- no obvious place in the UI to resume or inspect research work
- no strong boundary between ordinary search and deep research
- no first-class user story for "investigate this thoroughly and give me a verified brief"

Feynman solves this product problem well, even though Guardian remains the stronger runtime.

---

## What To Borrow From Feynman

Feynman is useful as a reference because it packages research work clearly.

The borrowable ideas are:

### 1. Research as a product, not just a prompt

Feynman treats deep research, literature review, comparison, review, and watch workflows as product-level capabilities with clear entry points.

Guardian should do the same.

### 2. Durable research artifacts

Feynman is disciplined about:

- a plan artifact
- evidence-gathering outputs
- a draft
- a verification pass
- a final deliverable
- provenance metadata

Guardian should adopt that lifecycle, but back it with its own stronger artifact and memory model.

### 3. Role-separated workflow stages

Feynman's strongest behavioral pattern is the separation of:

- researcher
- writer
- verifier
- reviewer

Guardian already has the orchestration substrate for this. It should package it as a first-class capability instead of leaving it as an internal architectural possibility.

### 4. Workflow discovery and artifact browsing

Feynman makes workflows and outputs feel discoverable.

Guardian should provide:

- an obvious research entry point
- clear workflow choices
- a place to browse research runs and artifacts

### 5. Verification and honesty discipline

Feynman consistently pushes:

- evidence over fluency
- explicit uncertainty
- verification before polished certainty

Guardian should adopt this as a research capability contract, not merely as optional good behavior.

---

## What Not To Borrow

Guardian should explicitly avoid the weaker parts of the Feynman model.

### 1. Do not make markdown files the canonical source of truth

Guardian's memory and artifact systems already have stronger provenance, trust, and lifecycle semantics.

Research artifacts may render to Markdown, but canonical research state should remain structured and runtime-owned.

### 2. Do not create a second execution plane

The Research capability should not bypass:

- Intent Gateway routing
- ToolExecutor
- approvals
- audit
- trust and taint handling
- shared pending-action orchestration

### 3. Do not mistake skills for authority

Research skills should remain advisory-only. They should not become a backdoor for tool execution or capability expansion.

### 4. Do not create an always-loaded research tool sprawl

Per the Tools Control Plane design, research should prefer:

- existing tools
- compact inventory plus drilldown
- a bounded research lane

It should not solve discovery problems by promoting a giant research tool set into the always-loaded surface.

### 5. Do not create a nav page before the domain exists

If Research does not own real state, real artifacts, and real workflows, a left-nav page would be empty product theater.

---

## Proposal

Guardian should add a first-class **Research capability** with five layers.

### Layer 1: Direct route

Add a dedicated `research_task` route through the Intent Gateway.

This route is justified because deep research is not the same thing as ordinary search:

- `search_task` is usually answer-oriented and narrow
- `research_task` is artifact-oriented, iterative, and verification-aware

The route should cover requests such as:

- "research this deeply"
- "do a literature review"
- "compare these sources and give me a brief"
- "audit these claims against public sources"
- "watch this topic over time"

This route should remain gateway-first and should not be implemented by pre-gateway heuristics.

### Layer 2: Research orchestration lane

Under the gateway, Guardian should add a bounded research lane built on existing orchestration primitives.

Recommended default shape:

1. clarify objective when needed
2. build research plan and acceptance criteria
3. gather evidence in bounded rounds
4. synthesize into a draft
5. verify grounding and citations
6. optionally run adversarial review
7. deliver a final artifact
8. optionally promote durable lessons into memory/wiki through the proper mutation path

This should reuse existing recipes and extend them where needed.

It should not create a separate orchestration framework.

### Layer 3: Research skills

Guardian should add first-party research-oriented skills such as:

- `deep-research`
- `literature-review`
- `source-comparison`
- `claim-audit`
- `research-verification`
- `research-writing`

These skills should:

- describe when to use the workflow
- define process and verification expectations
- declare reviewed artifact references where appropriate
- point to reusable templates and examples

They should not execute anything by themselves.

### Layer 4: Research artifact model

Guardian should add a structured artifact model for research work.

Minimum artifact classes:

- `research_plan`
- `evidence_bundle`
- `research_draft`
- `verified_brief`
- `review_report`
- `provenance_record`

These should be treated as runtime-managed artifacts with clear provenance, timestamps, run linkage, and trust metadata.

Markdown renderings are useful, but they should be derived artifacts, not the only state.

### Layer 5: Product surface

If Research is accepted as a true domain, Guardian should expose it as a first-class product area in the web UI and other surfaces.

That includes:

- explicit entry points in chat and CLI
- workflow picker / quick-start options
- run visibility
- artifact browsing
- links into Memory for promoted knowledge
- links into Automations for recurring watches

---

## Architecture Alignment

This proposal is intentionally constrained by Guardian's existing architecture.

## 1. Tools Control Plane alignment

The Research capability should not invent a new tool plane.

Use existing tools first:

- `web_search`
- `web_fetch`
- `doc_search`
- `fs_read`
- `fs_list`
- `memory_search`
- browser tools where justified

If new tools are added later, they should be narrow and justified. Examples might include research-artifact helpers or paper-source integrations, but those should still be governed by ToolExecutor and deferred discovery.

The rule from the Tools spec still applies:

- do not promote a large research tool family to always-loaded
- prefer compact inventory plus drilldown
- fix discovery and routing at the control-plane level, not by expanding prompt payload indiscriminately

## 2. Skills alignment

Research should lean heavily on Guardian's native skills model.

That means:

- compact skill catalog first
- bounded L2/L3 drilldown
- reviewed artifact references when useful
- progressive disclosure rather than giant top-level prompts

Research skills should be the guidance layer that teaches the model how to do good research work inside Guardian's runtime.

They are not a substitute for tools, integrations, or routing.

## 3. Orchestration alignment

The Research capability must sit cleanly within the current orchestration model:

- Intent Gateway owns route selection
- Pending Action orchestration owns blockers and resume
- Cross-surface continuity owns shared context
- Request orchestration owns queueing and execution observation
- Research lane lives beneath those layers as a recipe or bounded runtime service

This proposal therefore complements, and likely extends, the earlier research-lane idea in `RUNTIME-INTELLIGENCE-UPLIFTS-PROPOSAL.md`.

## 4. Memory and artifact alignment

Research outputs should connect to Guardian's artifact and memory direction.

The right relationship is:

- Research owns research artifacts and workflow state
- Memory owns durable reusable knowledge and wiki surfaces
- Research may promote selected outcomes into Memory through the shared mutation path
- Automations may schedule recurring research jobs, but they do not become the canonical home of research artifacts

This is critical. It keeps the model inspectable and governed without copying Feynman's looser file-centric persistence model.

---

## Proposed Runtime Model

```text
User request
  -> IntentGateway
  -> route = research_task
  -> shared pending-action resolution if blocked
  -> research planner
  -> bounded evidence collection rounds
  -> draft synthesis
  -> grounding verification
  -> optional adversarial review
  -> artifact persistence
  -> optional memory/wiki promotion
  -> final response + artifact links
```

### Research lane rules

- bounded iteration count
- bounded tool budgets
- explicit acceptance criteria
- explicit stopping condition
- explicit uncertainty handling
- no claim of verification without evidence
- final response should point to durable artifacts, not only inline prose

### Suggested initial workflows

- Deep research brief
- Literature review
- Source comparison
- Claim audit
- Research watch

### Suggested initial evidence sources

- web search / fetch
- document search
- local repository and file inspection
- browser reads when needed
- memory and prior artifacts when relevant

---

## Artifact Model Recommendation

Guardian should introduce a dedicated research domain object, conceptually similar to a "study" or "research run."

Suggested high-level fields:

- `id`
- `title`
- `mode`
- `status`
- `question`
- `plan`
- `artifacts`
- `sources`
- `verificationStatus`
- `reviewStatus`
- `linkedAutomationId`
- `linkedMemoryArtifactIds`
- `createdAt`
- `updatedAt`
- `requestedBy`

Suggested research artifact families:

### 1. Plan artifact

Contains:

- objective
- questions
- source types
- acceptance criteria
- task ledger
- verification checklist

### 2. Evidence bundle

Contains:

- normalized citations
- evidence items
- source snippets
- unresolved contradictions
- provenance metadata

### 3. Draft artifact

Contains:

- synthesized structured writeup
- explicit open questions
- unresolved gaps

### 4. Verified brief

Contains:

- final deliverable
- inline markers or source section, depending on mode
- verification summary

### 5. Review artifact

Contains:

- adversarial findings
- severity
- revision recommendations

### 6. Provenance record

Contains:

- run lineage
- source counts
- accepted vs rejected evidence
- verification pass summary

This artifact model should integrate with:

- run timeline
- audit
- artifact browsing
- memory promotion
- future exports

---

## Left-Nav Recommendation

## Short answer

**Yes, probably, but not immediately by default.**

Research should become its own left-nav page if Guardian accepts Research as a first-class domain with:

- canonical backend state
- canonical artifact ownership
- canonical page ownership
- durable runs and outputs
- cross-links to Automations, Memory, and Code

If Research is only:

- a few skills
- a chat preset
- a collection of slash commands
- a workflow hidden inside generic chat

then it should **not** be promoted to the left nav.

## Why a top-level page can make sense

The WebUI spec is built around one domain, one page.

Research is a plausible first-class domain because it could own:

- research runs
- research artifacts
- research templates
- current studies / investigations
- evidence and verification state
- source collections and comparisons

That is enough domain weight to justify a dedicated page.

## Why it should not be forced too early

If the page launches before the domain model is real, it will duplicate:

- chat
- automations
- memory
- reference guidance

and violate the WebUI ownership rules.

## Recommended ownership boundaries if adopted

### Research owns

- ad hoc research runs
- research artifacts
- research workflow templates
- verification/review state for research outputs
- latest output for recurring watches

### Automations owns

- schedule editing
- generic automation run history
- manual enable/disable/run controls for saved automations

Research can show compact schedule status and deep links, but should not become a second scheduling control plane.

### Memory owns

- promoted durable knowledge
- wiki pages
- curated long-term research notes once promoted

Research can offer "promote to Memory" or "link into Memory," but should not become the wiki.

### Configuration owns

- provider setup
- search and browser policy
- tool policy
- research-related cost / authority controls if added

### Code owns

- repo-scoped coding sessions
- code execution workbench

Research may link to repo-backed claim audits or evidence from Code, but should not absorb the coding surface.

## Suggested nav position if adopted

If Guardian adds Research as a first-class page, the likely cleanest slot is:

1. `Second Brain`
2. `System`
3. `Security`
4. `Network`
5. `Cloud`
6. `Automations`
7. `Research`
8. `Code`
9. `Memory`
10. `Reference`
11. `Performance`
12. `Configuration`

This keeps Research near other execution-heavy work without burying it under Configuration or Memory.

Important:

- this proposal does **not** change the current WebUI source-of-truth spec yet
- if the capability is accepted and implemented as a real page, `WEBUI-DESIGN.md` must be updated in the same implementation change

---

## Surface Design Recommendation

If Research becomes a page, it should not be a giant blank canvas.

It should likely have a small number of clearly owned tabs or major sections:

### 1. Overview

- what Research is
- recent runs
- pinned studies
- quick start workflows

### 2. Studies

- durable research objects
- status
- linked outputs
- verification state

### 3. Artifacts

- plans
- evidence bundles
- briefs
- review artifacts
- provenance records

### 4. Templates

- workflow templates
- domain templates
- output types

### 5. Watches

- recurring research watches
- latest output
- schedule status
- deep links to Automations for full schedule management

This page should explain itself at page, tab, and section level per the WebUI guidance standard.

---

## Suggested Phase Plan

## Phase 1: Capability definition and route

- define the product scope
- add a `research_task` route
- add initial research skills
- add prompt/runtime contracts for research artifact expectations

## Phase 2: Research lane and artifacts

- implement bounded research orchestration
- add research domain objects and artifact persistence
- connect to run timeline and audit

## Phase 3: Verification discipline

- package verification and review stages
- reuse evidence-grounded step semantics where appropriate
- add regression tests for evidence-backed outputs

## Phase 4: Product surface

- add chat and CLI workflow entry points
- add artifact browsing
- add a web Research page if the domain model is now real enough

## Phase 5: Recurring research

- add watch workflows backed by Automations
- keep scheduling and generic run history aligned with the Automations owner page

## Phase 6: Memory integration

- allow selective promotion of verified findings or enduring research summaries into Memory/Wiki
- keep provenance and lifecycle metadata explicit

---

## Risks

### 1. Research becomes a shadow orchestrator

Mitigation:

- keep Intent Gateway authoritative
- keep pending actions shared
- keep the research lane as a bounded recipe/runtime beneath existing orchestration

### 2. Research artifacts drift into loose files

Mitigation:

- make structured research state canonical
- treat Markdown outputs as renderable artifacts, not the only truth

### 3. The page duplicates Automations, Memory, or Chat

Mitigation:

- define clear ownership boundaries before the page exists
- do not add a Research page until it owns real domain state

### 4. Verification becomes branding instead of substance

Mitigation:

- require explicit evidence and verification metadata
- do not let outputs say "verified" unless the verification step actually ran and recorded evidence

### 5. Tool payload grows too much

Mitigation:

- reuse existing tools
- keep research tool discovery deferred
- rely on skills, route selection, and bounded orchestration rather than giant always-loaded research tool catalogs

---

## Recommendation

Guardian should proceed with a Guardian-native Research capability inspired by Feynman's product packaging, not by its runtime shape.

The key recommendations are:

1. add a first-class `research_task` route
2. package a bounded research lane beneath the current orchestration model
3. add research-specific skills, templates, and artifact types
4. make research outputs durable, browsable, and verification-aware
5. plan for a top-level **Research** page only once the capability owns real state and real artifacts

The left-nav answer is therefore:

**Yes, Research is likely strong enough to deserve its own page, but only after the backend capability exists as a real domain.**

That is the point where a Research page stops being UI decoration and becomes canonical product structure.
