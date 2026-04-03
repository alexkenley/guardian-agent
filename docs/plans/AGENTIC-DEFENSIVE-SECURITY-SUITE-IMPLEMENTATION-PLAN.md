# Agentic Defensive Security Suite — Implementation Plan

**Status:** In progress  
**Date:** 2026-03-19  
**Source proposals:** [Agentic Defensive Security Suite](/mnt/s/Development/GuardianAgent/docs/proposals/AGENTIC-DEFENSIVE-SECURITY-SUITE-PROPOSAL.md), [Security Detection And Threat Sharing Uplift](/mnt/s/Development/GuardianAgent/docs/proposals/SECURITY-DETECTION-AND-THREAT-SHARING-UPLIFT-PROPOSAL.md), [Threat Sharing Hub Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/THREAT-SHARING-HUB-PROPOSAL.md)
**Companion as-built spec:** [Agentic Defensive Security Suite - As-Built Spec](/mnt/s/Development/GuardianAgent/docs/specs/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT-SPEC.md)

**Current implementation scope:** phases 1 through 5 only. Enterprise governance and Guardian Hub work are deferred to future planning after the local defensive stack is proven.

## Objective

Deliver GuardianAgent as a layered defensive system that:

1. protects the local agent runtime from agentic offensive attacks
2. actively defends personal workstations and home networks
3. provides bounded, approval-aware containment and response automation for local threats

Enterprise governance and **Guardian Hub** integration remain valid future directions, but they are not part of the current implementation target.

## Sequencing Principles

- **Local-first before sharing.** No hub integration until local detection, alerting, and containment are credible.
- **Containment before autonomy.** Build kill switches, approvals, and scoped identity before aggressive automation.
- **Separate alerts from memory.** Raw telemetry stays in dedicated alert storage; only reviewed summaries enter long-term memory.
- **Personal safety before enterprise breadth.** Prove the safety model on personal workstations and home networks first.
- **Use native platform controls where they are strong.** On Windows, keep Microsoft Defender as the primary AV and firewall foundation, then layer Guardian correlation, policy, and response above it.
- **Profiles and modes are different axes.** Deployment profile selects environment defaults; operating mode selects control aggressiveness.
- **Default to monitor.** All deployment profiles start in `monitor` unless policy explicitly overrides that.
- **Stop at local containment for now.** Enterprise governance and Guardian Hub work stay deferred until the local defensive stack is credible end to end.

## Scope

### In scope

- runtime hardening for agent/browser/tool workflows
- explicit alert-store and memory boundary
- workstation and home-network detection/correlation/containment
- event-triggered containment and response automation

### Out of scope for this plan

- enterprise governance and defensive control-plane work
- Guardian Hub participation, trust, and federation
- a full replacement for commercial EDR, SIEM, or MDM suites
- replacing strong native OS protection engines with a weaker custom AV clone
- mandatory deep packet inspection on day one
- autonomous high-risk remediation from hub-fed intelligence
- broad federation before local trust/evidence quality is proven

## Target End State

By the end of this plan, GuardianAgent should support:

- deployment profiles:
  - `personal`
  - `home`
  - `organization`
- operating modes:
  - `monitor` as the default for all profiles
  - `guarded` for tighter approvals and bounded containment
  - `lockdown` for high-risk users, workflows, or active threats
  - `ir_assist` for investigation and containment under operator control
- native-host integration where appropriate:
  - on Windows, Microsoft Defender remains the primary antivirus and ransomware-protection engine
  - GuardianAgent acts as the policy, telemetry-correlation, threat-intelligence, and response layer above native host controls
  - GuardianAgent can advise, query, and trigger approved native protections without pretending to replace them
- local alerting, posture recommendation, and bounded containment workflows that do not depend on a shared hub

## Host Protection Model

GuardianAgent should not try to outgrow the platform on day one. The intended endpoint posture is:

- **native protection engine**
  - Microsoft Defender Antivirus
  - Windows Defender Firewall
  - Controlled Folder Access / attack-surface-reduction style native controls where available
- **GuardianAgent overlay**
  - host and network telemetry collection
  - cross-signal correlation
  - threat-intel and reputation enrichment
  - approval-aware containment and response
  - user-facing recommendations to move from `monitor` to `guarded`, `lockdown`, or `ir_assist`

For consumer Windows deployments, this means GuardianAgent should be able to replace a third-party consumer antivirus companion product while still keeping Microsoft Defender as the underlying protection engine.

---

## Phase 1: Runtime Safety And Memory Boundary

### Goal

Harden the current runtime so hostile inputs and noisy telemetry cannot quietly shape long-lived agent behavior.

### Deliver

- deployment profile model:
  - `personal`
  - `home`
  - `organization`
- operating mode model:
  - `monitor`
  - `guarded`
  - `lockdown`
  - `ir_assist`
- `monitor` as the default mode across all profiles
- advisory escalation logic that can recommend moving from `monitor` to a higher-control mode
- explicit boundary between:
  - conversation memory
  - long-term memory
  - code-session memory
  - security alerts and evidence
- reviewed incident-summary promotion flow for writing into persistent memory
- stricter approval templates for high-consequence actions:
  - send/share
  - download/open/execute
  - credential-bearing actions
  - destructive shell and system changes

### Likely implementation areas

- `src/config/types.ts`
- `src/runtime/agent-memory-store.ts`
- `src/runtime/conversation.ts`
- `src/tools/executor.ts`
- `src/guardian/*`
- new `src/runtime/deployment-profiles.ts`
- new `src/runtime/operating-modes.ts`

### Exit criteria

- raw detections are not auto-written into persistent memory
- reviewed incident summaries can be promoted with provenance and case linkage
- high-risk action approvals surface destination, scope, and consequence clearly
- deployment profiles and operating modes can be selected independently from config/runtime
- `monitor` is the default mode unless policy intentionally raises it

---

## Phase 2: Browser, Session, And Secrets Containment

### Goal

Reduce the two biggest consumer-risk surfaces for agentic attacks: authenticated browser state and exposed credentials.

### Deliver

- `BrowserSessionBroker`
- default logged-out browsing mode for untrusted or mixed-trust sites
- separation of authenticated and unauthenticated browser sessions
- upload/download gating for agent browser workflows
- `SecretsBroker` for narrow task-scoped tokens instead of raw credential exposure
- local egress allowlists per agent/task/profile/mode
- initial download quarantine for files fetched or generated by agents

### Likely implementation areas

- browser runtime / browser MCP integration layer
- `src/tools/executor.ts`
- `src/guardian/ssrf-protection.ts`
- `src/guardian/output-guardian.ts`
- new `src/runtime/browser-session-broker.ts`
- new `src/runtime/secrets-broker.ts`
- web approval UI and security notifications

### Exit criteria

- browser tasks can run in disposable or task-scoped sessions
- credential-bearing actions are brokered rather than prompt-visible
- risky outbound actions can be blocked by profile, mode, or policy
- suspicious downloads are quarantined before execution or opening

---

## Phase 3: Unified Detection Pipeline And Alert Store

### Goal

Create the local detection spine that all later response and sharing phases depend on.

### Deliver

- normalized `DetectionSignal`, `CorrelatedDetection`, `SecurityAlert`, and share-candidate models
- `ThreatCorrelator` with sliding-window rules
- alert store with lifecycle state, evidence, suppression, and forensic search
- detection-content pipeline for:
  - indicators and reputation data:
    - IPs
    - domains
    - URLs
    - hashes
  - behavior rules and signatures:
    - Sigma-style event detections
    - YARA-style file and artifact detections
- adapters for current local sources:
  - `AuditLog`
  - Sentinel findings
  - host monitor outputs
  - network baseline / threat outputs
  - gateway monitor outputs
  - native security provider outputs such as Defender detections and scan state
- read-only analyst tooling such as `security_alert_search`

### Likely implementation areas

- new `src/detection/*`
- `src/runtime/sentinel.ts`
- new `src/runtime/security-provider/*`
- `src/tools/executor.ts`
- `src/channels/web.ts`
- `web/public/js/pages/security.js`

### Exit criteria

- detections from multiple local sources are represented in one pipeline
- alerts can be searched, acknowledged, suppressed, and resolved
- evidence remains tied to the alert record rather than memory
- analysts and agents can query alert posture without relying on `memory_search`
- the detection stack can ingest both local telemetry and native security-engine findings

---

## Phase 4: Personal Workstation Defender And Home Network Guard

### Goal

Make the system operational for real personal endpoints and household environments.

### Deliver

- persistent workstation monitoring for:
  - suspicious process execution
  - persistence drift
  - sensitive path changes
  - suspicious downloads and outbound destinations
- Windows native security integration for:
  - Defender health, signatures, scan status, and threat detections
  - firewall state and configuration drift
  - Controlled Folder Access and related native hardening state
  - approved quick/full/custom scan triggers and signature refresh actions
- optional richer Windows telemetry for higher-fidelity detection:
  - Windows Event Log integration
  - Sysmon-backed process, network, and file activity where enabled
- home-network guard extensions for:
  - device trust graph
  - router/firewall drift
  - new admin interfaces
  - brute force and east-west scanning
  - suspicious DNS and beaconing
- safe operator workflows for:
  - watchlist additions
  - router denylist proposals
  - device quarantine recommendations
  - kill-switch actions
  - Defender hardening recommendations and scan actions

### Likely implementation areas

- existing host monitor runtime
- existing gateway monitor/runtime network services
- new `src/runtime/windows-defender-provider.ts`
- new `src/runtime/windows-security-events.ts`
- new `src/runtime/detection-content.ts`
- new `src/runtime/containment-service.ts`
- new `src/runtime/home-network-guard.ts`
- automations presets and security UI

### Exit criteria

- a personal user can run GuardianAgent in a meaningful defender posture without enterprise dependencies
- on Windows, a personal user can rely on Microsoft Defender plus GuardianAgent as a coherent host-security stack without needing a separate consumer AV companion
- home-network anomalies and workstation incidents are correlated and surfaced coherently
- response options are conservative, approval-aware, and audit-traceable

---

## Phase 5: Event-Triggered Containment And Response Automation

### Goal

Move from observation to safe reaction without bypassing Guardian enforcement.

### Deliver

- event-trigger support in `ScheduledTaskService`
- `ContainmentService` for:
  - pausing workflows
  - revoking approvals
  - cutting egress per agent/profile/mode
  - disabling high-risk tool classes temporarily
- response playbook presets for:
  - prompt-injected browser workflows
  - suspicious downloads
  - brute force / beaconing detections
  - credential exposure or token misuse
- causal-chain propagation from detection to response to operator notification

### Likely implementation areas

- `src/runtime/scheduled-tasks.ts`
- `src/runtime/connectors.ts`
- `src/queue/event-bus.ts`
- `src/runtime/notifications.ts`
- new `src/runtime/containment-service.ts`

### Exit criteria

- detections can trigger safe, bounded response workflows
- containment actions still pass through approval and policy layers
- operators can see why a response happened and what evidence triggered it

---

## Deferred Future Phases

The following phases remain part of the broader long-term roadmap, but they are explicitly out of scope for the current implementation effort. Current delivery stops after phase 5.

### Phase 6: Enterprise Governance And Defensive Control Plane

### Goal

Extend the local defensive model into a governed organizational product.

### Deliver

- `AgentAssetInventoryService` for agents, tools, MCPs, connectors, scopes, and owners
- `ConnectorTrustRegistry` with reviewed/signed connector metadata
- enterprise identity and short-lived credential patterns
- data classification and DLP-aware policy checks
- role-separated approvals and org policy-as-code for agent operations
- SOC/SIEM/EDR integration for alerts and cases
- enterprise hunt APIs and dashboards
- enterprise mapping to native endpoint controls where available:
  - Defender/ASR/CFA posture visibility
  - fleet policy recommendations
  - approved scan/hardening workflows routed through enterprise controls

### Likely implementation areas

- identity/runtime policy modules
- connector control plane
- security dashboard and APIs
- new inventory/registry services
- org-scoped config and approval channels

### Exit criteria

- enterprise users can inventory and govern their agentic attack surface
- alerts and cases can flow into organizational security tooling
- org policy can restrict tool, destination, and data access by role and environment

---

### Phase 7: Guardian Hub Local Node Integration

### Goal

Allow a fully local GuardianAgent deployment to participate in the Guardian Hub safely.

### Deliver

- Guardian Hub agent/node identity bootstrap
- signed submission pipeline for evidence-backed local alerts
- inbound feed ingestion as low-authority contextual signals
- retroactive hunt on new trusted indicators
- approval-gated submission workflow by default
- local cache and offline-safe behavior for hub outages

### Likely implementation areas

- threat sharing / hub runtime agent
- detection adapters for hub-fed signals
- alert store and retroactive hunt queries
- signing, registration, and feed-poll logic

### Exit criteria

- a local node can publish eligible intelligence to Guardian Hub
- a local node can consume trusted intelligence without bypassing local verification
- hub outages do not degrade local protection

---

### Phase 8: Guardian Hub Trust, Feedback, And Federation

### Goal

Turn Guardian Hub from simple feed exchange into a trustworthy defensive network.

### Deliver

- reputation and corroboration logic
- canary/counter-poisoning mechanics
- signed submission-chain validation
- effectiveness feedback loops from local detections and blocks
- organization-specific trust policies and feed controls
- sector or tenant-specific Guardian Hub feeds
- optional hub-to-hub federation after trust controls are mature

### Likely implementation areas

- Guardian Hub server/control-plane implementation
- node trust and feedback models
- dashboard and operator policy surfaces
- hub analytics and anti-poisoning services

### Exit criteria

- Guardian Hub can rank, suppress, and corroborate submissions safely
- local nodes benefit from shared intelligence without taking blind actions
- trust and effectiveness are measurable, not assumed

---

## Cross-Phase Workstreams

### Security evaluation

Run throughout all phases:

- hijacking evals
- prompt injection evals
- browser and credential misuse evals
- memory poisoning evals
- enterprise approval-abuse evals for future enterprise phases
- hub poisoning and stale-intel evals for future hub phases

### Documentation

Keep current through all phases:

- deployment-profile semantics, operating-mode semantics, and safe defaults
- operator runbooks
- case and alert taxonomy
- developer guidance for new tools, MCPs, and connectors

### UX

Keep current through all phases:

- explain why actions were blocked or gated
- show blast radius and destination clearly
- support quiet monitoring mode vs. lockdown mode
- keep remediation recommendations actionable and conservative

---

## Delivery Order

1. Phase 1: Runtime Safety And Memory Boundary
2. Phase 2: Browser, Session, And Secrets Containment
3. Phase 3: Unified Detection Pipeline And Alert Store
4. Phase 4: Personal Workstation Defender And Home Network Guard
5. Phase 5: Event-Triggered Containment And Response Automation

Current implementation stops here. Enterprise governance and Guardian Hub phases remain deferred until the local safety, evidence quality, and containment layers are complete and proven.

## Definition Of Done

- GuardianAgent can run safely across `personal`, `home`, and `organization` deployment profiles with `monitor` as the default operating mode
- alerts and evidence are stored in a dedicated security system rather than planner memory
- detections can trigger safe containment and response flows
- native host protections can be integrated and orchestrated without GuardianAgent pretending to replace them outright
- the implementation is operational and coherent without depending on enterprise governance or Guardian Hub participation
