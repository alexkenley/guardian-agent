# Windows 11 Performance Manager Proposal

**Status:** Historical proposal. The current as-built behavior is defined in [PERFORMANCE-MANAGEMENT-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/PERFORMANCE-MANAGEMENT-SPEC.md).  
**Date:** 2026-04-05  
**Primary Guardian files:** [web/public/index.html](/mnt/s/Development/GuardianAgent/web/public/index.html), [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js), [web/public/js/api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js), [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts), [src/runtime/control-plane/operations-dashboard-callbacks.ts](/mnt/s/Development/GuardianAgent/src/runtime/control-plane/operations-dashboard-callbacks.ts), [src/runtime/host-monitor.ts](/mnt/s/Development/GuardianAgent/src/runtime/host-monitor.ts), [src/tools/builtin/network-system-tools.ts](/mnt/s/Development/GuardianAgent/src/tools/builtin/network-system-tools.ts), [src/tools/types.ts](/mnt/s/Development/GuardianAgent/src/tools/types.ts), [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts), [native/windows-helper/src/main.rs](/mnt/s/Development/GuardianAgent/native/windows-helper/src/main.rs), [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)  
**Related docs:** [docs/specs/WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md), [docs/guides/CAPABILITY-AUTHORING-GUIDE.md](/mnt/s/Development/GuardianAgent/docs/guides/CAPABILITY-AUTHORING-GUIDE.md), [docs/architecture/FORWARD-ARCHITECTURE.md](/mnt/s/Development/GuardianAgent/docs/architecture/FORWARD-ARCHITECTURE.md), [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [docs/specs/SHARED-STATE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/SHARED-STATE-SPEC.md)

---

## Executive Summary

Guardian should add a new top-level `Performance` page to the web UI, positioned in the current shell between `Reference Guide` and `Configuration`, with a Windows 11-first implementation and an OS-adapter model for Linux and macOS fallback.

The page is not just a read-only dashboard. It is a guarded host performance manager that can:

- monitor OS resource health
- monitor internet and API latency
- recommend performance actions
- switch between named performance profiles
- execute approved cleanup and process-management actions
- autonomously apply a narrow allowlisted set of low-risk actions when the operator has explicitly enabled that behavior

The recommendation is to build this as a Guardian-native operational domain, not as an ad hoc optimizer script bundle. That means:

- monitoring lives in shared runtime services
- config and profile writes go through control-plane services
- manual and autonomous actions flow through the existing approval, pending-action, audit, and policy model
- new tools remain deferred by default
- the UI is backed by typed dashboard contracts rather than direct shell execution from the browser

Windows 11 is the primary target because it is the user need and because Windows has the richest optimization surface here: power schemes, process control, cache cleanup, startup noise, and host-level latency diagnostics. But the design should not trap Guardian in a Windows-only shape. The same page should render on other OSes with a reduced capability set and explicit unsupported states.

---

## Problem

Guardian already has pieces of this space:

- host monitoring via [src/runtime/host-monitor.ts](/mnt/s/Development/GuardianAgent/src/runtime/host-monitor.ts)
- gateway monitoring via existing control-plane callbacks
- network diagnostics via [src/tools/builtin/network-system-tools.ts](/mnt/s/Development/GuardianAgent/src/tools/builtin/network-system-tools.ts)
- web operational pages with typed APIs and SSE invalidation

What it does not have is a single operator surface for workstation performance management.

The missing operator workflow looks like this:

1. See whether the machine is slow because of CPU, RAM, disk, thermals, network, or external API latency.
2. Distinguish development-related processes from unrelated background noise.
3. Switch into a profile such as `Coding Focus` or `Deep Cleanup`.
4. Preview a safe set of actions.
5. Let Guardian execute only the approved actions, with guardrails and auditability.
6. Optionally allow Guardian to perform a small set of autonomous corrective actions when clear thresholds are crossed.

Today that workflow is spread across Task Manager, vendor utilities, random PowerShell snippets, browser tabs, and manual judgment.

---

## Design Principles

### 1. Performance is an operational domain, not a config sub-tab

This proposal adds a first-class `Performance` page, even though the immediate nav placement requested is between `Reference Guide` and `Configuration`.

That placement is acceptable for the current shell, but the owning concept is still operational:

- monitoring
- investigation
- action preview
- action execution
- alarm review
- profile application

This means [docs/specs/WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md) will need a follow-up update so the information architecture formally recognizes `Performance` as its own domain.

### 2. No fake "RAM booster" claims

Guardian should support real OS actions, but it should not market placebo behavior as optimization.

Examples:

- killing or lowering priority of explicit background processes is real
- deleting temporary files is real
- DNS cache flush is real
- power scheme switching is real
- per-process working set trimming is real but situational
- undocumented or highly aggressive global memory purges should never be default behavior

### 3. Development work is protected by default

The feature is specifically useful when the operator wants to suppress non-development noise while coding. The system therefore must bias toward preserving:

- active code-session processes
- Guardian-launched coding backend processes
- terminals, editors, compilers, Docker, WSL, git, SSH, browsers tagged as dev-critical, and user-pinned apps

### 4. Autonomous actions stay narrow and explicit

Autonomy is allowed only for an allowlisted action catalog and only after the operator opts in.

Examples of candidate autonomous actions:

- clear user temp files for known safe paths
- flush DNS cache
- terminate a configured allowlisted background process family
- switch to a configured low-noise performance profile

Examples that should remain manual or blocked:

- registry debloat
- startup-service disabling
- uninstall flows
- task-scheduler edits
- broad "optimize Windows" tweak packs

### 5. Cross-OS rendering, Windows-first capability

The UI should always render one `Performance` page, but its capabilities come from the runtime.

- Windows 11: full monitoring and action surface
- Linux/macOS: read-only metrics and a smaller action catalog
- unsupported features are shown as unavailable, not hidden

---

## Capability Authoring Alignment

This proposal should be implemented according to [docs/guides/CAPABILITY-AUTHORING-GUIDE.md](/mnt/s/Development/GuardianAgent/docs/guides/CAPABILITY-AUTHORING-GUIDE.md), and the correct capability split is:

- primary shape: native runtime integration plus dashboard/control-plane surface
- secondary shape: deferred built-in tools for assistant access to the same runtime-owned actions
- optional later shape: background maintenance sampling for trends and alarms
- not Phase 1: new direct intent route
- not Phase 1: new skill

### Answering the guide's seven start questions

1. `What kind of capability is this?`
   It is primarily a runtime-owned performance monitoring and action system with a web operator surface, plus a smaller assistant tool surface.
2. `Which runtime layer owns it?`
   Runtime services under `src/runtime/` own sampling, profiles, actions, alarms, and OS adapters. Control-plane callbacks own operator mutations. The web page only renders and submits typed requests.
3. `Does it need direct intent routing?`
   No in Phase 1. Assistant usage should stay in the normal tool loop through deferred built-in tools. A direct route is only justified later if this becomes a first-class workflow that normal tool use cannot express cleanly.
4. `Does it create blocked work, approvals, clarifications, or resume state?`
   Yes. Process termination, cleanup execution, and some profile applications can all block on approval or clarification. Those flows must use shared pending-action orchestration.
5. `Does it need operator configuration or a web surface?`
   Yes. Profiles, protected processes, autonomous-action policy, alarms, history, and action previews all need typed web and control-plane support.
6. `Does it create durable state, audit events, or maintenance jobs?`
   Yes. Profiles, history, trend snapshots, alarm state, and action history are durable. Mutations must be audited. Sampling and alarm evaluation may run as bounded maintenance work.
7. `What tests and harnesses prove it works?`
   Unit coverage for runtime services, tools, and protected-process logic; dashboard callback tests; web smoke coverage; approval/pending-action coverage; and the normal web/coding assistant harnesses after implementation.

### Assistant capabilities vs operator capabilities

The design should stay explicit about this split.

#### Operator capabilities

These are the main product surface:

- the `Performance` page
- profile CRUD and apply
- action preview
- process selection and confirmation
- latency targets and alarm review
- autonomous-action policy

These belong in:

- `src/runtime/`
- `src/runtime/control-plane/`
- `src/channels/web-types.ts`
- `src/channels/web-runtime-routes.ts`
- `web/public/`

#### Assistant capabilities

These should be narrower and runtime-backed:

- read current performance status
- list profiles
- apply a profile
- preview cleanup
- run an approved cleanup
- preview process-control candidates
- execute approved process actions
- run latency probes

These belong in deferred built-in tools, not in a skill and not in web-only code.

#### Why not a skill first

A skill would only provide advisory workflow text. It would not solve:

- runtime authority
- action policy
- approvals
- process protection
- durable state
- web operator control

That makes a skill the wrong primary capability shape here. If later we want reusable prompt-time guidance for safe workstation triage, that can be added after the runtime and tool surfaces exist.

---

## External Research Inputs

The proposal is informed by the following open-source projects and platform documentation:

- [System Informer](https://github.com/winsiderss/systeminformer): process-, service-, and network-centric workstation investigation model
- [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor): temperature, fan, voltage, clock, and hardware telemetry model
- [WinUtil](https://github.com/ChrisTitusTech/winutil): preset-oriented Windows utility UX and grouped system actions
- [Glances](https://github.com/nicolargo/glances): cross-platform monitoring, web exposure, and action/threshold framing
- [Netdata](https://github.com/netdata/netdata): per-second collection, anomaly detection, alerting, and auto-generated operational views
- [systeminformation](https://github.com/sebhildebrandt/systeminformation): Node-friendly cross-platform metrics collection for CPU, memory, disks, services, and processes
- [BleachBit](https://github.com/bleachbit/bleachbit): cleaner-definition and preview-before-delete model
- [Blackbox Exporter](https://github.com/prometheus/blackbox_exporter): modular latency and synthetic probe model for HTTP, HTTPS, DNS, TCP, and ICMP
- [Get-Counter](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-counter?view=powershell-7.5): Windows performance counter access
- [powercfg](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options): Windows power scheme control and diagnostics
- [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill): Windows process termination semantics
- [EmptyWorkingSet](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-emptyworkingset): per-process working set trimming

### Key takeaways from the research

1. Good performance tooling combines live metrics, process visibility, and one-click actions rather than treating them as separate products.
2. Presets matter. Operators do not want to manually tune the same knobs every session.
3. Cleanup needs a manifest and preview model, not a bag of opaque scripts.
4. Latency needs both passive and active measurements.
5. Aggressive Windows tweak surfaces are high-risk and must be gated more tightly than read-only monitoring.

---

## Goals

1. Add a Windows 11-first `Performance` page to the web UI.
2. Support named profiles that can be applied quickly.
3. Surface live CPU, memory, disk, process, startup-noise, and latency signals.
4. Provide guarded manual actions for process management and cleanup.
5. Allow a very small operator-approved autonomous action set.
6. Keep development-related processes protected by default.
7. Preserve Guardian architecture: shared orchestration, control-plane writes, typed web contracts, and auditability.

## Non-Goals

1. Do not build a generic Windows debloater.
2. Do not silently modify registry, startup entries, services, or Defender posture as "performance optimization".
3. Do not add ad hoc per-page approval or resume logic outside the shared orchestration model.
4. Do not force a Windows-only product shape.
5. Do not claim unsupported "clear RAM" improvements as a default optimization strategy.

---

## Proposed Operator Experience

### Navigation

Add a new left-nav item:

- `Performance`

The desired product direction is to place it in the current shell between `Reference Guide` and `Configuration`, matching the requested placement.

However, [docs/specs/WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md) is now the WebUI source of truth and its current required left-nav order does **not** yet include `Performance`.

That means implementation must follow one of these paths:

1. update `WEBUI-DESIGN-SPEC.md` in the same change that introduces a top-level `Performance` page, making the information-architecture change explicit
2. do **not** silently insert a top-level page in code until the spec has been amended

So this proposal should be read as a product/design candidate that requires a spec-coordinated WebUI IA change before implementation. The implementation touchpoints remain [web/public/index.html](/mnt/s/Development/GuardianAgent/web/public/index.html) and [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js), but they should not be changed ahead of the governing spec.

### WebUI Standard Compliance

If and when `Performance` is implemented, it should follow the current WebUI standard from [docs/specs/WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md):

- one page owns one domain
- summaries do not duplicate control planes
- operations stay separate from configuration
- page and tab intro blocks are required and collapsed by default
- section help must describe the actual rendered section
- linked cards and quick links must expose destination guidance
- visual implementation follows the current sharp-edge, zero-radius, accent-border standard

This proposal already assumes `Performance` is an operational domain, not a config sub-tab, so any eventual WebUI spec update should preserve that ownership model rather than bury the surface under `Configuration`.

### Page Structure

The `Performance` page should have these tabs:

1. `Overview`
2. `Profiles`
3. `Live`
4. `Latency`
5. `Actions`
6. `History`

### Overview

Shows:

- active profile
- current OS and capability badge set
- CPU, memory, disk, network, and optional temperature summary
- top background offenders
- internet/API latency summary
- recommendations
- active performance alarms

### Profiles

Shows:

- built-in starter profiles
- custom profiles
- action preview for the selected profile
- protected-process rules for the selected profile
- autonomous-action policy for the selected profile

Suggested starter profiles:

- `Coding Focus`
- `Balanced`
- `Deep Cleanup`
- `Low Latency`

### Live

Shows:

- top processes by CPU, RAM, disk, or network impact
- background app and service summary
- startup and scheduled-noise recommendations
- sensor telemetry when available on the current OS

### Latency

Shows:

- passive Guardian latency metrics
- synthetic internet latency probes
- API/provider latency probes
- DNS, TCP connect, TLS, and response timing breakdown where applicable

### Actions

Shows:

- recommended actions with rationale
- preview-first cleanup plans
- process control actions
- explicit review checklist before kill/cleanup execution
- profile application controls
- approval state and policy state

### History

Shows:

- action history
- profile switch history
- alarm history
- trend lines for key metrics
- whether Guardian acted manually, by policy approval, or autonomously

### High-Risk Action Review Flow

For process termination and other disruptive cleanup, the operator flow should be preview-first and selection-based.

Recommended UX:

1. The operator clicks `Preview cleanup` or `Preview process cleanup`.
2. Guardian returns a typed preview grouped into:
   - processes proposed for termination
   - cleanup actions proposed for execution
   - blocked or protected targets that cannot be selected
3. In the process list, killable rows are checked by default.
4. The operator can uncheck any row to remove it from the batch.
5. Protected or critical rows are shown with a reason and are not selectable.
6. The confirm action shows the exact selected count, for example `Kill 6 selected processes`.
7. The submitted execution only includes the operator-confirmed subset.

This is the right default. It is simple, fast, and keeps the operator in control while still supporting quick cleanup.

Each preview row should include:

- process name
- PID
- publisher or path when available
- CPU and RAM impact
- reason it was suggested
- risk badge
- protection status

---

## Core Concepts

### Performance Profiles

A profile is a named policy plus action bundle. It is not only a theme or a power plan.

Each profile defines:

- preferred power mode or scheme
- protected process groups
- background process targets
- cleanup actions allowed
- latency probe set
- alarm thresholds
- autonomous action allowance

Example profile intent:

- `Coding Focus`: preserve dev apps, terminate or de-prioritize chat/updater/media noise, keep network/API latency probes hot, avoid broad cleanup that could disrupt docs or login state
- `Deep Cleanup`: delete temp/cache targets, end explicitly allowed background apps, optionally trim selected process working sets, then return to a balanced power mode

### Protected Process Set

This is critical.

Guardian should never auto-end:

- itself
- active code-session attached processes
- coding backend processes
- terminals or editors in active use
- operator-pinned process names
- system-critical Windows services/processes

Protected state should be built from:

- current Guardian code-session state
- process ancestry
- operator config
- built-in critical process allowlists

### Performance Alarms

Performance alarms are not Security alerts.

They should live on the `Performance` page and use their own wording, while reusing shared lifecycle and notification patterns where technically useful.

Example alarms:

- sustained RAM pressure
- sustained CPU saturation by background apps
- low free disk on a monitored volume
- repeated API latency degradation
- repeated internet packet loss or DNS failure

### Recommendations Engine

The page should not require the operator to infer every action manually.

The recommendation engine maps observed state into:

- no-op
- suggested profile switch
- suggested cleanup
- suggested process intervention
- suggested network/provider investigation

The recommendation engine proposes; it does not mutate host state unless policy explicitly allows the matching action.

### Preview And Selection Batch

Disruptive actions should run through a first-class preview object, not a loose list of command arguments.

Illustrative shape:

```ts
interface PerformanceActionPreview {
  previewId: string;
  profileId?: string;
  processTargets: Array<{
    targetId: string;
    name: string;
    pid: number;
    cpuPercent?: number;
    memoryMb?: number;
    suggestedReason: string;
    checkedByDefault: boolean;
    selectable: boolean;
    blockedReason?: string;
    risk: 'low' | 'medium' | 'high';
  }>;
  cleanupTargets: Array<{
    targetId: string;
    label: string;
    checkedByDefault: boolean;
    selectable: boolean;
    blockedReason?: string;
    estimatedBytes?: number;
    risk: 'low' | 'medium' | 'high';
  }>;
}
```

Execution should require the selected subset from that preview result, for example:

```ts
interface ApprovedPerformanceAction {
  previewId: string;
  selectedProcessTargetIds: string[];
  selectedCleanupTargetIds: string[];
}
```

This keeps the kill/cleanup path explicit, reviewable, and easy to resume through shared orchestration if approval is required.

---

## Windows 11-First Action Catalog

The Phase 1 and Phase 2 action catalog should stay narrow and defensible.

### Safe candidates

- apply power profile using `powercfg`
- end configured background processes using `taskkill` or native APIs, but only from a previewed and operator-confirmed target set
- de-prioritize configured background processes
- clear user temp directories from a manifest-backed safe path set
- flush DNS cache
- clear selected app caches when the app-specific cleaner definition is explicit
- empty recycle bin only when explicitly selected

### Expert-mode or manual-only candidates

- trim a selected process working set using `EmptyWorkingSet`
- purge standby list or equivalent memory-list actions
- stop a non-critical service
- temporarily suspend a background process tree

### Out of scope by default

- registry tweak packs
- service disablement presets
- telemetry/privacy debloat bundles
- startup-item deletion
- "optimize all Windows settings" scripts

---

## OS Adapter Model

The feature should be implemented behind a runtime adapter contract, for example:

```ts
interface PerformanceAdapter {
  getCapabilities(): PerformanceCapabilities;
  collectSnapshot(): Promise<PerformanceSnapshot>;
  collectProcesses(input?: ProcessQuery): Promise<ProcessSnapshot[]>;
  collectLatency(input?: LatencyProbeRequest): Promise<LatencyProbeResult[]>;
  previewAction(input: PerformanceActionRequest): Promise<PerformanceActionPreview>;
  runAction(input: ApprovedPerformanceAction): Promise<PerformanceActionResult>;
  applyProfile(input: ProfileApplyRequest): Promise<ProfileApplyResult>;
}
```

### Windows adapter

Primary implementation sources:

- `systeminformation` or OS APIs for broad metrics
- PowerShell `Get-Counter` and CIM queries where Windows-specific counters are better
- `powercfg` for power plans and diagnostics
- `taskkill` or native Win32 termination for process actions
- `EmptyWorkingSet` only for explicit expert-mode actions
- optional extension of [native/windows-helper/src/main.rs](/mnt/s/Development/GuardianAgent/native/windows-helper/src/main.rs) for Win32-only operations that are awkward from Node

### Linux/macOS adapters

Initial scope:

- read-only system metrics
- process listing
- limited manual cleanup and process actions where supported
- latency probes
- clear unsupported Windows-only actions in the UI

This satisfies the requirement that the page split behavior by OS without shipping three unrelated implementations.

---

## Guardian Architecture Fit

### Runtime services

Add a new runtime slice, likely under `src/runtime/`, such as:

- `performance-monitor.ts`
- `performance-profiles.ts`
- `performance-latency.ts`
- `performance-actions.ts`
- `performance-adapters/windows.ts`
- `performance-adapters/linux.ts`
- `performance-adapters/darwin.ts`

The key rule is that monitoring, profiles, and action policy belong in the runtime/control-plane layer, not in the web page code and not inline in [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts).

### Control plane

Add a focused control-plane callback module, for example:

- `src/runtime/control-plane/performance-dashboard-callbacks.ts`

That module should own:

- read-only page state callbacks
- profile CRUD and apply operations
- action preview and action execution
- alarm acknowledgment/resolution for performance alarms
- latency probe execution
- preview token validation and selected-target submission for process/cleanup batches

### Web contract

Extend [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts) with typed contracts for:

- `PerformanceStatus`
- `PerformanceSnapshot`
- `PerformanceProfile`
- `PerformanceActionPreview`
- `PerformanceActionResult`
- `PerformanceAlarm`
- `LatencyProbeResult`

### Web UI

Add:

- `web/public/js/pages/performance.js`
- route wiring in [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js)
- API client methods in [web/public/js/api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js)
- nav entry in [web/public/index.html](/mnt/s/Development/GuardianAgent/web/public/index.html)

### Tool surface

For chat-driven use, do not add a bespoke route first.

Phase 1 recommendation:

- keep direct chat support inside the normal tool loop
- add deferred built-in tools under the existing `system` category rather than inventing a new tool category immediately

Illustrative tool shapes:

- `sys_profile_list`
- `sys_profile_apply`
- `sys_process_preview`
- `sys_process_control`
- `sys_cleanup_preview`
- `sys_cleanup_run`
- `sys_latency_probe`

If the feature later proves to need a dedicated workflow, then add a formal Intent Gateway route in a follow-up. Do not start there.

### Shared orchestration and approvals

Any blocked execution must use the shared pending-action model. No performance-specific resume flow should be invented.

Examples:

- profile apply blocked on elevated action
- process end blocked on manual approval
- process end blocked pending operator target deselection or confirmation
- cleanup run blocked on ambiguous target set
- autonomous action paused because operator approval policy changed

The preview object and selected-target subset should be resumable through the shared pending-action model rather than a custom page-local interaction contract.

---

## Proposed Config Shape

Add an `assistant.performance` section in [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts) with a shape parallel to existing monitoring systems.

Illustrative config:

```yaml
assistant:
  performance:
    enabled: true
    sampleIntervalSec: 5
    trendRetentionDays: 7
    alarms:
      cpuPercentWarn: 85
      memoryPercentWarn: 88
      apiLatencyWarnMs: 2500
      internetPacketLossWarnPercent: 10
    protectedProcesses:
      names:
        - GuardianAgent
        - code
        - Code.exe
        - devenv
        - idea64
        - node
        - npm
        - git
        - docker
        - wsl
      honorActiveCodeSessions: true
    profiles:
      - id: coding-focus
        name: Coding Focus
        powerMode: high_performance
        autoActions:
          enabled: false
          allowedActionIds:
            - clear-temp-user
            - flush-dns
            - terminate-allowed-background-app
        processRules:
          terminate:
            - Discord.exe
            - Spotify.exe
          protect:
            - code
            - node
            - git
        latencyTargets:
          - kind: internet
            id: cloudflare
            target: https://1.1.1.1
          - kind: api
            id: default-llm
            targetRef: defaultProvider
```

The exact shape can change, but the design intent should remain:

- explicit profiles
- explicit protected processes
- explicit autonomous-action allowlist
- explicit latency targets

---

## Latency Model

The user asked for internet, latency, and API latency visibility. This should be implemented through both passive and active measurements.

### Passive metrics

Reuse existing Guardian timing data where available:

- routed request duration
- tool duration
- provider request duration
- run timeline durations

This gives real user-path performance, not only synthetic probes.

### Active probes

Add a probe system inspired by Blackbox Exporter module design:

- `icmp`
- `dns`
- `tcp`
- `http`
- `https`
- `guardian-internal`
- `provider-api`

Metrics to capture:

- success/failure
- latency
- packet loss
- jitter
- DNS time
- TCP connect time
- TLS handshake time
- first byte / response time

This should be operator-configurable so the page can monitor:

- home gateway
- local NAS or build box
- public internet targets
- configured LLM provider endpoints
- other APIs the user relies on during development

---

## Cleanup Model

Cleanup should be manifest-backed, previewable, and scoped.

That means:

1. Define cleaner actions as named entries, not opaque scripts.
2. Each cleaner declares what paths, caches, or commands it may touch.
3. Each run has a preview result:
   - targets
   - estimated reclaimable size
   - risk notes
4. The same cleaner definition can be manually run, profile-bound, or policy-approved for autonomy.

This is closer to BleachBit's cleaner-definition discipline than to a one-shot shell script.

Example cleaner definitions:

- `clear-temp-user`
- `clear-temp-system`
- `flush-dns`
- `clear-delivery-optimization-cache`
- `clear-browser-cache-edge`
- `clear-browser-cache-chrome`

The browser cleaners should stay opt-in because they can disrupt active sessions or development workflows.

---

## Guardrails

### Risk tiers

Suggested policy mapping:

- `read_only`: metrics, probes, previews
- `mutating` with `approve_by_policy`: safe cleanup actions and profile apply
- `mutating` with `approve_each`: process termination, service stop, expert-mode memory actions
- `deny` by default: broad Windows tweak packs, registry edits, startup disablement

### Dev-work protection

Before any mutating action, Guardian should evaluate:

- is the target process attached to an active code session?
- is it a known coding backend or terminal?
- is it operator-pinned?
- is it system-critical?
- is it parented by Guardian itself?

If yes, the action is blocked unless the operator explicitly overrides it.

### Autonomous policy envelope

Autonomous actions should require:

- feature enabled globally
- feature enabled in the active profile
- action ID on the allowlist
- stable threshold breach for a minimum duration
- cooldown budget not exceeded
- preview succeeded without ambiguity

Every autonomous action must produce:

- audit log entry
- performance history record
- visible UI notice

### Privilege handling

Some Windows actions require elevation.

The design should support:

- non-elevated read-only mode
- partial-action mode when some actions are unavailable
- explicit UI indication when the current Guardian process lacks needed rights

The design should not silently fail into a false-success path.

---

## Data Retention And History

Recommended retention model:

- in-memory hot samples for the last 15 minutes
- persisted minute rollups for 7 days
- action and alarm history persisted with explicit timestamps and actor/source

That gives:

- responsive charts
- bounded storage
- enough trend history for operator decisions

---

## Web UI Ownership

`Performance` should canonically own:

- host performance metrics
- performance profiles
- performance alarms
- cleanup previews and performance actions
- internet/API latency health

Other pages may show only summaries:

- `Dashboard`: one compact performance summary card
- `Security`: only cross-links if a performance issue overlaps with security posture
- `Configuration`: profile editing shortcuts are acceptable only if they deep-link back to `Performance`

This preserves the "one page owns one domain" rule.

This section should not be interpreted as overriding the current WebUI spec by itself. It is the intended ownership model **if** the spec is amended to introduce `Performance` as a first-class page.

---

## Implementation Plan

### Phase 1: Read-only performance page

Deliver:

- `Performance` page
- live read-only metrics
- latency tab
- history trend storage
- Windows-first adapter with Linux/macOS fallback

No mutating actions yet.

### Phase 2: Manual profiles and safe actions

Deliver:

- profile apply
- cleanup preview
- cleanup run
- explicit process control
- protected-process system

All mutating actions remain approval-gated.

### Phase 3: Autonomous allowlisted actions

Deliver:

- profile-level autonomous action policy
- cooldown budgets
- performance alarms with optional corrective actions
- full pending-action integration where policy requires approval

### Phase 4: Advanced Windows-specific depth

Deliver:

- optional richer sensor telemetry
- expert-mode memory actions
- better startup-impact and background-noise analysis
- optional Rust helper subcommands for Win32-only operations

---

## Testing And Verification

Implementation should include:

- unit tests for profile evaluation and action policy
- unit tests for protected-process classification
- unit tests for latency probe aggregation
- dashboard callback tests for performance endpoints
- web page smoke coverage for the new route
- chat/tool-path tests if performance tools are exposed to the assistant

Relevant harnesses after implementation:

- `npm test`
- `npm run check`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`

If the implementation touches approvals, pending actions, or control-plane writes, the matching approval and shared-orchestration harnesses should also run.

---

## Risks And Open Questions

### 1. WebUI spec-first requirement

`WEBUI-DESIGN-SPEC.md` is the current source of truth. This proposal should not be implemented as a top-level page unless that spec is updated in the same change to formally introduce `Performance` into the canonical navigation and ownership model.

### 2. Windows memory cleanup semantics are easy to overpromise

The design should communicate clearly that:

- per-process working set trim is situational
- cache cleanup is real but not magical
- "free RAM" is not the same thing as improving user-perceived performance

### 3. Action safety is more important than breadth

WinUtil-style broad tweak surfaces are tempting but too risky as an early Guardian feature.

### 4. Sensor telemetry may require optional dependencies

Advanced hardware telemetry is useful, but Phase 1 should not depend on shipping a heavy Windows-only sensor stack if basic OS metrics already satisfy the core need.

### 5. The operator selection UX must stay fast

The default-checked review list is the right interaction model as long as:

- protected targets are excluded or disabled
- the suggested reason is visible per row
- the confirm button reflects the current selected count
- the preview remains resumable if approval interrupts the run

---

## Recommendation

Proceed with a Windows 11-first `Performance` page and keep the first shipping scope disciplined:

- strong monitoring
- good profiles
- real latency visibility
- safe, previewable cleanup
- guarded process actions
- narrow autonomous policy

Do not try to ship a general-purpose Windows debloater under the `optimizer` label. The right Guardian feature is a host-performance control plane with explicit policy, auditability, and operator trust.

---

## External References

- System Informer: https://github.com/winsiderss/systeminformer
- LibreHardwareMonitor: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
- WinUtil: https://github.com/ChrisTitusTech/winutil
- Glances: https://github.com/nicolargo/glances
- Netdata: https://github.com/netdata/netdata
- systeminformation: https://github.com/sebhildebrandt/systeminformation
- BleachBit: https://github.com/bleachbit/bleachbit
- Blackbox Exporter: https://github.com/prometheus/blackbox_exporter
- Get-Counter: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-counter?view=powershell-7.5
- powercfg: https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options
- taskkill: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
- EmptyWorkingSet: https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-emptyworkingset
