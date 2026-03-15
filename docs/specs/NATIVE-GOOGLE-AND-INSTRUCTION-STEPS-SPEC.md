# Spec: Native Google Integration + LLM Instruction Steps

**Date:** 2026-03-14
**Status:** Implementation
**Proposal:** [`docs/proposals/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-PROPOSAL.md`](../proposals/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-PROPOSAL.md)

---

## Overview

Two independent features shipped in phases:

1. **LLM Instruction Steps** (Phase 1a) — new `instruction` step type in automations/playbooks. Invokes the LLM with prior step outputs as context, enabling pipelines that interpret intermediate results.
2. **Delay Steps** (Phase 1b) — new `delay` step type that pauses a sequential pipeline for a specified duration. Useful for rate-limiting, cooldown periods, or waiting for external state to settle between tool steps.
3. **Native Google Integration** (Phase 2) — replace the `gws` CLI subprocess wrapper with direct `googleapis` + `google-auth-library` SDK calls. OAuth PKCE handled within GuardianAgent.

---

## Phase 1: LLM Instruction Steps + Delay Steps

### Type Changes (`src/config/types.ts`)

Extend `AssistantConnectorPlaybookStepDefinition`:

```typescript
export interface AssistantConnectorPlaybookStepDefinition {
  id: string;
  name?: string;
  type?: 'tool' | 'instruction' | 'delay';    // default: 'tool'
  // Tool step fields:
  packId: string;
  toolName: string;
  args?: Record<string, unknown>;
  // Instruction step fields:
  instruction?: string;
  llmProvider?: string;
  maxTokens?: number;
  // Delay step fields:
  delayMs?: number;
  // Shared:
  continueOnError?: boolean;
  timeoutMs?: number;
}
```

### Runtime Changes (`src/runtime/connectors.ts`)

1. **New constructor option**: `runInstruction?: RunInstructionFn`

```typescript
type RunInstructionFn = (
  prompt: string,
  provider?: string,
  maxTokens?: number,
) => Promise<string>;
```

2. **`executeStep()` branches** on `step.type`:
   - `'instruction'` → `executeInstructionStep(step, input, priorResults)`
   - `'delay'` → `executeDelayStep(step)`
   - `'tool'` (or omitted) → existing tool execution path

3. **Prior results threading**: `runSequential()` passes accumulated `results` array to each `executeStep()` call. `runParallel()` does not pass prior results (parallel steps cannot depend on siblings).

4. **`executeInstructionStep()`**: Builds a prompt from `step.instruction` + formatted prior step outputs, calls `runInstruction()`, returns result with `toolName: '_instruction'`.

5. **`executeDelayStep()`**: Validates `delayMs > 0`, auto-sets `timeoutMs` to `delayMs + 5000` to prevent the step from being killed by the watchdog during the pause, sleeps for the specified duration, and returns result with `toolName: '_delay'`. Only meaningful in sequential mode (parallel steps run concurrently, so a delay step would just block one lane without affecting sibling steps).

6. **Dry run behavior**: Instruction steps in dry-run mode return a synthetic success without calling the LLM. Delay steps in dry-run mode return a synthetic success without sleeping.

### Step Result Shape

```typescript
// Instruction step result:
{
  stepId: 'summarize',
  toolName: '_instruction',    // reserved name
  packId: '',
  status: 'succeeded',
  message: 'Instruction completed.',
  durationMs: 1234,
  output: 'The LLM response text...',
}

// Delay step result:
{
  stepId: 'cooldown',
  toolName: '_delay',          // reserved name
  packId: '',
  status: 'succeeded',
  message: 'Delayed 5000ms.',
  durationMs: 5003,
  output: '',
}
```

### Bootstrap Wiring (`src/index.ts`)

The `ConnectorPlaybookService` constructor receives a `runInstruction` closure that:
- Resolves the LLM provider (named or default)
- Calls `provider.chat()` with empty tools array
- Returns the text response

### System Prompt (`src/prompts/guardian-core.ts`)

Automations section updated to document instruction steps and provide usage guidance.

### Web UI (`web/public/js/pages/automations.js`)

Pipeline step builder gets:
- Step type toggle: "Tool" / "Instruction (LLM)" / "Delay"
- Conditional visibility: tool selector vs instruction textarea vs delay input
- Tool picker with Browse button showing tool descriptions and requirements
- LLM provider selector for all modes, optional prompt for single-tool mode
- Instruction and delay steps rendered with distinct styling in the step list

### Security

- Instruction steps call LLM with **empty tools array** — no tool calling possible
- LLM output scanned by `OutputGuardian` if available (via `scanOutput` closure)
- No approval needed — instruction steps are text-only generation, delay steps are inert pauses
- Instruction and delay step execution logged to audit log
- Token usage counted in `BudgetTracker` (instruction steps only; delay steps have no token cost)

---

## Phase 2: Native Google Integration

### New Module (`src/google/`)

```
src/google/
  types.ts          — GoogleConfig, GoogleAuthState, scope mappings, result types
  google-auth.ts    — OAuth2 PKCE flow, token storage, refresh, disconnect
  google-service.ts — Direct API wrapper (replaces GWSService subprocess calls)
  index.ts          — barrel export
```

### Relationship to GWS CLI (`src/runtime/gws-service.ts`)

- **GWS CLI is NOT removed** — it remains as `mode: 'gws_cli'` for power users
- **GoogleService** mirrors the `GWSService` API surface: `execute(params)`, `schema(path)`, `isServiceEnabled()`, `getEnabledServices()`
- **Tool routing** in `src/tools/executor.ts`: the `gws` tool handler checks `GoogleService` first, falls back to `GWSService`, so both backends share the same tool name and LLM interface
- **Cross-reference**: `GWSService` JSDoc updated to reference `GoogleService` as the native alternative. `GoogleService` JSDoc references `GWSService` as the CLI fallback.

### Config (`src/config/types.ts`)

```typescript
export interface GoogleConfig {
  enabled: boolean;
  mode: 'native' | 'gws_cli';
  services: string[];
  oauthCallbackPort: number;
  credentialsPath: string;
}
```

Added to `AssistantToolsConfig` as `google?: GoogleConfig`.

### OAuth Flow (`src/google/google-auth.ts`)

1. `startAuth(scopes)` — generates PKCE code verifier/challenge, builds auth URL, starts ephemeral localhost HTTP server for callback
2. Callback server receives authorization code, exchanges it for tokens via `google-auth-library`
3. Tokens stored encrypted in `~/.guardianagent/secrets.enc.json`
4. `getAccessToken()` transparently refreshes expired tokens
5. `disconnect()` revokes tokens and clears storage

### Scope Mapping

| Service    | OAuth Scope                                         |
|------------|-----------------------------------------------------|
| gmail      | `https://www.googleapis.com/auth/gmail.modify`      |
| calendar   | `https://www.googleapis.com/auth/calendar.events`   |
| drive      | `https://www.googleapis.com/auth/drive.file`         |
| docs       | `https://www.googleapis.com/auth/documents`          |
| sheets     | `https://www.googleapis.com/auth/spreadsheets`       |
| contacts   | `https://www.googleapis.com/auth/contacts.readonly`  |

### API Endpoints (registered in `src/index.ts`)

```
POST   /api/google/credentials     — Upload client_secret.json
GET    /api/google/auth/start      — Begin OAuth, returns { authUrl }
GET    /api/google/auth/callback   — OAuth redirect handler
POST   /api/google/disconnect      — Revoke + clear tokens
GET    /api/google/status          — Auth state, services, token expiry
```

### Web UI (`web/public/js/pages/config.js`)

`createGoogleWorkspacePanel()` redesigned:
- **Native mode (default)**: credential upload, service toggles, Connect/Disconnect button, status indicator
- **CLI mode**: existing setup guide (preserved for power users)
- **Mode selector**: toggle between native and CLI
- Both modes cross-reference each other: native panel mentions CLI as alternative, CLI panel mentions native as simpler path

### Security

| Concern | Control |
|---------|---------|
| Token storage | Encrypted at rest, key from machine entropy |
| Token logging | Never logged; patterns in SecretScanController |
| API audit | All calls logged with service/method/resource |
| Scope | Minimal per-service; user controls via service toggles |
| PKCE | Prevents auth code interception |
| Callback | `127.0.0.1` only, closes after callback |

### Dependencies

```json
{
  "googleapis": "^144.0.0",
  "google-auth-library": "^9.0.0"
}
```

---

## Files Changed

### Phase 1 (Instruction Steps + Delay Steps)

| File | Change |
|------|--------|
| `src/config/types.ts` | Add `type`, `instruction`, `llmProvider`, `maxTokens`, `delayMs` to step definition |
| `src/runtime/connectors.ts` | Add `runInstruction` option, `executeInstructionStep()`, `executeDelayStep()`, thread prior results |
| `src/runtime/connectors.test.ts` | Add instruction step and delay step tests |
| `src/prompts/guardian-core.ts` | Add instruction step and delay step guidance |
| `web/public/js/pages/automations.js` | Step type selector, instruction textarea, delay input, tool picker with Browse |

### Phase 2 (Native Google)

| File | Change |
|------|--------|
| `src/google/types.ts` | New — config, auth state, scope mappings |
| `src/google/google-auth.ts` | New — OAuth PKCE, token management |
| `src/google/google-service.ts` | New — direct API wrapper |
| `src/google/index.ts` | New — barrel export |
| `src/google/google-auth.test.ts` | New — auth flow tests |
| `src/google/google-service.test.ts` | New — API wrapper tests |
| `src/config/types.ts` | Add `GoogleConfig`, add to `AssistantToolsConfig` |
| `src/runtime/gws-service.ts` | Add cross-reference JSDoc to `GoogleService` |
| `src/tools/executor.ts` | Add `googleService` option, routing in `gws` handler |
| `src/index.ts` | Bootstrap `GoogleAuth`/`GoogleService`, API routes, config hot-reload |
| `web/public/js/pages/config.js` | Redesign Google panel with native/CLI modes |
| `package.json` | Add `googleapis`, `google-auth-library` |
