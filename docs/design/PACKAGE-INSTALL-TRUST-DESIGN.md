# Package Install Trust Design

**Status:** As Built
**Date:** 2026-03-26
**Primary Tool:** [executor.ts](../../src/tools/executor.ts)
**Trust Parser And Assessment:** [package-install-trust.ts](../../src/runtime/package-install-trust.ts)
**Native AV Scanner:** [package-install-native-protection.ts](../../src/runtime/package-install-native-protection.ts)
**Persistence And Orchestration:** [package-install-trust-service.ts](../../src/runtime/package-install-trust-service.ts)
**Unified Alerts:** [security-alerts.ts](../../src/runtime/security-alerts.ts)
**Posture Integration:** [security-posture.ts](../../src/runtime/security-posture.ts)
**Startup Wiring:** [index.ts](../../src/index.ts)

## Purpose

Package Install Trust is Guardian’s host-level managed package-install safety path for public package repositories.

It is separate from repo/workspace trust.

It exists to reduce silent execution of newly downloaded package artifacts by:

- staging requested top-level package artifacts into Guardian-owned quarantine first
- running bounded static review before install
- running native AV on the staged content when available
- blocking or pausing risky installs before the package manager mutates the target environment
- surfacing caution and blocked outcomes through unified Security alerts

It is not the Coding Assistant workspace trust system. When invoked from a code session it still uses the session workspace root as the filesystem boundary for `cwd`; outside code sessions it uses Guardian's configured allowed paths.

## Primary Surface

The primary surface is the `package_install` tool in [executor.ts](../../src/tools/executor.ts).

Behavior:

- `package_install` accepts `command`, optional `cwd`, and optional `allowCaution`
- it is approval-gated because it is mutating
- `cwd` must resolve inside the active workspace root or configured `allowedPaths` before approval or execution
- it routes through the dedicated `PackageInstallTrustService`

Guardrails around the old shell path:

- install-like package-manager commands are rejected from `shell_safe`
- the rejection message directs the caller to `package_install`
- this prevents package installs from bypassing the staged review path accidentally

## Supported V1 Commands

V1 supports explicit public-registry package additions only.

Supported:

- `npm install ...`
- `npm i ...`
- `npm add ...`
- `pnpm add ...`
- `yarn add ...`
- `bun add ...`
- `pip install ...`
- `pip3 install ...`
- `python -m pip install ...`
- `python3 -m pip install ...`
- `py -m pip install ...`

Supported package-manager flags are intentionally bounded. V1 keeps only the install flags needed for common add/install flows plus a short allowlist of registry-selection and target-selection flags.

## Unsupported V1 Inputs

V1 rejects these forms up front:

- command chains, redirects, subshells, and command substitution
- bare install commands with no explicit package specs such as `npm install` or `pip install` with no spec
- requirements files and constraints such as `pip install -r requirements.txt`
- editable installs such as `pip install -e .`
- local paths and file-based installs
- direct URLs and VCS installs
- generic lockfile/sync flows such as `npm ci`, `pnpm install`, `uv sync`, or similar non-explicit bulk install forms

The intent is to keep the safety claim honest: Guardian only manages the explicit flows it can stage and review deterministically in the shipped implementation.

## Target Model

Package Install Trust is separate from repo/workspace trust, but its working directory is still filesystem-scoped.

The install target comes from:

- the tool `cwd`, which must resolve through Guardian's allowed-path/workspace path resolver
- package-manager flags such as `--prefix`, `--target`, `--root`, `--user`, or `-g` when supported by the managed parser

The persisted event records the target as one of:

- `working_directory`
- `explicit_directory`
- `user`
- `global`

This is a host/package safety system, not a repo trust system.

The cwd rule prevents the managed install path from becoming a parallel host-filesystem mutation API. The package review still answers a supply-chain question about staged package artifacts; the path resolver answers where the install command is allowed to run.

## Managed Install Flow

The shipped flow is:

1. Parse the requested package-manager command through the dedicated managed-install parser.
2. Build a staging invocation.
3. Download the requested top-level artifacts into `~/.guardianagent/package-quarantine/<eventId>/downloads/`.
4. Inspect the staged artifacts without running install hooks.
5. Run native AV on the staged download directory when available.
6. Build a `PackageInstallAssessment`.
7. If the state is `blocked`, stop before install and emit a Security alert.
8. If the state is `caution` and `allowCaution` is not set, stop before install and emit a Security alert.
9. If the state is `caution` and `allowCaution` is set, record a review and continue.
10. Re-run the package-manager install from the staged local artifact paths rather than the original public package spec strings.

For Node-family installs, Guardian stages via `npm pack`.

For pip-family installs, Guardian stages via `pip download --no-deps` or the equivalent `python -m pip download --no-deps` form that matches the original runner prefix.

## Assessment Model

The assessment model is intentionally bounded.

States:

- `trusted`
- `caution`
- `blocked`

Review:

- `allowCaution` records a separate `PackageInstallTrustReview`
- it does not rewrite the underlying findings
- `blocked` is not overridable through `allowCaution`

Current deterministic signals include:

- Node lifecycle scripts such as `preinstall`, `install`, `postinstall`, and `prepare`
- Python source-distribution build metadata such as `setup.py` and `pyproject.toml`
- direct fetch-and-exec shell patterns
- encoded payload plus execution patterns
- combined network-fetch and command-execution primitives
- native or opaque binary payloads
- declared dependencies, used to surface the transitive-closure gap honestly

## Native AV

Native AV is folded into the same install assessment.

Current providers:

- Windows: Windows Defender custom path scan
- Unix-like: `clamdscan` or `clamscan`

Behavior:

- `detected` promotes the install decision to `blocked`
- `clean` is recorded in the event
- `unavailable` or `error` are recorded but do not block the install by themselves

## Unified Security Alert Integration

Package Install Trust is a first-class unified alert source.

Source name:

- `install`

Alert types:

- `package_install_blocked`
- `package_install_caution`

These alerts are available through the same unified Security alert APIs and tools as host, network, gateway, native, and assistant alerts.

That means:

- `security_alert_search` can filter on `source=install`
- alert acknowledge/resolve/suppress APIs work for install alerts
- posture summaries count install alerts as posture-oriented signals

Install alerts are treated like posture/supply-chain warnings rather than direct incident evidence. They can tighten posture to `guarded`, but they do not by themselves imply a live host compromise.

## Persistence

Persistence lives in:

- `~/.guardianagent/package-install-trust.json`
- `~/.guardianagent/package-quarantine/`

Persisted records include:

- managed install events
- findings and artifact summaries
- native AV result
- optional caution review
- unified alert lifecycle state

## Important V1 Limitation

V1 stages and reviews the requested top-level artifacts only.

It does not claim full transitive dependency quarantine across every supported ecosystem.

When a staged package declares dependencies that may still resolve during the real install, Guardian surfaces that as a `caution` finding instead of pretending the full dependency closure was reviewed.

That limitation is intentional and part of the shipped contract.
