# Windows Portable Isolation Option

## Purpose

Define a Windows-specific distribution option for users who want an additional local isolation layer without using a traditional Windows installer.

This option is intended for:

- Windows users who want stronger local subprocess isolation
- deployments where an unsigned installer is undesirable
- browser-first or portable usage patterns

It is not intended to eliminate all Windows trust prompts. It avoids an installer, but it still relies on native unsigned binaries unless code signing is added later.

---

## Option Summary

Ship an optional **portable zip bundle** for Windows containing:

- `guardian-runtime.exe`
- `guardian-sandbox-win.exe`
- optional UI assets or launcher script

This is intended to be a **single portable artifact**. Users should not need to install separate runtime and helper packages.

The user:

1. downloads the zip
2. extracts it
3. runs `guardian-runtime.exe`
4. uses GuardianAgent through the normal web UI or a localhost-served UI

The runtime uses `guardian-sandbox-win.exe` for risky subprocess-backed tools when strict sandbox mode is enabled and the helper is configured.

---

## Why This Exists

This option provides a practical middle ground:

- no MSI or installer packaging required
- no WSL2 or Docker required
- real Windows-native helper path remains available
- users who do not want this extra local layer can continue using normal Windows operation without it

---

## What It Improves

When enabled, this option can provide stronger host-local isolation for:

- shell execution
- browser automation
- MCP server subprocesses
- other subprocess-backed local tools

This is the right place to use Windows primitives such as:

- AppContainer where feasible
- restricted tokens
- job objects
- process mitigation policies

---

## What It Does Not Solve

- it does not remove SmartScreen or unsigned-binary reputation prompts
- it does not make a pure remote web app capable of local Windows kernel enforcement
- it does not provide driver-level or privileged per-domain network enforcement by itself

Avoiding the installer only removes one distribution friction point. It does not remove the trust implications of shipping native unsigned binaries.

---

## Recommended User Experience

### Default Windows Mode

- normal GuardianAgent operation
- no extra portable helper package required
- strict mode may disable risky tools if no strong backend is available

### Optional Windows Portable Isolation Mode

- user downloads the Windows portable isolation bundle
- user enables the helper in config
- risky subprocess-backed tools can run with the additional isolation layer when the helper is detected

This keeps the stronger isolation path opt-in rather than forcing every Windows user through native packaging immediately.

---

## Configuration

Example:

```yaml
assistant:
  tools:
    sandbox:
      enabled: true
      enforcementMode: strict
      windowsHelper:
        enabled: true
        command: ./bin/guardian-sandbox-win.exe
        timeoutMs: 5000
```

Recommended operator command:

```powershell
npm run portable:windows
```

That wrapper always starts from a clean `build/windows` output directory, then builds the portable zip and requires `guardian-sandbox-win.exe` (it uses a supplied helper or attempts a fresh helper build in that same run).

Behavior:

- if the helper is present and healthy, Windows sandbox availability can become `strong`
- by default, packaging fails when the helper is missing or unhealthy (developer override: `-AllowNoHelper`)
- if a no-helper build is explicitly allowed, strict mode disables risky subprocess-backed tools
- permissive mode still allows degraded operation, but with explicit warnings

---

## Packaging Recommendation

Suggested zip contents:

```text
guardianagent-windows-portable/
  guardian-runtime.exe
  bin/
    guardian-sandbox-win.exe
  config/
    config.yaml
  logs/
```

Optional:

- `start-guardian.bat`
- tray binary
- local web assets

The same staged payload can also be used to generate an installer, but the portable zip should remain the simplest one-artifact option for users who want the additional isolation layer without a traditional install flow.

---

## Security Position

This option should be described accurately:

- it is an **additional** Windows isolation option
- it is **opt-in**
- it avoids a traditional installer
- it still requires native binaries
- it improves local enforcement only when the helper is actually present and enabled

---

## Decision

GuardianAgent will offer an optional Windows **portable isolation** mode as an additional path for users who want stronger local isolation without relying on a signed installer-based distribution flow.
