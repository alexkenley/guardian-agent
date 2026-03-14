---
name: webapp-testing
description: Toolkit for testing local web applications and browser workflows with GuardianAgent's MCP browser tools. Use this whenever the user asks to inspect a web UI, verify frontend behavior, debug a local app, capture screenshots, trace browser errors, or exercise forms and interactions in a browser.
---

# Webapp Testing

Use GuardianAgent's MCP browser tools for browser work. Prefer Lightpanda for fast read-only inspection and Playwright for interaction, screenshots, uploads, and complex app behavior.

## Backend Selection

- Use `mcp-lightpanda-goto` plus read-only Lightpanda tools when the task is mostly reading, extracting, mapping links, or understanding page structure.
- Use `mcp-playwright-browser_navigate` and Playwright interaction tools when the task requires clicks, typing, form submission, auth flows, screenshots, or SPA behavior.
- Do not use `mcp-playwright-browser_run_code`; it is blocked by policy.
- Avoid `evaluate` unless the existing browser tools cannot answer the question and the action is worth approval.

## Workflow

1. Confirm how the app is started if it is not already running.
2. Open the page with the lowest-power tool that can answer the question.
3. Inspect before acting:
   - page text or markdown
   - semantic structure
   - interactive elements
   - screenshots or snapshots when visual state matters
4. Identify selectors or target elements from observed state.
5. Perform the minimum interaction needed to verify behavior.
6. Capture evidence: screenshot, relevant console output, network details, or structured findings.

## Read-Only Recon First

When the user asks "what is on this page?" or "why is this screen wrong?", prefer:

- `mcp-lightpanda-goto`
- `mcp-lightpanda-markdown`
- `mcp-lightpanda-semantic_tree`
- `mcp-lightpanda-interactiveElements`
- `mcp-lightpanda-structuredData`

Escalate to Playwright only when rendered behavior, interactivity, or visual proof matters.

## Interactive Testing

For user journeys and bug reproduction:

- navigate first
- wait for the page to settle
- inspect the current state before clicking blindly
- use descriptive selectors or the browser snapshot output
- capture a screenshot before and after important interactions

## Common Pitfalls

- Do not guess selectors before inspecting the current page state.
- Do not default to the heavier browser backend for simple extraction tasks.
- Do not stop at "it failed"; collect the screenshot, console messages, and any obvious network errors.

Read [references/browser-tool-selection.md](./references/browser-tool-selection.md) when you need a quick backend-selection checklist.
