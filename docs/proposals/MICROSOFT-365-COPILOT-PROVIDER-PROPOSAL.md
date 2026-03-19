# Proposal: Microsoft 365 Copilot Provider / Managed Integration

**Status:** Proposed
**Date:** 2026-03-19
**Informed by:**
- [Microsoft 365 Integration Spec](../specs/MICROSOFT-365-INTEGRATION-SPEC.md)
- [Cloud & Hosting Integration Spec](../specs/CLOUD-HOSTING-INTEGRATION-SPEC.md)
- [LLM Provider Types](../../src/llm/types.ts)
- [Microsoft 365 Copilot APIs overview](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/copilot-apis-overview)
- [Microsoft 365 Copilot Chat API overview](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/chat/overview)
- [copilotConversation: chat](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/chat/copilotconversation-chat)
- [Copilot API licensing / cost considerations](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/cost-considerations)
- [Plugins for Microsoft 365 Copilot](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/overview-api-plugins)
- [Extend your agent with MCP in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp)
- [Copilot Chat FAQ](https://learn.microsoft.com/en-us/copilot/mobile)
- [Windows App Actions](https://learn.microsoft.com/en-us/windows/ai/app-actions/)
- [Windows AI](https://learn.microsoft.com/en-us/windows/ai/)

---

## Executive Summary

GuardianAgent should **not** attempt to integrate the consumer **Windows Copilot** surface as an LLM provider.

There is no supported public API for treating the Windows Copilot app as a local assistant backend. The supported Microsoft path is the **Microsoft 365 Copilot APIs** exposed through Microsoft Graph and related enterprise services.

However, GuardianAgent also should **not** treat Microsoft 365 Copilot as "just another OpenAI-style provider" without qualification:

- it is **tenant-bound**
- it requires **Microsoft Entra app registration**
- it requires **delegated work/school user authentication**
- it requires **Microsoft 365 Copilot licensing**
- the current Chat API is still **preview / beta-backed**
- the current Chat API is **text-only** and explicitly does **not** support actions, content-generation skills, or tool-like capabilities

The correct direction, if we revisit this later, is:

1. **Do not build a Windows Copilot provider**
2. **Do not reuse the Azure cloud-hosting auth path**
3. **Do not reuse the current `m365` Graph integration unchanged**
4. **If implemented at all, add a separate enterprise integration** such as `m365_copilot`
5. **Initial scope should be a managed read-only / advisory integration or synthesis-only provider**, not the default Guardian tool-calling provider

---

## Problem

There are three Microsoft-shaped integration surfaces that are easy to conflate:

1. **Windows Copilot / Copilot Chat / the Windows shell experience**
2. **Microsoft 365 Graph-backed user integrations** such as Outlook, Calendar, OneDrive, Contacts
3. **Azure cloud-hosting operations** such as ARM, Storage, DNS, and Monitor

GuardianAgent already implements (2) and (3), but neither one is a ready-made Copilot provider:

- the current native Microsoft 365 integration is a **Graph v1.0 business-data integration**, not a Copilot conversation provider
- the Azure path is a **service-principal / client-credentials** infrastructure integration, not a user-delegated Copilot identity flow

This proposal defines the correct boundary.

---

## Research Summary

### What is not supported

The consumer Copilot / Copilot Chat path is not the right integration target for GuardianAgent:

- Microsoft documents **no public API for Copilot Chat** in the way developers often mean when they ask about "Windows Copilot API"
- the Copilot Chat FAQ explicitly says there is **no API** and directs extension scenarios toward **Microsoft 365 Copilot** and **Copilot Studio**
- Windows-native AI developer paths such as **Windows AI** and **App Actions on Windows** are real, but they are not equivalent to "call the Windows Copilot assistant"

Implication:

- GuardianAgent should not try to automate the Windows Copilot app through hidden services, shell hooks, or UI automation

### What is supported

The supported enterprise path is the **Microsoft 365 Copilot APIs**:

- Graph-backed Copilot APIs exist for enterprise scenarios
- the Chat API supports synchronous and streamed chat
- the APIs run within the Microsoft 365 trust boundary
- Copilot Studio and plugin / MCP paths are the supported way to extend Copilot itself

### Important limitations from the official docs

As of this proposal date, the documented Microsoft 365 Copilot Chat API has several constraints:

- **Licensing**: Microsoft 365 Copilot access is required
- **Auth model**: delegated **work or school account** permissions only
- **No app-only flow**: application permissions are not supported for Chat API
- **No personal-account flow**: personal Microsoft accounts are not supported
- **Preview posture**: the Chat API is still under preview / beta-backed documentation
- **Response shape**: textual responses only
- **Capability limits**: no action or content-generation skills such as sending email, creating files, or scheduling meetings
- **No tool parity**: no documented tool-calling / function-calling equivalent comparable to OpenAI or Anthropic tool use

Implication:

- even if GuardianAgent adds Microsoft 365 Copilot support, it should not assume the integration can replace a general tool-calling LLM provider

---

## Current Guardian State

### Existing native Microsoft 365 integration

GuardianAgent already has a native Microsoft 365 integration:

- direct Graph REST calls
- OAuth 2.0 PKCE
- localhost callback
- encrypted token storage
- `m365`, `m365_schema`, `outlook_draft`, `outlook_send`

This path is explicitly Graph business-data integration, not Copilot:

- [MICROSOFT-365-INTEGRATION-SPEC.md](../specs/MICROSOFT-365-INTEGRATION-SPEC.md) defines it as direct Graph integration for mail, calendar, OneDrive, contacts, and Teams
- [src/microsoft/microsoft-service.ts](../../src/microsoft/microsoft-service.ts) targets `graph.microsoft.com/v1.0`
- [src/microsoft/microsoft-auth.ts](../../src/microsoft/microsoft-auth.ts) implements PKCE using `clientId`, `tenantId`, and localhost callback

### Existing Azure cloud integration

GuardianAgent also already has Azure cloud-hosting support:

- ARM / Blob / DNS / Monitor operations
- explicit bearer token or service principal credentials
- client-credentials token exchange against `login.microsoftonline.com`

This path is operationally and semantically different from Copilot:

- it is cloud infrastructure access
- it is not user-delegated conversational auth
- it is not the right basis for Copilot Chat

### Existing LLM provider architecture

GuardianAgent's LLM provider interface expects:

- `chat(...)`
- `stream(...)`
- `listModels()`
- optional provider-returned tool calls inside `ChatResponse`

That means any "provider" we add should be judged not only by authentication feasibility, but by whether it fits the tool-calling behavior Guardian relies on for normal operation.

---

## Why The Current Microsoft Integrations Are Not Enough

### Why current `m365` is not enough

The current `m365` integration cannot simply be relabeled as Copilot because:

- it targets **Graph business endpoints**, not Copilot conversation endpoints
- it is designed around a broad user-data integration surface
- the spec explicitly allows `tenantId: common` and even personal-account compatibility, which conflicts with the enterprise-only Copilot API posture
- its tool set is about Outlook / Calendar / OneDrive CRUD, not Copilot conversation orchestration

### Why Azure cloud auth is not enough

The Azure integration cannot simply be reused because:

- it uses **client credentials / service principal** semantics
- the Copilot Chat API requires **delegated work/school user auth**
- service principal auth is the wrong trust model for per-user Copilot conversations grounded in tenant data

### Why a generic "new provider" framing is incomplete

The phrase "add Copilot as another AI provider" is directionally understandable, but incomplete.

The real constraints are:

- enterprise auth
- licensing
- preview API status
- lack of function / tool-calling parity
- tenant-specific compliance expectations

So this is not just "register another HTTP chat backend."

---

## Recommendation

### Primary recommendation

If GuardianAgent revisits this area, it should implement **a separate Microsoft 365 Copilot integration** with a distinct identity and config surface.

Recommended naming:

- `m365_copilot` for the integration family
- `m365_copilot_chat` for a managed read-only / advisory tool
- optional `m365-copilot` provider type only if the product later wants synthesis-only provider routing

### Explicit non-recommendations

Do **not**:

- attempt to call Windows Copilot directly
- build against undocumented Windows services
- bolt Copilot endpoints onto the existing `m365` tool without a separate config / auth boundary
- reuse Azure service-principal auth for Copilot chat
- advertise Microsoft 365 Copilot as a full tool-calling LLM provider on day one

---

## Proposed Product Shape

### Preferred shape: managed enterprise integration first

The safest first implementation is **not** a default LLM provider.

Instead:

- add a managed Microsoft 365 Copilot connection in the Config Center
- expose a read-only advisory surface such as `m365_copilot_chat`
- allow enterprise-grounded prompt/response flows for supported users
- keep Guardian's main planning / tool-calling loop on providers that support tool use reliably

Why this is the preferred first step:

- it matches the API's current textual-response limitations
- it avoids promising tool-calling parity that the API does not document
- it contains enterprise setup complexity to a clearly labeled optional integration

### Optional second shape: synthesis-only provider

A second-step option is to add `m365-copilot` as a **limited LLM provider family** with a very explicit constraint:

- allowed for response synthesis or instruction-style steps
- not recommended as the default chat/tool-loop provider
- not used where tool calling is required

This would let GuardianAgent route some grounded explanation or summarization turns through Microsoft 365 Copilot without pretending it is equivalent to OpenAI / Anthropic for agentic orchestration.

### Not recommended: full default provider

Making Microsoft 365 Copilot a normal default provider for GuardianAgent's main loop is not recommended unless Microsoft later offers clear, stable support for:

- tool/function calling
- provider-level operational maturity beyond preview
- a model and capability surface suitable for agentic orchestration

---

## Proposed Architecture

### New module family

Recommended new directory:

```text
src/microsoft-copilot/
  microsoft-copilot-auth.ts
  microsoft-copilot-service.ts
  microsoft-copilot-provider.ts
  types.ts
  index.ts
```

### Auth boundary

This integration should be separate from `src/microsoft/`, but can reuse ideas or later share internals through a refactor.

Recommended behavior:

- PKCE delegated auth, like the current Microsoft 365 integration
- **organization tenant required by default**
- no `common` default for Copilot-specific config
- no personal-account promise
- clear admin-consent and licensing preflight in the UI

### Service boundary

The service should encapsulate:

- conversation creation / continuation
- synchronous chat
- streamed chat
- contextual resource wiring where supported
- tenant / license / auth error mapping

It should not inherit CRUD semantics from the current `m365` service because that would blur two different product surfaces.

### Provider boundary

If a provider is implemented:

- it should return plain textual responses
- `toolCalls` should be treated as unsupported / always absent
- configuration and UI must clearly state that this provider is **not suitable as Guardian's primary tool-calling provider**

---

## Configuration Model

Recommended config surface:

```yaml
assistant:
  tools:
    microsoftCopilot:
      enabled: false
      oauthCallbackPort: 18434
      clientId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      mode: managed_tool
      allowPreviewApis: false
      enableStreaming: true

llm:
  m365_copilot:
    provider: m365-copilot
    model: microsoft-365-copilot-chat
```

Recommended notes:

- `tenantId` should be explicit
- `mode` should default to `managed_tool`, not full provider
- `allowPreviewApis` should gate whether the integration can be enabled at all in environments that want strict production-only dependencies

---

## UX Requirements

### Config Center

The setup UX should be more explicit than the current Microsoft 365 connection because Copilot has stronger gating:

1. Tenant / licensing preflight
2. Entra app registration instructions
3. Delegated consent explanation
4. Warning that the integration is currently preview-constrained
5. Warning that this is not equivalent to a normal tool-calling provider

### Provider list

If a provider type is added, the Providers UI should label it clearly:

- `Microsoft 365 Copilot (Enterprise, preview, text-only)`

This avoids the operator reading "Copilot" and assuming parity with mainstream agent backends.

### Tool discovery

If implemented as a managed tool first, `find_tools` results should describe it accurately:

- enterprise grounded
- delegated auth required
- no action execution through the API itself
- advisory / chat use, not direct mutation

---

## Security And Policy Considerations

This integration must stay inside Guardian's existing policy model:

- approval rules remain Guardian-owned
- tool use remains Guardian-owned
- Copilot chat should not be mistaken for a substitute approval plane
- any routed synthesis use must keep Guardian's tool outputs and trust metadata explicit

Additional requirements:

- tenant IDs and client IDs are config, not secrets
- tokens remain encrypted at rest
- auth failures should produce actionable operator copy
- preview-only APIs should be visibly marked in the UI and docs
- if the service is used for grounded summaries, the output should still be treated as AI-generated and untrusted until verified

---

## Recommended Phasing

### Phase 0: Decision and documentation only

- record that Windows Copilot is not an integration target
- record that Microsoft 365 Copilot is enterprise-only and preview-constrained
- keep the current `m365` integration unchanged

### Phase 1: Shared Microsoft auth refactor

- optionally extract shared PKCE pieces between `src/microsoft/` and a future Copilot auth module
- preserve separate config and runtime classes

### Phase 2: Managed enterprise Copilot connection

- add Config Center support
- implement connection test and licensing / auth diagnostics
- implement a minimal `m365_copilot_chat` managed tool

### Phase 3: Streaming + grounding refinements

- support streamed responses
- support contextual resource and grounding options where appropriate
- add operator-facing guidance and audit history shaping

### Phase 4: Optional limited provider mode

- add `m365-copilot` provider family only if there is clear product value for synthesis-only routing
- keep it off the default tool-calling path

---

## Open Questions

1. Should GuardianAgent support preview-only provider families in the main provider registry at all, or require an explicit feature flag?
2. Is there enough product value in a synthesis-only provider to justify new provider-family complexity?
3. Should the first implementation be a managed tool only, with no `llm:` provider integration?
4. Do we want a future shared Microsoft auth base, or should `src/microsoft/` and `src/microsoft-copilot/` remain intentionally separate for clarity?

---

## Proposed Decision

If work is scheduled here later, the proposal should be accepted with this decision:

- **Do not integrate Windows Copilot directly**
- **Do not market Microsoft 365 Copilot as a drop-in general LLM provider**
- **If implemented, build a separate `m365_copilot` integration**
- **Ship it first as a managed enterprise advisory integration, not as Guardian's default tool-calling backend**

