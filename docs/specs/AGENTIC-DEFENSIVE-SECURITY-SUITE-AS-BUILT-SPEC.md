# Agentic Defensive Security Suite - As-Built Spec

**Status:** Implemented for the current local-defense scope  
**Date:** 2026-03-19  
**Proposal origin:** [Agentic Defensive Security Suite](/mnt/s/Development/GuardianAgent/docs/proposals/AGENTIC-DEFENSIVE-SECURITY-SUITE-PROPOSAL.md)  
**Implementation plan:** [Agentic Defensive Security Suite - Implementation Plan](/mnt/s/Development/GuardianAgent/plans/AGENTIC-DEFENSIVE-SECURITY-SUITE-IMPLEMENTATION-PLAN.md)

## Purpose

Define the shipped local defensive-security stack for GuardianAgent.

This is an as-built runtime and operator spec, not a proposal. It documents what is implemented now for the current scope, where the boundaries are, and which parts of the broader plan remain deferred.

## Current Scope

The shipped system covers:

- local runtime hardening and memory boundaries
- unified local security alerts across host, network, gateway, and native provider sources
- advisory posture and bounded containment logic
- Windows Defender status, alert, and scan integration
- event-triggered security response automations
- an agentic security triage loop with persisted live activity history
- Security page surfaces for posture, alerts, activity, audit, and threat-intel review

The current scope does **not** include:

- enterprise governance and fleet control
- Guardian Hub federation or threat sharing
- deep EDR-grade kernel telemetry
- full browser isolation for user-driven browsing outside Guardian-managed browser tools
- a standalone secrets broker

## Separation Model

GuardianAgent now has two distinct security layers:

### 1. Runtime self-protection

This is the existing Guardian-side security stack:

- admission controls
- approvals
- taint-aware tool execution
- guarded LLM output handling
- policy enforcement
- audit logging
- brokered execution and sandboxing

### 2. Host and network defense extension

This is the outward-facing defensive overlay:

- workstation monitoring
- network and gateway monitoring
- native host-security integration
- unified alerting
- posture and containment recommendations
- event-triggered response workflows
- agentic triage and explanation

The defensive suite extends outward from the Guardian runtime. It does not replace the runtime security model.

## Implemented Runtime Model

## Deployment profiles and operating modes

The runtime stores two independent axes:

- deployment profiles:
  - `personal`
  - `home`
  - `organization`
- operating modes:
  - `monitor`
  - `guarded`
  - `lockdown`
  - `ir_assist`

Current behavior:

- `monitor` is the default when nothing else is configured
- posture can recommend escalation
- containment can temporarily auto-elevate to `guarded` for stacked elevated alerts
- `lockdown` and `ir_assist` remain explicit higher-control states

Primary files:

- `src/runtime/security-controls.ts`
- `src/runtime/security-posture.ts`
- `src/runtime/containment-service.ts`
- `src/config/types.ts`
- `src/config/loader.ts`

## Memory boundary

Security detections are intentionally separated from long-term memory.

Current behavior:

- raw security telemetry is not stored as memory
- unified alerts remain in security-specific state
- only reviewed summaries should be promoted into memory
- read-only alert inspection is exposed through security-specific tools and dashboard APIs

Primary files:

- `src/runtime/security-alerts.ts`
- `src/runtime/security-alert-lifecycle.ts`
- `src/runtime/agent-memory-store.ts`
- `src/runtime/conversation.ts`

## Unified local alert model

GuardianAgent normalizes current local security signals into one alert surface.

Current sources:

- host monitoring
- network baseline and threat analysis
- gateway firewall monitoring
- Windows Defender native-provider alerts

Current unified alert behaviors:

- search and filtering by source, severity, type, and query
- acknowledge, resolve, and suppress actions
- posture evaluation over the combined active set
- dashboard rendering through one Security queue rather than separate local queues

Primary files:

- `src/runtime/security-alerts.ts`
- `src/runtime/security-alert-lifecycle.ts`
- `src/tools/executor.ts`
- `src/channels/web.ts`
- `src/channels/web-types.ts`

## Host, network, and gateway monitoring

### Host monitoring

Current host monitoring covers:

- suspicious process families
- persistence drift
- sensitive-path drift
- new external destinations
- new listening ports
- local firewall posture

### Network monitoring

Current network monitoring covers:

- baseline readiness and learned device inventory
- anomaly detections such as new devices, beaconing, scanning, and unusual services
- read-only network threat and anomaly tools

### Gateway monitoring

Current gateway monitoring covers:

- firewall enabled/disabled state
- WAN default action
- port-forward drift
- admin-user drift

Primary files:

- `src/runtime/host-monitor.ts`
- `src/runtime/network-baseline.ts`
- `src/runtime/network-traffic.ts`
- `src/runtime/gateway-monitor.ts`

## Native Windows host protection integration

Windows Defender is integrated as a native provider, not replaced.

Current behavior:

- refresh and persist Defender status
- normalize Defender alerts into the unified local alert model
- expose provider health, signatures, scan ages, firewall state, and Controlled Folder Access state
- support approved quick/full/custom scan requests
- support approved signature updates
- handle third-party AV coexistence by marking Defender inactive rather than treating every passive state as a hard failure

Primary files:

- `src/runtime/windows-defender-provider.ts`
- `src/tools/executor.ts`
- `src/channels/web.ts`

Persisted state:

- `~/.guardianagent/windows-defender-provider.json`

## Bounded containment

Containment is currently policy- and mode-driven, not fully autonomous remediation.

Implemented actions include:

- advisory mode escalation
- temporary auto-escalation to `guarded`
- browser mutation restrictions in elevated modes
- scheduled risky mutation pause in elevated modes
- lockdown restrictions on shell, network egress, and non-essential mutation
- IR-assist read-heavy restrictions

The browser containment piece is currently limited to Guardian-managed browser tools. It does not inspect or control a user’s normal browser outside Guardian’s tool path.

Primary files:

- `src/runtime/containment-service.ts`
- `src/runtime/browser-session-broker.ts`

## Agentic security triage

The defensive stack now includes a dedicated LLM-backed security triage loop.

Current design:

- a `security-triage` chat agent performs bounded investigation
- a `security-triage-dispatcher` event agent listens for selected security events
- the dispatcher ignores low-confidence noisy families
- repeated events are deduped with a cooldown window
- the triage agent is instructed to use read-only evidence gathering first
- the triage loop records an `automation_finding` audit event when it completes

The current agentic layer is intentionally conservative:

- no automatic acknowledge, resolve, or suppress
- no automatic scan or mutating host action from event dispatch alone
- explain and triage first, escalate or act later under operator control

Primary files:

- `src/runtime/security-triage-agent.ts`
- `skills/host-firewall-defense/SKILL.md`
- `skills/native-av-management/SKILL.md`
- `skills/security-mode-escalation/SKILL.md`
- `skills/security-alert-hygiene/SKILL.md`
- `skills/security-response-automation/SKILL.md`
- `skills/browser-session-defense/SKILL.md`

## Persisted security-agent activity log

The security triage loop now writes a dedicated persisted activity history.

Current entry types:

- `started`
- `skipped`
- `completed`
- `failed`

Current use:

- backend activity history for the Security page
- live SSE streaming to connected dashboard clients
- operator review of what the security agents investigated and why

Primary files:

- `src/runtime/security-activity-log.ts`
- `src/runtime/security-triage-agent.ts`
- `src/index.ts`

Persisted state:

- `~/.guardianagent/security-activity-log.json`

## Event-triggered response automation

Scheduled tasks now support event-triggered definitions in addition to cron schedules.

Current behavior:

- a task may subscribe to an event type plus optional match conditions
- event-triggered tasks can run tool or playbook logic
- task history preserves trigger provenance
- security workflows can use events such as `security:alert`

Primary files:

- `src/runtime/scheduled-tasks.ts`
- `src/runtime/scheduled-tasks.test.ts`

## Operator and API Surfaces

## Tool surfaces

Current security-specific tool surfaces include:

- `security_alert_search`
- `security_alert_ack`
- `security_alert_resolve`
- `security_alert_suppress`
- `security_posture_status`
- `security_containment_status`
- `windows_defender_status`
- `windows_defender_refresh`
- `windows_defender_scan`
- `windows_defender_update_signatures`

Primary file:

- `src/tools/executor.ts`

## Web API surfaces

Current dashboard endpoints include:

- `GET /api/security/alerts`
- `POST /api/security/alerts/ack`
- `POST /api/security/alerts/resolve`
- `POST /api/security/alerts/suppress`
- `GET /api/security/posture`
- `GET /api/security/containment`
- `GET /api/security/activity`
- `GET /api/windows-defender/status`
- `POST /api/windows-defender/refresh`
- `POST /api/windows-defender/scan`
- `POST /api/windows-defender/signatures/update`

Current SSE event families include:

- `security.alert`
- `security.triage`

Primary files:

- `src/channels/web.ts`
- `src/channels/web-types.ts`
- `src/index.ts`

## Security page

The current Security page is the main operator surface for the local defensive suite.

Current tabs:

- `Overview`
- `Alerts`
- `Agentic Security Log`
- `Audit`
- `Threat Intel`

Current Security page behavior:

- page-level guidance panel describing the tab split
- tab-level intro panels for each major tab
- per-tab hover tooltips on the tab buttons
- unified local alert queue
- operating-mode posture and containment state
- native Windows Defender status and actions
- persisted live security-agent activity log
- audit chain verification and historical audit review
- threat-intel workspace for longer-running monitoring and action drafting

Primary files:

- `web/public/js/pages/security.js`
- `web/public/js/components/tabs.js`
- `web/public/js/app.js`
- `web/public/js/api.js`

## Verification

Current focused verification includes:

- `src/runtime/security-posture.test.ts`
- `src/runtime/security-triage-agent.test.ts`
- `src/runtime/security-activity-log.test.ts`
- `src/runtime/windows-defender-provider.test.ts`
- `src/channels/channels.test.ts`
- `src/tools/executor.test.ts`
- `src/runtime/scheduled-tasks.test.ts`

Harness coverage:

- `scripts/test-contextual-security-uplifts.mjs`

## Deferred Work

The following remain outside the current as-built scope:

- enterprise governance and fleet policy
- Guardian Hub trust, sharing, and federation
- full secrets-broker process isolation
- user-browser inspection outside Guardian-managed browser tools
- deep forensic or kernel-level endpoint instrumentation
- autonomous destructive remediation

This spec is intentionally narrower than the proposal and implementation plan. It documents the shipped local defensive stack as it exists today.
