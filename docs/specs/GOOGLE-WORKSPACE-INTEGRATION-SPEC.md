# Google Workspace Integration Specification

**Status:** Implemented foundation
**Depends on:** MCP Client, Native Skills, ToolExecutor policy model, Guardian capabilities
**Primary External Runtime:** Google Workspace CLI (`gws`) via managed MCP mode

---

## Overview

GuardianAgent includes a **managed MCP provider** foundation for Google Workspace built around the Google Workspace CLI (`gws`).

The recommended architecture is:

- `gws mcp` provides typed tool execution for Google Workspace APIs
- Native GuardianAgent skills provide procedural guidance for Gmail, Calendar, Drive, Docs, and Sheets
- GuardianAgent remains the policy, approval, audit, and sandbox boundary

This avoids two bad extremes:

- building bespoke Google API support one endpoint at a time
- giving the model unrestricted shell access to a broad Google CLI

---

## Goals

- Expand Google Workspace coverage beyond the current Gmail-send-only path.
- Preserve Guardian policy enforcement and approval workflows.
- Support a curated subset of Google services first.
- Reuse native skills to teach the model safe and effective Google workflows.

## Non-Goals

- Raw unrestricted `gws` shell access for agents.
- Exposing every Google API by default.
- Replacing built-in email workflows on day one.
- Managing privileged Windows network controls for Google tools.

---

## Architecture

```text
GuardianAgent Chat / Runtime
        |
        v
  SkillResolver
        |
        v
  ToolExecutor + Guardian
        |
        v
  MCPClientManager
        |
        v
   managed provider: gws
        |
        v
      gws mcp
        |
        v
 Google Workspace APIs
```

### Key Principle

`gws` is an execution backend, not a trust boundary.

All Google actions must still pass through:

- capability checks
- tool policy
- approval workflows
- audit logging
- sandbox process controls

---

## Managed Provider Model

GuardianAgent supports a first-class managed MCP provider entry for Google Workspace rather than forcing users to hand-author a raw MCP server block.

### Current Config

```yaml
assistant:
  tools:
    mcp:
      enabled: true
      managedProviders:
        gws:
          enabled: true
          command: gws
          services:
            - gmail
            - calendar
            - drive
          exposeSkills: true
          accountMode: single_user
```

GuardianAgent translates this into an internal MCP server definition and registers it with the existing MCP client manager.

---

## Initial Service Scope

### Implemented Default Scope

- Gmail
- Calendar
- Drive

### Next Scope

- Docs
- Sheets
- Chat

### Later / Optional

- Admin APIs
- Meet
- Groups

Services should be opt-in and exposed through explicit allowlists.

---

## Skill Packs

Native skills accompany the managed provider.

Examples:

- `google-gmail-assistant`
- `google-calendar-assistant`
- `google-drive-assistant`
- `google-docs-sheets-assistant`

Each skill should:

- explain safe usage patterns
- point to the relevant MCP tools
- clarify approval expectations
- guide drafting before sending or mutating

These skills are especially useful for:

- draft-first email workflows
- event planning with review steps
- structured file retrieval and summarization
- safe document update flows

---

## Capability Model

The current email capability set is still too coarse for broad Google Workspace support.

### Existing

- `read_email`
- `draft_email`
- `send_email`

### Implemented Hooks / Additions

- `read_calendar`
- `write_calendar`
- `read_drive`
- `write_drive`
- `read_docs`
- `write_docs`
- `read_sheets`
- `write_sheets`

This lets GuardianAgent enforce least privilege at the agent level rather than collapsing all Google operations into `network_access`.

---

## Tool Policy

Google Workspace tools should still use existing ToolExecutor decisions:

- `read_only`
- `mutating`
- `external_post`

### Examples

- Gmail draft/list/read = `read_only` or `mutating` depending on action
- Gmail send = `external_post`
- Calendar create/update = `mutating`
- Drive list/read metadata = `read_only`
- Docs/Sheets edits = `mutating`

Default expectation:

- read-only Google actions may run under policy
- mutating actions should usually require approval in `approve_by_policy`
- external send/post actions always remain manual approval

### Current Limitation

The managed provider foundation and capability hooks are implemented, but coverage still depends on tool-name/description inference from the provider surface. Richer provider-specific diagnostics and broader service rollout are still follow-up work.

---

## Security Model

### Risks Addressed

- over-broad Google API exposure
- credential mishandling
- external side effects without review
- dynamic tool surface drift

### Controls

- service allowlist at config level
- per-tool approval policy
- narrow capabilities per service
- native skills are guidance only
- audit trail for every action
- managed provider status surfaced in web/CLI

### Credential Handling

Preferred approach:

- rely on `gws` OS keyring-backed credential handling where available
- do not pass raw OAuth tokens through normal chat args unless a specific tool path still requires it
- avoid storing Workspace credentials in skill bundles or static config where possible

---

## UX

### Web / CLI

Expose:

- provider enabled/disabled state
- allowed Google services
- connected account summary if available from provider status
- linked Google skills

Current implementation already surfaces managed-provider-driven tools through the normal tool catalog. Richer provider-specific status is still follow-up work.
Google-linked skills also report whether their required managed provider is currently ready through the skills CLI/API surfaces.

### Chat

The assistant should prefer workflows like:

1. draft
2. summarize proposed action
3. request approval if mutating or external
4. execute via MCP tool

---

## Rollout Plan

### Implemented

- Managed `gws` MCP provider materialization
- Gmail / Calendar / Drive default service scope
- Native Google skills
- optional skill exposure when the provider is enabled
- capability enforcement hooks for Gmail / Calendar / Drive / Docs / Sheets managed tools

### Next

- Docs / Sheets
- better provider status and diagnostics
- richer review flows and templates

### Later

- multi-account selection
- Admin APIs with stricter gating
- provider health checks and enhanced audit correlation

---

## Relationship to Existing Gmail Tools

Current built-in Gmail send flows may remain temporarily for backwards compatibility, but the long-term direction should favor:

- managed `gws` MCP tools for broad Workspace coverage
- native skills for procedure
- Guardian policy for safety

This keeps Google integration consistent with the broader `skills + MCP` architecture rather than growing a parallel bespoke subsystem.
