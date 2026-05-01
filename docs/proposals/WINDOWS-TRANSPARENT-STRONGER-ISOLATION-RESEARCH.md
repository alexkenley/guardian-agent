# Windows Transparent Stronger Isolation Research

## Goal

Identify Windows isolation architectures that are:

- real and documented
- reasonably transparent to the user
- compatible with GuardianAgent's current runtime shape

This document avoids speculative mechanisms. If a capability is not documented or is not clearly usable from Guardian's current model, it is treated as uncertain rather than assumed.

## Current Guardian Baseline

Today Guardian already has:

- Linux strong isolation via `bubblewrap`
- a native Windows helper slot in `assistant.tools.sandbox.windowsHelper`
- a Rust Windows helper that currently uses AppContainer plus Job Objects

Current helper behavior in [main.rs](../../native/windows-helper/src/main.rs):

- creates an AppContainer process
- assigns the process to a Job Object
- grants AppContainer ACL access to configured paths
- does **not** currently implement a verified config-driven network policy contract

The helper currently logs:

`guardian-sandbox-win: network=off requested (host-level per-process network enforcement requires additional OS policy wiring)`

That means the helper is a real isolation primitive, but not yet a complete policy surface.

## Concrete Windows Isolation Mechanisms

### 1. AppContainer and Less-Privileged AppContainer (LPAC)

This is real and directly relevant.

Microsoft documents:

- AppContainer is a sandbox boundary for processes.
- It isolates process, window, file, credential, device, and network access.
- Capabilities are explicit and capability-free AppContainers do not automatically get broad access.
- LPAC is more isolated than a regular AppContainer.

What matters for Guardian:

- this is the best native, user-transparent primitive already closest to the current helper
- it works at process creation time using `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
- it fits the current helper architecture

Limits:

- access must be explicitly granted through capabilities and ACLs
- compatibility can break quickly for complex arbitrary desktop tools
- LPAC is stronger, but also more likely to break normal Win32 behavior

## 2. Job Objects

This is real and already partially used.

Microsoft documents that Job Objects can:

- manage a group of processes as a unit
- kill the entire process tree when the job handle closes
- enforce limits such as active process count, memory, and time

What matters for Guardian:

- this is a strong way to prevent helper-launched descendants from escaping lifecycle control
- it is transparent to the user
- it should be expanded beyond just kill-on-close

Limits:

- Job Objects are not a filesystem or network isolation boundary
- they help with containment and resource control, not privilege separation by themselves

## 3. Child Process Policy

This is real and usable from process creation attributes.

Microsoft documents `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` and `PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`.

What matters for Guardian:

- for subprocess classes that should not spawn arbitrary descendants, we can make that impossible
- this is especially useful for one-shot tools, parsers, and tightly scoped helper processes

Limits:

- Microsoft explicitly notes the restriction is only effective in sandboxed applications such as AppContainer
- it is not suitable for every tool class because some workflows genuinely need descendants

## 4. Process Mitigation Policies

This is real and usable from process creation attributes.

Microsoft documents `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` and concrete mitigations including:

- dynamic code prohibition
- binary signature policy
- image-load policy
- extension point disable policy
- Win32k system call disable policy

What matters for Guardian:

- these are strong, transparent hardening layers that can be applied per helper launch profile
- they meaningfully reduce attack surface inside the sandboxed child

Limits:

- these are not universal defaults
- many legitimate tools will break if the wrong mitigation is applied
- this must be profile-driven, not one blanket setting for every subprocess

## 5. Restricted Tokens

This is real.

Microsoft documents `CreateRestrictedToken`.

What matters for Guardian:

- restricted tokens are a valid Windows primitive for removing privileges and adding restricting SIDs

Limits:

- I verified the primitive exists, but I did **not** verify a production-ready combination pattern with Guardian's current AppContainer launch path
- because of that, this should be treated as a follow-on hardening layer, not the first implementation anchor

## 6. Windows Sandbox

This is real and strong, but not transparent.

Microsoft documents:

- Windows Sandbox is a lightweight desktop environment using virtualization
- it supports `.wsb` config files
- networking can be disabled
- host folders can be mapped read-only or writable
- a logon command can be run at startup

What matters for Guardian:

- this is the strongest documented Windows-host isolation option available without building a custom VM stack

Limits:

- it launches a separate desktop environment
- mapped writable folders can affect the host
- I did not find a documented headless/public API model comparable to "spawn one invisible sandboxed child and stream stdio"
- this is better for explicit quarantine workflows than for transparent everyday subprocess isolation

## 7. WSL2 with a Dedicated Linux Runner

This is real.

Microsoft documents:

- per-distro `wsl.conf` can disable Windows process interoperability
- `appendWindowsPath=false` can keep Windows executables out of the Linux `PATH`
- `automount.enabled=false` can stop automatic mounting of Windows drives
- custom WSL distributions can be packaged and distributed as `.wsl` files
- WSL 2 global settings can control networking and firewall behavior
- Hyper-V Firewall can filter inbound and outbound traffic to WSL on Windows 11 22H2+

What matters for Guardian:

- this is the most realistic way to get a Linux-style sandbox on a Windows machine while keeping a Windows host runtime
- it can be made nearly transparent once installed
- it is especially attractive for Linux-friendly toolchains and code execution paths

Limits:

- WSL firewall and networking controls are WSL/VM-scoped, not obviously per Guardian process
- using host-mounted `/mnt/c/...` paths weakens the isolation story
- this is not a good fit for arbitrary Windows-native binaries

## 8. Win32 App Isolation

This is real, but not ready as a default foundation yet.

Microsoft documents:

- Win32 app isolation exists
- it requires Windows 11 24H2+
- it is still in preview
- Microsoft positions it as requiring little to no code changes
- it uses packaging plus capability declaration, with ACP available to discover needed capabilities

What matters for Guardian:

- this is the most promising future-native Windows story for transparent isolation of the runtime itself

Limits:

- preview status
- Windows 11 24H2+ requirement
- packaging and capability-authoring work
- not a practical default for Guardian's current broad subprocess surface yet

## 9. App Control / AppLocker

These are real, but they solve a different layer.

Microsoft documents:

- App Control for Business is the robust device-wide application control feature
- AppLocker exists, but Microsoft does not position it as the stronger security feature

What matters for Guardian:

- these can help with executable identity enforcement on managed hosts

Limits:

- they are host-wide policy systems
- they require admin/enterprise management posture
- they are not a good default transparent consumer flow for Guardian

## 10. Microsoft Defender Application Guard

This is **not** a forward path.

Microsoft documents:

- MDAG is deprecated
- on Windows 11 24H2 it is no longer available

It should not be part of Guardian's future Windows isolation plan.

## What Is Actually Feasible For Guardian

### Best Near-Term Transparent Path: Native Helper V2

This is the most realistic path that stays aligned with the current codebase.

Concrete changes:

1. Keep AppContainer as the primary native boundary.
2. Add explicit launch profiles instead of one generic helper policy.
3. Expand Job Object limits:
   - active process limit where compatible
   - memory/time limits where compatible
   - keep kill-on-close
4. Add Child Process Policy for tool classes that should not spawn descendants.
5. Add process mitigation policies per profile:
   - dynamic code off where JIT is not required
   - extension point disable
   - image load restrictions
   - optionally Win32k disable for non-GUI workloads
6. Add verified capability mapping for network:
   - no-network profile
   - explicit capability-based network profile
   - do not claim fine-grained egress until it is actually enforced

Why this is the best near-term path:

- no extra VM window
- no separate user workflow
- fits current helper integration
- improves isolation meaningfully without inventing new infrastructure

### Best Medium-Term Strong Path: Dedicated WSL Backend

This is the best path if we need stronger containment than native helper profiles can safely provide.

Concrete shape:

1. Bundle or import a dedicated Guardian WSL distro.
2. Configure the distro with:
   - `interop.enabled=false`
   - `appendWindowsPath=false`
   - `automount.enabled=false`
3. Run Linux-side commands inside the distro only.
4. Keep the working set inside the distro VHD, not live on `/mnt/c`.
5. Sync files in and out through Guardian-controlled staging.
6. Use a Linux sandbox runner inside the distro.

Optional:

- on Windows 11 22H2+, evaluate Hyper-V Firewall rules for WSL if the operator accepts WSL-wide policy effects

Why this is strong:

- real Linux process boundary
- real WSL VM separation from the host
- explicit ability to disable Windows interop and automatic host drive exposure

Why this is not the default first step:

- more moving parts
- less suitable for Windows-native subprocess workflows
- WSL networking controls are broader than a single Guardian child

### Explicit High-Risk Lane: Windows Sandbox

This is feasible for manual or special-case quarantine workflows, not for transparent default execution.

Good uses:

- opening or running truly untrusted artifacts
- package or installer triage
- manual forensic or review workflows

Bad uses:

- routine invisible subprocess spawning from the Guardian UI

### Strategic Watch Item: Win32 App Isolation

This should be tracked, not relied on today.

It becomes interesting if:

- Microsoft graduates it from preview
- packaging friction drops
- Guardian decides to isolate a packaged worker rather than every child individually

## Recommended Product Direction

### Phase 1: Make the Native Helper Real

Do this first.

- Keep the portable/runtime distribution story separate from the architecture decision.
- Treat the helper as a first-class Windows runtime backend, not just a packaging artifact.
- Implement profile-based AppContainer hardening, Job Object limits, child-process policy, and mitigation policies.
- Expose exactly which guarantees are active.

This is the only path that is both:

- transparent to the user
- directly compatible with today's Guardian runtime

### Phase 2: Add a Dedicated WSL Execution Backend

Do this if we need stronger isolation for Linux-friendly workloads.

- make it opt-in
- use a dedicated distro
- disable interop and host automount inside that distro
- keep workspace data in staged copies, not direct live host mounts

This becomes the "stronger than native helper" lane for code-heavy or network-sensitive subprocesses.

### Phase 3: Reserve Windows Sandbox for Explicit Quarantine

Use it when the user or policy explicitly requests maximum isolation and can tolerate a visible sandbox environment.

## Non-Recommendations

Do not rely on these as the main transparent Windows answer:

- MDAG / Application Guard
- AppLocker as the primary security boundary
- a claim that generic Windows Sandbox is transparent or headless
- a claim that current WSL networking controls are per Guardian process
- live `/mnt/c` workspace sharing as the default "secure" WSL path

## Bottom Line

If the requirement is "stronger isolation that is transparent to the user," the most concrete architecture in reality is:

1. **Native helper v2 on Windows**
   - AppContainer or LPAC where compatible
   - Job Objects
   - child-process policy
   - mitigation policies
   - explicit capability-driven access

2. **Dedicated WSL backend as the stronger optional lane**
   - custom distro
   - interop disabled
   - automount disabled
   - staged workspace sync
   - Linux-side sandbox runner

3. **Windows Sandbox only for explicit quarantine workflows**

That is the strongest plan I can defend from the documented primitives without inventing features that do not exist.

## Sources

Primary external sources used:

- Microsoft Learn: AppContainer isolation
  - https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- Microsoft Learn: Launch an AppContainer
  - https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- Microsoft Learn: SECURITY_CAPABILITIES
  - https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-security_capabilities
- Microsoft Learn: UpdateProcThreadAttribute
  - https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
- Microsoft Learn: CreateRestrictedToken
  - https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
- Microsoft Learn: Job Objects
  - https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Microsoft Learn: JOBOBJECT_BASIC_LIMIT_INFORMATION
  - https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
- Microsoft Learn: Win32 app isolation overview
  - https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview
- Microsoft Learn: Application capability profiler
  - https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-capability-profiler
- Microsoft Learn: Use and configure Windows Sandbox
  - https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
- Microsoft Learn: Windows Sandbox architecture
  - https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-architecture
- Microsoft Learn: Advanced settings configuration in WSL
  - https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- Microsoft Learn: Build a Custom Linux Distribution for WSL
  - https://learn.microsoft.com/en-us/windows/wsl/build-custom-distro
- Microsoft Learn: Import any Linux distribution to use with WSL
  - https://learn.microsoft.com/en-us/windows/wsl/use-custom-distro
- Microsoft Learn: Configure Hyper-V firewall
  - https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall
- Microsoft Learn: App Control for Business and AppLocker overview
  - https://learn.microsoft.com/en-us/windows/security/application-security/application-control/windows-defender-application-control/wdac-and-applocker-overview
- Microsoft Learn: AppLocker
  - https://learn.microsoft.com/en-us/windows/configuration/lock-down-windows-10-applocker
- Microsoft Learn: Microsoft Defender Application Guard overview
  - https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/microsoft-defender-application-guard/md-app-guard-overview
