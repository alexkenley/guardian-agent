# Proposal: Microsoft Agent 365 Compliance Baseline

**Status:** Proposed  
**Date:** 2026-05-02  
**Scope:** Tier 1 only for the first implementation pass  
**Informed by:**
- [Microsoft Agent 365 documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/)
- [Overview of Microsoft Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/overview)
- [Microsoft Agent 365 SDK and CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Get started with Agent 365 development](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/get-started)
- [Agent 365 Identity](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/identity)
- [Agent observability](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)
- [Add and manage tools](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling)
- [Agent Registry in Microsoft 365 admin center](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry)
- [Secure AI agents at scale using Microsoft Agent 365](https://learn.microsoft.com/en-us/security/security-for-ai/agent-365-security)
- [Microsoft 365 Integration Design](../design/MICROSOFT-365-INTEGRATION-DESIGN.md)
- [Tools Control Plane Design](../design/TOOLS-CONTROL-PLANE-DESIGN.md)
- [Forward Architecture](../architecture/FORWARD-ARCHITECTURE.md)

---

## Executive Summary

Microsoft Agent 365 is not a replacement runtime for GuardianAgent. It is an enterprise control plane for observing, governing, and securing agents across Microsoft 365, Microsoft Entra, Microsoft Purview, and Microsoft Defender.

GuardianAgent already has several compatible foundations:

- native Microsoft Graph integration for Outlook, Calendar, OneDrive, and Contacts
- Azure connectivity through cloud provider profiles
- a centralized tool control plane
- approval-gated mutations and external posts
- durable execution state and audit/security activity logs
- a strong Guardian admission and output-protection model

The immediate goal should be **Tier 1 compliance alignment**, not a deep Agent 365 rewrite.

Tier 1 means GuardianAgent should be easy for a Microsoft 365 administrator to identify, review, own, and govern. It should clearly document its Microsoft-facing identity, permissions, data access, approval controls, audit evidence, and operational owner. It should not yet depend on Agent 365 SDK packages, Work IQ MCP servers, or an AI teammate identity.

Later tiers can add Agent 365 observability export, Entra Agent ID blueprints, governed Work IQ MCP tool access, and optional AI teammate behavior.

---

## Current Guardian State

### Existing Microsoft 365 Integration

GuardianAgent currently implements Microsoft 365 through direct Microsoft Graph calls:

- `src/microsoft/microsoft-auth.ts` implements OAuth 2.0 PKCE with encrypted token storage.
- `src/microsoft/microsoft-service.ts` wraps Microsoft Graph REST calls.
- `src/tools/builtin/workspace-tools.ts` registers `m365_status`, `m365`, `m365_schema`, `outlook_draft`, and `outlook_send`.
- `docs/design/MICROSOFT-365-INTEGRATION-DESIGN.md` defines the native integration model.

This is a delegated user integration. It is appropriate for user-approved Outlook, calendar, OneDrive, and contacts work, but it is not the same thing as an Agent 365 blueprint-backed agent identity.

### Existing Azure Connectivity

GuardianAgent already has Azure cloud profile support for infrastructure operations. That surface is operationally separate from Microsoft 365 user-data access:

- Azure cloud tooling uses cloud provider profiles and infrastructure-oriented credentials.
- Microsoft 365 tooling uses Microsoft Graph and delegated OAuth.
- Agent 365 identity and blueprint work should not be mixed into either path casually.

### Existing Governance Foundations

GuardianAgent already owns the right internal chokepoints for a compliance baseline:

- Intent Gateway for request classification.
- ToolExecutor and tool registry for capability execution.
- Guardian admission pipeline for risk decisions.
- Approval orchestration for write/send/delete/external-post actions.
- Audit log and security activity log for review evidence.
- Web Configuration and Reference Guide surfaces for operator-facing setup.

These should be reused. Tier 1 should not add a parallel Microsoft-specific approval, audit, or routing flow.

---

## What Agent 365 Adds

Agent 365 organizes enterprise agent governance around these concerns:

1. **Registry and visibility**: agents appear in the Microsoft 365 admin center and can be reviewed by owner, publisher, platform, status, channel, and governance state.
2. **Identity and lifecycle**: agents can be registered as Entra applications or built from Entra Agent ID blueprints. Blueprint-backed agents inherit tenant governance and policy.
3. **Observability**: Agent 365 uses OpenTelemetry-based telemetry for invocations, tool execution, model inference, exceptions, and operational traces.
4. **Governed Microsoft 365 tool access**: Work IQ MCP servers can expose Microsoft 365 workloads through admin-governed tooling.
5. **Security and compliance**: Entra, Purview, and Defender provide visibility, conditional access, DLP, sensitivity-label handling, auditing, detection, and lifecycle controls.
6. **Optional AI teammate identity**: some tenants can provision agents with user-like Microsoft 365 identities, mailboxes, Teams presence, and org-chart visibility.

Tier 1 only needs the first concern plus enough local documentation and controls to prove GuardianAgent is not a shadow, ownerless, over-permissioned, or unauditable agent.

---

## Proposed Tier Model

### Tier 1: Compliance Baseline

**Goal:** Make GuardianAgent visible, owned, least-privilege, reviewable, and audit-ready for Microsoft 365 administrators.

Tier 1 should add:

- a documented Agent 365 compliance posture
- an operator checklist for Microsoft 365 admin center / Agent Registry review
- a tenant registration model for the existing Microsoft 365 integration
- explicit owner, publisher, and support-contact metadata
- a permission and data-access inventory for Microsoft Graph scopes
- guidance to use tenant-specific Entra app registrations instead of broad `common` registrations for organization deployments
- a local status/report surface that summarizes Agent 365 compliance readiness without reading mailbox/calendar/file content
- tests around the report/status shaping

Tier 1 should not add:

- Agent 365 SDK dependencies
- Agent 365 observability exporter
- Agent 365 Work IQ MCP integration
- Entra Agent ID blueprint automation
- AI teammate provisioning
- Teams bot or Microsoft 365 app manifest publishing
- new Microsoft-specific approval flow

### Tier 2: Agent 365 Observability

**Goal:** Export GuardianAgent invocation, tool, and inference telemetry using Agent 365-compatible OpenTelemetry semantics.

This should instrument existing Guardian chokepoints rather than creating side-channel telemetry:

- invocation spans from shared dispatch / chat-agent entry
- tool spans from ToolExecutor
- inference spans from provider calls
- approval/denial/error events from Guardian and pending-action state
- redaction before export

### Tier 3: Agent Identity and Blueprint Support

**Goal:** Support Entra Agent ID / blueprint-backed deployments for autonomous or organization-owned agent operations.

This tier should introduce a first-class `agent365` config surface for:

- tenant ID
- blueprint ID
- agent ID / agent instance ID
- agent user ID and email, if applicable
- publisher metadata
- support owner metadata
- token resolver configuration

### Tier 4: Governed Work IQ MCP Tools

**Goal:** Allow GuardianAgent to consume Agent 365-governed Microsoft 365 MCP servers where administrators want Microsoft-managed tool permissions instead of direct Graph calls.

This should be added as a governed Microsoft tool-source adapter and should not replace the current direct Graph integration by default.

### Tier 5: AI Teammate Mode

**Goal:** Allow GuardianAgent to operate as a Microsoft 365 AI teammate with its own identity, mailbox, Teams presence, and organization metadata.

This is a separate product mode and should only be pursued after the tenant, license, and Frontier availability constraints are clear.

---

## Tier 1 Requirements

### R1: Agent Registration Posture

GuardianAgent must have a documented registration posture for enterprise Microsoft 365 use.

Recommended Tier 1 posture:

- Register a tenant-specific Microsoft Entra application for GuardianAgent.
- Avoid `common` for organization deployments unless the operator explicitly wants multi-tenant or personal account compatibility.
- Use a clear display name, for example `GuardianAgent`.
- Set verified publisher information where available.
- Assign an owner or owner group in Entra.
- Record the support contact and responsible team.
- Review the application in the Microsoft 365 admin center / Agent Registry where available.

Rationale:

- Agent 365 emphasizes registry visibility, owner assignment, and avoiding unmanaged or ownerless agents.
- The existing Guardian OAuth implementation supports tenant IDs already, so the runtime does not need major changes for this posture.

### R2: Permission Inventory

GuardianAgent must document the Microsoft Graph scopes it requests and why.

Current native Microsoft 365 scope model:

| Service | Scopes | Purpose |
|---------|--------|---------|
| User | `User.Read` | Profile lookup and connection status |
| Mail | `Mail.ReadWrite`, `Mail.Send` | Outlook read/draft/send operations |
| Calendar | `Calendars.ReadWrite` | Calendar read/write operations |
| OneDrive | `Files.ReadWrite` | OneDrive file read/write operations |
| Contacts | `Contacts.ReadWrite` | Contact read/write operations |
| Refresh | `offline_access` | Token refresh for connected accounts |

Tier 1 should make this visible in operator documentation and in a status/report surface.

### R3: Least-Privilege Deployment Guidance

Operators should be guided to enable only required Microsoft 365 services.

Examples:

- Mail-only deployment: enable `mail` and `user`, not Calendar/OneDrive/Contacts.
- Calendar assistant deployment: enable `calendar` and `user`, not Mail/OneDrive/Contacts.
- Full productivity deployment: enable Mail, Calendar, OneDrive, Contacts, and document the broader access.

Tier 1 should not silently expand scopes for Agent 365 readiness.

### R4: Approval and Action Controls

The compliance baseline must explicitly map Microsoft-facing actions to Guardian approval controls.

Expected controls:

| Action class | Examples | Required Guardian posture |
|--------------|----------|---------------------------|
| Read status | `m365_status` | No content read; safe for status checks |
| Read content | list/read mail, calendar, OneDrive, contacts | Guardian read capability checks and audit |
| Draft content | `outlook_draft`, event/file/contact creation drafts where applicable | Mutating approval outside autonomous policies |
| Send/share/delete/write | `outlook_send`, calendar write, OneDrive write/delete, contact write/delete | Manual approval or explicit operator policy |
| External post | sending mail outside tenant, posting to external systems | Highest scrutiny; never hidden behind Agent 365 integration |

Tier 1 must keep this in Guardian's shared ToolExecutor and approval model.

### R5: Audit Evidence

GuardianAgent should provide local evidence that Microsoft 365 actions are governed:

- tool name
- action type
- provider, for example `microsoft-native`
- user/channel/request identity where available
- approval state for gated actions
- high-level resource class without leaking sensitive message/file content
- timestamp and outcome

Tier 1 can use existing audit and security activity logs. It does not require exporting telemetry to Microsoft yet.

### R6: Data Boundary Statement

Tier 1 should add a clear operator-facing statement:

- GuardianAgent's current Microsoft 365 integration uses Microsoft Graph delegated access.
- GuardianAgent is not yet an Agent 365 blueprint-backed AI teammate.
- Microsoft 365 content is processed by GuardianAgent according to configured LLM providers and tool policy.
- Operators must configure local vs external model routing according to their data-handling requirements.
- Agent 365 observability export is not enabled in Tier 1.

### R7: Compliance Status Surface

Add a small status/report contract that can be surfaced through the Reference Guide, web Configuration, or a tool/status command.

The report should include:

- Microsoft 365 configured: yes/no
- authenticated: yes/no
- tenant mode: `common`, `organizations`, `consumers`, or specific tenant ID if known
- enabled services
- configured scopes
- risky services enabled
- whether send/write tools are available
- approval policy posture summary
- owner/publisher/support metadata if configured
- Agent 365 readiness status: `baseline_ready`, `needs_owner`, `needs_tenant_specific_registration`, `needs_scope_review`, etc.

The report must not read mailbox, calendar, OneDrive, or contact contents.

---

## Proposed Tier 1 Implementation

### Workstream 1: Documentation and Operator Checklist

Add an Agent 365 compliance section to the operator documentation that covers:

- how GuardianAgent relates to Agent 365
- how to register the Entra app for organization deployments
- why tenant-specific registration is preferred for enterprise use
- Microsoft Graph scope inventory
- owner and support-contact expectations
- Microsoft 365 admin center / Agent Registry review steps
- what Tier 1 does and does not claim

Candidate files:

- `src/reference-guide.ts`
- possibly a new `docs/guides/AGENT-365-COMPLIANCE.md`

### Workstream 2: Config Metadata

Add optional metadata for Agent 365 compliance reporting.

Possible config shape:

```yaml
assistant:
  integrations:
    microsoft365:
      agent365:
        owner: "Platform Operations"
        supportContact: "platform-ops@example.com"
        publisher: "Example Organization"
        registrationMode: "tenant-specific"
        adminCenterUrl: "https://admin.microsoft.com"
```

This metadata is informational in Tier 1. It should not control auth, tool routing, or approvals.

### Workstream 3: Baseline Readiness Report

Extend the existing Microsoft 365 status path or add a narrow compliance report helper.

Preferred shape:

- keep `m365_status` as the no-content status tool
- add an `agent365Compliance` object to its output
- avoid creating a separate Microsoft-specific control flow unless the status object becomes too large

Example output:

```json
{
  "configured": true,
  "authenticated": true,
  "services": ["mail", "calendar"],
  "configuredScopes": {
    "mail": ["Mail.ReadWrite", "Mail.Send"],
    "calendar": ["Calendars.ReadWrite"],
    "user": ["User.Read"]
  },
  "agent365Compliance": {
    "tier": "tier1",
    "status": "needs_scope_review",
    "registrationMode": "tenant-specific",
    "ownerConfigured": true,
    "supportContactConfigured": true,
    "contentReadPerformed": false,
    "observabilityExportEnabled": false,
    "blueprintBackedIdentity": false,
    "workIqMcpEnabled": false
  }
}
```

### Workstream 4: Tests

Add focused coverage for:

- tenant-specific posture is reported when metadata is present
- missing owner/support metadata is flagged
- `m365_status` remains content-free
- configured Graph scopes are accurately summarized
- Tier 1 report does not claim observability, Work IQ, blueprint identity, or AI teammate readiness

Candidate tests:

- `src/microsoft/microsoft-service.test.ts`
- `src/tools/executor.test.ts`
- `src/reference-guide.test.ts`

---

## Non-Goals for the First Pass

Tier 1 must not:

- add `@microsoft/agents-a365-*` npm packages
- install or invoke the `a365` CLI
- create or mutate Entra Agent ID blueprints
- create Microsoft 365 app manifest ZIP files
- publish GuardianAgent to Microsoft Marketplace
- provision an AI teammate identity
- register Work IQ MCP servers
- export telemetry to Microsoft Purview, Defender, or Agent 365
- bypass Guardian's existing approval model
- promote direct Microsoft 365 tools to always-loaded just for Agent 365 visibility

---

## Security Considerations

### Avoiding Shadow Agent Risk

The main Tier 1 risk is not a code exploit. It is administrative ambiguity.

GuardianAgent should not appear as:

- an ownerless Entra app
- a broad multi-tenant app with unclear purpose
- a tool with broad Graph access but no owner
- an unmanaged local agent performing Microsoft 365 actions outside review

Tier 1 reduces this by requiring owner, support, scope, and status visibility.

### Data Minimization

The compliance report must never read Microsoft 365 content. It should rely on configuration, auth state, enabled services, and known scope mappings.

### Least Privilege

The existing Graph scope groups are broad because they support read/write workflows. Tier 1 should make this explicit and steer operators to enable only required services.

Future work may split read-only and write-capable scope sets, but that is not required for the first compliance baseline.

### Approval Preservation

Agent 365 compatibility must not weaken Guardian's local policy. Microsoft-facing write actions should still flow through shared approvals, pending actions, audit logging, and channel rendering.

---

## Acceptance Criteria for Tier 1

Tier 1 is complete when:

1. GuardianAgent has an Agent 365 compliance proposal and operator-facing guidance.
2. Microsoft 365 status/report output includes a Tier 1 compliance summary without reading Microsoft 365 content.
3. The summary identifies missing owner/support metadata and broad/non-tenant-specific registration posture.
4. The summary lists enabled services and configured Graph scopes.
5. The documentation clearly states that GuardianAgent is not yet blueprint-backed, Work IQ-enabled, or Agent 365 observability-exporting.
6. Tests cover the readiness summary and verify no content-read behavior is introduced.
7. Existing Microsoft 365 tools continue to use the shared Guardian ToolExecutor, approval, and audit model.

---

## Recommended First Implementation Order

1. Add the operator-facing Agent 365 compliance guidance.
2. Add optional config metadata shaping for owner, support contact, publisher, and registration posture.
3. Extend `m365_status` with a no-content `agent365Compliance` summary.
4. Add tests for the status summary and docs/reference guide expectations.
5. Run focused tests:
   - `npx vitest run src/reference-guide.test.ts`
   - `npx vitest run src/microsoft/microsoft-service.test.ts`
   - the focused executor/workspace tool test that covers `m365_status`
6. Run `npm run check`.

---

## Future Architecture Notes

When moving beyond Tier 1, avoid adding one-off Microsoft-specific orchestration paths.

The right target shape is:

```text
Agent 365 adapter/config
  -> Guardian execution identity and shared runtime metadata
  -> existing ToolExecutor / approval / audit path
  -> optional Agent 365 observability exporter
  -> optional governed Work IQ MCP tool source
```

Agent 365 should be an enterprise governance adapter around GuardianAgent's existing security model, not a bypass around it.
