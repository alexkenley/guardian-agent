# Browser Automation Design

**Status:** Implemented current Playwright browser wrapper surface
**Date:** 2026-03-23
**Proposal Origin:** [Browser Automation Proposal](../implemented/BROWSER-AUTOMATION-PROPOSAL.md)
**Related Designs:** [TOOLS-CONTROL-PLANE-DESIGN.md](./TOOLS-CONTROL-PLANE-DESIGN.md), [AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md](./AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md)

## Purpose

Document the browser automation stack that is actually shipped now.

This is an as-built runtime spec. The proposal remains the design/rationale document. This spec only describes the current browser wrapper, MCP integration, operator surfaces, and runtime boundaries.

## Current Runtime Model

Guardian no longer exposes the old built-in `browser_open` / `browser_action` / `browser_task` tool family.

The shipped browser surface is split into two layers:

- Guardian-native browser wrapper tools for the normal product surface
- MCP-backed Playwright tools underneath that wrapper

The wrapper tools are:

- `browser_capabilities`
- `browser_navigate`
- `browser_read`
- `browser_links`
- `browser_extract`
- `browser_state`
- `browser_act`
- `browser_interact`

The raw transport layer is Playwright MCP. Typical internal tool names are:

- `mcp-playwright-browser_navigate`
- `mcp-playwright-browser_snapshot`
- `mcp-playwright-browser_click`
- `mcp-playwright-browser_type`
- `mcp-playwright-browser_select_option`
- `mcp-playwright-browser_evaluate`

Those raw MCP browser tools still exist internally as the transport layer, but assistant-visible discovery prefers the Guardian wrapper surface. Saved automations and ordinary chat/browser work should use `browser_*` names rather than raw `mcp-*` browser identifiers.

`ToolExecutor` keeps lightweight browser session state for current URL, last action, and stable interactive refs. Actual browser execution stays delegated through Playwright MCP registration and the normal Guardian tool path.

## Bootstrap Behavior

Browser MCP providers are started in `src/index.ts` when:

- `assistant.tools.browser.enabled !== false`
- MCP is not blocked by the current sandbox/runtime state

### Playwright MCP

Playwright is the only shipped browser backend.

Current startup shape:

- command: `npx`
- package: installed `@playwright/mcp` from the local dependency set
- default args:
  - `--no-install`
  - `@playwright/mcp`
  - `--headless`
  - `--browser <playwrightBrowser>`
  - `--caps <playwrightCaps>`
  - `--snapshot-mode incremental`
- extra operator args can be appended through `browser.playwrightArgs`

Defaults:

- `playwrightEnabled: true`
- `playwrightBrowser: chromium`
- `playwrightCaps: network,storage`

## Configuration Surface

Current browser config fields in `BrowserConfig`:

- `enabled`
- `playwrightEnabled`
- `playwrightBrowser`
- `playwrightCaps`
- `allowedDomains`
- `playwrightArgs`

Operator surfaces:

- `GET /api/tools/browser`
- `POST /api/tools/browser`
- Configuration > Tools tab browser controls

Current web UI exposes:

- browser master enable/disable
- Playwright enable/disable
- Playwright browser engine
- Playwright capability groups
- browser domain list

Browser config changes are persisted and live-applied. Guardian stops and restarts the managed Playwright MCP server in-process, refreshes wrapper registration, and returns a degraded message if the backend cannot be started. Restart is no longer the normal apply path for browser config changes.

## Current Policy And Containment

Browser tools still flow through the normal Guardian control path:

- tool registration and execution through `ToolExecutor`
- wrapper orchestration through `HybridBrowserService`
- audit/event emission via `tool.executed`
- host monitoring follow-up for browser-relevant tools
- security-mode browser containment through `BrowserSessionBroker`

Shipped browser policy bundle:

- [browser.json](../../policies/base/browser.json)

Current bundled rules:

- deny `mcp-playwright-browser_run_code`
- deny `mcp-playwright-browser_install`
- require approval for Playwright page evaluation where policy marks it mutating/high-risk
- require approval for browser file upload
- require approval for `browser_act`
- require approval for browser storage-state save/restore

Current containment behavior from `BrowserSessionBroker`:

- high-risk browser tools are blocked outside `monitor`
- scheduled mutating browser actions are blocked outside `monitor`
- Guardian-native `browser_*` wrapper tools participate in the same browser containment path

Browser URL validation also applies before execution:

- only `http` and `https` targets are allowed
- private/internal hosts are hard-blocked for SSRF protection before any allowlist remediation is suggested
- browser wrapper tools prefer `assistant.tools.browser.allowedDomains` when configured and otherwise fall back to the general tool `allowedDomains`

## Event And Monitoring Integration

Browser tool executions emit the standard runtime `tool.executed` event with:

- `toolName`
- `args`
- `result`
- `requestId`

Browser-relevant tools also participate in post-tool host monitoring triggers. Current explicit browser examples include:

- wrapper navigation, read, link extraction, structured extraction, and interaction tools
- Playwright navigation, click, type, evaluate, run-code, and file-upload tools

## Current Boundaries And Limitations

Accurate current limits:

- Browser automation is MCP-backed under the hood rather than a custom browser engine.
- The main browser UX is a Guardian-native wrapper layer. Raw MCP browser tools remain available internally for the wrapper path and controlled escape hatches, but they are intentionally hidden from normal assistant-visible discovery.
- Conversational automation authoring should save browser workflows with Guardian wrapper step names (`browser_navigate`, `browser_read`, `browser_links`, `browser_extract`, `browser_state`, `browser_act`) instead of raw MCP identifiers.
- `browser_state` is the deterministic Playwright discovery lane for interactive pages. `browser_act` is the approval-aware mutation lane and expects a fresh `stateId` plus a stable ref from `browser_state`.
- `browser_interact` remains for compatibility, but mutating `browser_interact` calls now require `stateId` plus a stable ref. Free-form label mutation is no longer supported.
- `browser_links` and the structured part of `browser_extract` now run through Playwright DOM evaluation instead of a secondary read-only backend.
- Browser-specific `allowedDomains` applies to the Guardian-native wrapper tools when configured, falling back to the general tool `allowedDomains` list otherwise.
- High-risk browser behavior is constrained mainly through approval rules, containment mode, and MCP tool policy, not through the more advanced privacy features proposed elsewhere.
- Privacy/Tor behavior is not part of this as-built spec. That work remains proposal-stage.

## Files

Primary runtime files:

- `src/index.ts`
- `src/tools/browser-hybrid.ts`
- `src/tools/executor.ts`
- `src/tools/mcp-client.ts`
- `src/runtime/browser-session-broker.ts`
- `policies/base/browser.json`
- `src/channels/web.ts`
- `web/public/js/pages/config.js`

## Verification

Current coverage includes:

- `src/tools/browser-hybrid.test.ts`
- `src/runtime/browser-session-broker.test.ts`
- `src/tools/executor.test.ts`
- `src/tools/mcp-integration.test.ts`
- `scripts/test-automation-authoring-compiler.mjs`

Behavior confirmed by current tests/spec-adjacent checks:

- legacy built-in browser tools are no longer registered
- Guardian-native wrapper tools are registered when Playwright browser tools are present
- raw managed Playwright MCP tools are hidden from assistant-visible tool discovery while remaining available internally for the wrapper/escape-hatch path
- wrapper reads, link extraction, and structured extraction run through Playwright
- wrapper browser interactions keep ref discovery low-friction through `browser_state` / `browser_interact action=list` while mutating actions stay on the approval-aware `browser_act` lane
- browser config API/UI wiring exists and live-applies backend changes when possible
- private/internal browser targets are denied before any add-domain remediation path
- browser containment and policy rules are present in the runtime
