# Assistant Security Spec

**Status:** Proposed intended implementation  
**Date:** 2026-03-21  
**Owner:** Security + Runtime + Web UI  
**Amends:** [WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md) for the future `Security > Assistant Security` tab  
**Related:** [SECURITY-PANEL-CONSOLIDATION-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/SECURITY-PANEL-CONSOLIDATION-SPEC.md), [THREAT-INTEL-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/THREAT-INTEL-SPEC.md), [CODE-WORKSPACE-TRUST-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODE-WORKSPACE-TRUST-SPEC.md), [AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT-SPEC.md)

Configuration remains the owner of security settings. `Security > Assistant Security` is the operator command center.

## Goal

Add a built-in `Assistant Security` capability that continuously tests Guardian's assistant surfaces for adversarial failure modes:

- jailbreak susceptibility
- prompt injection and untrusted-context influence
- system-prompt leakage
- unsafe tool or approval-boundary behavior
- secret and sensitive-data disclosure
- trust-boundary failures inside coding sessions and web chat flows

The feature should test **Guardian itself**, not only the attached repo.

## Why

Guardian already has:

- workspace trust review for coding sessions
- host, gateway, network, and native AV alerting
- Security Log for current issues and evidence
- Threat Intel for external monitoring

What is missing is a first-class way to ask:

- "Would the current assistant prompt and policy stack resist a jailbreak today?"
- "Did a recent prompt or routing change make the coding assistant less safe?"
- "Can a hostile repo or chat turn into unsafe tool use, memory writes, or hidden-prompt leakage?"

`Assistant Security` fills that gap.

## Scope

### Primary scan targets

- `assistant_runtime`
  - the main Guardian assistant behavior with its current prompt, policy, and tool routing
- `code_session`
  - the coding assistant with an attached workspace and current trust state
- `web_ui`
  - the web chat and approval flow when browser-backed validation is enabled
- `workspace_influence`
  - bounded analysis of repo content that may influence the assistant without executing repo code

### Not just repo review

Repo scanning is only one part of the feature. The main value is dynamic adversarial testing of the assistant/runtime itself.

## Non-Goals

This spec does not define:

- a replacement for SAST, dependency scanning, or secret scanning across arbitrary source code
- a full third-party scanner product embedded into Guardian
- automatic offensive exploitation or host mutation
- automatic remediation of findings
- a second alert console separate from `Security Log`

## Security Model

- The model is never treated as trustworthy by default.
- Assistant Security probes are bounded, read-only, and auditable.
- Findings are evidence, not automatic permission to mutate state.
- Higher-risk scan profiles must be posture-aware:
  - if sandboxing is degraded
  - if browser tooling is disabled
  - if manual terminals are allowed on degraded backends
  - if network-bearing tools are disallowed

The feature should consume the security-settings posture produced by the parallel hardening work rather than duplicating that configuration in its own tab.

## Detection Categories

Phase 1 should cover:

- `jailbreak`
  - attempts to override role, policy, or system instructions
- `prompt_injection`
  - attempts to make untrusted repo/chat content act as instructions
- `prompt_leak`
  - attempts to reveal system prompt, hidden policy, or internal guardrail text
- `tool_escape`
  - attempts to get the assistant to exceed path, domain, or authority bounds
- `approval_bypass`
  - attempts to perform actions that should still require approval
- `secret_disclosure`
  - attempts to reveal secrets, credentials, prior messages, memory, or protected config
- `memory_boundary`
  - attempts to poison or persist hostile memory content
- `trust_boundary`
  - attempts to turn low-trust or quarantined content into writes, approvals, or execution
- `workspace_influence`
  - hostile README, prompt file, script, or toolchain cues that may steer the coding assistant

Phase 2 can add:

- browser/webchat-specific interaction probes
- regression scoring and attack success rate (ASR) trends
- optional garak-compatible community probe adapters

## UX

The operator surface should make it obvious what was scanned, what failed, how serious it is, and where the next action belongs.

### Command Center

The command center is a new `Security > Assistant Security` tab.

It should sit beside:

- `Overview`
- `Security Log`
- `Assistant Security` (merged command center including automated security activity)
- `Threat Intel`

Recommended placement: between `Security Log` and `Threat Intel`.

### Required sections

#### `Assistant Security Posture`

Shows:

- scan system enabled or disabled
- sandbox posture and confidence level
- degraded-backend warnings
- browser/MCP/manual-terminal availability relevant to scan profiles
- last completed scan
- "Open Security Settings" deep link into Configuration

This section must explain that Configuration owns the settings, not this tab.

#### `Targets`

Operators can view and manage scan targets such as:

- current assistant runtime
- selected code sessions
- configured web UI surface

#### `Profiles`

Profiles define probe bundles and execution scope.

Initial built-ins:

- `Quick`
- `Standard`
- `Release Gate`
- `Continuous`
- `Browser`

#### `Recent Runs`

Shows:

- target
- profile
- status
- duration
- finding count
- regression flag

#### `Findings`

Shows:

- category
- severity
- confidence
- target
- short summary
- evidence preview
- current finding status
- "View in Security Log" when promoted

#### `Trends`

Shows:

- findings over time
- ASR or regression trend
- per-target stability
- latest pass/fail deltas

## Runtime Architecture

Add the following runtime pieces:

- `AiSecurityTargetStore`
  - persists configured scan targets
- `AiSecurityProbeRegistry`
  - resolves built-in, community, and custom probe packs
- `AiSecurityScanService`
  - runs probes against the chosen target
- `AiSecurityRunStore`
  - persists run state and per-run evidence
- `AiSecurityFindingStore`
  - persists normalized findings and triage status
- `AiSecurityScheduler`
  - runs background scans on schedule

Optional later component:

- `AiSecurityExternalWorkerAdapter`
  - bridges to a separate Python or garak-compatible worker when enabled

## Execution model

1. A target and profile are selected.
2. The profile resolves into a bounded probe list.
3. The scan service runs those probes against the target.
4. Raw results are normalized into findings.
5. Findings are persisted, triaged, and optionally promoted.
6. Relevant promoted findings appear in `Security Log`.
7. Run lifecycle events appear in `Agentic Security Log` when agent-driven or scheduled.

## Settings Integration

Configuration should own the editable settings under the broader Security settings area being introduced by the parallel hardening work.

Recommended semantic namespace:

- `assistant.security.aiSecurity`

If the concurrent config work nests this differently, the fields can be remapped. The semantic requirements are:

- `enabled: boolean`
- `mode: off | manual | continuous`
- `defaultProfile: quick | standard | release_gate | continuous | browser`
- `scheduleCron` or `intervalMinutes`
- `promoteSeverity: high | critical`
- `allowCodeSessionTargets: boolean`
- `allowWebTargets: boolean`
- `allowExternalProbeWorkers: boolean`
- `requireStrongSandboxForBrowserProfiles: boolean`
- `requireStrongSandboxForContinuousProfiles: boolean`
- `retainRunsDays: number`
- `retainEvidenceDays: number`

### Posture-aware behavior

Assistant Security must consume sandbox and hardening posture as input.

Examples:

- if the host is on degraded fallback, `Browser` and `Continuous` profiles may be blocked or downgraded
- if browser tooling is disabled, web UI targets are unavailable
- if manual code terminals are allowed on degraded backends, posture copy should warn that scan confidence is reduced
- if strong containment is present, the UI can show a higher-confidence posture badge

The tab should **read** this posture, not become the place where those settings are edited.

## Data Model

### Target

- `id`
- `kind: assistant_runtime | code_session | web_ui | workspace_influence`
- `label`
- `targetRef`
- `enabled`
- `createdAt`
- `updatedAt`

### Run

- `id`
- `targetId`
- `profileId`
- `status: queued | running | succeeded | failed | cancelled`
- `trigger: manual | scheduled | release_gate | session_attach`
- `startedAt`
- `completedAt`
- `summary`
- `postureSnapshot`

### Finding

- `id`
- `runId`
- `targetId`
- `category`
- `severity: low | medium | high | critical`
- `confidence`
- `summary`
- `evidence`
- `status: new | triaged | accepted_risk | fixed | false_positive`
- `promotedToSecurityLog: boolean`
- `createdAt`
- `updatedAt`

## Integration With Existing Security Surfaces

### Security Log

High and critical Assistant Security findings must flow into `Security Log`.

Phase 1 should do this by emitting audit events and rendering promoted rows in the merged `Security Log` view.

Do **not** force these findings into the current `UnifiedSecurityAlert` source union immediately, because that lifecycle model is currently optimized for host/network/gateway/native alerts.

Phase 2 can add a broader lifecycle model for AI findings if inline acknowledge/resolve behavior is needed.

### Agentic Security Log

When Assistant Security scans are run by a scheduler or dedicated agent, record:

- scan started
- scan completed
- scan skipped
- regression detected
- scan failed

These belong in `src/runtime/security-activity-log.ts`, not in a second ad hoc run log.

### Code Sessions

Code sessions should show the latest Assistant Security result in session-local checks.

Recommended change:

- extend `CodeSessionWorkState.verification.kind` to include `security`

Examples:

- `security / pass` for a clean quick scan
- `security / warn` for medium findings or reduced-confidence posture
- `security / fail` for high/critical findings or release-gate failure

### Workspace Trust

`workspaceTrust` remains the static + native-protection trust boundary.

Assistant Security must not silently replace it.

Phase 1:

- add Assistant Security findings as parallel evidence
- use them to enrich operator context
- never auto-promote a repo to `trusted`

Phase 2:

- allow selective correlation where strong AI findings can raise caution or block follow-on assistant behaviors under explicit policy

## API Surface

Recommended endpoints:

- `GET /api/security/ai/summary`
- `GET /api/security/ai/targets`
- `POST /api/security/ai/targets`
- `POST /api/security/ai/targets/delete`
- `GET /api/security/ai/profiles`
- `GET /api/security/ai/runs`
- `POST /api/security/ai/runs`
- `GET /api/security/ai/findings`
- `POST /api/security/ai/findings/status`
- `GET /api/security/ai/trends`

Optional later:

- `POST /api/security/ai/profiles`
- `POST /api/security/ai/probes/sync`

## Audit Events

Add audit types for:

- `assistant_security_scan_started`
- `assistant_security_scan_completed`
- `assistant_security_scan_failed`
- `assistant_security_finding`
- `assistant_security_regression_detected`

These events should support Security Log rendering without inventing a second evidence pipeline.

## Implementation Phases

### Phase 1

- add `Security > Assistant Security` tab shell
- add target/profile/run/finding persistence
- ship built-in deterministic probes
- support manual scans for `assistant_runtime` and `code_session`
- promote high/critical findings into `Security Log`
- surface session-local results in Code checks

### Phase 2

- add scheduling and trend tracking
- add web UI/browser-backed targets
- add posture-aware gating for higher-risk profiles
- add regression comparisons and release-gate mode

### Phase 3

- add optional external worker adapter for community probe packs
- add richer ASR metrics
- add saved views and triage presets

## Testing

Required verification:

- unit tests for stores, scan normalization, finding promotion, and scheduler behavior
- web UI smoke for the `Assistant Security` tab
- coding assistant integration tests for code-session scan status and result propagation
- Security Log tests for promoted AI findings
- harness coverage using the documented integration test process

Recommended harness additions:

- `scripts/test-ai-security-smoke.mjs`
- extend `scripts/test-contextual-security-uplifts.mjs` for regression and boundary checks
- add a real-model smoke lane for the manual run path when the configured AI test backend is available

## Recommendation

Build `Assistant Security` as a Guardian-native feature, not as a bolt-on scanner console.

The key design choices are:

- the command center lives in `Security > Assistant Security`
- actionable findings land in `Security Log`
- code-session results also appear in `Code > Checks`
- configuration stays in the broader Security settings surface
- scan confidence is explicitly tied to runtime containment posture
