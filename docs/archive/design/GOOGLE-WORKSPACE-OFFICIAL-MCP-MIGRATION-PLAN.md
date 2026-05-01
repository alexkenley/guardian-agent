# Google Workspace Official MCP Evaluation And Migration Plan

**Date:** 2026-04-23
**Status:** Investigation complete. Recommended path is **optional/hybrid adoption**, not a full replacement today.
**Primary sources:**
- [Google Workspace Developer Tools](https://developers.google.com/workspace/guides/developer-tools) (last updated 2026-04-01 UTC)
- [Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers) (last updated 2026-04-22 UTC)

---

## Executive Summary

Google now has **official MCP support**, but there are **two different offerings**:

1. **Developer-docs MCP server** at `https://workspace-developer.goog/mcp`
   - Official
   - Read-only
   - Used to search Google Workspace developer documentation and snippets
   - Not a replacement for authenticated Gmail / Drive / Calendar access

2. **Google Workspace remote MCP servers** in **Developer Preview**
   - Official
   - Authenticated product/data access
   - Separate remote servers for:
     - Gmail: `https://gmailmcp.googleapis.com/mcp/v1`
     - Drive: `https://drivemcp.googleapis.com/mcp/v1`
     - Calendar: `https://calendarmcp.googleapis.com/mcp/v1`
     - Chat: `https://chatmcp.googleapis.com/mcp/v1`
     - People: `https://people.googleapis.com/mcp/v1`

So the answer is **yes**: Google now provides an official Workspace MCP integration for authenticated Workspace data access.

However, a full Guardian migration is **not worth doing as a hard replacement yet** because:

- the official Workspace MCP servers are still **Developer Preview**
- Guardian does **not** currently use an unofficial MCP connector anymore; it already uses a **native Google API integration** in `src/google/`
- Guardian's current native integration covers **Docs** and **Sheets**, while the official MCP servers currently document support for **Gmail, Drive, Calendar, People, and Chat**
- Guardian's MCP client currently supports **stdio only**, not remote HTTP MCP with OAuth 2.0
- a full switch would require non-trivial control-plane, auth, prompt, and test-harness work

The recommended path is:

- **do not replace the native Google integration yet**
- build **generic remote MCP + OAuth support** in the shared MCP control plane
- add Google's official Workspace MCP as an **optional managed provider / backend**
- evaluate it side-by-side
- only consider full replacement after parity improves and the Google servers are no longer preview-only

---

## Current Guardian State

Guardian's live Google path is already native, not the old unofficial MCP/CLI design:

- `src/index.ts` initializes `GoogleAuth` and `GoogleService`
- `src/google/google-auth.ts` handles OAuth PKCE and token storage
- `src/google/google-service.ts` performs direct Google API calls
- `src/tools/builtin/workspace-tools.ts` exposes `gws` and `gws_schema`

The older CLI-backed Google Workspace design in `docs/design/GOOGLE-WORKSPACE-INTEGRATION-DESIGN.md` is now historical background only.

This means the migration question is really:

**native Google SDK/REST integration vs official Google remote MCP**

not:

**unofficial MCP vs official MCP**

---

## Capability Comparison

| Area | Current Guardian Native Google | Official Google Workspace MCP |
|------|--------------------------------|-------------------------------|
| Status | Implemented, first-party in Guardian | Official Google offering, but Developer Preview |
| Transport | Direct HTTPS API calls from Guardian | Remote MCP over HTTP |
| Auth | Guardian-owned OAuth PKCE + encrypted token storage | OAuth 2.0 to Google-hosted remote MCP servers |
| Repo support today | Already implemented | Not yet supported by Guardian MCP client |
| Current Guardian tool shape | `gws`, `gws_schema`, `gmail_draft`, `gmail_send` | Product-specific MCP tools such as `create_draft`, `search_files`, `create_event` |
| Documented coverage | Gmail, Calendar, Drive, Docs, Sheets, Contacts | Gmail, Drive, Calendar, People, Chat |
| Docs support | Yes | No documented Docs MCP server yet |
| Sheets support | Yes | No documented Sheets MCP server yet |
| Chat support | No first-class native path today | Yes |
| Gmail send | Yes | Draft documented; direct send is not documented in the current tool list |
| Tool discoverability | Generic raw API surface via `gws_schema` | Curated first-party tool inventory |
| Maintenance burden | Guardian owns API wrappers and scopes | Google owns server-side tool mapping for supported products |

### Current documented official tool coverage

Per Google's current documentation, the official remote MCP servers expose:

- Gmail: `create_draft`, `create_label`, `get_thread`, `label_message`, `label_thread`, `list_drafts`, `list_labels`, `search_threads`, `unlabel_message`, `unlabel_thread`
- Drive: `create_file`, `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, `search_files`
- Calendar: `create_event`, `delete_event`, `get_event`, `list_calendars`, `list_events`, `respond_to_event`, `suggest_time`, `update_event`
- People: `get_user_profile`, `search_contacts`, `search_directory_people`
- Chat: `search_conversations`, `list_messages`

This is useful coverage, but it is still narrower than Guardian's current native Google surface in important areas.

---

## Why A Full Replacement Is Not Worthwhile Yet

### 1. The official Workspace MCP servers are still preview-only

Google marks the authenticated Workspace MCP servers as **Developer Preview**. That is a valid evaluation target, but not yet a strong foundation for replacing a working production integration.

### 2. Guardian would lose currently supported capabilities

Guardian currently has native Docs and Sheets coverage and explicit Gmail send support. The official Workspace MCP docs currently do not document Docs or Sheets servers, and the Gmail tool list is draft-focused rather than send-focused.

### 3. Guardian lacks the required MCP transport/auth foundation

Guardian's MCP client is currently a **stdio** process client. The official Google Workspace MCP servers are **remote HTTP MCP endpoints with OAuth 2.0**. Adopting them cleanly requires a shared MCP evolution, not a Google-only workaround.

### 4. Prompting and orchestration are built around `gws`

Guardian prompts, tests, approval normalization, and capability hints are currently built around a generic `gws` tool plus schema lookup. Switching directly to product-specific remote MCP tools would cause broad churn across prompts, tests, and routing behavior.

### 5. Setup is not obviously simpler

Google's official remote MCP setup still requires:

- a Google Cloud project
- API enablement
- MCP service enablement
- OAuth consent configuration
- OAuth client creation
- extra Chat app configuration if Chat is enabled

That is not a clear simplification over Guardian's current native OAuth flow.

---

## Where The Official MCP Path Is Better

Even though full migration is not recommended yet, the official Google path has real advantages:

- Google owns the tool definitions and product-specific behavior for supported services
- remote MCP tools are cleaner and more model-friendly than raw REST-shaped arguments
- Chat support is available now
- People / directory search is better defined than Guardian's current contacts-only scope
- long-term maintenance burden for supported products may be lower if Google keeps expanding the server suite

This makes it worth **adopting experimentally**, just not worth **replacing the native path immediately**.

---

## Recommended Migration Strategy

### Recommendation

Adopt the official Google Workspace MCP integration as an **optional backend**, not as a hard replacement.

### Architecture rule

Implement this through the **shared MCP control plane**, not through a Google-only shortcut.

That means:

- extend MCP support generically for remote HTTP transport + OAuth
- then add Google's official servers as a managed provider on top of that shared foundation
- preserve Guardian's existing Google-facing contract until parity is proven

This follows the repo's architecture guidance and avoids another special-case integration path.

---

## Migration Plan

## Phase 0: Decision Gate And Scope Freeze

**Goal:** Confirm that the target is optional/hybrid adoption first, not immediate full replacement.

Tasks:

- record the official Google MCP endpoints, preview status, and documented tool coverage
- define parity criteria before any implementation starts
- explicitly choose one of these target modes:
  - **Mode A:** optional managed provider
  - **Mode B:** hybrid backend behind existing Guardian Google tools
  - **Mode C:** full replacement

Recommendation:

- start with **Mode A**
- keep **Mode B** as the likely next step if the evaluation succeeds
- avoid **Mode C** until Google reaches broader parity and exits preview

Exit criteria:

- product owner agrees that Docs/Sheets/send-email regressions are unacceptable for a full cutover
- implementation work is approved as shared MCP infrastructure, not a one-off Google patch

## Phase 1: Shared Remote MCP Foundation

**Goal:** Teach Guardian to consume remote MCP servers over HTTP with OAuth 2.0.

Required shared changes:

- extend `src/tools/mcp-client.ts` to support remote HTTP transport in addition to stdio
- extend MCP config types beyond stdio-only server definitions
- add secure OAuth credential/token handling for remote MCP servers
- add control-plane UI/API support for remote MCP server configuration and auth state
- keep approval, auditing, and risk classification inside `ToolExecutor`

Rules:

- no Google-specific transport fork in channel code
- no Google-specific auth bypass in `src/index.ts`
- no hardcoding Google remote MCP behavior directly in prompts before the control plane exists

Exit criteria:

- Guardian can connect to a generic OAuth-protected remote MCP server
- tool listing, tool calling, auth failure, reconnect, and audit logging work end to end

## Phase 2: Official Google Managed Provider

**Goal:** Add the official Google Workspace MCP servers as a first-class managed provider on top of the new remote MCP foundation.

Tasks:

- add a managed-provider definition for official Google Workspace MCP
- support service toggles for Gmail, Drive, Calendar, People, and Chat
- wire server URLs from config rather than hardcoding them deep in runtime logic
- store OAuth client config and token material in the same hardened secret/control-plane path used by other integrations
- map each official tool to Guardian categories/risk semantics

Examples:

- `gmail.create_draft` -> `draft_email`
- `calendar.create_event` -> `write_calendar`
- `drive.read_file_content` -> `read_drive`
- `chat.list_messages` -> `read_chat` or `read_workspace`

Exit criteria:

- official Google MCP servers can be enabled from config/web UI
- tool inventory appears correctly
- approval copy and policy decisions remain coherent

## Phase 3: Compatibility Layer Decision

**Goal:** Minimize churn in prompts, routing, and tests.

Recommended approach:

- keep Guardian's existing high-level Google contract stable initially
- do **not** immediately rewrite every prompt and test around raw official MCP tool names

Two implementation options:

1. **Expose official MCP tools directly**
   - simpler MCP purity
   - higher prompt/test churn

2. **Introduce a backend abstraction behind Guardian's existing Google tools**
   - native backend and official MCP backend both satisfy the same higher-level Google capability contract
   - lower churn
   - easier hybrid fallback for unsupported services

Recommendation:

- prefer **option 2**

Reason:

- Guardian already has strong product behavior around `gws`, `gws_schema`, `gmail_draft`, and `gmail_send`
- a backend abstraction lets us adopt official MCP where it is stronger without dropping Docs, Sheets, or Gmail send

Exit criteria:

- existing user-facing Google flows continue to work without widespread prompt regressions
- unsupported official operations can fall back cleanly to native when needed

## Phase 4: Hybrid Evaluation

**Goal:** Run the official Google MCP path side-by-side with the native backend.

Test matrix:

- Gmail
  - search/read thread
  - draft creation
  - label changes
  - send flow comparison
- Drive
  - list/search/read file
  - create file
  - permission reads
- Calendar
  - list events
  - create/update/delete event
  - respond to invite
- People
  - user profile
  - contacts search
  - directory search
- Chat
  - search conversations
  - list messages
- Existing native-only areas
  - Docs operations
  - Sheets operations

Guardian-specific validation:

- approval metadata and blocked-work behavior
- pending-action resume flow
- tool policy/risk classification
- audit logs
- provider routing behavior
- web UI connection state and reconnect flows
- degraded/failure messaging

Exit criteria:

- no regression in Guardian approval/resume invariants
- no silent loss of Docs/Sheets/send coverage
- performance and reliability are acceptable

## Phase 5: Go / No-Go

Use this decision rule:

- **Go to wider adoption** if Google official MCP reaches stable reliability and covers the workflows users actually need
- **Stay hybrid** if Google official MCP is better for Gmail/Drive/Calendar/People/Chat but native remains necessary for Docs/Sheets/send
- **No-go for replacement** if preview instability or missing coverage remains material

Current recommendation:

- **No-go for full replacement today**
- **Go for optional experimental adoption once shared remote MCP support exists**

---

## Proposed Acceptance Criteria For A Future Full Cutover

Do not replace the native backend unless all of the following are true:

- Google official Workspace MCP is no longer preview-only, or preview risk is explicitly accepted
- Docs and Sheets have first-party MCP coverage, or Guardian has a clean long-term hybrid plan
- Gmail send semantics are covered without degraded UX
- Guardian remote MCP support is generic and reusable
- approval, pending-action, and resume behavior match current guarantees
- web UI setup is no more complex than today's native Google connection flow
- harnesses and regression tests are green across the Google workspace flows

---

## Immediate Next Step

If implementation proceeds, the first engineering task should be:

**build generic remote HTTP MCP + OAuth support in the shared MCP control plane**

not:

**replace `src/google/` directly**

That first step is valuable even if Google official MCP never becomes the default, because it unlocks standards-based remote MCP integrations without introducing another custom integration path.
