# Proposal: Package Install Trust And Quarantine

Historical proposal. The shipped behavior now lives in [PACKAGE-INSTALL-TRUST-DESIGN.md](../design/PACKAGE-INSTALL-TRUST-DESIGN.md).

**Date:** 2026-03-26
**Status:** Historical Draft
**Related:** [Coding Workspace Spec](../design/CODING-WORKSPACE-DESIGN.md), [Code Workspace Trust Spec](../design/CODE-WORKSPACE-TRUST-DESIGN.md), [Agentic Defensive Security Suite - As-Built Spec](../design/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md), [executor.ts](../../src/tools/executor.ts), [workspace-dependency-ledger.ts](../../src/runtime/workspace-dependency-ledger.ts), [ai-security.ts](../../src/runtime/ai-security.ts), [security-alerts.ts](../../src/runtime/security-alerts.ts), [host-monitor.ts](../../src/runtime/host-monitor.ts)

## Executive Summary

Guardian already has a useful trust pattern for coding workspaces:

- bounded static review
- async native AV enrichment
- persisted trust state
- surfaced findings
- manual acceptance of the current fingerprint

That pattern is currently repo-scoped for coding sessions. It does **not** protect package installs into user environments from public registries, VCS URLs, or direct archives.

This proposal adds a separate `Package Install Trust` subsystem for install surfaces such as `npm`, `pnpm`, `yarn`, `bun`, `pip`, `uv`, `git+https`, GitHub shorthand, and tarball URLs.

The core model is:

1. classify install-like commands
2. stage the requested artifact in quarantine first
3. scan the staged artifact before release
4. allow, warn, or block based on the assessment
5. emit Security alerts and offer remediation when malicious or suspicious content is found

This proposal does **not** modify the existing Coding Assistant trust flow. It adds a sibling security subsystem for package and artifact installation.

## Why This Needs To Be Separate

The current Coding Assistant trust pipeline in [code-workspace-trust.ts](../../src/runtime/code-workspace-trust.ts) and [code-workspace-trust-service.ts](../../src/runtime/code-workspace-trust-service.ts) is designed for:

- an attached coding workspace
- prompt hardening against hostile repo content
- repo-scoped execution friction
- session-scoped manual review

That is the wrong scope for package installation risk.

Package-install protection needs different units of trust:

- package artifacts rather than workspaces
- resolved versions rather than repo roots
- publisher and integrity metadata rather than session identity
- pre-install quarantine rather than post-session prompt handling
- uninstall and artifact cleanup actions rather than code-session trust review

The right design is to reuse the **pattern**, not the existing subsystem.

## Current Position

### Capabilities already present

Guardian already has pieces that make this proposal feasible:

- Workspace trust and native AV enrichment for coding repos in [code-workspace-trust.ts](../../src/runtime/code-workspace-trust.ts) and [code-workspace-native-protection.ts](../../src/runtime/code-workspace-native-protection.ts)
- Install-like command classification in [executor.ts](../../src/tools/executor.ts)
- JS dependency awareness history in [workspace-dependency-ledger.ts](../../src/runtime/workspace-dependency-ledger.ts)
- Assistant Security findings in [ai-security.ts](../../src/runtime/ai-security.ts)
- Unified alert aggregation in [security-alerts.ts](../../src/runtime/security-alerts.ts)
- Host monitoring and alert lifecycle infrastructure in [host-monitor.ts](../../src/runtime/host-monitor.ts)

### Current gaps

The current runtime does **not** yet provide:

- a dedicated install-artifact trust model
- quarantine-first handling for package installs
- pre-install scanning for registry, VCS, or tarball artifacts
- post-install remediation flows for packages introduced outside Guardian
- a supply-chain-specific alert and review workflow

The existing JS dependency ledger is useful context, but it records manifest changes **after** execution. It is not a gate, scanner, or quarantine system.

## Threat Model

This proposal targets the practical cases the user raised:

- compromised npm or PyPI publishers
- hijacked repos used through `git+https` or GitHub shorthand installs
- malicious `postinstall`, `prepare`, `setup.py`, or build-backend execution
- typosquatted or newly published packages with malicious bootstrap code
- tarball or direct-URL installs that bypass normal registry review
- source distributions that execute code during build
- native addons or embedded binaries dropped during install

It is not a claim of perfect malware detection. The goal is to reduce silent execution of unreviewed public artifacts and force higher-friction release when risk is present.

## Design Principles

- Keep Coding Assistant trust unchanged.
- Make package-install trust a sibling subsystem.
- Default to quarantine-first for Guardian-managed installs.
- Treat "Guardian-managed" as "Guardian launches the install through its own execution path," not "the repo happens to live under a Guardian-owned directory."
- Trust decisions are artifact-scoped, not global.
- Manual acceptance is fingerprint-scoped and does not rewrite raw findings.
- Separate managed installs from unmanaged installs.
- Only offer destructive cleanup against artifacts Guardian staged or against operator-confirmed install targets.

## Proposed Runtime Model

### Primary object model

Add a dedicated install trust model with these persisted concepts:

- `PackageInstallArtifactRef`
  - ecosystem
  - requested spec
  - resolved name and version
  - resolved source URL
  - integrity or artifact hash
  - publisher or owner metadata when available
  - VCS commit or tag when relevant
- `PackageInstallTrustAssessment`
  - state
  - findings
  - static summary
  - native AV status
  - assessment fingerprint
- `PackageInstallTrustReview`
  - accepted by
  - accepted at
  - accepted fingerprint
- `PackageInstallEvent`
  - install attempt
  - release decision
  - actual install outcome
  - remediation actions

### Trust states

Use a small lifecycle that mirrors the useful parts of workspace trust without sharing implementation:

- `pending_scan`
- `trusted`
- `caution`
- `blocked`
- `accepted`

Interpretation:

- `pending_scan`: artifact is staged and cannot be installed yet
- `trusted`: no current indicators from the shipped checks
- `caution`: suspicious or incomplete signals; approval required before release
- `blocked`: high-confidence malicious or dangerous signals; install denied by default
- `accepted`: operator accepted the exact current fingerprint; release allowed for that artifact only

`accepted` should be stored separately from the raw assessment, the same way workspace trust keeps review separate from findings.

### Artifact fingerprint

Trust must bind to the actual install artifact, not only to a package name.

Recommended fingerprint inputs:

- ecosystem
- package name
- resolved version
- resolved source URL
- registry integrity field or downloaded artifact hash
- publisher or maintainer metadata when available
- VCS commit SHA when source is Git-based
- artifact layout type such as wheel, sdist, tarball, or repo clone

This prevents a blanket "trust this package forever" decision from silently carrying across publisher compromise or version swaps.

## Managed Install Flow

Managed installs are the strong-control path: Guardian sees the command before execution and can stop it.

In this proposal, a managed install means:

- the install command is launched by Guardian through its own tool-execution path
- Guardian can inspect the command before execution
- Guardian can stage artifacts in its own quarantine area before release

It does **not** mean:

- the target repo lives under a special Guardian-only directory
- the repo is isolated from PowerShell, VS Code, or other normal host tools
- installs typed manually into a PTY or external shell automatically become managed

The quarantine or staging area is Guardian-owned. The target workspace or environment does not need to be.

### Entry points

The initial interception point should be [executor.ts](../../src/tools/executor.ts), because it already classifies install-like commands across:

- `npm`, `pnpm`, `yarn`, `bun`
- `pip`, `pip3`, `python -m pip`, `uv`
- `cargo`, `go`, `composer`, `bundle`, `gem`, `dotnet`

Phase 1 should focus on:

- npm-family
- PyPI-family
- VCS and direct-URL installs

### Proposed flow

1. User or agent requests an install-like command through Guardian-managed execution.
2. Guardian parses the command, extracts candidate artifacts, and resolves the intended install target.
3. If the requested install target is outside the current approved workspace or allowed paths, Guardian requests explicit path approval before continuing.
4. Guardian stages each candidate into a quarantine area such as `~/.guardianagent/package-quarantine/`.
5. Guardian scans the staged artifact without running install hooks.
6. Guardian records a `PackageInstallTrustAssessment`.
7. If all candidates are `trusted` or explicitly `accepted`, Guardian releases the install into the approved target.
8. If any candidate is `caution`, Guardian surfaces findings and requests approval before release.
9. If any candidate is `blocked`, Guardian denies the install, creates a Security alert, and offers cleanup actions.

Default behavior for multi-artifact commands should be atomic:

- if one candidate blocks, the command does not partially install the rest

Release should usually mean "install from the already-staged local artifact into the approved target environment," not "redownload directly into the target path."

## V1 Target Scope

Phase 1 should stay tighter than "any path anywhere."

Recommended v1 target policy:

- allow workspace-local installs and clearly workspace-local environments by default
- require explicit path approval for targets outside the current workspace root
- keep global and user-wide installs blocked in v1

Examples of default-allowed v1 targets:

- a repo-local `.venv`
- a workspace-local Python target directory
- workspace `node_modules`

Examples that should require extra approval or remain blocked:

- arbitrary directories outside the workspace root
- user-profile package locations
- global system package-manager targets

This keeps the first implementation aligned with the current repo-scoped trust and sandbox posture instead of quietly expanding into broad host package management.

## Unmanaged Install Monitoring

Not every install will come through Guardian-managed execution. Users may run package-manager commands directly in a terminal, IDE, or another process.

That means there are two different operating modes:

### 1. Managed installs

Guardian can:

- quarantine before install
- scan before release
- block or allow before mutation

### 2. Unmanaged installs

Guardian can only do after-the-fact detection unless deeper host hooks are added.

Recommended phase 2 behavior:

- detect package-manager process execution through host monitoring or a dedicated install observer
- diff environment manifests and install targets after the fact
- create a Security alert that the environment changed outside the managed trust path
- offer review and remediation actions

The proposal should stay honest about this boundary: pre-install quarantine is only guaranteed for Guardian-managed installs.

An important corollary is that a normal repo directory remains a normal host directory. It can still be opened or mutated from PowerShell, Explorer, VS Code, or any other tool outside Guardian. Those external mutations do not automatically pass through the managed trust pipeline.

## Scanner Design

The scanner should stay bounded and deterministic, like workspace trust.

### Static signals to inspect

- lifecycle hooks such as `preinstall`, `install`, `postinstall`, `prepare`
- Python build hooks and executable packaging metadata
- VCS and direct-URL sources
- floating Git refs such as branch names instead of pinned commits
- encoded or obfuscated execution
- fetch-and-exec patterns
- bundled native binaries or compiled addons
- suspicious `bin` entrypoints
- download-and-launch patterns in setup or install scripts
- integrity mismatch or missing provenance where one is expected

### Native AV enrichment

Reuse the native AV pattern, not the workspace-trust codepath:

- run Windows Defender or ClamAV against the staged artifact or extracted tree
- persist a native AV sub-status on the install assessment
- force `blocked` on positive native detection
- do not let a clean AV result override other suspicious findings

### Ecosystem-specific handling

#### npm, pnpm, yarn, bun

Prefer registry-resolution or tarball acquisition into quarantine, then inspect:

- `package.json`
- lifecycle scripts
- `bin` entries
- bundled binaries
- native modules
- install-time fetch or shell execution

#### pip, pip3, python -m pip, uv

Prefer wheel or source download into quarantine before install.

Important rule:

- wheels are lower-risk to inspect than sdists
- sdists should default to higher scrutiny because build backends may execute code during installation

Inspect:

- `pyproject.toml`
- `setup.py`
- `setup.cfg`
- entry points
- compiled extensions
- direct URL and VCS references

#### Git and tarball sources

Always quarantine first.

Rules:

- clone shallow and pin the resolved commit
- treat floating refs as caution by default
- scan the extracted or cloned source before any install command executes
- if malicious, delete the staged clone or archive and never release it

## Alerting And Review

The existing Security surfaces are sufficient for phase 1 if we use them correctly.

### Findings

Package-install findings should surface through [ai-security.ts](../../src/runtime/ai-security.ts) as a new supply-chain oriented finding type or category.

Recommended category addition:

- `supply_chain`

### Unified alerts

The alert should also flow into [security-alerts.ts](../../src/runtime/security-alerts.ts).

Phase 1 can publish these as `assistant`-source alerts to minimize changes.

If volume grows, phase 2 can justify a dedicated unified-alert source such as `install`.

### Alert contents

Each alert should include:

- requested install command
- ecosystem
- package or artifact identity
- trust state
- top findings
- whether anything was actually installed yet
- recommended next action

## Remediation Model

The remediation path depends on what Guardian actually controlled.

### When the artifact was blocked before install

Offer:

- delete staged artifact
- delete staged clone
- suppress or accept the exact fingerprint
- denylist the artifact fingerprint locally

### When the install already happened

Offer:

- uninstall the package
- remove the staged artifact
- purge package-manager cache entries
- remove an extracted source tree created by the install flow
- mark the environment as reviewed after manual response

If the install or update later happens through Guardian again, it should be rescanned as a new artifact assessment. Trust does not carry forward forever just because an earlier version or tarball was accepted once.

### "Delete repo" behavior

Only offer "delete repo" when the source is actually:

- a staged cloned repo
- an extracted archive directory created by Guardian

Do **not** present "delete repo" for a normal registry package where no repo clone exists. In that case the right actions are uninstall, purge cache, or delete the staged artifact.

Also do not auto-delete an arbitrary user repo path purely because its contents matched a blocked install. Destructive cleanup should stay explicit and path-scoped.

## Proposed Components

Recommended new runtime files:

- `src/runtime/package-install-trust.ts`
- `src/runtime/package-install-trust-service.ts`
- `src/runtime/package-install-detector.ts`
- `src/runtime/package-install-quarantine.ts`
- `src/runtime/package-install-scan.ts`
- `src/runtime/package-install-ledger.ts`

Recommended integration points:

- [executor.ts](../../src/tools/executor.ts) for managed install interception
- [ai-security.ts](../../src/runtime/ai-security.ts) for findings
- [security-alerts.ts](../../src/runtime/security-alerts.ts) for Security queue integration
- [host-monitor.ts](../../src/runtime/host-monitor.ts) or a dedicated observer for unmanaged install detection
- [workspace-dependency-ledger.ts](../../src/runtime/workspace-dependency-ledger.ts) as awareness context only, not as the enforcement mechanism

## Rollout Plan

### Phase 1

- managed install interception in `shell_safe`
- quarantine-first handling for npm-family, PyPI-family, Git, and tarball installs
- bounded static scan plus native AV enrichment
- Security findings and alerts
- explicit release, accept, block, and cleanup actions

### Phase 2

- unmanaged install detection
- environment drift review
- cache and uninstall helpers
- dedicated UI for package-install review history

### Phase 3

- richer provenance and publisher trust
- package-signature or attestation inputs where supported
- broader ecosystem coverage
- transitive dependency risk summarization

## Non-Goals

This proposal does **not** attempt to:

- replace full dependency-SCA products
- guarantee malware detection
- rescan every installed transitive package on every command
- merge package-install trust into code-session trust
- auto-delete arbitrary user directories
- silently permit risky installs because a package name was trusted once before

## Recommendation

Guardian should add `Package Install Trust` as a quarantine-first sibling to coding-workspace trust.

That is the smallest design that matches the current architecture and directly addresses the supply-chain problem the user raised:

- monitor installs from public registries and repos
- quarantine before release when Guardian controls the command
- request explicit target-path approval when the install destination falls outside the approved workspace scope
- alert when suspicious or malicious artifacts are found
- offer targeted cleanup, including repo deletion only when a staged repo actually exists

The existing coding-session trust model should remain unchanged.
