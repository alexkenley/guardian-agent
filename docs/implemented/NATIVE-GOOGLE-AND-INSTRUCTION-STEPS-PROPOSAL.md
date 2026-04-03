# Proposal: Native Google Integration + LLM Instruction Steps

**Date:** 2026-03-14
**Status:** Draft

---

## Executive Summary

Two independent but synergistic improvements:

1. **Native Google Integration** — replace the external `gws` CLI dependency with direct `googleapis` + `google-auth-library` npm packages. OAuth handled within GuardianAgent (localhost callback, PKCE). Reduces user setup from 7 steps to 3.

2. **LLM Instruction Steps** — add an `instruction` step type to automations/playbooks so the LLM can interpret prior step outputs mid-pipeline. Enables automations like "check my emails and calendar, then create a prioritized task list."

Both features are independently shippable. Instruction steps have no new dependencies and lower risk — recommended as Phase 1.

---

## Part 1: Native Google Integration

### Problem

The current Google Workspace integration requires:

1. Install Node.js globally (if not present)
2. `npm install -g @anthropic/gws` (global CLI)
3. Create OAuth Desktop credentials in Google Cloud Console
4. Download `client_secret.json`
5. Run `gws auth login` in a separate terminal
6. Set `mcp.managedProviders.gws.enabled: true` in config
7. Restart GuardianAgent

This 7-step flow is fragile — users must keep the CLI updated, the CLI manages its own token store, and errors from the subprocess are opaque. The `GWSService` class (`src/runtime/gws-service.ts`) shells out to `gws <service> <resource> <method>` via `child_process`, adding ~200ms latency per call and limiting error handling.

### Solution

Replace the subprocess wrapper with direct Google API calls using `googleapis` (official SDK) and `google-auth-library` (OAuth2 + PKCE). GuardianAgent owns the entire auth lifecycle.

### New User Flow (3 steps)

1. **Create OAuth Desktop credentials** in Google Cloud Console (unavoidable — Google requires it)
2. **Paste or upload `client_secret.json`** in GuardianAgent web UI (Configuration > Integrations > Google Workspace)
3. **Click "Connect Google"** → browser opens for OAuth consent → callback completes → done

The web UI panel guides the user through step 1 with inline instructions and a direct link to the Cloud Console.

### Architecture

#### New Module: `src/google/`

```
src/google/
  types.ts              — GoogleConfig, GoogleAuthState, scope mappings
  google-auth.ts        — OAuth2 PKCE flow, token refresh, encrypted storage
  google-service.ts     — API wrapper (replaces GWSService subprocess calls)
  index.ts              — barrel export
```

#### `google-auth.ts` — OAuth Flow

```typescript
export class GoogleAuth {
  /** Start OAuth flow — returns the authorization URL for the browser. */
  startAuth(scopes: string[]): Promise<{ authUrl: string; state: string }>;

  /** Handle OAuth callback — exchanges code for tokens, stores encrypted. */
  handleCallback(code: string, state: string): Promise<void>;

  /** Get a valid access token, refreshing if needed. */
  getAccessToken(): Promise<string>;

  /** Revoke tokens and clear stored credentials. */
  disconnect(): Promise<void>;

  /** Check if authenticated with valid (or refreshable) tokens. */
  isAuthenticated(): boolean;
}
```

Key design decisions:

- **PKCE** (Proof Key for Code Exchange) — no client secret in the callback, per OAuth 2.0 for Native Apps (RFC 8252)
- **Localhost callback** — ephemeral HTTP server on configurable port (default: `18432`), binds to `127.0.0.1`, auto-closes after callback
- **Token storage** — encrypted at rest in `~/.guardianagent/secrets.enc.json`, key derived from machine-specific entropy (hostname + username + salt). Same pattern as existing credential storage
- **Auto-refresh** — `getAccessToken()` transparently refreshes expired tokens using the refresh token
- **Scope mapping** — each enabled service maps to minimal Google OAuth scopes:

| Service    | Scope                                              |
|------------|---------------------------------------------------|
| `gmail`    | `gmail.modify` (read + send, not full access)     |
| `calendar` | `calendar.events` (read + write events)            |
| `drive`    | `drive.file` (files created/opened by app only)    |
| `docs`     | `documents` (read + write)                         |
| `sheets`   | `spreadsheets` (read + write)                      |
| `contacts` | `contacts.readonly`                                |

Users can enable/disable individual services to control scope grants.

#### `google-service.ts` — API Wrapper

```typescript
export class GoogleService {
  constructor(auth: GoogleAuth, config: GoogleConfig);

  /** Execute a Google Workspace API call (replaces GWSService.execute). */
  async execute(params: GoogleExecuteParams): Promise<GoogleResult>;

  /** Look up API schema (replaces GWSService.schema). */
  async schema(schemaPath: string): Promise<GoogleResult>;

  /** Check if a service is enabled. */
  isServiceEnabled(service: string): boolean;

  /** Get list of enabled services. */
  getEnabledServices(): string[];
}
```

The `execute()` method uses the `googleapis` SDK directly:

```typescript
// Instead of:  execFile('gws', ['gmail', 'users', 'messages', 'list', '--params', json])
// Direct SDK:  google.gmail('v1').users.messages.list({ userId: 'me', ...params })
```

This eliminates subprocess overhead, gives proper error types, and enables streaming for large responses.

#### `GoogleExecuteParams` — Same Shape as `GWSExecuteParams`

The parameter interface mirrors `GWSExecuteParams` (`src/runtime/gws-service.ts:29-48`) so the existing `gws` tool handler requires minimal changes:

```typescript
export interface GoogleExecuteParams {
  service: string;
  resource: string;
  subResource?: string;
  method: string;
  params?: Record<string, unknown>;
  json?: Record<string, unknown>;
  format?: 'json' | 'table' | 'yaml' | 'csv';
  pageAll?: boolean;
  pageLimit?: number;
}
```

### Configuration

New config section under `assistant.tools.google`:

```yaml
assistant:
  tools:
    google:
      enabled: true
      # 'native' uses googleapis directly; 'gws_cli' uses the external CLI (legacy)
      mode: native
      # Which Google services to enable (controls OAuth scope grants)
      services: [gmail, calendar, drive]
      # Localhost port for OAuth callback server
      oauthCallbackPort: 18432
      # Path to client_secret.json (can also be uploaded via web UI)
      credentialsPath: ~/.guardianagent/google-credentials.json
```

Config types added to `src/config/types.ts`:

```typescript
export interface GoogleConfig {
  enabled: boolean;
  mode: 'native' | 'gws_cli';
  services: string[];
  oauthCallbackPort: number;
  credentialsPath: string;
}
```

Default: `{ enabled: false, mode: 'native', services: ['gmail', 'calendar', 'drive'], oauthCallbackPort: 18432, credentialsPath: '~/.guardianagent/google-credentials.json' }`.

### Tool Routing

The existing `gws` tool handler in `src/tools/executor.ts` (~line 9437) checks for `GoogleService` first, falls back to `GWSService`:

```typescript
// In tool handler (pseudo-code):
const googleService = this.options.googleService;
const gwsService = this.options.gwsService;

if (googleService?.isServiceEnabled(service)) {
  result = await googleService.execute({ service, resource, method, params, json });
} else if (gwsService) {
  result = await gwsService.execute({ service, resource, method, params, json });
} else {
  return { success: false, message: 'Google Workspace not configured...' };
}
```

This means the `gws` tool name, parameters, and LLM interface remain identical — no prompt changes needed. The switch is transparent.

### Optional Convenience Tools

Future phase — register dedicated tools for the most common operations:

| Tool Name             | Deferred | Category    | Maps To                                  |
|-----------------------|----------|-------------|------------------------------------------|
| `google_mail_list`    | yes      | `workspace` | `gmail.users.messages.list`              |
| `google_mail_read`    | yes      | `workspace` | `gmail.users.messages.get` (format=full) |
| `google_mail_send`    | yes      | `workspace` | `gmail.users.messages.send`              |
| `google_calendar_list`| yes      | `workspace` | `calendar.events.list`                   |
| `google_drive_list`   | yes      | `workspace` | `drive.files.list`                       |

These are thin wrappers with simpler parameter schemas — easier for the LLM to call correctly. They all route through `GoogleService.execute()` internally. Deferred-loaded (discovered via `find_tools`).

### Web API Endpoints

```
POST   /api/google/credentials     — Upload client_secret.json
GET    /api/google/auth/start      — Begin OAuth flow, returns { authUrl }
GET    /api/google/auth/callback   — OAuth callback (redirect from Google)
POST   /api/google/disconnect      — Revoke tokens, clear stored credentials
GET    /api/google/status          — Auth state, enabled services, token expiry
```

All endpoints require the existing bearer token auth.

### Web UI Changes

Replace the current `createGoogleWorkspacePanel()` in `web/public/js/pages/config.js` (~line 3705). Current panel shows static CLI instructions. New panel:

1. **Status indicator** — Connected / Not Connected / Expired
2. **Credential upload** — file picker or paste JSON, with inline Cloud Console instructions
3. **Service toggles** — checkboxes for each Google service (gmail, calendar, drive, etc.)
4. **Connect/Disconnect button** — starts OAuth flow or revokes access
5. **Mode selector** — Native (recommended) / CLI (legacy) for power users

### Security Model

| Concern | Control |
|---------|---------|
| Token storage | Encrypted at rest (`secrets.enc.json`), key from machine entropy |
| Token in memory | Never logged, cleared on disconnect |
| Secret scanning | `client_secret`, `access_token`, `refresh_token` patterns already in `SecretScanController` |
| API call audit | All Google API calls logged to audit log with service/method/resource |
| Scope minimization | Only requested scopes granted; each service maps to narrowest scope |
| SSRF | Google API calls go to `*.googleapis.com` — not subject to SSRF private-IP blocking |
| Guardian gating | `gws` tool still passes through full Guardian pipeline (capability check, policy, approval) |
| OAuth state | PKCE + `state` parameter prevent CSRF in callback |
| Callback server | Binds `127.0.0.1` only, closes immediately after receiving callback |

### Migration Path

- Existing `gws_cli` users: set `mode: gws_cli` to keep current behavior. `GWSService` is not removed.
- New users: default `mode: native` — no CLI install needed.
- Config migration: when `mcp.managedProviders.gws.enabled` is true but `assistant.tools.google.enabled` is false, show a migration prompt in the web UI suggesting the native path.
- The `gws` and `gws_schema` tool names are unchanged — LLM prompts and automation steps continue to work regardless of backend mode.

### Dependencies

| Package | Version | Size | Purpose |
|---------|---------|------|---------|
| `googleapis` | `^144.0.0` | ~2.5MB | Google API client (tree-shakeable per service) |
| `google-auth-library` | `^9.0.0` | ~200KB | OAuth2, PKCE, token refresh |

Both are official Google packages, widely used, actively maintained.

---

## Part 2: LLM Instruction Steps in Automations

### Problem

The current automation/playbook system (`src/runtime/connectors.ts`) only supports **tool-call steps**. Each step executes a registered tool with fixed arguments:

```typescript
// Current: AssistantConnectorPlaybookStepDefinition (src/config/types.ts:742)
{
  id: string;
  name?: string;
  packId: string;
  toolName: string;       // ← must be a registered tool
  args?: Record<string, unknown>;
  continueOnError?: boolean;
  timeoutMs?: number;
}
```

This means users **cannot** create automations that require LLM interpretation of intermediate results. For example, "every morning, check my emails and calendar, then create a prioritized task list" requires an LLM to read the outputs of steps 1 and 2 and synthesize step 3 — but there's no step type for "ask the LLM to process this."

### Solution

Add a new step type: `instruction`. An instruction step sends a natural language prompt to the LLM with accumulated prior step outputs as context. The LLM generates a text response (no tool calling) which becomes the step's output for downstream steps.

### Type Changes

Extend `AssistantConnectorPlaybookStepDefinition` in `src/config/types.ts`:

```typescript
export interface AssistantConnectorPlaybookStepDefinition {
  id: string;
  name?: string;
  /** Step type: 'tool' executes a registered tool, 'instruction' invokes the LLM. Default: 'tool'. */
  type?: 'tool' | 'instruction';

  // Tool step fields (required when type is 'tool' or omitted):
  packId: string;
  toolName: string;
  args?: Record<string, unknown>;

  // Instruction step fields (required when type is 'instruction'):
  /** Natural language prompt for the LLM. Prior step outputs injected as context. */
  instruction?: string;
  /** LLM provider override for this step (e.g. 'anthropic', 'ollama'). Falls back to default. */
  llmProvider?: string;
  /** Max tokens for the LLM response. Default: 2048. */
  maxTokens?: number;

  // Shared fields:
  continueOnError?: boolean;
  timeoutMs?: number;
}
```

The `type` field defaults to `'tool'` for backward compatibility — all existing playbooks work unchanged.

### Execution Changes

In `ConnectorPlaybookService.executeStep()` (`src/runtime/connectors.ts:378`), branch on step type:

```typescript
private async executeStep(
  step: AssistantConnectorPlaybookStepDefinition,
  input: ConnectorPlaybookRunInput,
  priorResults?: PlaybookStepRunResult[],  // ← new parameter
): Promise<PlaybookStepRunResult> {
  if (step.type === 'instruction') {
    return this.executeInstructionStep(step, input, priorResults ?? []);
  }
  // ... existing tool step logic unchanged ...
}
```

New method:

```typescript
private async executeInstructionStep(
  step: AssistantConnectorPlaybookStepDefinition,
  input: ConnectorPlaybookRunInput,
  priorResults: PlaybookStepRunResult[],
): Promise<PlaybookStepRunResult> {
  const startedAt = this.now();

  if (!step.instruction?.trim()) {
    return {
      stepId: step.id, toolName: '_instruction', packId: '',
      status: 'failed',
      message: 'Instruction step has no instruction text.',
      durationMs: this.now() - startedAt,
    };
  }

  // Build context from prior step outputs
  const context = priorResults
    .filter(r => r.output != null)
    .map(r => `### Step "${r.stepId}" (${r.toolName}) — ${r.status}\n${formatOutput(r.output)}`)
    .join('\n\n');

  const prompt = [
    'You are processing an automation pipeline step.',
    'Below are the outputs from prior steps in this automation:\n',
    context || '(no prior step outputs)',
    '\n---\n',
    'Your instruction for this step:\n',
    step.instruction,
    '\n\nRespond with the requested output only. Do not explain the automation or reference these instructions.',
  ].join('\n');

  try {
    const response = await withTimeout(
      this.runInstruction(prompt, step.llmProvider, step.maxTokens),
      step.timeoutMs ?? this.config.playbooks.defaultStepTimeoutMs,
    );

    // Scan response through OutputGuardian before storing
    const scanned = await this.scanOutput(response);

    return {
      stepId: step.id,
      toolName: '_instruction',
      packId: '',
      status: 'succeeded',
      message: 'Instruction completed.',
      durationMs: this.now() - startedAt,
      output: scanned,
    };
  } catch (err) {
    return {
      stepId: step.id,
      toolName: '_instruction',
      packId: '',
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
      durationMs: this.now() - startedAt,
    };
  }
}
```

#### Prior Results Threading

The `runSequential` and `runParallel` methods need to pass accumulated results to each step:

```typescript
// Sequential: each step sees all prior results
private async runSequential(steps, input): Promise<PlaybookStepRunResult[]> {
  const results: PlaybookStepRunResult[] = [];
  for (const step of steps) {
    const result = await this.executeStep(step, input, results);
    results.push(result);
    // ... existing early-exit logic for failures/approvals ...
  }
  return results;
}

// Parallel: instruction steps in a parallel batch see results from prior batches only
// (not from sibling parallel steps — those haven't completed yet)
```

#### `runInstruction` Closure

The `ConnectorPlaybookService` constructor receives a `runInstruction` function, injected from the bootstrap (`src/index.ts`):

```typescript
type RunInstructionFn = (
  prompt: string,
  provider?: string,
  maxTokens?: number,
) => Promise<string>;
```

At bootstrap, this closure calls the appropriate `LLMProvider.chat()` with:
- An empty `tools` array (instruction steps are text-only — no tool calls)
- The system prompt stripped to a minimal instruction preamble
- Temperature 0.3 for deterministic automation outputs

#### `scanOutput` Integration

Instruction step outputs pass through `OutputGuardian.scanResponse()` before being stored in the step result. This catches:
- Secrets/PII that the LLM might echo from prior step outputs
- Prompt injection attempts embedded in prior tool outputs that the LLM might propagate

### Security Model

| Concern | Control |
|---------|---------|
| Tool calling from instructions | Blocked — LLM called with empty tools array |
| Secrets in LLM output | OutputGuardian scans response before storage |
| Prompt injection via tool outputs | Prior step outputs injected as data, not as system instructions. OutputGuardian prompt-injection hardening applies. |
| Approval | No approval required — instruction steps are read-only text generation. The _tool steps_ that feed them already went through approval. |
| Cost/rate limiting | Instruction steps consume LLM tokens — counted in BudgetTracker. Rate limiter applies per the provider. |
| Audit | Instruction step execution logged to audit log with `toolName: '_instruction'`, instruction text, and provider used |

### Step Result Changes

`PlaybookStepRunResult` already has `output?: unknown` which carries the instruction text. The `toolName` field is set to `'_instruction'` for instruction steps (a reserved name that cannot conflict with real tools since tool names cannot start with `_`).

### Web UI Changes

In `web/public/js/pages/automations.js`, the step builder area (~line 720) adds a "Step Type" selector:

```html
<div class="cfg-field">
  <label>Step Type</label>
  <select id="auto-step-type">
    <option value="tool" selected>Tool</option>
    <option value="instruction">Instruction (LLM)</option>
  </select>
</div>
```

When "Instruction" is selected:
- The tool name dropdown is hidden
- A textarea appears for the instruction text
- Optional fields: LLM provider selector, max tokens input
- The step renders in the step list with an LLM icon instead of a tool icon

### System Prompt Update

Add to the "Automations:" section in `src/prompts/guardian-core.ts`:

```
Instruction steps: When creating multi-step automations, you can use 'instruction' steps
to have the LLM interpret prior step outputs. Set type: 'instruction' and provide the
instruction text. Example: after fetching emails and calendar, add an instruction step
"Create a prioritized task list from the emails and calendar events above."
```

### Example Automations

**Morning Briefing:**
```json
{
  "id": "morning-briefing",
  "name": "Morning Briefing",
  "mode": "sequential",
  "schedule": "0 8 * * 1-5",
  "steps": [
    {
      "id": "emails",
      "type": "tool",
      "toolName": "gws",
      "packId": "",
      "args": { "service": "gmail", "resource": "users messages", "method": "list", "params": { "userId": "me", "maxResults": 20, "q": "is:unread" } }
    },
    {
      "id": "calendar",
      "type": "tool",
      "toolName": "gws",
      "packId": "",
      "args": { "service": "calendar", "resource": "events", "method": "list", "params": { "calendarId": "primary", "timeMin": "today", "timeMax": "tomorrow" } }
    },
    {
      "id": "summarize",
      "type": "instruction",
      "instruction": "Based on the unread emails and today's calendar events, create a prioritized task list. Group by urgency: Critical (needs response before first meeting), Important (today), and FYI (can wait).",
      "maxTokens": 1024
    },
    {
      "id": "send",
      "type": "tool",
      "toolName": "gws",
      "packId": "",
      "args": { "service": "gmail", "resource": "users messages", "method": "send", "params": { "userId": "me" }, "json": { "to": "me", "subject": "Morning Briefing — {{date}}", "body": "{{steps.summarize.output}}" } }
    }
  ]
}
```

**Weekly Security Digest:**
```json
{
  "id": "weekly-security-digest",
  "name": "Weekly Security Digest",
  "mode": "sequential",
  "schedule": "0 9 * * 1",
  "steps": [
    {
      "id": "scan",
      "type": "tool",
      "toolName": "net_arp_scan",
      "packId": "",
      "args": {}
    },
    {
      "id": "threats",
      "type": "tool",
      "toolName": "intel_scan",
      "packId": "",
      "args": {}
    },
    {
      "id": "analyze",
      "type": "instruction",
      "instruction": "Analyze the network scan and threat intel results. Identify: (1) any new devices on the network, (2) devices with open high-risk ports, (3) any threat findings that need attention. Format as a concise weekly security report.",
      "maxTokens": 2048
    }
  ]
}
```

### Template Substitution (Future Enhancement)

The `{{steps.summarize.output}}` syntax in the morning briefing example represents a potential future enhancement — template substitution in tool step args. This is **not required for Phase 1**. In Phase 1, instruction steps consume prior outputs implicitly (they're injected as context). For tool steps that need to use instruction output (like the email send), the user would create a two-part automation or use the LLM conversationally.

---

## Implementation Phases

### Phase 1: LLM Instruction Steps

**Scope:** 5 files, 0 new dependencies, low risk.

| File | Change |
|------|--------|
| `src/config/types.ts` | Add `type`, `instruction`, `llmProvider`, `maxTokens` fields to `AssistantConnectorPlaybookStepDefinition` |
| `src/runtime/connectors.ts` | Add `executeInstructionStep()`, thread `priorResults` through `runSequential`/`runParallel`, accept `runInstruction` closure |
| `src/index.ts` | Wire `runInstruction` closure into `ConnectorPlaybookService` constructor |
| `src/prompts/guardian-core.ts` | Add instruction step guidance to automations section |
| `web/public/js/pages/automations.js` | Step type selector, instruction textarea, conditional field visibility |

Tests: add instruction step execution tests to `src/runtime/connectors.test.ts`.

### Phase 2: Native Google Service

**Scope:** 4 new files, 2 new dependencies, moderate risk.

| File | Change |
|------|--------|
| `src/google/types.ts` | New — `GoogleConfig`, `GoogleAuthState`, scope mappings |
| `src/google/google-auth.ts` | New — OAuth2 PKCE flow, token storage, refresh |
| `src/google/google-service.ts` | New — API wrapper, replaces subprocess calls |
| `src/google/index.ts` | New — barrel export |
| `src/config/types.ts` | Add `GoogleConfig` to `AssistantToolsConfig` |
| `src/tools/executor.ts` | Add `googleService` option, routing in `gws` tool handler |
| `src/index.ts` | Bootstrap `GoogleAuth` + `GoogleService`, wire into executor, add API routes |
| `web/public/js/pages/config.js` | Redesign Google Workspace panel with auth flow |
| `package.json` | Add `googleapis`, `google-auth-library` dependencies |

Tests: `src/google/google-auth.test.ts`, `src/google/google-service.test.ts` (mock HTTP).

### Phase 3: Web UI Polish + Migration

**Scope:** 2 files, 0 new dependencies, low risk.

| File | Change |
|------|--------|
| `web/public/js/pages/config.js` | Migration prompt for gws_cli users, inline Cloud Console guide |
| `src/reference-guide.ts` | Update Google Workspace and Automations sections |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Google OAuth complexity (consent screen verification) | Medium | High | Document that unverified apps show a warning screen — acceptable for personal/self-hosted use. Provide clear instructions. |
| `googleapis` package size bloat | Low | Medium | Tree-shake by importing per-service (`googleapis/build/src/apis/gmail` not the whole package). Monitor bundle size. |
| Instruction steps producing low-quality output | Medium | Low | Default to external provider for instruction steps if available. Allow per-step `llmProvider` override. Quality is iterative. |
| Instruction steps leaking secrets from prior tool outputs | Low | High | OutputGuardian scans all instruction outputs before storage. Prior outputs are data-injected, not system-prompt-injected. |
| Breaking existing `gws` tool behavior | Low | High | `mode: gws_cli` preserves exact current behavior. Default `mode: native` only activates when credentials are configured. Transparent fallback. |

---

## Non-Goals

- **Google service account / API key auth** — out of scope. OAuth Desktop flow only (matches personal assistant use case).
- **Multi-account Google support** — single authenticated user per GuardianAgent instance (matches existing `accountMode: 'single_user'` in config).
- **Instruction steps with tool access** — instruction steps are text-only. If tool calling is needed, use a tool step.
- **Template substitution in tool args** — `{{steps.X.output}}` syntax is a future enhancement, not part of this proposal.
- **Google Admin / Enterprise APIs** — scope limited to Gmail, Calendar, Drive, Docs, Sheets, Contacts.

---

## Decision Points

1. **Should instruction steps support streaming?** Recommendation: No for Phase 1. Automation steps run in the background — streaming adds complexity with no user-facing benefit.

2. **Should the Google OAuth callback port be configurable?** Yes — some users may have port conflicts. Default `18432` chosen to avoid common port ranges.

3. **Should instruction steps count toward the `maxSteps` limit?** Yes — they're steps like any other. The limit exists to prevent runaway automations.

4. **Should we import `googleapis` as a whole or per-service?** Per-service imports to minimize memory footprint. The `googleapis` package supports this natively.
