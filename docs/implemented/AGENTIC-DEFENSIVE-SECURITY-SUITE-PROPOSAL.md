# Proposal: Agentic Defensive Security Suite

**Date:** 2026-03-19
**Status:** Implemented for the current local-defense scope; retained as historical proposal
**Current source of truth:** [Agentic Defensive Security Suite As-Built](../design/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md)
**Cross-references:** [Security Detection And Threat Sharing Uplift Proposal](../proposals/SECURITY-DETECTION-AND-THREAT-SHARING-UPLIFT-PROPOSAL.md), [Threat Sharing Hub Proposal](../proposals/THREAT-SHARING-HUB-PROPOSAL.md), [Architecture Overview](../architecture/OVERVIEW.md)

---

## Executive Summary

GuardianAgent should not only protect its own agent runtime. It should evolve into a defensive suite for **agentic security on real endpoints and networks**:

- personal workstations
- home networks with mixed-trust devices
- small business environments
- larger organizations with enterprise identity, approval, and SOC workflows

The design goal is to actively defend against agentic offensive tradecraft such as:

- agent hijacking through indirect prompt injection
- tool misuse that turns legitimate capabilities into offensive actions
- credential and token abuse
- memory and context poisoning
- malicious MCP or connector supply-chain inputs
- remote code execution through natural-language driven automation
- human trust exploitation that tricks operators into approving harmful actions

This document expands the current security proposal into a broader product strategy. The architecture and roadmap below are an implementation proposal synthesized from current GuardianAgent capabilities and external guidance from NIST, OWASP, OpenAI, Anthropic, Google Cloud, and Microsoft.

---

## Why This Matters

Recent public guidance points in the same direction:

- NIST documented that agent hijacking can drive outcomes such as remote code execution, data exfiltration, and automated phishing, and that multi-attempt/adaptive evaluations materially change the observed risk picture.
- OWASP's agentic security work highlights a wider taxonomy that includes goal hijack, tool misuse, identity abuse, supply-chain poisoning, unexpected code execution, memory poisoning, insecure inter-agent communication, cascading failures, and human-agent trust exploitation.
- OpenAI, Anthropic, Google Cloud, and Microsoft all emphasize layered defenses: structured flows, least privilege, approvals, runtime guardrails, isolation, monitoring, and evaluation.

The practical implication is simple:

**Agentic security is now endpoint security, identity security, browser security, network security, memory security, and workflow security combined.**

---

## Threat Model

### Core attack classes

| Attack class | Personal / home example | Enterprise example |
|---|---|---|
| Agent goal hijack | Malicious email or web page steers an assistant to exfiltrate local files | Internal or SaaS content steers a corporate agent to copy customer or source data |
| Tool misuse | Agent uses benign shell or browser tools to download malware or mass-send phishing | Agent abuses cloud, ticketing, or admin APIs to make destructive changes |
| Identity and privilege abuse | Stored browser sessions or local tokens are reused for unauthorized actions | Over-scoped OAuth, MCP, or service account access enables lateral movement |
| Supply-chain poisoning | Malicious plugin, MCP server, or update modifies tool descriptions or outputs | Rogue internal connector or compromised vendor integration poisons workflows |
| Unexpected code execution | Natural-language task leads to script download or unsafe shell execution | Automation agent is manipulated into CI/CD or infra execution it should never perform |
| Memory/context poisoning | Long-lived notes or agent memory accumulate hostile instructions | Shared memory or ticket/case summaries bias future enterprise workflows |
| Trust exploitation | User approves a harmful action because the agent explains it confidently | Analyst approves a destructive remediation because it looks routine and urgent |
| Cascading failures | A bad detection or prompt causes multiple home automations to misfire | A false or poisoned signal spreads across teams, agents, or orchestrations |

### Operational consequences we should assume

- prompt injection will remain a long-term problem rather than a fully solved one
- some attacks will succeed only after repeated attempts or long-horizon interaction
- high-consequence actions matter more than aggregate pass/fail rates
- human review is necessary, but human review itself becomes a target

---

## Design Principles

### 1. Treat all untrusted content as hostile workflow input

Emails, PDFs, webpages, tickets, documents, MCP tool descriptions, connector responses, and copied notes can all carry adversarial instructions.

### 2. Separate trusted intent from untrusted data

Untrusted content should not directly become high-authority instructions, tool arguments, or memory.

### 3. Default to least privilege and ephemeral access

Agents should operate with:

- minimal filesystem scope
- minimal network scope
- minimal identity scope
- minimal session lifetime

### 4. Build for containment, not only prevention

Some attacks will get through. The system needs deterministic containment controls:

- kill switches
- sandbox isolation
- approval gates
- network cut-offs
- token revocation
- case creation and evidence capture

### 5. Keep machine telemetry separate from durable memory

Raw alerts should not become planner memory. Only reviewed incident summaries should be promoted.

### 6. Continuously evaluate with adaptive red teaming

Security posture should be measured against evolving attack scenarios, not only static unit tests.

---

## Defensive Architecture

```text
Untrusted inputs
  email / web / files / MCP / connectors / messages / shared intel
                |
                v
      Input Trust + Guardrail Layer
                |
        +-------+--------+
        |                |
        v                v
   Restricted Agent   Detection Sensors
   Runtime            host / network / identity / browser / audit
        |                |
        +-------+--------+
                v
          Correlation + Policy
                |
      +---------+----------+
      |                    |
      v                    v
  Containment         Alert / Case / Hunt
      |                    |
      +---------+----------+
                v
      Notifications / Approvals / Sharing
```

### Key layers

| Layer | Purpose |
|---|---|
| Input trust layer | classify and sanitize hostile or suspicious content before it influences tools |
| Restricted runtime | sandbox agents and segment sessions, credentials, and network reach |
| Sensor layer | observe host, browser, identity, network, and workflow behavior |
| Correlation + policy | combine signals and decide whether to allow, warn, contain, or escalate |
| Containment | freeze risky workflows, disable tools, revoke tokens, cut egress, quarantine sessions |
| Case + hunt | preserve evidence, support review, search, and retroactive analysis |

---

## Boundary And Control Model

The design has two distinct but connected planes.

### 1. Guardian runtime protection

This is the internal security boundary around the agent runtime itself:

- input trust and sanitization
- approvals
- sandboxing
- output controls
- audit logging
- memory protection

### 2. Host and network defense extension

This is the outer defensive boundary around the user environment:

- workstation monitoring
- browser/session containment
- credential and token brokering
- local network and gateway monitoring
- containment actions that affect host or network access

So yes: this is an extension of GuardianAgent into the host and network environment. The runtime layers protect the agent. The outer layer protects the user environment from attacks that use or target the agent.

### Two configuration axes

These docs should keep deployment scope and enforcement posture separate.

**Deployment profile** answers: "what environment is this protecting?"

- `personal`
- `home`
- `organization`

**Operating mode** answers: "how aggressively should controls act right now?"

- `monitor`
- `guarded`
- `lockdown`
- `ir_assist`

### Default operating mode

The default should be `monitor` for all deployment profiles.

That keeps impact low while still collecting evidence, surfacing detections, and building trust in the system. When the system sees meaningful risk, it should:

- notify the user or administrator
- explain why a higher-control mode is recommended
- recommend escalation to `guarded`, `lockdown`, or `ir_assist` as appropriate

Policy-authorized temporary escalation can exist for very high-confidence events, but the baseline posture should still be `monitor`, not automatic lockdown.

---

## Personal Workstation And Home Network Profile

### Product posture

GuardianAgent should support a strong `personal` deployment profile with:

- sandboxed browser and shell tasks
- allowlisted network access for agent actions
- automatic logged-out browsing where possible
- explicit confirmation for email, purchases, account changes, downloads, and script execution
- persistent endpoint and home-network baselining

### Recommended capabilities

| Capability | Purpose |
|---|---|
| Browser Session Broker | Use disposable or task-scoped browser sessions, minimize reuse of logged-in state |
| Secrets Broker | Keep passwords, API keys, and tokens outside agent context; expose only narrow action tokens |
| Local Egress Controller | Enforce per-agent/per-task network allowlists and cut-offs |
| Download Quarantine | Intercept files produced or fetched by agents before opening or execution |
| Home Network Baseline | Detect new devices, role changes, lateral scans, brute force, suspicious DNS, and router drift |
| Incident Kill Switch | Immediately pause automations, browser actions, and outbound agent traffic |
| Safe Approval UX | Force high-signal review for consequential actions with provenance and destination visibility |

### Example protective flows

**Prompt-injected browser workflow**

1. Agent opens a malicious page.
2. Page attempts to redirect the agent to exfiltrate local files or send email.
3. Guardrail layer flags suspicious instructions or data movement.
4. Browser session broker blocks credential-bearing actions outside approved domains.
5. Egress controller denies outbound transfer.
6. Detection stack opens a case, stores screenshots/evidence, and notifies the operator.

**Agent-driven malware delivery attempt**

1. Agent is induced to download a binary or script.
2. Download quarantine intercepts the file.
3. Policy engine denies execution unless explicitly approved in a high-risk workflow.
4. Host monitor and detection pipeline record the event and recommend containment.

### Home network extension

Home networks are hostile-by-default mixed environments. The suite should treat:

- routers
- NAS appliances
- IP cameras
- smart devices
- personal laptops
- guest devices

as a monitored trust graph, not a flat trusted LAN.

Recommended home-network controls:

- baseline each device type and role
- detect new management interfaces, port forwards, firewall disablement, or admin-user changes
- watch for east-west scans, brute force, repeated DNS beaconing, and outbound connections to newly suspicious destinations
- support safe response actions such as alert-only, watchlist, router denylist proposal, or device quarantine recommendation

---

## Enterprise And Corporate Profile

### Product posture

For organizations, GuardianAgent should become a governed defensive control plane for agentic workflows rather than a standalone assistant.

### Recommended capabilities

| Capability | Purpose |
|---|---|
| Agent and MCP Inventory | Maintain an asset inventory of agents, tools, connectors, data sources, scopes, and owners |
| Identity Federation | Use enterprise identity, short-lived credentials, and role/approval boundaries |
| Policy-As-Code for Agents | Encode allowed tools, destinations, data classes, and consequence thresholds |
| Org lockdown policies | High-risk users or workflows can be moved into a deterministic low-network mode |
| DLP + Data Classification | Prevent exfiltration of secrets, regulated data, source code, and sensitive documents |
| SOC / SIEM / EDR Integration | Forward cases and alerts into existing security operations tooling |
| Connector Trust Registry | Approve, sign, and version internal MCPs and workflow dependencies |
| Segregated Workspaces | Separate browsing, shell, code, and data access by team, tenant, or function |
| Enterprise Hunt APIs | Search alerts, cases, and correlated evidence across users, agents, and time windows |

### Enterprise-specific defenses

- least-privilege scopes for every agent, connector, and approval role
- oversharing remediation before agents can access corporate content broadly
- signed and reviewed MCP/connector definitions
- read and write approvals separated by data sensitivity and blast radius
- case escalation into IR/SOC systems with structured evidence
- agent-specific red-team programs and release gates

### Operating modes across all deployment profiles

| Mode | Intended use |
|---|---|
| Monitor | Default for all profiles. Observe, alert, and advise with minimal behavioral impact. |
| Guarded | Add tighter approvals, stricter network/session rules, and bounded containment for suspicious conditions. |
| Lockdown | Minimal network/tool surface for high-risk users, workflows, or active threats. |
| IR Assist | Incident response mode: preserve evidence, hunt quickly, and contain aggressively under operator control. |

The important distinction is:

- deployment profile selects environment-specific defaults
- operating mode selects how aggressively the system acts at the moment

---

## New GuardianAgent Capabilities To Add

### 1. `MemoryGuardService`

Purpose:

- protect long-term memory from poisoning
- mark provenance and trust
- require reviewed promotion for incident summaries
- support rollback and diff of memory changes

### 2. `BrowserSessionBroker`

Purpose:

- use disposable browser profiles
- separate authenticated and unauthenticated browsing
- restrict site login reuse
- gate clipboard, upload, and download actions

### 3. `SecretsBroker`

Purpose:

- issue narrowly scoped tokens instead of exposing raw credentials
- rotate and revoke quickly
- prevent the agent from seeing secrets it does not need to reason over

### 4. `ContainmentService`

Purpose:

- pause or kill running workflows
- disable classes of tools dynamically
- cut outbound network for selected agents
- invalidate scoped approvals on active incidents

### 5. `AgentAssetInventoryService`

Purpose:

- inventory all agents, tools, MCPs, connectors, permissions, trust levels, and owners
- support enterprise reporting and attack surface review

### 6. `ConnectorTrustRegistry`

Purpose:

- approve and sign trusted connector/MCP definitions
- monitor version drift
- mark trust and blast radius for each integration

### 7. `AgenticAttackEvalSuite`

Purpose:

- continuously test hijacking, tool misuse, data exfiltration, phishing, RCE, memory poisoning, and approval-manipulation scenarios
- score not just attack success but consequence severity and containment time

### 8. `DeploymentProfilesAndModes`

Purpose:

- expose clear deployment profiles such as `personal`, `home`, and `organization`
- expose operating modes such as `monitor`, `guarded`, `lockdown`, and `ir_assist`
- make `monitor` the default across profiles and treat escalation as advisory or policy-authorized

---

## How This Extends The Current Proposal

The current security detection proposal remains the right technical foundation:

- normalized signals
- correlation rules
- alert store
- event-triggered response
- hub integration

This broader suite adds the layers that turn it into active defense:

- runtime isolation
- memory protection
- identity and secrets mediation
- browser/session containment
- org-scale inventory and policy control
- adaptive red-team evaluation

---

## Recommended Roadmap

### Phase 1: Personal Foundation In Monitor Mode

- add browser/session isolation rules
- add download quarantine and outbound allowlists
- add reviewed incident-to-memory promotion flow
- add high-risk approval UX for send/download/execute/share actions

### Phase 2: Home Network Guard

- expand gateway and host monitoring into persistent home-network defense
- add suspicious DNS, brute force, and lateral movement correlation
- add router/firewall drift cases and safe denylist proposals

### Phase 3: Enterprise Governance Foundation

- add asset inventory for agents, tools, and MCPs
- add connector trust registry and scoped identity controls
- add alert/case APIs for SIEM, EDR, and SOAR integration

### Phase 4: Mode Escalation, Lockdown, And Incident Response

- introduce deterministic lockdown mode for high-risk users or live incidents
- disable network-capable features selectively
- support workflow freeze, token revocation, and emergency containment

### Phase 5: Continuous Agentic Red Teaming

- add an evaluation harness modeled around agent hijacking, tool misuse, exfiltration, and approval abuse
- track attack success, attempted consequence, containment latency, and operator error rates

---

## Research Inputs

These sources directly informed the recommendations above:

- [NIST: Strengthening AI Agent Hijacking Evaluations](https://www.nist.gov/news-events/news/2025/01/technical-blog-strengthening-ai-agent-hijacking-evaluations)
- [OWASP: Agentic Security Initiative](https://genai.owasp.org/initiatives/agentic-security-initiative/)
- [OWASP: Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)
- [OpenAI: Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- [OpenAI: Continuously hardening ChatGPT Atlas against prompt injection attacks](https://openai.com/index/hardening-atlas-against-prompt-injection/)
- [OpenAI Help: Lockdown Mode](https://help.openai.com/en/articles/20001061)
- [Anthropic: Computer use tool security considerations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Google Cloud: Securing AI](https://cloud.google.com/security/securing-ai)
- [Microsoft Learn: Security for Microsoft 365 Copilot](https://learn.microsoft.com/en-us/copilot/microsoft-365/security-microsoft-365-copilot)

---

## Summary

The strategic direction is to make GuardianAgent capable of:

- resisting agent hijacking and tool abuse locally
- detecting and containing agentic attacks on personal systems and home networks
- operating as a governed defensive plane for enterprise agent ecosystems

The key design choice is not to solve this only with prompts or only with detections. It requires a layered system:

- trust-aware inputs
- constrained runtime
- strong approvals
- separate alert and memory boundaries
- continuous containment
- adaptive red-team evaluation
