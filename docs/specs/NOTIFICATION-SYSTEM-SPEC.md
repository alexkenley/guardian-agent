# Notification System Spec

**Status:** Initial implementation + next-step design  
**Date:** 2026-03-11

## Goal

Provide a first-class automated notification system for GuardianAgent so operators are alerted when:

- the runtime or guardrails detect anomalies
- code-level security controls trigger important events
- workstation or network monitoring surfaces suspicious activity

This system is intended to complement approvals, audit history, Sentinel, and sandboxing. It is not a replacement for those controls.

## Scope

Initial implementation scope:

- normalize selected audit events into operator-facing notifications
- emit real-time web notifications over existing SSE/event bus plumbing
- optionally fan out notifications to CLI and Telegram
- deduplicate repeated alerts with a cooldown window
- ship example automation templates and presets for host/security workflows

Future scope:

- email, Slack, Discord, webhook, and SIEM destinations
- policy-driven auto-response actions
- richer alert routing rules per severity/type/channel

## Design Principles

- Reuse existing GuardianAgent trust boundaries: `AuditLog`, `EventBus`, channels, automations.
- Keep the first version simple: use audit events as the authoritative source.
- Prefer normalized operator copy over raw internal event payloads.
- Fail soft on delivery: notification transport failures must not block the runtime.
- Deduplicate aggressively enough to reduce noise without hiding distinct incidents.

## Current Runtime Design

### Source of Truth

The notification system consumes `AuditLog` events.

Default notification-worthy audit events:

- `anomaly_detected`
- `host_alert`
- `action_denied`
- `secret_detected`
- `policy_changed`
- `policy_mode_changed`
- `policy_shadow_mismatch`
- `agent_error`
- `agent_stalled`

### Notification Service

Implementation file:

- [notifications.ts](/mnt/s/Development/GuardianAgent/src/runtime/notifications.ts)

Responsibilities:

- subscribe to audit events
- filter by configured event type and minimum severity
- build normalized notification payloads
- dedupe by event type, agent, controller, and description
- emit `security:alert` events on the `EventBus`
- send operator copy to configured delivery channels

The current implementation also treats host-monitor findings as first-class inputs by consuming `host_alert` audit events emitted from workstation checks.

### Delivery Channels

Initial delivery paths:

- **Web**
  - via `security:alert` SSE events
  - rendered in the Security monitoring view
- **CLI**
  - uses the existing channel `send()` surface to show alerts directly to the local operator
- **Telegram**
  - uses configured `allowedChatIds` as the alert fanout list

### Config

Config path:

- `assistant.notifications`

Current fields:

```yaml
assistant:
  notifications:
    enabled: true
    minSeverity: warn
    auditEventTypes:
      - anomaly_detected
      - host_alert
      - action_denied
      - secret_detected
      - policy_changed
      - policy_mode_changed
      - policy_shadow_mismatch
      - agent_error
      - agent_stalled
    cooldownMs: 60000
    destinations:
      web: true
      cli: true
      telegram: true
```

## Event Model

Normalized notification payload:

```ts
interface SecurityNotification {
  id: string;
  timestamp: number;
  severity: 'info' | 'warn' | 'critical';
  source: 'audit';
  sourceEventType: AuditEventType;
  agentId: string;
  title: string;
  description: string;
  dedupeKey: string;
  details: Record<string, unknown>;
}
```

Event bus event:

- type: `security:alert`
- payload: `SecurityNotification`

## UI/UX Expectations

### Web Security Page

The Security page should:

- show `security:alert` events in the live event stream
- preserve normal network threat posture refresh behavior
- avoid assuming every security alert came from network monitoring
- show host-monitor posture, active host alerts, acknowledgement, and manual check controls

### CLI

The CLI should display notifications as operator-visible alerts without requiring user polling.

### Telegram

Telegram notifications should be concise and readable in mobile chat contexts:

- severity
- short title
- description
- agent
- event type
- timestamp

## Host Monitor Integration

The notification system now has a concrete integration path with workstation monitoring:

- host-monitor checks emit `host_alert` audit events
- those events are normalized into `security:alert` notifications
- the Security page, CLI, and Telegram receive the same operator-facing alert family
- `host_monitor_check` and the web manual check path both route through the same audit/notification flow

This keeps notifications consistent whether the anomaly came from:

- Guardian policy/runtime controls
- network monitoring
- workstation monitoring
- agent self-policing

## Built-In Automation Examples

New built-in template:

- `agent-host-guard`

Included playbooks:

- `host-security-baseline`
  - host monitor check
  - system info
  - resources
  - services
  - top processes
  - active connections
  - threat summary
- `anomaly-response-triage`
  - host monitor check
  - threat check
  - active connections
  - top processes
  - localhost port scan

New scheduled-task presets:

- `host-security-baseline`
- `anomaly-response-triage`

These are intended as starting points for:

- regular workstation security snapshots
- recurring anomaly review
- incident triage after a suspicious alert

## Recommended Next Steps

1. Add webhook/email/Slack delivery transports.
2. Add routing rules by severity and event family.
3. Add response playbooks:
   - pause automations
   - force manual approval mode
   - kill descendant process tree
4. Add dashboard configuration UI for notification settings.
5. Add richer helper-backed host telemetry on Windows, then optional Linux `auditd`/eBPF and macOS native depth.

## Non-Goals

- building a full SIEM
- replacing the audit log
- creating a second approval system
- claiming notification delivery is guaranteed under all process-failure conditions
