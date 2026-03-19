# WebUI Design Spec

**Status:** Source of truth  
**Date:** 2026-03-12  
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

If a card, button, badge, or summary tile navigates elsewhere, the user should be able to tell where it goes and why before clicking.

## Navigation

Required left-nav order:

1. `Dashboard`
2. `Security`
3. `Network`
4. `Cloud`
5. `Automations`
6. `Configuration`
7. `Reference`

Notes:

- the persistent chat panel remains part of the shell, not a left-nav page
- `Cloud` is a first-class operational area and must not live only inside Configuration
- legacy `Workflows` and `Operations` routes remain redirected to `Automations`

## Canonical Ownership

| Domain | Canonical page | Allowed secondary surfaces |
|---|---|---|
| app health and readiness | `Dashboard` | compact status only |
| agent status | `Dashboard` | none |
| audit log and policy decisions | `Security` | dashboard count only |
| active alerts | `Security` | dashboard strip, network/cloud counts |
| threat intel | `Security` | none |
| network inventory and diagnostics | `Network` | dashboard count only |
| cloud connections and cloud posture | `Cloud` | dashboard count only |
| automations, schedules, run history | `Automations` | dashboard count only |
| AI provider config and search config | `Configuration` | single dashboard summary card |
| tools, approvals, policy, sandbox | `Configuration` | filtered links only |
| auth, integrations, system settings | `Configuration` | status only elsewhere |

## Cross-Page Rules

### Summary card rules

- A page may have a summary card grid only for its own domain.
- Secondary pages may show one compact count or badge for another domain, but not another full card grid for the same data.
- Dashboard is the only page allowed to summarize multiple domains at once.

### Alert rules

- `Security` owns the unified alert queue.
- `Dashboard` may show only a compact recent-attention strip.
- `Network` and `Cloud` may show domain-specific counts and short summaries.
- the global web alert tray remains available everywhere.

### Run-history rules

- `Automations` owns all automation and schedule run history.
- `Network` may own network-specific one-off tool and scan history.
- `Cloud` may own cloud-specific activity and cloud-action history.
- Dashboard must not duplicate full run-history tables.

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

### Dashboard exception

`Dashboard` remains the lightest-weight page and does not require a large explanatory banner.

However:

- linked dashboard cards must always expose destination tooltips
- quick links must always expose destination tooltips
- dashboard sections should still use the section-help pattern where practical
- dashboard copy should emphasize orientation and navigation rather than detailed operations

## Page Specs

## Dashboard

### Purpose

Landing page for high-level health, attention, and navigation.

### Guidance standard

Dashboard uses the lightweight variant of the contextual guidance standard.

It must provide:

- destination tooltips on all linked cards and quick links
- section-level info affordances for major content blocks when implemented
- orientation-focused copy rather than long instructional text

### Required sections

- `System Summary`
- `Needs Attention`
- `Agent Runtime`
- `Quick Links / Quick Actions`

### Allowed content

- readiness
- current provider summary
- active alert counts
- agent counts
- top-level health indicators

### Disallowed content

- full provider management tables
- full audit/policy tables
- scheduled job tables
- large background-job consoles
- duplicate network/cloud posture tables

### Current content to relocate

- `LLM Providers` table -> `Configuration > AI & Search`
- `Scheduled Cron Jobs` -> `Automations`
- `Recent Policy Decisions` -> `Security > Audit`
- `Session Queue` and `Background Jobs` -> future runtime detail surface or collapsible advanced panel

## Security

### Purpose

Central place for security investigation, alert triage, agentic-security workflow review, and audit history.

### Guidance standard

Security must include:

- a page-level intro explaining the difference between `Overview`, `Alerts`, `Agentic Security Log`, `Audit`, and `Threat Intel`
- a tab-level intro for each major tab
- a tooltip or equivalent hover description on each tab button
- section-level info affordances on major cards, tables, and queues

### Required tabs

- `Overview`
- `Alerts`
- `Agentic Security Log`
- `Audit`
- `Threat Intel`

### `Overview`

Must contain:

- overall security posture summary
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

### `Alerts`

This is the canonical alert queue.

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

### `Agentic Security Log`

Owns:

- the persisted running log of security-agent workflow
- live triage activity fed from `security.triage`
- investigation start/skip/complete/failure history
- light filtering by status and agent identity

Must not become:

- a duplicate alert queue
- a replacement for the audit ledger
- a generic runtime metrics page

### `Audit`

Owns:

- audit log
- chain verification
- policy decisions
- denials
- expanded event detail

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

- `AI & Search`
- `Tools & Policy`
- `Integrations`
- `System`
- `Appearance`

### `AI & Search`

Owns:

- AI providers
- default provider
- web search and fallback
- search sources

### `Tools & Policy`

Owns:

- tool runtime status
- approvals
- tool routing
- sandbox status
- allowlists
- policy mode

### `Integrations`

Owns:

- Telegram
- browser automation settings
- Google Workspace
- future configuration-only integrations

### `System`

Owns:

- authentication
- Guardian agent
- policy-as-code
- Sentinel
- notifications
- trust preset
- danger zone

### `Appearance`

Owns:

- theme and display settings

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
- render it in `Security > Alerts`

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

The Security page must show automation-originated findings as a first-class source in `Alerts`.

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
- any promoted findings appear in `Security > Alerts`
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
- `Security > Alerts`
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
