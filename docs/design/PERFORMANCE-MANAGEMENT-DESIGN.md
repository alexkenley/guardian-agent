# Performance Management Design

**Status:** Implemented current architecture  

## Purpose

Define the as-built performance-management capability that Guardian currently ships.

This document is the source of truth for the runtime service, web control-plane surface, and assistant tool access for workstation performance operations. The earlier proposal in [WINDOWS-11-PERFORMANCE-MANAGER-PROPOSAL.md](../implemented/WINDOWS-11-PERFORMANCE-MANAGER-PROPOSAL.md) is historical design context, not the current behavior contract.

## Scope

Owned implementation surfaces:

- runtime service: [performance-service.ts](../../src/runtime/performance-service.ts)
- OS adapters: [windows.ts](../../src/runtime/performance-adapters/windows.ts), [fallback.ts](../../src/runtime/performance-adapters/fallback.ts)
- web callbacks: [performance-dashboard-callbacks.ts](../../src/runtime/control-plane/performance-dashboard-callbacks.ts)
- web routes and types: [web-runtime-routes.ts](../../src/channels/web-runtime-routes.ts), [web-types.ts](../../src/channels/web-types.ts)
- web page and client: [performance.js](../../web/public/js/pages/performance.js), [api.js](../../web/public/js/api.js)
- assistant tools: [performance-tools.ts](../../src/tools/builtin/performance-tools.ts)
- config mutation path: [direct-config-update.ts](../../src/runtime/control-plane/direct-config-update.ts)

Out of scope:

- generic host monitoring outside the `Performance` page
- autonomous maintenance or background cleanup jobs
- guaranteed application launch/keep-alive behavior
- power-mode enforcement on the host
- non-process cleanup actions beyond the reserved preview/run contract

## Operator Model

`Performance` is a workstation-operations domain. It exists to help the operator:

- inspect current host pressure
- inspect live processes
- maintain named performance profiles
- preview a guarded cleanup action
- execute only the reviewed subset of selectable rows
- review recent profile switches and cleanup actions

The current required web information architecture is defined in [WEBUI-DESIGN.md](./WEBUI-DESIGN.md#L311).

## Runtime Ownership

The runtime constructs one shared `PerformanceService` in [index.ts](../../src/index.ts#L4485) and wires it into the web dashboard callbacks in [index.ts](../../src/index.ts#L1957).

The service owns:

- active profile resolution
- host snapshot collection via the OS adapter
- live process decoration and protection tagging
- latency probe execution and short-lived caching
- preview generation for reviewed actions
- preview expiry
- reviewed action execution
- local history plus durable audit-backed history when an audit log is available

The service does not own layout, direct browser shell execution, or ad hoc config writes.

## Configuration Contract

Performance configuration lives under `assistant.performance` in [types.ts](../../src/config/types.ts#L676).

Current top-level fields:

- `enabled`
- `sampleIntervalSec`
- `trendRetentionDays`
- `alarms`
- `protectedProcesses`
- `profiles`

Profile fields:

- `id`
- `name`
- `powerMode`
- `autoActions`
- `processRules.terminate`
- `processRules.protect`
- `latencyTargets`

The default shipped profile lives in [types.ts](../../src/config/types.ts#L1759) and is currently `coding-focus`.

Config writes from the web UI are normalized through [direct-config-update.ts](../../src/runtime/control-plane/direct-config-update.ts#L427). The browser does not write raw YAML directly.

## Platform Capabilities

### Windows

Windows uses [WindowsPerformanceAdapter](../../src/runtime/performance-adapters/windows.ts#L107).

Current as-built behavior:

- host CPU, memory, disk, and process counts are sampled
- live processes are listed from `Get-Process`
- executable path and cumulative CPU time are exposed when available
- selected process rows can be terminated with `taskkill`
- latency probes are supported

Current limitations:

- `canManagePower` is `false`
- `runCleanupActions()` is not implemented
- per-process CPU percent is not currently collected, so process ranking is primarily memory-driven on Windows
- exact Task Manager icons are not extracted

### Linux/macOS Fallback

Fallback uses [FallbackPerformanceAdapter](../../src/runtime/performance-adapters/fallback.ts#L97).

Current as-built behavior:

- host CPU, memory, disk, and process counts are sampled
- live processes are listed from `ps`
- per-process CPU percent and memory are exposed
- latency probes are supported

Current limitations:

- process termination is disabled
- non-process cleanup actions are disabled
- power management is disabled

## Process Protection Model

Protection is assembled in [performance-service.ts](../../src/runtime/performance-service.ts#L330) from:

- global `assistant.performance.protectedProcesses.names`
- the active profile `processRules.protect`
- Guardian's own running process names
- an explicit default protection for `node`

Protected rows remain visible in the live process browser and cleanup preview, but they are marked non-selectable with a reason.

Important behavior:

- `protect` means "Guardian must not target this executable name for cleanup"
- it does not mean "ensure this process is launched"

## Cleanup Preview Model

The only supported reviewed action id today is `cleanup`, enforced in [performance-service.ts](../../src/runtime/performance-service.ts#L615).

As built, `cleanup` is primarily a reviewed process-selection workflow:

- explicit candidates come from the active profile `processRules.terminate`
- if those do not match the live process list, the service falls back to heuristic recommendations
- heuristic recommendations suppress common development, system, and browser processes
- heuristic recommendations favor known background apps and notably heavy CPU or memory usage

Current heuristic families are defined in [performance-service.ts](../../src/runtime/performance-service.ts#L29) and scored in [performance-service.ts](../../src/runtime/performance-service.ts#L244).

Preview behavior:

- previews expire after 10 minutes
- at most 8 ranked process targets are returned
- `cleanupTargets` is currently always empty
- risk is classified as `low`, `medium`, or `high`
- protected rows remain in the preview but are disabled

## Action Execution Model

Reviewed actions run through [runAction()](../../src/runtime/performance-service.ts#L644).

Current behavior:

- the request must reference a non-expired preview
- the request must select at least one explicit target id
- the service rejects stale or now-invalid selections
- selected process targets are passed to the adapter for termination
- selected cleanup target ids are accepted by contract, but no concrete cleanup tasks are implemented today
- every successful or failed run is added to local history and, when available, the audit log

Important non-goals in the current build:

- applying a profile does not kill terminate-listed apps
- applying a profile does not launch protected apps
- the service does not perform autonomous corrective actions in the background

## Latency Probes

Latency targets are profile-scoped. The service resolves them from either:

- `target`
- `targetRef`

and caches probe results for `sampleIntervalSec`, implemented in [performance-service.ts](../../src/runtime/performance-service.ts#L521).

Current target kinds:

- `internet`
- `api`

These are advisory diagnostics for `Overview`. They do not trigger automatic actions in this build.

## Web Control Plane

Current performance routes:

- `GET /api/performance/status`
- `GET /api/performance/processes`
- `POST /api/performance/profile/apply`
- `POST /api/performance/action/preview`
- `POST /api/performance/action/run`

See [web-runtime-routes.ts](../../src/channels/web-runtime-routes.ts#L721).

Privilege model:

- `status` and `processes` are authenticated read paths
- `profile/apply` requires a privileged ticket for `performance.manage`
- `action/run` requires a privileged ticket for `performance.manage`
- `action/preview` is read-only and does not require a privileged ticket

The browser client mints privileged tickets through [api.js](../../web/public/js/api.js#L108) before calling the mutating routes.

## Web UI Surface

The operator-facing page is [performance.js](../../web/public/js/pages/performance.js#L65).

Current required tabs:

- `Overview`
- `Profiles`
- `Cleanup`
- `History`

Current as-built UX:

- `Overview` shows the current host snapshot, top processes, runtime capability flags, and latency targets
- `Profiles` supports create, edit, apply, and delete for performance profiles
- `Profiles` includes a live running-process browser grouped by executable name with quick-add into terminate/protect rules
- `Cleanup` is preview-first and only runs the reviewed subset
- `History` shows profile applications and reviewed action runs

## Assistant Tool Surface

There is no dedicated performance-management skill in `skills/`.

Assistant access is provided through deferred built-in tools:

- `performance_status_get`
- `performance_profile_apply`
- `performance_action_preview`
- `performance_action_run`

See [performance-tools.ts](../../src/tools/builtin/performance-tools.ts#L42) and the deferred-tool inventory note in [tool-context.ts](../../src/tools/tool-context.ts#L177).

These tools are:

- runtime-backed, not web-page backed
- category `system`
- deferred by default and intended to be discovered through `find_tools`

`performance_action_run` supports two modes:

- explicit execution from an existing preview id
- generate-a-preview-first and then run either the default-checked or all selectable rows

## Approval and Audit

Mutating tool calls participate in the shared approval model. Approval copy is specialized in [pending-approval-copy.ts](../../src/runtime/pending-approval-copy.ts#L575).

Durable audit event families:

- `performance.profile_applied`
- `performance.action_run`

See [performance-service.ts](../../src/runtime/performance-service.ts#L27).

## Current Gaps and Non-Goals

Not implemented in the current build:

- autonomous performance actions
- non-process cleanup task implementations
- host power-mode changes
- startup-app or service management
- exact Windows shell icon extraction
- process launch/keep-alive semantics for protected apps
- dedicated direct-intent routing for performance workflows
- a dedicated performance skill

This capability should not be documented as if those features already exist.

## Verification Baseline

Relevant coverage currently lives in:

- [performance-service.test.ts](../../src/runtime/performance-service.test.ts)
- [performance-tools.test.ts](../../src/tools/builtin/performance-tools.test.ts)
- [performance-dashboard-callbacks.test.ts](../../src/runtime/control-plane/performance-dashboard-callbacks.test.ts)
- [channels.test.ts](../../src/channels/channels.test.ts)

When changing this capability, the minimum verification bar should include:

- `npm run check`
- focused Vitest coverage for runtime service, tools, callbacks, and channel routes
- relevant web smoke coverage when the local environment can authenticate successfully
