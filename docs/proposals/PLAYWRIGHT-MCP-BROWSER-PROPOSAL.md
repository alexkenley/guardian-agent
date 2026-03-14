# Playwright MCP Browser Integration Proposal

## Summary

Replace the current `agent-browser` dependency with [Playwright MCP](https://github.com/microsoft/playwright-mcp) as GuardianAgent's browser automation backend, optionally combined with [Lightpanda](https://github.com/lightpanda-io/browser) for lightweight page reading. Playwright MCP is Microsoft's official MCP server exposing 55+ browser automation tools through the standardized MCP protocol, backed by real Chromium/Firefox/WebKit engines with full web compatibility.

This proposal supersedes the Lightpanda-only proposal (`LIGHTPANDA-BROWSER-PROPOSAL.md`) and presents three options: Playwright MCP alone, Lightpanda alone, or a combination of both.

## Problem

(Same as Lightpanda proposal — the current `agent-browser` system works but is resource-heavy, limited in extraction capabilities, has no JS evaluation, and lacks a persistent server mode.)

## Playwright MCP Overview

Playwright MCP is the official MCP server from the Playwright team at Microsoft. It wraps Playwright's browser automation in the MCP tool-calling protocol, giving AI agents structured access to real browser engines.

| Property | Value |
|----------|-------|
| Language | TypeScript (Node.js >= 18) |
| License | Apache-2.0 |
| Version | v0.0.68 (active pre-1.0, weekly releases) |
| Stars | 28,800+ |
| Maintainer | Microsoft / Playwright team |
| npm | `@playwright/mcp` |
| Engines | Chromium, Firefox, WebKit, Chrome, Edge |
| Modes | stdio (default), SSE/HTTP server, Docker |
| Approach | Accessibility-tree-first (snapshot), with optional vision/coordinate mode |

### Tool Inventory (55+ tools)

**Core (always available):**

| Tool | What It Does |
|------|-------------|
| `browser_navigate` | Go to URL |
| `browser_navigate_back` | Browser back |
| `browser_click` | Click element by ref (supports double-click, modifiers) |
| `browser_hover` | Hover over element |
| `browser_type` | Type text into element (with optional submit, slow typing) |
| `browser_select_option` | Select dropdown value |
| `browser_press_key` | Press keyboard key |
| `browser_drag` | Drag and drop between elements |
| `browser_fill_form` | Fill multiple form fields at once |
| `browser_snapshot` | Capture accessibility tree snapshot |
| `browser_take_screenshot` | Take screenshot (full page or element) |
| `browser_evaluate` | Run JavaScript on page |
| `browser_run_code` | Run arbitrary Playwright code snippet |
| `browser_console_messages` | Get browser console output |
| `browser_network_requests` | Get network request log |
| `browser_file_upload` | Upload files to file inputs |
| `browser_handle_dialog` | Accept/dismiss browser dialogs |
| `browser_resize` | Resize browser viewport |
| `browser_wait_for` | Wait for text, text gone, or time |
| `browser_close` | Close current page |
| `browser_tabs` | List, create, close, select tabs |
| `browser_install` | Install the configured browser engine |

**Opt-in capability groups (`--caps`):**

| Group | Tools | Purpose |
|-------|-------|---------|
| `network` | `browser_route`, `browser_route_list`, `browser_unroute` | Mock/intercept network requests |
| `storage` | 16 tools for cookies, localStorage, sessionStorage, state save/restore | Full storage control |
| `vision` | 6 coordinate-based mouse tools (`click_xy`, `drag_xy`, `move_xy`, etc.) | Pixel-precise interaction |
| `devtools` | `browser_start/stop_tracing`, `browser_start/stop_video` | Performance tracing, video recording |
| `pdf` | `browser_pdf_save` | Export page as PDF |
| `testing` | `browser_verify_*`, `browser_generate_locator` | Assertions and test generation |
| `config` | `browser_get_config` | Inspect resolved configuration |

### Key Capabilities vs Current System

| Capability | agent-browser | Playwright MCP |
|-----------|--------------|----------------|
| JS evaluation | No | Yes (`browser_evaluate`, `browser_run_code`) |
| Multi-tab | No | Yes (`browser_tabs`) |
| File upload | No | Yes (`browser_file_upload`) |
| Screenshots | No (accessibility only) | Yes (full page, element, viewport) |
| Network interception | No | Yes (`browser_route`) |
| Cookie/storage control | No | Yes (16 storage tools) |
| Form batch fill | No (one field at a time) | Yes (`browser_fill_form`) |
| Dialog handling | No | Yes (`browser_handle_dialog`) |
| PDF export | No | Yes (`browser_pdf_save`) |
| Drag and drop | No | Yes (`browser_drag`) |
| Incremental snapshots | No | Yes (only sends changes) |
| Browser engines | Chromium only | Chromium, Firefox, WebKit |
| Device emulation | No | Yes (`--device "iPhone 15"`) |
| Proxy support | No | Yes (`--proxy-server`) |
| Auth state persistence | No | Yes (`browser_storage_state`) |

## Head-to-Head: Playwright MCP vs Lightpanda

| Dimension | Playwright MCP | Lightpanda |
|-----------|---------------|------------|
| **Web compatibility** | Full (real browser engines) | Partial (beta, some sites crash) |
| **Tool count** | 55+ | 7 |
| **Interaction depth** | Full automation (click, type, drag, upload, dialogs, tabs) | Navigate + evaluate only in MCP mode |
| **Resource usage** | Heavy (~200MB+ for Chromium) | Light (~24MB for 100 pages) |
| **Speed** | Standard browser speed | 11x faster page loads |
| **License** | Apache-2.0 | AGPL-3.0 core |
| **Maturity** | Pre-1.0 but 28K+ stars, Microsoft-backed, weekly releases | Beta v0.2.5, 15K stars |
| **Markdown extraction** | No native tool (use `browser_evaluate` with JS) | Native `markdown` tool |
| **Structured data** | No native tool (use `browser_evaluate`) | Native `structuredData` tool |
| **Semantic tree** | `browser_snapshot` (accessibility tree) | `semantic_tree` tool |
| **Screenshots** | Real screenshots | Placeholder only |
| **Multi-tab** | Yes | No (single page per process) |
| **File upload** | Yes | No |
| **Network mocking** | Yes | No |
| **Storage control** | Full (cookies, localStorage, sessionStorage) | No |
| **Node.js integration** | npm dependency, spawns browser | npm binary download, spawns binary |
| **Windows support** | Native | WSL2 only |

## Integration Options

### Option 1: Playwright MCP Only

Register Playwright MCP as a managed MCP provider. All 55+ tools become available through MCPClientManager with full Guardian admission.

```
GuardianAgent Runtime
  └─ MCPClientManager
       └─ @playwright/mcp (stdio subprocess)
            └─ Chromium / Firefox / WebKit
```

**Config:**
```yaml
mcp:
  servers:
    playwright:
      command: npx
      args: ['@playwright/mcp@latest', '--headless', '--caps', 'network,storage']
      trustLevel: managed
      maxCallsPerMinute: 60
```

**Advantages:**
- Full web compatibility — real browser engines handle every site correctly
- Massive tool surface — 55+ tools cover every browser automation scenario
- Apache-2.0 — no license concerns
- Microsoft backing — long-term maintenance confidence
- Native Windows support — no WSL2 requirement
- Incremental snapshots — token-efficient, only sends accessibility tree changes
- Auth state persistence — `browser_storage_state` save/restore for logged-in workflows
- Multi-tab support for complex multi-page workflows
- Proxy, device emulation, custom user agents for stealth/compatibility

**Disadvantages:**
- Resource-heavy — Chromium process uses ~200MB+ RAM
- No native markdown or structured data extraction tools (achievable via `browser_evaluate` but requires JS)
- Pre-1.0 versioning — API may change between releases
- All 55+ tools exposed via MCP namespace (`mcp-playwright-*`) — noisy tool list for the LLM unless filtered

**Implementation scope:** ~100-150 lines (MCP config + bootstrap wiring + Guardian policy rules for dangerous tools). Optionally ~200 more lines for a wrapper layer with cleaner tool names.

### Option 2: Lightpanda Only

(See `LIGHTPANDA-BROWSER-PROPOSAL.md` for full analysis.)

Best for lightweight, high-volume page reading where full browser automation isn't needed. Weaker on interaction depth, web compatibility, and stability.

### Option 3: Both — Lightpanda for Reading, Playwright MCP for Automation (Recommended)

Use both as managed MCP providers with intelligent routing:

- **Lightpanda** handles fast, lightweight page reads — markdown extraction, link discovery, structured data, semantic trees
- **Playwright MCP** handles full browser automation — form filling, clicking, file uploads, multi-tab workflows, screenshots, network interception

```
GuardianAgent Runtime
  └─ MCPClientManager
       ├─ Lightpanda MCP (stdio) — fast reads
       │    └─ Lightpanda binary (24MB peak)
       │
       └─ Playwright MCP (stdio) — full automation
            └─ Chromium headless (~200MB)
```

**How routing works:**

GuardianAgent already has smart LLM routing that directs tools to local or external models by category. The same principle applies here — the AI assistant naturally selects the right tool based on the task:

- "Read this article and summarize it" → `mcp-lightpanda-goto` + `mcp-lightpanda-markdown` (fast, light)
- "Log into this dashboard and download the report" → `mcp-playwright-browser_navigate` + `mcp-playwright-browser_type` + `mcp-playwright-browser_click` (full automation)

No explicit routing logic needed — the LLM picks the appropriate tools from the tool list based on the task. Tool descriptions guide selection naturally.

**Lazy startup:** Playwright MCP's Chromium process only launches when a `mcp-playwright-*` tool is first called. Lightpanda is always lightweight. For users who only need page reading, Chromium never starts.

**Advantages:**
- Best of both worlds — fast lightweight reads + full browser automation
- Resource-efficient for common cases — most AI assistant browser tasks are reads, not interactions
- Graceful capability escalation — start with Lightpanda, escalate to Playwright when interaction is needed
- Both use MCP protocol — consistent integration model through existing MCPClientManager
- No custom tool wrapper code needed — both servers provide their own tool definitions

**Disadvantages:**
- Two browser backends to configure and maintain
- Potential user confusion about when to use which (mitigated by clear tool descriptions)
- Two processes consuming resources when both are active
- Lightpanda's beta stability issues don't go away

**Implementation scope:** ~200 lines total (MCP config for both + bootstrap + policy rules).

## Security Analysis

### Playwright MCP Security Posture

Playwright MCP explicitly states it is **"not a security boundary"** — it provides no authentication, authorization, rate limiting, or audit logging. This is fine for GuardianAgent because we enforce security at the Runtime/Guardian level, not at the tool server level.

**High-risk tools that need Guardian gating:**

| Tool | Risk | Mitigation |
|------|------|------------|
| `browser_evaluate` | Arbitrary JS execution | Classify as `mutating`, require approval, Guardian Agent (Layer 2) LLM evaluation |
| `browser_run_code` | Arbitrary Playwright code execution | Classify as `mutating`, require approval, or **deny by default** via policy |
| `browser_file_upload` | Filesystem access | Classify as `mutating`, require approval, validate paths against allowedPaths |
| `browser_route` | Network interception/modification | Classify as `mutating`, require approval |
| `browser_cookie_set` | Session manipulation | Classify as `mutating`, require approval |
| `browser_storage_state` | Auth credential persistence | Classify as `mutating`, validate output path |

**Recommended policy rules (policies/base/browser.json):**

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "browser-deny-run-code",
      "description": "Block arbitrary Playwright code execution",
      "priority": 100,
      "conditions": { "action.name": { "in": ["mcp-playwright-browser_run_code"] } },
      "decision": "deny",
      "reason": "Arbitrary code execution blocked by policy"
    },
    {
      "id": "browser-approve-mutating",
      "description": "Require approval for browser mutations",
      "priority": 200,
      "conditions": {
        "action.name": {
          "startsWith": "mcp-playwright-browser_",
          "in": ["mcp-playwright-browser_evaluate", "mcp-playwright-browser_click",
                  "mcp-playwright-browser_type", "mcp-playwright-browser_file_upload",
                  "mcp-playwright-browser_route", "mcp-playwright-browser_cookie_set"]
        }
      },
      "decision": "require_approval",
      "reason": "Browser mutation requires operator approval"
    },
    {
      "id": "browser-allow-reads",
      "description": "Auto-allow browser read operations",
      "priority": 300,
      "conditions": {
        "action.name": {
          "in": ["mcp-playwright-browser_snapshot", "mcp-playwright-browser_navigate",
                  "mcp-playwright-browser_tabs", "mcp-playwright-browser_console_messages",
                  "mcp-playwright-browser_network_requests"]
        }
      },
      "decision": "allow"
    }
  ]
}
```

### Lightpanda Security (unchanged from Lightpanda proposal)

The `evaluate` tool is the primary surface. Same mitigations apply: expression blocklist, mutating risk, Guardian Agent evaluation, length limits, output truncation.

### Domain Control

Both servers support origin/domain restrictions:
- Playwright MCP: `--blocked-origins "https://banking.com"` CLI flag
- Lightpanda: Validated in wrapper layer against `assistant.tools.browser.allowedDomains`

GuardianAgent's SSRF controller and domain allowlist apply regardless — URLs are validated before the tool call reaches the MCP server.

### Process Isolation

Both run as MCP stdio subprocesses managed by MCPClientManager:
- Process lifecycle (start, health check, restart, graceful shutdown) managed by the framework
- No shared memory with the supervisor process
- Sandbox profile: `workspace-write` with `networkAccess: true` (browsers need network)
- Rate-limited via per-server `maxCallsPerMinute` config
- All tool calls pass through full Guardian admission pipeline

## Recommendation

**Option 3 (Both) is the strongest choice**, but with a pragmatic phased approach:

### Phase 1: Playwright MCP as primary browser backend

- Add `@playwright/mcp` to package.json
- Register as managed MCP provider in bootstrap
- Add policy rules for dangerous tools (`browser_run_code` → deny, `browser_evaluate` → approve)
- Remove `agent-browser` dependency and `BrowserSessionManager`
- Configure with `--headless --caps network,storage`

This alone is a massive upgrade: from 5 limited tools to 55+ comprehensive tools, with real browser compatibility, multi-tab, file upload, screenshots, network interception, and auth state persistence.

### Phase 2: Add Lightpanda for fast reads (when stable)

- Add `@lightpanda/browser` as optional dependency
- Register as second managed MCP provider
- Lightpanda handles high-volume page reading tasks
- Playwright MCP handles interactive automation
- Wait until Lightpanda reaches v1.0 or demonstrates stability on target sites

### Why Playwright MCP first:

1. **Full web compatibility** — Real Chromium means every site works. Lightpanda's beta status means some sites crash.
2. **Apache-2.0** — No license complexity.
3. **Windows native** — No WSL2 requirement. GuardianAgent has Windows users.
4. **55+ tools** — Covers every automation scenario out of the box. Lightpanda's 7 MCP tools are a subset.
5. **Microsoft backing** — Playwright is one of the most widely used browser automation frameworks. The MCP server inherits that ecosystem.
6. **Zero wrapper code** — MCPClientManager handles everything. Policy rules gate dangerous tools. No custom `LightpandaBrowserProvider` needed.

The resource overhead (~200MB for Chromium) is the main tradeoff. Adding Lightpanda in Phase 2 addresses this for the common case (page reading) while keeping Playwright available for full automation.

## Configuration

### Phase 1 config (Playwright MCP only)

```yaml
mcp:
  servers:
    playwright:
      command: npx
      args:
        - '@playwright/mcp@latest'
        - '--headless'
        - '--browser'
        - 'chromium'
        - '--caps'
        - 'network,storage'
      trustLevel: managed
      maxCallsPerMinute: 60

assistant:
  tools:
    browser:
      enabled: true
      backend: playwright-mcp    # replaces agent-browser
      allowedDomains: []          # empty = all domains (SSRF still applies)
```

### Phase 2 config (both)

```yaml
mcp:
  servers:
    lightpanda:
      command: lightpanda
      args: ['mcp']
      trustLevel: managed
      maxCallsPerMinute: 120     # higher limit — lightweight reads
    playwright:
      command: npx
      args:
        - '@playwright/mcp@latest'
        - '--headless'
        - '--caps'
        - 'network,storage'
      trustLevel: managed
      maxCallsPerMinute: 60
```

## Implementation Estimate

### Phase 1

| Component | Files | Scope |
|-----------|-------|-------|
| MCP server config in bootstrap | 1 existing (index.ts) | ~40 lines |
| Policy rules for browser tools | 1 new (policies/base/browser.json) | ~50 lines |
| Config types update | 1 existing (config/types.ts) | ~10 lines |
| Remove BrowserSessionManager | 1 existing (browser-session.ts) | Delete file |
| Remove agent-browser tool registration | 1 existing (executor.ts) | Remove ~250 lines |
| Remove agent-browser from package.json | 1 existing | 1 line |
| Add @playwright/mcp to package.json | 1 existing | 1 line |
| Web UI: update browser config panel | 1 existing | ~20 lines |
| Tests | 1-2 files | ~100-150 lines |
| **Total** | 5-7 files | ~270-520 lines (net reduction due to BrowserSessionManager removal) |

### Phase 2

| Component | Files | Scope |
|-----------|-------|-------|
| Add Lightpanda MCP config | 1 existing (index.ts) | ~20 lines |
| Add @lightpanda/browser to package.json | 1 existing | 1 line |
| Policy rules for Lightpanda tools | 1 existing (browser.json) | ~20 lines |
| **Total** | 2-3 files | ~40 lines |

## Decision Summary

| Factor | Playwright MCP Only | Lightpanda Only | Both (Recommended) |
|--------|--------------------|-----------------|--------------------|
| Web compatibility | Full | Partial (beta) | Full |
| Tool breadth | 55+ | 7 | 62+ |
| Resource usage | Heavy (~200MB) | Light (~24MB) | Heavy when automating, light when reading |
| Implementation effort | Minimal (MCP config) | Moderate (wrapper layer) | Minimal (two MCP configs) |
| License | Apache-2.0 | AGPL-3.0 core | Mixed |
| Windows support | Native | WSL2 only | Playwright native, Lightpanda WSL2 |
| Stability | High (real engines) | Beta | High for primary, beta for reads |
| Maintenance | Microsoft-backed | Community | Both |

**Proceed with Phase 1 (Playwright MCP) immediately. Evaluate Lightpanda for Phase 2 when it stabilizes.**
