# Google Workspace Integration Specification

**Status:** Implemented
**Depends on:** MCP Client, Native Skills, ToolExecutor policy model, Guardian capabilities
**Primary External Runtime:** Google Workspace CLI (`gws`) via managed MCP mode

---

## Overview

GuardianAgent integrates with Google Workspace (Gmail, Calendar, Drive, Docs, Sheets) through the **Google Workspace CLI** (`@googleworkspace/cli`) running as a managed MCP server.

The architecture:

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

## Installation and Setup

The GWS CLI is **not bundled** with Guardian Agent. Users must install it separately and complete Google OAuth setup before it can be used.

### Prerequisites

- Node.js >= 20
- A Google account
- A Google Cloud project with OAuth 2.0 credentials

### Step 1 — Install the CLI

```bash
npm install -g @googleworkspace/cli
```

### Step 2 — Configure OAuth Credentials

Users need a Google Cloud project with an OAuth 2.0 Desktop client. Two paths:

**Option A — Automatic (requires Google Cloud CLI)**

1. Install the [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk)
2. Run `gcloud auth login`
3. Run `gws auth setup` — this auto-creates the OAuth client and consent screen

**Option B — Manual (no gcloud needed)**

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project if needed (top-left project selector > New Project)
3. Go to **Google Auth Platform > Audience** (left sidebar)
   - Set user type to **External**
   - Fill in app name (e.g. "Guardian Agent") and your email
   - Save
4. On the Audience page, under **Publishing status**, click **Publish App**
   - Without this, only manually-added test users can authenticate
   - Users will see "access_denied" errors during OAuth consent if the app is still in Testing mode
   - Publishing is safe — the OAuth credentials are only usable on the user's machine
5. Go to **Credentials** (left sidebar) > **+ Create Credentials** > **OAuth client ID**
   - Set Application type to **Desktop app** (not "Web application")
   - No redirect URIs or JavaScript origins needed
   - Give it any name and click Create
6. Download the client secret JSON from the confirmation dialog
7. Save as `~/.config/gws/client_secret.json` (Windows: `%USERPROFILE%\.config\gws\client_secret.json`)
   - Create the `.config/gws` folder if it doesn't exist

### Step 3 — Authenticate

```bash
gws auth login
```

A browser window opens for Google OAuth consent. After approval, credentials are stored in the OS keyring.

**Troubleshooting:** If you see "access_denied" or "app not verified", go back to Google Auth Platform > Audience and either click Publish App or add your email address under Test Users.

### Step 4 — Enable in Guardian Agent

In the web UI: **Settings > Google Workspace** — select services and click **Enable Google Workspace**. Restart Guardian Agent for the MCP server to start.

Or manually in `~/.guardianagent/config.yaml`:

```yaml
assistant:
  tools:
    mcp:
      enabled: true
      managedProviders:
        gws:
          enabled: true
          services:
            - gmail
            - calendar
            - drive
```

### Verification

- **Web UI:** Settings > Google Workspace should show CLI Installed, Auth Connected, Provider Enabled
- **CLI:** `/google status` shows connection state
- **Test Connection:** The web UI Settings panel has a Test Connection button that probes CLI availability and auth status

---

## Managed Provider Model

GuardianAgent supports a first-class managed MCP provider entry for Google Workspace rather than forcing users to hand-author a raw MCP server block.

### Config

```yaml
assistant:
  tools:
    mcp:
      enabled: true
      managedProviders:
        gws:
          enabled: true
          command: gws          # optional, defaults to 'gws' from PATH
          services:
            - gmail
            - calendar
            - drive
          exposeSkills: true
          accountMode: single_user
          model: openai         # optional, explicit LLM for tool-calling
```

GuardianAgent translates this into an internal MCP server definition (`gws mcp -s gmail,calendar,drive`) and registers it with the MCP client manager.

### Runtime Behavior

- `probeGwsCli()` checks CLI availability and auth status using `gws --version` and `gws auth status`
- All `gws` subprocess calls use `shell: process.platform === 'win32'` for Windows `.cmd` compatibility without breaking JSON param quoting on Unix
- The `command` field allows users to specify a custom path if `gws` is not on PATH
- Config updates (enable/disable, services, command) are persisted via `POST /api/config` and require a restart

### GWSService (`src/runtime/gws-service.ts`)

Subprocess wrapper for the `gws` CLI. Key interface:

- `execute(params)` — runs `gws <service> <resource> <method> [flags]` and parses JSON output
- `schema(path)` — looks up API schema for a service method
- `authStatus()` — checks auth status via `gws auth status`
- `isServiceEnabled(service)` / `getEnabledServices()` — service allowlist queries

Configuration: `command` (default `'gws'`), `timeoutMs` (default 30s), `services` (default `['gmail', 'calendar', 'drive', 'docs', 'sheets']`). Max output buffer: 512 KB.

### Web UI Integration

The Settings > Google Workspace panel has three states:

1. **Not installed** — Full setup guide with both automatic and manual OAuth paths
2. **Installed, not authenticated** — Compact instructions for OAuth setup and `gws auth login`
3. **Authenticated** — Status display (CLI version, auth method, services, provider state) with Enable button if provider is disabled

The Enable button saves `gws.enabled: true` and selected services directly to config via the API — no manual YAML editing required.

### CLI Integration

- `/google status` — Shows installed/version, authenticated, provider enabled, services
- Authentication and logout must be done directly via `gws auth login` / `gws auth logout` in a terminal (OAuth requires an interactive browser flow)

---

## LLM Provider Routing for Tool-Calling

Google Workspace operations require structured tool calls (function calling). Local models like Ollama often struggle with complex tool schemas, so GuardianAgent routes GWS-related messages to an external LLM when available.

### Dynamic Provider Resolution

The `resolveGwsProvider` closure (`src/index.ts`) re-evaluates at each request so providers added via the web UI (hot reload) are picked up without restart. Resolution order:

1. **Explicit model** — if `managedProviders.gws.model` is set and the named provider exists, use it
2. **Auto-detect** — if the default provider is Ollama, scan `config.llm` for the first non-Ollama provider and use it
3. **Default provider** — if the default is already an external LLM (OpenAI/Anthropic), use it directly

If no external provider is found (only Ollama configured), the resolver returns `undefined` and the request goes through `chatWithFallback()` with its full fallback chain instead.

### Message Routing

When `onMessage` receives a user message, it checks:

1. Is the `gws` managed provider enabled? (`enabledManagedProviders.has('gws')`)
2. Does the message match workspace keywords? (`gmail|email|inbox|calendar|schedule|event|drive|docs|sheets|spreadsheet|google`)

If both are true, `resolveGwsProvider()` is called. If a provider is returned, it handles the tool-calling loop directly. If `undefined`, `chatWithFallback` is used (primary LLM + fallback chain).

### Error Handling

The GWS provider `chatFn` wraps `gwsProvider.chat()` in a try/catch. If the external LLM throws (API error, timeout, rate limit), the error is logged and the request falls back to `chatWithFallback()` gracefully instead of propagating an unhandled error.

```
gwsProvider.chat() → success → return response
                   → error   → log warning → chatWithFallback()
no gwsProvider     →           → chatWithFallback()
```

### Key Invariant

The resolver **never returns an Ollama provider**. When only Ollama is configured:
- The resolver returns `undefined`
- `chatWithFallback` is used, which tries `ctx.llm` (Ollama) then the `ModelFallbackChain`
- This preserves the same behavior as before the dynamic resolver refactor

---

## Service Scope

### Default Scope

- Gmail
- Calendar
- Drive

### Additional (user-selectable)

- Docs
- Sheets

### Later / Optional

- Chat
- Admin APIs
- Meet
- Groups

Services are opt-in via the `services` array and exposed through the web UI service checkboxes.

---

## Skill Packs

Native skills accompany the managed provider.

Implemented:

- `google-gmail-assistant`
- `google-calendar-assistant`
- `google-drive-assistant`
- `google-docs-sheets-assistant`

Each skill:

- explains safe usage patterns
- points to the relevant MCP tools
- clarifies approval expectations
- guides drafting before sending or mutating

Skills are auto-exposed when `exposeSkills: true` (default) and the GWS provider is enabled. They report readiness through the skills CLI/API surfaces based on whether the required managed provider is active.

---

## Capability Model

### Email Capabilities

- `read_email`
- `draft_email`
- `send_email`

### Workspace Capabilities

- `read_calendar` / `write_calendar`
- `read_drive` / `write_drive`
- `read_docs` / `write_docs`
- `read_sheets` / `write_sheets`

This lets GuardianAgent enforce least privilege at the agent level rather than collapsing all Google operations into `network_access`.

---

## Tool Policy

Google Workspace tools use existing ToolExecutor policy decisions:

- `read_only`
- `mutating`
- `external_post`

### Examples

- Gmail draft/list/read = `read_only` or `mutating` depending on action
- Gmail send = `external_post`
- Calendar create/update = `mutating`
- Drive list/read metadata = `read_only`
- Docs/Sheets edits = `mutating`

Default behavior:

- Read-only Google actions may run under policy
- Mutating actions should usually require approval in `approve_by_policy`
- External send/post actions always remain manual approval

Coverage depends on tool-name/description inference from the MCP provider surface.

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

- `gws` manages OAuth tokens via OS keyring — GuardianAgent never stores or passes raw tokens
- OAuth authentication requires an interactive browser flow and cannot be initiated from the web UI or headlessly
- The `client_secret.json` is stored in the user's home directory, not in the project

---

## Chat Workflow

The assistant should prefer workflows like:

1. draft
2. summarize proposed action
3. request approval if mutating or external
4. execute via MCP tool

---

## Rollout Status

### Implemented

- Managed `gws` MCP provider materialization
- Gmail / Calendar / Drive / Docs / Sheets service scope
- Native Google skills with auto-exposure
- Capability enforcement hooks for all managed tools
- Web UI setup guide with detailed OAuth walkthrough
- Web UI enable/disable with service picker (no YAML editing required)
- CLI `/google status` command
- `probeGwsCli()` connectivity test via web API
- Config persistence for `gws.enabled`, `gws.services`, `gws.command` via `POST /api/config`
- Dynamic `resolveGwsProvider` with hot-reload support
- GWS provider error handling with graceful fallback to `chatWithFallback`
- Ollama exclusion from GWS provider resolution (prevents silent tool-call failures)

### Removed

- Bundled `@googleworkspace/cli` dependency (was `^0.7.0` in package.json)
- `scripts/ensure-gws.mjs` auto-provisioning script
- Web UI login/logout buttons (OAuth is terminal-only)
- `/api/gws/login` and `/api/gws/logout` endpoints
- CLI `/google login` and `/google logout` commands
- Static `gwsLlmProvider` variable (replaced by dynamic `resolveGwsProvider` closure)

### Future

- Multi-account selection
- Admin APIs with stricter gating
- Provider health checks and enhanced audit correlation
- Richer provider-specific diagnostics

---

## Relationship to Existing Gmail Tools

Current built-in Gmail send flows may remain temporarily for backwards compatibility, but the long-term direction favors:

- managed `gws` MCP tools for broad Workspace coverage
- native skills for procedure
- Guardian policy for safety

This keeps Google integration consistent with the broader `skills + MCP` architecture rather than growing a parallel bespoke subsystem.
