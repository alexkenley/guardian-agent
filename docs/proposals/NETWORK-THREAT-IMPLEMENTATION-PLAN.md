# Network Threat Guardian — Implementation Plan

**Status:** Planned  
**Date:** 2026-03-05  
**Source Proposal:** `docs/proposals/NETWORK-THREAT-ANALYSIS.md`

## Progress Update

- Completed: sandbox-alignment fixes needed before network threat rollout (see Layer 1.5 constraints in `SECURITY.md`).
- Completed (WS1):
  - Added runtime network intelligence module (`src/runtime/network-intelligence.ts`)
  - Added OUI vendor lookup, port-to-service mapping, and heuristic device classification
  - Integrated enrichment into `DeviceInventoryService` ingestion path and persistence migration
- Completed (WS2 core):
  - Added `NetworkBaselineService` with anomaly detection, dedupe, alert history, acknowledge flow, and persistence
  - Wired automatic analysis after manual scans, playbook scans, and scheduled scan tasks
  - Emitted `security:network:anomaly` / `security:network:threat` events + `anomaly_detected` audit records
- Completed (WS3):
  - Added dashboard callbacks + API endpoints for baseline/threats/acknowledge
  - Added Monitoring tab network threat cards and live `security.alert` SSE handling
  - Added Operations presets for `net_baseline`, `net_anomaly_check`, and `net_threat_summary`
- Completed (WS4 + WS5 first pass):
  - Added advisory tools for fingerprinting, WiFi scanning, traffic baseline, and traffic threat checks
  - Added network config schema (`assistant.network.*`) with defaults + validation
  - Added runtime traffic service and alert ingestion path for traffic-derived threats
  - Added Threats tab under Network with active-alert acknowledge workflow
  - Added connection-profile-aware scans (`connectionId`) and profile inspection tooling for LAN/WiFi/VPN/remote config

## Objective

Deliver an active network guardian that:
1. Continuously analyzes local network posture from scan data.
2. Feeds actionable alerts into **Security > Monitoring**.
3. Exposes network threat context to agents so they can advise with evidence.

## Scope (First Delivery)

This implementation plan focuses on **Phase 1 + Phase 2** from the proposal, with UI/agent integrations required to make it operational:
- Device intelligence enrichment (vendor, type, services).
- Baseline + anomaly detection after each scan.
- Security Monitoring alert surfacing (live + history).
- Agent-visible read-only tooling for advisory responses.

Out of scope for first delivery:
- WiFi client enumeration (Phase 4).
- Flow-level traffic analytics and data exfiltration/beacon detection (Phase 5).
- Multi-connection types (Phase 6).

## Isolation Alignment (Post-Update)

The latest `SECURITY.md` update introduces **Layer 1.5 OS-level process sandboxing**. This changes implementation constraints for network monitoring:

- All child-process network probes must run through sandbox wrappers.
- Network probe commands must explicitly request `networkAccess: true` when needed.
- Read-only collection tools should stay on the `read-only` sandbox profile where possible.
- Any new action types used by tools must be added to capability mappings because unknown action types are now default-denied.

Practical impact for this project:
- Keep anomaly analysis primarily in TypeScript/runtime memory (no extra shell dependencies).
- Reuse existing `net_*` tool outputs as primary data source for baseline/threat logic.
- When adding new network tools (e.g., fingerprinting), include sandbox profile and capability mapping updates in the same PR.

## Current Gaps

- `DeviceInventoryService` stores only basic identity + open ports.
- No baseline model or anomaly scoring exists.
- `Security > Monitoring` streams generic audit events only; no dedicated network threat alerts.
- Agents can run low-level `net_*` tools, but cannot query threat posture/baseline/alert summaries directly.

## Target Architecture

1. **Scan ingestion**  
`net_arp_scan` / `net_port_check` / `net_dns_lookup` outputs update `DeviceInventoryService`.

2. **Network snapshot + baseline check**  
A new `NetworkBaselineService` builds and updates a baseline and evaluates anomaly rules on each scan completion.

3. **Threat event generation**  
Findings become:
- EventBus events (`security:network:anomaly`, `security:network:threat`)
- Audit events (`anomaly_detected` with `details.source = 'network_sentinel'`)

4. **Security Monitoring integration**  
Monitoring tab displays network threat cards, active alerts, and severity/risk trends (from API + SSE).

5. **Agent advisory visibility**  
Agents can read inventory, baseline, and alert summaries through new read-only tools and use that data to advise.

## Workstreams

### WS1 — Data Model + Device Intelligence

**Files**
- `src/runtime/device-inventory.ts` (extend `DiscoveredDevice`, ingest enrichment, persistence migration)
- `src/runtime/network-intelligence.ts` (new: OUI lookup, service mapping, type classifier)
- `src/tools/executor.ts` (new tools: `net_oui_lookup`, `net_classify`)

**Deliverables**
- Vendor lookup from MAC OUI (bundled dataset initially).
- Port-to-service mapping.
- Device type + confidence scoring.
- Trust metadata (`userLabel`, `trusted`) in inventory schema.

### WS2 — Baseline + Active Detection

**Files**
- `src/runtime/network-baseline.ts` (new: baseline model + anomaly rules)
- `src/runtime/network-threats.ts` (new: alert store, dedupe, acknowledge lifecycle)
- `src/index.ts` (wire services + scan-complete trigger path)
- `src/runtime/scheduled-tasks.ts` (emit scan completion for scheduled scans)

**Deliverables**
- Baseline readiness threshold (`minSnapshotsForBaseline`).
- Rules: new device, port change, unusual service, device gone, ARP mapping anomaly.
- Risk scoring (0-100) + severity mapping.
- Deduplicated threat records with timestamps and evidence payloads.

### WS3 — Security Monitoring Tab + Alerting

**Files**
- `src/channels/web-types.ts` (new callback and SSE types)
- `src/channels/web.ts` (new network threat endpoints)
- `web/public/js/app.js` (register `security.alert` SSE type)
- `web/public/js/api.js` (add network threat APIs)
- `web/public/js/pages/security.js` (Monitoring tab: network alert UI)

**Deliverables**
- API:
  - `GET /api/network/threats`
  - `POST /api/network/threats/ack`
- SSE event: `security.alert` for medium/high/critical detections.
- Monitoring UI:
  - Active alert count by severity
  - Latest high/critical network alerts
  - Baseline health indicator

### WS4 — Agent Advisory Access

**Files**
- `src/tools/executor.ts` (new tools: `net_baseline`, `net_anomaly_check`, `net_threat_summary`)
- `src/tools/types.ts` (tool category lists)
- `src/reference-guide.ts` (document usage)
- `src/agents/sentinel.ts` (optional: include network findings in scheduled analysis narrative)

**Deliverables**
- Read-only tools returning:
  - Current device posture
  - Baseline deltas/anomalies
  - Active alert summaries + recommended actions
- Agents can answer "what changed on my network?" with concrete evidence.

### WS5 — Configuration + Safety Controls

**Files**
- `src/config/types.ts` (add `assistant.network.*` schema + defaults)
- `src/config/loader.ts` (schema validation and merge)
- `src/guardian/guardian.ts` (action capability mappings for any new action types)
- `src/index.ts` (tool-runtime `capMap` updates for new action types)
- `SECURITY.md` (security model updates)

**Deliverables**
- Feature flags and thresholds:
  - `assistant.network.deviceIntelligence.enabled`
  - `assistant.network.baseline.enabled`
  - `assistant.network.baseline.minSnapshotsForBaseline`
  - `assistant.network.baseline.anomalyRules.*`
- Sandbox alignment:
  - New network-related command tools define sandbox profile (`read-only` unless write is required)
  - Network-dependent probes explicitly opt into `networkAccess: true`
  - No custom tool action type is introduced without capability mapping updates
- Safe defaults: enabled for low-risk, local-only analysis; no packet payload capture.

### WS6 — Test Coverage

**Files**
- `src/runtime/device-inventory.test.ts` (new/expanded)
- `src/runtime/network-baseline.test.ts` (new)
- `src/runtime/network-threats.test.ts` (new)
- `src/channels/web.test.ts` (network threats endpoints + SSE payload shape)
- `web/public/js/pages/security.test.ts` (if frontend tests exist; otherwise add targeted integration checks)

**Acceptance Tests**
- New device appears -> anomaly is generated -> alert visible in Monitoring.
- Port profile drift triggers low/medium alert with dedupe window respected.
- Acknowledged alert does not repeatedly spam Monitoring during dedupe window.
- Agent tool responses include enough context to produce advisory guidance.
- New/updated network tools execute successfully under sandbox constraints (bwrap path and fallback path).
- Capability checks pass for all network threat tool actions (no unknown-action denials).

## Delivery Sequence

1. WS1 device intelligence foundation.
2. WS2 baseline + anomaly engine with audit/event wiring.
3. WS3 monitoring UI + alert APIs/SSE.
4. WS4 agent visibility tooling and advisory support.
5. WS5/WS6 hardening, config polish, tests.

## Definition of Done

- Network anomaly detection runs automatically after every manual or scheduled scan.
- Security Monitoring tab clearly surfaces active network threats and severity.
- High-risk findings emit live alerts (`security.alert`) and are audit-traceable.
- Agents can read threat posture via tools and provide evidence-backed advice.
- Security architecture docs reflect the new active network guardian behavior.
