# Proposal: Browser Automation

**Status:** Draft
**As-Built Spec:** [Browser Automation Spec](/mnt/s/Development/GuardianAgent/docs/specs/BROWSER-AUTOMATION-SPEC.md)
**Supersedes:** `agent-browser` integration (`src/tools/browser-session.ts`, browser tools in `src/tools/executor.ts`)
**Depends on:** MCP Client (`src/tools/mcp-client.ts`), Guardian admission pipeline, Policy-as-Code engine, sandbox subsystem
**Input proposals:** `docs/proposals/PLAYWRIGHT-MCP-BROWSER-PROPOSAL.md`, `docs/proposals/LIGHTPANDA-BROWSER-PROPOSAL.md`

---

## Overview

Replace the current `agent-browser` subprocess browser with two MCP-based browser backends:

- **Playwright MCP** (`@playwright/mcp`) — full browser automation via real Chromium/Firefox/WebKit. 55+ tools covering navigation, interaction, screenshots, file uploads, network interception, storage control, and more.
- **Lightpanda** (`@lightpanda/browser`) — lightweight headless browser for fast page reading. 7 MCP tools optimized for AI consumption: markdown extraction, semantic trees, structured data, and JS evaluation.

Both run as managed MCP servers over stdio, consumed through the existing `MCPClientManager` infrastructure. All tool calls pass through Guardian admission. The current `BrowserSessionManager` and `agent-browser` dependency are removed entirely.

**Key principles:**
- MCP-native — no custom browser process management, session tracking, or subprocess orchestration. MCPClientManager handles lifecycle, namespacing, and routing.
- Dual-backend by design — Playwright for full automation, Lightpanda for fast reads. The LLM selects tools naturally based on task.
- Security by default — dangerous tools (`browser_run_code`) denied by policy. Mutating tools require approval. All calls pass through Guardian.
- Lazy startup — browser processes only spawn when first tool call arrives. No resource consumption until needed.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  GuardianAgent Runtime                                            │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  ToolExecutor                                                │ │
│  │                                                              │ │
│  │  ┌──────────────────┐    ┌────────────────────────────────┐  │ │
│  │  │ Guardian Pipeline │───▶ MCPClientManager                │  │ │
│  │  │ • Capability      │    │                                │  │ │
│  │  │ • SSRF            │    │  ┌──────────────────────────┐  │  │ │
│  │  │ • SecretScan      │    │  │ MCPClient: playwright    │  │  │ │
│  │  │ • Policy Engine   │    │  │ transport: stdio         │  │  │ │
│  │  │ • GuardianAgent   │    │  │ tools: 55+ (core +       │  │  │ │
│  │  │   (Layer 2 LLM)   │    │  │   network, storage)      │  │  │ │
│  │  └──────────────────┘    │  └──────────┬───────────────┘  │  │ │
│  │                           │             │ stdin/stdout     │  │ │
│  │                           │  ┌──────────────────────────┐  │  │ │
│  │                           │  │ MCPClient: lightpanda    │  │  │ │
│  │                           │  │ transport: stdio         │  │  │ │
│  │                           │  │ tools: 7 (goto,          │  │  │ │
│  │                           │  │   markdown, links, etc.) │  │  │ │
│  │                           │  └──────────┬───────────────┘  │  │ │
│  │                           └─────────────┼──────────────────┘  │ │
│  └─────────────────────────────────────────┼─────────────────────┘ │
└─────────────────────────────────────────────┼─────────────────────┘
                                              │
          ┌───────────────────────────────────┼───────────────────┐
          │                                   │                   │
          ▼                                   ▼                   │
┌──────────────────┐              ┌──────────────────┐            │
│ Playwright MCP   │              │ Lightpanda       │            │
│ (Node.js)        │              │ (Zig binary)     │            │
│                  │              │                  │            │
│ ┌──────────────┐ │              │ ┌──────────────┐ │            │
│ │  Chromium    │ │              │ │  V8 + DOM    │ │            │
│ │  (headless)  │ │              │ │  (no render) │ │            │
│ │  ~200MB      │ │              │ │  ~24MB       │ │            │
│ └──────────────┘ │              │ └──────────────┘ │            │
│                  │              │                  │            │
│ Full web compat  │              │ Fast page reads  │            │
│ All interactions │              │ Markdown, struct  │            │
│ Screenshots, PDF │              │ data, semantic   │            │
│ Network mock     │              │ tree, JS eval    │            │
└──────────────────┘              └──────────────────┘
```

---

## What Gets Removed

### Files deleted

| File | Purpose | Replacement |
|------|---------|-------------|
| `src/tools/browser-session.ts` | BrowserSessionManager class | MCPClientManager handles lifecycle |
| `src/tools/browser-session.test.ts` | Tests for BrowserSessionManager | New integration tests |

### Code removed from existing files

| File | What | Lines (approx) |
|------|------|----------------|
| `src/tools/executor.ts` | `import { BrowserSessionManager, ... }` | 2 imports |
| `src/tools/executor.ts` | `private readonly browserSession` field + constructor init | ~5 lines |
| `src/tools/executor.ts` | Browser tool block (`// ── Browser Automation Tools`) | ~250 lines (9207–9456) |
| `src/tools/executor.ts` | `validateBrowserUrl`, `validateBrowserAction`, `validateElementRef` helpers | ~30 lines |
| `src/index.ts` | `hostRelevant` set reference to `browser_open`, `browser_action`, `browser_task` | 1 line update |
| `package.json` | `"agent-browser": "^0.16.0"` dependency | 1 line |

### Config types updated

| Type | Change |
|------|--------|
| `BrowserConfig` | Remove `binaryPath`, `sessionIdleTimeoutMs`, `maxSessions`. Add `playwrightEnabled`, `lightpandaEnabled`, `playwrightCaps`, `playwrightBrowser`. Keep `enabled`, `allowedDomains`. |

---

## Playwright MCP Integration

### Server Configuration

Playwright MCP runs as a managed MCP server registered at bootstrap.

```typescript
// Bootstrap — add Playwright MCP server when browser.enabled && browser.playwrightEnabled
const playwrightMCPConfig: MCPServerConfig = {
  id: 'playwright',
  name: 'Playwright Browser',
  transport: 'stdio',
  command: 'npx',
  args: [
    '@playwright/mcp@latest',
    '--headless',
    '--browser', config.assistant.tools.browser.playwrightBrowser ?? 'chromium',
    '--caps', config.assistant.tools.browser.playwrightCaps ?? 'network,storage',
    '--snapshot-mode', 'incremental',
  ],
  timeoutMs: 60_000,    // Navigation can be slow
  trustLevel: undefined, // Inferred per-tool from MCP metadata
  maxCallsPerMinute: 60,
};
```

### Tool Exposure

MCPClientManager auto-discovers and namespaces all tools:

| MCP Tool | GuardianAgent Name | Inferred Risk |
|----------|-------------------|---------------|
| `browser_navigate` | `mcp-playwright-browser_navigate` | `network` |
| `browser_click` | `mcp-playwright-browser_click` | `mutating` |
| `browser_type` | `mcp-playwright-browser_type` | `mutating` |
| `browser_select_option` | `mcp-playwright-browser_select_option` | `mutating` |
| `browser_press_key` | `mcp-playwright-browser_press_key` | `mutating` |
| `browser_drag` | `mcp-playwright-browser_drag` | `mutating` |
| `browser_fill_form` | `mcp-playwright-browser_fill_form` | `mutating` |
| `browser_snapshot` | `mcp-playwright-browser_snapshot` | `read_only` |
| `browser_take_screenshot` | `mcp-playwright-browser_take_screenshot` | `read_only` |
| `browser_evaluate` | `mcp-playwright-browser_evaluate` | `mutating` |
| `browser_run_code` | `mcp-playwright-browser_run_code` | `mutating` |
| `browser_console_messages` | `mcp-playwright-browser_console_messages` | `read_only` |
| `browser_network_requests` | `mcp-playwright-browser_network_requests` | `read_only` |
| `browser_file_upload` | `mcp-playwright-browser_file_upload` | `mutating` |
| `browser_handle_dialog` | `mcp-playwright-browser_handle_dialog` | `mutating` |
| `browser_resize` | `mcp-playwright-browser_resize` | `mutating` |
| `browser_wait_for` | `mcp-playwright-browser_wait_for` | `read_only` |
| `browser_close` | `mcp-playwright-browser_close` | `read_only` |
| `browser_tabs` | `mcp-playwright-browser_tabs` | `mutating` |
| `browser_navigate_back` | `mcp-playwright-browser_navigate_back` | `network` |
| `browser_install` | `mcp-playwright-browser_install` | `mutating` |
| `browser_route` | `mcp-playwright-browser_route` | `mutating` |
| `browser_route_list` | `mcp-playwright-browser_route_list` | `read_only` |
| `browser_unroute` | `mcp-playwright-browser_unroute` | `mutating` |
| `browser_cookie_*` | `mcp-playwright-browser_cookie_*` | `mutating` (set/delete/clear) or `read_only` (get/list) |
| `browser_localstorage_*` | `mcp-playwright-browser_localstorage_*` | `mutating` (set/delete/clear) or `read_only` (get/list) |
| `browser_sessionstorage_*` | `mcp-playwright-browser_sessionstorage_*` | `mutating` (set/delete/clear) or `read_only` (get/list) |
| `browser_storage_state` | `mcp-playwright-browser_storage_state` | `mutating` |
| `browser_set_storage_state` | `mcp-playwright-browser_set_storage_state` | `mutating` |
| `browser_pdf_save` | `mcp-playwright-browser_pdf_save` | `mutating` |
| `browser_start_tracing` | `mcp-playwright-browser_start_tracing` | `mutating` |
| `browser_stop_tracing` | `mcp-playwright-browser_stop_tracing` | `mutating` |
| `browser_start_video` | `mcp-playwright-browser_start_video` | `mutating` |
| `browser_stop_video` | `mcp-playwright-browser_stop_video` | `mutating` |

All tools use `deferLoading: true` (MCP tools are never always-loaded). Discovery happens via `find_tools` meta-tool.

### Capabilities Configuration

Playwright MCP exposes tools in capability groups. GuardianAgent controls which groups are enabled via `playwrightCaps`:

| Capability | Default | Tools Added | Security Note |
|------------|---------|-------------|---------------|
| `core` | Always on | 22 tools (navigate, click, type, snapshot, evaluate, etc.) | `browser_run_code` denied by policy |
| `network` | On | 3 tools (route, unroute, route_list) | Network mocking — mutating risk |
| `storage` | On | 16 tools (cookies, localStorage, sessionStorage, state) | Session manipulation — mutating risk |
| `vision` | Off | 6 tools (coordinate-based mouse) | Requires vision-capable LLM |
| `devtools` | Off | 4 tools (tracing, video) | Performance debugging |
| `pdf` | Off | 1 tool (pdf_save) | File output |
| `testing` | Off | 5 tools (assertions, locator generation) | Testing workflows |
| `config` | Off | 1 tool (get_config) | Read-only introspection |

Default: `core,network,storage` (41 tools). Configurable via `assistant.tools.browser.playwrightCaps`.

---

## Lightpanda Integration

### Server Configuration

Lightpanda runs as a second managed MCP server. Optional — enabled separately from Playwright.

```typescript
// Bootstrap — add Lightpanda MCP server when browser.enabled && browser.lightpandaEnabled
const lightpandaMCPConfig: MCPServerConfig = {
  id: 'lightpanda',
  name: 'Lightpanda Browser',
  transport: 'stdio',
  command: 'lightpanda',
  args: ['mcp'],
  timeoutMs: 30_000,
  trustLevel: undefined,
  maxCallsPerMinute: 120,  // Higher limit — lightweight reads
};
```

### Tool Exposure

| MCP Tool | GuardianAgent Name | Inferred Risk |
|----------|-------------------|---------------|
| `goto` | `mcp-lightpanda-goto` | `network` |
| `markdown` | `mcp-lightpanda-markdown` | `read_only` |
| `links` | `mcp-lightpanda-links` | `read_only` |
| `evaluate` | `mcp-lightpanda-evaluate` | `mutating` |
| `semantic_tree` | `mcp-lightpanda-semantic_tree` | `read_only` |
| `interactiveElements` | `mcp-lightpanda-interactiveElements` | `read_only` |
| `structuredData` | `mcp-lightpanda-structuredData` | `read_only` |

### When to Use Which

The LLM selects tools naturally based on task. Tool descriptions guide selection:

| Task | Preferred Backend | Why |
|------|------------------|-----|
| Read an article, extract content | Lightpanda (`goto` + `markdown`) | 11x faster, 8x less memory |
| Extract JSON-LD / OpenGraph metadata | Lightpanda (`structuredData`) | Native tool, no JS needed |
| Get page link map for crawling | Lightpanda (`links`) | Purpose-built, lightweight |
| Fill a form and submit | Playwright (`browser_type` + `browser_click`) | Full interaction support |
| Log into a website | Playwright (`browser_type` + `browser_click` + `browser_storage_state`) | Auth state persistence |
| Upload a file | Playwright (`browser_file_upload`) | Not available in Lightpanda |
| Take a screenshot | Playwright (`browser_take_screenshot`) | Real screenshots |
| Mock API responses for testing | Playwright (`browser_route`) | Network interception |
| Interact with a complex SPA | Playwright (various) | Full Chromium compatibility |
| High-volume page scraping | Lightpanda (`goto` + `markdown` loop) | Resource-efficient |

No explicit routing logic is implemented. Both tool sets are available simultaneously and the LLM picks based on the task description and tool names/descriptions.

---

## Policy Rules

### New Policy File: `policies/base/browser.json`

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "browser-deny-run-code",
      "family": "tool",
      "enabled": true,
      "priority": 50,
      "description": "Block arbitrary Playwright code execution — too powerful for agent use",
      "match": {
        "action": "tool:mcp-playwright-browser_run_code"
      },
      "decision": {
        "kind": "deny",
        "reason": "Arbitrary Playwright code execution is blocked by policy"
      }
    },
    {
      "id": "browser-deny-install",
      "family": "tool",
      "enabled": true,
      "priority": 50,
      "description": "Block browser_install — managed by operator, not by the agent",
      "match": {
        "action": "tool:mcp-playwright-browser_install"
      },
      "decision": {
        "kind": "deny",
        "reason": "Browser installation is managed by the operator"
      }
    },
    {
      "id": "browser-approve-evaluate-playwright",
      "family": "tool",
      "enabled": true,
      "priority": 80,
      "description": "Require approval for Playwright JS evaluation",
      "match": {
        "action": "tool:mcp-playwright-browser_evaluate"
      },
      "decision": {
        "kind": "require_approval",
        "reason": "JavaScript evaluation on a web page requires approval"
      }
    },
    {
      "id": "browser-approve-evaluate-lightpanda",
      "family": "tool",
      "enabled": true,
      "priority": 80,
      "description": "Require approval for Lightpanda JS evaluation",
      "match": {
        "action": "tool:mcp-lightpanda-evaluate"
      },
      "decision": {
        "kind": "require_approval",
        "reason": "JavaScript evaluation on a web page requires approval"
      }
    },
    {
      "id": "browser-approve-file-upload",
      "family": "tool",
      "enabled": true,
      "priority": 80,
      "description": "Require approval for browser file uploads",
      "match": {
        "action": "tool:mcp-playwright-browser_file_upload"
      },
      "decision": {
        "kind": "require_approval",
        "reason": "File upload to a website requires approval",
        "obligations": ["log_command"]
      }
    },
    {
      "id": "browser-approve-storage-state",
      "family": "tool",
      "enabled": true,
      "priority": 80,
      "description": "Require approval for saving/restoring auth state",
      "match": {
        "action": {
          "in": [
            "tool:mcp-playwright-browser_storage_state",
            "tool:mcp-playwright-browser_set_storage_state"
          ]
        }
      },
      "decision": {
        "kind": "require_approval",
        "reason": "Saving or restoring browser auth state requires approval"
      }
    }
  ]
}
```

### How Policy Interacts With Existing Rules

The existing `policies/base/tools.json` rules still apply as fallbacks:

1. `browser-deny-run-code` (priority 50) fires first for `browser_run_code` → **deny**
2. `browser-approve-evaluate-*` (priority 80) fires for `evaluate` tools → **require_approval**
3. For all other browser tools, the existing rules apply:
   - `tool-read-only-allow` (priority 100) allows `browser_snapshot`, `browser_console_messages`, etc.
   - `tool-network-readonly-allow` (priority 100) allows `browser_navigate`, `browser_navigate_back`
   - `tool-mutating-approval` (priority 300) catches remaining mutating tools (`browser_click`, `browser_type`, etc.)
4. In `autonomous` mode, `tool-autonomous-allow-all` (priority 200) overrides everything except explicit denies

---

## Configuration

### Config Types

```typescript
interface BrowserConfig {
  /** Master switch for all browser tooling. Default: true */
  enabled: boolean;

  /** Enable Playwright MCP backend. Default: true */
  playwrightEnabled: boolean;

  /** Enable Lightpanda MCP backend. Default: false (Phase 2) */
  lightpandaEnabled: boolean;

  /** Playwright browser engine. Default: 'chromium' */
  playwrightBrowser?: 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'msedge';

  /** Playwright MCP capability groups. Default: 'network,storage' */
  playwrightCaps?: string;

  /** Domain allowlist for browser navigation. Falls back to tools.allowedDomains. */
  allowedDomains?: string[];

  /** Playwright CLI extra args (proxy, user-agent, viewport, etc.) */
  playwrightArgs?: string[];

  /** Lightpanda binary path override. Default: 'lightpanda' */
  lightpandaBinaryPath?: string;
}
```

### YAML Examples

**Minimal (Playwright only, defaults):**
```yaml
assistant:
  tools:
    browser:
      enabled: true
```

**Both backends:**
```yaml
assistant:
  tools:
    browser:
      enabled: true
      playwrightEnabled: true
      lightpandaEnabled: true
      playwrightBrowser: chromium
      playwrightCaps: 'network,storage'
      allowedDomains:
        - example.com
        - '*.internal.corp'
```

**Playwright with proxy and custom viewport:**
```yaml
assistant:
  tools:
    browser:
      enabled: true
      playwrightArgs:
        - '--proxy-server'
        - 'http://proxy.corp:8080'
        - '--viewport-size'
        - '1280x720'
        - '--user-agent'
        - 'GuardianAgent/1.0'
```

**Playwright with vision mode (for vision-capable LLMs):**
```yaml
assistant:
  tools:
    browser:
      enabled: true
      playwrightCaps: 'network,storage,vision'
```

### Defaults

```typescript
const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  playwrightEnabled: true,
  lightpandaEnabled: false,  // Phase 2
  playwrightBrowser: 'chromium',
  playwrightCaps: 'network,storage',
};
```

---

## Bootstrap Wiring

### In `src/index.ts`

The browser MCP servers are registered through `MCPClientManager`, but browser automation does not require `assistant.tools.mcp.enabled: true`. If the general MCP subsystem has not already created a manager, the browser bootstrap path creates one itself. Registration still depends on browser tooling being enabled and the sandbox allowing MCP-backed subprocesses.

```typescript
// ── Browser MCP Providers ────────────────────────────────────────
const browserConfig = config.assistant?.tools?.browser;
if (browserConfig?.enabled !== false && !mcpBlockedBySandbox) {
  if (!mcpManager) {
    mcpManager = new MCPClientManager(sandboxConfig);
  }
  // Playwright MCP
  if (browserConfig?.playwrightEnabled !== false) {
    const playwrightArgs = [
      '@playwright/mcp@latest',
      '--headless',
      '--browser', browserConfig?.playwrightBrowser ?? 'chromium',
      '--caps', browserConfig?.playwrightCaps ?? 'network,storage',
      '--snapshot-mode', 'incremental',
      ...(browserConfig?.playwrightArgs ?? []),
    ];
    try {
      await mcpManager.addServer({
        id: 'playwright',
        name: 'Playwright Browser',
        transport: 'stdio',
        command: 'npx',
        args: playwrightArgs,
        timeoutMs: 60_000,
        maxCallsPerMinute: 60,
      });
      log.info({ tools: mcpManager.getClient('playwright')?.getTools().length },
        'Playwright MCP browser connected');
    } catch (err) {
      log.warn({ err }, 'Playwright MCP failed to start — browser automation unavailable');
    }
  }

  // Lightpanda (Phase 2)
  if (browserConfig?.lightpandaEnabled) {
    try {
      await mcpManager.addServer({
        id: 'lightpanda',
        name: 'Lightpanda Browser',
        transport: 'stdio',
        command: browserConfig?.lightpandaBinaryPath ?? 'lightpanda',
        args: ['mcp'],
        timeoutMs: 30_000,
        maxCallsPerMinute: 120,
      });
      log.info({ tools: mcpManager.getClient('lightpanda')?.getTools().length },
        'Lightpanda MCP browser connected');
    } catch (err) {
      log.warn({ err }, 'Lightpanda MCP failed to start — lightweight browser reads unavailable');
    }
  }
}
```

### Sandbox Interaction

Both MCP servers inherit the standard MCP sandbox behavior:
- Spawned via `sandboxedSpawn()` with `profile: 'workspace-write'`, `networkAccess: true`
- In `strict` sandbox mode, MCP is disabled entirely (existing behavior) — browser tools unavailable
- In `permissive` mode, both servers start normally

### Host Monitoring Integration

Update the `hostRelevant` tool set in the host-monitoring self-policing logic:

```typescript
// Before:
const hostRelevant = new Set(['shell_safe', 'browser_open', 'browser_action', 'browser_task', 'net_connections', 'sys_processes']);

// After:
const hostRelevant = new Set([
  'shell_safe', 'net_connections', 'sys_processes',
  'mcp-playwright-browser_navigate', 'mcp-playwright-browser_click',
  'mcp-playwright-browser_type', 'mcp-playwright-browser_evaluate',
  'mcp-playwright-browser_run_code', 'mcp-playwright-browser_file_upload',
  'mcp-lightpanda-goto', 'mcp-lightpanda-evaluate',
]);
```

---

## Security Analysis

### Threat: Arbitrary code execution via `browser_run_code`

`browser_run_code` accepts arbitrary Playwright API code as a string and executes it. This is effectively `eval()` with full browser control.

- **Risk:** Critical — can navigate anywhere, extract credentials, exfiltrate data, interact with authenticated sessions
- **Mitigation:** Denied by policy rule `browser-deny-run-code` (priority 50). Cannot be overridden by mode-based rules (they have higher priority numbers but explicit deny takes precedence). Only removable by operator editing the policy file.
- **Residual risk:** Operator misconfiguration (removing the deny rule). Acceptable — operators own their policy.

### Threat: JavaScript evaluation via `browser_evaluate`

`browser_evaluate` runs a JavaScript function on the current page. Less powerful than `browser_run_code` (scoped to page context, not Playwright API) but still capable of data extraction and DOM manipulation.

- **Risk:** High — can read page content, extract tokens from DOM, submit forms via JS
- **Mitigation:** Requires approval via policy rule `browser-approve-evaluate-*`. Guardian Agent (Layer 2) LLM evaluates the expression before execution. Both Playwright and Lightpanda `evaluate` tools gated identically.
- **Residual risk:** Approved expressions could still exfiltrate data from the page. Output Guardian scans results for secrets.

### Threat: Auth state persistence via `browser_storage_state`

`browser_storage_state` saves cookies, localStorage, and sessionStorage to a JSON file. `browser_set_storage_state` restores them. This persists authenticated sessions.

- **Risk:** High — saved state files contain session tokens and cookies
- **Mitigation:** Requires approval via policy rule. Output path validated against `allowedPaths`. File access restricted by sandbox. Secret scanner catches leaked tokens in tool output.
- **Residual risk:** Saved state files on disk contain raw credentials. Operator should use encrypted storage or restrict file permissions.

### Threat: SSRF via browser navigation

Playwright MCP has `--allowed-origins` and `--blocked-origins` but explicitly states these are "not a security boundary."

- **Risk:** Agent navigates to internal/private URLs via the browser
- **Mitigation:** GuardianAgent's SSRF controller validates URLs in tool arguments before the MCP call reaches Playwright. Private IPs (RFC1918), loopback, link-local, cloud metadata, and obfuscated IPs are blocked at the Guardian admission layer.
- **Implementation:** Add SSRF pre-check in MCPClientManager or a new browser-specific admission controller that intercepts `url` arguments in `browser_navigate` and `goto` tool calls.
- **Residual risk:** Playwright page could follow redirects to private IPs after initial navigation. Mitigated by Playwright's own origin controls (`--blocked-origins`) as defense-in-depth, but not a hard boundary.

### Threat: Lightpanda stability (beta)

Lightpanda v0.2.5 is beta. Segfaults reported on some sites. Partial Web API coverage.

- **Risk:** Browser process crashes mid-task, partial page rendering produces wrong data
- **Mitigation:** MCPClient handles process exit and reconnection. Lightpanda failures don't affect Playwright. Operator can disable Lightpanda (`lightpandaEnabled: false`) if stability is insufficient.
- **Residual risk:** Silent incorrect rendering (page JS fails, partial DOM returned). Acceptable for read-only extraction — the LLM can detect incomplete content and retry with Playwright.

### Threat: Tool surface overwhelming the LLM

55+ Playwright tools plus 7 Lightpanda tools = 62+ browser tools in the tool list.

- **Risk:** LLM tool selection quality degrades with too many tools
- **Mitigation:** All browser tools use `deferLoading: true`. They are not in the always-loaded tool set. The LLM discovers them via `find_tools` when it needs browser capabilities. `shortDescription` fields keep token usage low. Capability groups (`playwrightCaps`) control which tools are exposed.

### License Safety

| Package | License | Model | AGPL Risk |
|---------|---------|-------|-----------|
| `@playwright/mcp` | Apache-2.0 | npm dependency | None |
| `playwright` | Apache-2.0 | npm dependency | None |
| `@lightpanda/browser` | Apache-2.0 (wrapper) | npm dependency | None |
| Lightpanda binary | AGPL-3.0 | Unmodified subprocess | None — stdio communication, no modification or distribution |

---

## SSRF Pre-Check for Browser Navigation

Browser navigation tools need SSRF validation before the URL reaches the MCP server. This is handled by adding URL extraction logic to the existing Guardian admission flow for MCP tool calls.

### Implementation

In `MCPClient.callTool()` or as an MCP-specific admission controller, extract and validate URL arguments for known browser navigation tools:

```typescript
const BROWSER_NAV_TOOLS = new Set([
  'browser_navigate',  // Playwright
  'goto',              // Lightpanda
]);

function extractBrowserUrl(toolName: string, args: Record<string, unknown>): string | undefined {
  // Strip MCP prefix to get original tool name
  const baseName = toolName.replace(/^mcp-[a-zA-Z0-9_]+-/, '');
  if (BROWSER_NAV_TOOLS.has(baseName) && typeof args.url === 'string') {
    return args.url;
  }
  return undefined;
}
```

The extracted URL is checked against:
1. `isPrivateAddress()` from SSRF module
2. Domain allowlist from `browser.allowedDomains` or `tools.allowedDomains`
3. Standard Guardian admission pipeline (SecretScan, DeniedPath, etc.)

If the URL fails validation, the tool call is denied before reaching the MCP server.

---

## Dependencies

### npm packages to add

```json
{
  "dependencies": {
    "@playwright/mcp": "^0.0.68"
  },
  "optionalDependencies": {
    "@lightpanda/browser": "^0.2.5"
  }
}
```

### npm packages to remove

```json
{
  "dependencies": {
    "agent-browser": "^0.16.0"  // REMOVE
  }
}
```

### Installation Model

**`@playwright/mcp`** requires two install steps:

1. `npm install` — downloads the npm package + `playwright` + `playwright-core` (~60MB)
2. `npx playwright install chromium` — downloads the Chromium browser binary (~150MB)

Step 2 is **not automatic** from `npm install`. The platform start scripts (`scripts/start-dev-unix.sh`, `scripts/start-dev-windows.ps1`) handle this by checking for `@playwright/mcp` in `node_modules` and running `npx playwright install chromium` if the browser is missing. This runs once during initial setup and is skipped on subsequent starts.

On Debian/Ubuntu, Chromium may also need OS-level dependencies:
```bash
npx playwright install-deps chromium
```
This installs shared libraries (libglib, libnss, etc.). The start scripts do not automate this because it requires `sudo`. If Chromium fails to launch, the error message directs the operator to run this manually.

**`@lightpanda/browser`** (Phase 2, optional dependency) handles everything automatically:
- npm postinstall downloads the platform-specific binary (~15MB)
- No additional steps needed

Browser MCP startup is independent of the general MCP config toggle. On a fresh install, browser tools can register without setting `assistant.tools.mcp.enabled: true`, as long as browser tooling is enabled and the required browser binary is available.

**Graceful degradation:** If either browser binary is unavailable, the corresponding MCP server fails to start with a warning log. Browser tools for that backend are simply not registered. The other backend (if enabled) continues to work independently.

### System requirements

- Node.js >= 20 (GuardianAgent requirement)
- For Playwright: OS-level dependencies for Chromium (on Debian/Ubuntu: `npx playwright install-deps chromium`)
- For Lightpanda: Linux x86_64/aarch64 or macOS; Windows requires WSL2

---

## Web UI Changes

### Configuration > Tools Tab

Update the browser configuration panel:

- Replace "agent-browser binary path" with Playwright/Lightpanda toggles
- Add browser engine selector (Chromium, Firefox, WebKit)
- Add capability group checkboxes (network, storage, vision, devtools, pdf, testing)
- Add Lightpanda enable toggle with "(beta)" label
- Keep domain allowlist editor

### Dashboard

- Browser MCP server status shown alongside other MCP servers in the MCP status section
- No separate "browser session" panel needed (MCP lifecycle replaces session management)
- On successful startup, logs include `Playwright MCP browser connected` and optionally `Lightpanda MCP browser connected`

---

## System Prompt Updates

### In `src/prompts/guardian-core.ts`

Update the browser tool guidance section:

```
Browser Automation:
You have access to two browser backends via MCP tools:
- Playwright (mcp-playwright-*): Full browser automation. Use for clicking, typing, form filling,
  file uploads, screenshots, and any interactive web task. Real Chromium engine — works with all sites.
- Lightpanda (mcp-lightpanda-*): Lightweight page reader. Use for reading articles, extracting
  links, getting structured data (JSON-LD, OpenGraph), and semantic page analysis. Much faster and
  lighter than Playwright — prefer this for read-only page tasks.

For page reading: use mcp-lightpanda-goto + mcp-lightpanda-markdown (fast, lightweight).
For web interaction: use mcp-playwright-browser_navigate + browser_click/type/etc (full automation).
Do not use browser_run_code — it is blocked by policy.
```

### Reference Guide Update

Update `src/reference-guide.ts` to document the new browser capabilities, tool names, and the dual-backend model.

---

## Testing

### Unit Tests

- Policy rule evaluation: verify `browser-deny-run-code` denies, `browser-approve-evaluate-*` requires approval, read-only tools allow
- SSRF pre-check: verify private IPs blocked for `browser_navigate` and `goto` tool arguments
- Config defaults: verify `playwrightEnabled: true`, `lightpandaEnabled: false` defaults
- Bootstrap wiring: verify MCP servers registered when config enables them, not registered when disabled

### Integration Tests

- Playwright MCP connection: verify MCPClient connects, discovers tools, correct namespacing
- Lightpanda MCP connection (when available): verify same
- Tool call flow: verify Guardian admission → MCP call → result scan pipeline
- Sandbox enforcement: verify MCP servers blocked in strict mode
- Graceful degradation: verify Playwright failure doesn't break Lightpanda and vice versa
- Hot-reload: verify browser config changes apply without restart

### Manual Testing Checklist

- [ ] Navigate to a public URL via Playwright — verify page loads, snapshot returned
- [ ] Click a button via Playwright — verify approval prompt, action executes
- [ ] Fill and submit a form — verify multi-step interaction works
- [ ] Read a page via Lightpanda — verify markdown returned
- [ ] Extract structured data via Lightpanda — verify JSON-LD/OpenGraph returned
- [ ] Attempt `browser_run_code` — verify denied by policy
- [ ] Attempt `browser_evaluate` — verify approval required
- [ ] Navigate to private IP — verify SSRF blocked before MCP call
- [ ] Disable Playwright in config — verify tools not registered
- [ ] Enable Lightpanda — verify tools registered alongside Playwright
- [ ] Run in strict sandbox mode — verify all browser MCP tools unavailable

---

## Migration Checklist

### Phase 1: Playwright MCP (immediate)

- [ ] Add `@playwright/mcp` to `package.json` dependencies
- [ ] Remove `agent-browser` from `package.json` dependencies
- [ ] Delete `src/tools/browser-session.ts`
- [ ] Delete `src/tools/browser-session.test.ts`
- [ ] Remove BrowserSessionManager import and field from `src/tools/executor.ts`
- [ ] Remove browser tool registration block (lines ~9207-9456) from `src/tools/executor.ts`
- [ ] Remove `validateBrowserUrl`, `validateBrowserAction`, `validateElementRef` helpers from `src/tools/executor.ts`
- [ ] Update `BrowserConfig` in `src/config/types.ts` — remove old fields, add new fields
- [ ] Update `DEFAULT_CONFIG` browser defaults in `src/config/types.ts`
- [ ] Add Playwright MCP server registration to `src/index.ts` bootstrap
- [ ] Add SSRF pre-check for browser navigation tool URLs
- [ ] Update `hostRelevant` set in `src/index.ts`
- [ ] Create `policies/base/browser.json` with deny/approve rules
- [ ] Update system prompt in `src/prompts/guardian-core.ts`
- [ ] Update `src/reference-guide.ts`
- [ ] Update web UI browser config panel
- [ ] Update `docs/guides/WEB-TOOLS-GUIDE.md`
- [ ] Write tests
- [ ] Update README, SECURITY.md, CLAUDE.md browser references

### Phase 2: Add Lightpanda (when stable)

- [ ] Add `@lightpanda/browser` to `package.json` optionalDependencies
- [ ] Add Lightpanda MCP server registration to `src/index.ts` bootstrap (conditional on `lightpandaEnabled`)
- [ ] Add `browser-approve-evaluate-lightpanda` to `policies/base/browser.json`
- [ ] Update system prompt with Lightpanda tool guidance
- [ ] Update reference guide, web UI
- [ ] Write tests for Lightpanda MCP connection and tool flow

---

## Future Considerations

- **Playwright extension mode** (`--extension`): Connect to a user's running Chrome/Edge browser with existing logged-in sessions. Powerful for authenticated workflows but significant security surface — would need its own policy analysis.
- **Persistent browser profiles** (`--user-data-dir`): Persist browser state across GuardianAgent restarts for long-running authenticated sessions. Needs credential storage analysis.
- **Multi-browser**: Run multiple Playwright MCP instances with different engines (Chromium + Firefox) for cross-browser testing workflows.
- **Lightpanda CDP mode**: If Lightpanda's MCP mode proves insufficient, its CDP mode could be consumed via `puppeteer-core` for more control. Lower priority — MCP mode covers the read-only use case well.
- **Browser pool**: For high-concurrency workloads, a pool of Playwright MCP instances behind a load-balancing MCPClientManager. Not needed for personal assistant use.
