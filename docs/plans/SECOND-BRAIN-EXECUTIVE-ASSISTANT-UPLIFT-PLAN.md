# Second Brain Executive Assistant Uplift Plan

**Date:** 2026-04-08  
**Status:** Draft  
**Origin:** Follow-up plan after the current `Second Brain` implementation pass, routine lifecycle testing, and UX review of the `Routines` surface  
**Primary related plans:** [Second Brain Implementation Plan](./SECOND-BRAIN-IMPLEMENTATION-PLAN.md), [Cross-Surface Continuity Uplift Plan](./CROSS-SURFACE-CONTINUITY-UPLIFT-PLAN.md), [Background Delegation Uplift Plan](./BACKGROUND-DELEGATION-UPLIFT-PLAN.md)  
**Primary as-built reference:** [Second Brain As-Built Specification](../specs/SECOND-BRAIN-AS-BUILT-SPEC.md)  
**Key files:** `src/runtime/second-brain/second-brain-service.ts`, `src/runtime/second-brain/briefing-service.ts`, `src/runtime/second-brain/horizon-scanner.ts`, `src/runtime/second-brain/sync-service.ts`, `src/runtime/second-brain/types.ts`, `src/runtime/assistant-jobs.ts`, `src/runtime/notifications.ts`, `src/tools/builtin/second-brain-tools.ts`, `src/chat-agent.ts`, `src/channels/web-types.ts`, `src/channels/web.ts`, `web/public/js/pages/second-brain.js`, `src/reference-guide.ts`  
**Primary specs impacted:** `docs/specs/SECOND-BRAIN-AS-BUILT-SPEC.md`, `docs/specs/WEBUI-DESIGN-SPEC.md`, `docs/specs/ORCHESTRATION-SPEC.md`, `docs/specs/PENDING-ACTION-ORCHESTRATION-SPEC.md`

---

## Goal

Evolve `Second Brain` from a bounded personal record surface into a clearer executive-assistant product area that:

- feels proactive rather than passive
- communicates useful outcomes back to the user instead of only saving artifacts
- exposes a simple routine model based on capability plus timing
- uses shared runtime delivery and orchestration instead of bespoke routine-side notification logic
- defaults user-facing proactive delivery to Telegram, with web and CLI treated as secondary operator-facing surfaces

This plan is not about making `Second Brain` an autonomous general agent. It is about making the existing bounded assistant behavior feel connected, useful, and legible.

---

## Why This Uplift Is Needed

The current `Second Brain` implementation is functional, but it still behaves more like a local record store with helper jobs than an executive assistant.

The main gaps are:

- the `Routines` UI exposes backend mechanics such as trigger modes, lookahead windows, routing bias, and budget profile IDs
- the user-facing routine model is weakly defined; it mirrors implementation detail instead of expressing intent
- user-facing routines and maintenance routines are mixed together
- successful routine runs mostly save output rather than proactively communicating the result
- delivery expectations are unclear across Telegram, web, and CLI
- `starter routine` and `catalog` language makes the system feel more like a fixture browser than an assistant configuration surface

The result is a product that works, but does not yet feel like:

- "Guardian knows what it is doing for me"
- "Guardian tells me when something useful is ready"
- "Guardian behaves like an assistant with bounded initiative"

---

## Product Direction

The target `Second Brain` experience should feel like:

- a personal assistant for planning, follow-up, and preparation
- a shared memory and retrieval layer for personal context
- a bounded proactive system that surfaces useful outputs at the right moment

The target experience should not feel like:

- a generic automation builder
- a raw scheduler editor
- a backend policy control panel
- a passive database that only becomes useful when the user manually asks for everything

---

## Design Principles

1. User-facing routines should be defined by what they do, not by backend trigger internals.
2. Proactive communication should use shared runtime delivery paths, not one-off routine code.
3. Telegram should be the default user-facing notification channel for assistant outcomes.
4. Web and CLI should stay strong operator surfaces, but should not be the assumed default place for proactive assistant delivery.
5. Maintenance work should stay quiet unless it needs operator attention.
6. Every routine run should produce a bounded outcome contract that explains what happened and whether the user should be notified.
7. Advanced implementation detail should either be derived internally or moved to an explicit advanced/operator lane.
8. User-authored routines should be possible, but only through bounded assistant capability modules rather than arbitrary workflow scripting.

---

## Non-Goals

- turning `Second Brain` into an unrestricted open-ended agent platform
- replacing `Automations` as the advanced workflow surface
- pushing every maintenance event to Telegram
- exposing raw cron, routing bias, model policy, or budget profile controls in the default routine UX
- inventing a second notification stack outside the shared runtime
- turning `Second Brain` routines into a duplicate of unrestricted `Automations`

---

## Current Problems To Solve

### 1. Routine abstraction is backwards

The current public routine model is too close to the storage model. It exposes:

- `cron`
- `event` vs `horizon`
- `lookaheadMinutes`
- `budgetProfileId`
- `defaultRoutingBias`
- workload and external communication metadata

These are implementation concerns. They are not the operator mental model.

### 2. Routine setup is not capability-first

The operator should be choosing:

- what Guardian should do
- when Guardian should do it
- where Guardian should tell me about it

The current system instead starts from templates and internal mechanics.

### 3. Proactive assistant behavior is underdefined

Today, routines often save a brief or mark a run, but the assistant feel depends on delivery. The missing contract is:

- when to notify
- what to say
- where to deliver it
- what user actions should be attached

### 4. Maintenance and assistant outcomes are conflated

`Manual Sync` and related upkeep behavior are maintenance concerns. `Morning Brief` and `Pre-Meeting Brief` are user-facing assistant outputs. These should not share one undifferentiated routine model.

### 5. Channel intent is unclear

For `Second Brain`, the channel roles should be:

- Telegram: default user-facing assistant delivery
- Web: full review, editing, and operator visibility
- CLI: local operator and debugging surface

The current product does not clearly enforce that distinction.

### 6. The current routine set is too fixed

The current implementation is heavily tied to a predefined set of routines. That is acceptable for a first bounded release, but it is too rigid for the intended assistant experience.

Users should be able to express bounded assistant intents such as:

- `message me when I have something due tomorrow`
- `send me a prep note before meetings with Jordan`
- `tell me when anything in my notes or tasks mentions Harbor launch`
- `message me when a meeting ends and there is no follow-up draft yet`

Those should become supported `Second Brain` routines without requiring each one to be hard-coded as a separate bespoke product feature.

---

## Target Model

### A. Capability-first routine model

The public routine concept should be:

- `Capability`
- `Timing`
- `Delivery`
- `Enabled`

Recommended user-facing capability types:

- `Morning Brief`
- `Weekly Review`
- `Pre-Meeting Brief`
- `Follow-Up Draft`
- `Deadline Watch`
- `Daily Agenda Check`
- `Sync Calendar And Contacts` or a separate explicit sync control

Recommended timing types:

- `Manual`
- `Scheduled`
- `Before meetings`
- `After meetings`

Recommended delivery types:

- `Telegram`
- `Web`
- `CLI`

The default should be:

- user-facing assistant routines: `Telegram` plus optionally `Web`
- maintenance routines: no proactive delivery unless there is an issue

### B. Outcome contract for every routine run

Each routine run should produce a bounded runtime outcome with:

- `kind`: brief, draft, sync_result, signal, or none
- `summary`: one human-readable sentence or short paragraph
- `artifactRefs`: brief ids, event ids, task ids, or other linked records
- `importance`: silent, useful, urgent
- `deliveryMode`: save_only, web_notice, telegram_notice, multi_channel
- `followUpActions`: open_brief, dismiss, snooze, regenerate, run_now

This outcome object should become the canonical bridge from routine execution to assistant communication.

### C. Split user-facing routines from maintenance routines

Recommended groups:

User-facing assistant routines:

- `Morning Brief`
- `Weekly Review`
- `Pre-Meeting Brief`
- `Follow-Up Draft`
- `Deadline Watch`

Silent or mostly silent maintenance routines:

- provider sync
- routine scan / horizon scan
- indexing or background hygiene

`Manual Sync` should likely stop being presented as a routine and become a direct action.

### D. User-authored modular routines

`Second Brain` should support user-authored routines, but through a bounded modular model rather than arbitrary free-form automation authoring.

The target operator experience should be closer to:

- `Watch for`
- `Check`
- `If true`
- `Do this`
- `Tell me here`

Recommended public building blocks:

- `Trigger`
  - scheduled
  - before meeting
  - after meeting
  - after sync
- `Scope`
  - tasks
  - notes
  - briefs
  - people
  - calendar
  - library
  - cross-entity
- `Condition`
  - mentions topic
  - overdue or due soon
  - meeting with person
  - no follow-up exists
  - any new relevant item
- `Action`
  - generate brief
  - generate follow-up draft
  - summarize findings
  - notify me
  - save artifact and notify me
- `Delivery`
  - Telegram
  - web
  - CLI

This keeps the product modular while staying inside a bounded `Second Brain` capability set.

The key rule is:

- `Second Brain` routines may be user-authored from supported assistant modules
- unrestricted multi-step arbitrary logic still belongs in `Automations`

---

## Canonical Capability Sequences

The next implementation wave should define the actual task sequences behind each supported assistant capability.

The same sequence model should also support user-authored modular routines. A user-authored routine should compile into one of these bounded capability graphs rather than into arbitrary scripting.

### Morning Brief

Sequence:

1. gather today and near-term events
2. gather open and due-soon tasks
3. gather recent notes
4. gather relevant people and follow-up pressure
5. gather recent or relevant saved library items
6. synthesize deterministic brief
7. persist brief
8. deliver proactive summary if configured

User-facing settings:

- scheduled time
- delivery channels
- enabled

### Weekly Review

Sequence:

1. gather next 7 days of events
2. gather current tasks and deadlines
3. gather recent notes and relationship context
4. gather useful library references
5. synthesize weekly review
6. persist brief
7. deliver proactive summary if configured

User-facing settings:

- scheduled day and time
- delivery channels
- enabled

### Pre-Meeting Brief

Sequence:

1. identify upcoming events inside the configured meeting-prep window
2. gather related tasks, notes, people, and library items
3. synthesize pre-meeting brief
4. persist brief
5. proactively notify the user with a short meeting-prep message

User-facing settings:

- how long before the meeting to prepare it
- delivery channels
- enabled

### Follow-Up Draft

Sequence:

1. identify recently ended events inside the configured follow-up window
2. skip events that already have a follow-up artifact
3. gather related tasks, notes, people, and library items
4. synthesize follow-up draft
5. persist draft
6. proactively notify the user that a draft is ready

User-facing settings:

- how long after a meeting to watch for follow-up
- delivery channels
- enabled

### Deadline Watch

Sequence:

1. scan tasks for due-soon or overdue pressure
2. build a short grouped summary
3. optionally save a small signal artifact or direct assistant message
4. notify only when there is actionable pressure

User-facing settings:

- cadence
- urgency threshold
- delivery channels
- enabled

### Sync Calendar And Contacts

Sequence:

1. run provider sync
2. reconcile local-first records
3. record sync result and conflicts
4. stay silent on success
5. notify on failure or conflict requiring attention

User-facing settings:

- manual action or background maintenance policy
- failure delivery channels

This may belong outside `Routines` entirely.

---

## Modular Capability Framework

To support user-authored routines without turning `Second Brain` into a second automation platform, the runtime should expose a bounded modular capability layer.

### Capability module categories

Recommended categories:

- retrieval modules
  - gather tasks
  - gather notes
  - gather people
  - gather events
  - gather library items
  - gather related records about a topic or person
- condition modules
  - due soon
  - overdue
  - meeting coming up
  - meeting ended
  - follow-up missing
  - mentions topic
  - changed since last run
- synthesis modules
  - summarize
  - generate brief
  - generate follow-up draft
  - generate agenda or prep note
- delivery modules
  - send Telegram note
  - show web notice
  - save brief only
  - save note and notify

### Example user-authored routines

Examples of supported bounded authoring:

- `Every weekday at 7 a.m., send me a morning summary on Telegram.`
- `One hour before meetings with Jordan Lee, send me a prep brief on Telegram.`
- `At 5 p.m., tell me what tasks mention Harbor launch.`
- `After meetings, draft a follow-up and message me if one is ready.`
- `Each morning, message me if anything due today mentions tax.`

Examples that should still route to `Automations` instead:

- `When a meeting ends, look up Salesforce, update HubSpot, draft an email, and post a Slack summary`
- `Watch five SaaS systems and run a branching workflow based on the result`
- `Call arbitrary tools in a custom sequence`

### Compile target

User-authored routines should compile into a bounded internal representation such as:

- `trigger`
- `scope`
- `condition`
- `sequence`
- `output`
- `delivery`

The runtime should then map that internal representation onto the shared `Second Brain` services, assistant job tracking, and delivery surfaces.

---

## Telegram-First Delivery Model

For user-facing `Second Brain` assistant behavior, Telegram should become the default proactive delivery channel.

Rationale:

- it matches the "assistant messaging me" mental model
- it is better suited to lightweight proactive nudges than a web operator dashboard
- it separates assistant communication from the heavier operator surfaces

Default delivery policy:

- user-facing assistant routines default to Telegram
- web remains available for review and artifact inspection
- CLI remains available for local operator visibility
- maintenance routines do not notify by default
- user-authored `notify me when ...` routines default to Telegram unless the operator explicitly chooses another channel

Guardrails:

- no proactive Telegram delivery unless Telegram is configured and allowed
- if Telegram is unavailable, fall back to web notice rather than failing silently
- operator can opt out or choose `web only`
- high-noise events must not notify by default

Recommended examples:

- "Your pre-meeting brief for Harbor launch review is ready."
- "I drafted a follow-up for the Jordan Lee meeting."
- "Your weekly review is ready: 3 deadlines and 2 meetings need attention."

---

## Shared Runtime Requirements

This uplift should be implemented on top of shared runtime primitives, not routine-local hacks.

### 1. Shared outcome and delivery contract

Routine execution should emit a bounded outcome object that can be:

- stored in assistant job history
- rendered in web status views
- converted into Telegram or web notices
- associated with follow-up actions

### 2. Assistant job integration

Routine runs should integrate with the assistant job model in a more explicit way so the runtime can explain:

- what ran
- what artifact was produced
- whether the user was notified
- what the next relevant user action is

### 3. Notification and channel integration

Proactive `Second Brain` delivery should reuse the shared notification and channel infrastructure where possible, while allowing `Second Brain`-specific presentation and severity rules.

### 4. Continuity-aware follow-up

If the user opens a brief or responds from Telegram or web, the follow-up should bind back to the relevant local `Second Brain` record or assistant outcome rather than creating a detached thread.

---

## UX Uplift Requirements

The `Routines` page should be redesigned around the target model.

### Remove

- summary cards at the top
- budget profile controls
- routing bias controls
- workload and external communication readouts
- generic backend trigger labels
- `starter routine` and `catalog` language in the primary UX

### Add

- a capability-first create or edit flow
- a schedule builder similar to the `Automations` cadence picker
- contextual timing labels such as `Before meetings` and `After meetings`
- delivery selection with Telegram-first defaults
- clearer distinction between assistant routines and quiet maintenance behavior

### Simplify the table

Recommended columns:

- `Routine`
- `When`
- `Delivery`
- `Status`
- `Last run`
- `Actions`

The left pane should own creation and editing. The primary create action should live there, not in the table header.

---

## Documentation Uplift Requirements

The following user-facing shifts should be reflected once implementation lands:

- `Second Brain` should be described as a proactive assistant surface, not only a planning store
- `Routines` should be described in terms of capabilities and timing, not starter templates and internal trigger settings
- Telegram should be documented as the default assistant delivery channel when configured
- maintenance behavior should be clearly described as quieter than user-facing assistant routines

---

## Proposed Phases

### Phase 1: Capability and sequence model

Define the canonical assistant capability matrix:

- supported routines
- supported modular routine building blocks
- sequence of retrieval and synthesis steps
- records read
- records written
- meaningful user-facing settings
- default delivery behavior

Deliverables:

- canonical routine capability table
- modular routine authoring matrix
- decision on which current routines stay, rename, move, or disappear
- clear split between assistant routines and maintenance flows

### Phase 2: Shared outcome and delivery contract

Add the bounded routine outcome model:

- artifact references
- summary
- importance
- delivery mode
- follow-up actions

Deliverables:

- runtime outcome type
- assistant job integration
- shared delivery adapter contract

### Phase 3: Telegram-first proactive delivery

Implement proactive delivery defaults:

- Telegram-first for user-facing routines
- web fallback when Telegram is unavailable
- quiet-by-default maintenance handling

Deliverables:

- channel policy for `Second Brain` outcomes
- user-visible delivery settings
- guardrails for noise and duplicates

### Phase 4: Routine tooling uplift

Refactor the public routine tooling and service contract so the operator-facing model is no longer raw trigger internals.

Deliverables:

- public routine DTO based on capability, timing, delivery, enabled
- bounded modular user-authored routine DTO
- internal translation layer into existing execution primitives
- simplified create or update tool parameters

### Phase 5: Web UI redesign

Replace the current routines page with the new interaction model.

Deliverables:

- left-pane create or edit surface
- simplified configured-routines list
- contextual timing controls
- delivery-first configuration
- modular `message me when ...` builder for supported assistant capabilities

### Phase 6: Chat, docs, and test alignment

Update every user-facing surface to the new model.

Deliverables:

- chat routine read and mutation language
- reference guide updates
- spec updates
- manual and automated test coverage for proactive delivery and routine lifecycle

---

## Migration Notes

- existing persisted routines will need translation into the new public model
- internal trigger data may remain richer than the public DTO during migration
- default seeded routines should be reevaluated before migration is finalized
- `Manual Sync` should likely be migrated into a direct action rather than preserved as a visible routine

---

## Open Questions

1. Should `Sync` remain visible in `Routines`, or move to an explicit `Sync now` control plus silent background maintenance?
2. Should `Next 24 Hours Radar` survive as a user-visible routine, or be replaced with a clearer assistant-facing capability such as `Daily Agenda Check`?
3. Should `Deadline Watch` create saved artifacts, or only proactive notices?
4. Should Telegram delivery default to Telegram-only or Telegram-plus-web for assistant routines?
5. Which follow-up actions should be available directly from Telegram messages versus only in web?
6. How much modular authoring should be exposed in the first user-facing routine builder without overwhelming the operator?

---

## Recommended Immediate Next Step

Before redesigning the page, define the canonical `Second Brain` capability matrix and the routine outcome contract.

The implementation order should be:

1. capability sequences
2. outcome and delivery contract
3. tooling uplift
4. UI redesign
5. docs and tests

This keeps the UX redesign grounded in the real assistant model instead of designing around the current storage schema.
