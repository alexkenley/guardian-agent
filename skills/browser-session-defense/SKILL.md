# Browser Session Defense

Use this when the work is about security boundaries around Guardian-managed browser tools rather than generic web UI testing.

## Core Boundary

- GuardianAgent can directly control and reason about browsing that happens through its managed browser tools.
- GuardianAgent does not get rich page-level visibility into the user's normal browser sessions unless additional components exist outside the current runtime.

## Workflow

1. Clarify whether the browsing is:
   - Guardian-managed
   - user-driven in a normal browser
2. For Guardian-managed browsing:
   - prefer read-only page understanding first
   - use the lowest-power browser tool that answers the question
   - treat uploads, storage-state operations, and script execution as higher-risk
3. For user-driven browsing:
   - explain the visibility boundary clearly
   - fall back to host and network signals when appropriate

## Tooling Guidance

- Read-only page work: prefer `browser_read`, `browser_links`, and `browser_extract`.
- Interactive browser work: use `browser_state` plus `browser_act`, or Playwright tools directly when you need lower-level control.
- Do not use `browser_run_code`.
- Treat `browser_evaluate`, file uploads, and storage-state operations as approval-worthy actions.

## Boundaries

- Use `webapp-testing` for functional UI verification and bug reproduction.
- Use `host-firewall-defense` when the only available evidence is indirect host or network drift around browser activity.
- Use `security-mode-escalation` when browser risk needs to be translated into `monitor`, `guarded`, or `lockdown` recommendations.

## Gotchas

- Do not imply GuardianAgent can see arbitrary tabs or page contents in the user's own browser when it cannot.
- Do not default to the most powerful raw MCP tool for basic page reading.
- Do not recommend storage-state or upload actions as if they were harmless read-only inspection.

Read [references/visibility-boundary.md](./references/visibility-boundary.md) when the user is confused about what GuardianAgent can and cannot observe in browser activity.
