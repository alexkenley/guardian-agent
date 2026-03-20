# Configuration Center Spec

## Goal
Provide one intuitive configuration surface (web + CLI) without an interactive setup wizard.

## Scope
- Web Config Center (`#/config`)
- CLI config commands (`/config ...`)
- Web auth controls in Config Center + CLI (`/auth ...`)
- Readiness diagnostics (`GET /api/setup/status`)
- Provider apply endpoint (`POST /api/setup/apply`) used by Config Center
- Search config endpoint (`POST /api/config/search`) for web search settings
- Document search source management endpoints (`/api/search/*`)

## Requirements
- Users do not hand-edit YAML for normal onboarding
- Local vs external provider switching is explicit and simple
- Provider testing and model visibility are built-in
- Web search settings are decoupled from LLM provider config
- Telegram enable/token/chat-id configuration is part of the same panel
- Web auth mode/token controls are part of the same panel
- Default provider can be changed live
- API keys can be cleared (removed) from config, not just set
- Telegram readiness status should update immediately after save (no manual refresh)

## UX Model
- Web:
  - Side-by-side provider panels:
    - **Left panel — Local Providers (Ollama):** Profile dropdown filtered to `provider === 'ollama'` entries + "New", model/URL fields, always sends `providerType: 'ollama'`
    - **Right panel — External Providers (APIs):** Profile dropdown filtered to `provider !== 'ollama'` entries + "New", type selector (anthropic/openai), model/key/URL fields, always sends explicit `providerType`
  - Each panel has independent Save, Test Connection, and status display
  - Web search config section with provider selector, API key fields, and fallback list
  - API key fields show `[clear]` button when a key is configured, allowing removal
  - Readiness checklist and status cards
  - Telegram config as a separate section below provider panels
  - Telegram section fields:
    - `Enable Telegram` (on/off)
    - `Bot Token`
    - `Allowed Chat IDs` (comma-separated IDs)
    - `Default Agent` (optional)
  - Telegram readiness card reports completion state from saved config
- CLI:
  - No `/setup` wizard command
  - Use `/config` and `/auth` commands for all configuration actions
  - Use `/assistant` and `/providers` for runtime/health visibility

## Endpoints

### `POST /api/setup/apply` — Provider Configuration
Applies LLM provider settings. Always requires explicit `providerType` field. If `providerType` is missing, the backend preserves the existing provider's type rather than defaulting (safety net against corruption).

### `POST /api/config/search` — Web Search Configuration
Dedicated endpoint for web search settings. Updates ONLY `assistant.tools.webSearch` and `fallbacks` — never touches LLM provider config. This prevents web search saves from corrupting provider settings.

Input fields:
- `webSearchProvider` — `'auto' | 'perplexity' | 'brave' | 'duckduckgo'`
- `perplexityApiKey`, `openRouterApiKey`, `braveApiKey` — API keys (empty string = clear key, undefined = leave unchanged)
- `fallbacks` — fallback provider list

## Runtime Behavior
- Config writes persist to config YAML via backend callbacks
- LLM/default provider updates apply live through `runtime.applyLLMConfiguration()`
- Web search config changes apply immediately — `ToolExecutor.updateWebSearchConfig()` is called from `persistAndApplyConfig`, also clearing the search result cache so the new provider takes effect without restart
- Telegram channel structural updates still require restart
- Web auth mode is fixed to `bearer_required` (no unauthenticated mode)
- If no token is configured, runtime may generate an ephemeral token for the current process
- If `channels.web.auth.rotateOnStartup` is `true`, runtime generates a fresh ephemeral token at startup even when a config/env token exists
- Runtime-generated startup tokens and manually rotated tokens remain runtime-ephemeral and are not written back into config
- When Guardian starts in an interactive terminal with an ephemeral startup token, it prints the full token once so the operator can exchange it for the dashboard session cookie
- The Windows and Unix development launchers should mirror that runtime behavior by explaining up front whether startup will reuse a pinned token or surface a per-run ephemeral token in the terminal

## Telegram Configuration Flow

Recommended setup path:
1. Create bot with `@BotFather` (`/newbot`) and copy token.
2. In web `#/config` -> `Settings` -> `Telegram Channel`, enable Telegram and save token.
3. Send one message to the bot (`/start`) and fetch updates via Telegram API.
4. Copy `message.chat.id` into `Allowed Chat IDs` and save.
5. Restart runtime for Telegram channel structural changes.

## Validation Rules
- `model` required
- External providers require API key unless one already exists
- Updated config must pass `validateConfig()`
- Provider saves must include explicit `providerType` — missing type with no existing provider returns an error

## Document Search Source Management

REST endpoints for managing document search sources at runtime:

- `GET /api/search/status` — Search engine status, indexed collections, configured sources
- `GET /api/search/sources` — List all configured document sources
- `POST /api/search/sources` — Add a new source (body: `{ id, name, type, path, globs?, branch?, description?, enabled }`)
  - `type` supports: `directory` (local path + globs), `git` (repo URL + optional branch), `url` (web content), `file` (single file)
- `DELETE /api/search/sources/:id` — Remove a source by id
- `PATCH /api/search/sources/:id` — Toggle source enabled/disabled (body: `{ enabled: boolean }`)
- `POST /api/search/reindex` — Trigger reindex (body: `{ collection?: string }`)

Web UI: Configuration > Search Sources tab provides full CRUD with status card, sources table, and add form.

Config: `assistant.tools.search` — `enabled`, `sqlitePath`, `defaultMode`, `maxResults`, `sources[]`, `embedding`, `chunking`, `reranker`

## Tool Provider Routing Management

Per-tool and per-category LLM provider routing, controlling which model synthesizes tool results. Smart category defaults automatically assign tools to local or external models based on task type when both provider types are configured.

- `GET /api/tools` — Returns `providerRouting` map, `providerRoutingEnabled`, and `defaultProviderLocality` in the tools state response
- `POST /api/tools/provider-routing` — Update routing map and/or toggle (body: `{ routing?: { "key": "local" | "external" }, enabled?: boolean }`)
  - Keys are tool names (e.g. `fs_write`) or category names (e.g. `workspace`)
  - `enabled` controls the `providerRoutingEnabled` master toggle
  - Only entries differing from the default provider locality are persisted
  - Validated server-side; invalid values return 400
- `POST /api/providers/default` — Set the default LLM provider (body: `{ name: string }`)

**Smart defaults:** When `providerRoutingEnabled` is `true` (default) and both local and external providers exist, categories are auto-routed: local categories (filesystem, shell, network, system, memory) use the local model; external categories (web, browser, workspace, email, contacts, forum, intel, search, automation) use the external model. Explicit `providerRouting` entries always override smart defaults. When only one provider type exists, smart routing is a no-op.

Web UI: Configuration > Tools tab — "LLM" column on both Tool Categories and Tool Catalog tables with Local/External dropdowns. "Smart LLM Routing" checkbox toggles `providerRoutingEnabled`. Category changes cascade to all tools in that category. Providers tab includes a "Set as Default" button per provider row. Changes save immediately and take effect on the next tool execution (hot-reloadable, no restart needed).

Config: `assistant.tools.providerRoutingEnabled` (boolean, default `true`), `assistant.tools.providerRouting` — `Record<string, 'local' | 'external'>`
