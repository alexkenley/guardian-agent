# Proposal: Second Brain

**Status:** Implemented current product scope; retained as historical proposal
**Date:** 2026-04-04
**Current source of truth:** [Second Brain As-Built Design](../design/SECOND-BRAIN-AS-BUILT.md)
**Related:**
- [Capability Authoring Guide](../guides/CAPABILITY-AUTHORING-GUIDE.md)
- [Intent Gateway And Smart Routing Specification](../design/INTENT-GATEWAY-ROUTING-DESIGN.md)
- [Architecture Overview](../architecture/OVERVIEW.md)
- [Forward Architecture](../architecture/FORWARD-ARCHITECTURE.md)
- [Web UI Design Spec](../design/WEBUI-DESIGN.md)
- [Cross-Surface Continuity Uplift Plan](../plans/CROSS-SURFACE-CONTINUITY-UPLIFT-PLAN.md)
- [Memory System Uplift Plan](../plans/MEMORY-SYSTEM-UPLIFT-PLAN.md)
- [Memory Artifact Wiki Uplift Plan](../plans/MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md)
- [Notion Workspace Integration Implementation Plan](../plans/NOTION-WORKSPACE-INTEGRATION-IMPLEMENTATION-PLAN.md)
- [Native Google And Instruction Steps Proposal](../implemented/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-PROPOSAL.md)
- [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts)
- [src/runtime/direct-intent-routing.ts](../../src/runtime/direct-intent-routing.ts)
- [src/runtime/automation-authoring.ts](../../src/runtime/automation-authoring.ts)
- [src/runtime/scheduled-tasks.ts](../../src/runtime/scheduled-tasks.ts)
- [src/runtime/budget.ts](../../src/runtime/budget.ts)
- [src/runtime/model-routing-ux.ts](../../src/runtime/model-routing-ux.ts)
- [src/llm/guarded-provider.ts](../../src/llm/guarded-provider.ts)
- [src/google/google-service.ts](../../src/google/google-service.ts)
- [src/microsoft/microsoft-service.ts](../../src/microsoft/microsoft-service.ts)
- [src/search/search-service.ts](../../src/search/search-service.ts)
- [src/channels/web-runtime-routes.ts](../../src/channels/web-runtime-routes.ts)
- [src/channels/web-types.ts](../../src/channels/web-types.ts)
- [src/tools/builtin/contacts-email-tools.ts](../../src/tools/builtin/contacts-email-tools.ts)
- [src/tools/marketing-store.ts](../../src/tools/marketing-store.ts)
- [skills/outreach-campaigns/SKILL.md](../../skills/outreach-campaigns/SKILL.md)
- [src/quick-actions.ts](../../src/quick-actions.ts)
- [web/public/index.html](../../web/public/index.html)
- [web/public/js/pages/memory.js](../../web/public/js/pages/memory.js)
- [web/public/js/pages/config.js](../../web/public/js/pages/config.js)
- [Trust Presets Spec](../design/TRUST-PRESETS-DESIGN.md)
- [Tools Control Plane Spec](../design/TOOLS-CONTROL-PLANE-DESIGN.md)

**External product and OSS signals:**
- [Motion auto-scheduling](https://www.usemotion.com/help/time-management/auto-scheduling)
- [Sunsama daily planning](https://help.sunsama.com/docs/daily-planning)
- [Sunsama weekly planning](https://help.sunsama.com/docs/usage-guides/weekly-objectives/weekly-planning/)
- [Reclaim habits and calendar protection](https://help.reclaim.ai/en/articles/5224992)
- [Reflect](https://reflect.app/)
- [Gemini in Gmail](https://support.google.com/mail/answer/14355636)
- [Copilot in OneNote](https://support.microsoft.com/en-us/topic/copilot-tutorial-summarize-and-identify-to-do-items-with-copilot-in-onenote-696ebaf1-62fe-49b3-b3d7-cd047659fa55)
- [Postiz](https://postiz.com/)
- [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)
- [AFFiNE](https://github.com/toeverything/AFFiNE)
- [Joplin](https://github.com/laurent22/joplin)
- [Super Productivity](https://github.com/johannesjo/super-productivity)
- [Vikunja](https://github.com/go-vikunja/vikunja)
- [Monica](https://github.com/monicahq/monica)
- [ActivityWatch](https://github.com/ActivityWatch/activitywatch)
- [mem0](https://github.com/mem0ai/mem0)
- [FullCalendar](https://github.com/fullcalendar/fullcalendar)

---

## Executive Summary

Guardian should grow a first-class **Second Brain** product area and make it the primary entry point for normal users.

This is not a small "notes and calendar" add-on. It is a target-state product shift:

- the current top-level dashboard stops being mainly an operator summary
- **Second Brain** becomes the daily home for the user
- Guardian starts behaving more like an **executive assistant / chief-of-staff assistant**
- built-in notes, tasks, reminders, people, library, and a built-in calendar layer become first-class product objects
- Google Workspace and Microsoft 365 become important source systems, not the whole product
- personal routines and assistant briefs become first-class, modifiable built-in automations

The most important behavioral change is this:

Guardian should stop feeling merely reactive and start feeling **alive**.

That means it should:

- prepare the user for upcoming meetings and events
- gather relevant context from notes, emails, calendar events, contacts, and documents
- run bounded research when helpful
- produce briefing packets and follow-up suggestions
- track commitments, deadlines, and relationship follow-ups
- surface the right context before the user has to dig for it manually

The repo already has much of the substrate:

- Google and Microsoft calendar, email, contacts, and document access
- durable memory and document search
- automations, scheduled tasks, presets, and assistant jobs
- campaign/contact tooling that can seed People/CRM and outreach capabilities
- cross-surface continuity across web, CLI, and Telegram

The proposal is to assemble those into one coherent personal-assistant system.

It should also make model usage visible and governable.

Second Brain will run background routines, meeting briefs, and prep flows. If those are not explicitly budgeted, the product can feel expensive and unpredictable, especially for API-only users.

---

## Problem

Guardian today is strong as:

- a secure orchestration runtime
- a chat assistant
- an operator dashboard
- a coding and automation environment

It is not yet strong as an everyday personal assistant for the average user.

The current navigation and product shape still read as a control plane:

- Dashboard
- Security
- Network
- Cloud
- Automations
- Code
- Memory
- Reference Guide
- Configuration

That is not the entry point of a mainstream second-brain assistant.

An average user does not think in terms of:

- memory artifacts
- routing traces
- tool inventories
- cloud panels
- control-plane surfaces

They think in terms of:

- what matters today
- what meeting is coming up next
- what do I owe people
- what should I prep
- what did I promise
- save this note
- find that thing I wrote before
- remind me when it matters

Without a first-class product area for those jobs, Guardian risks remaining technically impressive but habitually unused.

---

## Product Thesis

Second Brain should be Guardian's **personal operating layer**.

It should behave like a privacy-conscious executive assistant that can:

1. capture things quickly
2. organize them into structured state
3. retrieve relevant context from many sources
4. proactively brief the user
5. keep commitments and follow-ups from slipping
6. stay synced across web, CLI, and Telegram

The right metaphor is not "better dashboard."

The right metaphor is:

- a personal assistant
- a chief-of-staff assistant
- a second brain

---

## Naming And Information Architecture Options

The naming and IA matter because they will shape user expectations.

## Option A: Replace Dashboard With Second Brain

Shape:

- top-level nav label becomes `Second Brain`
- this is the default entry point
- current dashboard runtime widgets move to owner pages or a smaller ops view

Pros:

- clearest product story
- strongest daily-use mental model
- no split entry point between personal assistant and system controls

Cons:

- requires the strongest IA transition
- current dashboard content must be redistributed cleanly

## Option B: Keep Dashboard And Add A Second Brain Tab Under It

Shape:

- keep current Dashboard shell
- add `Second Brain` or `Organizer` as one tab inside it

Pros:

- lowest short-term disruption
- preserves existing operator expectations

Cons:

- split identity
- users still land in the wrong place
- feels like the personal assistant is bolted onto an ops page

## Option C: Keep Dashboard As The Label, But Make It The Second Brain Shell

Shape:

- nav label remains `Dashboard`
- page becomes the personal-assistant home
- current runtime/ops summaries move into an `Operations` subview or separate surface

Pros:

- preserves the familiar label
- keeps product migration softer

Cons:

- the word `Dashboard` undersells the assistant
- long-term product language stays weaker than it should be

## Decision

Use **Option A** as the target state and product direction:

- replace `Dashboard` with `Second Brain` in the primary navigation
- make `Second Brain` the main web entry point
- treat any `Dashboard`-labeled shell only as a temporary migration bridge if needed

Naming decision:

- call it `Second Brain`
- do **not** call it `Organizer`
- do **not** keep the current operational dashboard as the primary home
- do **not** make users discover the personal assistant through a nested subtab

---

## Target-State Navigation

Recommended top-level nav:

- `Second Brain`
- `Automations`
- `Code`
- `Security`
- `Network`
- `Cloud`
- `Memory`
- `Reference`
- `Configuration`

Recommended `Second Brain` tabs:

- `Today`
- `Calendar`
- `Tasks`
- `Notes`
- `People`
- `Library`
- `Routines`

Optional later tabs:

- `Meetings`
- `Content`

Long-term naming recommendation:

- keep top-level `Automations` for power-user and technical automation authoring
- use `Routines` inside Second Brain for the simplified personal assistant automation surface

That avoids the confusion of having two separate things both called "Automations."

---

## Current Guardian Assets We Should Build On

Guardian already has valuable building blocks that this proposal should reuse directly.

## 1. Google and Microsoft integrations

Existing native integrations already cover:

- email
- calendar
- contacts
- drive and document surfaces

Primary files:

- [src/google/google-service.ts](../../src/google/google-service.ts)
- [src/microsoft/microsoft-service.ts](../../src/microsoft/microsoft-service.ts)

These should become source adapters for Second Brain, not isolated feature islands.

## 2. Document search

Guardian already has a native hybrid search engine over indexed document collections.

Primary file:

- [src/search/search-service.ts](../../src/search/search-service.ts)

This should become the retrieval layer for:

- notes
- saved documents
- meeting transcripts
- attached artifacts
- imported knowledge sources

## 3. Memory

Guardian already has durable memory and an advanced Memory page.

Primary file:

- [web/public/js/pages/memory.js](../../web/public/js/pages/memory.js)

This should remain:

- the advanced durable-knowledge layer
- the curation and audit layer

It should **not** become the main notes database.

## 4. Contacts and campaigns

Guardian already has:

- contact discovery
- contact import
- local contact storage
- campaign drafting and sending
- an outreach skill

Primary files:

- [src/tools/builtin/contacts-email-tools.ts](../../src/tools/builtin/contacts-email-tools.ts)
- [src/tools/marketing-store.ts](../../src/tools/marketing-store.ts)
- [skills/outreach-campaigns/SKILL.md](../../skills/outreach-campaigns/SKILL.md)

This is important because it gives us a starting point for:

- People / CRM
- relationship follow-up
- personal outreach
- content and social workflows later

## 5. Quick actions

Guardian already has structured personal-assistant quick actions for:

- email
- task planning
- meeting planning

Primary file:

- [src/quick-actions.ts](../../src/quick-actions.ts)

These should become direct capture and action entry points inside Second Brain.

## 6. Personal-automation groundwork

Guardian already has:

- automation authoring
- scheduled tasks
- built-in presets
- automation catalog materialization

And the automation authoring layer already recognizes content and outbound workflows such as:

- newsletters
- LinkedIn posts
- content pipelines

Primary files:

- [src/runtime/automation-authoring.ts](../../src/runtime/automation-authoring.ts)
- [src/runtime/scheduled-tasks.ts](../../src/runtime/scheduled-tasks.ts)

## 7. Cross-channel continuity

Guardian already has the right direction for:

- shared continuity across linked surfaces
- shared pending actions
- cross-surface resume semantics

Primary plan:

- [Cross-Surface Continuity Uplift Plan](../plans/CROSS-SURFACE-CONTINUITY-UPLIFT-PLAN.md)

That matters because Second Brain must feel like the same assistant whether the user is in:

- web
- CLI
- Telegram

## 8. Budgeting and usage primitives

Guardian already has the right starting pieces for usage governance:

- token usage is recorded centrally in [src/runtime/budget.ts](../../src/runtime/budget.ts)
- LLM calls are metered through [src/llm/guarded-provider.ts](../../src/llm/guarded-provider.ts)
- scheduled tasks already support `dailySpendCap` and `providerSpendCap` in [src/runtime/scheduled-tasks.ts](../../src/runtime/scheduled-tasks.ts)
- the runtime already exposes `GET /api/budget` through [src/channels/web-runtime-routes.ts](../../src/channels/web-runtime-routes.ts)
- response metadata already carries locality, fallback, and token usage in [src/runtime/model-routing-ux.ts](../../src/runtime/model-routing-ux.ts)

The gap is productization.

Today these are mostly runtime and operator primitives. Second Brain should turn them into user-visible budget controls and explainable spend behavior.

---

## Token, Cost, And Model Governance

Second Brain should be designed to avoid becoming an invisible token-burner.

That matters for two user groups:

- users with a local model, where most small assistant work should stay local
- users with only API providers, where proactive routines can quietly create ongoing spend unless the product manages it explicitly

## Design principles

### 1. Local-first when local exists

If a local model is configured, it should do most of the cheap and frequent assistant work:

- note cleanup
- task extraction
- lightweight classification
- reminder generation
- relationship nudges
- first-pass meeting context assembly
- routine triage and prioritization

External models should be reserved for:

- higher-quality synthesis
- bounded web research
- complex writing or rewriting
- richer meeting briefs
- cases where the local model fails or the smart router escalates

### 2. Deterministic work should not spend tokens

Second Brain should minimize LLM spend by making more of the pipeline deterministic:

- sync jobs
- calendar merging
- event horizon checks
- reminder scheduling
- task due-date checks
- library indexing
- source retrieval
- evidence bundle assembly

Only the synthesis step should need LLM tokens in many flows.

### 3. Background routines need explicit budgets

Every built-in routine should have:

- a default execution profile
- a token budget
- an external-spend allowance
- a downgrade path when budgets are tight

Second Brain must never behave like "set and forget until your bill arrives."

### 4. Users should see where spend came from

Every proactive brief and major assistant output should be able to say:

- which provider was used
- whether it ran local or external
- whether fallback occurred
- approximately how many tokens were used
- whether external research was included

That makes the assistant feel governed instead of magical.

## Recommended usage model

Second Brain should track usage at four levels:

### Global assistant usage

- daily token usage
- monthly token usage
- by provider
- by local vs external locality

### Second Brain product usage

- daily and monthly usage for Second Brain specifically
- background routine spend
- briefing spend
- research spend

### Routine-level usage

- per-routine daily budget
- per-run budget
- provider-specific caps
- auto-pause when exceeded

### Output-level usage

- tokens and provider used for each brief, digest, or major synthesis

## Recommended user controls

Second Brain should add built-in usage controls, not leave budgeting entirely in operator config.

Recommended controls:

- monthly external token budget
- daily external token budget
- per-routine external budget
- per-brief maximum spend class
- external research allowed: `always`, `when needed`, `ask first`, `never`
- provider preference: `local first`, `balanced`, `quality first`, `external only`
- quiet-budget mode that degrades gracefully before spending more

If the user only configures an API key and no local provider, these controls become even more important.

## Recommended budget classes

Second Brain should classify work into spend classes instead of treating all assistant work equally.

### Class A: zero or near-zero spend

Use deterministic logic only:

- sync
- indexing
- reminders
- due-date checks
- event detection
- queueing work

### Class B: cheap local assistant work

Prefer local if available:

- extraction
- summarization of already-collected materials
- task and note normalization
- meeting context triage

### Class C: premium synthesis

Use external when justified or explicitly allowed:

- high-quality executive brief generation
- nuanced writing
- larger cross-source synthesis

### Class D: research-enhanced premium work

Most expensive class. Requires explicit allowance:

- external web research
- company and attendee research
- multi-step briefing enrichment
- content and social research

This gives the user a mental model that matches real spend.

## Degradation behavior when budgets are constrained

Second Brain should degrade gracefully instead of just failing hard.

Recommended order:

1. skip external research
2. use local synthesis if available
3. reduce briefing depth
4. shorten lookback windows
5. convert proactive routine output into a lighter digest
6. pause non-essential routines
7. ask approval before exceeding the configured budget

## UI and reporting recommendation

Second Brain should expose a simple budget view for normal users and keep deeper diagnostics in Configuration.

Recommended user-facing surfaces:

- a `Usage` card or status badge in `Second Brain > Today`
- per-routine budget settings in `Second Brain > Routines`
- per-brief usage metadata on generated briefing packets

Recommended operator-facing surfaces:

- richer provider and budget diagnostics in `Configuration`
- route/provider usage breakdowns for debugging smart routing behavior

## Architecture recommendation

Do not build a separate token tracker just for Second Brain.

Instead:

- extend the existing budget tracker to support persistent, attributable usage slices
- attribute usage to route, feature area, routine, and brief type
- preserve locality metadata so users can see `local` versus `external`
- add optional provider pricing metadata so tokens can map to estimated cost when pricing is known

Suggested runtime additions:

- `SecondBrainUsageService`
- `SecondBrainBudgetPolicy`
- `SecondBrainRoutineBudgetProfile`

These should sit on top of the shared runtime budget and routing primitives, not beside them.

## Smart-routing implications

This proposal should explicitly align with the existing smart routing design.

Recommended behavior:

- local-first for routine housekeeping and cheap synthesis
- external escalation only for bounded high-value work
- explicit fallback metadata shown on outputs when the local lane could not handle the request
- user-selectable bias toward local, balanced, or quality-first execution

This is especially important for an "alive" assistant. The more proactive the assistant becomes, the more important budget transparency becomes.

---

## What Second Brain Should Actually Do

The target role is not just "answer my questions." It is "actively help me stay prepared."

## Core assistant jobs

Second Brain should reliably handle:

### 1. Today planning

- show today's meetings, tasks, reminders, and priorities
- identify likely conflicts and overloaded periods
- explain what matters first

### 2. Meeting preparation

- collect relevant past notes, email threads, files, tasks, and people context
- optionally run bounded external research
- produce a briefing packet before the event

### 3. Follow-up management

- track commitments from notes and emails
- flag unanswered threads and overdue promises
- draft follow-up messages

### 4. Context recall

- find related notes, files, messages, and people quickly
- explain why something is relevant now

### 5. Lightweight chief-of-staff behavior

- weekly review
- deadline watch
- relationship reminders
- recurring prep workflows

---

## Built-In Smart Routines

Second Brain should ship with a built-in **routine catalog** backed by Guardian's automation and scheduling system.

These should be:

- prebuilt
- editable
- cloneable
- optionally scheduled
- optionally event-triggered
- budgeted

They should not be opaque hardcoded magic.

## Recommended built-in routines

### Daily and weekly routines

- `Morning Brief`
- `Evening Wrap`
- `Weekly Review`
- `Next 24 Hours Radar`

### Meeting and event routines

- `Pre-Meeting Brief`
- `Post-Meeting Follow-Up`
- `External Meeting Research Brief`
- `Travel / Event Prep`

### Commitment and follow-up routines

- `Follow-Up Watch`
- `Commitment Tracker`
- `Relationship Nudge`
- `Deadline Guard`

### Personal operations routines

- `Renewal And Bills Reminder`
- `Reading Queue Digest`
- `Project Context Refresh`

### Content and outreach routines

- `Content Calendar Review`
- `Social Draft Queue`
- `Outreach Review`

The content and outreach routines should start as draft-and-review workflows, not fully autonomous posting systems.

## Trigger model

These should not rely on cron alone.

Recommended trigger types:

- cron-based review windows
- calendar horizon triggers
- due-date and overdue triggers
- event completion triggers
- manual "prepare me" triggers

The current runtime already supports scheduled and event-driven task concepts. Second Brain should use both.

Each routine should also carry:

- a default budget profile
- a default routing preference
- a downgrade policy when it hits its budget ceiling

---

## Target-State Second Brain Tabs

## Today

This is the main home view.

It should answer:

- what is coming up
- what matters first
- what is at risk
- what should I prepare now

Recommended sections:

- next event
- top tasks
- follow-up queue
- reminders due today
- briefing cards
- quick capture
- quick actions

## Calendar

Second Brain should own a **built-in calendar layer**.

This should not mean "ignore Google and Microsoft."

It should mean:

- Second Brain has a canonical calendar model
- Google and Microsoft calendars sync into it
- local-only items also live in it
- meeting context, notes, tasks, and briefs attach to calendar events

Recommended built-in calendar objects:

- external synced events
- local events
- reminders
- time blocks
- habits or protected routines

Future meeting-provider objects:

- Teams meeting metadata
- Zoom meeting metadata
- Google Meet metadata

These are planned, not required for the first implementation.

## Tasks

Tasks should be first-class product objects with:

- title
- status
- due date
- priority
- tags
- topic or project
- linked notes
- linked event
- linked people
- provenance
- reminder rules

Key behaviors:

- convert email to task
- convert note bullets to tasks
- attach tasks to meeting briefs
- suggest next actions and time blocks

## Notes

Notes should support:

- quick capture
- long-form notes
- meeting notes
- daily notes
- topic notes
- backlinks
- tags
- linked people, tasks, and events
- retrieval over full content and related artifacts

## People

People should start as a lightweight personal CRM, not enterprise sales CRM.

Core jobs:

- who is this person
- when did I last talk to them
- what do I owe them
- what meetings and notes are relevant

Initial data sources:

- Google contacts
- Microsoft contacts
- local notes
- linked tasks
- linked calendar events
- existing contact/campaign tooling where it makes sense

## Library

The library should own:

- imported notes
- attached files
- saved web pages
- meeting transcripts
- PDFs
- reference docs

This is where the existing document search system should plug in most directly.

## Routines

This is the simplified personal automation surface.

It should show:

- built-in routine templates
- installed routines
- schedule and trigger editing
- delivery controls
- recent outputs

This is where the user configures the assistant's proactive behavior without dropping into the full technical automation surface.

---

## Active Briefing Pipeline

The assistant needs one canonical pattern for "alive" behavior.

Recommended target-state pipeline:

1. deterministic collection
2. cross-source retrieval
3. optional bounded external research
4. synthesis
5. delivery and follow-up hooks

## Example: Pre-Meeting Brief

Inputs:

- calendar event
- linked attendees
- recent emails
- related notes
- related tasks
- library artifacts
- optional web research on attendees or company

Output:

- meeting purpose
- latest context
- open questions
- known risks
- suggested agenda
- follow-up reminders

## Example: Weekly Review

Inputs:

- open tasks
- overdue tasks
- upcoming events
- stale notes
- unanswered threads
- people not contacted recently

Output:

- weekly priorities
- slipped commitments
- prep recommendations
- cleanup recommendations

Important rule:

collection should be deterministic and source-aware first; synthesis should happen after collection, not instead of it.

---

## Personal Data Architecture

Second Brain should not mix ordinary user notes and structured personal data into Guardian's durable memory store.

That separation is correct and should stay.

## Recommended layered model

### Layer 1: Structured personal stores

Own:

- tasks
- reminders
- notes
- people
- calendar objects
- routine definitions
- briefing packets

### Layer 2: Library and retrieval index

Own:

- imported files
- attachments
- saved pages
- transcripts
- synced note repositories
- source snippets and parsed content

This layer should use the existing SearchService and indexed collection model.

### Layer 3: Distilled durable memory

Own:

- preferences
- standing instructions
- durable facts
- canonical summaries
- curated topic pages
- long-lived retrieved context

This layer should continue to use the shared memory mutation path.

## Important rules

1. Normal notes are not raw memory entries by default.
2. Raw synced content should not be shoved directly into durable memory.
3. The assistant should use the same retrieval and distillation mechanisms across these layers, but the stores remain distinct.
4. "RAG" is an implementation detail here. The product concept is a layered personal knowledge system.

---

## Built-In Calendar Architecture

The user asked for a built-in calendar that can pull in external sources. That should be the target state.

Recommendation:

- build a `SecondBrainCalendarStore`
- treat it as the canonical local calendar layer
- sync external calendars into it through adapters
- allow local-only objects to live there as well

Suggested calendar model:

- `CalendarSourceConnection`
- `CalendarFeed`
- `CalendarEvent`
- `TimeBlock`
- `Reminder`
- `HabitBlock`
- `MeetingContextRef`

Source adapters:

- Google Calendar
- Microsoft 365 Calendar

Later source adapters:

- Teams meeting context
- Google Meet context
- Zoom meeting context

This creates a true built-in calendar without making Guardian reimplement every provider feature from day one.

---

## Search And Retrieval Strategy

Second Brain should use Guardian's existing search capabilities much more aggressively.

## Search should power

- note search
- library search
- event prep retrieval
- people context retrieval
- routine context assembly
- active assistant "why this matters" explanations

## Recommended retrieval model

Blend:

- structured entity search
- document search over the library
- provider search where available
- distilled memory retrieval

Potential user-facing search behaviors:

- one global Second Brain search bar
- event-specific "search related context"
- people-specific "show relevant notes and messages"
- assistant-generated evidence bundles for briefs

This is the right place to leverage the existing SearchService and collection system instead of creating a parallel knowledge feature.

---

## People, Outreach, And Social

There is already reusable work in the repo for contacts and campaigns.

That should not stay isolated as "marketing-only" forever.

## Recommended reuse path

### People / CRM

Use the current contact and campaign substrate as the seed for:

- People records
- relationship notes
- outreach history
- follow-up reminders

Long-term recommendation:

- evolve the current `MarketingStore` into a broader relationship or people domain
- keep personal CRM and bulk-campaign behavior logically distinct

### Outreach

The existing campaign tools and outreach skill can support:

- personal follow-up campaigns
- light networking workflows
- event and relationship follow-up batches

### Social and content

Second Brain should plan for:

- social content research
- draft generation
- content calendar planning
- approval-gated posting

Recommended initial scope:

- research
- draft
- schedule
- review

Not:

- broad autonomous posting

Useful references:

- Postiz for social scheduling patterns
- the existing `forum_post` and external-post approval model for safety semantics
- the automation authoring layer, which already recognizes newsletter and LinkedIn-style workflows

Potential later channels:

- LinkedIn
- X
- Mastodon
- Bluesky
- Threads

---

## Cross-Channel Sync And Continuity

Second Brain must be one coherent assistant across:

- web
- CLI
- Telegram

This needs two different things:

## 1. Shared canonical personal data

Notes, tasks, calendar objects, people, routines, and briefing packets should be stored once and surfaced everywhere.

## 2. Shared conversational continuity

The same user should be able to continue the same Second Brain thread across channels with:

- continuity state
- blockers
- focus summary
- relevant pending actions

Guardian is already heading this direction through its continuity-thread and pending-action design. Second Brain should explicitly depend on that shared model rather than inventing new channel-specific resume logic.

Recommended channel posture:

- web is the richest editing and dashboard surface
- CLI is strong for capture, review, and power workflows
- Telegram is strong for quick capture, notifications, approvals, and brief digests

Routine delivery should support:

- web only
- web plus Telegram
- web plus CLI
- all linked surfaces where appropriate

---

## Intent Gateway And Routing Options

The user's routing concern is valid.

If Second Brain becomes a real product area, the current route split will start to feel wrong.

Today, personal-assistant-shaped requests are spread across:

- `email_task`
- `workspace_task`
- `memory_task`
- `general_assistant`

That creates ambiguity once the system needs to distinguish:

- personal-assistant intent
- technical / operational intent
- coding intent

## Option 1: Keep current split routes and add more entities

Pros:

- smallest immediate change

Cons:

- personal intent stays scattered
- Dashboard / Second Brain cannot get a clean deterministic lane

## Option 2: Add a dedicated personal-assistant route

Recommended internal name:

- `personal_assistant_task`

Alternative if we want product-language symmetry:

- `second_brain_task`

Pros:

- clear personal-vs-technical delineation
- cleaner direct routing for notes, tasks, calendar, people, briefs, and routines
- easier to build a coherent Second Brain lane

Cons:

- larger routing change
- needs careful entity and dispatch design

## Option 3: Route by UI surface instead of intent

Pros:

- superficially simple

Cons:

- wrong abstraction
- CLI and Telegram must still understand the same personal intent
- violates the gateway-first design if overused

## Recommendation

Adopt **Option 2** in the target state.

Use:

- `personal_assistant_task` as the internal route
- `Second Brain` as the user-facing product label

Recommended route ownership:

- calendar
- tasks
- notes
- people
- reminders
- routines
- briefing and prep flows
- most user-facing email/calendar assistant flows

Recommended retained specialized routes:

- `coding_task`
- `coding_session_control`
- `security_task`
- `filesystem_task`
- `browser_task`
- `automation_authoring`
- `automation_control`

Recommended treatment of current email and workspace routes:

- `email_task` should largely collapse into the personal-assistant lane for user-facing mail/calendar work
- `workspace_task` should remain for explicit document system and workspace CRUD, enterprise content work, and provider-specific file operations
- the personal-assistant lane can still call Google, Microsoft, Notion, or search tools under the hood when assembling a brief

That gives the clear delineation the user asked for:

- personal assistant work
- technical and operational work

### Required implementation touchpoints

If this route is added, it must follow the repo's intent-gateway rules:

- add route to `IntentGatewayRoute`
- update the gateway tool schema and prompt
- update normalization
- update `preferredCandidatesForDecision`
- add dispatch wiring in `src/index.ts`
- update the routing spec

---

## Recommended Built-In Second Brain Tools

Second Brain should not be powered only by free-form chat.

Recommended bounded tools:

- `sb_task_create`
- `sb_task_update`
- `sb_task_list`
- `sb_note_create`
- `sb_note_update`
- `sb_note_search`
- `sb_calendar_list`
- `sb_calendar_upsert`
- `sb_people_list`
- `sb_people_update`
- `sb_reminder_create`
- `sb_brief_generate`
- `sb_routine_install`
- `sb_routine_update`
- `sb_library_link`

These should sit on top of proper runtime services rather than directly on memory.

Recommended new runtime area:

- `src/runtime/second-brain/`

Possible modules:

- `calendar-store.ts`
- `task-store.ts`
- `note-store.ts`
- `people-store.ts`
- `reminder-store.ts`
- `briefing-service.ts`
- `routine-service.ts`
- `library-link-service.ts`
- `second-brain-search.ts`

---

## Web Surface Changes

Recommended long-term web changes:

- replace the main nav entry in [web/public/index.html](../../web/public/index.html) with `Second Brain`
- add `web/public/js/pages/second-brain.js`
- add Second Brain API types in `src/channels/web-types.ts`
- add Second Brain API routes in `src/channels/web-runtime-routes.ts`

Recommended Dashboard transition:

- current dashboard runtime cards should move to their natural owner pages
- if a global summary is still needed, add a compact `Operations` view later
- do not keep the current operator summary as the product's primary home

---

## Open Source Borrowing Map

Guardian should borrow selectively.

## Strong references for this direction

### AppFlowy / AFFiNE

Use for:

- integrated workspace patterns
- note and database interaction
- local-first product thinking

### Joplin

Use for:

- note portability
- import/export
- clipper and attachment flows

### Super Productivity

Use for:

- task model
- timeboxing
- focused daily planning

### Monica

Use for:

- personal CRM patterns
- relationship reminders
- people-centric workflows

### ActivityWatch

Use for:

- optional passive context capture
- local-first activity timelines

### Postiz

Use for:

- content calendar and social scheduling ideas
- review-before-posting workflows

### FullCalendar

Use for:

- calendar rendering
- agenda and multi-view UI

### mem0

Use for:

- layered memory and distillation patterns

## Licensing caution

Direct code reuse must be deliberate.

Recommendation:

- treat most of these primarily as product and architecture references
- only adopt permissively licensed components after explicit license review

---

## Delivery Phases

These phases are **not** throwaway v1 work.

They are delivery slices against a fixed target-state architecture.

## Phase 0: Lock The Target State

Deliver:

- IA decision
- route decision
- data model decision
- Second Brain page contract
- built-in calendar model
- personal routine model
- usage and budget model

## Phase 1: Core Second Brain Shell

Deliver:

- Second Brain top-level page
- Today, Calendar, Tasks, Notes, Library, Routines
- built-in calendar aggregation layer
- built-in tasks, reminders, notes
- shared cross-channel data access
- personal route in intent gateway
- user-visible Second Brain usage surfaces

## Phase 2: Active Assistant Behavior

Deliver:

- morning brief
- pre-meeting brief
- weekly review
- follow-up watch
- retrieval-backed briefing pipeline
- evidence bundles and cross-linked context
- per-routine budget enforcement and downgrade behavior

## Phase 3: People And Relationship Intelligence

Deliver:

- People tab
- merged contact model
- relationship reminders
- outreach-aware workflows
- commitment tracking by person

## Phase 4: Content, Social, And Rich Meeting Assistants

Deliver:

- content and social routines
- approval-gated posting integrations
- Teams / Zoom / Meet planning hooks
- richer meeting context pack generation

## Phase 5: Optional Passive Intelligence

Deliver:

- opt-in activity timeline
- project and topic drift detection
- richer contextual resurfacing

---

## Risks And Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Split identity between ops product and assistant product | users land in the wrong place | make Second Brain the primary home |
| Mixing notes with memory | retrieval and trust become messy | keep structured stores and durable memory separate |
| Over-automation | an "alive" assistant can become annoying | routines are configurable, bounded, and explainable |
| Invisible token spend | proactive routines can become costly or surprising | local-first execution, routine budgets, downgrade paths, and visible usage reporting |
| Routing ambiguity | personal and technical work overlap | add a dedicated personal-assistant route |
| Calendar complexity | full calendar parity is large | use a canonical local layer with sync adapters |
| Social/posting risk | outbound posting is high impact | draft-first, approval-gated, explicit external-post semantics |
| Channel drift | web, CLI, and Telegram diverge | use shared stores and shared continuity/orchestration |

---

## Final Recommendation

Guardian should stop treating the personal-assistant direction as an add-on and make it a first-class product:

- call it **Second Brain**
- make it the entry point
- give it a built-in calendar, tasks, notes, people, library, and routines
- separate its data model from durable memory while reusing the same retrieval and distillation intelligence
- add a dedicated personal-assistant intent lane
- build proactive, editable assistant routines that make the system feel alive
- make model usage and external spend visible, controllable, and local-first where possible

The right end state is not:

- "Dashboard with an organizer tab"

The right end state is:

- "Second Brain is the product home, and Guardian's secure runtime powers it underneath"

If we do this properly, Guardian will feel less like an operator console with a chat box and more like a real assistant that actively helps the user stay prepared.
