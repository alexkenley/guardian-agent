# Second Brain As-Built Specification

**Status:** Implemented current architecture  
**Date:** 2026-04-05  
**Purpose:** This is the as-built reference for Guardian's current `Second Brain` product surface. It captures what is actually shipped today, the runtime boundaries, and the current gaps relative to the broader proposal and implementation plan.

## Scope

`Second Brain` is Guardian's current personal-assistant product area. It is the default web landing page at `#/` and uses the shared Guardian runtime rather than introducing a separate orchestration, scheduling, or budgeting stack.

This spec is authoritative for the current implementation of:
- the `personal_assistant_task` route
- the shared `Second Brain` storage model
- provider-backed calendar and people sync into `Second Brain`
- deterministic brief generation and routine scanning
- the web, tool, and direct-read surfaces for `Second Brain`

This spec does not claim that every item from the proposal or implementation plan is complete. It documents the shipped implementation only.

## Primary Files

- `src/runtime/second-brain/second-brain-store.ts`
- `src/runtime/second-brain/second-brain-service.ts`
- `src/runtime/second-brain/briefing-service.ts`
- `src/runtime/second-brain/sync-service.ts`
- `src/runtime/second-brain/horizon-scanner.ts`
- `src/tools/builtin/second-brain-tools.ts`
- `src/runtime/intent-gateway.ts`
- `src/runtime/direct-intent-routing.ts`
- `src/chat-agent.ts`
- `src/channels/web-types.ts`
- `src/channels/web-runtime-routes.ts`
- `web/public/js/pages/second-brain.js`

## Product Surface

### Web entry points

- `#/` is the default `Second Brain` home.
- `#/system` is the operator-focused status and activity surface outside Second Brain.
- `#/dashboard` may remain as a compatibility alias to `#/system`, but it is not the canonical nav destination.

### Current `Second Brain` tabs

- `Today`
- `Calendar`
- `Tasks`
- `Notes`
- `People`
- `Library`
- `Briefs`
- `Routines`

### Current tab behavior

- `Today` is a dashboard-style daily home with agenda, quick capture, focus tasks, brief actions, relationship follow-up, recent notes, routine status, and a cloud-AI budget card.
- `Calendar` exposes week, month, and year views, full-day tile selection, a selected-day agenda, and a local event editor with title, timing, location, and description fields. Local events can be updated and deleted in-panel. Provider-backed events are visible in the calendar and remain read-only in this surface.
- `Tasks` exposes a status-board layout with inline status changes plus a dedicated task editor, with editing and delete on the left and board content on the right.
- `Notes` exposes search, pinned and archived note states, and a full editor with tag support, with editing and delete on the left and list content on the right.
- `Contacts` exposes relationship filters, last-contact tracking, and a dedicated person editor with create, update, and delete actions.
- `Library` now exposes saved link and reference CRUD in the web UI, with editing on the left and filtered content on the right. Absolute file paths are normalized into `file://` URLs for local document items.
- `Briefs` now exposes saved brief review plus visible brief generation, edit, regenerate, and delete actions in the web UI.
- `Routines` now exposes a configured-routines management surface, with only configured routines listed in the main table and a dedicated create or edit pane on the left that uses bounded routine types when the operator explicitly opens `Create routine`.

### Briefs in the current UI

- Briefs are part of the runtime model and can be generated through tools and the web API.
- The web page now has a dedicated `Briefs` tab with saved-brief review plus explicit generate, update, regenerate, and delete actions.
- Overview counters reflect persisted brief records and follow-up draft records.

## Routing Contract

### Route ownership

The Intent Gateway owns classification of `Second Brain` work through the `personal_assistant_task` route.

Current `personal_assistant_task` scope includes:
- overview reads
- notes
- tasks
- local calendar planning, local calendar CRUD, and provider-backed event context
- people context
- routines
- briefs and follow-up drafts
- personal retrieval across notes, events, messages, and provider-backed context

Current route boundaries are:
- `personal_assistant_task`: Second Brain and personal productivity work, including local Guardian calendar entries when the user does not explicitly name a provider
- `workspace_task`: explicit Google Workspace or Microsoft 365 CRUD and admin operations such as Google Calendar or Outlook calendar changes
- `email_task`: direct mailbox work in Gmail or Outlook

### Direct deterministic handling

`direct-intent-routing.ts` maps `personal_assistant_task` to the `personal_assistant` direct candidate.

`chat-agent.ts` then short-circuits simple `Second Brain` reads without a full tool loop for:
- overview
- tasks
- notes
- calendar
- people
- routines

That direct-read path is bounded to `inspect`, `read`, and `search` style requests. Mutations and synthesis still route through the runtime service and tool surface.

## Persistence Model

`Second Brain` uses `assistant-second-brain.sqlite` when `node:sqlite` is available and falls back to in-memory storage when it is not.

### Implemented entity stores

- `note-store.ts`
- `task-store.ts`
- `calendar-store.ts`
- `people-store.ts`
- `link-store.ts`
- `routine-store.ts`
- `brief-store.ts`
- `sync-cursor-store.ts`
- `usage-store.ts`

### Current schema families

Implemented and actively used:
- `sb_notes`
- `sb_tasks`
- `sb_people`
- `sb_events`
- `sb_links`
- `sb_routines`
- `sb_routine_tombstones`
- `sb_briefs`
- `sb_usage_records`
- `sb_sync_cursors`

Present in schema but not yet surfaced through the current runtime surface:
- `sb_reminders`

### Current entity coverage

Persisted and exposed:
- notes
- tasks
- events
- people
- library/link records
- routines
- briefs
- usage records
- sync cursor records

Not yet exposed as first-class runtime CRUD:
- reminders

## Core Service Behavior

### `SecondBrainService`

`SecondBrainService` is the shared runtime façade for:
- overview generation
- create, update, and delete for notes, tasks, local calendar events, people, library items, briefs, and routines
- provider-sync upsert for Google and Microsoft calendar events
- routine-type catalog listing plus bounded routine creation, updates, and deletes
- brief persistence, lookup, generation, update, and delete
- sync cursor persistence and lookup
- usage record aggregation

It also seeds the default assistant routine set at startup.

Current mutation behavior note:
- chat-driven local calendar, task, and people writes normalize relative dates and times such as `tomorrow at 12 pm`, `next Friday`, or `yesterday` against the runtime local timezone before saving the shared record
- unqualified calendar CRUD still targets the local Guardian `Second Brain` calendar; explicit Google Calendar or Microsoft 365 calendar CRUD stays on the provider route

### Ownership model: current vs target

Current shipped ownership:
- notes, tasks, library items, briefs, and routines are Guardian-owned records in the shared `Second Brain` store
- local calendar events are Guardian-owned records in the shared `Second Brain` store
- Google and Microsoft calendar events are synced into the shared store as provider-backed records and remain read-only in `Second Brain`
- people records live in the shared `Second Brain` store, with Google and Microsoft contacts syncing into that same store
- direct mailbox work remains provider-owned and routes through Gmail / Google Workspace or Outlook / Microsoft 365 rather than `Second Brain`

Documented target direction, not yet fully implemented:
- Guardian should become the canonical assistant-facing source of truth for calendar and people / relationship context
- generic assistant requests about calendar and people should resolve against Guardian-owned records by default, even when Google Workspace or Microsoft 365 is connected
- Google Calendar and Microsoft 365 calendar should act as sync adapters for Guardian-owned calendar state rather than peer destinations for generic chat CRUD
- Google and Microsoft contacts should sync into Guardian-owned people records as enrichments or mirrors rather than acting as competing first-class context stores
- email should remain provider-owned, with Guardian storing synced and derived context for retrieval, planning, and drafting rather than becoming a mailbox of record

Planned ownership list:
- Guardian canonical: calendar, people / contacts context, notes, tasks, library, briefs, routines
- Provider canonical with Guardian-derived context layered on top: email, Drive / Docs / Sheets, OneDrive / SharePoint, and other provider-native files
- Explicit provider routes remain valid for provider administration, provider-only maintenance, and direct provider CRUD where the user intentionally targets that provider

### Default routines and routine types

Current default seeded routines on first run:
- `morning-brief` (`Morning Brief`)
- `weekly-review` (`Weekly Review`)
- `next-24-hours-radar` (`Daily Agenda Check`)
- `pre-meeting-brief` (`Pre-Meeting Brief`)
- `follow-up-watch` (`Follow-Up Draft`)

Current additional routine type available through `Create routine`:
- `topic-watch` (`Topic Watch`)
- `deadline-watch` (`Deadline Watch`)

Current direct maintenance action on the Routines surface:
- `Sync now` refreshes provider calendar and contact context without appearing as a visible assistant routine

Current behavior note:
- `weekly-review` now generates and stores a dedicated weekly review brief artifact that pulls from events, tasks, notes, people, and library items.
- the Routines table shows only configured routines; `Create routine` is the explicit path for adding another bounded routine type.
- deleting a seeded default routine keeps it out of the configured routines list across restart until an operator explicitly re-creates it from `Create routine`.
- `topic-watch` supports multiple configured instances and stores a `topicQuery` routine config instead of behaving like a single fixed built-in.
- `deadline-watch` supports multiple configured instances and stores bounded deadline settings (`dueWithinHours`, `includeOverdue`) for proactive task-pressure notifications.

## Sync Model

### `SyncService`

`SyncService` is instantiated at runtime startup and performs:
- a best-effort startup sync
- on-demand sync through the horizon scanner

### Current providers

Google Workspace:
- upcoming calendar events from Google Calendar
- contacts from Google People API

Microsoft 365:
- calendar view events from Microsoft Graph
- contacts from Microsoft Graph

### Current sync shape

The current sync flow:
1. reads provider data through the shared native provider services
2. normalizes it into `Second Brain` events and people
3. records connector usage in `sb_usage_records`
4. stores a `lastSyncAt` record in `sb_sync_cursors`

Current limitations:
- sync cursors are persisted, but the current implementation stores timestamped sync markers rather than provider-native delta tokens
- sync is pull-based only
- no webhook or push-based provider change ingestion is implemented yet
- provider-backed calendar events are still modeled as read-only remote-owned records; outbound calendar sync from Guardian-owned local events is not implemented yet
- people / contact unification still uses one shared store today, but ownership and conflict semantics are not yet explicitly modeled as Guardian-canonical vs remote-mirror records

## Briefing Model

### `BriefingService`

`BriefingService` generates deterministic briefs backed by persisted `Second Brain` data.

Current supported brief kinds:
- `morning`
- `weekly_review`
- `pre_meeting`
- `follow_up`

### Current brief generation behavior

`morning`
- summarizes upcoming events, open tasks, recent notes, and enabled routines
- persists the result under a day-stable brief id

`weekly_review`
- summarizes the next seven days of events plus current tasks, notes, people, and saved library references
- persists the result under a day-stable weekly review id

`pre_meeting`
- requires `eventId`
- matches tasks, notes, and people using simple keyword overlap with the event title
- persists the result under an event-stable brief id

`follow_up`
- requires `eventId`
- creates a draft-style follow-up packet from the event, open tasks, and recent notes
- persists the result under an event-stable brief id

`topic watch` output
- is currently stored as a `manual` brief artifact tied back to the triggering routine id
- summarizes newly matched tasks, notes, people, library items, events, and briefs for the configured topic

`deadline watch` output
- is currently stored as a `manual` brief artifact tied back to the triggering routine id
- summarizes overdue and due-soon open tasks that are newly relevant for the configured deadline window

Current limitations:
- synthesis is deterministic string assembly, not open-ended agent drafting
- there is no dedicated research-enriched meeting brief flow yet
- there is no separate web briefing queue surface yet

## Deterministic Routine Execution

### `HorizonScanner`

`HorizonScanner` is wired into the shared `ScheduledTaskService`.

At startup it ensures a scheduled tool exists with:
- target: `second_brain_horizon_scan`
- type: `tool`
- cron: `*/15 * * * *`

### Current scan behavior

Each scan:
1. runs `SyncService.syncAll(...)`
2. evaluates enabled routines
3. generates briefs and assistant outcomes only when trigger conditions are met
4. records `lastRunAt` on triggered routines

Current proactive delivery note:
- user-facing routine outcomes now flow through shared runtime channels
- Telegram is the default delivery channel for user-facing routine notifications, with web and CLI available as additional operator-facing delivery channels
- proactive routine notices include a title, a short summary, and simple next-step hints when an artifact is ready for review

Current trigger behavior:
- `morning-brief`: once per local day after 5:00
- `next-24-hours-radar`: marks a run when open tasks or near-horizon events exist
- `weekly-review`: generated weekly to summarize your state
- `pre-meeting-brief`: generates missing pre-meeting briefs for events within the configured lookahead window
- `follow-up-watch`: generates missing follow-up drafts for recently ended events
- `topic-watch`: generates a topic-watch brief when new matching context appears since the last run
- `deadline-watch`: generates a deadline-watch brief when due-soon or overdue tasks become newly relevant for the configured watch window
- provider sync: exposed as a direct `Sync now` maintenance action rather than a visible assistant routine

## Tool Surface

Current built-in `Second Brain` tools:
- `second_brain_overview`
- `second_brain_brief_list`
- `second_brain_brief_update`
- `second_brain_brief_delete`
- `second_brain_generate_brief`
- `second_brain_horizon_scan`
- `second_brain_calendar_list`
- `second_brain_calendar_upsert`
- `second_brain_calendar_delete`
- `second_brain_library_list`
- `second_brain_library_upsert`
- `second_brain_library_delete`
- `second_brain_note_list`
- `second_brain_note_upsert`
- `second_brain_note_delete`
- `second_brain_people_list`
- `second_brain_person_upsert`
- `second_brain_person_delete`
- `second_brain_task_list`
- `second_brain_task_upsert`
- `second_brain_task_delete`
- `second_brain_routine_catalog`
- `second_brain_routine_create`
- `second_brain_routine_list`
- `second_brain_routine_update`
- `second_brain_routine_delete`
- `second_brain_usage`

All of these are registered in the `memory` category and exposed through deferred loading.

## Web API Surface

Current `Second Brain` API routes:
- `GET /api/second-brain/overview`
- `GET /api/second-brain/briefs`
- `POST /api/second-brain/briefs/generate`
- `POST /api/second-brain/briefs/update`
- `POST /api/second-brain/briefs/delete`
- `GET /api/second-brain/calendar`
- `POST /api/second-brain/calendar/upsert`
- `POST /api/second-brain/calendar/delete`
- `GET /api/second-brain/tasks`
- `POST /api/second-brain/tasks/upsert`
- `POST /api/second-brain/tasks/delete`
- `GET /api/second-brain/notes`
- `POST /api/second-brain/notes/upsert`
- `POST /api/second-brain/notes/delete`
- `GET /api/second-brain/people`
- `POST /api/second-brain/people/upsert`
- `POST /api/second-brain/people/delete`
- `GET /api/second-brain/links`
- `POST /api/second-brain/links/upsert`
- `POST /api/second-brain/links/delete`
- `GET /api/second-brain/routines/catalog`
- `GET /api/second-brain/routines`
- `POST /api/second-brain/routines/create`
- `POST /api/second-brain/routines/update`
- `POST /api/second-brain/routines/delete`
- `GET /api/second-brain/usage`

Not currently exposed:
- reminder CRUD routes

## Usage And Budgeting

`Second Brain` records usage into the shared usage store with route attribution fixed to `personal_assistant_task`.

Current usage summary fields:
- total records
- local token total
- external token total
- connector call total
- monthly budget
- daily budget
- quiet-budget-mode flag
- pause-on-overage flag

Current defaults:
- monthly external budget: `25_000`
- daily external budget: `2_500`

Current limitation:
- the current implementation exposes budget visibility and attribution, but it does not yet enforce a separate budget policy engine that pauses or downgrades work automatically based on overage thresholds

## Channels

Current `Second Brain` behavior is shared across:
- web
- CLI
- Telegram

The canonical store and routines live in the backend. There is no channel-specific `Second Brain` continuity stack.

## Verification

Current dedicated verification coverage includes:
- `src/runtime/second-brain/second-brain-service.test.ts`
- `src/runtime/second-brain/briefing-service.test.ts`
- `src/runtime/second-brain/horizon-scanner.test.ts`
- `src/runtime/second-brain/sync-service.test.ts`
- `scripts/test-second-brain-smoke.mjs`
- `scripts/test-second-brain-routines.mjs`
- `scripts/test-second-brain-budgeting.mjs`

## Current Gaps Relative To The Plan

The implementation plan remains broader than the current as-built product.

Still not delivered as first-class shipped behavior:
- reminder CRUD surface
- dedicated weekly review synthesis
- research-enhanced briefs
- budget policy engine beyond visibility and usage aggregation
- provider delta-sync cursors and push-based sync

This spec should be updated when those items move from scaffolding or roadmap status into the runtime surface.
