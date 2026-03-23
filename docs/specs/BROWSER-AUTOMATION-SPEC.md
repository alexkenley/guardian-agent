# Browser Automation Spec

**Status:** Implemented current hybrid wrapper + MCP browser surface
**Date:** 2026-03-20
**Proposal Origin:** [Browser Automation Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/BROWSER-AUTOMATION-PROPOSAL.md)
**Related Specs:** [Tools Control Plane Spec](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [Agentic Defensive Security Suite - As-Built Spec](/mnt/s/Development/GuardianAgent/docs/specs/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT-SPEC.md)

## Purpose

Document the browser automation stack that is actually shipped now.

This is an as-built runtime spec. The proposal remains the design/rationale document. This spec only describes the current browser wrapper, MCP integration, operator surfaces, and real boundaries.

## Current Runtime Model

Guardian no longer exposes the old built-in `browser_open` / `browser_action` / `browser_task` tool family.

The shipped browser surface is now split into two layers:

- Guardian-native browser wrapper tools for the main product surface
- MCP-backed Playwright and Lightpanda tools underneath that wrapper

The wrapper tools are:

- `browser_capabilities`
- `browser_navigate`
- `browser_read`
- `browser_links`
- `browser_extract`
- `browser_state`
- `browser_act`
- `browser_interact`

Under the wrapper, the browser transport remains MCP-native:

- Playwright MCP for full interactive browsing
- Lightpanda MCP for lightweight read-oriented browsing

Browser tools are registered through `MCPClientManager` and appear as namespaced MCP tools such as:

- `mcp-playwright-browser_navigate`
- `mcp-playwright-browser_click`
- `mcp-playwright-browser_type`
- `mcp-lightpanda-goto`
- `mcp-lightpanda-markdown`

Those raw MCP browser tools still exist internally as the transport layer, but normal assistant-visible discovery now prefers the Guardian wrapper surface. Saved automations and ordinary chat/browser work should use `browser_*` names rather than raw `mcp-*` browser identifiers.

`ToolExecutor` still does not implement a separate browser process manager. The wrapper keeps lightweight session state for current URL, preferred lane, and last action, but actual browser execution stays delegated through MCP registration and the normal Guardian tool path.

## Bootstrap Behavior

Browser MCP providers are started in `src/index.ts` when:

- `assistant.tools.browser.enabled !== false`
- MCP is not blocked by the current sandbox/runtime state

### Playwright MCP

Playwright is the default browser backend.

Current startup shape:

- command: `npx`
- package: installed `@playwright/mcp` from the local dependency set (no `@latest` startup path)
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

Browser config changes are persisted and now reconcile the managed browser backend set live. Guardian will stop and restart the managed Playwright/Lightpanda MCP servers in-process, refresh wrapper registration, and return a degraded message if the requested backend cannot be started. Restart is no longer the normal apply path for browser config changes.

## Current Policy And Containment

Browser tools still flow through the normal Guardian control path:

- tool registration and execution through `ToolExecutor`
- wrapper orchestration through `HybridBrowserService`
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
- Lightpanda `goto` and `evaluate`

## Current Boundaries And Limitations

This is the current runtime shape, not the original proposal in full.

Accurate current limits:

- Browser automation is still MCP-backed under the hood rather than a custom browser engine.
- The main browser UX is now a Guardian-native wrapper layer. Raw MCP browser tools still remain available as fallback escape hatches, but they are intentionally hidden from normal assistant-visible tool discovery so the model prefers the wrapper surface first.
- Conversational automation authoring should save browser workflows with Guardian wrapper step names (`browser_navigate`, `browser_read`, `browser_links`, `browser_extract`, `browser_state`, `browser_act`) instead of raw MCP identifiers.
- `browser_state` is the deterministic Playwright discovery lane for interactive pages. `browser_act` is the approval-aware mutation lane and expects a fresh `stateId` plus a stable ref from `browser_state`.
- `browser_interact` remains for compatibility, but mutating `browser_interact` calls now require `stateId` plus a stable ref. Free-form label mutation is no longer supported.
- Playwright is the primary implementation. Lightpanda remains opt-in.
- Browser-specific `allowedDomains` now applies to the Guardian-native wrapper tools when configured, falling back to the general tool `allowedDomains` list otherwise.
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

Behavior confirmed by current tests/spec-adjacent checks:

- legacy built-in browser tools are no longer registered
- Guardian-native wrapper tools are registered when managed browser backends are present
- raw managed browser MCP tools are hidden from assistant-visible tool discovery while remaining available internally for the wrapper/escape-hatch path
- wrapper reads prefer Lightpanda and fall back to Playwright snapshots when needed
- wrapper browser interactions keep ref discovery low-friction through `browser_state` / `browser_interact action=list` while mutating actions stay on the approval-aware `browser_act` lane
- browser config API/UI wiring exists and live-applies backend changes when possible
- private/internal browser targets are denied before any add-domain remediation path
- browser containment and policy rules are present in the runtime
