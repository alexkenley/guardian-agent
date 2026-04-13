# Security Isolation Spec

**Status:** Canonical architecture reference for current and planned isolation backends  
**Date:** 2026-04-12  
**Owner:** Runtime + Security  
**Related:** [SECURITY.md](/mnt/s/Development/GuardianAgent/SECURITY.md), [Brokered Agent Isolation Spec](/mnt/s/Development/GuardianAgent/docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md), [Coding Workspace Spec](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md), [Remote Sandboxing Spec](/mnt/s/Development/GuardianAgent/docs/specs/REMOTE-SANDBOXING-SPEC.md), [Tools Control Plane Spec](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [Sandbox Egress And Secret Brokering Uplift](/mnt/s/Development/GuardianAgent/docs/proposals/SANDBOX-EGRESS-AND-SECRET-BROKERING-ROADMAP.md)

This spec is the one-stop reference for how Guardian models execution isolation across brokered workers, local process sandboxes, local VM-backed isolation, and remote sandbox backends.

Backend-specific docs remain the source of truth for implementation details. For provider-backed bounded coding execution, [Remote Sandboxing Spec](/mnt/s/Development/GuardianAgent/docs/specs/REMOTE-SANDBOXING-SPEC.md) is the concrete implementation reference. This document defines the shared contract and the security boundaries that must stay stable as new backends are added.

## Goal

Define one backend-neutral isolation model so Guardian can add stronger execution backends without creating a second control plane or weakening existing security guarantees.

The design must support:

- current brokered worker isolation
- current local process sandboxing
- distinct Windows process-sandbox and Hyper-V-backed tiers
- future Linux VM-backed isolation
- provider-attached remote sandbox execution

## Core Principles

1. Guardian owns the control plane.
   Routing, approvals, pending actions, audit, memory, policy, secret resolution, and output scanning remain Guardian-owned regardless of where bounded execution happens.

2. Isolation is capability-driven.
   Layer 1.5 is not "the bwrap feature" or "the Hyper-V feature." It is a workload-to-backend selection layer.

3. Stronger isolation adds containment, not authority.
   A VM or remote sandbox may run a job, but it does not decide policy, mutate approvals, or directly own durable memory.

4. Honest reporting matters.
   AppContainer/helper isolation is not equivalent to Hyper-V. A remote VM is not equivalent to a local no-network brokered worker. Status, setup, and audit surfaces must report the actual backend and network mode used.

5. Prefer simplicity until stronger isolation is warranted.
   Guardian should choose the least-complex boundary that safely satisfies the workload. Do not push routine local data-plane work into remote sandboxes just because the backend exists.

## Isolation Taxonomy

Guardian's relevant boundaries are:

- `Layer 1: admission and policy`
  - input sanitization
  - denied-path and shell validation
  - SSRF and secret controls
  - approval policy

- `Brokered execution boundary`
  - the built-in chat/planner loop runs in a brokered worker
  - the worker has no direct tool, approval, or raw provider authority

- `Layer 1.5: execution isolation`
  - local process sandbox
  - local virtualized strong isolation
  - remote virtualized execution

- `Layer 2+`
  - inline Guardian evaluation
  - output scanning and trust classification
  - audit and retrospective detection

Isolation backends live inside Layer 1.5. They do not replace the other layers.

## Shared Control-Plane Ownership

The execution backend must not become a second runtime.

Guardian keeps ownership of:

- intent classification and routing
- tool admission and policy checks
- approval creation, display, binding, and completion
- memory reads/writes and trust state
- connector/provider auth and credential resolution
- audit logging
- final output scanning and trust classification

The backend receives only:

- a bounded job or session contract
- staged inputs and allowed artifacts
- an execution profile
- a network mode
- time/resource limits

The backend returns only:

- status
- stdout/stderr or structured events
- artifacts and metadata

## Backend Classes

| Backend class | Status | Typical use | Notes |
|---|---|---|---|
| `brokered_worker` | Implemented | built-in chat/planner loop | no direct LLM network egress; tools and approvals stay supervisor-owned |
| `local_process_sandbox` | Implemented | managed subprocesses on Linux and current Windows helper path | current strong/degraded/unavailable posture mostly describes this class |
| `windows_process_sandbox` | Implemented as the current Windows helper/AppContainer tier | lower-friction Windows hardening | useful, but not equivalent to a VM boundary |
| `local_virtualized_strong_isolation` | Parallel/planned | hostile or semi-trusted bounded jobs on the same machine or host OS family | Hyper-V on Windows is the current concrete direction |
| `remote_virtualized_execution` | Implemented initial slice | bounded cloud-sandbox jobs | provider adapters such as Vercel or Daytona plug into the shared orchestration model rather than creating a separate runtime |

## Network Modes

Backends should report which network modes they support and Guardian should select from the shared set:

- `no_network`
  - no direct outbound network access
  - preferred default for brokered workers and many read-only or local-only jobs

- `brokered`
  - outbound access only through Guardian-owned brokerage
  - appropriate where Guardian terminates or mediates the protocol

- `allowlisted_egress`
  - bounded outbound access to explicit destinations
  - should be paired with strong audit and clear policy attachment

The network mode is part of the run contract, not a hidden backend implementation detail.

## Workload Classes

Guardian should classify execution needs by workload, not by product label.

| Workload class | Default posture | Why |
|---|---|---|
| `assistant_chat` | brokered worker | isolates the planner loop from the supervisor and removes direct LLM network egress |
| `local_data_plane` | supervisor-owned runtime | memory, contacts, notes, calendars, and provider mutations are control-plane or data-plane operations, not phase-1 remote sandbox targets |
| `bounded_repo_job` | local process sandbox first | build, test, lint, indexing, and similar bounded repo jobs usually fit the local process tier |
| `semi_trusted_exec` | strong local or remote virtualization when available | bootstrap, install-like, or higher-risk execution may need a stronger boundary |
| `secret_bearing_network_subprocess` | prefer supervisor-owned or brokered network paths | until the egress-broker model is complete, avoid treating arbitrary network-capable subprocesses as fully solved by a sandbox alone |

## Selection Rules

Guardian should follow these rules when selecting an execution boundary:

1. If the task does not require a subprocess or detached execution context, keep it in the normal Guardian runtime path.
2. The built-in chat/planner loop stays brokered even when stronger job backends exist.
3. For managed subprocess work, start with the least-complex backend that satisfies policy, trust posture, and host capabilities.
4. If a workload or policy requires a stronger boundary and the required backend is unavailable, fail closed or require an explicit degraded fallback. Do not silently downgrade.
5. Windows process-sandbox and Windows Hyper-V tiers must be treated as distinct backends in diagnostics, setup, and audit.
6. Remote sandbox backends are job-oriented execution substrates. They do not replace Guardian's memory model, approval flow, or intent gateway.
7. Provider-specific adapters belong below the shared execution contract. Choosing Vercel versus Daytona is a backend selection concern, not a new runtime model.

## Coding Workflow Guidance

For the coding workflow, the phase-1 posture relies on automatic tier promotion:

- Automatically promoted to a remote sandbox (when configured):
  - dependency install (`package_install`)
  - build, test, and lint (`code_build`, `code_test`, `code_lint`)
  - explicit remote execution requests (`code_remote_exec`)

- Local-by-default operations:
  - normal code chat
  - repo-grounded planning
  - `fs_write` and patch application against the local workspace
  - session memory, approvals, and transcript handling
  - non-coding product operations such as Second Brain data access

If a remote sandbox is *not* configured, the runtime falls back to the `local_process_sandbox` and relies on the operator's `assistant.tools.sandbox.enforcementMode` to block or allow degraded execution (e.g., `allowPackageManagers`).


## Windows-Specific Contract

Guardian's Windows isolation story should be expressed as separate tiers:

- `windows_process_sandbox`
  - host-process hardening via the Windows helper/AppContainer path
  - useful fallback and lower-friction tier

- `windows_hyperv_strong_isolation`
  - virtualization-backed boundary
  - intended strong tier for hostile or semi-trusted bounded execution

The lower tier must not be described as if it provides the same guarantees as the Hyper-V tier.

## Remote Sandbox Contract

Provider-backed remote isolation should plug into the same Layer 1.5 model.

Requirements:

- explicit connector configuration and capability enablement
- backend availability and health reporting
  - provider readiness must be based on a real probe, not configuration completeness alone
  - the shared runtime may cache probe results briefly, but it must surface when a configured provider is currently unreachable
- supported network modes declared by backend
- staged input and bounded artifact return
- Guardian-owned approvals, audit, secrets, and memory
- no silent promotion of whole conversations into remote execution

For coding workflows, remote sandbox backends may keep either an ephemeral lease for one-off runs or a managed session-scoped lease so repeated bounded jobs in the same coding session can reuse installed prerequisites and sandbox-local caches without promoting the whole conversation into a remote runtime. The lease is still Guardian-owned orchestration state:

- keyed to the Guardian coding session and workspace root
- subject to idle expiry when ephemeral, or explicit release when managed
- provider-specific below the shared remote-execution contract
- reported honestly in run metadata and operator surfaces

Managed code-session sandboxes are operator-visible from the Code workspace and must be cleaned up through shared backend deletion/release paths rather than relying on browser-only best-effort cleanup.

In other words: remote sandboxes are execution backends, not remote brains.

## Secrets And Egress

Isolation is only one part of the security story.

Sandboxing alone does not mean:

- secrets can be safely injected as raw environment variables
- arbitrary outbound traffic is acceptable
- any network-capable subprocess is automatically safe

The target direction remains:

- supervisor-owned provider connectivity where possible
- explicit provider attachment to a run
- brokered or allowlisted egress
- honest degraded-host behavior when those guarantees are unavailable

See the sandbox-egress proposal for the longer-term model.

## Audit And Operator Visibility

Every isolation path should surface:

- the backend identity that actually ran
- the selected network mode
- why that backend was chosen
- whether the run was degraded from a stronger preferred tier
- whether approval or policy forced a stricter posture

Operators should not have to infer from symptoms whether a task ran in a helper sandbox, a VM boundary, or a remote provider sandbox.

## Non-Goals

This spec does not claim:

- universal descendant-process identity enforcement on all hosts
- that every developer-authored execution path is already fully virtualized
- that remote sandboxes should own Guardian's state or memory
- that provider choice is decided here beyond fitting the shared execution contract

## Current Implementation Shape

Today, the shipped system already provides:

- brokered worker isolation for the built-in chat/planner loop
- local process sandboxing with strong/degraded/unavailable posture
- current Windows helper/AppContainer process isolation tier
- provider-attached remote sandbox execution for bounded coding jobs with shared target selection plus managed code-session sandbox reuse

This spec exists so upcoming backends such as Hyper-V and provider-attached remote sandboxes land under the same model instead of growing as parallel one-off security systems.
