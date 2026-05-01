# Proposal: Security Detection And Threat Sharing Uplift

**Date:** 2026-03-19
**Status:** Draft
**Cross-references:** [Threat Sharing Hub Proposal](./THREAT-SHARING-HUB-PROPOSAL.md), [Agentic Defensive Security Suite](../implemented/AGENTIC-DEFENSIVE-SECURITY-SUITE-PROPOSAL.md), [NotificationService](../../src/runtime/notifications.ts)

---

## Executive Summary

GuardianAgent already has meaningful security controls:

- inline action enforcement through `GuardianAgentService`
- retrospective audit analysis through `SentinelAuditService`
- scheduled and on-demand network checks such as `net_anomaly_check`, `net_threat_check`, and `net_threat_summary`
- workstation and gateway posture checks through the host and firewall monitoring tools
- a `ThreatIntelService` model for watchlists, findings, and response proposals
- auditable automation and notification delivery

The remaining gap is not "security detection from zero". The gap is **unified detection operations**:

1. normalize signals from network, host, audit, and shared-intel sources into one model
2. correlate those signals in real time or near real time
3. enrich detections with evidence and risk context
4. persist alerts with lifecycle state and forensic search
5. route high-quality detections into automations, notifications, and the threat-sharing hub

This proposal reframes the work as a generic uplift of security functions rather than a comparison to any external repository. It also tightens scope where the previous draft overstated what is already present in the codebase.

---

## Current Position

### Existing strengths to preserve

| Area | Current capability |
|---|---|
| Enforcement | Pre-execution action evaluation, approvals, rate limits, policy checks |
| Audit | Structured `AuditLog`, persistence options, anomaly review |
| Network | Baseline tracking, anomaly checks, traffic threat checks, summaries |
| Host | Host monitor posture and immediate checks |
| Automations | Scheduled tasks, playbooks, audit promotion, causal chain tracking |
| Intel | Watchlists, finding model, response proposal model |
| Delivery | `NotificationService` + EventBus-driven security alerts |

### Remaining gaps

| Gap | Why it matters |
|---|---|
| No unified signal model | Network, host, audit, and future hub signals cannot be correlated consistently |
| Snapshot-heavy telemetry | Existing tools are useful but mostly poll/snapshot driven rather than stream driven |
| Limited cross-signal correlation | Audit anomalies, host alerts, and network anomalies are not fused into one detection pipeline |
| No durable detection store | There is no single alert lifecycle for review, suppression, acknowledgment, and forensic search |
| No evidence gate for sharing | Raw local observations should not be submitted directly to the hub |
| Cron-only scheduled tasks | Event-triggered response requires a real service/model extension |

---

## Review Findings And Recommended Uplifts

### 1. Reframe the proposal around unification, not replacement

The previous draft described large parts of detection as absent. That is not accurate. The codebase already contains useful network, host, audit, and notification capabilities. The proposal should therefore position new work as:

- unifying existing telemetry
- adding optional continuous collectors where they materially help
- building a correlation and evidence layer above current tools

### 2. Treat event-triggered response as first-class scope

The previous draft implied that event-triggered scheduled tasks were mostly existing plumbing. They are not. `ScheduledTaskService` is currently cron-based, so event-triggered response needs:

- schema changes in task definitions
- subscription wiring from `EventBus`
- filter semantics for matching event payloads
- replay and dedupe rules to avoid event storms

This should be called out explicitly as a design and implementation phase, not as incidental wiring.

### 3. Avoid simplistic detection heuristics

Pure suspicious-TLD matching is noisy and easy to evade. Recommended uplift:

- combine baseline deviation, frequency, NXDOMAIN rate, resolution state, and entropy
- include allowlists and suppression controls
- allow shared IOCs and local evidence to reinforce one another
- record why a classification was made instead of only recording the outcome

### 4. Make enrichment optional, cached, and provenance-aware

Any external GeoIP or reputation lookup will be rate-limited, partially available, or privacy-sensitive. Recommended uplift:

- provider-agnostic enrichment interfaces
- cache with TTL and bounded concurrency
- explicit provenance on every enrichment result
- graceful degradation when enrichment is unavailable

### 5. Introduce an evidence threshold before sharing

The hub spec is local-first and poison-resistant. The local detection proposal must match that. Recommended uplift:

- raw signals stay local
- correlated detections are triage candidates
- only evidence-backed, normalized alerts become share candidates
- submission defaults remain approval-gated

### 6. Separate detection, intelligence, and response objects

One schema should not do everything. Recommended uplift:

- `DetectionSignal` for raw local observations
- `CorrelatedDetection` for local conclusions
- `SecurityAlert` for operator workflow and alert lifecycle
- `SharedIndicatorCandidate` for outbound hub submission

This reduces ambiguity, makes suppression safer, and clarifies what can and cannot be shared.

### 7. Require least-privilege and fallback modes for continuous collectors

Packet capture and system log streaming will not be available everywhere. Recommended uplift:

- collectors remain opt-in
- startup capability checks are explicit
- unsupported platforms fall back to scheduled checks and existing tools
- failure to start a collector does not degrade the rest of the security stack

### 8. Keep hub-driven hardening conservative

Inbound shared indicators must never become direct, unverified system mutations. Recommended uplift:

- use hub indicators as monitoring and investigation signals first
- require local verification before auto-hardening
- keep medium/high-risk remediations approval-gated
- preserve causal chain and audit evidence for every hub-driven action

---

## Target Architecture

```text
Existing local sources                Optional continuous sources
----------------------               ---------------------------
AuditLog                             DNS collector
Sentinel heuristics                  Host event stream
net_anomaly_check                    Gateway event stream
net_threat_check
host_monitor_check
gateway_firewall_check
Threat-sharing feed
        \                                  /
         \                                /
          v                              v
            Normalized Detection Signals
                       |
                       v
                Threat Correlator
                       |
             +---------+---------+
             |                   |
             v                   v
      Enrichment Pipeline    Alert Store
             |                   |
             +---------+---------+
                       |
        +--------------+---------------+
        |              |               |
        v              v               v
  NotificationService  Automations   Threat sharing adapter
                       and playbooks  (submit + ingest)
```

### Core design principle

The system should improve in layers:

1. normalize and correlate what already exists
2. add better collectors where justified
3. enrich detections only when needed
4. promote only high-quality evidence to the sharing plane

---

## Proposed Data Model

```typescript
interface DetectionSignal {
  id: string;
  timestamp: number;
  type: string;
  source: 'audit' | 'network' | 'host' | 'gateway' | 'hub' | 'dns_stream';
  severityHint?: 'info' | 'warn' | 'critical';
  subject?: string; // domain, ip, agentId, host, rule key
  tags: string[];
  attributes: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
}

interface CorrelatedDetection {
  id: string;
  timestamp: number;
  ruleId: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  description: string;
  score: number;
  subject: string;
  contributingSignalIds: string[];
  evidence: Array<Record<string, unknown>>;
  enrichment?: Record<string, unknown>;
}

interface SecurityAlert {
  id: string;
  detectionId: string;
  status: 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';
  assignee?: string;
  createdAt: number;
  updatedAt: number;
  resolution?: string;
}

interface SharedIndicatorCandidate {
  id: string;
  alertId: string;
  indicatorType: 'domain' | 'ip' | 'hash' | 'url' | 'pattern' | 'behavior';
  value: string;
  category: string;
  confidence: number;
  evidenceSummary: string;
  shareEligible: boolean;
  blockedReasons?: string[];
}
```

### Why this separation matters

- suppression can target noisy signals without discarding correlated alerts
- shared indicators can enforce quality gates without rewriting the alert store
- automations can react to detections while analysts work alerts independently

## Memory System Integration

The security detection stack should integrate with the memory system **selectively**, not by treating memory as the primary detection database.

### Current memory surfaces

GuardianAgent already has three memory-adjacent surfaces:

- conversation/session memory for prior turns and `memory_search`
- global long-term agent memory for durable facts and summaries
- code-session memory for coding-specific retained context

### Recommended boundary

Security telemetry should not be written into those stores by default.

- raw `DetectionSignal` records stay in the detection pipeline
- `CorrelatedDetection` objects stay in the detection pipeline
- `SecurityAlert` objects and their evidence live in the dedicated alert store
- only reviewed, durable summaries are promoted into long-term memory

### Why not store alerts as memory entries

Raw security signals are:

- high-volume
- noisy
- time-sensitive
- often untrusted until correlated and reviewed

If they are injected directly into planner memory, they create avoidable risks:

- prompt/context pollution
- memory poisoning of future agent behavior
- stale detections influencing later decisions
- loss of clear separation between operator knowledge and machine telemetry

### Recommended bridge between security and memory

Use an explicit promotion path instead of automatic persistence into planner memory:

1. Detection pipeline creates a `SecurityAlert`
2. Analyst or approved automation produces an incident summary
3. Only that summary is written into long-term memory
4. The memory entry links back to the originating alert or case ID

Recommended implementation details:

- add a read-only `security_alert_search` tool for alert/evidence retrieval rather than overloading `memory_search`
- allow a controlled promotion path using `memory_save` or a dedicated `security_incident_promote` tool
- write promoted summaries with provenance, tags, and reviewed status
- keep raw detection evidence in the alert store for forensic accuracy

### Practical rule

The alert store is the system of record for detections.

The memory system is the system of record for durable, human-meaningful conclusions such as:

- "Home router was exposed to repeated SSH brute force on 2026-03-18"
- "Agent browser tasks should default to logged-out mode for untrusted sites"
- "Domain X was confirmed malicious and added to the local watchlist after analyst review"

---

## Detection Logic Uplifts

### Recommended default rules

| Rule | Inputs | Default behavior |
|---|---|---|
| DNS beaconing | DNS queries + baseline | investigate on first strong hit, escalate on repeated cadence |
| DNS tunneling | Query volume + label length + entropy | critical alert when tunneling traits cluster in a short window |
| Brute force | Host auth failures | escalate after repeated failures from same source/window |
| Capability probing | `action_denied` audit events | warn on broad denied-action exploration |
| Secret exfil pattern | `secret_detected` + external egress signals | critical alert with containment recommendation |
| Shared IOC local match | hub indicator + local signal | immediate alert with elevated confidence |
| Compound threat | cross-signal correlation | higher severity when multiple weak signals align |

### Classification inputs

Recommended factors for risk scoring:

- baseline deviation
- repetition or cadence
- resolution status
- domain or identifier entropy
- allowlist and known-good checks
- corroboration from shared intelligence
- enrichment provenance and freshness

Recommended non-goal:

- do not encode risk as a single hardcoded `if/else` ladder

---

## Phased Plan

### Phase 1: Unified signal model and correlator

Create a new `src/detection/` module that starts with existing local sources:

- audit events from `AuditLog`
- current network threat and anomaly outputs
- host monitor outputs
- gateway firewall outputs

Primary deliverables:

- normalized `DetectionSignal` model
- in-memory correlation engine with sliding windows
- rule configuration and suppression model
- adapters that ingest current tool/runtime outputs without requiring privileged collectors

Why first:

- highest leverage
- minimal platform risk
- immediately improves fidelity of existing detections

### Phase 2: Optional continuous collectors

Add opt-in adapters for environments that can support them:

- passive DNS collector
- host event stream collector
- gateway log stream collector where available

Required controls:

- explicit capability checks
- platform-specific adapters
- clean startup and teardown
- fallback to current snapshot checks

### Phase 3: Enrichment and evidence quality

Add provider-agnostic enrichment with:

- DNS resolution
- GeoIP or ASN lookup
- optional reputation or age signals
- TTL cache and failure-aware status

This phase also defines share eligibility:

- must be correlated
- must carry evidence
- must satisfy minimum confidence and privacy policy

### Phase 4: Alert store, triage, and forensic search

Add a durable alert store for:

- status transitions
- suppression and false-positive management
- evidence preservation
- alert search

Recommended implementation:

- SQLite
- FTS5-backed search if available, with graceful fallback

### Phase 5: Event-triggered response and notification integration

Extend automations so they can be triggered by detections, not only cron.

Scope includes:

- task definition changes for event triggers
- payload filtering rules
- dedupe and cooldown handling
- causal chain propagation
- response presets for monitoring, enrichment, investigation, and low-risk hardening

All response steps continue to execute through the existing Guardian approval and policy boundary.

### Phase 6: Threat-sharing hub integration

Integrate only after local evidence quality exists.

Outbound:

- submit only eligible `SharedIndicatorCandidate` objects
- sign and audit every submission
- default to approval-gated submission

Inbound:

- ingest shared indicators as context signals
- use them to raise confidence and trigger retroactive hunts
- do not bypass local verification or approval policy

---

## Revised Integration With Threat Sharing Hub

The hub integration should strengthen local detection, not replace it.

### Outbound policy

Only alerts meeting all of the following should be submission candidates:

- correlated rather than raw
- evidence-backed
- not derived from obviously local-only or sensitive context
- above a minimum confidence and severity threshold
- compliant with configured privacy exclusions

### Inbound policy

Feed indicators should enter the correlator as contextual signals, for example:

- watchlist matches
- retroactive hunts against local alert history
- confidence boosts for already-observed local activity

They should not become automatic firewall or configuration changes without local confirmation and policy approval.

### Recommended configuration extension

```yaml
assistant:
  threatSharing:
    enabled: false
    submission:
      autoReport: false
      requireCorrelation: true
      requireEvidence: true
      minSeverity: critical
      minConfidence: 0.8
    feed:
      minTrustLevel: correlated
      injectToCorrelator: true
      retroactiveHuntOnNew: true
    hardening:
      autoHarden: false
      requireLocalVerification: true
```

---

## Implementation Scope

| Phase | Primary changes | Notes |
|---|---|---|
| 1 | New `src/detection/` module, runtime adapters, correlation rules | Starts from existing local telemetry |
| 2 | Optional collectors for DNS and host streams | Opt-in and capability-gated |
| 3 | Enrichment interfaces, cache, evidence policy | No hard dependency on one external service |
| 4 | Alert store, API surface, dashboard search | Enables triage and retrospective hunts |
| 5 | `ScheduledTaskService` event-trigger support, detection presets, notification wiring | Real service/model change |
| 6 | Threat-sharing submission and feed adapters | Depends on hub trust model |

---

## Risk Assessment

| Risk | Recommended mitigation |
|---|---|
| Privileged collectors are unavailable | Keep collectors optional and degrade to current scheduled checks |
| False positives from weak heuristics | Use compound signals, allowlists, suppression, and confidence scoring |
| External enrichment is unreliable | Provider abstraction, cache, TTLs, bounded concurrency, graceful fallback |
| Event storms trigger automation loops | Add cooldowns, dedupe keys, and per-rule automation guardrails |
| Shared intel poisoning | Require evidence gates, trust thresholds, privacy filters, and local verification |
| Scope creep into full SIEM | Keep this as a local detection and response uplift tied to current runtime boundaries |

---

## Explicit Non-Goals

- building a standalone multi-tenant SIEM platform
- making privileged packet capture mandatory
- auto-applying high-risk hub remediations without approval
- assuming one external reputation or GeoIP provider will always be available

---

## Priority Order

1. Phase 1: Unified signal model and correlator
2. Phase 3: Enrichment and evidence quality
3. Phase 5: Event-triggered response and notification integration
4. Phase 4: Alert store and forensic search
5. Phase 2: Optional continuous collectors
6. Phase 6: Threat-sharing hub integration

This ordering closes the largest fidelity gap first, then prevents low-quality detections from flowing into automation or sharing before the evidence model is ready.
