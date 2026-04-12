# WebUI Design Spec

**Status:** Source of truth  
**Date:** 2026-04-05  
**Owner:** WebUI uplift  
**Supersedes:** [WEBUI-PANEL-CONSOLIDATION-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/WEBUI-PANEL-CONSOLIDATION-PROPOSAL.md)

## Goal

Define the canonical information architecture, page ownership, section rules, and cross-surface behavior for the GuardianAgent WebUI.

This document is the single source of truth for the WebUI redesign moving forward.

## Scope

This spec governs:

- left-nav structure
- route ownership
- tab structure within major pages
- contextual guidance and discoverability standards
- which page owns which data domain
- duplication-removal rules
- cloud UX structure
- automation output and alert-routing UX
- summary vs detail behavior across pages

This spec does not define:

- visual theme tokens
- exact CSS implementation
- backend schema details outside what the UI requires

## Design Principles

### 1. One page owns one domain

Each major operational domain must have one canonical home. Secondary pages may show counts, badges, or deep links, but not a second full control plane.

### 2. Summaries are not duplicate control planes

Dashboard summaries are allowed. Full tables, editors, and run consoles belong only on the owning page.

### 3. Operations and configuration stay separate

Operational pages are for monitoring, investigation, and running work. Configuration is for product setup and policy.

### 4. Raw JSON is never the primary user flow

JSON editors may exist for advanced users, but guided forms must be the primary UX for setup and management.

### 5. Automation outputs are always accessible from the automation itself

Any extra routing to notifications or security is additive, not a replacement for direct run access.

### 6. Security should receive normalized findings, not arbitrary raw output dumps

When an automation feeds security monitoring, Security should display a normalized alert/finding summary with a link back to the originating run.

### 7. Every page, tab, and major section must explain itself

Users should not have to infer the difference between monitoring, audit, configuration, and action surfaces by trial and error.

### 8. Linked UI elements must communicate destination and intent

If a card, button, badge, or summary tile navigates elsewhere, the user should be able to tell where it goes and why before clicking. Emphasize clear active states and subtle hover transforms.

### 9. Precision & Sharpness

The default Guardian profile should stay sharp, dense, and engineering-oriented. Theme bundles may vary corner radius, border treatment, and typography as long as shell layout, navigation placement, and page ownership remain fixed.

## Visual Standards

### Border Radius
Default Guardian profile uses strict `0`. Alternate appearance bundles may apply tokenized radius values to buttons, cards, panels, inputs, tooltips, and code blocks without changing page layout.

### Shadows
Used sparingly to create subtle depth (e.g., on hover for cards), avoiding heavy or dated drop shadows.

### Accents
Use 2px-4px accent borders (typically left-border or bottom-border) to denote focus, activity, or status levels.

### Typography
- **Sans / Display bundles**: Theme-driven typography may swap the primary UI and display stacks.
- **Monospace**: Code, logs, diff output, terminals, and other system-level surfaces remain monospaced even when the UI theme changes.

### Spacing & Grid
Maintain consistent, generous padding (typically 1.25rem - 1.5rem) to ensure information density remains high but readable.

## Navigation

Required left-nav order:

1. `Second Brain`
2. `System`
3. `Security`
4. `Network`
5. `Cloud`
6. `Automations`
7. `Code`
8. `Memory`
9. `Reference`
10. `Performance`
11. `Configuration`

Notes:

- the persistent chat panel remains part of the shell, not a left-nav page
- the chat panel now exposes a request-scoped provider-profile selector sourced from enabled AI provider profiles; choosing a provider affects only that chat turn and does not persist to config
- the chat toolbar keeps `Provider`, `Stop`, and `Reset Chat` on a single row; `Stop` cancels the active in-flight chat request (triggering a true backend abort and queue clearance) and `Reset Chat` clears conversation state after issuing a stop when needed
- if the chat panel reloads mid-turn, the panel should recover the prior in-flight request ID and issue a cancel so stale work does not continue invisibly behind the refreshed UI
- persistent tier-routing mode changes such as `auto` / `local-only` / `managed-cloud-only` / `frontier-only` remain a shared routing control, but they are not owned by the web chat toolbar
- `System` is the dedicated cross-product status and activity monitoring surface
- `Performance` remains a first-class workstation-operations page and must not be folded back into `Second Brain`
- `Cloud` is a first-class operational area and must not live only inside Configuration
- legacy `Workflows` and `Operations` routes remain redirected to `Automations`
- `#/dashboard` may remain as a compatibility alias, but `#/system` is the canonical route and nav destination
- the sidebar is a fixed 220px width for a stable operational feel
- nav items use high-contrast text and explicit 4px accent-left markers for the active state

## Canonical Ownership

| Domain | Canonical page | Allowed secondary surfaces |
|---|---|---|
| app health and readiness | `System` | compact status only |
| agent status | `System` | none |
| audit log and policy decisions | `Security` | system count only |
| active alerts | `Security` | system attention queue, network/cloud counts |
| threat intel | `Security` | none |
| workstation performance, editable profiles, latency, and reviewed cleanup | `Performance` | compact counts or deep links only |
| coding sessions, repo activity, and coding approvals | `Code` | compact links only |
| network inventory and diagnostics | `Network` | system count only |
| cloud connections and cloud posture | `Cloud` | system count only |
| automations, schedules, run history | `Automations` | system count only |
| AI provider config and search config | `Configuration` | compact system card only |
| live pending tool approvals | `System` | compact counts only |
| tools, runtime routing, recent tool jobs | `Configuration > Tools` | filtered links only |
| sandbox, allowlists, trust, browser risk controls, security-related configuration | `Configuration > Security` | filtered links only |
| auth, integrations, system settings | `Configuration` | status only elsewhere |

## Cross-Page Rules

### Summary card rules

- A page may have a summary card grid only for its own domain.
- Secondary pages may show one compact count or badge for another domain, but not another full card grid for the same data.
- `System` is the only page allowed to summarize multiple domains at once.

### Alert rules

- `Security` owns the unified alert queue.
- `System` may show a compact recent-attention queue and bounded high-signal status summaries.
- `Network` and `Cloud` may show domain-specific counts and short summaries.
- the global web alert tray remains available everywhere.

### Run-history rules

- `Automations` owns all automation and schedule run history.
- `Network` may own network-specific one-off tool and scan history.
- `Cloud` may own cloud-specific activity and cloud-action history.
- `System` must not duplicate full run-history consoles or owner-page history tables.

## Contextual Guidance Standard

### Goal

Every major surface must provide lightweight, repeatable guidance that tells the user what they are looking at, what actions are available, and how the current surface relates to the rest of the app.

### Required levels

The guidance model applies at three levels:

- page level
- tab level
- section or component-section level

### Required page and tab intro pattern

Each major page and each major tab must include a short intro block near the top of the content area.

Intro blocks are **collapsed by default** to reduce operational noise while keeping the guidance discoverable.

That intro must answer:

- `What it is`
- `What the user is seeing`
- `What they can do`
- `How it links to other sections`

### Required section-help pattern

Every major section title must include a small info affordance next to the title.

That affordance may be an info icon, help badge, or similar compact control, but it must support hover and keyboard focus.

When a custom themed tooltip is used for section help, the UI must not also show the browser's native `title` tooltip for the same affordance.

The section help content must answer:

- `What it is`
- `What the user is seeing`
- `What they can do`
- `How it links to other sections`

Section help must be written for the **actual rendered section content**, not just the parent page, tab, or the literal title text.

Examples:

- a section titled `Automation Configuration` must explain the automation controls shown in that panel, not threat intel broadly
- a section titled `Run Intelligence Scan` must explain the scan form and result behavior, not the entire Threat Intel tab
- a section titled `Edit aws-prod` must explain that the user is editing the currently selected AWS profile, not AWS in general

Generic fallback copy is not acceptable in shipped UI.

If a section does not yet have useful section-specific help text, the UI should omit the section-help affordance until that copy exists.

### Recommended extra guidance fields

When useful, section help should also include:

- `When to use this`
- `Where to go next`
- `What updates this data`
- `What requires configuration first`

### Tooltip and destination rules

Any card, summary tile, quick link, or compact status surface that navigates to another page or tab must expose a tooltip or equivalent hover/focus description.

That tooltip should tell the user:

- what the card represents
- where clicking will take them
- why they would go there

### Writing rules

Guidance copy must be:

- concise
- specific to the current surface
- action-oriented
- free of internal implementation jargon
- anchored to the concrete rows, controls, outputs, or state shown in that exact panel

Guidance copy must not:

- restate the section title without adding meaning
- describe the whole page when the help icon is attached to one subsection
- use placeholder or generic fallback text such as "this section is part of X workflow"
- dump raw schema details into normal-user help text
- duplicate a full help manual inside the page

### System exception

`System` remains the lightest-weight cross-domain monitoring page and does not require a large explanatory banner.

However:

- linked System cards must always expose destination tooltips
- quick links must always expose destination tooltips
- System sections should still use the section-help pattern where practical
- System copy should emphasize monitoring, orientation, and next actions rather than configuration editing

## Page Specs

## System

### Purpose

Cross-product operations overview for high-level health, owner-surface status, runtime visibility, and routing/debug visibility.

### Guidance standard

System uses the lightweight variant of the contextual guidance standard.

It must provide:

- destination tooltips on all linked cards and quick links
- section-level info affordances for major content blocks when implemented
- monitoring-focused copy rather than configuration instructions

### Required sections

- `System Summary`
- `Operational Surfaces`
- `Agent Runtime`
- `Routing Trace`

### Allowed content

- readiness
- current provider summary
- high-level security posture summary
- high-level code/automation/network/search/cloud status
- bounded routing visibility
- bounded job and session visibility
- top-level health indicators

### Disallowed content

- full provider management tables
- full audit/policy tables
- actionable security attention queues
- full owner-page history consoles
- duplicate network/cloud posture tables

### Current content to relocate

- `LLM Providers` table -> `Configuration > AI Providers`
- `Scheduled Cron Jobs` -> `Automations`
- `Recent Policy Decisions` -> `Security > Security Log`
- `Needs Attention` queue -> `Security > Overview` and `Security > Security Log`
- `full session queue and deep background-job management` -> owner pages such as `Automations`, `Code`, or a future runtime-detail surface

## Performance

### Purpose

Workstation operations page for host pressure, editable workstation profiles, latency checks, and reviewed cleanup actions.

Detailed runtime behavior, tool access, approval gating, and current implementation limits are defined in [PERFORMANCE-MANAGEMENT-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/PERFORMANCE-MANAGEMENT-SPEC.md).

### Guidance standard

Performance must make clear that it is separate from `Second Brain` and focused on workstation operations rather than planning or personal knowledge capture.

Each tab must explain:

- what host state or action surface is being shown
- whether the user is monitoring, editing a profile, or preparing a guarded mutation
- when the user should go to `Automations` or `Code` instead

### Required tabs

- `Overview`
- `Profiles`
- `Cleanup`
- `History`

### `Profiles`

Must support:

- create, edit, apply, and delete for performance profiles
- process protect and cleanup rule editing
- a live running-process browser grouped by executable name for quick-add into protect and cleanup rules
- latency target editing for the active profile library
- clear guidance that these profiles affect both Overview and Cleanup

Must not become:

- a generic runtime configuration page
- a second copy of unrelated Configuration sections
- a place for cloud, auth, or provider administration

### `Cleanup`

Must support:

- preview-first reviewed cleanup
- selectable process rows checked by default
- protected rows shown but disabled with a reason
- explicit confirmation of the final selected subset before execution
- a useful empty state when no candidates are recommended
- advisory previews even when the current runtime is read-only for host process actions
- a clear path from profile editing into cleanup preview without bypassing review

Must not become:

- a generic automation history page

### Ownership boundary

- `Performance` owns live workstation status, the running-process browser, performance profile definitions, guarded cleanup previews, and operator-initiated performance actions
- `Automations` owns scheduled or saved automation definitions that happen to call performance tools

## Code

### Purpose

Dedicated repo-scoped coding workspace for code sessions, repo activity, and coding approvals.

### Guidance standard

Code must stay distinct from both `Second Brain` and `Performance`.

It is the place for:

- coding session selection
- repo-scoped editing and investigation
- coding activity and approval follow-up

It must not be treated as a generic system-operations or workstation-cleanup surface.

## Security

### Purpose

Central place for security investigation, combined alert-and-audit review, Assistant Security scan/workflow review, and threat-intel work.

### Guidance standard

Security must include:

- a page-level intro explaining the difference between `Overview`, `Security Log`, `Assistant Security`, and `Threat Intel`
- a tab-level intro for each major tab
- a tooltip or equivalent hover description on each tab button
- section-level info affordances on major cards, tables, and queues

### Required tabs

- `Overview`
- `Security Log`
- `Assistant Security`
- `Threat Intel`

### `Overview`

Must contain:

- overall security posture summary
- a short `Needs Attention` queue that links into `Security Log`
- effective containment state
- native host-protection summary
- host monitor posture summary
- gateway firewall posture summary
- network anomaly summary
- cloud security summary
- recent security activity

Must not contain:

- general-purpose runtime analytics that are not security-specific
- duplicate agent status tables

### `Security Log`

This is the canonical combined action-and-evidence surface.

Must support:

- source filters:
  - network
  - host
  - gateway
  - native
  - cloud
  - tool/policy
  - automation
- severity filters
- acknowledgement
- resolve and suppression actions for supported local alerts
- deep links to originating objects
- audit chain verification
- searchable audit history
- denial summaries or equivalent historical context

### `Assistant Security`

Owns:

- posture-driven Assistant Security scans across runtime and coding workspaces
- the current Assistant Security findings queue and recent scan history
- the persisted running log of security-agent workflow
- live triage activity fed from `security.triage`
- investigation start/skip/complete/failure history
- light filtering by status and agent identity

Must not become:

- a duplicate alert queue
- a replacement for the audit ledger
- a generic runtime metrics page

### `Threat Intel`

Owns:

- watchlist
- findings
- drafted actions
- operating plan

### Disallowed

- separate `Cloud` tab once the Cloud page exists
- generic agent/resource monitoring that belongs elsewhere

## Network

### Purpose

Inventory, scan, diagnose, and review network-specific results.

### Guidance standard

Network must make clear that it is the operational home for devices and diagnostics, not the primary security triage surface.

Each tab must explain:

- what network data is being shown
- whether the user is reviewing state or running an action
- when the user should go to `Security` or `Automations` instead

### Required tabs

- `Overview`
- `Devices`
- `Diagnostics`
- `History`

### `Overview`

Must show:

- device count
- baseline readiness summary
- active network alert count
- quick actions

Must not become a second security page.

### `Devices`

Owns:

- discovered devices
- trust state
- ports and inventory details

### `Diagnostics`

Owns:

- one-off tool execution for network tools
- quick diagnostics and scans

### `History`

Owns:

- network-specific scans
- network tool runs
- network automation deep links when relevant

### Disallowed

- separate full `Threats` tab duplicating Security
- references to legacy `Workflows` or `Operations`

## Cloud

### Purpose

Cloud monitoring and configuration hub for provider connections, posture, activity, and cloud-focused automation entry points.

### Guidance standard

Cloud must include page, tab, and section guidance that clearly separates:

- connection setup
- cloud posture monitoring
- cloud activity review
- cloud-to-automation entry points

Connection forms must also explain what credentials or identifiers are required before the user starts.

Every Cloud section tooltip must describe the exact panel content currently visible:

- posture tables describe posture tables
- approvals tables describe approval rows and decisions
- workflow sections describe workflow summaries and handoff
- provider editors describe the saved-profile list, create state, edit state, secret-rotation behavior, and downstream tool usage

Cloud must not ship generic section-help fallback copy.

### Required tabs

- `Overview`
- `Connections`
- `Activity`
- `Automations`

### `Overview`

Must show:

- enabled/disabled cloud runtime
- provider family counts
- connection health summary
- posture warnings
- recent cloud denials
- recent cloud activity summary

### `Connections`

This is the primary cloud setup surface.

Must provide guided forms for:

- cPanel / WHM
- Vercel
- Cloudflare
- AWS
- GCP
- Azure

Every provider connection form must support:

- profile name
- enabled toggle
- required provider-specific identifiers
- auth method selection
- secret inputs or credential-ref inputs as appropriate
- optional endpoint overrides behind an advanced panel
- `Test Connection`
- `Save`

The preferred provider-editing pattern is:

- saved profiles listed on the left
- selecting a saved profile opens an edit surface on the right
- `Add` switches the right side into an explicit create flow
- section help on both the provider-family panel and the active editor must describe that actual state

### `Activity`

Owns:

- cloud-related audit activity
- cloud approval queue or filtered cloud approvals
- cloud tool-job history
- links back to the affected connection or run

### `Automations`

Owns:

- cloud-focused templates and presets
- “create automation from this connection”
- filtered deep link into the main Automations page

### Advanced mode

Raw JSON editing for cloud profiles is allowed only in an advanced drawer or advanced editor mode.

It must not be the default connection experience.

## Automations

### Purpose

Single home for creating, scheduling, running, and reviewing automations.

### Guidance standard

Automations must explain:

- the difference between catalog, editing, scheduling, run history, and engine settings
- where automation output remains visible
- how optional notification and security routing works

### Required sections

- `Automation Catalog`
- `Run History`
- `Engine Settings`

### Required behavior

- all schedules live here
- all automation run history lives here
- single-tool and multi-step automations use one shared model
- filtered entry points from Network, Security, and Cloud link here rather than recreating their own automation consoles

### Required create/edit fields

- name
- description
- enabled
- schedule
- steps
- tool access
- output handling

## Configuration

### Purpose

Configure GuardianAgent itself, not operate monitored domains.

### Guidance standard

Configuration must include page and tab guidance that explains ownership boundaries.

Users should be able to tell immediately that this page is for product setup and policy, not runtime monitoring or alert triage.

### Required tabs

- `AI Providers`
- `Search Providers`
- `Second Brain`
- `Tools`
- `Security`
- `Integration System`
- `Appearance`

### `AI Providers`

Owns:

- AI providers
- model auto selection policy
- managed-cloud profile routing
- shared credential refs

The AI Providers surface must support:

- an enabled checkbox on each saved provider row so operators can remove a profile from live routing without deleting the saved model and credential settings
- multiple named managed-cloud profiles under Ollama Cloud
- deletion of existing provider profiles with cleanup of invalidated defaults and managed-cloud role bindings
- a suggested starting model for new managed-cloud profiles based on the profile name, without locking the operator out of changing the model before save
- an explicit managed-cloud role-routing editor for `general`, `direct answers`, `tool loops / provider CRUD`, and `managed-cloud coding`
- guidance that unset managed-cloud role bindings use the explicit `general` profile first when set, otherwise can still be inferred from profile names before falling back to the routed managed-cloud default
- guidance that managed-cloud role routing is about provider selection inside the managed-cloud tier, not about rearranging page layout or bypassing the shared broker/orchestration path
- guidance that disabled profiles stay visible and editable but are excluded from routed defaults and automatic execution-profile selection until re-enabled
- guidance that the web chat provider selector only lists enabled profiles and that choosing one forces that one request through the selected profile instead of using automatic provider selection

### `Search Providers`

Owns:

- web search and fallback
- search sources

Must not own:

- Ollama or other LLM provider profile details
- duplicate provider or cloud summary cards

Search-source runtime state should be shown as one compact actionable summary, not a strip of vanity status cards.

### `Second Brain`

Owns:

- editable Second Brain setup preferences
- workday defaults
- default delivery preferences for new Second Brain routines
- bounded retrieval defaults for the Second Brain experience

Must not own:

- a second memory authority or duplicate memory store
- direct provider administration
- routine editing for already configured routines

This tab should make clear that the settings remain editable later and that existing routines still belong to `Second Brain > Routines`.

### `Tools`

Owns:

- tool runtime status
- tool routing
- recent tool jobs

Must not own:

- the primary global pending-approval queue

### `System`

Owns:

- cross-product runtime summary
- active assistant and routine execution overview
- global pending tool approvals

### `Security`

Owns:

- sandbox enforcement
- degraded-backend override controls
- browser automation security posture
- allowlists
- agent policy access gates
- Guardian agent
- policy-as-code
- Sentinel
- notifications
- trust preset

### `Integration System`

Owns:

- Telegram
- Coding Assistants
- Google Workspace
- authentication
- danger zone
- future configuration-only integrations that are not part of the security control plane

Must not own:

- AI provider inventory or Ollama details
- search-provider status
- cloud connection inventory

Overview cards in this tab should stay limited to operator-access and channel state.

### `Appearance`

Owns:

- theme bundles and display settings
- typography presets and theme-following font behavior
- motion-reduction preferences
- IDE/editor theme alignment with the main app appearance

### Disallowed

- catch-all `Settings` mega-accordion
- normal-user `Config Snapshots` section
- primary cloud management tab

## Automation Output Model

## Goal

Make automation outputs easy to find, preserve direct access from the automation, and optionally route important results into notifications or security monitoring without creating noise.

## Core rule

Automation outputs always remain attached to the automation run.

Any routing to notifications, memory, or security is additive.

## Required run output structure

Every automation run must produce a normalized result envelope:

- run summary
- per-step results
- operator-visible output preview
- optional artifacts
- optional derived findings/signals

Minimum conceptual shape:

```ts
interface AutomationRunResult {
  runId: string;
  automationId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'partial';
  startedAt: number;
  completedAt?: number;
  summary: string;
  steps: Array<{
    stepId: string;
    toolName: string;
    status: string;
    outputPreview?: string;
    output?: unknown;
  }>;
  artifacts?: Array<{
    id: string;
    kind: 'json' | 'text' | 'table' | 'report' | 'file_ref';
    title: string;
    value: unknown;
  }>;
  findings?: Array<{
    id: string;
    type: string;
    severity: 'info' | 'warn' | 'critical';
    title: string;
    description: string;
    sourceStepId?: string;
  }>;
}
```

## Output handling settings

Every automation must expose an `Output Handling` section in create/edit UI.

### Default behavior

Default setting:

- `Store on automation only`

This means:

- output is visible in run history and run details
- no notification is emitted
- no security finding is created unless the runtime itself independently emits one

### Required output routing controls

The UI must support:

- `Primary access`
  - fixed value: `Automation run details`
- `Notify`
  - `Off`
  - `On warn/critical findings`
  - `On all findings`
- `Send to Security`
  - `Off`
  - `On warn/critical findings`
  - `On all findings`
- `Persist artifacts`
  - `Run history only`
  - `Run history + search/memory` if supported by the workflow type later

The important rule is that `Primary access` is always the automation itself. Other destinations are extra copies or derived summaries.

## Security integration for automation outputs

Automation output must not be shoved directly into Security as raw logs.

Instead, if `Send to Security` is enabled:

1. the automation run generates structured findings
2. qualifying findings are normalized into a security event
3. Security shows a concise alert/finding row
4. that row links back to the originating automation run and step output

### Required promoted payload fields

Security-promoted automation findings must include:

- automation id
- automation name
- run id
- step id when applicable
- severity
- title
- concise description
- deep link target to the run detail

### Eventing rule

Promoted automation findings should flow through the same normalized alert path as other security signals:

- emit an audit event for the promoted finding
- let the notification system consume that event
- render it in `Security > Security Log`

This preserves one alert pipeline instead of creating a special-case UI-only path.

## Notification integration for automation outputs

If automation output routing enables notifications:

- only normalized findings should notify
- plain successful output should not notify by default
- notifications should include the automation name and run link context

This prevents routine automation success noise from spamming users.

## Automations UI requirements for outputs

The Automations page must provide:

- per-run summary
- expandable per-step output
- artifact list
- promoted-finding indicators
- routing badges:
  - `notifies`
  - `security`
  - `artifacts`

If a run created a promoted security finding, the run detail must show that relationship directly.

Example:

- `Promoted to Security: 2 findings`
- `View in Security`

## Security UI requirements for automation findings

The Security page must show automation-originated findings as a first-class source in `Security Log`.

Each row must include:

- source = `automation`
- severity
- title
- automation name
- short description
- link to run detail

Security should never be the only place where that output is visible.

## Cloud and Automation Interaction

The Cloud page must be able to start creation of automations from a connected provider.

Examples:

- monitor this AWS account
- check Cloudflare DNS drift daily
- watch Vercel deployment failures

When a cloud automation is created:

- it is owned by `Automations`
- it may be launched from `Cloud > Automations`
- any promoted findings appear in `Security > Security Log`
- raw run outputs remain in `Automations`

## Required Removals and Migrations

### Remove from normal navigation

- `Security > Cloud`
- `Configuration > Cloud`
- `Configuration > Settings` mega-accordion
- `Configuration > Settings > Config Snapshots`
- `Network > Threats` as a separate top-level tab

### Replace with

- left-nav `Cloud`
- `Security > Security Log`
- `Configuration` split into clear ownership tabs
- `Network` focused on inventory and diagnostics

## Implementation Order

### Phase 1

- establish new route ownership
- add left-nav `Cloud`
- remove legacy wording that references `Workflows` and `Operations`
- define destination badges and output-handling placeholders in Automations UI

### Phase 2

- implement Cloud page shell
- move cloud posture out of Security
- move guided cloud connections out of Configuration

### Phase 3

- implement automation output-handling controls
- add promoted automation findings into Security alert flow
- add run-detail links from Security back to Automations

### Phase 4

- simplify Dashboard
- simplify Network
- restructure Configuration

## Acceptance Criteria

The uplift is complete when:

- every major domain has one obvious owner page
- every major page, tab, and section follows the contextual guidance standard
- cloud connection setup is form-based, not JSON-first
- there is one unified security alert queue
- automation outputs are always accessible from Automations
- automation outputs can optionally promote normalized findings to Security
- Dashboard no longer duplicates deep operational tables
- Configuration no longer acts as a second app shell
