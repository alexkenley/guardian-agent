# Second Brain Editable Setup And Knowledge Plane Implementation Plan

**Date:** 2026-04-12  
**Status:** Draft  
**Primary references:** [Second Brain As-Built Specification](../specs/SECOND-BRAIN-AS-BUILT-SPEC.md), [Configuration Center Spec](../specs/CONFIG-CENTER-SPEC.md), [Memory System Guide](../guides/MEMORY-SYSTEM.md), [Memory Artifact / Wiki Uplift Plan](./MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md), [Second Brain Executive Assistant Uplift Plan](./SECOND-BRAIN-EXECUTIVE-ASSISTANT-UPLIFT-PLAN.md)

---

## Goal

Uplift `Second Brain` intelligence, personalization, and day-to-day usefulness without introducing:

- a one-shot setup wizard that becomes stale after day one
- a second durable memory authority beside Guardian memory
- a separate orchestration or config stack
- high-complexity behavior that is expensive to debug or test

The target shape is an editable-first `Second Brain` that becomes personal quickly, stays simple, and can be reconfigured later from the same product surfaces.

---

## Core Decisions

### 1. No standalone first-run wizard

Guardian already deprecated the old setup wizard model. `Second Brain` should follow the same direction.

Recommended shape:

- first-run should be a thin guided onboarding flow
- the flow should write into the same canonical config and runtime services used after onboarding
- every setting captured during onboarding must remain editable later

This means:

- use `#/config` as the canonical settings home
- add a dedicated `Second Brain` configuration subsection
- optionally surface a first-run checklist or guided card inside `Second Brain`, but do not create a separate long-lived wizard architecture

### 2. Editable later by both UI and assistant

The user should be able to change `Second Brain` setup in at least two supported ways:

- web UI configuration and management surfaces
- assistant-driven updates that call the same backend config and routine APIs

Manual YAML editing may still exist for advanced operators, but it is not the primary UX.

### 3. One memory authority, not two

`docs/guides/MEMORY-SYSTEM.md` already establishes the correct architecture:

- Guardian has unified durable memory surfacing
- canonical memory remains sidecar/index-backed and runtime-owned
- surfacing multiple memory-like things in one UI does not create multiple runtime memory authorities

For `Second Brain`, that means:

- notes, tasks, contacts, briefs, routines, and library artifacts remain `Second Brain` product data
- Guardian durable memory remains Guardian durable memory
- a richer `Library` or knowledge plane must be retrieval and artifact infrastructure, not a parallel free-form memory store competing with Memory/Wiki

### 4. Simplicity wins over breadth

Every uplift in this plan must pass a simplicity test:

- does it reuse existing config, routing, memory, search, and approval infrastructure?
- can it be explained in one or two operator sentences?
- does it avoid creating a second source of truth?

If not, it should be deferred.

---

## Product Direction

`Second Brain` should become:

- a personalized assistant surface
- a better retrieval layer over the user’s actual data
- a bounded workspace for briefs, follow-up, and draft review

It should not become:

- a second memory subsystem
- a raw document-management system
- an autonomous agent platform
- a separate configuration island

---

## Scope

### In scope

- editable-first `Second Brain` setup
- `Configuration > Second Brain` subsection
- guided onboarding that seeds defaults through the canonical config path
- assistant-driven settings changes using the same backend-owned settings and routine APIs
- a richer knowledge plane behind `Library`
- evidence-backed meeting and follow-up intelligence
- `contacts` terminology as the user-facing standard

### Out of scope

- replacing Guardian Memory / Wiki with `Second Brain`
- file-system-as-authority note storage
- arbitrary workflow authoring inside `Second Brain`
- introducing a separate onboarding runtime or persistence layer

---

## Recommended UX Model

### A. First-run experience

On first meaningful `Second Brain` entry, show a compact guided setup card instead of a separate wizard app.

Capture:

- preferred delivery channels
- default workday timezone and hours
- desired proactivity level
- desired default routines
- connected sources to prioritize
- preferred knowledge collections or document sources

Actions:

- `Use recommended defaults`
- `Customize now`
- `Skip for now`

### B. Persistent edit surfaces

Add `Configuration > Second Brain` with sections for:

- `Profile`
- `Routines`
- `Knowledge Sources`
- `Calendar And Contacts`
- `Delivery`
- `Budget And Quality`

### C. Assistant-editable settings

Support requests such as:

- `Turn off proactive morning briefs.`
- `Use Telegram and web for Second Brain updates.`
- `Add my archive folder to Second Brain knowledge sources.`
- `Make pre-meeting briefs quality-first.`

These should map to backend-owned config and `Second Brain` services, not ad hoc YAML edits or prompt-only memory.

---

## Configuration Model

Do not create a separate settings store. Extend the existing config surface with a bounded `Second Brain` section.

Recommended shape:

```yaml
assistant:
  secondBrain:
    enabled: true
    profile:
      timezone: Australia/Brisbane
      workdayStart: "08:30"
      workdayEnd: "17:30"
      proactivityLevel: balanced
    delivery:
      defaultChannels: [telegram, web]
    routines:
      seedDefaults: true
      qualityPolicy: local_first
    knowledge:
      enabled: true
      collections: []
      defaultRetrievalMode: hybrid
      rerankerEnabled: true
    sync:
      contactsEnabled: true
      calendarEnabled: true
```

This is illustrative, not final schema. The important rule is that onboarding, config UI, and assistant-driven updates must all target the same structure.

---

## Knowledge Plane Direction

The `Library` uplift should behave as a knowledge plane, but only in the retrieval sense.

### What to add

- source-aware collections
- importable document and folder groups
- hybrid retrieval:
  - lexical search
  - embeddings
  - reranking
- snippet and citation evidence in chat and briefs
- explicit provenance in saved brief artifacts

### What not to add

- a second free-form durable memory area
- raw markdown or vault files as the new canonical memory store
- silent promotion of every retrieved artifact into Guardian memory

The knowledge plane should sit beside Search and Memory/Wiki, not compete with them.

---

## Intelligence Uplifts

### Priority 1: Better meeting packets

Upgrade `pre_meeting` and `follow_up` flows to gather:

- related contacts
- recent notes
- relevant library artifacts
- prior briefs
- explicitly allowed provider-backed context

Every high-value brief should show evidence blocks, not just a synthesized paragraph.

### Priority 2: Draft review workspace

Add a bounded draft queue for:

- follow-up drafts
- reply suggestions
- outreach suggestions

Keep send actions provider-owned and approval-gated.

### Priority 3: Knowledge-backed retrieval

When `Second Brain` answers a question from imported collections, it should return:

- result summary
- source references
- why the result matched

This is a usability uplift and a trust uplift.

---

## Implementation Phases

### Phase 1: Editable Setup Foundation

Deliver:

- `Configuration > Second Brain`
- first-run setup card linked to the same config model
- assistant-driven update path for major settings
- terminology pass using `contacts`

Exit criteria:

- onboarding choices are editable later
- no separate setup persistence path exists
- settings changes apply live or through the same approved runtime path used elsewhere

### Phase 2: Knowledge Plane Behind Library

Deliver:

- collection model
- collection CRUD in config/UI
- hybrid retrieval and reranking support
- citation-aware retrieval surfaces

Exit criteria:

- `Library` supports collection-backed retrieval
- evidence and provenance are visible in answers and briefs
- no second memory authority is introduced

### Phase 3: Briefing And Draft Intelligence

Deliver:

- richer pre-meeting packet assembly
- richer follow-up draft assembly
- bounded draft review queue

Exit criteria:

- meeting prep is clearly better than keyword overlap
- follow-up artifacts are reviewable and source-grounded

### Phase 4: Hardening And Verification

Deliver:

- route tests
- config tests
- retrieval verification
- UI smoke coverage

Exit criteria:

- first-run and later editing behave identically at the config layer
- Library and knowledge-plane changes do not corrupt memory or durable config

---

## File-Level Impact

Primary areas:

- `web/public/js/pages/second-brain.js`
- `web/public/js/pages/config.js`
- `src/channels/web-runtime-routes.ts`
- `src/chat-agent.ts`
- `src/runtime/second-brain/*`
- `src/search/*`
- `src/reference-guide.ts`
- `docs/specs/CONFIG-CENTER-SPEC.md`
- `docs/specs/SECOND-BRAIN-AS-BUILT-SPEC.md`

---

## Acceptance Gates

- onboarding settings are editable later from the web UI
- the assistant can update the same settings through bounded backend-owned paths
- `Library` gains real retrieval depth without becoming a second memory system
- `Second Brain` remains simpler to explain, not harder
- no new one-off orchestration or persistence stack is introduced
