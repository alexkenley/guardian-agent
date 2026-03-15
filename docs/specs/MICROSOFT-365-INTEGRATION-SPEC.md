# Microsoft 365 Integration Specification

**Status:** Proposal
**Author:** Claude (research) + Alex (review)
**Date:** 2026-03-15
**Depends on:** ToolExecutor, Guardian admission pipeline, Skills layer, Channel adapters
**Reference pattern:** `src/google/` (GoogleAuth + GoogleService)

---

## Overview

Add native Microsoft 365 integration to GuardianAgent via the **Microsoft Graph API** — the single unified REST endpoint (`https://graph.microsoft.com/v1.0/`) that covers Outlook mail, Calendar, OneDrive, Contacts, and Teams.

This spec mirrors the established Google Workspace integration pattern for consistency:

| Concern | Google Pattern | Microsoft Pattern (proposed) |
|---------|---------------|------------------------------|
| Auth | OAuth 2.0 PKCE, localhost callback | OAuth 2.0 PKCE, localhost callback (hand-rolled, same as Google) |
| Token storage | AES-256-GCM encrypted file | Same encrypted file (separate key) |
| API calls | Direct REST via `fetch()` | Direct REST via `fetch()` (no heavy SDK) |
| Tools | `gws` (generic) + `gmail_send`/`gmail_draft` (convenience) | `m365` (generic) + `outlook_send`/`outlook_draft` (convenience) |
| Discovery | `gws_schema` via Google Discovery API | `m365_schema` via Graph metadata |
| Skill | `skills/google-workspace/` | `skills/microsoft-365/` |
| Config UI | Cloud > Connections tab, 3-step setup | Cloud > Connections tab, 3-step setup |

---

## Architecture

### File Organization

```
src/microsoft/
  types.ts               — Type definitions, scope mappings, constants
  microsoft-auth.ts      — Hand-rolled OAuth 2.0 PKCE flow + encrypted token storage (mirrors google-auth.ts)
  microsoft-service.ts   — Direct Graph REST API wrapper
  microsoft-auth.test.ts — Auth unit tests
  microsoft-service.test.ts — API wrapper unit tests
  index.ts               — Barrel export

skills/microsoft-365/
  SKILL.md               — Core rules and workflow guidance
  skill.json             — Metadata (tags, triggers, tools)
  references/
    outlook.md           — Mail-specific patterns
    calendar.md          — Calendar-specific patterns
    onedrive.md          — Files-specific patterns
```

### Dependencies

**No new npm dependencies.** The entire integration uses hand-rolled OAuth 2.0 PKCE + direct `fetch()` REST calls, exactly mirroring the Google Workspace pattern in `src/google/`.

- Auth: hand-rolled PKCE against `login.microsoftonline.com` (same token endpoint already used by Azure cloud tools in `src/tools/cloud/azure-client.ts`)
- API: direct `fetch()` to `graph.microsoft.com` with Bearer tokens
- No MSAL, no Graph SDK, no `@azure/identity`

This keeps the dependency footprint at zero and maintains architectural consistency with `GoogleAuth` + `GoogleService`.

---

## Authentication

### OAuth 2.0 Authorization Code + PKCE

Follows the exact same flow as `GoogleAuth`:

1. **App Registration** — User creates an app in [Microsoft Entra admin center](https://entra.microsoft.com):
   - Platform: "Mobile and desktop applications"
   - Redirect URI: `http://localhost:{port}` (configurable, default `18433`)
   - Enable "Allow public client flows"
   - Record: Application (client) ID + Tenant ID
   - No client secret needed (public client + PKCE)

2. **Auth Flow** (`MicrosoftAuth.startAuth()`) — mirrors `GoogleAuth.startAuth()`:
   - Generate PKCE code verifier (32 random bytes, base64url) + code challenge (SHA256 of verifier, base64url)
   - Generate random state parameter for CSRF protection
   - Build authorization URL:
     ```
     https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
       ?client_id={clientId}
       &response_type=code
       &redirect_uri=http://localhost:{port}/callback
       &scope={scopes} offline_access
       &code_challenge={challenge}
       &code_challenge_method=S256
       &state={random}
     ```
   - Start ephemeral localhost HTTP server on configured port (same pattern as `GoogleAuth`)
   - Open browser via `start` (Windows) → user signs in and consents → redirect back with auth code
   - Validate state parameter matches
   - Exchange auth code for tokens via direct POST to token endpoint:
     ```
     POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
     Content-Type: application/x-www-form-urlencoded

     client_id={clientId}
     &grant_type=authorization_code
     &code={authCode}
     &redirect_uri={redirectUri}
     &code_verifier={codeVerifier}
     &scope={scopes} offline_access
     ```
   - Close server, return tokens (access_token, refresh_token, expires_in, scope)
   - Note: `offline_access` scope is required to receive a refresh_token

3. **Token Storage** — same `~/.guardianagent/secrets.enc.json` file, namespaced key:
   - Google uses key `google-tokens`
   - Microsoft uses key `microsoft-tokens`
   - Same AES-256-GCM encryption, same machine-specific key derivation (hostname + username)
   - Same file permissions (0o600)

4. **Token Refresh** — hand-rolled, same pattern as `GoogleAuth`:
   - 5-minute pre-expiry refresh threshold
   - Direct POST to token endpoint with `grant_type=refresh_token`
   - `getAccessToken()` returns valid token or transparently refreshes
   - Note: the same `login.microsoftonline.com` token endpoint is already used by `AzureClient` in `src/tools/cloud/azure-client.ts` for service principal auth — the endpoint constant can be shared

5. **Disconnect** — Clear locally stored encrypted tokens. Microsoft doesn't have a direct token revoke endpoint like Google's `/revoke`, so we clear local storage and optionally redirect to the logout URL (`https://login.microsoftonline.com/common/oauth2/v2.0/logout`).

### Account Types

The app registration should use **"Accounts in any organizational directory and personal Microsoft accounts"** (`common` tenant) for broadest compatibility. Users with personal Outlook.com/Hotmail accounts get mail, calendar, contacts, and OneDrive. Organizational accounts additionally get Teams, SharePoint, etc.

### Scopes

Minimal scopes per service, matching Google's approach:

```typescript
const MICROSOFT_SERVICE_SCOPES: Record<string, string[]> = {
  // Phase 1 — core services
  mail:     ['Mail.ReadWrite', 'Mail.Send'],
  calendar: ['Calendars.ReadWrite'],
  onedrive: ['Files.ReadWrite'],
  contacts: ['Contacts.ReadWrite'],
  user:     ['User.Read'],
  // Phase 2 — organizational services
  // teams: ['Team.ReadBasic.All', 'ChannelMessage.Send', 'Chat.ReadWrite'],
};
```

`User.Read` is always included (required for basic profile info and `/me` endpoint).

---

## API Service Layer

### `MicrosoftService` (mirrors `GoogleService`)

Single class wrapping direct REST calls to `https://graph.microsoft.com/v1.0/`.

**Key design decisions:**
- Direct `fetch()` calls — no Graph SDK wrapper
- Error-as-value pattern: always returns `{ success: boolean, data?, error? }`, never throws
- Smart URL building from resource paths
- Auto-pagination with `@odata.nextLink`
- Configurable timeout (default 30s)

### Resource URL Mapping

Microsoft Graph has a cleaner URL structure than Google (single base, consistent patterns):

```
GET    /me/messages                    — list mail
GET    /me/messages/{id}               — get message
POST   /me/sendMail                    — send mail
POST   /me/messages                    — create draft
PATCH  /me/messages/{id}               — update draft
POST   /me/messages/{id}/send          — send draft
GET    /me/events                      — list calendar events
POST   /me/events                      — create event
GET    /me/drive/root/children         — list OneDrive root
GET    /me/contacts                    — list contacts
GET    /me/joinedTeams                 — list Teams
POST   /teams/{id}/channels/{id}/messages — post to channel
```

The `m365` tool will accept:
- `resource`: Slash-separated Graph path (e.g., `me/messages`, `me/events`, `me/drive/root/children`)
- `method`: `list`, `get`, `create`, `update`, `delete`, `send`
- `params`: Query parameters (`$filter`, `$select`, `$top`, `$orderby`, etc.)
- `json`: Request body for mutations
- `id`: Resource ID (inserted into path)

### URL Building Logic

```typescript
function buildGraphUrl(resource: string, id?: string, action?: string): string {
  let path = resource;              // e.g. "me/messages"
  if (id) path += `/${id}`;         // e.g. "me/messages/AAMk..."
  if (action) path += `/${action}`; // e.g. "me/messages/AAMk.../send"
  return `https://graph.microsoft.com/v1.0/${path}`;
}
```

### Pagination

Graph uses `@odata.nextLink` for pagination (simpler than Google's varied field names):

```typescript
async paginate(url: string, headers: HeadersInit, pageLimit = 20): Promise<any[]> {
  const items: any[] = [];
  let nextUrl: string | undefined = url;
  let pages = 0;
  while (nextUrl && pages < pageLimit) {
    const res = await fetch(nextUrl, { headers });
    const data = await res.json();
    items.push(...(data.value || []));
    nextUrl = data['@odata.nextLink'];
    pages++;
  }
  return items;
}
```

### Special Helpers

Like Google's `sendGmailMessage()`, provide convenience methods:

```typescript
async sendOutlookMessage(to: string, subject: string, body: string): Promise<MicrosoftResult> {
  return this.execute({
    resource: 'me/sendMail',
    method: 'create',  // POST
    json: {
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }]
      }
    }
  });
}

async createOutlookDraft(to: string, subject: string, body: string): Promise<MicrosoftResult> {
  return this.execute({
    resource: 'me/messages',
    method: 'create',
    json: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
      isDraft: true
    }
  });
}
```

---

## Tool Registration

### Tools (4 total, mirrors Google's 4)

#### `m365` — General Microsoft Graph API Tool
- **Risk**: `network`
- **Category**: `workspace`
- **Defer loading**: yes (always-loaded when Microsoft service enabled)
- **Parameters**:
  - `service` (required): `mail`, `calendar`, `onedrive`, `contacts`, `teams`, `user`
  - `resource` (required): Graph path (e.g., `me/messages`, `me/events`)
  - `method` (required): `list`, `get`, `create`, `update`, `delete`, `send`
  - `id` (optional): Resource ID
  - `params` (optional): OData query params (`$filter`, `$select`, `$top`, `$orderby`)
  - `json` (optional): Request body for mutations
  - `format`: `json`, `table`, `yaml`, `csv`
  - `pageAll`: Auto-paginate all results
  - `pageLimit`: Max pages when paginating
- **Smart param normalization**: same pattern as `gws` — body fields moved from params to json, IDs moved from json to params

#### `m365_schema` — Graph API Discovery
- **Risk**: `read_only`
- **Category**: `workspace`
- **Purpose**: Look up available endpoints and parameters
- **Input**: `schemaPath` (e.g., `mail.messages.list`)
- **Implementation**: Returns curated endpoint documentation (Graph's `$metadata` is OData XML, not as clean as Google's Discovery API — so we ship a curated reference map instead)

#### `outlook_draft` — Create Email Draft (convenience)
- **Risk**: `mutating`
- **Category**: `email`
- **Parameters**: `to`, `subject`, `body`
- **Action**: `draft_email` capability

#### `outlook_send` — Send Email (convenience)
- **Risk**: `external_post`
- **Category**: `email`
- **Parameters**: `to`, `subject`, `body`
- **Action**: `send_email` capability
- **Always requires approval** (external_post)

### Approval Logic (`decideM365Tool`)

Mirrors `decideGwsTool`:

| Operation | Approval |
|-----------|----------|
| Any read (list, get) | Default policy (allow) |
| `outlook_send` / `me/sendMail` | **Always** requires approval |
| Mail drafts | Requires approval unless autonomous |
| Calendar writes | Requires approval unless autonomous |
| OneDrive writes | Requires approval unless autonomous |
| Teams messages (Phase 2) | Requires approval unless autonomous |

### Action Type Mapping (Guardian capabilities)

```typescript
const M365_ACTION_TYPES: Record<string, string> = {
  'mail.send':       'send_email',
  'mail.write':      'draft_email',
  'mail.read':       'read_email',
  'calendar.write':  'write_calendar',
  'calendar.read':   'read_calendar',
  'onedrive.write':  'write_drive',
  'onedrive.read':   'read_drive',
  'contacts.write':  'write_contacts',
  'contacts.read':   'read_contacts',
  // Phase 2
  // 'teams.write':  'write_teams',
  // 'teams.read':   'read_teams',
};
```

---

## Configuration

### Config Type

```typescript
interface MicrosoftConfig {
  enabled: boolean;                    // Default: false
  services: string[];                  // Phase 1 default: ['mail', 'calendar', 'onedrive', 'contacts']
  oauthCallbackPort: number;           // Default: 18433 (different from Google's 18432)
  clientId: string;                    // Application (client) ID from Entra
  tenantId: string;                    // Default: 'common'
  timeoutMs?: number;                  // Default: 30_000
}
// Phase 2 adds: 'teams' to services list
```

**Note:** Unlike Google which requires a downloaded JSON credentials file, Microsoft only needs a `clientId` (and optionally `tenantId`). No secret file. This simplifies the setup flow.

### YAML Config

```yaml
assistant:
  tools:
    microsoft:
      enabled: true
      services: [mail, calendar, onedrive, contacts]
      oauthCallbackPort: 18433
      clientId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      tenantId: "common"
      timeoutMs: 30000
```

---

## Web UI Setup Flow

3-step flow on Cloud > Connections tab, directly below Google Workspace and above the infrastructure providers (cPanel/WHM, Vercel, etc.):

### Step 1: Register App
- Instructions to go to [Microsoft Entra admin center](https://entra.microsoft.com)
- Create App Registration → "Mobile and desktop applications"
- Set redirect URI: `http://localhost:18433/callback`
- Enable "Allow public client flows"
- Copy Application (client) ID

### Step 2: Enter Client ID
- Text input for Application (client) ID
- Optional text input for Tenant ID (defaults to `common`)
- Save → stores in config

### Step 3: Connect Microsoft
- Service checkboxes (Mail, Calendar, OneDrive, Contacts)
- Click "Connect Microsoft" → opens browser for consent
- OAuth PKCE flow completes → tokens stored encrypted
- Auto-enables `microsoft.enabled` in config

### API Routes

```
GET  /api/microsoft/status        → { authenticated, tokenExpiry, services }
POST /api/microsoft/auth/start    → { authUrl, state }
POST /api/microsoft/config        → save clientId/tenantId
POST /api/microsoft/disconnect    → clear tokens
```

---

## Skill: `skills/microsoft-365/`

### `skill.json`

```json
{
  "id": "microsoft-365",
  "name": "Microsoft 365",
  "version": "0.1.0",
  "description": "Guide for interacting with Microsoft 365 services via Graph API: Outlook mail, Calendar, OneDrive, Contacts, Teams.",
  "role": "domain",
  "tags": ["microsoft", "outlook", "email", "calendar", "onedrive", "teams", "office365"],
  "enabled": true,
  "appliesTo": {
    "agents": ["sentinel", "chat"],
    "channels": ["cli", "web", "telegram"],
    "requestTypes": ["chat", "quick_action"]
  },
  "triggers": {
    "keywords": ["outlook", "microsoft", "office 365", "m365", "onedrive", "microsoft calendar", "outlook mail", "outlook email", "send outlook", "draft outlook"],
    "toolCategories": ["workspace", "email"],
    "intents": ["email_management", "calendar_management", "file_management"]
  },
  "tools": ["m365", "m365_schema", "outlook_draft", "outlook_send"],
  "requiredCapabilities": ["network_access"],
  "risk": "informational"
}
```

### `SKILL.md` Key Rules (mirrors Google skill)

1. Never ask for tokens — auth is automatic
2. Prefer `outlook_draft`/`outlook_send` for simple email
3. Use `m365` for everything else
4. Consult `m365_schema` when uncertain about endpoints
5. Resource paths use slashes: `me/messages` not `me.messages`
6. IDs in `id` param, bodies in `json`
7. Read first on ambiguous mutations
8. Expect approvals for sends/drafts
9. Use OData `$select` to minimize response size
10. Use `$filter` for server-side filtering

### References

- `references/outlook.md` — mail patterns (read, search, draft, send, attachments)
- `references/calendar.md` — event patterns (list, create, update, RSVP)
- `references/onedrive.md` — file patterns (list, upload, download, search, share)

---

## Key Differences from Google Integration

| Aspect | Google | Microsoft | Impact |
|--------|--------|-----------|--------|
| Credentials | JSON file download from Cloud Console | Just a client ID string | Simpler setup — no file upload step |
| Base URL | Different per service (6 base URLs) | Single: `graph.microsoft.com/v1.0` | Simpler URL building |
| Auth library | Hand-rolled OAuth PKCE | Hand-rolled OAuth PKCE (same pattern) | Zero dependencies, identical architecture |
| Token refresh | Manual refresh implementation | Manual refresh implementation (same pattern) | Consistent, no external dependency |
| Pagination | Varied field names per API | Consistent `@odata.nextLink` | Simpler pagination |
| Discovery | Google Discovery API (JSON, excellent) | OData `$metadata` (XML, verbose) | Ship curated schema reference instead |
| Send mail | RFC822 base64url encoding | JSON body (cleaner) | Simpler mail sending |
| Query filtering | Custom per-API | OData `$filter` (standardized) | Consistent query syntax |
| Personal accounts | Full API access | Limited (no Teams, SharePoint) | Document limitations clearly |

---

## Implementation Plan

### Phase 1: Core Integration (Windows-first, 4 services)

**Target:** Windows desktop users with personal or organizational Microsoft accounts.
**Services:** Mail (Outlook), Calendar, OneDrive, Contacts only.
**No:** Teams, Device Code flow, shared mailboxes, batching, webhooks — all deferred to Phase 2.

#### Step 1: Core Auth + Service (4 files, ~800 lines)

1. `src/microsoft/types.ts` — interfaces, scope mappings, constants (mail, calendar, onedrive, contacts, user)
2. `src/microsoft/microsoft-auth.ts` — Hand-rolled PKCE flow (mirrors `google-auth.ts`), encrypted token storage, browser launch via `start` (Windows)
3. `src/microsoft/microsoft-service.ts` — Graph REST wrapper with pagination
4. `src/microsoft/index.ts` — barrel export

#### Step 2: Tool Registration (~200 lines in executor.ts)

5. Register `m365`, `m365_schema`, `outlook_draft`, `outlook_send` tools
6. Add `decideM365Tool` approval logic
7. Add action type mapping for Guardian capabilities

#### Step 3: Bootstrap + API Routes (~80 lines in index.ts)

8. Initialize `MicrosoftAuth` + `MicrosoftService` in bootstrap
9. Wire API routes (`/api/microsoft/*`)
10. Add to `enabledManagedProviders` conditionally

#### Step 4: Web UI (~200 lines in cloud.js)

11. Add "Microsoft 365" panel to Cloud > Connections tab (below Google Workspace, above cPanel/WHM)
12. 3-step setup flow (register app, enter client ID, connect)
13. Service toggles (Mail, Calendar, OneDrive, Contacts), status display, disconnect button
14. Wire up API routes for status polling, auth start, config save, disconnect

#### Step 5: Skill (5 files)

14. `skills/microsoft-365/skill.json`
15. `skills/microsoft-365/SKILL.md`
16. `skills/microsoft-365/references/outlook.md`
17. `skills/microsoft-365/references/calendar.md`
18. `skills/microsoft-365/references/onedrive.md`

#### Step 6: Tests (2 files, ~150 lines)

19. `src/microsoft/microsoft-auth.test.ts`
20. `src/microsoft/microsoft-service.test.ts`

#### Step 7: Documentation

21. Update `src/reference-guide.ts` with Microsoft 365 section
22. Update `CLAUDE.md` with Microsoft section
23. Update `README.md` config reference

---

### Phase 2: Extended Features (future)

- **Teams integration** — `Team.ReadBasic.All`, `ChannelMessage.Send`, `Chat.ReadWrite` (org accounts only)
- **Device Code flow** — alternative auth for headless/SSH environments
- **Shared mailbox / delegated access** — `/users/{id}/messages` (org accounts, admin consent)
- **Graph API batching** — `$batch` for bulk operations
- **Webhooks/subscriptions** — push change notifications for real-time monitoring
- **Cross-platform browser launch** — `xdg-open` (Linux), `open` (macOS) alongside `start` (Windows)

---

## Dependencies

**No new npm dependencies.** Both auth and API layers are hand-rolled using Node.js built-ins (`crypto`, `http`, `fetch`), matching the Google Workspace pattern exactly. The `login.microsoftonline.com` token endpoint is already known to the codebase via `src/tools/cloud/azure-client.ts`.

---

## Security Considerations

- **Token encryption**: Same AES-256-GCM pattern, separate key namespace
- **Scopes**: Minimal per service, incremental consent supported
- **PKCE**: Prevents auth code interception (same as Google)
- **Guardian gating**: All tools go through admission pipeline
- **SSRF protection**: Graph endpoints are external, pass SSRF checks
- **Secret scanning**: Bearer tokens caught by existing SecretScanController patterns
- **Approval model**: Same as Google — reads pass, writes need approval, sends always need approval
- **No client secret**: Public client apps use PKCE instead of a secret, reducing credential surface

---

## Design Decisions

1. **Teams → Phase 2.** Requires organizational accounts, adds complexity, not needed for core personal productivity.
2. **Device Code flow → Phase 2.** Phase 1 targets Windows desktop where browser is always available.
3. **Shared mailboxes → Phase 2.** Org-only, requires admin consent.
4. **Graph batching → Phase 2.** Nice optimization but not needed for initial integration.
5. **Webhooks → Phase 2.** Needs publicly reachable endpoint; polling or cron-based checks are sufficient initially.
6. **Windows-first.** Browser launch uses `start` command. Cross-platform (`xdg-open`, `open`) added in Phase 2.
7. **Zero new dependencies.** Hand-rolled PKCE + direct `fetch()` to Graph REST API, same architecture as `src/google/`. No MSAL, no Graph SDK, no `@azure/identity`. The token endpoint (`login.microsoftonline.com`) is already used by Azure cloud tools — constant can be shared.
