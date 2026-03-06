# Windows App Options

## Purpose

This proposal compares the practical Windows deployment options for GuardianAgent when the goal is to support real host-level enforcement for risky local tools.

The central constraint is simple:

- kernel enforcement must happen on the Windows machine whose kernel is enforcing it
- a pure remote web app cannot provide Windows host-level sandboxing for local workstation actions

---

## Goals

- support Windows users without requiring WSL2 or Docker
- preserve a browser-friendly product experience where possible
- keep Guardian policy, approvals, audit, and orchestration consistent across platforms
- provide a realistic path to strong isolation for shell, browser, MCP, and other subprocess-backed tools

## Non-Goals

- inventing a new sandbox boundary in JavaScript
- driver-level Windows network enforcement in the first release
- forcing users into a heavyweight local virtualization stack

---

## Option 1: Desktop App

### Shape

- Electron or native desktop shell
- bundled Guardian runtime
- bundled `guardian-sandbox-win.exe`

### How it works

- UI runs locally as a desktop app
- local runtime executes tools directly on the machine
- risky subprocesses go through the Windows sandbox helper

### Pros

- simplest user mental model
- easiest local auth/session story
- easiest distribution of helper binary
- strongest control over lifecycle and updates

### Cons

- heavier install footprint
- less natural if product direction is primarily SaaS/browser-first
- desktop packaging/update complexity

### Best for

- local-first workstation automation
- single-user installs
- environments where desktop packaging is acceptable

---

## Option 2: Web UI + Local Runtime + Bundled Helper

### Shape

- browser UI served by cloud or local backend
- local Windows runtime/agent installed on the workstation
- bundled `guardian-sandbox-win.exe`

### How it works

1. user interacts through browser UI
2. backend handles identity, orchestration, policy, and audit
3. local runtime receives approved local-execution jobs
4. local runtime launches risky tools through the Windows helper
5. results stream back to UI

### Pros

- keeps a web-first product experience
- central backend can still own policy and multi-device identity
- local host actions remain enforceable on Windows
- no WSL2 or Docker required

### Cons

- requires installing a local runtime on the Windows machine
- pairing/auth between backend and local runtime must be designed carefully
- slightly more operational complexity than a pure desktop app

### Best for

- SaaS or browser-led products
- environments where local workstation actions are still required
- hybrid cloud/local control planes

---

## Option 3: Web UI + Local Windows Service

### Shape

- browser UI
- Windows service installed locally
- optional small tray app for sign-in/status
- bundled `guardian-sandbox-win.exe`

### How it works

- local service runs continuously
- browser UI or backend submits jobs to the service
- service invokes sandboxed helper for risky child processes

### Pros

- strong control over availability and background execution
- can support scheduled jobs and long-running local automation reliably
- clean foundation for enterprise management

### Cons

- more complex install/update path
- service permissions and lifecycle need careful handling
- larger operational step up from today’s app model

### Best for

- enterprise deployments
- always-on local execution
- scheduled local tasks and managed fleet rollout

---

## Option 4: Pure Remote Web App

### Shape

- browser UI
- remote backend only
- no local native runtime

### Result

- cannot provide Windows host-level kernel enforcement for local workstation actions
- suitable only for remote/cloud-side actions, not local shell/browser/filesystem execution on the user’s machine

### Recommendation

- not acceptable if GuardianAgent needs strong local sandboxing on Windows

---

## Recommended Direction

### Short Term

Option 2: `Web UI + Local Runtime + Bundled Helper`

Reason:

- preserves a browser-first product shape
- provides a clean place for local execution and sandbox enforcement
- aligns with the current Guardian control-plane architecture

### Medium Term

Support both:

- Option 1 for users who want a single packaged desktop app
- Option 2 for SaaS/browser-first deployments

This can share the same local runtime and sandbox helper code.

---

## Local Runtime Responsibilities

The local Windows runtime should own:

- job receipt and acknowledgement
- local policy re-check for host actions
- invocation of `guardian-sandbox-win.exe`
- local stdout/stderr streaming and result marshalling
- local audit buffering for host-side actions
- health/status reporting back to UI/backend

The backend should continue owning:

- identity
- approvals
- high-level tool policy
- audit correlation
- orchestration and session state

---

## Windows Helper Responsibilities

`guardian-sandbox-win.exe` should own:

- AppContainer or equivalent Windows sandbox setup where feasible
- restricted token creation
- job object assignment
- mitigation policy configuration
- scoped workspace/temp directory access
- network on/off boundary at the child-process level

It should not own:

- user-facing policy decisions
- chat/session logic
- high-level tool semantics

Those stay in GuardianAgent.

---

## Packaging Model

Minimum Windows package contents:

- `guardian-runtime.exe`
- `guardian-sandbox-win.exe`
- UI assets or desktop shell depending on product mode

Optional:

- tray app
- updater
- Windows service wrapper

---

## Decision

If GuardianAgent must remain web-first while supporting real Windows isolation for local actions, the most practical choice is:

- web UI
- local native runtime
- bundled Windows sandbox helper

If GuardianAgent instead moves toward a local-first workstation product, the desktop app path becomes simpler operationally.
