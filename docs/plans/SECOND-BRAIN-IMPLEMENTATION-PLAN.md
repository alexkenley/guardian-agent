# Second Brain Implementation Plan

**Date:** 2026-04-04
**Status:** Draft
**Origin:** Follow-up implementation plan for the `Second Brain` proposal and subsequent design decisions on budgeting, scheduler execution, and intent boundaries
**Primary proposal:** [Second Brain Proposal](../implemented/SECOND-BRAIN-PROPOSAL.md)
**Key files:** `src/runtime/intent-gateway.ts`, `src/runtime/direct-intent-routing.ts`, `src/chat-agent.ts`, `src/index.ts`, `src/runtime/scheduled-tasks.ts`, `src/runtime/scheduler.ts`, `src/runtime/budget.ts`, `src/runtime/continuity-threads.ts`, `src/runtime/analytics.ts`, `src/google/google-service.ts`, `src/microsoft/microsoft-service.ts`, `src/search/search-service.ts`, `src/tools/executor.ts`, `src/tools/builtin/contacts-email-tools.ts`, `src/tools/marketing-store.ts`, `src/skills/prompt.ts`, `src/skills/resolver.ts`, `src/channels/web-types.ts`, `src/channels/web-runtime-routes.ts`, `web/public/index.html`, `web/public/js/app.js`, `web/public/js/pages/dashboard.js`
**Primary specs impacted:** `docs/guides/CAPABILITY-AUTHORING-GUIDE.md`, `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`, `docs/design/ORCHESTRATION-DESIGN.md`, `docs/design/PENDING-ACTION-ORCHESTRATION-DESIGN.md`, `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`, `docs/design/INTELLIGENCE-IN-DEPTH-DESIGN.md`, `docs/design/IDENTITY-MEMORY-DESIGN.md`, `docs/design/SKILLS-DESIGN.md`, `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md`, `docs/design/WEBUI-DESIGN.md`, `docs/design/TRUST-PRESETS-DESIGN.md`, `docs/plans/CROSS-SURFACE-CONTINUITY-UPLIFT-PLAN.md`, `docs/plans/CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md`, `docs/plans/MEMORY-SYSTEM-UPLIFT-PLAN.md`, `docs/plans/MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md`, `docs/archive/plans/SKILLS-PROGRESSIVE-DISCLOSURE-UPLIFT-PLAN.md`

---

## Goal

Implement `Second Brain` as Guardian's primary personal-assistant product area without introducing a second orchestration stack, a second scheduling system, or a second budget tracker.

The target outcome is:

- `Second Brain` replaces `Dashboard` as the main entry point in the web UI
- personal productivity flows get a dedicated runtime lane
- notes, tasks, contacts, calendar, routines, briefs, and library become first-class product objects
- background assistant behavior is server-owned, deterministic where possible, and local-first when a local model exists
- external spend is visible, attributable, capped, and graceful under budget pressure
- web, CLI, and Telegram share one canonical `Second Brain` data model and continuity model

---

## Assumptions

1. The recent cross-channel continuity issue has been rectified and the shared continuity model remains the foundation for `Second Brain`.
2. `Second Brain` builds on the existing Intent Gateway, pending-action flow, scheduler, and shared response metadata.
3. Google Workspace and Microsoft 365 integrations remain shared connector infrastructure. The change is in routing and product ownership, not duplicate provider stacks.
4. Durable memory remains separate from ordinary personal notes and tasks.
5. Existing scheduled-task infrastructure remains the primary server-owned automation substrate.

---

## Non-Goals

- rebuilding Google Calendar or Microsoft 365 feature-for-feature
- replacing the generic `Automations` surface with `Second Brain`
- storing raw notes directly in durable memory
- making every background check an open-ended agent turn
- autonomous sending/posting by default
- introducing pre-gateway regex routing for personal vs technical intent

---

## Confirmed Decisions

### Product and IA

- `Second Brain` is the product name
- `Second Brain` becomes the main web home
- `Dashboard` is only a migration alias if needed
- `Automations` remains a separate advanced/power-user surface
- `Routines` inside `Second Brain` is the simplified personal automation surface

### Routing

- add a dedicated internal route: `personal_assistant_task`
- most user-facing productivity flows on Google Workspace and Microsoft 365 route into that lane
- connectors stay shared; route ownership changes

### Execution

- regular checks are backend-owned scheduler/horizon work
- deterministic checks should not require LLM calls
- agent-style synthesis runs only when a routine trigger actually needs a brief, digest, or draft

### Budgeting

- local-first when a local model exists
- external spend is capped and user-visible
- routines carry explicit budget profiles
- proactive work must degrade gracefully before overspending

---

## Target Architecture

`Second Brain` should be implemented as a first-class runtime domain under:

`src/runtime/second-brain/`

Recommended modules:

- `second-brain-service.ts`
- `second-brain-store.ts`
- `calendar-store.ts`
- `task-store.ts`
- `note-store.ts`
- `people-store.ts`
- `library-store.ts`
- `routine-store.ts`
- `briefing-service.ts`
- `sync-service.ts`
- `horizon-scanner.ts`
- `usage-service.ts`
- `budget-policy.ts`
- `route-service.ts`

Recommended tool and API surfaces:

- `src/tools/builtin/second-brain-tools.ts`
- `src/channels/web-types.ts`
- `src/channels/web-runtime-routes.ts`
- `web/public/js/pages/second-brain.js`

### Storage model

Use the same SQLite-backed runtime pattern already used for analytics, continuity, pending actions, and conversations.

Recommended persistence:

- SQLite primary store when `node:sqlite` is available
- in-memory fallback for degraded runtimes only
- document bodies and attachments indexed through existing search infrastructure

Recommended database families:

- `assistant-second-brain.sqlite`
- existing search index storage remains separate

Recommended top-level entities:

- `sb_notes`
- `sb_tasks`
- `sb_people`
- `sb_events`
- `sb_reminders`
- `sb_routines`
- `sb_briefs`
- `sb_links`
- `sb_usage_records`
- `sb_sync_cursors`

### Layered data model

Layer 1: structured `Second Brain` entities

- notes
- tasks
- contacts
- reminders
- calendar events and local calendar objects
- routine definitions
- briefing packets

Layer 2: library and retrieval index

- attachments
- saved pages
- imported docs
- synced file references
- transcript artifacts

Layer 3: durable memory

- preferences
- standing instructions
- long-lived facts
- curated summaries

Promotion into durable memory stays explicit and selective.

---

## Runtime Execution Model

The backend should own `Second Brain` maintenance and proactive behavior. It should not repeatedly spin up free-form agent turns just to see whether anything changed.

### Core rule

Use this flow:

1. sync or receive provider changes
2. run deterministic horizon checks
3. evaluate routine triggers
4. assemble evidence deterministically
5. invoke LLM synthesis only when needed
6. store and deliver the result

### Scheduler model

Reuse the existing scheduler and scheduled-task service:

- cron triggers through `CronScheduler`
- event triggers through `ScheduledTaskService` + `EventBus`
- runtime-owned startup through `Runtime.start()`

`Second Brain` should use three execution styles:

### 1. Deterministic maintenance jobs

Use for:

- sync cursor refresh
- calendar horizon scanning
- due-date checks
- stale follow-up detection
- library indexing
- reminder queue maintenance

Execution style:

- server-owned service methods
- zero LLM by default
- runs frequently

### 2. Routine trigger jobs

Use for:

- `Morning Brief`
- `Next 24 Hours Radar`
- `Weekly Review`
- `Pre-Meeting Brief`
- `Follow-Up Watch`

Execution style:

- deterministic context assembly first
- brief synthesis only when a trigger fires
- backed by scheduled-task definitions plus `Second Brain` manifests

### 3. Premium synthesis or draft jobs

Use for:

- research-enhanced meeting briefs
- post-meeting follow-up drafts
- outreach review drafts
- social draft queue

Execution style:

- bounded agent or bounded tool-backed synthesis
- local-first if possible
- external only when justified by policy or routing

### What should not happen

Do not run a generic chat-agent turn every 5 minutes to ask whether anything interesting happened.

Instead:

- poll or receive source changes
- compute trigger conditions deterministically
- only enqueue synthesis work for actual triggered routines

---

## Routine Model

`Second Brain > Routines` should be backed by explicit manifests, not opaque hardcoded behavior.

Recommended manifest shape:

```ts
interface SecondBrainRoutineManifest {
  id: string;
  name: string;
  category: 'daily' | 'meeting' | 'follow_up' | 'contacts' | 'content' | 'maintenance';
  enabledByDefault: boolean;
  trigger: {
    mode: 'cron' | 'event' | 'horizon' | 'manual' | 'hybrid';
    cron?: string;
    eventType?: string;
    lookaheadMinutes?: number;
  };
  workloadClass: 'A' | 'B' | 'C' | 'D';
  externalCommMode: 'none' | 'draft_only' | 'send_with_approval' | 'post_with_approval';
  budgetProfileId: string;
  deliveryDefaults: Array<'web' | 'cli' | 'telegram'>;
  defaultRoutingBias: 'local_first' | 'balanced' | 'quality_first';
}
```

Recommended built-in routine sets:

- daily: `Morning Brief`, `Evening Wrap`, `Next 24 Hours Radar`
- weekly: `Weekly Review`
- meeting: `Pre-Meeting Brief`, `Post-Meeting Follow-Up`, `Travel / Event Prep`
- follow-up: `Follow-Up Watch`, `Commitment Tracker`, `Deadline Guard`
- contacts: `Relationship Nudge`, `Outreach Review`
- content: `Content Calendar Review`, `Social Draft Queue`
- maintenance: calendar horizon scan, reminder refresh, stale-thread scan

### Routine ownership boundary

`Second Brain` routines are:

- curated
- personal-assistant oriented
- editable but bounded
- backed by explicit budgets and output types

`Automations` are:

- general-purpose
- user-authored
- not restricted to personal productivity
- allowed to stay power-user centric

Use the same runtime substrate where appropriate, but keep the product surfaces and routing lanes separate.

---

## Token, Cost, And External Communication Governance

This is a first-class implementation area, not a later polish task.

### Definitions

The system must separately track:

- connector reads and sync activity
- LLM token usage
- user-visible outbound communications

For planning and reporting:

- connector read activity is not the same as outbound communication
- external communication means user-visible outward actions such as sending email, creating invites, posting social content, or dispatching messages

### Workload classes

| Class | Purpose | Default model posture | Typical token spend | Outbound comms |
|---|---|---|---|---|
| `A` | deterministic maintenance | none | `0` | none |
| `B` | cheap assistant synthesis | local-first | low | none or draft-only |
| `C` | premium synthesis | local-first with external escalation | medium | draft-only |
| `D` | research-enhanced premium work | external allowed only by policy | high | draft-only or approval-gated outbound |

### Initial routine inventory assumptions

Use these starting assumptions for estimation and product controls:

| Routine group | Approx count | Typical cadence | Tokens per check | Tokens per fired run | External comm capability |
|---|---|---|---|---|---|
| maintenance and horizon checks | `8-12` | every `5-60` min | `0` | `0` | none |
| brief and digest routines | `5-7` | daily, weekly, or event-driven | `0` | low to medium | none |
| draft-producing assistant routines | `3-5` | event-driven or daily | `0` until triggered | medium | yes, draft-only |
| autonomous outbound routines | `0` by default | n/a | n/a | n/a | disabled by default |

### Default external-communication posture

Default behavior:

- create drafts only
- do not send automatically
- do not post automatically
- require explicit approval for outbound send/post operations

Initial built-in routines that are communication-capable but draft-only by default:

- `Post-Meeting Follow-Up`
- `Follow-Up Watch`
- `Relationship Nudge`
- `Outreach Review`
- `Social Draft Queue`

### Forecasting model

Each routine should carry a forecast profile:

```ts
interface SecondBrainRoutineForecast {
  avgChecksPerDay: number;
  avgTriggersPerDay: number;
  avgLocalTokensPerRun: number;
  avgExternalTokensPerRun: number;
  avgOutboundActionsPerMonth: number;
  externalResearchRate: number;
}
```

Monthly forecast should be computed as:

- deterministic checks cost: connector activity only
- token forecast: triggered runs x average tokens by locality
- outbound forecast: triggered draft/send/post counts by routine

### User-visible usage controls

Expose:

- monthly external token budget
- daily external token budget
- per-routine token cap
- per-routine external research policy
- provider bias: `local_first`, `balanced`, `quality_first`, `external_only`
- quiet-budget mode
- pause-on-overage behavior

### Runtime budget attribution

Extend shared budget tracking rather than creating a second tracker.

Attribute usage by:

- route
- feature area
- routine id
- brief type
- provider
- locality
- principal

Recommended runtime record shape:

```ts
interface SecondBrainUsageRecord {
  timestamp: number;
  route: 'personal_assistant_task';
  featureArea: 'routine' | 'brief' | 'search' | 'draft' | 'maintenance';
  featureId?: string;
  provider?: string;
  locality: 'local' | 'external';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  connectorCalls?: number;
  outboundAction?: 'email_send' | 'email_draft' | 'calendar_update' | 'social_post' | 'social_draft';
}
```

### Degradation order

When budgets tighten:

1. skip external research
2. stay local if local exists
3. shrink lookback windows
4. generate shorter briefs
5. convert full briefs into lightweight digests
6. pause non-essential routines
7. request approval before exceeding policy

---

## Intent Gateway And Route Ownership

Add a dedicated route:

- `personal_assistant_task`

This route should own personal productivity intent regardless of whether the underlying provider is Google Workspace, Microsoft 365, local storage, or document search.

### Route ownership matrix

| User intent | Route | Notes |
|---|---|---|
| manage tasks, reminders, notes, contacts, calendar | `personal_assistant_task` | primary `Second Brain` lane |
| prepare me for a meeting | `personal_assistant_task` | includes provider reads and optional research |
| find context across my docs, emails, calendar, notes | `personal_assistant_task` | personal retrieval, not generic workspace CRUD |
| draft a follow-up email from meeting notes | `personal_assistant_task` | outbound still approval-gated |
| review my outreach queue or social drafts | `personal_assistant_task` | assistant-style drafting workflow |
| explicit provider file CRUD in Drive/OneDrive/SharePoint/Notion | `workspace_task` | not every provider call belongs to `Second Brain` |
| broad public web research | `search_task` | internet search remains its own route |
| generic automation authoring or editing | `automation_authoring` / `automation_control` | stays separate from `Routines` |
| coding, security, network, cloud | existing specialist routes | unchanged |
| durable memory curation and audit | `memory_task` | remains separate from personal notes |

### Practical connector split

Google Workspace and Microsoft 365 should be split by intent, not by provider.

Send these through `personal_assistant_task` when the user is doing:

- email follow-up
- meeting prep
- calendar planning
- contact context
- personal search across messages, docs, events, and notes
- assistant routines and briefs

Keep these outside `personal_assistant_task`:

- explicit workspace file operations
- generic enterprise content administration
- power-user automation authoring
- technical or operator tasks

### Required routing changes

Update:

- `src/runtime/intent-gateway.ts`
- `src/runtime/direct-intent-routing.ts`
- `src/chat-agent.ts`
- `src/index.ts`
- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`

Recommended new direct candidate:

- `personal_assistant`

That candidate should dispatch into a bounded `Second Brain` runtime service, not a prompt-only branch.

---

## Web Surface Plan

### Navigation

Replace the current top-level `Dashboard` nav entry with `Second Brain`.

Impacted files:

- `web/public/index.html`
- `web/public/js/app.js`
- `web/public/js/pages/dashboard.js`

Recommended transition:

- add `web/public/js/pages/second-brain.js`
- keep `#/` as the default route
- allow a temporary alias from `dashboard` to `second-brain`
- move current runtime summary content either into a smaller `Operations` card set or a later `Operations` page

### Second Brain page structure

Tabs:

- `Today`
- `Calendar`
- `Tasks`
- `Notes`
- `Contacts`
- `Library`
- `Routines`

Core widgets on `Today`:

- next event
- top tasks
- due reminders
- briefing queue
- follow-up queue
- quick capture
- usage badge

### Web API additions

Recommended endpoints:

- `GET /api/second-brain/overview`
- `GET /api/second-brain/calendar`
- `POST /api/second-brain/calendar/upsert`
- `GET /api/second-brain/tasks`
- `POST /api/second-brain/tasks/upsert`
- `GET /api/second-brain/notes`
- `POST /api/second-brain/notes/upsert`
- `GET /api/second-brain/people`
- `POST /api/second-brain/people/upsert`
- `GET /api/second-brain/library`
- `GET /api/second-brain/routines`
- `POST /api/second-brain/routines/update`
- `GET /api/second-brain/usage`
- `POST /api/second-brain/briefs/generate`

Impacted contract files:

- `src/channels/web-types.ts`
- `src/channels/web-runtime-routes.ts`
- `src/index.ts`

---

## Cross-Channel Plan

`Second Brain` must stay canonical across:

- web
- CLI
- Telegram

### Rules

- one shared store for personal entities
- one shared routine catalog
- one shared briefing store
- one shared usage and budget store
- no bespoke channel-only resume logic

### Channel roles

- web: richest editing and review surface
- CLI: fast capture, review, and power workflows
- Telegram: quick capture, notifications, approvals, and digest delivery

### Continuity

Build on the shared continuity thread model. Do not add a separate `Second Brain` continuity mechanism.

Use continuity for:

- ongoing meeting-prep threads
- unfinished follow-up work
- blocked clarification on a brief
- review of a generated draft

Do not use continuity to bypass approvals or surface-specific auth constraints.

---

## Domain-Specific Workstreams

### Workstream 0: Specs And Contracts

Deliver:

- `SECOND-BRAIN-DESIGN.md`
- `SECOND-BRAIN-DATA-MODEL-DESIGN.md`
- `SECOND-BRAIN-ROUTING-DESIGN.md` or equivalent design deltas
- updates to `INTENT-GATEWAY-ROUTING-DESIGN.md`
- updates to `ORCHESTRATION-DESIGN.md`
- updates to `PENDING-ACTION-ORCHESTRATION-DESIGN.md`
- updates to `CONTEXT-ASSEMBLY-DESIGN.md`
- updates to `INTELLIGENCE-IN-DEPTH-DESIGN.md`
- updates to `IDENTITY-MEMORY-DESIGN.md`
- updates to `SKILLS-DESIGN.md`
- updates to `WEBUI-DESIGN.md`
- updates to `TOOLS-CONTROL-PLANE-DESIGN.md` for locality and usage reporting
- updates to `CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md`
- updates to `MEMORY-SYSTEM-UPLIFT-PLAN.md`
- updates to `MEMORY-ARTIFACT-WIKI-UPLIFT-PLAN.md`
- updates to `docs/archive/plans/SKILLS-PROGRESSIVE-DISCLOSURE-UPLIFT-PLAN.md`
- updates to `src/reference-guide.ts`

Explicit documentation goals:

- document how `Second Brain` uses layered retrieval without collapsing notes into durable memory
- document how tooling and deferred tool discovery should expose `Second Brain` tools without bloating the default prompt surface
- document what `Second Brain` should and should not load through skills or prompt material
- document how context assembly, continuity, pending actions, and personal-intent routing interact
- document how durable memory promotion from `Second Brain` remains bounded and explicit

### Workstream 1: Core Second Brain Store

Deliver:

- SQLite-backed `Second Brain` store
- CRUD for notes, tasks, contacts, events, reminders, routines, briefs
- link table between entities
- stable IDs and timestamps
- in-memory fallback when SQLite is unavailable

### Workstream 2: Routing And Orchestration

Deliver:

- new `personal_assistant_task` route
- direct routing candidate and dispatch path
- shared pending-action integration
- continuity-aware `Second Brain` resume semantics
- route attribution for usage accounting

### Workstream 3: Sync And Retrieval

Deliver:

- Google and Microsoft sync adapters for calendar, contacts, and productivity retrieval
- local calendar layer
- document and artifact linking into search
- library ingest and index hooks

### Workstream 4: Routine Engine

Deliver:

- routine manifest registry
- horizon scanner
- deterministic trigger evaluation
- routine execution coordinator
- built-in routine catalog
- delivery handling across channels

### Workstream 5: Briefing And Drafting

Deliver:

- evidence bundle assembler
- meeting brief generator
- weekly review generator
- follow-up draft generator
- user-visible source and usage metadata on outputs

### Workstream 6: Usage And Budget Governance

Deliver:

- `SecondBrainUsageService`
- per-routine budget profiles
- forecast model and estimator
- output-level usage metadata
- web `Usage` surfaces
- budget enforcement and downgrade policy

### Workstream 7: Web Product Surface

Deliver:

- `Second Brain` page
- tabbed personal surface
- migration away from current dashboard page
- routines settings UI
- usage badge and reporting

### Workstream 8: Contacts, Outreach, And Social

Deliver:

- broaden current contact/campaign substrate into `Contacts`
- relationship reminders
- follow-up queue
- draft-only outreach review
- draft-only social queue

Keep send/post approval-gated by default.

---

## Delivery Phases

### Phase 0: Architecture Lock

Deliver:

- specs
- route decision locked
- storage design locked
- routine manifest model locked
- usage model locked

Exit criteria:

- no open ambiguity about route ownership
- no open ambiguity about scheduler behavior
- no open ambiguity about budget attribution

### Phase 1: Runtime Foundation

Deliver:

- `Second Brain` store
- CRUD services
- budget attribution extension
- basic sync adapters
- basic route wiring

Exit criteria:

- a manual request can create and retrieve notes, tasks, and reminders through the new runtime path

### Phase 2: Web Shell And Personal Surface

Deliver:

- `Second Brain` web page
- tab shell
- `Today`, `Tasks`, `Notes`, `Calendar`, `Library`, `Routines`
- `Dashboard` migration alias if needed

Exit criteria:

- `Second Brain` is the new default landing page

### Phase 3: Routines And Briefing

Deliver:

- built-in routine catalog
- horizon scanner
- briefing pipeline
- daily and meeting routines
- usage metadata on outputs

Exit criteria:

- at least `Morning Brief`, `Next 24 Hours Radar`, `Pre-Meeting Brief`, and `Weekly Review` are working end-to-end

### Phase 4: Contacts And Follow-Up Intelligence

Deliver:

- `Contacts` tab
- merged contact model
- relationship reminders
- follow-up queue
- post-meeting follow-up drafts

Exit criteria:

- the assistant can answer "what do I owe this contact?" from structured data plus linked artifacts

### Phase 5: Content, Outreach, And Advanced Budgeting

Deliver:

- draft-only outreach review
- draft-only social queue
- richer forecast and cost estimation UI
- approval-gated outbound actions

Exit criteria:

- communication-capable routines remain bounded, explainable, and approval-gated

---

## Recommended File-Level Changes

### Runtime

- add `src/runtime/second-brain/` module tree
- update `src/runtime/intent-gateway.ts`
- update `src/runtime/direct-intent-routing.ts`
- update `src/chat-agent.ts`
- update `src/index.ts`
- extend `src/runtime/budget.ts`
- extend `src/runtime/analytics.ts` or add a parallel usage persistence service built on the same SQLite pattern

### Tools

- add `src/tools/builtin/second-brain-tools.ts`
- integrate with `src/tools/executor.ts`
- optionally refactor existing contacts/email tools to share `Contacts` primitives

### Skills and prompt material

- update `src/skills/prompt.ts`
- update `src/skills/resolver.ts` if `Second Brain` changes skill selection or bounded prompt material
- document which `Second Brain` workflows should use tools directly versus skill guidance

### Channels and UI

- extend `src/channels/web-types.ts`
- extend `src/channels/web-runtime-routes.ts`
- update `web/public/index.html`
- update `web/public/js/app.js`
- add `web/public/js/pages/second-brain.js`
- shrink or retire `web/public/js/pages/dashboard.js`

### Docs

- add new `Second Brain` specs
- update routing spec
- update orchestration, context-assembly, intelligence, and memory docs
- update skills docs and prompt-material guidance
- update web UI spec
- update reference guide

---

## Verification Strategy

### Unit coverage

- store CRUD tests
- route-classification tests
- direct-routing candidate tests
- budget attribution tests
- routine trigger tests
- briefing downgrade tests

### Integration coverage

- web route tests for `/api/second-brain/*`
- scheduler + routine execution tests
- cross-channel continuity tests
- approval tests for outbound drafts and sends
- connector sync tests for Google and Microsoft paths

### Harness coverage

Run at minimum after implementation changes touching these areas:

- `npm test`
- `npm run check`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`

Recommended new harnesses:

- `node scripts/test-second-brain-smoke.mjs`
- `node scripts/test-second-brain-routines.mjs`
- `node scripts/test-second-brain-budgeting.mjs`

### Manual validation

Validate these end-to-end flows:

1. create note -> convert to task -> see on `Today`
2. upcoming meeting -> auto-generated pre-meeting brief
3. no local model -> API-only budget caps still hold
4. local model configured -> routine synthesis stays local-first
5. follow-up draft appears, but send remains approval-gated
6. same `Second Brain` thread continues across web and Telegram

---

## Risks And Controls

| Risk | Failure mode | Control |
|---|---|---|
| route ambiguity | personal requests leak into generic automation or workspace lanes | explicit `personal_assistant_task` and route-ownership matrix |
| invisible spend | background routines quietly consume API budget | local-first defaults, routine budgets, usage reporting, degrade-before-overspend |
| over-agentization | trivial checks become expensive agent loops | deterministic horizon scanning and trigger evaluation |
| connector duplication | Google/Microsoft logic forks into two stacks | shared connectors, split by intent not provider |
| notes-memory confusion | raw notes pollute durable memory | separate stores and explicit promotion only |
| channel drift | web, CLI, Telegram diverge | shared stores, shared continuity, shared pending-action model |
| outbound safety | drafts accidentally become sends | draft-only defaults and explicit approval gates |

---

## Final Recommendation

Implement `Second Brain` as a new product domain on top of Guardian's existing shared runtime primitives.

Do not build it as:

- a nested organizer tab
- a second scheduler
- a second budget tracker
- a prompt-only assistant persona

Build it as:

- a dedicated personal-intent lane
- a SQLite-backed personal data domain
- a backend-owned routine and horizon engine
- a local-first, budget-aware assistant layer
- a clear product surface separate from generic `Automations`

This keeps the architecture coherent while making Guardian feel like a real executive-assistant style product instead of an operator console with personal features bolted on.
