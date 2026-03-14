# Lightpanda Browser Integration Proposal

## Summary

Replace the current `agent-browser` dependency with [Lightpanda](https://github.com/lightpanda-io/browser) as GuardianAgent's headless browser backend. Lightpanda is a purpose-built headless browser for AI agents — written in Zig with V8 for JavaScript, no rendering engine — that is 11x faster and uses 19x less memory than headless Chrome. It offers three integration modes: one-shot fetch, CDP WebSocket server, and MCP stdio server.

## Problem

The current browser tooling uses `agent-browser` (v0.16.0), a subprocess-based headless browser CLI. It works, but:

1. **Resource-heavy** — Built on Chromium internals, carries the full rendering pipeline even though GuardianAgent never needs visual output
2. **Generic** — Designed as a general-purpose headless browser, not optimized for AI agent workflows
3. **Limited extraction** — Returns accessibility snapshots capped at 8K chars; no structured data extraction, no markdown conversion, no semantic tree
4. **No JS evaluation** — `browser_action` supports only a fixed set of interactions (click, fill, select, press, scroll, hover); cannot evaluate expressions or extract computed values
5. **Single integration mode** — Subprocess CLI only; no persistent server mode for session reuse across tool calls without session management overhead

## Lightpanda Overview

Lightpanda is a headless browser built from scratch — not based on Chromium, Blink, or WebKit. It eliminates CSS layout, painting, GPU compositing, and image decoding entirely, focusing on DOM construction and JavaScript execution.

| Property | Value |
|----------|-------|
| Language | Zig (with V8 for JS, html5ever for HTML parsing) |
| License | AGPL-3.0 (core), Apache-2.0 (npm wrapper) |
| Version | v0.2.5 (beta) |
| Stars | 15,200+ |
| Platforms | Linux x86_64/aarch64, macOS x86_64/aarch64, WSL2 |
| npm | `@lightpanda/browser` (downloads binary on postinstall) |
| Modes | `fetch` (one-shot), `serve` (CDP WebSocket), `mcp` (stdio) |

### Performance (vs headless Chrome)

| Metric | Lightpanda | Chrome | Improvement |
|--------|-----------|--------|-------------|
| 100 page loads | 1.7s | 18.6s | 11x faster |
| Peak memory (100 pages) | 24MB | 207MB | 8.6x less |
| CPU usage | 4.6% | 158.6% | 34x less |
| 933 URLs concurrent | 5.2s, 410MB | 69 min, 4.2GB | ~800x faster |

### MCP Tools (stdio mode)

| Tool | Description |
|------|-------------|
| `goto` | Navigate to URL |
| `markdown` | Convert current page DOM to markdown |
| `links` | Extract all links from current page |
| `evaluate` | Execute JavaScript expression and return result |
| `semantic_tree` | Get accessibility/semantic tree of page |
| `interactiveElements` | List all interactive elements (buttons, inputs, links) |
| `structuredData` | Extract JSON-LD, OpenGraph, and other structured metadata |

Plus resources: `mcp://page/html` and `mcp://page/markdown`.

### CDP Domains (serve mode)

Page, Runtime, DOM, Network, Fetch (request interception), Input (click/type), Target, Browser, Emulation, CSS, Accessibility, Performance, Security, Storage.

### Known Limitations

- **Beta stability** — Segfaults reported on some sites (nist.gov, complex SPAs)
- **Partial Web API coverage** — Growing but incomplete; some React/Vue SPAs may not render fully
- **Single page per connection** — Parallelism requires multiple processes
- **No WASM support** — Sites relying on WebAssembly will fail
- **No real screenshots** — `captureScreenshot` returns a placeholder (same as current system)
- **Bot detection** — Sites like Google actively fingerprint and block it
- **CDP `Page.navigate` hangs** on some sites (e.g., Wikipedia — tracked in issue #1801)

## Current System

```
GuardianAgent Runtime
  └─ BrowserSessionManager (src/tools/browser-session.ts)
       └─ agent-browser CLI (subprocess per command)
            └─ Chromium headless internals

Tools: browser_open, browser_action, browser_snapshot, browser_close, browser_task
Risk:  browser_action = mutating (requires approval), others = network/read_only
Sandbox: workspace-write profile, networkAccess: true
```

The current system works well — sessions are keyed by userId:channel, element references are regex-validated, domains are allowlisted, and all calls go through Guardian admission. The architecture (subprocess model, security gating, session management) is sound. The question is whether the browser backend itself should change.

## Integration Options

### Option A: Managed MCP Provider (Recommended)

Register Lightpanda as a managed MCP provider, similar to how Google Workspace is integrated. Lightpanda's MCP mode (`./lightpanda mcp`) runs over stdio — exactly what MCPClientManager already handles.

```
GuardianAgent Runtime
  └─ MCPClientManager
       └─ Lightpanda MCP server (stdio subprocess)

Tools auto-registered: mcp-lightpanda-goto, mcp-lightpanda-markdown, etc.
All calls pass through full Guardian admission pipeline.
```

**Advantages:**
- Minimal new code — MCPClientManager, Guardian admission, tool namespacing, and per-server trust/rate-limit config already exist
- High-level tools purpose-built for AI agent consumption (markdown, semantic_tree, structuredData, interactiveElements)
- The `evaluate` tool lets the AI run targeted JS expressions for data extraction and interaction
- Clean process lifecycle managed by MCPClientManager
- Tool descriptions come from Lightpanda's MCP manifest — no maintenance burden

**Disadvantages:**
- Tool names are namespaced (`mcp-lightpanda-*`) rather than clean (`browser_*`)
- Less control over tool input/output formatting than custom tools
- `evaluate` tool exposes arbitrary JS execution — needs Guardian policy gating (see Security section)
- Single page per MCP session — multi-page workflows need session coordination

**Implementation scope:** ~200 lines of config/bootstrap code. Zero new tool definitions.

### Option B: CDP Client with Custom Tools

Run Lightpanda in CDP serve mode and connect with `puppeteer-core`. Replace `BrowserSessionManager` with a `LightpandaSessionManager` that wraps Puppeteer operations into the existing tool interface.

```
GuardianAgent Runtime
  └─ LightpandaSessionManager (new)
       └─ puppeteer-core (npm)
            └─ CDP WebSocket
                 └─ Lightpanda serve (subprocess on port 9222)
```

**Advantages:**
- Full control over tool definitions, names, descriptions, and I/O formatting
- Can maintain the existing tool API (`browser_open`, `browser_action`, etc.) for backward compatibility
- Puppeteer gives access to network interception, cookie management, and fine-grained page control
- Can add new capabilities (JS evaluation, structured data extraction) as controlled tool parameters rather than open-ended MCP tools

**Disadvantages:**
- Adds `puppeteer-core` as a dependency (~4MB)
- More code to write and maintain (~500-800 lines replacing browser-session.ts)
- Must manage Lightpanda process lifecycle separately (start serve, health-check, restart on crash)
- CDP protocol versioning — Lightpanda's partial CDP implementation may diverge from what Puppeteer expects

### Option C: Hybrid (MCP Primary + Custom Wrappers)

Use MCP mode as the transport but wrap Lightpanda's MCP tools in custom tool definitions that match GuardianAgent's existing conventions. This gives clean tool names while using the MCP protocol internally.

```
GuardianAgent Runtime
  └─ LightpandaBrowserProvider (new, thin wrapper)
       └─ MCPClient (existing)
            └─ Lightpanda MCP server (stdio)

Tools: browser_navigate, browser_read, browser_interact, browser_extract, browser_close
Each wraps one or more MCP tool calls with validation and formatting.
```

**Advantages:**
- Clean tool names and descriptions tailored to GuardianAgent's UX
- Uses MCP transport (proven, existing infrastructure) without exposing raw MCP tool naming
- Can compose multiple MCP calls into single high-level operations (e.g., `browser_interact` could call `interactiveElements` → `evaluate` in sequence)
- Can gate or omit specific MCP tools (e.g., restrict `evaluate` to read-only expressions)
- Maintains familiar tool API for the AI assistant

**Disadvantages:**
- More code than Option A (~300-400 lines for the wrapper layer)
- Wrapper layer must stay in sync with Lightpanda's MCP tool schema changes
- Double-layered abstraction (custom tool → MCP call → Lightpanda)

## Recommendation: Option C (Hybrid)

Option C gives the best balance of capability, security control, and integration cleanliness. The rationale:

1. **Tool UX matters** — The AI assistant works better with well-named, well-described tools (`browser_navigate`) than namespaced MCP identifiers (`mcp-lightpanda-goto`)
2. **Security control on `evaluate`** — Wrapping lets us restrict JS evaluation to read-only expressions or specific patterns, rather than exposing arbitrary code execution
3. **Composability** — A `browser_interact` tool can call `interactiveElements` to discover targets, then `evaluate` to act on them, in a single tool invocation — reducing multi-step orchestration overhead
4. **MCP transport is proven** — MCPClient already handles JSON-RPC, process lifecycle, error recovery, and timeouts
5. **Moderate scope** — ~300-400 lines of wrapper code, no new dependencies beyond `@lightpanda/browser`

## Proposed Tool Definitions

Replace the current 5 browser tools with 6 Lightpanda-backed tools:

| Tool | Lightpanda MCP Calls | Risk | Description |
|------|---------------------|------|-------------|
| `browser_navigate` | `goto` | `network` | Navigate to a URL; returns page title and status |
| `browser_read` | `markdown` | `read_only` | Get current page content as clean markdown |
| `browser_links` | `links` | `read_only` | Get all links on the current page with text and href |
| `browser_interact` | `interactiveElements` + `evaluate` | `mutating` | List interactive elements, or act on one (click, fill, select) |
| `browser_extract` | `structuredData` + `semantic_tree` | `read_only` | Extract structured data (JSON-LD, OpenGraph) and/or semantic tree |
| `browser_evaluate` | `evaluate` | `mutating` | Evaluate a JavaScript expression on the page (restricted) |

**Approval behavior under `approve_by_policy`:**
- `browser_navigate`, `browser_read`, `browser_links`, `browser_extract` — auto-allowed
- `browser_interact`, `browser_evaluate` — requires approval

### Tool Details

**`browser_navigate`** — Replaces `browser_open`
```
Input:  { url: string }
Output: { title: string, url: string, status: string }
Guards: URL validation, SSRF check, domain allowlist
```

**`browser_read`** — Replaces `browser_task` (one-shot read) and `browser_snapshot`
```
Input:  { maxChars?: number }
Output: { markdown: string, url: string }
Guards: Output truncation (default 12K chars — markdown is denser than accessibility snapshots)
```

**`browser_links`** — New capability
```
Input:  { filter?: string }
Output: { links: Array<{ text: string, href: string }> }
Guards: Output truncation
```

**`browser_interact`** — Replaces `browser_action`
```
Input:  { action: 'list' | 'click' | 'fill' | 'select', element?: string, value?: string }
Output: { elements?: Array<{ ref: string, type: string, text: string }>, result?: string }
Guards: Element reference validation, value sanitization
Implementation:
  - action=list → calls interactiveElements
  - action=click/fill/select → calls evaluate with a constructed expression
    e.g., click → document.querySelector('[data-ref="btn_submit"]').click()
```

**`browser_extract`** — New capability
```
Input:  { type: 'structured' | 'semantic' | 'both' }
Output: { structuredData?: object, semanticTree?: string }
Guards: Output truncation
```

**`browser_evaluate`** — New capability (restricted)
```
Input:  { expression: string }
Output: { result: string }
Guards:
  - Expression length limit (2K chars)
  - Blocked patterns: fetch(, XMLHttpRequest, WebSocket, window.open, document.cookie (write),
    localStorage.setItem, eval(, Function(, import(, require(
  - Always mutating risk (requires approval)
  - Guardian Agent (Layer 2) LLM evaluation before execution
```

## Security Considerations

### License Safety

Lightpanda core is **AGPL-3.0**. Using it as an unmodified subprocess communicating over stdio (MCP protocol) does **not** trigger AGPL copyleft obligations. The npm wrapper (`@lightpanda/browser`) is Apache-2.0. We never modify, link, or distribute the Lightpanda binary — we spawn it as a managed child process.

This is the same model used by GuardianAgent's current `agent-browser` integration and the Google Workspace `gws` MCP provider.

### JavaScript Evaluation Controls

The `evaluate` MCP tool is the primary security surface. Mitigations:

1. **Expression blocklist** — Block `fetch()`, `XMLHttpRequest`, `WebSocket`, `window.open()`, `eval()`, `Function()`, `import()`, cookie writes, storage writes, and similar exfiltration/execution vectors
2. **Mutating risk classification** — Always requires approval under `approve_by_policy`
3. **Guardian Agent (Layer 2)** — Inline LLM evaluation before every `evaluate` call
4. **Expression length limit** — 2K chars max to prevent complex injection payloads
5. **Output truncation** — Results capped to prevent large data exfiltration
6. **Sandbox isolation** — Lightpanda process runs in `workspace-write` sandbox with controlled network access
7. **Policy-as-Code** — `browser_evaluate` can be set to `deny` in policy rules for locked-down deployments

### Process Isolation

Lightpanda runs as a stdio subprocess managed by MCPClient — the same isolation model as all MCP servers:
- Process lifecycle managed by MCPClientManager (start, health check, restart, shutdown)
- No shared memory with the supervisor process
- Network access controlled by sandbox profile
- Can be rate-limited via per-server `maxCallsPerMinute` config

### Domain Allowlist

The wrapper layer validates URLs passed to `browser_navigate` against `assistant.tools.browser.allowedDomains` (or `assistant.tools.allowedDomains`) before forwarding to Lightpanda. SSRF checks run on all URLs.

## Migration Path

### Phase 1: Add Lightpanda as alternative backend

- Add `@lightpanda/browser` to package.json
- Implement `LightpandaBrowserProvider` wrapper (~300-400 lines)
- Register new tool definitions alongside existing `browser_*` tools
- Config: `assistant.tools.browser.backend: 'lightpanda' | 'agent-browser'` (default: `agent-browser`)
- Users can opt in to Lightpanda while agent-browser remains the default

### Phase 2: Default to Lightpanda

- After validation on real workloads and user feedback
- Switch default to `backend: 'lightpanda'`
- Keep agent-browser as a fallback option

### Phase 3: Remove agent-browser

- After Lightpanda stabilizes (post-v1.0 or after sufficient real-world usage)
- Remove `agent-browser` from package.json
- Remove `BrowserSessionManager` and old tool definitions
- Simplify config to remove `backend` toggle

## Dependency Model

**npm dependency** — Add `@lightpanda/browser` to package.json as an optional dependency.

```json
{
  "optionalDependencies": {
    "@lightpanda/browser": "^0.2.5"
  }
}
```

The npm package handles binary download on postinstall (platform-specific). This is the same model used by `agent-browser`. We do not vendor, fork, or copy the binary.

**Why not vendor/copy:**
- AGPL-3.0 distribution obligations would apply if we redistribute the binary
- Platform-specific binaries (4 platforms) would bloat the repo
- The npm package handles platform detection and updates automatically

**Why optional dependency:**
- Browser tooling is not required for core GuardianAgent functionality
- Users without browser needs avoid the binary download
- Graceful degradation: if not installed, browser tools are simply not registered (same as current agent-browser behavior)

## Implementation Estimate

| Component | Files | Scope |
|-----------|-------|-------|
| `LightpandaBrowserProvider` wrapper | 1 new file | ~300-400 lines |
| Tool registration in executor.ts | 1 existing file | ~150 lines (replace existing browser tool block) |
| Config types update | 1 existing file | ~20 lines (add `backend` field to BrowserConfig) |
| Bootstrap wiring in index.ts | 1 existing file | ~30 lines (conditional provider creation) |
| Expression blocklist/validator | 1 new file or inline | ~80 lines |
| Tests | 1-2 new files | ~200-300 lines |
| **Total** | 4-6 files | ~800-1200 lines |

## Decision Criteria

**Do it if:**
- The performance improvement matters (running on user hardware with limited RAM)
- Lightpanda's MCP tools (markdown, structuredData, semantic_tree) provide materially better AI agent UX than accessibility snapshots
- The `evaluate` tool enables workflows that are currently impossible (extracting computed values, interacting with complex SPAs)

**Don't do it if:**
- Beta stability is a blocker (segfaults on important sites)
- Lightpanda's partial Web API coverage breaks too many real-world sites
- The security surface of `evaluate` is unacceptable even with mitigations
- `agent-browser` is working well enough and the performance difference doesn't matter in practice

**Recommendation:** Proceed with Phase 1 (add as alternative backend). The performance characteristics and AI-native tool design are compelling for a personal assistant running on user hardware. The phased rollout and `backend` config toggle eliminate risk — users only switch when they're ready, and can fall back if a specific site doesn't work.
