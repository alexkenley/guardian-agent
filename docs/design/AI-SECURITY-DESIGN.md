# Assistant Security Design

**Status:** Implemented current architecture, with deterministic posture scanning baseline
**Date:** 2026-04-08
**Owner:** Security + Runtime + Web UI
**Amends:** [WEBUI-DESIGN.md](./WEBUI-DESIGN.md) for the `Security > Assistant Security` tab
**Related:** [SECURITY-PANEL-CONSOLIDATION-DESIGN.md](./SECURITY-PANEL-CONSOLIDATION-DESIGN.md), [THREAT-INTEL-DESIGN.md](./THREAT-INTEL-DESIGN.md), [CODE-WORKSPACE-TRUST-DESIGN.md](./CODE-WORKSPACE-TRUST-DESIGN.md), [AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md](./AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md)

The as-built defensive-security suite document is the broad shipped reference. This document is the current Assistant Security design/as-built contract for the deterministic posture scanning baseline in [ai-security.ts](../../src/runtime/ai-security.ts), the Security page implementation in [security.js](../../web/public/js/pages/security.js), and the assistant-security tools in [security-intel-tools.ts](../../src/tools/builtin/security-intel-tools.ts).

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

Implemented target types:

- `runtime`
  - the active Guardian runtime posture, including sandbox availability, browser posture, MCP exposure, and agent policy update posture
- `workspace`
  - tracked coding-session workspaces with current trust assessment and review state

Forward target types:

- `web_ui`
  - browser-backed validation of web chat and approval flow
- deeper `workspace_influence`
  - richer hostile repo-content probes beyond the current workspace-trust correlation

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

The deterministic baseline covers these implemented categories:

- `sandbox`
  - degraded containment, risky fallback allowances, package-manager exposure, or manual terminal risks
- `policy`
  - runtime policy update surfaces that can widen path, command, domain, or tool authority
- `browser`
  - browser/MCP exposure and dynamic Playwright package risks
- `mcp`
  - third-party server startup, network, environment, and connection posture
- `workspace`
  - coding-workspace trust/review state and high-risk workspace findings
- `trust_boundary`
  - untrusted workspaces or accepted-risk reviews that can affect assistant behavior

Future probe-backed phases can add:

- `jailbreak`, `prompt_injection`, `prompt_leak`, `tool_escape`, `approval_bypass`, `secret_disclosure`, and `memory_boundary`
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

Current placement: the Security page tabs are `Overview`, `Assistant Security`, `Threat Intel`, and `Security Log`.

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

Implemented built-ins:

- `quick`
- `runtime-hardening`
- `workspace-boundaries`

Reserved/future profile families:

- `standard`
- `release_gate`
- `continuous`
- `browser`

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
- "View in Security Log" when the finding is an incident-candidate and was promoted

#### `Trends`

Shows:

- findings over time
- ASR or regression trend
- per-target stability
- latest pass/fail deltas

## Runtime Architecture

Implemented runtime pieces:

- `AiSecurityService`
  - owns target discovery, built-in profiles, deterministic scan evaluation, run/finding persistence, status updates, and promotion candidates
- `AssistantSecurityConfig`
  - configures deployment profile, operating mode, triage provider preference, continuous monitoring, and auto-containment thresholds under `assistant.security`
- managed scheduled task preset `assistant-security-scan`
  - runs the configured quick profile on the schedule from `assistant.security.continuousMonitoring`
- `security-intel-tools.ts`
  - exposes `assistant_security_status`, `assistant_security_scan`, and `assistant_security_findings`

Optional later component:

- `AiSecurityExternalWorkerAdapter`
  - bridges to a separate Python or garak-compatible worker when enabled

## Execution model

1. The operator, tool layer, or scheduled task selects a profile and optional targets.
2. `AiSecurityService` resolves runtime and workspace targets.
3. Deterministic posture checks evaluate the selected targets.
4. Findings are persisted in `~/.guardianagent/assistant-security.json`, deduplicated by stable keys, and classified as either posture-only debt or incident-candidate evidence.
5. High/critical incident-candidate findings are returned as promoted findings and enter `Security Log` through the unified alert lifecycle.
6. Runs and findings are visible in `Security > Assistant Security`.

## Settings Integration

Configuration should own the editable settings under the broader Security settings area being introduced by the parallel hardening work.

Implemented namespace:

- `assistant.security`

Current fields include:

- `deploymentProfile`
- `operatingMode`
- `triageLlmProvider`
- `continuousMonitoring.enabled`
- `continuousMonitoring.profileId`
- `continuousMonitoring.cron`
- `autoContainment.enabled`
- `autoContainment.minSeverity`
- `autoContainment.minConfidence`
- `autoContainment.categories`

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
- `type: runtime | workspace`
- `label`
- `description`
- `riskLevel`
- `ready`
- `metadata`

### Run

- `id`
- `source: manual | scheduled | system`
- `profileId`
- `profileLabel`
- `startedAt`
- `completedAt`
- `success`
- `message`
- `targetCount`
- `findingCount`
- `highOrCriticalCount`

### Finding

- `id`
- `runId`
- `targetId`
- `category`
- `severity: low | medium | high | critical`
- `confidence`
- `summary`
- `evidence`
- `alertSemantics: posture_only | incident_candidate`
- `status: new | triaged | resolved | suppressed`
- `firstSeenAt`
- `lastSeenAt`
- `occurrenceCount`

## Integration With Existing Security Surfaces

### Security Log

Only high and critical Assistant Security findings classified as incident candidates should flow into `Security Log`.

Posture-only findings should remain in `Assistant Security`, while promoted incident-candidate rows appear in the merged `Security Log` view.

The current as-built path uses the shared `UnifiedSecurityAlert` lifecycle so promoted Assistant Security findings can be triaged alongside host, network, gateway, native, and install alerts. Broader posture-only findings stay visible only in `Assistant Security`.

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

Implemented endpoints:

- `GET /api/security/ai/summary`
- `GET /api/security/ai/profiles`
- `GET /api/security/ai/targets`
- `GET /api/security/ai/runs`
- `POST /api/security/ai/runs`
- `GET /api/security/ai/findings`
- `POST /api/security/ai/findings/status`

Optional later:

- `GET /api/security/ai/trends`
- `POST /api/security/ai/targets`
- `POST /api/security/ai/targets/delete`
- `POST /api/security/ai/profiles`
- `POST /api/security/ai/probes/sync`

## Audit Events

Dedicated audit event names remain future work. The current baseline records Assistant Security runs/findings through the Assistant Security persistence file, Security page APIs, unified alert promotion, scheduled-task history, and tool execution/audit surfaces. Future event names should include:

- `assistant_security_scan_started`
- `assistant_security_scan_completed`
- `assistant_security_scan_failed`
- `assistant_security_finding`
- `assistant_security_regression_detected`

These events should support Security Log correlation and Assistant Security history rendering without inventing a second evidence pipeline.

## Implementation Phases

### Phase 1

- shipped `Security > Assistant Security` tab
- added runtime/workspace target discovery and profile listing
- added run/finding persistence
- shipped built-in deterministic posture probes
- supports manual and scheduled scans for `runtime` and `workspace`
- promotes incident-candidate high/critical findings into `Security Log`

### Phase 2

- add richer trend tracking
- add web UI/browser-backed dynamic probes
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

- add an assistant-security smoke lane to the existing security harness set
- extend `scripts/test-contextual-security-uplifts.mjs` for regression and boundary checks
- add a real-model smoke lane for the manual run path when the configured AI test backend is available

## Recommendation

Build `Assistant Security` as a Guardian-native feature, not as a bolt-on scanner console.

The key design choices are:

- the command center lives in `Security > Assistant Security`
- incident-candidate high/critical findings land in `Security Log`, while posture-only findings remain in `Assistant Security`
- code-session results also appear in `Code > Checks`
- configuration stays in the broader Security settings surface
- scan confidence is explicitly tied to runtime containment posture
