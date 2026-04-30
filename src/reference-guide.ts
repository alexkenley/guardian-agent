/**
 * Shared reference guide content for CLI, Telegram, and Web UI.
 *
 * AGENT NOTE:
 * This file is a user/operator guide only.
 * Keep it focused on how to use the product, navigate the surfaces, and understand shipped capabilities.
 * Do not turn this file into implementation documentation, code-path notes, architecture commentary,
 * test guidance, or internal troubleshooting details except where an operator directly needs them to use
 * or diagnose the product from the outside.
 * Avoid backend terminology unless the operator sees it directly in the product. Prefer user-facing labels
 * and workflows over internal names, config-file details, trace-file paths, route IDs, or runtime internals.
 */

export interface ReferenceGuidePageSection {
  title: string;
  items: string[];
  note?: string;
}

export interface ReferenceGuidePage {
  id: string;
  title: string;
  summary: string;
  sections: ReferenceGuidePageSection[];
}

export interface ReferenceGuideCategory {
  id: string;
  title: string;
  description: string;
  pages: ReferenceGuidePage[];
}

export interface ReferenceGuide {
  title: string;
  intro: string;
  categories: ReferenceGuideCategory[];
}

const GUIDE_PROMPT_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'app',
  'are',
  'can',
  'do',
  'for',
  'guardian',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'use',
  'using',
  'what',
  'where',
  'with',
]);

export function getReferenceGuide(): ReferenceGuide {
  return {
    title: 'Guardian Agent Reference Guide',
    intro: 'Operator guide for setup, daily use, coding work, cloud connections, automations, and security controls across web, CLI, and Telegram. For source code, design docs, security policy, or contribution workflow, use the GitHub Repository section in this guide.',
    categories: [
      {
        id: 'getting-started',
        title: 'Getting Started',
        description: 'Bootstrap the assistant, learn the control surfaces, use the coding IDE, and manage conversations safely.',
        pages: [
          {
            id: 'quick-start',
            title: 'Quick Start',
            summary: 'Bring the assistant online, open Second Brain, and confirm your provider and auth configuration.',
            sections: [
              {
                title: 'Start The System',
                items: [
                  'Run Guardian Agent from the repo root with the platform startup script or `npx guardianagent`.',
                  'Open the web UI at `http://localhost:3000` when the web channel is enabled.',
                  'If web authentication is enabled, use the token shown at startup or your configured web credentials to sign in.',
                  'Use the Configuration Center in the web UI or CLI `/config` to create or update settings instead of editing config files directly.',
                ],
              },
              {
                title: 'Verify Readiness',
                items: [
                  'Use the Second Brain home at `#/` to confirm the assistant is running and ready for day-to-day work.',
                  'If the guided setup card is still showing on Second Brain, you can accept the recommended defaults there or open Configuration > Second Brain to tune them manually.',
                  'Open `#/system` when you want the cross-product status and activity monitoring surface.',
                  'System shows cross-product status, recent assistant activity, and the live approval queue.',
                  'Open `#/performance` when you want the operator-facing workstation health and reviewed cleanup surface.',
                  'Open `#/config` to verify your AI connection, web access settings, and enabled channels.',
                  'Open Configuration > Second Brain when you want to change assistant response style, the Second Brain home setup card, or default delivery channels later without rerunning a one-shot wizard.',
                  'Open Configuration > Integrations > Coding Assistants when you want to confirm whether Guardian can delegate work to Claude Code, Codex, Gemini CLI, or Aider.',
                  'Open Configuration > Appearance when you want to switch between built-in and curated visual bundles, let typography follow the selected bundle, raise the web UI text size slightly, or reduce interface motion.',
                  'Open `#/code` when you want the repo-scoped coding surface, and `#/security` when you want alerts, findings, and security status.',
                  'Use CLI `/providers` or Configuration > AI Providers to confirm the selected provider is reachable.',
                  'Use CLI `/guide` or Telegram `/guide` to pull the same reference content outside the web UI.',
                ],
                note: 'Most configuration changes should appear in the web UI without a manual browser refresh.',
              },
              {
                title: 'Which Page To Use',
                items: [
                  'Use Second Brain for tasks, notes, routines, and the personal-assistant home view.',
                  'Use System for cross-product status, approvals, runtime activity, and troubleshooting.',
                  'Use Performance for workstation health, reviewed process cleanup, and profile switching.',
                  'Use Code for repo work, coding sessions, approvals, and workspace activity.',
                  'Use Automations for saved workflows, schedules, output, and run history.',
                  'Use Security for alerts, Assistant Security, threat intel, and security activity.',
                  'Use Configuration for setup, integrations, AI connections, tools, and appearance.',
                ],
              },
            ],
          },
          {
            id: 'configuration-quick-start',
            title: 'Configuration Quick Start',
            summary: 'Set up AI providers, core access, and the first validation checks in one pass.',
            sections: [
              {
                title: 'Minimum Working Setup',
                items: [
                  'Open `#/config` first. That is the main setup surface for AI providers, auth, integrations, search, and appearance.',
                  'In Configuration > AI Providers add at least one usable AI profile before expecting normal chat to work well.',
                  'Each saved AI profile now has an enable checkbox in the AI Providers list. Unchecking it removes that profile from live routing without deleting its settings.',
                  'If you want the simplest private setup, start with local Ollama. If you want a hosted fallback, add Ollama Cloud, OpenRouter, or NVIDIA Cloud as a managed-cloud provider, or add a frontier provider after that.',
                  'For managed cloud, use Configured Providers to choose the active provider family, then bind that family\'s profiles for general, direct, tool-loop, and coding work.',
                  'Use the web configuration forms or CLI `/config` instead of editing config files by hand.',
                ],
              },
              {
                title: 'AI Provider Basics',
                items: [
                  'Local path: install Ollama, pull a model, then add that profile in Configuration > AI Providers.',
                  'Managed-cloud path: add Ollama Cloud for remote Ollama-native access, OpenRouter for OpenRouter-hosted models, or NVIDIA Cloud for NVIDIA NIM models in the managed-cloud tier.',
                  'Frontier path: add OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, Together, or xAI when you want a stronger hosted fallback or an explicit high-quality tier.',
                  'Use Configuration > AI Providers or CLI `/providers` to confirm connectivity and model discovery after each provider change.',
                  'Use Auto mode for normal operation once the provider tiers you care about are configured correctly.',
                ],
              },
              {
                title: 'Core Access And Integrations',
                items: [
                  'If web authentication is enabled, confirm you can still sign in after changing auth settings before moving on to other setup tasks.',
                  'Open Configuration > Integrations > Coding Assistants when you want Guardian to be able to delegate to Claude Code, Codex, Gemini CLI, or Aider.',
                  'Open Configuration > Integration System when you want to enable operator channels such as Telegram.',
                  'Open Configuration > Search Providers when you want live web search or document-search collections available inside Guardian.',
                  'Use paste-once secrets for the easiest local setup, or use credential refs when your environment already manages secrets outside the app.',
                ],
              },
              {
                title: 'First Validation Pass',
                items: [
                  'Run CLI `/providers` or use the AI Providers page to make sure the configured provider is reachable and shows the model you expect.',
                  'Open Second Brain and confirm the page loads without missing-provider errors.',
                  'Ask one simple chat question first, then one bounded Second Brain question such as `Show my tasks` to verify normal chat and Second Brain both work.',
                  'If you enabled Telegram, send the bot a test message and confirm it replies before treating the channel as live.',
                  'If you connected Google Workspace or Microsoft 365, validate the connection from the connection page first, then test the specific Calendar, Contacts, or Mail flow you actually plan to use.',
                ],
                note: 'A good first-run goal is not full feature coverage. It is one working AI provider, one working operator surface, and one verified daily-use flow.',
              },
            ],
          },
          {
            id: 'second-brain',
            title: 'Second Brain',
            summary: 'Comprehensive operator and user guide to the daily-home, calendar, tasks, notes, contacts, library, briefs, routines, sync behavior, and usage signals.',
            sections: [
              {
                title: 'What Second Brain Is',
                items: [
                  'Open Second Brain at `#/` for the main personal-assistant surface.',
                  'The current tabs are `Today`, `Calendar`, `Tasks`, `Notes`, `Contacts`, `Library`, `Briefs`, and `Routines`.',
                  'Configuration > Second Brain owns the editable setup preferences for assistant response style, the Today setup card, and default delivery channels for new routines. It is not a separate memory system.',
                  'Second Brain is the personal-assistant home, not the main operator dashboard. Use it for your day, your commitments, your notes, and your planning context.',
                  'Items you save in Second Brain are available across the supported Guardian surfaces instead of being trapped in one panel.',
                  'Performance, Security, Automations, and Configuration are the main operator-facing control surfaces outside Second Brain.',
                  'Use explicit Gmail, Outlook, Drive, OneDrive, SharePoint, or Docs CRUD requests when you want direct provider operations rather than Second Brain retrieval or planning.',
                ],
              },
              {
                title: 'Today',
                items: [
                  'Today is the landing surface for the current day. It brings together your agenda, quick capture, priority tasks, follow-up contacts, recent notes, brief actions, and routine status.',
                  'When setup is still pending, Today shows a guided Second Brain preferences card so you can accept recommended defaults quickly or jump into Configuration for manual changes.',
                  'The quick-add control on Today lets you create a note, task, or local event without leaving the daily view.',
                  'The summary cards on Today are there to help you triage quickly. They surface what matters now, but the dedicated tabs remain the deeper editing surfaces.',
                  'The Today view includes a Cloud AI budget readout that shows Second Brain cloud-model token usage for the current month. Local-only work does not count toward that number.',
                  'Use Today when you want to decide what to do next fast instead of browsing every tab manually.',
                ],
              },
              {
                title: 'Calendar',
                items: [
                  'Calendar supports `Week`, `Month`, and `Year` modes so you can zoom from day-to-day scheduling out to longer-range planning without leaving the tab.',
                  'Clicking open space anywhere inside a day tile selects that day. Clicking an event opens that event directly instead.',
                  'The day agenda and event editor live on the left, while the active calendar surface stays on the right.',
                  'If a day collapses behind a `+N more` chip, click that chip to focus the day, then click any entry in the left-hand day agenda to switch the editor to that event.',
                  'Use `New event` to add a local event or time block that belongs only to your shared Second Brain store.',
                  'Local events currently support title, start time, end time, location, and description. The same editor also handles later updates and deletes for local events.',
                  'Google Calendar and Microsoft 365 events can appear in the grid when those providers are connected, but those synced events are read-only here. Edit or delete them in the source calendar.',
                  'If a synced event is selected, you can generate a pre-meeting brief from it directly from the Calendar view.',
                  'If a local Guardian event is added or changed from chat while you are already on the Calendar tab, the tab should refresh in place so the updated event appears without leaving Second Brain.',
                ],
              },
              {
                title: 'Tasks',
                items: [
                  'Tasks use a board layout with `Todo`, `In progress`, and `Done` columns.',
                  'The task editor is on the left and the board is on the right so you can edit while keeping the live queue visible.',
                  'Use the lane buttons on each task card when you want to move work quickly without reopening the full editor.',
                  'Selecting a task opens the editor for the full title, details, priority, status, and due date fields, including in-place delete.',
                  'Tasks created here feed the Today view and can also be pulled into meeting briefs and follow-up drafts when relevant.',
                  'Use the top-right `New task` action when you want a clean editor instead of changing the currently selected task.',
                  'If a task is created or updated from chat while you are already on the Tasks tab, the tab should refresh in place so the board stays current.',
                ],
              },
              {
                title: 'Notes And Ideas',
                items: [
                  'Notes is the general capture area for decisions, loose context, prep material, promises, and anything else you may need later.',
                  'The note editor is on the left and the searchable note list is on the right.',
                  'Search matches note title, body text, and tags, so the Notes tab is intended to work as a practical retrieval surface, not just a scratchpad.',
                  'Notes can be pinned when they should stay prominent and archived when they should stay searchable but stop cluttering the active list. The same editor also supports delete.',
                  'A title is optional when saving a note. If you leave it blank, Guardian infers one from the note content.',
                  'Use Notes when something matters semantically but does not belong as a task, event, or contact record.',
                ],
              },
              {
                title: 'Contacts',
                items: [
                  'Contacts stores contact records with relationship type, company, title, email, phone, location, notes, and last-contact date.',
                  'The contact editor is on the left and the filtered contact list is on the right.',
                  'Use the relationship filter when you want to narrow the list to work, personal, family, vendor, or all contacts.',
                  'The `Mark contacted today` action is the fast path for keeping follow-up data accurate without manually editing the timestamp field.',
                  'Use the contact editor for create, update, and delete instead of jumping to another surface. Phone and location are first-class fields now, so you do not need to hide them in notes.',
                  'Contact records can surface in briefs when the event, notes, or tasks suggest those contacts are relevant.',
                  'Use Contacts for real relationship context, not just an address book. The notes field is meant for promises, social detail, and follow-up cues.',
                ],
              },
              {
                title: 'Library',
                items: [
                  'Library is for saved links, repositories, documents, files, and references you may want later.',
                  'The item editor is on the left and the filtered saved-item list is on the right.',
                  'Each library item stores a title, URL, kind, tags, and a short summary of why it matters.',
                  'Absolute file paths picked from the file browser are accepted here and normalized into file URLs, so local documents can be reopened consistently later.',
                  'Use the kind filter when you want to narrow the list to references, documents, repositories, or files.',
                  'Use the summary field to explain why the item is useful instead of forcing future-you to reopen it cold.',
                  'The `Open link` action is available from the editor when a saved item is selected, and the same editor now handles delete as well.',
                ],
              },
              {
                title: 'Briefs',
                items: [
                  'Briefs is where saved Morning Briefs, Scheduled Reviews, Weekly Reviews, Pre-Meeting Briefs, and Follow-Up Drafts are reviewed after generation.',
                  'Morning Brief gives you a deterministic summary of current calendar, tasks, notes, and routine state.',
                  'Scheduled Review is the reusable custom review format for operator-defined review cadences such as Friday board review or a project-specific review rhythm.',
                  'Weekly Review rolls up the next seven days of events plus current tasks, notes, contacts, and saved library references.',
                  'Pre-Meeting Brief is anchored to a selected event and tries to gather the most relevant tasks, notes, and contacts around that meeting.',
                  'Follow-Up Draft is anchored to a finished event and assembles a draftable follow-up packet from recent shared context.',
                  'Use the Today page, Calendar, or Briefs tab to trigger brief generation manually when you want it on demand.',
                  'Saved briefs can now be edited, regenerated, or deleted from the Briefs tab. Regeneration replaces the stored content with a fresh deterministic version, and scoped or custom routine briefs now preserve their originating routine instead of collapsing back to the default starter brief.',
                ],
              },
              {
                title: 'Routines',
                items: [
                  'Routines exposes the bounded Second Brain assistant routines that support briefs, horizon checks, follow-up, topic watches, and deadline watches.',
                  'If you ask Guardian to `create an automation`, that means the power-user Automations system, not the Second Brain routine catalog.',
                  'If you ask for a `routine`, `topic watch`, or name a routine concept such as Morning Brief, Pre-Meeting Brief, or Follow-Up Draft, that stays in Second Brain.',
                  'The main Routines list shows only configured routines. Deleting one removes it from that list until you explicitly add it back.',
                  'Guardian now ships the default assistant set configured: Morning Brief, Weekly Review, Daily Agenda Check, Pre-Meeting Brief, and Follow-Up Draft.',
                  'Use `Create routine` to work from the full capability list without leaving the tab. Core assistant capabilities stay visible even when their starter instance is already configured, and the multi-instance watch capabilities still support additional routines.',
                  'New routines start enabled by default. The create pane lets you choose delivery channels first, then confirm whether the routine should stay enabled.',
                  'Some assistant capabilities now also support focused extra instances, so you can create things like `Weekly Review: Board prep` or `Morning Brief: Harbor launch` instead of only renaming the starter routine.',
                  'Scheduled Review is the custom review capability for creating your own review cadence, such as `Friday Board Review` or `Monthly Launch Review`, without overloading the seeded Morning Brief or Weekly Review examples.',
                  'In chat, you can also ask for bounded assistant watch routines directly with requests like `message me when anything mentions Harbor launch` or `message me when I have something due tomorrow`.',
                  'Chat can now also create a custom review routine from requests like `create a review for Board prep every Friday at 4 pm`.',
                  'The create or edit pane is on the left, and the configured routines table is on the right.',
                  'Use `Sync now` when you want to refresh provider calendar and contact context immediately. Sync is a direct maintenance action now, not a user-visible routine.',
                  'Selecting a configured routine lets you change its name, enabled state, timing, supported context window, delivery channels, or delete it.',
                  'Use the optional focus field when you want another instance of a core assistant capability to target one project, person, or theme without clobbering the default routine.',
                  'Chat routine updates also understand plain language such as `run daily at 6 pm`, `watch Board prep instead`, or `include overdue tasks`.',
                  'Routine setup is capability-first: what Guardian should do, when it should run, and where updates should be delivered.',
                  'Scheduled routines now support hourly, daily, weekdays, weekly, fortnightly, and monthly cadence options.',
                  'Routine schedules are still shown back in plain English across the list and read views, even when the saved trigger is a cron expression.',
                  'Telegram is the default assistant delivery channel for user-facing routine output. Add web or CLI when you also want operator visibility.',
                  'If Telegram is not available, user-facing routine notices fall back to web so assistant output is still surfaced.',
                  'Routine notices now include a clear title, a short summary of what happened, and a simple next-step hint when Guardian has something ready for review.',
                  'Topic Watch can watch a topic across tasks, notes, briefs, contacts, library items, and events, then message you when new matching context appears.',
                  'Deadline Watch can watch for tasks due within a bounded window and optionally include overdue work, then message you when fresh task pressure appears.',
                  'Use Routines when you want predictable assistance on a schedule without turning Second Brain into an always-running autonomous agent.',
                ],
              },
              {
                title: 'Sync And Shared Data',
                items: [
                  'If Google Workspace or Microsoft 365 is connected, Second Brain can sync calendar events and contacts into Guardian.',
                  'Guardian runs a startup sync and then refreshes shared Second Brain context periodically.',
                  'Second Brain data is shared across the supported surfaces. A task, note, event, contact, or library item created in the web UI is available from Guardian on other supported surfaces too.',
                  'Directionally, Guardian is the assistant-facing home for calendar and contact context. Provider calendars and contacts sync into that shared context instead of replacing it.',
                  'Generic requests for Second Brain notes, tasks, contacts, library items, briefs, routines, or local calendar work stay in Second Brain even when Google Workspace or Microsoft 365 is connected.',
                  'Requests like `show my briefs` or `list my briefs` should return saved local briefs or a clear empty state instead of falling back to the generic Second Brain overview.',
                  'Routine reads should also stay bounded and local: requests like `show only my disabled routines` or `what routines are related to email` should return filtered routine results or a clear empty state instead of drifting back to overview.',
                  'Unqualified requests such as `create a calendar entry for tomorrow` default to a local Guardian Second Brain event. Say `Google Calendar` or `Outlook calendar` only when you want provider-specific calendar CRUD.',
                  'That local-vs-provider calendar boundary is deliberate. Connected providers do not automatically take over generic local calendar requests.',
                  'Local Second Brain writes such as calendar creation can still require approval. In that case the approval is for the local Guardian write, not for a provider calendar unless you explicitly named that provider.',
                  'Treat notes, tasks, library items, briefs, and routines as Guardian-owned records. Calendar and contact context are also moving in that direction, even when external providers are connected for sync.',
                  'Email is different. Gmail and Outlook remain provider-owned mail systems, so explicit mail send, reply, inbox, and mailbox actions should still target the relevant provider rather than Second Brain storage.',
                  'Direct mailbox reads should preserve the user\'s requested inbox mode: requests for unread mail stay unread-only, while requests for the newest or latest emails should return the latest inbox messages regardless of read status.',
                  'Chat-driven local calendar, task due-date, and contact last-contact updates resolve phrases like `tomorrow at 12 pm`, `move it to Friday`, or `I talked to her yesterday` in Guardian\'s local timezone before the change is saved.',
                  'Natural chat creates for local calendar events and tasks can infer the saved title from purpose wording such as `to take Benny to the vet` or `to call the vet about Benny`, while still asking for clarification when the request truly lacks a title.',
                  'Simple chat questions such as `What do I have today?` or `Show my tasks` can be answered directly from your saved Guardian data.',
                  'The assistant can create, update, and delete local Second Brain notes, tasks, calendar events, contacts, library items, briefs, and configured routines.',
                  'Follow-up local Second Brain edits such as `update that note`, `mark that task as done`, `update that contact`, or `move that event to tomorrow at 5 pm` should bind to the last focused local record in the current chat instead of drifting into unrelated brief or provider actions.',
                  'If a local Second Brain create flow needs one missing detail, a short reply such as just the missing contact name or provider choice should stay bound to that same pending action instead of falling back into generic chat.',
                  'Saved briefs can be generated, reviewed, edited, regenerated, and deleted from the same saved data.',
                  'Event descriptions, task details, note content, contact notes, and library summaries are part of the stored records, so they are available to the assistant logic that reads those records.',
                ],
                note: 'Provider-backed calendar events remain editable in the source provider, and Guardian-first sync for calendar and contact records is still evolving rather than a fully shipped bidirectional sync contract.',
              },
              {
                title: 'Operator Expectations And Limits',
                items: [
                  'Second Brain is meant to be understandable from the UI alone. Controls that only duplicate nearby actions should be removed rather than explained away.',
                  'You can currently see budget visibility and attribution, but Guardian does not yet automatically pause or downgrade work when you cross a threshold.',
                  'Second Brain stays intentionally focused: briefs are fixed-format summaries, routines are scheduled assistant helpers, and provider sync is curated rather than full provider administration.',
                  'Use Second Brain for planning, retrieval, and bounded capture. Use Performance, Configuration, Security, Automations, and Code for the heavier operator control surfaces.',
                  'If you need direct provider changes, provider-specific messages, or broader workflow automation, move to the explicit feature surface instead of trying to force it through Second Brain.',
                ],
              },
            ],
          },
          {
            id: 'github-repo',
            title: 'GitHub Repository',
            summary: 'Use the public repository for source code, technical documentation, security policy, and contribution workflow.',
            sections: [
              {
                title: 'Main Links',
                items: [
                  'Repository: https://github.com/Threat-Vector-Security/guardian-agent',
                  'Source code: https://github.com/Threat-Vector-Security/guardian-agent/tree/main/src',
                  'README: https://github.com/Threat-Vector-Security/guardian-agent/blob/main/README.md',
                  'Security policy: https://github.com/Threat-Vector-Security/guardian-agent/blob/main/SECURITY.md',
                  'Second Brain as-built design: https://github.com/Threat-Vector-Security/guardian-agent/blob/main/docs/design/SECOND-BRAIN-AS-BUILT.md',
                  'Docs and technical notes: https://github.com/Threat-Vector-Security/guardian-agent/tree/main/docs',
                  'Issues and pull requests: https://github.com/Threat-Vector-Security/guardian-agent/issues',
                ],
              },
              {
                title: 'When To Use GitHub',
                items: [
                  'Use this in-product guide for normal operation and day-to-day workflows.',
                  'Use GitHub when you want source code, design docs, security notes, or deeper technical documentation that would clutter the operator guide.',
                  'If you want to contribute, start from the repo README and docs folder, then use issues and pull requests from the repository.',
                ],
              },
            ],
          },
          {
            id: 'chat-sessions',
            title: 'Chat, Sessions, And Quick Actions',
            summary: 'Use the assistant conversationally while keeping context, approvals, and fast actions under control.',
            sections: [
              {
                title: 'Normal Chat Flow',
                items: [
                  'Choose an agent in the web chat panel or with CLI `/chat <agentId>` when you want to pin work to one agent.',
                  'Conversation memory follows the user, channel, and selected assistant. Switching the web provider selector or CLI mode does not start a brand-new conversation by itself.',
                  'Web chat now shows a source badge on every assistant reply so you can see which final lane answered: local, managed cloud, frontier, or a non-model system response.',
                  'If Guardian used a specific saved provider profile, the badge can also show that profile and model.',
                  'Hover the badge when you want the provider and model detail for that reply.',
                  'In plain terms: `local` means your local AI path answered, `external` means a hosted AI path answered, and `system` means the reply came from product logic rather than a normal model turn.',
                  'The web `Ask the agent...` field supports multiline drafting. Press `Enter` to send and `Shift+Enter` to add a new line.',
                  'Use `Stop` in the web chat toolbar to cancel the active in-flight request when you need to interrupt a long or stuck turn.',
                  'Use `Clear Pending` from `System` > `Pending Approvals` when a stale approval or clarification is stuck and you want to clear the blocked state.',
                  'If you reload the web page mid-turn, Guardian attempts to cancel the recovered in-flight request automatically so the prior turn does not continue silently behind the refreshed UI.',
                  'Use `Reset Chat` to clear the current conversation context. If a request is still running, Reset first issues a stop for that active request and then resets the conversation state.',
                  'Use the web New Conversation control, CLI `/reset [agentId]`, or Telegram `/reset [agentId]` to clear context.',
                  'Short corrective replies such as `Use Outlook`, `No, Codex the CLI coding assistant`, or `the Guardian workspace` should now be treated as repairs of the active misunderstanding when there is recent context, not as unrelated brand-new tasks.',
                  'If your request could mean two different kinds of work, Guardian may stop and ask a short follow-up instead of guessing. Typical examples are repo work vs coding-workspace/session management, new automation creation vs editing an existing automation, or a Guardian page vs an external website.',
                ],
              },
              {
                title: 'Session Management',
                items: [
                  'Use CLI `/session list`, `/session use <sessionId>`, and `/session new` to revisit or branch prior work.',
                  'Assistant state in the System page shows queued and running sessions, wait times, execution times, and recent activity.',
                  'Quick actions are available through the web quick-action bar, CLI `/quick <action> <details>`, and Telegram `/quick ...`.',
                  'Built-in quick actions cover email, task planning, calendar planning, and a security review that runs the Assistant Security scan flow.',
                  'Chat can show whether a reply came from the local or hosted model path when that is useful for troubleshooting.',
                  'If Guardian delegates part of a job, the live activity feed can show that delegated work and whether it is still running, blocked, or finished.',
                  'Guardian chat works against one primary coding session at a time, while still keeping other saved workspaces available for reference. In the web UI, use the session cards in `#/code` to choose the current coding session and manage referenced workspaces. In CLI, use `/code current`, `/code attach <sessionId-or-match>`, `/code detach`, and `/code create <workspaceRoot> [| title]`.',
                  'You can also ask Guardian to switch, attach, or detach a coding session in normal chat. The web chat surface stays lightweight by default; session management belongs to the Code Sessions panel.',
                ],
                note: 'Web chat and CLI show live request progress while the assistant is working. The running feed now rolls forward instead of stacking every step, while blocked or otherwise important milestones remain visible with the final reply when you still need them.',
              },
            ],
          },
          {
            id: 'assistant-control-plane',
            title: 'Assistant Control Plane',
            summary: 'Inspect system state, approvals, jobs, and policy decisions from the operator surfaces.',
            sections: [
              {
                title: 'Web Control Surfaces',
                items: [
                  'System is the cross-product operations overview for runtime health, recent assistant activity, pending approvals, and links to the owner pages.',
                  'Performance shows workstation pressure, reviewed cleanup previews, and profile-aware latency targets.',
                  'Security Overview now owns the short `Needs Attention` queue, and Security Log remains the full action-and-evidence surface for alert triage.',
                  'Use `Agent Runtime` when you want the recent job view for assistant work, background work, and held follow-up results.',
                  'Held results can be replayed, kept held, or dismissed directly from `Agent Runtime`.',
                  'System includes `Runtime Execution`, the timeline for assistant dispatches, routine and scheduled-task runs, and coding-session execution that does not belong on Automations.',
                  'Use `Runtime Execution` when you need to reconstruct what Guardian did, where a run paused, or which step failed.',
                  'Runtime Execution can also show delegated or child runs so you can tell whether background work finished.',
                  'System also includes `Routing Trace`, a compact view of recent request decisions when you need to understand why Guardian answered or resumed a request a certain way.',
                  'System shows the global pending-approval queue alongside runtime state. Configuration > Tools is where you manage tool policy and recent tool jobs. Security is where you review alerts, posture, and security activity.',
                ],
              },
              {
                title: 'CLI Control Surfaces',
                items: [
                  'Use `/assistant summary`, `/assistant sessions`, `/assistant jobs`, `/assistant traces`, `/assistant routing`, and `/assistant policy` for the same operational visibility in the terminal.',
                  'Use `/assistant jobs all` when you want the raw recent job feed instead of the filtered operator view.',
                  'Use `/assistant jobs followup <jobId> <replay|keep_held|dismiss>` when a held result is waiting for operator review.',
                  'Use `/tools` to inspect tool policy and pending approvals, and `/approve` or `/deny` as fallback commands if native prompts are not suitable.',
                  'Use `/mode` to switch between auto, local, managed cloud, and frontier routing without changing agent definitions.',
                  'Guardian chat can also explain the CLI command surface in normal language. Ask things like "How do I attach a coding workspace from the CLI?" and it should answer from the built-in command guide, then point you to `/help <command>` for exact syntax.',
                  'Auto mode chooses the best available AI path for the request. If only one AI path is available, Guardian uses it automatically.',
                  'Blocked work such as approvals, clarifications, and workspace switches can be resumed cleanly across the supported operator surfaces.',
                ],
                note: 'Approval prompts should normally be handled through the native buttons or inline prompt flow first. Fallback commands remain useful for remote or scripted sessions.',
              },
            ],
          },
          {
            id: 'tools-and-approvals',
            title: 'Tools, Approvals, And Browser Automation',
            summary: 'Run workstation tools safely, tune policy boundaries, and understand how browser sessions behave.',
            sections: [
              {
                title: 'Tool Governance',
                items: [
                  'Configuration > Tools is the main operator surface for tool enablement, policy, and recent jobs, while System carries the global pending-approval queue.',
                  'Configuration > Security is where you review or change the main protection settings for browser, shell, and other higher-risk actions.',
                  'Use CLI `/tools` for the same operational visibility when you are working outside the web UI.',
                  'Treat allowed paths, commands, and domains as trust boundaries, not convenience toggles.',
                  'Coding work stays scoped to the active coding session instead of silently widening normal chat access.',
                  'If a protected setting change is interrupted by auth, sign in again and retry the change from the web UI.',
                ],
              },
              {
                title: 'Approvals',
                items: [
                  'Pending tool actions show up through web approvals, CLI prompts, and Telegram approval flows.',
                  'Approval prompts should describe the requested action in readable product language rather than raw JSON.',
                  'In web chat and the Coding Workspace, approvals should appear inline with the blocked request when possible.',
                  'Short clarification answers such as `Use Gmail`, `Codex`, or `Repo work` should continue the blocked task rather than start a new unrelated one.',
                  'If a request needs a workspace switch, provider choice, or allowed-path confirmation, answer that blocker directly and Guardian should resume the original task.',
                  'Saving or exporting to a protected path, running managed installs, or executing higher-risk repo actions can require approval before Guardian continues.',
                  'Inside code sessions, safe repo-local reads and edits stay low-friction, while repo execution and persistence actions need either stronger trust or explicit approval.',
                  'Use `/approve [approvalId]` and `/deny [approvalId]` as fallback commands when native approval controls are unavailable.',
                  'Recent approval outcomes stay visible in product history views so you can verify what was allowed or denied.',
                ],
              },
              {
                title: 'Managed Package Installs',
                items: [
                  'Ask the assistant to perform public package-manager installs through the managed path when you want Guardian to review packages before execution.',
                  'Supported v1 forms are explicit registry installs for `npm install`, `pnpm add`, `yarn add`, `bun add`, and `pip install`.',
                  'Guardian rejects command chaining, redirects, local paths, direct URLs, VCS specs, requirements files, and editable installs in this path so the review stays deterministic.',
                  'If the staged review is `caution`, re-run with explicit caution acceptance. If the staged review is `blocked`, the install does not proceed.',
                  'Use the Security page to review package-install alerts under the unified alert feed. The alert source for this feature is `install`.',
                ],
              },
              {
                title: 'Browser Automation',
                items: [
                  'Browser automation is built into Guardian.',
                  'Use the built-in browser actions exposed through chat and automations rather than trying to wire in separate browser tools yourself.',
                  'Guardian can inspect page state, extract content, follow links, and interact with supported web pages through the managed browser surface.',
                  'Browser navigation only supports HTTP and HTTPS targets, and private hosts are blocked for SSRF protection.',
                  'Use Configuration > Security > Browser Automation > Allowed Domains to add browser hosts manually. An entry such as `httpbin.org` also covers subdomains like `www.httpbin.org`.',
                  'Browser configuration changes can be applied from the web UI or CLI.',
                  'Third-party browser-like integrations should still be treated carefully and require explicit approval before use.',
                ],
              },
            ],
          },
          {
            id: 'coding-assistant-ide',
            title: 'Coding Workspace',
            summary: 'Use persistent code sessions, Monaco editing, bounded repo review, and session-scoped approvals for repo work.',
            sections: [
              {
                title: 'Start A Code Session',
                items: [
                  'Create a code session either from Guardian chat or from `#/code` by choosing a title plus the workspace root you want Guardian to anchor to.',
                  'Each code session keeps its own coding context, repo state, approvals, recent jobs, and verification history.',
                  'Creating or attaching a code session authorizes repo-local work for that session. It does not widen general non-Code file access.',
                  'Guardian chat is the canonical coding chat in the web UI. CLI and Telegram can also attach to the same code session when you want to continue the work from another surface.',
                  'Guardian keeps one shared current coding session across web chat, CLI, and Telegram for the same user by default.',
                  'In the web UI, use the session cards in `#/code` to choose the current coding session and manage referenced workspaces. In CLI, use `/code attach <sessionId-or-match>` and `/code detach` for the same job.',
                  'Guardian chat can also switch, list, inspect, and detach coding sessions directly from normal-language requests.',
                  'Repo-scoped search requests in an attached coding workspace stay inside that workspace and use Guardian’s guarded code search tools by default.',
                  'Repo-grounded inspect and review requests prefer Guardian’s built-in file and code search tools before shell or git output, unless you explicitly ask for shell or git output.',
                ],
              },
              {
                title: 'IDE And Session Context',
                items: [
                  'The Coding Workspace page (`#/code`) is a workbench: session rail, explorer, editor and diff view, manual terminal panes, activity, and a code inspector for guided investigation.',
                  'Session context survives refreshes and can be reused from other attached surfaces.',
                  'Guardian chat stays available while you are in the Coding Workspace and follows the currently attached code session.',
                  'Attached coding sessions keep the shared workspace context and approvals. The current provider or chat mode still applies unless you explicitly change it.',
                  'When the workbench is opened from a run or history link, it can open a session for inspection without changing which session is currently attached to Guardian chat.',
                  'The Sessions rail keeps one current coding workspace selected at a time. Other saved sessions stay available as referenced context by default, and Guardian caps the saved portfolio at four sessions so that cross-workspace context stays bounded.',
                  'The side rail also includes a `Sandboxes` tab for the active coding session when you want to create, inspect, refresh, or release a reusable remote sandbox instead of relying only on one-shot isolated runs.',
                  'The `Sandboxes` tab can create, inspect, refresh, stop, start, release, or reuse a remote sandbox for the active coding session.',
                  'If both Vercel and Daytona are available, Vercel is usually the quicker fit for short bounded runs, while Daytona is better for reusable or dependency-heavy workspaces.',
                  'Managed sandboxes show provider lifecycle state in the `Sandboxes` tab so you can monitor active resource usage directly.',
                  'The workbench activity rail shows the session timeline for approvals, verification, and recent work.',
                  'The activity rail now also shows the active coding workflow recipe and a stage rail for inspect, plan, implement, approve, verify, and summarize, including whether verification is still missing, running, failing, or complete.',
                  'When a ready isolated execution target exists, the workflow card can also flag that bounded jobs such as dependency install, build, or targeted verification should run through the configured sandbox instead of on the host.',
                  'When you want that isolated lane explicitly, Guardian can run one bounded repo command in the configured remote sandbox instead of on the host, and the normal code test/build/lint actions can use that same remote lane when requested.',
                  'Configure the remote sandbox lane from Cloud > Connections > Vercel or Cloud > Connections > Daytona.',
                  'If both Vercel and Daytona are configured, use Cloud > Connections > Cloud Controls > Default Remote Sandbox to choose which ready target Guardian should prefer by default.',
                  'Workspace Activity cards and recent timeline events can show the source badge for the final coding reply, so you can tell whether it came from the local, managed-cloud, or frontier path.',
                  'Use the Code activity timeline when you want the local story for one coding session. Use Automations > Execution Timeline when you want the global cross-session view.',
                  'Use the inline editor search beside `Inspect` to search within the current file, jump to each match in Monaco, and step forward or backward through repeated hits without opening the full Monaco find widget.',
                  'The editor theme selector can follow the current app bundle by default, or you can pin a different code theme when you want the IDE to diverge from the rest of the UI.',
                  'Manual terminals remain operator-controlled. Assistant actions still stay under approvals and policy rather than taking over a terminal directly.',
                  'Manual terminals are for operator use rather than a substitute for guarded assistant actions.',
                ],
              },
              {
                title: 'External Coding Backends',
                items: [
                  'Configuration > Integrations > Coding Assistants shows the external coding assistants Guardian can launch: Claude Code, Codex, Gemini CLI, and Aider.',
                  'That panel is intentionally simple: enable or disable the assistants you want available and choose a default when needed.',
                  'Guardian only uses these assistants when you explicitly ask to delegate coding work to one of them. Direct coding requests still use Guardian’s built-in coding tools by default.',
                  'Mentioning Codex or another assistant as the subject of a question is not enough to launch it. Questions such as "Why did Codex do this?" stay in normal explanation or investigation flow unless you explicitly ask Guardian to use that assistant.',
                  'In web chat and CLI, delegated coding assistants can surface live activity updates while they work. Telegram stays better suited to remote one-shot follow-up than dense live logs.',
                  'Approval copy for delegated coding assistants includes the active coding workspace so you can see which repo Guardian will launch the CLI in before you approve it.',
                  'If a delegated coding request explicitly names a different saved coding workspace, Guardian switches to that workspace before it launches the assistant. If the target is ambiguous, it stops and asks.',
                ],
              },
              {
                title: 'Code Inspector',
                items: [
                  'Use the `Inspect` button or editor actions in supported TypeScript and JavaScript files to open the code inspector for the selected symbol, current cursor region, or active file section.',
                  'The inspector can stay inline in the Code page or be detached into its own popup window when you want a larger parallel investigation surface while still editing.',
                  'The `Investigate` tab explains what the current code does, what it depends on, which deterministic risks or quality issues stand out, and where to inspect next.',
                  'The `Flow` tab focuses on symbol-level callers, callees, and local execution flow inside the active file or selected large-file section.',
                  'The `Impact` tab shows cross-file blast radius across related files and references.',
                  'Large files are inspected section by section instead of failing outright, so the inspector can anchor analysis to the current cursor or a chosen section without parsing the whole file at once.',
                  'Structure insights update from unsaved edits after a short delay, so the inspector can follow changes before you save.',
                ],
              },
              {
                title: 'Repo Trust And Native AV',
                items: [
                  'New code sessions do not assume a cloned repo is automatically safe. Guardian reviews the workspace and can block or slow down higher-risk actions until you trust it.',
                  'When native host protection is available, Guardian can use those results as part of the workspace trust decision.',
                  'The Code page exposes trust state directly through session badges, activity cards, and warning banners.',
                  'Activity cards and Edit Session explain why a repo was flagged and what to review next.',
                  'The most serious blockers are prioritised at the top of the trust findings.',
                  'Operators can manually trust the current findings from Edit Session. That override is session-scoped, keeps the raw findings visible, and clears automatically if the assessment changes.',
                  'If trust is not cleared, Guardian limits how much repo context it will rely on for autonomous work.',
                  'A `trusted` result means current checks did not find blocking indicators. It is not a guarantee that the repo is safe.',
                ],
              },
              {
                title: 'Coding Approvals',
                items: [
                  'Safe repo-local reads and edits remain low-friction inside the active workspace.',
                  'Execution and persistence actions only auto-approve when the effective workspace trust state is `trusted`.',
                  'Read-only shell commands such as `git status` stay low-friction. Non-read-only shell execution in a `caution` or `blocked` workspace requires approval even under autonomous policy mode.',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'providers-and-channels',
        title: 'Providers And Channels',
        description: 'Connect LLMs and external channels, then validate each path end to end.',
        pages: [
          {
            id: 'ollama-local',
            title: 'Connect Ollama (Local)',
            summary: 'Configure a local model for private, low-latency operation, including advanced Ollama runtime options when needed.',
            sections: [
              {
                title: 'Local Provider Setup',
                items: [
                  'Install and run Ollama locally before configuring Guardian Agent.',
                  'Pull at least one model first, for example `ollama pull gpt-oss:120b`.',
                  'In Configuration > AI Providers choose the local provider path, then set a profile name and model.',
                  'Use the checkbox beside a saved local profile when you want to keep it configured but temporarily remove it from live routing.',
                  'Set the local routed default if you want this profile to be the model Guardian uses whenever routing stays on the local tier.',
                  'CLI equivalent: `/config add ollama ollama gpt-oss:120b`.',
                  'With approval, Guardian can also inspect configured provider profiles and switch between already-available models for you.',
                ],
              },
              {
                title: 'Advanced Settings',
                items: [
                  'Local Ollama and Ollama Cloud both use the same native Ollama request controls inside Guardian.',
                  'Use the advanced section when you need to tune local Ollama behavior such as max tokens, temperature, timeout, keep-alive, think mode, or native Ollama options JSON.',
                  'Leave advanced settings empty unless you have a concrete reason to override the defaults.',
                ],
              },
              {
                title: 'Validation',
                items: [
                  'Use Configuration > AI Providers or CLI `/providers` to verify connectivity and model discovery.',
                  'The Configured Providers inventory is grouped in logical tier order: local first, then managed cloud, then frontier.',
                  'If the provider is unavailable, check the Ollama process and base URL before changing Guardian configuration.',
                ],
              },
            ],
          },
          {
            id: 'ollama-cloud',
            title: 'Connect Managed Cloud Providers',
            summary: 'Configure Ollama Cloud, OpenRouter, or NVIDIA Cloud as the managed-cloud middle tier when you want hosted models without routing every external request to the frontier tier.',
            sections: [
              {
                title: 'Managed-Cloud Setup',
                items: [
                  'In Configuration > AI Providers use the managed-cloud editor to add Ollama Cloud, OpenRouter, or NVIDIA Cloud profiles.',
                  'Set a profile name, the remote model, and the matching API key or credential ref.',
                  'While creating a new managed-cloud profile, Guardian suggests a starting model from the profile name, but you can still change it before saving.',
                  'Managed-cloud providers sit between local Ollama and frontier hosted providers in the provider list and Auto mode.',
                  'In Configured Providers choose the managed-cloud provider family Auto mode should use, such as Ollama Cloud, OpenRouter, or NVIDIA Cloud.',
                  'You can save multiple named profiles per managed-cloud family, for example a general profile plus separate direct, tools, and coding profiles.',
                  'A saved managed-cloud profile can be disabled from the left-side profile list without deleting it.',
                  'If you use multiple managed-cloud profiles, Configuration > AI Providers > Configured Providers lets you bind profiles separately for each provider family.',
                  'You can delete saved provider profiles from the AI Providers editor without manually cleaning up related defaults afterward.',
                ],
              },
              {
                title: 'Provider Family Guidance',
                items: [
                  'Use Ollama Cloud when you want remote Ollama-native models with the same Ollama controls you use locally.',
                  'Use OpenRouter when you want one managed-cloud profile family that can reach OpenRouter-hosted Qwen, Kimi, Claude, OpenAI, Google, and other catalog models through the OpenRouter API.',
                  'Use NVIDIA Cloud when you want NVIDIA NIM hosted models, including NVIDIA-published models and partner models available through your NVIDIA account.',
                  'The active managed-cloud family is selected in Configured Providers. The role profile selectors in that same section choose which saved profile in that family handles general, direct, tool-loop, and coding work.',
                ],
              },
              {
                title: 'Advanced Settings',
                items: [
                  'Ollama Cloud profiles support the same Ollama-native controls as local Ollama, including keep-alive, think mode, and native options JSON.',
                  'OpenRouter and NVIDIA Cloud profiles use OpenAI-compatible base URL paths; leave the defaults unless you have a deliberate reason to override them.',
                ],
              },
              {
                title: 'Current Ollama Cloud Role Models',
                items: [
                  'Treat these as current operator recommendations, not hardcoded product rules: `general` -> `gpt-oss:120b`, `direct` -> `minimax-m2.1`, `tools` -> `glm-4.7`, `coding` -> `qwen3-coder:480b`.',
                  'If you only want three managed-cloud profiles, merge `direct` into `general` first and keep `tools` plus `coding` separate.',
                  'Use the exact model names shown in Guardian model discovery, not alternate `-cloud` suffix examples you may see in some Ollama documentation.',
                ],
              },
              {
                title: 'Current OpenRouter Role Models',
                items: [
                  'Treat these as starting recommendations for OpenRouter: `general` -> `qwen/qwen3.6-plus`, `direct` -> `moonshotai/kimi-k2.6`, `tools` -> `moonshotai/kimi-k2.6`, `coding` -> `qwen/qwen3.6-coder` when available, or `qwen/qwen3.6-plus` if you want one Qwen profile for both general and coding work.',
                  'OpenRouter model IDs can change as catalog entries move, so use the exact IDs shown by OpenRouter or Guardian model discovery when saving profiles.',
                ],
              },
              {
                title: 'OpenRouter Fallback Behavior',
                items: [
                  'When an OpenRouter profile uses a specific model, Guardian asks OpenRouter to try that selected model first and then fall back to `openrouter/auto` if OpenRouter reports the selected model as unavailable, rate-limited, refused, or otherwise failed.',
                  '`openrouter/auto` lets OpenRouter choose a suitable model for the request shape from its supported automatic-routing pool.',
                  'The response still appears as a normal OpenRouter response, and the returned model field shows which model actually served the request.',
                  'This fallback is provider-side reliability for OpenRouter requests. It does not replace Guardian Auto mode, and it does not guarantee that every slow-but-successful upstream response will switch models.',
                  'If the selected profile is already `openrouter/auto`, Guardian leaves it as a normal automatic-router request instead of adding a duplicate fallback chain.',
                ],
              },
              {
                title: 'Current NVIDIA Cloud Role Models',
                items: [
                  'Treat these as starting recommendations for NVIDIA NIM: `general` -> `qwen/qwen3-5-122b-a10b`, `direct` -> `moonshotai/kimi-k2-instruct`, `tools` -> `moonshotai/kimi-k2-thinking`, `coding` -> `qwen/qwen3-coder-480b-a35b-instruct`.',
                  'Use the exact model IDs returned by NVIDIA Cloud model discovery because NIM model availability can vary by account and catalog rollout.',
                ],
              },
              {
                title: 'Validation',
                items: [
                  'Use Configuration > AI Providers or CLI `/providers` to confirm model discovery and connectivity.',
                  'If model loading fails, verify the API key first and then confirm the model exists for your Ollama Cloud, OpenRouter, or NVIDIA Cloud account.',
                  'Guardian does not hardcode managed-cloud plan concurrency in its config. Save the profiles you want, then let the upstream provider enforce its own plan-level concurrency and queueing.',
                ],
              },
            ],
          },
          {
            id: 'cloud-providers',
            title: 'Connect Hosted AI Providers',
            summary: 'Add hosted models from managed-cloud providers such as OpenRouter or NVIDIA Cloud, or frontier providers such as OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, or Google Gemini.',
            sections: [
              {
                title: 'External Provider Setup',
                items: [
                  'In Configuration > AI Providers choose the Frontier Providers section, then select the service, model, and credentials.',
                  'CLI equivalent: `/config add <name> <provider> <model> <apiKey>`.',
                  'Use the checkbox beside a saved frontier profile when you want to take it out of routing without deleting the stored model and credential settings.',
                  'Set the frontier routed default if you want Guardian to use a specific frontier profile whenever routing explicitly targets the frontier tier.',
                ],
              },
              {
                title: 'Built-In Provider Families',
                items: [
                  'Guardian supports local, managed-cloud, and frontier hosted AI provider tiers.',
                  'Use Ollama Cloud when you want Ollama-native managed access without moving all the way to a different frontier provider family.',
                  'Use OpenRouter when you want OpenRouter-hosted models, such as Qwen or Kimi coding models, inside the managed-cloud tier.',
                  'Use NVIDIA Cloud when you want NVIDIA NIM hosted models, such as Qwen3 Coder, Kimi K2, or Nemotron, inside the managed-cloud tier.',
                  'Use a frontier hosted provider when you want higher-quality responses or a fallback path beyond local and managed cloud.',
                  'Use the web picker to choose from the built-in supported services.',
                ],
              },
              {
                title: 'Usage Notes',
                items: [
                  'Use the web chat provider selector when you want one turn to go through a specific enabled provider profile, or use CLI `/mode` when you want to force `local`, `managed cloud`, or `frontier` directly.',
                  'Auto mode chooses between local, managed cloud, and frontier based on your saved provider policy and the kind of request you asked for.',
                  'Auto mode only considers enabled provider profiles. Disabled profiles stay saved in the config UI but are ignored until you re-enable them.',
                  'Guardian still requires at least one enabled AI profile overall, so disabling the last remaining provider is rejected.',
                  'In Configuration > AI Providers > Model Tier Selection Policy choose whether Auto should stay balanced or bias more aggressively toward frontier quality.',
                  'Balanced Auto can keep lighter external work on the selected managed-cloud family while escalating heavier repo-grounded synthesis or security-heavy work to the frontier default. Basic repo inspection uses the managed-cloud model with an iterative search/read loop.',
                  'Provider changes propagate to the running web UI immediately.',
                ],
              },
              {
                title: 'Auto Mode Basics',
                items: [
                  'A specific provider chosen in the web chat selector wins for that request.',
                  'CLI `/mode` can force `local`, `managed cloud`, or `frontier` when you want to stay inside one tier.',
                  'In normal Auto mode, Guardian prefers local for local-first work, can use the selected managed-cloud family for lighter external work, and can escalate to frontier when your policy allows it.',
                  'Inside each tier, Guardian uses the defaults and Auto policy you configured on the AI Providers page.',
                  'If you want more control over Auto mode, use Configuration > AI Providers > Model Tier Selection Policy.',
                ],
              },
            ],
          },
          {
            id: 'credential-storage',
            title: 'Credential Storage Options',
            summary: 'Guardian supports a simple paste-once path for most users and an environment-backed ref path for advanced operators.',
            sections: [
              {
                title: 'Simple Paste-Once Mode',
                items: [
                  'Paste provider, search, or Telegram secrets directly into the web configuration forms when you want the easiest setup path.',
                  'When a secret is already configured, the UI shows it as configured and lets you paste a replacement without revealing the current value.',
                ],
                note: 'The local secret store is primarily meant to keep secrets out of plain-text config. On shared servers or managed environments, prefer env-backed refs.',
              },
              {
                title: 'Advanced Env-Backed Refs',
                items: [
                  'Set the real secret in the host environment, for example `OPENAI_API_KEY` or `BRAVE_API_KEY`.',
                  'Open Configuration > AI Providers > Credential Refs and create a stable ref name such as `llm.openai.primary` that maps to that environment variable.',
                  'In provider, search, or Telegram settings, leave the secret field blank and enter that credential ref instead.',
                ],
              },
              {
                title: 'Which Path To Use',
                items: [
                  'Use paste-once local storage for laptops, desktops, and straightforward single-host deployments.',
                  'Use env-backed refs when the app is deployed through service managers, containers, CI, or any environment where operators already manage secrets outside the app.',
                  'Both paths work the same once configured.',
                ],
              },
            ],
          },
          {
            id: 'google-workspace',
            title: 'Google Workspace',
            summary: 'Enable Gmail, Calendar, Drive, Docs, Sheets, and Contacts via native integration.',
            sections: [
              {
                title: 'Integration',
                items: [
                  'Google Workspace is supported directly inside Guardian for Gmail, Calendar, Drive, Docs, Sheets, and Contacts.',
                  'You do not need a separate Google CLI tool to use the built-in Google Workspace features.',
                  'Status-only requests for Gmail, Google Calendar, or Google Workspace report connection and enabled-service state without reading mailbox, calendar, Drive, Docs, Sheets, or Contacts contents.',
                ],
              },
              {
                title: 'Setup (3 Steps)',
                items: [
                  'Step 1 — Create OAuth credentials: Go to the Google Cloud Console (console.cloud.google.com). Create a new project if needed (top-left project selector > New Project). Navigate to APIs & Services > Credentials. Click "+ Create Credentials" > "OAuth client ID". IMPORTANT: Set Application type to "Desktop app" (not "Web application"). Give it any name (e.g. "Guardian Agent Desktop") and click Create. On the confirmation dialog, click "Download JSON" to get your client_secret.json file.',
                  'Before creating credentials you may need to configure the OAuth consent screen: Go to Google Auth Platform > Audience (or OAuth consent screen). Set user type to External, fill in the app name and your email, save. Then under Publishing status click "Publish App" — without this, only manually-added test users can authenticate.',
                  'Enable the Google APIs you plan to use: Go to APIs & Services > Library. Search for and enable: Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API. Only enable what you need.',
                  'Step 2 — Upload credentials: In Guardian Agent, open Cloud > Connections > Google Workspace. Select Native mode, then upload the `client_secret.json` file you downloaded, or manually place it at `~/.guardianagent/google-credentials.json`.',
                  'Step 3 — Connect: Select the Google services you want (Gmail, Calendar, Drive, Docs, Sheets, Contacts). Click "Connect Google". A browser window opens for Google consent. Approve access, and the connection is live immediately. If you close the auth window before finishing, Guardian resets the pending attempt so you can click Connect Google again immediately.',
                ],
              },
            ],
          },
          {
            id: 'microsoft-365',
            title: 'Microsoft 365',
            summary: 'Enable Outlook Mail, Calendar, OneDrive, and Contacts via native Microsoft Graph integration.',
            sections: [
              {
                title: 'Integration',
                items: [
                  'Microsoft 365 is supported directly inside Guardian for Outlook Mail, Calendar, OneDrive, and Contacts.',
                  'You can connect a personal Microsoft account or an organization account that allows the required access.',
                ],
              },
              {
                title: 'Setup (3 Steps)',
                items: [
                  'Step 1 — Register app: Go to the Microsoft Entra admin center (entra.microsoft.com). Click "New registration". Name it anything (e.g. "Guardian Agent"). Set supported account types to "Any Entra ID directory + personal Microsoft accounts". Under Redirect URI, select "Mobile and desktop applications" and enter http://localhost:18433/callback. Click Register. Then go to Authentication > Settings, enable "Allow public client flows", and click Save. Copy the Application (client) ID from the Overview page.',
                  'Step 2 — Enter Client ID: In Guardian Agent, open Cloud > Connections > Microsoft 365. Paste the Application (client) ID. Tenant ID defaults to `common`; use `consumers` for personal Microsoft accounts only, `organizations` for work or school accounts only, or a specific tenant ID/domain for a known organization.',
                  'Step 3 — Connect: Select the services you want (Mail, Calendar, OneDrive, Contacts). Click "Connect Microsoft". A browser window opens with Microsoft account selection for consent. Approve access, and the connection is live immediately. If you close the auth window before finishing, Guardian resets the pending attempt so you can click Connect Microsoft again immediately.',
                ],
              },
              {
                title: 'Available Services',
                items: [
                  'Mail — read, search, draft, send, folders, attachments via Outlook.',
                  'Calendar — list events, calendar view with recurring expansion, create/update/delete events.',
                  'OneDrive — list files, search, get metadata, storage quota.',
                  'Contacts — list, create, update, delete contacts.',
                  'User — get current user profile (display name, email address).',
                ],
              },
            ],
          },
          {
            id: 'vercel-remote-sandbox',
            title: 'Vercel Remote Sandbox',
            summary: 'Configure an isolated Vercel sandbox target so Guardian can run bounded coding jobs away from the host.',
            sections: [
              {
                title: 'What This Adds',
                items: [
                  'Vercel remote sandboxing is optional. Normal repo browsing and editing can stay local, while higher-risk bounded jobs such as install, build, test, lint, or targeted verification can be pushed into the remote sandbox.',
                  'Guardian uses the existing Vercel cloud profile model for this. You do not need a separate connector family just for sandboxing.',
                  'For the normal local Guardian setup, use a Vercel access token plus the Vercel Team ID and the Project ID of the sandbox project.',
                ],
              },
              {
                title: 'Values To Collect From Vercel',
                items: [
                  'Create or choose a dedicated Vercel project for sandbox work, for example `guardian-sandbox`. The project name or slug is not the same thing as the Project ID.',
                  'Use the current Vercel dashboard left sidebar. First choose the correct team or account scope from the left side, then open Settings > General to copy the Team ID.',
                  'Open the sandbox project from the left sidebar, then open that project\'s Settings > General to copy the Project ID.',
                  'Create a Vercel access token from your account settings and make sure it has access to the team that owns the sandbox project.',
                  'If you also see a team slug or project slug in Vercel, treat those as different identifiers. Guardian\'s normal sandbox setup uses Team ID and Project ID, not the slug.',
                ],
              },
              {
                title: 'Guardian Setup',
                items: [
                  'Open Cloud > Connections > Vercel in Guardian.',
                  'Enter a Profile ID and Name for the saved Vercel profile.',
                  'Paste the Vercel access token into Access Token, or use a Credential Ref if you keep the token outside Guardian.',
                  'Enter the Team ID exactly as shown by Vercel, enable Vercel Sandbox, and paste the Project ID of the sandbox project.',
                  'Leave Team Slug blank for the normal sandbox setup. Only use Team Slug for advanced non-sandbox Vercel API scope cases where you intentionally are not using Team ID.',
                  'If you also have Daytona configured, set Cloud Controls > Default Remote Sandbox to this Vercel target when you want Guardian to prefer Vercel automatically for isolated verification runs.',
                  'Leave the default API base URL unless you have a deliberate reason to point Guardian at a different compatible endpoint.',
                  'If you want bounded package install or dependency verification inside the sandbox, keep outbound network enabled and optionally add a small domain allowlist.',
                ],
              },
              {
                title: 'Validation',
                items: [
                  'Save the Vercel profile from Cloud > Connections first and make sure the profile no longer shows configuration errors.',
                  'Use the profile-level Test Connection button in Cloud > Connections > Vercel when you want to verify the saved token, team, and project scope before you try isolated coding work.',
                  'Open Code and attach the repo session you want to work in.',
                  'Open the Code side rail `Sandboxes` tab if you want to create a managed reusable Vercel sandbox for that session instead of only triggering one-off isolated runs.',
                  '**Manual Lifecycle Control:** Persistent Vercel sandboxes support **Stop** in the Sandboxes tab and remain visible after they stop. Because Vercel does not restart the same stopped sandbox, use **Release** and then create a new managed sandbox when you need another session.',
                  '**Status Visibility:** Managed sandboxes show the provider-reported lifecycle state, including **RUNNING**, **STOPPED**, **EXPIRED**, **FAILED**, or **UNREACHABLE**, so you can monitor cloud resource usage at a glance.',
                  'Use an explicitly isolated coding action when you want Guardian to verify that the remote sandbox path is live.',
                  'If a save fails, re-check that Team ID looks like `team_xxx`, Project ID looks like `prj_xxx`, and Team Slug is blank unless you intentionally chose the advanced slug path.',
                ],
              },
            ],
          },
          {
            id: 'daytona-remote-sandbox',
            title: 'Daytona Remote Sandbox',
            summary: 'Configure a Daytona sandbox target so Guardian can run bounded coding jobs in a simpler cloud-isolation path.',
            sections: [
              {
                title: 'What This Adds',
                items: [
                  'Daytona remote sandboxing is optional. Normal repo browsing and editing can stay local, while bounded higher-risk jobs such as install, build, test, lint, or targeted verification can be pushed into Daytona.',
                  'Compared with Vercel, the normal Daytona setup is simpler: one API key, optional target, and optional API URL override.',
                  'Guardian treats Daytona as another remote execution target inside the same shared isolation system used by Vercel.',
                ],
              },
              {
                title: 'Values To Collect From Daytona',
                items: [
                  'Create or copy a Daytona API key from your Daytona account.',
                  'If you use Daytona Cloud, the normal API URL is the default and can be left blank in Guardian.',
                  'If your Daytona account uses multiple targets or regions, collect the target name you want Guardian to use for isolated runs.',
                  'Only collect CIDR ranges if you intentionally want to restrict sandbox egress. Daytona uses CIDR allowlists here rather than domain allowlists.',
                ],
              },
              {
                title: 'Guardian Setup',
                items: [
                  'Open Cloud > Connections > Daytona in Guardian.',
                  'Enter a Profile ID and Name for the saved Daytona profile.',
                  'Paste the Daytona API key into API Key, or use a Credential Ref if you keep the key outside Guardian.',
                  'Enable Daytona Sandbox, optionally set a Target, and leave Sandbox Language as `typescript` unless you have a specific reason to change it.',
                  'Leave API URL blank for the normal Daytona Cloud path. Only fill it in when you intentionally use a different Daytona endpoint.',
                  'If you want bounded package install or dependency verification inside Daytona, keep outbound network enabled. If you need tighter egress control, add CIDR ranges in the Outbound CIDR Allowlist field.',
                  'If you also have Vercel configured, set Cloud Controls > Default Remote Sandbox to this Daytona target when you want Guardian to prefer Daytona automatically for isolated verification runs.',
                ],
              },
              {
                title: 'Validation',
                items: [
                  'Save the Daytona profile from Cloud > Connections first and make sure the profile no longer shows configuration errors.',
                  'Use the profile-level Test Connection button in Cloud > Connections > Daytona when you want a quick API-key and target check.',
                  'Open Code and attach the repo session you want to work in.',
                  'Open the Code side rail `Sandboxes` tab if you want to create a managed reusable Daytona sandbox for that session instead of only triggering one-off isolated runs.',
                  '**Manual Lifecycle Control:** Persistent Daytona sandboxes support both **Stop** and **Start** in the Sandboxes tab, so you can hibernate a managed sandbox and later resume the same workspace.',
                  '**Status Visibility:** Managed sandboxes show the provider-reported lifecycle state, including **RUNNING**, **STOPPED**, **STARTING**, **FAILED**, or **UNREACHABLE**, so you can monitor cloud resource usage at a glance.',
                  'Use an explicitly isolated coding action when you want Guardian to verify that the Daytona remote sandbox path is live.',
                ],
              },
            ],
          },
          {
            id: 'telegram',
            title: 'Telegram Channel',
            summary: 'Bring the assistant into Telegram with BotFather setup, chat access, and proactive delivery.',
            sections: [
              {
                title: 'Bot Setup',
                items: [
                  'Create the bot through `@BotFather` using `/newbot`, then copy the returned token.',
                  'Enable Telegram in Configuration > Integration System, then either paste the token once for secure local storage or leave the token field blank and provide an env-backed credential ref.',
                  'Integration System stays limited to operator access, channels, and maintenance. AI provider, search, and cloud connection details live on their own owner tabs.',
                  'Send at least one message to the bot, then fetch your `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates`.',
                  'Paste allowed chat IDs into the configuration when you want an explicit Telegram allowlist and proactive fanout target list. Group IDs are commonly negative and often start with `-100`.',
                  'If you leave the allowlist empty, proactive Telegram delivery can still target chats that have already talked to the bot during the current runtime.',
                ],
              },
              {
                title: 'CLI Equivalent',
                items: [
                  'Use `/config telegram on`, `/config telegram token <token>`, `/config telegram chatids <id1,id2,...>`, and `/config telegram status`.',
                  'Telegram channel changes are hot-reloaded, so enable/disable and token updates apply without a full application restart.',
                ],
              },
            ],
          },
          {
            id: 'web-search-and-document-search',
            title: 'Web Search And Document Search',
            summary: 'Use live web search, page fetch, and local document search together without losing source control.',
            sections: [
              {
                title: 'Web Search',
                items: [
                  'Built-in web search and fetch tools can run through the configured search provider path without leaving Guardian controls.',
                  'Use Configuration > Search Providers to set provider options and either paste premium search keys once or assign env-backed credential refs.',
                  'Configuration > Search Providers only owns search and retrieval behavior. Ollama and other LLM provider profiles stay in Configuration > AI Providers.',
                  'Search config changes apply immediately and invalidate the web UI so the current state stays visible.',
                ],
              },
              {
                title: 'Document Search',
                items: [
                  'Document search can combine keyword and semantic matching across local directories, repositories, URLs, and files.',
                  'When you already know the exact local PDF path, use `fs_read` to extract the document text directly instead of indexing first.',
                  'Use Configuration > Search Providers to add, remove, enable, disable, or reindex document sources.',
                  'The Search Providers overview keeps the page focused on source management instead of decorative status cards.',
                  'Keep collections tight and purposeful so retrieval quality remains high and reindex times stay reasonable.',
                ],
                note: 'Treat web search and document search as complementary: web search is for external freshness, document search is for trusted local context.',
              },
            ],
          },
        ],
      },
      {
        id: 'automation-and-operations',
        title: 'Automation And Operations',
        description: 'Operate workstation performance, scheduled work, tool output, and network or intel workflows.',
        pages: [
          {
            id: 'performance',
            title: 'Performance',
            summary: 'Use the Performance page for workstation health, editable performance profiles, latency checks, and reviewed process cleanup actions.',
            sections: [
              {
                title: 'What Performance Owns',
                items: [
                  'Performance is the workstation-operations page for host pressure, process visibility, editable profile definitions, and reviewed cleanup actions.',
                  'Overview shows the latest CPU, memory, disk, process pressure, and latency checks for the active profile.',
                  'Profiles is the working profile library where you create, edit, apply, and delete workstation modes.',
                  'Profiles also exposes a live running-process browser grouped by executable name so you can add current apps directly into the protect or cleanup lists.',
                  'Cleanup builds a reviewed recommendation set from the active profile and current process list before Guardian touches anything.',
                  'History records profile switches and reviewed cleanup runs performed from the page.',
                ],
              },
              {
                title: 'Reviewed Process Cleanup',
                items: [
                  'Use the Cleanup tab to generate a reviewed cleanup preview before Guardian stops any process.',
                  'Guardian shows the exact process rows it proposes, and selectable rows are checked by default.',
                  'Protected rows remain visible but disabled so you can see why Guardian refused to include them.',
                  'Uncheck any process you do not want touched, then confirm the final selected subset with the run button when the current runtime supports host process control.',
                  'If the runtime is read-only, the preview is still useful for tuning profile rules before you switch to a writable environment.',
                  'The profile editor also includes a direct Preview Cleanup path so you can apply a saved profile and jump into review without bypassing the cleanup safety gate.',
                ],
              },
              {
                title: 'Profiles And Limits',
                items: [
                  'Profiles are config-backed, but the page is now the canonical operator surface for creating and maintaining them.',
                  'Performance is a top-level operator surface separate from Second Brain. Use it for workstation state and guarded cleanup, not personal planning or knowledge capture.',
                  'The active profile controls which process names are treated as terminate candidates and which names are protected.',
                  'Protected means Guardian will not target that executable name for cleanup. It does not guarantee the app is launched.',
                  'Latency checks live with the profile definition so Overview can show whether slowness is local host pressure or upstream/API latency.',
                  'This build keeps cleanup behavior conservative: the reviewed process-selection path is the primary supported mutation surface.',
                  'If a profile reports that power-mode changes are not available on the current OS, Guardian still switches the active profile and tells you that the host tuning step was skipped.',
                  'Power users can also reach the same performance controls from chat or saved automations.',
                ],
              },
            ],
          },
          {
            id: 'automations',
            title: 'Automations',
            summary: 'Build deterministic workflows, scheduled assistant reports, or manual on-demand assistant automations, then run them from Automations or on a cron schedule.',
            sections: [
              {
                title: 'Create And Run',
                items: [
                  'The Automations page is the unified home for saved automations, schedules, and built-in starter examples.',
                  'Automations can run a single tool, multiple workflow steps, a scheduled assistant task, or a manual on-demand assistant automation.',
                  'You can combine read, write, browser, instruction, and delay-style steps in one workflow when the job needs more than a single action.',
                  'The tool picker (Browse button) lets you search tools by name or description and shows integration requirements (e.g. Google Workspace connected, AWS profile configured).',
                  'Performance automation for power users should use the performance built-in tools directly rather than trying to route workstation cleanup through Second Brain.',
                  'If a single-tool automation also needs a written summary, the editor can help you expand it into a multi-step workflow.',
                  'The AI selector lets you use auto mode or force a local or hosted model path for the automation.',
                  'Use Edit for normal updates such as names, tools, steps, and schedules without dropping into raw JSON.',
                  'Advanced JSON editing is available for power users, but normal updates should stay in the structured form. Built-in examples must be copied before editing.',
                  'Use the `Use Example` action on built-in starter rows to create a saved automation such as Agent Host Guard or Firewall Sentry, and use `Create Copy` to fork an already-saved automation.',
                  'Use Dry Run before live execution when you want a safe preview path.',
                  'Named automations can also be controlled from chat: Guardian can inspect, run, enable, disable, or delete saved automations.',
                  'Chat requests such as `List my automations` should return the saved automation catalog directly instead of a vague summary.',
                  'When Guardian truncates a direct list response, follow-ups like `show me the remaining items`, `list the additional 25 automations`, `show me the additional 5 links`, or `show me 2 more emails` should continue from the prior window instead of starting over.',
                  'Immediately after Guardian creates an automation, follow-ups like `disable that automation` or `show me that automation` should resolve to the most recent saved automation from the conversation.',
                  'If a chat automation request is incomplete, Guardian returns a draft instead of guessing the missing schedule, goal, or steps.',
                ],
              },
              {
                title: 'Ask For The Right Shape',
                items: [
                  'For repeatable monitoring and threshold checks, ask for a deterministic workflow explicitly. Example: `Create a deterministic scheduled automation named "WHM Social Check Disk Quota". Run it daily at 9:00 AM. Do not create an assistant automation. Create a step-based workflow using built-in tools only. Query the WHM Social profile for all accounts with disk used and quota, compute remaining MB, and notify me in the web channel only when any account has 100 MB or less remaining. If no account is near quota, do not send a notification.`',
                  'For recurring open-ended research or briefing work, ask for a scheduled assistant task explicitly. Example: `Create a scheduled assistant automation named "Daily Threat Brief". Run it every weekday at 8:00 AM. Use built-in tools to review saved watchlists, summarize the most important changes, and deliver the report to the web channel.`',
                  'For operator-triggered work that should not run on a timer, ask for a manual assistant automation explicitly. Example: `Create a manual assistant automation named "Investigate New Domain". Do not schedule it. When I run it, inspect the supplied domain with built-in tools, summarize findings, and stop for approval before any outreach or mutation.`',
                  'Be explicit about delivery. Scheduled automations should normally deliver to `web`, `telegram`, or `cli`, or stay `scheduled` with no direct message delivery. Do not use `code-session` as the delivery channel for recurring scheduled runs.',
                ],
                note: 'If you only describe the goal in open-ended language, Guardian may choose an assistant automation. If you want fixed tool steps, say `deterministic`, `step-based workflow`, and `do not create an assistant automation`.',
              },
              {
                title: 'Scheduling And Limits',
                items: [
                  'Any automation can be given a cron schedule and turned into a recurring task, or left manual-only so it runs only when an operator triggers it.',
                  'Use Single shot when you want the task to run once on the next matching schedule and then disable itself automatically.',
                  'Scheduled assistant tasks are best for recurring briefs, watchlists, and open-ended checks that should decide what to inspect at runtime.',
                  'Pre-flight approval check: when scheduling an automation, the system checks whether any tools will require manual approval at runtime. If so, a validation panel shows the issues with one-click "Auto-approve" buttons that set per-tool auto policies. You can also skip the check and accept that each run may need manual approval.',
                  'Scheduled task creation is the approval checkpoint. After the task is saved, later cron runs do not re-prompt for the same action.',
                  'Power-user options remain available through the advanced JSON/config sections when you need direct definition edits.',
                  'Automation settings let you control how large or parallel a run can become.',
                  'Permission policies still restrict what hosts, file paths, and commands an automation can touch.',
                ],
              },
              {
                title: 'Inspect Results',
                items: [
                  'Automations now separates `Output` from `History & Timeline`, so the page no longer mixes raw run output with the chronological execution view in one long panel.',
                  'The `Output` tab leads with a readable run result summary for each recent run, then lets you expand into raw per-step output only when you need it.',
                  'Run history now keeps per-step output, not just status text.',
                  'Saved automations keep enough history for Guardian to review earlier runs later without you having to rerun them.',
                  'Approval-gated automations keep one stable run record and resume after the approval decision instead of starting over from scratch.',
                  'Manual and scheduled automation runs can be expanded in the `Output` tab to inspect captured output.',
                  'The `History & Timeline` tab keeps the compact run ledger together with the automation execution view for recent automation runs only.',
                  'Use `History & Timeline` when you need to answer "what happened in this automation run?" and use `Output` when you need the automation-specific result payload, step output, and artifacts.',
                  'Use `System > Runtime Execution` when you need assistant, routine, scheduled-task, or code-session timeline detail that does not belong to a saved automation.',
                  'When an automation targets an assistant, the assistant picker includes the current role label or lane so you can choose the right coordinator surface without guessing from the raw agent id alone.',
                  'Where output is shown in the UI, operators can copy it directly or export it as plain text or HTML for sharing and review.',
                  'Live UI invalidation updates the Automations page when runs finish, schedules change, or automations are edited.',
                ],
              },
              {
                title: 'Security Automation Starters',
                items: [
                  'Use `agent-host-guard` when you want workstation baseline and anomaly-response playbooks.',
                  'Use `firewall-sentry` when you want host and gateway firewall posture checks plus firewall-drift triage.',
                  'Those packs now include unified alert search and operating-mode recommendation steps so the operator gets both raw findings and a posture recommendation in one run.',
                  'Preset scheduled jobs such as `host-monitor-watch`, `firewall-posture-watch`, `gateway-firewall-watch`, and `gateway-firewall-posture` are available from Examples.',
                ],
              },
            ],
          },
          {
            id: 'network-operations',
            title: 'Network Operations',
            summary: 'Use the Network page for inventory, one-off diagnostics, and network run history. Use Security for the unified alert queue.',
            sections: [
              {
                title: 'Core Tabs',
                items: [
                  'Overview summarizes device counts, baseline readiness, active alerts, and quick actions.',
                  'Devices shows discovered devices, trust state, open ports, and first/last seen timestamps.',
                  'Security owns the unified alert queue; Network keeps the operational device and diagnostics views.',
                  'History shows recent scheduled and manual network runs with expandable per-step output.',
                ],
              },
              {
                title: 'Tools Tab',
                items: [
                  'The Diagnostics tab groups network tools by category and uses dropdown selectors instead of a scrolling tab strip.',
                  'Choose a category first, then select the specific tool to run.',
                  'Each tool panel keeps its own argument form and result viewer so raw output is inspectable immediately.',
                  'Live result panels include Copy, Text export, and HTML export actions so one-off scan output can be reused outside the web UI.',
                ],
              },
              {
                title: 'What Gets Persisted',
                items: [
                  'Inventory-oriented outputs feed the device inventory service automatically.',
                  'Threat and baseline actions update the network baseline and alert state.',
                  'Scheduled network jobs also write structured history entries so operators can review what ran and what it returned.',
                  'Expanded history output uses the same copy and export controls as live results, so archived runs can be saved as `.txt` or `.html` without rerunning the tool.',
                ],
              },
            ],
          },
          {
            id: 'threat-intel-and-campaigns',
            title: 'Threat Intel And Campaigns',
            summary: 'Run watchlist scans, triage findings, draft responses, and use approval-gated outreach workflows.',
            sections: [
              {
                title: 'Threat Intel Operator Surfaces',
                items: [
                  'Use Security > Threat Intel in the web UI to manage watch targets, change response mode, run manual scans, and review findings in one place.',
                  'CLI `/intel ...` is the full operator surface for threat intel: status, plan, watchlist management, scans, findings, finding status changes, drafted actions, and response mode changes.',
                  'Telegram currently exposes the three quick intel operators: `/intel status`, `/intel scan <query> [--darkweb]`, and `/intel findings`.',
                  'Threat-intel results stay visible in Security, and high-risk scan results are also promoted into the wider security signal path.',
                ],
              },
              {
                title: 'Threat Intel Commands And Tools',
                items: [
                  'CLI operators: `/intel [status]`, `/intel plan`, `/intel watch [list|add|remove] <target>`, `/intel scan [query] [--darkweb] [--sources=web,news,social,forum]`, `/intel findings [limit] [status]`, `/intel finding <id> status <new|triaged|actioned|dismissed>`, `/intel actions [limit]`, `/intel action draft <findingId> <report|request_takedown|draft_response|publish_response>`, and `/intel mode <manual|assisted|autonomous>`.',
                  'Built-in scheduled examples are available for recurring intel collection and recurring Assistant Security posture reviews.',
                  'Configuration > Security owns the managed Assistant Security monitoring schedule.',
                ],
              },
              {
                title: 'Threat Intel Operating Notes',
                items: [
                  'Response mode can be manual, assisted, or autonomous depending on your tolerance for automatic action.',
                  'Dark-web scanning is opt-in and disabled by default unless explicitly enabled.',
                  'Use watchlist entries for people, handles, brands, domains, and fraud or impersonation phrases you want monitored over time.',
                  'Treat third-party intel connectors carefully and keep them behind strict approval and access controls.',
                ],
              },
              {
                title: 'Campaign Workflows',
                items: [
                  'Discover contacts with `/campaign discover <url> [tagsCsv]` or import them from CSV.',
                  'Create campaigns with `/campaign create <name> | <subjectTemplate> | <bodyTemplate>`.',
                  'Preview content with `/campaign preview <campaignId> [limit]` before sending.',
                  'Run sends with `/campaign run <campaignId> [maxRecipients]`; outbound sends remain approval-gated.',
                ],
                note: 'Template placeholders such as `{name}`, `{company}`, and `{email}` are available in campaign subject and body templates.',
              },
            ],
          },
          {
            id: 'quick-actions-and-schedules',
            title: 'Quick Actions And Schedules',
            summary: 'Use fast structured actions for routine work, then promote repeatable tasks into scheduled automations.',
            sections: [
              {
                title: 'Quick Actions',
                items: [
                  'Quick actions are available in the web UI, CLI `/quick ...`, and Telegram `/quick ...` for common email, task, calendar, and security-review flows.',
                  'Use quick actions when the job is structured but not worth building a full playbook.',
                  'Quick action runs still pass through normal approval, policy, and audit controls.',
                ],
              },
              {
                title: 'When To Schedule',
                items: [
                  'Promote repetitive quick or manual workflows into Automations when they need cron execution, output history, or stronger guardrails.',
                  'Use scheduled automations for periodic network checks, intel scans, system health checks, and repeatable automation runs.',
                  'Review run history and step output after the first scheduled execution to confirm the automation is doing what you expect.',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'data-security-and-troubleshooting',
        title: 'Data, Security, And Troubleshooting',
        description: 'Understand identity, observability, and the fastest operator checks when something is off.',
        pages: [
          {
            id: 'identity-and-memory',
            title: 'Identity And Memory',
            summary: 'Control how users map across channels and how conversation state is retained.',
            sections: [
              {
                title: 'Identity Modes',
                items: [
                  '`single_user` shares one assistant identity across web, CLI, and Telegram.',
                  '`channel_user` keeps identities separate by channel unless you alias-map them deliberately.',
                  'Choose the mode that matches whether you want one shared assistant memory or distinct channel personas.',
                ],
              },
              {
                title: 'Memory Behavior',
                items: [
                  'Conversation memory is kept when available, with retention settings exposed through configuration.',
                  'The web `Memory` page is the unified operator surface for durable memory: global memory, code-session memory, operator-curated pages, derived indexes, linked outputs, and review-only records.',
                  'Operator-curated memory pages can be created, edited, and archived from the Memory page when durable memory is writable, and Guardian keeps those edits as durable memory entries.',
                  'The `Lint` tab exposes bounded per-scope cleanup plus direct edit or archive actions when a finding points at writable curated pages, and review-only findings can be hidden from the current view by turning off inactive results.',
                  'Guardian avoids exact duplicate memory saves, updates matching curated pages instead of stacking obvious duplicates, and keeps system-managed memory tidy over time.',
                  'Memory maintenance can be tuned from Configuration when you want Guardian to review older memory automatically.',
                  'Derived memory pages and hygiene findings are inspectable but remain read-only and refreshable by design.',
                  'Changing CLI routing mode or the web chat provider selection changes who answers, but it does not create a separate conversation by itself.',
                  'In the web chat, a specific provider selection still preserves normal tool use and answer-source labels.',
                  'The web chat provider selector is request-scoped and browser-session scoped, not a persistent config change.',
                  'Reset conversation state when you want a clean run without changing the longer-term identity policy.',
                  'If context looks stale, review memory, analytics, and search-oriented history together.',
                ],
              },
            ],
          },
          {
            id: 'analytics-and-observability',
            title: 'Analytics And Observability',
            summary: 'Use built-in analytics, audit history, and assistant state views to understand system behavior.',
            sections: [
              {
                title: 'Operator Views',
                items: [
                  'System gives the cross-surface runtime and owner-page status overview, while CLI `/analytics [minutes]` remains available for analytics summaries.',
                  'Assistant state shows recent jobs, failures, and what Guardian has been doing recently.',
                  'Security monitoring shows alerts, Assistant Security findings, and recent security activity.',
                ],
              },
              {
                title: 'Audit Workflow',
                items: [
                  'Use Security > Security Log or CLI `/audit`, `/audit summary`, and `/security` to inspect recent events.',
                  'Use the audit views when you need to confirm what happened, what was approved, or why an action was blocked.',
                  'Security Log entries can be expanded when you need more detail than the short preview.',
                  'Expanded Security Log alerts can include related audit events when Guardian can correlate nearby structured evidence.',
                  'Policy changes, auth changes, and tool decisions are reflected in the audit history.',
                ],
              },
            ],
          },
          {
            id: 'defensive-security-suite',
            title: 'Defensive Security Suite',
            summary: 'Use the Security page, native provider integrations, and agentic triage loop to operate the local defensive stack.',
            sections: [
              {
                title: 'Main Operator Surface',
                items: [
                  'The Security page is the main operator surface for the local defensive suite. It combines posture, Assistant Security, threat intel, the Security Log, and native Windows Defender visibility in one place.',
                  'Security Overview carries the short `Needs Attention` queue so alert triage does not have to live on the general System page.',
                  'Unified local security alerts currently aggregate host monitoring, network baseline and anomaly analysis, gateway firewall monitoring, native Windows Defender alerts, and package-install trust alerts.',
                  'Assistant Security keeps its full posture-and-workspace finding queue on the Assistant Security tab. Only promoted incident-candidate findings are added to Security Log.',
                  'Host persistence alerts are prioritised to reduce noise while keeping higher-risk autoruns prominent.',
                  'Use the Security page when you need posture and evidence. Use the Network page for device inventory and diagnostics, and the Code page when the issue is repo trust inside a coding session.',
                  'Built-in Assistant Security checks can be run from the assistant, automations, and the Security page.',
                  'Assistant Security continuous monitoring runs in the background rather than as a normal chat turn.',
                ],
              },
              {
                title: 'Profiles, Modes, And Containment',
                items: [
                  'Deployment profiles (`personal`, `home`, `organization`) are separate from operating modes (`monitor`, `guarded`, `lockdown`, `ir_assist`).',
                  'Monitor is the normal default. Posture can recommend escalation, and containment can temporarily auto-elevate to `guarded` when elevated alerts stack together.',
                  'Configuration > Security lets you tune how conservative Assistant Security should be before it tightens controls automatically.',
                  'Containment remains bounded and policy-driven. The shipped system does not fully auto-remediate or silently take over the host.',
                ],
              },
              {
                title: 'Native Host Protection',
                items: [
                  'Windows Defender is integrated as a native provider. Guardian can refresh status, show alerts, request scans, and request signature updates from the Security page.',
                  'Code sessions can use native AV results as part of repo trust and blocking decisions.',
                  'Managed package installs can also use native AV results and may block before install if a detection is found.',
                  'On Unix-like hosts, available native AV results can also inform code-session trust, but a clean scan does not override other suspicious repo findings.',
                ],
              },
              {
                title: 'Agentic Triage',
                items: [
                  'Guardian includes a conservative automated triage path for selected security events.',
                  'That triage path gathers evidence first, avoids noisy repeats, and records completed investigations in activity history.',
                  'Low-confidence triage skips are grouped in Assistant Security activity so routine monitor-only signals do not crowd out completed investigations.',
                  'It does not automatically acknowledge alerts or launch mutating host actions just because an alert fired.',
                ],
              },
              {
                title: 'Third-Party Connectors',
                items: [
                  'Third-party connector servers require explicit approval before Guardian will launch them.',
                  'Guardian keeps third-party connector access under tighter restrictions than built-in capabilities by default.',
                  'Assistant Security can surface connector exposure separately so operators can watch for added risk over time.',
                ],
              },
            ],
          },
          {
            id: 'policy-and-audit',
            title: 'Policy-As-Code And Audit',
            summary: 'Use deterministic policy rules and audit evidence together when you need to explain or change behavior safely.',
            sections: [
              {
                title: 'Policy Engine',
                items: [
                  'Policy-as-code supports off, shadow, and enforce modes depending on how aggressively you want rules to apply.',
                  'Configuration > Security and CLI `/policy ...` expose the current mode, family settings, and reload controls.',
                  'Shadow mode is the safest way to compare rule output with current behavior before switching to enforce.',
                ],
              },
              {
                title: 'Audit Use',
                items: [
                  'Audit entries capture policy changes, approvals, denials, security events, and important operator actions.',
                  'Use audit verification and summary views before changing policy if you need evidence of what actually happened.',
                  'Prefer adjusting the policy model or tool boundaries instead of repeatedly approving the same risky action by hand.',
                ],
              },
            ],
          },
          {
            id: 'security-and-troubleshooting',
            title: 'Security And Troubleshooting',
            summary: 'Start with auth, provider health, permissions, and audit evidence before assuming a deeper product issue.',
            sections: [
              {
                title: 'First Checks',
                items: [
                  'If the web UI rejects you, confirm whether Web Authentication is set to bearer_required and then check the bearer token or session cookie state.',
                  'If a save or browser-config action drops you back to the auth prompt, the secure web session expired. Re-enter the current web access token and retry the change.',
                  'If a model appears offline, verify connectivity in Configuration > AI Providers or with CLI `/providers`.',
                  'If file or command execution is blocked, review Configuration > Tools and Configuration > Security before retrying.',
                  'If repo execution is blocked in the Code page, inspect the code session workspace trust badge, native AV summary, approvals tab, and recent jobs before assuming the coding tools are broken.',
                  'If network data looks stale, use the Network History tab and recent outputs to confirm whether the scan actually ran.',
                ],
              },
              {
                title: 'Security Defaults',
                items: [
                  'Guardian blocks prompt injection patterns, secret leakage, and risky tool actions by default.',
                  'New code sessions authorize the workspace path for repo-local access, but they do not treat the attached repo as automatically safe for execution.',
                  'Web Authentication can be disabled on trusted networks, but bearer_required remains the safer default for the web UI.',
                  'Rotate web auth credentials from the web Config Center or with CLI `/auth rotate`; toggle bearer protection from CLI with `/auth enable` or `/auth disable`.',
                  'Security alerts stay focused on the higher-signal detections by default.',
                  'Use audit and policy views to understand why an action was denied instead of loosening controls blindly.',
                  'Outbound network tools are restricted to reduce private-host and metadata-service access risks.',
                  'Third-party connector servers should be treated with the same scrutiny as shell, browser, and network tooling when you decide whether to enable them.',
                ],
                note: 'Configuration changes should appear live in the web UI, so if something still looks wrong after a save, verify the current product state rather than assuming the browser is stale.',
              },
            ],
          },
        ],
      },
    ],
  };
}

export function formatGuideForCLI(guide: ReferenceGuide = getReferenceGuide()): string[] {
  const lines: string[] = [];
  lines.push(guide.title);
  lines.push(guide.intro);
  lines.push('');

  for (const category of guide.categories) {
    lines.push(category.title);
    lines.push(`  ${category.description}`);
    lines.push('');

    for (const page of category.pages) {
      lines.push(`- ${page.title}`);
      lines.push(`  ${page.summary}`);
      for (const section of page.sections) {
        lines.push(`  ${section.title}:`);
        for (const item of section.items) {
          lines.push(`    - ${item}`);
        }
        if (section.note) {
          lines.push(`    Note: ${section.note}`);
        }
      }
      lines.push('');
    }
  }

  return lines;
}

export function formatGuideForTelegram(guide: ReferenceGuide = getReferenceGuide()): string {
  const lines: string[] = [];
  lines.push(guide.title);
  lines.push(guide.intro);
  lines.push('');

  for (const category of guide.categories) {
    lines.push(`${category.title}:`);
    lines.push(category.description);
    lines.push('');

    for (const page of category.pages) {
      lines.push(`${page.title} - ${page.summary}`);
      for (const section of page.sections) {
        lines.push(`${section.title}:`);
        for (const item of section.items) {
          lines.push(`- ${item}`);
        }
        if (section.note) {
          lines.push(`Note: ${section.note}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function tokenizeGuidePromptQuery(value: string | undefined): string[] {
  const normalized = (value ?? '').toLowerCase();
  if (!normalized.trim()) return [];
  return Array.from(new Set(
    normalized
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3 || token === 'ui')
      .filter((token) => !GUIDE_PROMPT_STOP_WORDS.has(token)),
  ));
}

function countGuidePromptTokenMatches(text: string, tokens: readonly string[]): number {
  if (!tokens.length) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function buildGuidePromptSectionLine(
  section: ReferenceGuidePageSection,
  tokens: readonly string[],
  maxItems: number,
): string | null {
  const scoredItems = section.items
    .map((item, index) => ({
      item,
      index,
      score: countGuidePromptTokenMatches(item, tokens),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosenItems = (scoredItems.some((entry) => entry.score > 0) ? scoredItems : scoredItems.slice(0, maxItems))
    .slice(0, maxItems)
    .map((entry) => entry.item.trim())
    .filter(Boolean);
  if (!chosenItems.length) {
    return section.note?.trim()
      ? `${section.title}: ${section.note.trim()}`
      : null;
  }
  const note = section.note?.trim();
  const noteIsRelevant = note ? countGuidePromptTokenMatches(note, tokens) > 0 : false;
  return `${section.title}: ${chosenItems.join(' | ')}${note && noteIsRelevant ? ` | Note: ${note}` : ''}`;
}

export function formatGuideForPrompt(
  query?: string,
  guide: ReferenceGuide = getReferenceGuide(),
  options?: {
    maxPages?: number;
    maxSectionsPerPage?: number;
    maxItemsPerSection?: number;
  },
): string {
  const maxPages = Math.max(1, options?.maxPages ?? 6);
  const maxSectionsPerPage = Math.max(1, options?.maxSectionsPerPage ?? 2);
  const maxItemsPerSection = Math.max(1, options?.maxItemsPerSection ?? 2);
  const tokens = tokenizeGuidePromptQuery(query);
  const pageEntries = guide.categories.flatMap((category) => category.pages.map((page, index) => ({
    category,
    page,
    index,
    score:
      countGuidePromptTokenMatches(category.title, tokens) * 2
      + countGuidePromptTokenMatches(page.title, tokens) * 6
      + countGuidePromptTokenMatches(page.summary, tokens) * 4
      + page.sections.reduce((total, section) => total + countGuidePromptTokenMatches(section.title, tokens) * 3, 0)
      + page.sections.reduce((total, section) => total + section.items.reduce((sum, item) => sum + countGuidePromptTokenMatches(item, tokens), 0), 0),
  })));
  const rankedPages = [...pageEntries]
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selectedPages = (rankedPages.some((entry) => entry.score > 0) ? rankedPages.filter((entry) => entry.score > 0) : rankedPages)
    .slice(0, maxPages);

  const lines = [
    'Use this Guardian product and operator guide only when the user asks how to use Guardian, navigate the app, or understand available product capabilities.',
    'Do not answer implementation, code-path, or architecture questions from this guide.',
    'For source code and deeper technical documentation, point technical users to the GitHub Repository page in this guide.',
    `Guide overview: ${guide.intro}`,
  ];

  for (const entry of selectedPages) {
    lines.push(`- ${entry.page.title} (${entry.category.title}): ${entry.page.summary}`);
    const rankedSections = entry.page.sections
      .map((section, index) => ({
        section,
        index,
        score:
          countGuidePromptTokenMatches(section.title, tokens) * 4
          + section.items.reduce((total, item) => total + countGuidePromptTokenMatches(item, tokens), 0)
          + (section.note ? countGuidePromptTokenMatches(section.note, tokens) : 0),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const selectedSections = (rankedSections.some((section) => section.score > 0) ? rankedSections.filter((section) => section.score > 0) : rankedSections)
      .slice(0, maxSectionsPerPage);
    for (const { section } of selectedSections) {
      const sectionLine = buildGuidePromptSectionLine(section, tokens, maxItemsPerSection);
      if (sectionLine) lines.push(`  ${sectionLine}`);
    }
  }

  return lines.join('\n');
}
