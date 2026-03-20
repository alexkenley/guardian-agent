# Browser Automation Spec

**Status:** Implemented current MCP browser surface
**Date:** 2026-03-20
**Proposal Origin:** [Browser Automation Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/BROWSER-AUTOMATION-PROPOSAL.md)
**Related Specs:** [Tools Control Plane Spec](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [Agentic Defensive Security Suite - As-Built Spec](/mnt/s/Development/GuardianAgent/docs/specs/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT-SPEC.md)

## Purpose

Document the browser automation stack that is actually shipped now.

This is an as-built runtime spec. The proposal remains the design/rationale document. This spec only describes the current MCP browser integration, operator surfaces, and real boundaries.

## Current Runtime Model

Guardian no longer exposes the old built-in `browser_open` / `browser_action` / `browser_task` tool family.

The shipped browser surface is MCP-native:

- Playwright MCP for full interactive browsing
- Lightpanda MCP for lightweight read-oriented browsing

Browser tools are registered through `MCPClientManager` and appear as namespaced MCP tools such as:

- `mcp-playwright-browser_navigate`
- `mcp-playwright-browser_click`
- `mcp-playwright-browser_type`
- `mcp-lightpanda-goto`
- `mcp-lightpanda-markdown`

`ToolExecutor` does not implement a separate browser session manager anymore. Browser tooling is entirely delegated through MCP registration and the normal Guardian tool path.

## Bootstrap Behavior

Browser MCP providers are started in `src/index.ts` when:

- `assistant.tools.browser.enabled !== false`
- MCP is not blocked by the current sandbox/runtime state

### Playwright MCP

Playwright is the default browser backend.

Current startup shape:

- command: `npx`
- package: `@playwright/mcp@latest`
- default args:
  - `--headless`
  - `--browser <playwrightBrowser>`
  - `--caps <playwrightCaps>`
  - `--snapshot-mode incremental`
- extra operator args can be appended through `browser.playwrightArgs`

Defaults:

- `playwrightEnabled: true`
- `playwrightBrowser: chromium`
- `playwrightCaps: network,storage`

### Lightpanda MCP

Lightpanda is optional and off by default.

Current startup shape:

- command: `lightpanda` or configured `lightpandaBinaryPath`
- args: `mcp`

Defaults:

- `lightpandaEnabled: false`

## Configuration Surface

Current browser config fields in `BrowserConfig`:

- `enabled`
- `playwrightEnabled`
- `lightpandaEnabled`
- `playwrightBrowser`
- `playwrightCaps`
- `allowedDomains`
- `playwrightArgs`
- `lightpandaBinaryPath`

Operator surfaces:

- `GET /api/tools/browser`
- `POST /api/tools/browser`
- Configuration > Tools tab browser controls

Current web UI exposes:

- browser master enable/disable
- Playwright enable/disable
- Lightpanda enable/disable
- Playwright browser engine
- Playwright capability groups
- browser domain list

Structural browser config changes are persisted, but they require restart to affect the running MCP provider set.

## Current Policy And Containment

Browser tools still flow through the normal Guardian control path:

- tool registration and execution through `ToolExecutor`
- audit/event emission via `tool.executed`
- host monitoring follow-up for browser-relevant tools
- security-mode browser containment through `BrowserSessionBroker`

Shipped browser policy bundle:

- [browser.json](/mnt/s/Development/GuardianAgent/policies/base/browser.json)

Current bundled rules:

- deny `mcp-playwright-browser_run_code`
- deny `mcp-playwright-browser_install`
- require approval for Playwright and Lightpanda page evaluation
- require approval for browser file upload
- require approval for browser storage-state save/restore

Current containment behavior from `BrowserSessionBroker`:

- high-risk browser tools are blocked outside `monitor`
- scheduled mutating browser actions are blocked outside `monitor`

## Event And Monitoring Integration

Browser tool executions emit the standard runtime `tool.executed` event with:

- `toolName`
- `args`
- `result`
- `requestId`

Browser-relevant tools also participate in post-tool host monitoring triggers. Current explicit browser examples include:

- Playwright navigation, click, type, evaluate, run-code, and file-upload tools
- Lightpanda `goto` and `evaluate`

## Current Boundaries And Limitations

This is the current runtime shape, not the original proposal in full.

Accurate current limits:

- Browser automation is MCP-backed, not a custom Guardian browser runtime.
- Playwright is the primary implementation. Lightpanda remains opt-in.
- Browser-specific `allowedDomains` exists in config/UI, but the current runtime does not yet provide a dedicated browser-domain preflight layer separate from the existing MCP/containment path.
- High-risk browser behavior is constrained mainly through approval rules, containment mode, and MCP tool policy, not through the more advanced privacy features proposed elsewhere.
- Privacy/Tor behavior is not part of this as-built spec. That work remains proposal-stage.

## Files

Primary runtime files:

- `src/index.ts`
- `src/tools/executor.ts`
- `src/tools/mcp-client.ts`
- `src/runtime/browser-session-broker.ts`
- `policies/base/browser.json`
- `src/channels/web.ts`
- `web/public/js/pages/config.js`

## Verification

Current coverage includes:

- `src/tools/executor.test.ts`
- `src/tools/mcp-integration.test.ts`

Behavior confirmed by current tests/spec-adjacent checks:

- legacy built-in browser tools are no longer registered
- MCP browser tools are the active browser surface
- browser config API/UI wiring exists
- browser containment and policy rules are present in the runtime
