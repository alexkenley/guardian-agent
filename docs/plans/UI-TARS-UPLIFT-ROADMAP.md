# UI-TARS Uplift Roadmap

**Date:** 2026-03-22
**Status:** Draft
**Origin:** Analysis of [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) against GuardianAgent
**Primary Guardian files:** `src/channels/web.ts`, `src/index.ts`, `src/runtime/orchestrator.ts`, `src/runtime/orchestration-tracing.ts`, `src/runtime/run-events.ts`, `src/runtime/code-sessions.ts`, `src/runtime/code-workspace-profile.ts`, `src/runtime/code-workspace-map.ts`, `src/runtime/browser-session-broker.ts`, `src/tools/mcp-client.ts`, `src/tools/executor.ts`

---

## Goal

Improve GuardianAgent's operator quality and user-facing agent UX by selectively borrowing the strongest ideas from UI-TARS-desktop while preserving GuardianAgent's existing lead in:

- runtime-enforced security boundaries
- approval-aware execution
- brokered worker isolation
- trust-aware memory and output handling
- auditability and tamper-evident persistence

This roadmap is about borrowing **product shape and execution ergonomics**, not copying UI-TARS's trust model, telemetry posture, or model-specific GUI loop.

## Comparison Summary

### GuardianAgent leads in

- runtime security architecture and mandatory chokepoints
- approval workflows and policy enforcement
- graph-backed orchestration and deterministic resume
- coding-session state, workspace trust, and verification tracking
- multi-channel assistant operation

### UI-TARS leads in

- multimodal operator UX
- browser and computer action visibility
- explicit screenshot/action playback
- hybrid browser-control product framing
- user takeover and resume flow
- run artifact sharing and session presentation

## Principles

- **Keep Guardian's trust boundary.** All new browser, operator, or visual flows must stay behind Guardian admission, approvals, SSRF controls, audit, and output scanning.
- **Prefer wrappers over raw capability exposure.** Expose clean Guardian-native tools and UX, even if the backend uses MCP or another engine internally.
- **DOM-first, vision-fallback.** For browser work, use deterministic structured tools first and only fall back to visual control when the structured lane is insufficient.
- **Human takeover is a product feature, not a failure case.** Sensitive or brittle tasks should pause cleanly, hand control to the user, and resume explicitly.
- **Trace data should be operator-visible.** Existing runtime traces and run events should become a first-class UI surface.
- **Local-first by default.** Do not copy hosted telemetry or remote operator assumptions into Guardian's default product behavior.

## Current Implementation Focus

The recommended near-term scope is:

1. run timeline and event viewer
2. hybrid browser lane with Guardian-native tools
3. explicit human takeover and resume
4. exportable run artifacts for code and automation sessions

Guarded computer-use operator work should stay behind those foundations unless a concrete local use case justifies it.

---

## Phase 1: Run Timeline And Event Viewer

**Detailed spec:** [RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md](../design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md)

### Goal

Turn Guardian's existing trace and run-event primitives into a real operator-facing timeline for chat, code, browser, and automation work.

### Why this phase first

Guardian already stores meaningful execution state, but much of it is only surfaced indirectly. UI-TARS treats event streams and action playback as a product, not just internal plumbing. Guardian should do the same before adding more browser complexity.

### Deliver

- unified run timeline model for:
  - tool calls
  - approvals
  - handoffs
  - verification steps
  - browser session milestones
  - code-session job activity
- live timeline panel in the web UI and Coding Assistant
- per-run status summary:
  - running
  - awaiting approval
  - takeover required
  - verification pending
  - completed
  - failed
- richer event metadata for user-visible explanations, not just internal debugging
- update `src/reference-guide.ts` for the new timeline surfaces, navigation, and playback workflow

### Likely implementation areas

- `src/runtime/orchestrator.ts`
- `src/runtime/orchestration-tracing.ts`
- `src/runtime/run-events.ts`
- `src/runtime/code-sessions.ts`
- `src/index.ts`
- `src/channels/web.ts`
- `web/public/`

### Exit criteria

- a user can open any recent code session or automation run and see a clear timeline of what happened
- approvals and verification are visible as timeline states, not only as detached messages
- trace events are streamed incrementally to the UI rather than reconstructed only after completion

---

## Phase 2: Guardian-Native Hybrid Browser Lane

### Goal

Adopt the most valuable UI-TARS browser idea: hybrid control. Guardian should offer clean browser task tools that combine structured page understanding with controlled fallback paths.

### Deliver

- Guardian-native browser tool set oriented around intent, such as:
  - `browser_navigate`
  - `browser_read`
  - `browser_links`
  - `browser_interact`
  - `browser_extract`
  - optional guarded `browser_evaluate`
- DOM-first execution with a defined fallback path when structured interaction fails
- browser capability preflight that explains what is and is not supported by the current backend/provider
- stronger browser-session UX:
  - current URL
  - page title
  - session status
  - last action
  - approval/takeover state
- update `src/reference-guide.ts` for the hybrid browser workflow, capability limits, and any new browser session affordances

### Security requirements

- keep SSRF protection and domain validation mandatory
- keep high-risk browser state mutation blocked or approval-gated per current `BrowserSessionBroker`
- do not expose arbitrary page-code execution without Guardian policy and Layer 2 review
- keep scheduled browser mutation rules fail-closed

### Likely implementation areas

- `docs/proposals/LIGHTPANDA-BROWSER-PROPOSAL.md`
- `src/runtime/browser-session-broker.ts`
- `src/tools/mcp-client.ts`
- `src/tools/executor.ts`
- `src/guardian/ssrf-protection.ts`
- `src/channels/web.ts`

### Exit criteria

- Guardian exposes a browser workflow that feels like a product surface, not a bag of raw tool calls
- read-oriented browser tasks complete in the structured lane by default
- mutating browser actions remain clearly scoped and approval-aware
- the user can tell why the agent chose DOM interaction, fallback logic, or paused

---

## Phase 3: Human Takeover And Resume

### Goal

Add an explicit pause/resume model for tasks that need the user's hands for a short interval.

### Rationale

UI-TARS's `call_user()` concept is worth borrowing. Guardian approvals are strong, but they do not fully solve tasks like login, 2FA, CAPTCHA, manual security prompts, or subjective UI confirmation.

### Deliver

- explicit runtime state for `takeover_required`
- browser and code-session UI states that show:
  - why the agent paused
  - what the user needs to do
  - what the agent will do after resume
- resume action bound to the same session and principal
- safe timeout/expiry behavior for stale paused sessions
- audit events for takeover requested, resumed, expired, or cancelled
- update `src/reference-guide.ts` for takeover prompts, resume behavior, expiry, and audit visibility

### Likely implementation areas

- `src/index.ts`
- `src/runtime/code-sessions.ts`
- `src/runtime/pending-approval-copy.ts`
- `src/tools/approvals.ts`
- `src/channels/web.ts`
- `web/public/`

### Exit criteria

- Guardian can pause a live browser or code task and later resume it cleanly
- the pause state is distinct from approval pending and distinct from failure
- resumed tasks keep the relevant session context without reopening the entire planning loop from scratch

---

## Phase 4: Exportable Run Artifacts

### Goal

Give operators a clean way to export or review what the agent did, especially for coding and automation runs.

### Deliver

- local-first HTML or Markdown exports for:
  - code sessions
  - workflow runs
  - browser tasks
  - security triage sessions
- exports include:
  - task summary
  - timeline
  - approvals
  - changed files
  - verification results
  - evidence and citations where relevant
- artifact generation should default to local download or local storage, not hosted upload
- update `src/reference-guide.ts` for export entry points, artifact contents, and redaction behavior

### Constraints

- any share/export mechanism must respect secret and PII redaction
- no silent telemetry upload
- generated artifacts should be clearly marked when content was truncated or redacted

### Likely implementation areas

- `src/runtime/code-sessions.ts`
- `src/index.ts`
- `src/channels/web.ts`
- `src/reference-guide.ts`
- `web/public/`

### Exit criteria

- a code session can be exported as a readable artifact without copying from the UI manually
- automation runs have a durable human-readable review format
- exports preserve Guardian's safety posture and redaction rules

---

## Phase 5: Guarded Operator Abstraction

### Goal

Introduce a reusable internal operator layer for browser, computer, and possibly remote execution surfaces without letting those surfaces bypass Guardian.

### Scope

This is an internal architecture phase, not a commitment to ship a full local desktop GUI agent immediately.

### Deliver

- internal operator contract for bounded environments, for example:
  - capture state
  - propose action
  - execute action
  - report result
- browser operator implementation first
- optional future extensions for:
  - local desktop operator
  - remote browser operator
  - remote computer operator
- provider/backend capability registry to avoid attempting unsupported modes
- update `src/reference-guide.ts` if any new operator-backed user-visible surface, control, or status is introduced

### Non-goal

- copying the UI-TARS screenshot-driven desktop loop as Guardian's default assistant path
- replacing coding tools or browser tools with a purely vision-driven control loop

### Likely implementation areas

- `src/runtime/`
- `src/tools/`
- `src/channels/web.ts`
- `src/index.ts`

### Exit criteria

- Guardian has a clean internal abstraction for operator-style environments
- browser work uses the abstraction without weakening the current security pipeline
- future operator additions can plug into the same approval, audit, and trace surfaces

---

## Phase 6: Typed Web Contract And UI Surface Cleanup

### Goal

Reduce friction in the web surface by moving toward a typed, schema-first contract for the high-churn run, approval, and code-session APIs.

### Rationale

UI-TARS's typed IPC layer is cleaner than Guardian's large hand-managed web route surface. Guardian does not need Electron IPC, but it should adopt the discipline of typed contracts for the most complex runtime surfaces.

### Deliver

- typed schemas for:
  - run timeline events
  - code-session snapshots
  - browser session state
  - approval and takeover actions
- export requests
- smaller route handlers with clearer request/response boundaries
- easier testability for the web API
- update `src/reference-guide.ts` for any user-visible API contract changes that alter workflows, labels, or surfaced state

### Likely implementation areas

- `src/channels/web.ts`
- `src/channels/web-types.ts`
- `src/index.ts`
- web UI consumers under `web/public/`

### Exit criteria

- new browser/timeline/takeover features are added through typed contracts rather than ad hoc JSON shapes
- the web surface becomes easier to evolve without silent frontend/backend drift

---

## Deferred Work

These ideas may be worth exploring later, but they should not lead the roadmap:

- full local desktop computer-use agent for arbitrary OS control
- remote hosted browser/computer operator services
- screenshot-heavy multimodal execution as the default mode
- telemetry-backed sharing flows
- model-provider-specific prompt flows tied to one VLM family

## Non-Goals

- weakening Guardian's approval, audit, or sandbox boundaries
- copying UI-TARS's telemetry or hosted-service assumptions
- replacing the current Coding Assistant with a screenshot-driven UI agent
- building a consumer desktop-control novelty feature before browser and code-session UX are improved

## Recommended Order

1. Run timeline and event viewer
2. Guardian-native hybrid browser lane
3. Human takeover and resume
4. Exportable run artifacts
5. Guarded operator abstraction
6. Typed web contract cleanup

## Success Criteria

- Guardian sessions become easier to inspect, replay, and trust
- browser tasks feel more capable without becoming less safe
- the user can distinguish approvals, takeovers, failures, and verification outcomes at a glance
- exports and playback reduce manual context reconstruction for debugging and review
- new operator surfaces are added through Guardian-native boundaries, not side channels

## Source References

- UI-TARS monorepo: <https://github.com/bytedance/UI-TARS-desktop>
- Guardian architecture overview: [OVERVIEW.md](../architecture/OVERVIEW.md)
- Guardian browser containment: [browser-session-broker.ts](../../src/runtime/browser-session-broker.ts)
- Guardian orchestration and run events: [orchestrator.ts](../../src/runtime/orchestrator.ts), [orchestration-tracing.ts](../../src/runtime/orchestration-tracing.ts), [run-events.ts](../../src/runtime/run-events.ts)
- Guardian code-session state: [code-sessions.ts](../../src/runtime/code-sessions.ts)
- Guardian workspace context layers: [code-workspace-profile.ts](../../src/runtime/code-workspace-profile.ts), [code-workspace-map.ts](../../src/runtime/code-workspace-map.ts)
