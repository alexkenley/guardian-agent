# Browser Visibility Boundary

GuardianAgent has two different browser viewpoints:

## 1. Guardian-managed browser sessions

When browsing happens through the managed browser backends:

- GuardianAgent can reason about the navigation and browser tool calls
- policy and approvals apply to higher-risk actions
- screenshots, snapshots, uploads, storage state, and network traces are available through the browser tooling surface

## 2. User-driven normal browser sessions

When the user opens Chrome, Edge, Firefox, or Safari directly:

- GuardianAgent does not get page-by-page visibility by default
- GuardianAgent mainly sees indirect host and network signals
- the system can infer that browser processes are running or that new destinations appeared, but not the exact page contents or clicks

## Practical Implication

Use browser security language carefully:

- say "Guardian-managed browser session" when the agent is actually driving the browser
- say "indirect host or network evidence" when the user is browsing outside GuardianAgent
