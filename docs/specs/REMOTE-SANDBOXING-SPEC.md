# Remote Sandboxing Spec

**Status:** As built  
**Date:** 2026-04-13  
**Owner:** Runtime + Code Workspace + WebUI  
**Related:** [Security Isolation Spec](/mnt/s/Development/GuardianAgent/docs/specs/SECURITY-ISOLATION-SPEC.md), [Coding Workspace Spec](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md), [WebUI Design Spec](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md), [Tools Control Plane Spec](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [Cloud Hosting Integration Spec](/mnt/s/Development/GuardianAgent/docs/specs/CLOUD-HOSTING-INTEGRATION-SPEC.md)

## Goal

Define the provider-neutral remote sandboxing model Guardian uses for bounded coding execution.

This spec exists so Vercel and Daytona behave as alternate backends under one orchestration model instead of growing into separate execution products with different lifecycle rules.

The remote sandbox system must:

- work when only Vercel is configured
- work when only Daytona is configured
- work when both are configured
- keep normal Guardian control-plane ownership local
- support both short-lived isolated runs and intentionally reusable code-session sandboxes
- expose longer-lived sandbox lifecycle control directly in the Code workspace

## Non-Goals

This spec does not turn Guardian into a hosted IDE or move the full runtime into a cloud provider.

It does not define:

- full remote shell or terminal parity
- provider-specific routing heuristics such as "always use Daytona for installs"
- provider-owned approvals, memory, audit, or intent routing
- hidden promotion of whole conversations into a remote sandbox runtime

## Product Model

Guardian treats remote sandboxes as Layer 1.5 execution backends for bounded coding jobs.

The shared product model is:

- Cloud configuration owns provider setup and health
- Code owns session-scoped reusable sandbox operations
- Guardian retains ownership of routing, approvals, memory, policy, and audit
- provider adapters only supply bounded execution and sandbox lifecycle primitives

Remote sandbox choice is a target-selection problem, not a separate routing architecture.

## Shared Terms

### Remote target

A configured and health-checked remote execution backend exposed through the shared remote-execution service.

Examples:

- `vercel:<profile-id>`
- `daytona:<profile-id>`

### Lease

Guardian-owned orchestration metadata that binds a sandbox instance to a workspace root and optional code session.

Leases are not provider-owned durable state. Guardian decides when to acquire, resume, and dispose them.

### Lease modes

Guardian supports two remote lease modes:

- `ephemeral`
  - create for one bounded run
  - eligible for normal expiry and teardown
  - preferred for one-shot verification or higher-risk isolated commands

- `managed`
  - created deliberately for a code session
  - reused across later compatible runs
  - intended for retained prerequisites, warmed caches, repeated test/build loops, and longer-running coding work

## Control-Plane Ownership

Remote sandboxing must stay below Guardian's shared orchestration layer.

Guardian owns:

- intent classification and route selection
- approval creation and completion
- code-session state
- staged local workspace access rules
- memory and conversation state
- audit metadata
- final answer composition

Remote providers own only:

- sandbox lifecycle primitives
- bounded command execution
- provider-specific health and reconnect mechanics
- stdout, stderr, artifacts, and sandbox metadata returned to Guardian

## Runtime Architecture

Primary modules:

- `src/runtime/remote-execution/types.ts`
- `src/runtime/remote-execution/remote-execution-service.ts`
- `src/runtime/remote-execution/policy.ts`
- `src/runtime/remote-execution/providers/vercel-remote-execution.ts`
- `src/runtime/remote-execution/providers/daytona-remote-execution.ts`
- `src/tools/executor.ts`
- `src/runtime/code-sessions.ts`

Provider adapters implement the shared remote-execution contract and may advertise capabilities such as reconnecting to an existing sandbox or restarting a stopped sandbox.

The shared service owns:

- target discovery
- target health
- lease acquire, resume, and dispose
- managed vs ephemeral semantics
- run metadata normalization
- idle cleanup for ephemeral leases

## Provider Behavior

Guardian does not hard-route by provider. Both providers participate through the same target-selection rules.

Practical tradeoffs are still surfaced to operators:

- Vercel
  - faster fit for short bounded isolated runs
  - weaker fit for long-lived stateful reuse

- Daytona
  - stronger fit for reusable long-running workspaces
  - heavier sandbox lifecycle than quick bounded runs

These tradeoffs appear as UI guidance only. They are not hidden orchestration rules.

## Target Selection Rules

For remote bounded coding execution, Guardian chooses targets in this order:

1. a compatible managed sandbox already attached to the current code session
2. the configured default remote target
3. the first ready target in deterministic config order

Guardian must not add workflow-specific provider rules above this shared order.

If the user explicitly requests a profile, that profile wins if ready. If it is unavailable, the run fails rather than silently switching to a different provider.

## Managed Code-Session Sandboxes

Managed sandboxes are persisted in backend code-session state, not only in the browser.

`CodeSessionWorkState.managedSandboxes` stores:

- target identity
- provider identity
- lease id
- sandbox id
- local and remote workspace roots
- acquired and last-used timestamps
- optional runtime and vCPU hints
- tracked remote paths
- current health state

When a remote run starts for a code session, Guardian:

1. inspects the session's active managed sandboxes
2. prefers a compatible managed lease when present
3. passes that lease into the shared remote-execution service as the preferred lease
4. syncs updated lease metadata back into the code-session record after the run

Run metadata must report whether:

- a lease was reused
- the lease mode was `managed` or `ephemeral`
- a specific sandbox id and backend were used

## Tool-Loop Orchestration Contract

Remote sandbox runs must stay serialized inside one assistant tool loop when later steps may depend on the same sandbox filesystem state or lease.

Rules:

- if a turn asks for multiple remote sandbox commands in the same coding workspace, Guardian must advance them one bounded remote step at a time
- later remote sandbox tool calls in the same tool round must not create parallel approvals or run ahead of the earlier remote sandbox step
- when a remote sandbox step is waiting on approval, later same-turn remote sandbox steps are deferred until the approved step completes and its exact result is replayed into planning
- if the user explicitly named a remote execution profile, that profile selection must be preserved across every later remote sandbox step in the turn
- approval-backed remote failures must replay the full structured tool result, including stdout/stderr and lease metadata when available, so the next planning step reacts to the real sandbox outcome instead of a degraded placeholder

## Web And Control-Plane Contract

Cloud/provider setup stays under the Cloud connection pages.

Reusable sandbox operations live under the Code workspace and are exposed through shared dashboard callbacks and web routes:

- `GET /api/code/sessions/:id/sandboxes`
- `POST /api/code/sessions/:id/sandboxes`
- `DELETE /api/code/sessions/:id/sandboxes/:leaseId`

The callback and route layers stay provider-neutral. They list targets, create managed sandboxes, and release managed sandboxes without branching into Vercel-specific or Daytona-specific orchestration paths.

Managed sandbox status reads may trigger backend lease reconciliation, but that reconciliation must stay read-only:

- the backend may inspect a persisted managed sandbox no more than once every 30 seconds per lease while the Code UI is refreshing
- lease inspection must not silently resume, restart, extend, or recreate the managed sandbox
- lease inspection updates the session-owned managed sandbox record and UI card state, but must not poison target-wide readiness just because one specific managed sandbox has expired

## Code UI Contract

The Code page owns operator lifecycle control for managed coding sandboxes.

Required behavior:

- a `Sandboxes` tab beside `Sessions` in the Code side rail
- visibility into configured remote targets and whether they are ready or unavailable
- provider-specific tooltips that explain tradeoffs without hard-routing
- create action for a managed sandbox on a selected target
- refresh view for sandbox health and current lease state
- release action for a managed sandbox

The browser is not the source of truth for the sandbox lease. It is a client of backend code-session state.

## Deletion And Cleanup Rules

Managed sandbox cleanup must be authoritative in the shared backend path.

Rules:

- deleting a managed sandbox must dispose the corresponding remote lease before the backend session record is cleared
- deleting a code session must release all managed sandboxes before the session record is removed
- if a managed sandbox cannot be resolved or released, code-session deletion fails and the session remains so the operator can retry cleanup
- the browser may reflect sandbox state and request deletion, but it must not be the only place where lease cleanup happens

This prevents remote sandboxes from being orphaned when a session is deleted from another surface or API client.

## Health And Observability

The remote sandbox system must surface:

- configured target ids and provider names
- ready vs unavailable target state
- backend kind
- sandbox id
- lease id
- lease mode
- whether a later run reused the existing lease

For managed code-session sandboxes specifically, Guardian must reconcile provider-side liveness back into the persisted session record so expired provider sandboxes do not remain indefinitely shown as active after a backend restart or provider-side auto-stop/delete event.

Operators should be able to tell whether a run used:

- local sandboxing only
- an ephemeral remote sandbox
- a managed reusable sandbox

## Current As-Built Scope

Implemented in the current slice:

- shared remote target model for Vercel and Daytona
- provider-neutral target prioritization
- managed and ephemeral lease modes
- lease resume support in the shared remote-execution service
- persisted managed sandbox records on code sessions
- Code-page `Sandboxes` tab with provider tooltips and create/release actions
- backend API routes for list/create/delete sandbox operations
- backend-owned cleanup before code-session deletion

Not in scope for this slice:

- full browser terminal inside the remote sandbox
- background sandbox fleets outside a code session
- provider-specific orchestration branches above the shared remote-execution layer
