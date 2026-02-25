# Channel Analytics Spec

## Goal
Capture assistant interaction telemetry to identify friction and prioritize UX improvements.

## Storage
- SQLite-backed `AnalyticsService`
- Table: `assistant_analytics`
- Retention: `assistant.analytics.retentionDays`

## Event Types
- `message_sent`
- `message_success`
- `message_error`
- `message_denied`
- `command_used`
- `quick_action_triggered`
- `conversation_reset`
- `setup_applied`
- `setup_apply_failed`
- `config_update_success`
- `config_update_failed`
- `threat_intel_scan`
- `threat_intel_autoscan`
- `threat_intel_watch_add`
- `threat_intel_watch_remove`
- `threat_intel_action_drafted`
- `threat_intel_response_mode_updated`
- `moltbook_*` hostile-site connector security events
- `sqlite_permissions_hardened`
- `sqlite_permissions_check_failed`
- `sqlite_integrity_check_failed`
- `sqlite_driver_unavailable`

## Event Dimensions
- `channel`
- `channelUserId`
- `canonicalUserId`
- `agentId`
- `metadata` (JSON payload)

## API Surface
- `GET /api/analytics/summary?windowMs=<ms>`

## Consumption
- Web monitoring page renders 60-minute analytics summary
- CLI renders summary via `/analytics [minutes]`
- Setup/config and command flows emit analytics events
