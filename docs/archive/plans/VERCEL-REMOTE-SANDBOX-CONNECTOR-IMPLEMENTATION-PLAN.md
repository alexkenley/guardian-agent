# Remote Sandbox Orchestration Plan

**Date:** 2026-04-13
**Status:** Delivered initial slice. See [Remote Sandboxing Spec](../../design/REMOTE-SANDBOXING-DESIGN.md) for the canonical as-built behavior.
**Primary references:** [Cloud Hosting Integration Spec](../../design/CLOUD-HOSTING-INTEGRATION-DESIGN.md), [Coding Workspace Spec](../../design/CODING-WORKSPACE-DESIGN.md), [WebUI Design Spec](../../design/WEBUI-DESIGN.md)
**External references:** [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox/), [Vercel Sandbox Managing](https://vercel.com/docs/vercel-sandbox/managing), [Daytona Documentation](https://www.daytona.io/docs/)

---

## Goal

Provide one shared remote-sandbox model for Guardian that:

- works with Vercel, Daytona, or either provider alone
- keeps local execution as the default path
- supports both ephemeral isolated runs and session-managed reusable sandboxes
- avoids provider-specific orchestration forks
- exposes longer-lived sandbox control directly in the Code workspace

This is not a plan to move the full Guardian runtime into hosted infrastructure. It is a plan for bounded remote execution plus optional reusable coding-session sandboxes.

---

## Product Direction

### Provider model

Guardian must treat Vercel and Daytona as optional remote-execution backends under one shared orchestration layer.

Rules:

- users may configure only Vercel
- users may configure only Daytona
- users may configure both
- target choice must not depend on hard-coded "Vercel for X, Daytona for Y" workflow heuristics

Selection order:

1. explicit session-managed sandbox for the current code session
2. explicitly configured default remote target
3. first ready target in deterministic config order

### Sandbox modes

Guardian now needs two remote execution modes:

- `ephemeral`: create, run, tear down
- `managed`: created deliberately for a code session and reused across multiple runs

Managed sandboxes are for longer-running tasks such as:

- dependency install
- repeated test/build loops
- workflows that need retained prerequisites or warmed state

Ephemeral sandboxes remain appropriate for:

- one-shot bounded verification
- higher-risk isolated commands
- quick policy-driven remote execution

---

## UX Direction

Remote provider configuration stays under Cloud / configuration surfaces.

Operational control for reusable coding sandboxes lives under the Code workspace.

### Code page changes

Add a `Sandboxes` tab beside the existing `Sessions` tab in the Code side rail.

The panel must show:

- configured remote targets that are ready or unavailable
- provider tooltip guidance for each target
- create managed sandbox action
- active managed sandboxes for the current code session
- release action for managed sandboxes

Tooltip guidance should explain the practical tradeoff without hard-routing users:

- Vercel: faster bounded sandbox startup, stronger fit for short isolated runs, weaker fit for long-lived stateful sessions
- Daytona: stronger fit for reusable long-running workspaces, heavier lifecycle than short-lived bounded sandboxes

---

## Runtime Design

### Shared orchestration

The shared remote execution layer owns:

- target discovery
- health state
- lease acquire / resume / release
- artifact metadata
- run lifecycle
- code-session lease reuse

Primary modules:

- `src/runtime/remote-execution/types.ts`
- `src/runtime/remote-execution/remote-execution-service.ts`
- `src/runtime/remote-execution/policy.ts`
- `src/runtime/remote-execution/providers/vercel-remote-execution.ts`
- `src/runtime/remote-execution/providers/daytona-remote-execution.ts`

### Lease behavior

Managed leases must support:

- persisted session attachment metadata
- reconnect to an existing sandbox when the provider supports it
- no idle auto-expiry inside Guardian while the lease remains managed
- retained remote tracked-path metadata so resumed sandboxes can safely restage and remove stale files

### Code-session integration

Code sessions persist managed sandbox records in shared session state.

That record must include:

- target and provider identity
- sandbox id and lease id
- workspace roots
- last-used timestamp
- runtime / CPU hints
- tracked remote paths
- health state

When a code-session remote run starts, Guardian should:

1. inspect the session-managed sandboxes
2. prefer a compatible managed lease when present
3. otherwise fall back to the shared target-selection logic
4. write the updated sandbox usage back into the code session

---

## Web / Control-Plane Design

Required web contract additions:

- `GET /api/code/sessions/:id/sandboxes`
- `POST /api/code/sessions/:id/sandboxes`
- `DELETE /api/code/sessions/:id/sandboxes/:leaseId`

Shared dashboard callbacks must surface:

- list session sandboxes
- create managed sandbox
- release managed sandbox

The implementation must stay provider-neutral at the callback and route layer.

---

## Supported Behavior

### In scope

- explicit remote isolated execution
- provider-neutral target selection
- session-managed reusable sandboxes
- persistent prerequisites across coding-session runs
- code-session UI to create and release managed sandboxes
- provider capability tooltips in the Code panel

### Out of scope

- full remote IDE replacement
- browser-terminal parity inside remote sandboxes
- remote execution by hidden provider-specific heuristics
- duplicating approvals or orchestration logic per provider

---

## Implementation Phases

### Phase 1: Shared Target And Lease Foundation

Deliver:

- provider-neutral target model for Vercel and Daytona
- remote health summaries
- lease acquire / resume / release
- managed vs ephemeral lease modes

Exit criteria:

- both providers can be resolved through one shared service
- no Vercel-vs-Daytona workflow-specific routing heuristic remains in orchestration

### Phase 2: Code-Session Managed Sandboxes

Deliver:

- persisted `managedSandboxes` state on code sessions
- ToolExecutor helpers for create / list / release
- managed lease preference during later remote runs

Exit criteria:

- a code session can create a managed sandbox once and reuse it on later runs

### Phase 3: Code UI Control Surface

Deliver:

- `Sandboxes` tab in the Code side rail
- target chooser, provider tooltips, create / refresh / release actions
- live view of active managed sandboxes

Exit criteria:

- operators can intentionally create and reuse session sandboxes from the Code page

### Phase 4: Validation And Hardening

Deliver:

- type and unit coverage for provider, executor, and route behavior
- deletion / release cleanup
- docs/spec updates aligned with the actual provider-neutral design

Exit criteria:

- managed sandbox flow is validated from executor through web route through Code UI

---

## Acceptance Gates

- Guardian works with Vercel only, Daytona only, or both
- code-session managed sandboxes are optional, not mandatory
- the Code page exposes a `Sandboxes` tab beside `Sessions`
- provider tradeoffs are explained in-panel with concise tooltips
- longer-running sandbox reuse does not depend on provider-specific orchestration forks
- managed sandbox runs reuse the same remote lease when compatible
- session deletion or sandbox release does not silently leave stale local session metadata behind
