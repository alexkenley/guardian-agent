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
- `#/dashboard` remains available as the operator-focused Dashboard alias.

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
- `Calendar` exposes a month grid, selected-day agenda, and a local event editor with title, timing, location, and description fields. Provider-backed events are visible in the grid and remain read-only in this surface.
- `Tasks` exposes a status-board layout with inline status changes plus a dedicated task editor.
- `Notes` exposes search, pinned and archived note states, and a full editor with tag support.
- `People` exposes relationship filters, last-contact tracking, and a dedicated person editor.
- `Library` now exposes saved link and reference CRUD in the web UI.
- `Briefs` now exposes saved brief review plus visible brief generation actions in the web UI.
- `Routines` exposes routine grouping plus editable enablement, routing bias, budget profile, and delivery defaults.

### Briefs in the current UI

- Briefs are part of the runtime model and can be generated through tools and the web API.
- The web page now has a dedicated `Briefs` tab with saved-brief review and explicit generate actions.
- Overview counters reflect persisted brief records and follow-up draft records.

## Routing Contract

### Route ownership

The Intent Gateway owns classification of `Second Brain` work through the `personal_assistant_task` route.

Current `personal_assistant_task` scope includes:
- overview reads
- notes
- tasks
- calendar planning and event context
- people context
- routines
- briefs and follow-up drafts
- personal retrieval across notes, events, messages, and provider-backed context

Current route boundaries are:
- `personal_assistant_task`: Second Brain and personal productivity work
- `workspace_task`: explicit Google Workspace or Microsoft 365 CRUD and admin operations
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
- `sb_briefs`
- `sb_usage_records`
- `sb_sync_cursors`

Present in schema but not yet surfaced through the current runtime surface:
- `sb_reminders`
- `sb_links`

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
- library/link records

## Core Service Behavior

### `SecondBrainService`

`SecondBrainService` is the shared runtime façade for:
- overview generation
- CRUD for notes, tasks, events, and people
- routine listing and updates
- brief persistence and lookup
- sync cursor persistence and lookup
- usage record aggregation

It also seeds the built-in routine catalog at startup.

### Built-in routines

Current seeded routines are:
- `morning-brief`
- `next-24-hours-radar`
- `weekly-review`
- `pre-meeting-brief`
- `follow-up-watch`

Current behavior note:
- `weekly-review` is seeded as a routine record but does not yet have a dedicated synthesis path in the current horizon scanner.

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

## Briefing Model

### `BriefingService`

`BriefingService` generates deterministic briefs backed by persisted `Second Brain` data.

Current supported brief kinds:
- `morning`
- `pre_meeting`
- `follow_up`

### Current brief generation behavior

`morning`
- summarizes upcoming events, open tasks, recent notes, and enabled routines
- persists the result under a day-stable brief id

`pre_meeting`
- requires `eventId`
- matches tasks, notes, and people using simple keyword overlap with the event title
- persists the result under an event-stable brief id

`follow_up`
- requires `eventId`
- creates a draft-style follow-up packet from the event, open tasks, and recent notes
- persists the result under an event-stable brief id

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
3. generates briefs only when trigger conditions are met
4. records `lastRunAt` on triggered routines

Current trigger behavior:
- `morning-brief`: once per local day after 5:00
- `next-24-hours-radar`: marks a run when open tasks or near-horizon events exist
- `pre-meeting-brief`: generates missing pre-meeting briefs for events within the configured lookahead window
- `follow-up-watch`: generates missing follow-up drafts for recently ended events

## Tool Surface

Current built-in `Second Brain` tools:
- `second_brain_overview`
- `second_brain_brief_list`
- `second_brain_generate_brief`
- `second_brain_horizon_scan`
- `second_brain_calendar_list`
- `second_brain_calendar_upsert`
- `second_brain_library_list`
- `second_brain_library_upsert`
- `second_brain_note_list`
- `second_brain_note_upsert`
- `second_brain_people_list`
- `second_brain_person_upsert`
- `second_brain_task_list`
- `second_brain_task_upsert`
- `second_brain_routine_list`
- `second_brain_routine_update`
- `second_brain_usage`

All of these are registered in the `memory` category and exposed through deferred loading.

## Web API Surface

Current `Second Brain` API routes:
- `GET /api/second-brain/overview`
- `GET /api/second-brain/briefs`
- `POST /api/second-brain/briefs/generate`
- `GET /api/second-brain/calendar`
- `POST /api/second-brain/calendar/upsert`
- `GET /api/second-brain/tasks`
- `POST /api/second-brain/tasks/upsert`
- `GET /api/second-brain/notes`
- `POST /api/second-brain/notes/upsert`
- `GET /api/second-brain/people`
- `POST /api/second-brain/people/upsert`
- `GET /api/second-brain/links`
- `POST /api/second-brain/links/upsert`
- `GET /api/second-brain/routines`
- `POST /api/second-brain/routines/update`
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
