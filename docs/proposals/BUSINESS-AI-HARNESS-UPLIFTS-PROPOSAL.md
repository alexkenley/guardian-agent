# Proposal: Business AI Harness Uplifts for GuardianAgent

**Date:** 2026-03-15
**Status:** Draft
**Author:** Comparison against business-agent risk themes raised in "Beyond the Hype: Why Your Business AI Needs a Harness, Not Just a Wrapper"

---

## Executive Summary

GuardianAgent already behaves more like a true harness than a thin wrapper.

It has strong mandatory runtime enforcement:

- brokered worker isolation for the built-in chat/planner path
- Guardian admission controls before execution
- approval-aware policy enforcement
- sandboxed subprocess execution
- localhost/browser-boundary hardening
- encrypted secret storage
- tamper-evident audit persistence

Those controls already address most of the failure classes commonly associated with fragile agent wrappers:

- plaintext credentials
- broad unauthenticated local control surfaces
- prompt-driven capability escalation
- unsafe direct shell or file access
- brittle "trust the model" execution

The remaining gaps are less about core security architecture and more about business-operability:

1. hard cost governance
2. stronger enterprise identity and authorization
3. tighter scheduled automation governance
4. broader business-facing capability coverage
5. clearer packaging as a reusable control plane for external agent frameworks

The recommendation is to preserve GuardianAgent's current security architecture and invest next in those business-grade uplift areas.

---

## Comparison Summary

| Area | GuardianAgent Today | Current Gap | Recommendation |
|------|----------------------|-------------|----------------|
| Runtime enforcement | Strong mandatory chokepoints, brokered worker, approvals, sandboxing | None at the architectural level | Keep GA lead |
| Secret handling | Encrypted local secret store, output scanning, audit trail | Multi-tenant secret management not yet emphasized | Improve selectively |
| Local web security | Authenticated APIs/SSE, no query-token SSE, localhost hardening | Bearer token is still the only auth mode | Uplift |
| OAuth/bootstrap | Native Google PKCE flow avoids external CLI dependence | More enterprise IdP patterns needed | Uplift |
| Cost control | Token-per-minute and invocation budget controls exist | No hard spend caps, forecasted cost policy, or runaway schedule kill-switches | Uplift urgently |
| Scheduling | Strong CRUD model, approval at create/update time | Later runs are effectively pre-approved once saved | Uplift |
| Capability breadth | Strong security/networking/tooling foundation | Browser, media, voice, and channel breadth lag broader agent platforms | Uplift |
| Memory/search | Per-agent KB plus conversation memory plus hybrid doc search | Automatic semantic recall and ranking can improve | Uplift selectively |
| Product shape | Strong standalone secure orchestrator | Limited story for securing external frameworks | Uplift |

---

## What GuardianAgent Already Does Well

GuardianAgent already avoids several classes of issues that business users should worry about in agent systems:

### 1. Mandatory Runtime Governance

GuardianAgent does not rely on prompt discipline alone. Execution is mediated by runtime chokepoints, approvals, and sandboxing.

Why this matters:

- unsafe instructions do not directly become side effects
- the built-in chat/planner path is separated from the supervisor
- risky tools can be blocked before execution

### 2. Stronger Secret and Localhost Posture

GuardianAgent already avoids the common anti-patterns of plaintext token storage and weak localhost trust assumptions.

Why this matters:

- local control surfaces are a common business deployment risk
- browser-to-localhost abuse is a real attack class
- secret sprawl becomes expensive and hard to audit

### 3. Auditable Memory and Search

GuardianAgent already provides a readable memory model and hybrid search rather than opaque hidden memory layers.

Why this matters:

- business operators need explainable persistent context
- readable memory is easier to audit and clean up
- search quality can be improved without abandoning auditability

---

## Required Uplifts

### 1. Hard Cost Governance and Runaway Automation Control

This is the highest-priority uplift.

GuardianAgent already tracks token rate and invocation budgets, but that is not yet the same thing as business-grade cost control. The system should be able to stop an expensive misconfiguration before it burns money for hours.

Recommended additions:

- per-agent daily spend caps
- per-user daily spend caps
- per-provider daily spend caps
- per-scheduled-task budget ceilings
- per-run estimated cost preview before approval
- cumulative monthly budget tracking
- automatic suspension of schedules after repeated budget overruns
- anomaly alerts for unusual token acceleration or repeated retries
- "dry-run cost estimate" for automations and scheduled tasks

Key design point:

Budget enforcement should fail closed for autonomous and scheduled execution paths once a hard cap is hit.

Suggested integration points:

- `src/runtime/budget.ts`
- `src/runtime/runtime.ts`
- `src/runtime/scheduled-tasks.ts`
- `src/runtime/assistant-jobs.ts`
- `src/runtime/notifications.ts`
- web config/status surfaces

### 2. Enterprise Identity and Authorization Expansion

Bearer-token-only auth is adequate for local-first single-operator use, but not for serious business environments.

Recommended additions:

- pluggable auth provider abstraction
- OIDC / generic OAuth 2.0 support
- Microsoft Entra ID
- Google Workspace identity
- GitHub identity for developer-centric installs
- role mapping for operator, approver, viewer, and admin
- audit principals tied to real identities rather than shared bearer tokens
- scoped approval authority by role and channel
- optional short-lived sessions instead of long-lived static bearer usage

Key design point:

Preserve bearer mode as the default simple path, but add provider-backed multi-user deployments without weakening existing localhost protections.

Suggested integration points:

- `src/config/types.ts`
- `src/channels/web.ts`
- `src/runtime/identity.ts`
- `src/runtime/analytics.ts`
- `SECURITY.md`

### 3. Scheduled Automation Governance

GuardianAgent's current model is operationally pragmatic: approval happens when a scheduled task is created or updated, and later executions are treated as approved. That is convenient, but it is exactly where business users can end up with silent drift, runaway repetition, or stale permissions.

Recommended additions:

- approval expiry windows for scheduled tasks
- automatic re-approval after meaningful task changes
- approval expiry on elevated scope changes
- recurrence-risk scoring for schedules
- execution circuit breaker after repeated failures or denials
- operator-visible "why is this still allowed?" provenance for each saved schedule
- separate policy for autonomous schedules vs attended schedules
- maintenance-window constraints for high-impact tasks
- rate-of-change guardrails for tasks that can post, mutate, or spend money

Key design point:

A saved schedule should behave like a signed automation contract with bounded scope, not an indefinite permission grant.

Suggested integration points:

- `src/runtime/scheduled-tasks.ts`
- `src/runtime/scheduler.ts`
- `src/tools/executor.ts`
- `src/policy/engine.ts`
- audit and notification surfaces

### 4. Capability Breadth for Business Workflows

The article's strongest practical point is not that wrappers are always insecure. It is that businesses will choose broader platforms if the secure harness cannot do enough useful work.

GuardianAgent already has strong tooling in security, networking, files, memory, and automations. The next business-value capabilities should target the biggest practical gaps.

Recommended capability priorities:

- richer Playwright-based browser automation
- persistent browser sessions and profiles
- guarded file upload/download flows
- PDF extraction and analysis
- media understanding for images/audio/video
- text-to-speech for alerts and operator workflows
- broader channels such as Slack or Discord
- stronger business suite integrations beyond Google

Key design point:

Every new capability should be added through the existing Guardian, approval, and sandbox model. Breadth must not bypass enforcement.

Suggested starting point:

- reuse the prioritization already captured in `OPENCLAW-CAPABILITY-ADOPTION.md`

### 5. Adapter SDK for External Agent Frameworks

If GuardianAgent wants to compete as a business harness rather than only as a standalone app, it should secure other agent stacks too.

Recommended additions:

- small adapter SDK for external frameworks
- first-party adapters for OpenAI Agents SDK and LangGraph
- mapped audit events for external tool calls and handoffs
- approval/policy callbacks routed into GuardianAgent runtime
- documented contract for tool execution, approvals, and session identity

Key design point:

The adapter layer must route actions through GuardianAgent's controls rather than reimplementing partial wrapper checks in each integration.

Suggested starting point:

- reuse the adapter direction already outlined in `ZEROTRUSTAGENT-UPLIFTS-PROPOSAL.md`

### 6. Better Memory Ranking and Automatic Semantic Recall

GuardianAgent already has a good memory foundation, but business users will still compare retrieval quality against more aggressive agent platforms.

Recommended additions:

- automatic semantic recall for relevant past facts
- better ranking that combines recency, semantic similarity, and confidence
- memory decay or freshness weighting
- optional LLM-assisted summarization on memory flush
- policy-aware memory classes for sensitive vs general memories
- memory retention controls per workspace or user class

Key design point:

Improve retrieval quality without giving up readable, auditable memory files and searchable structured storage.

Suggested integration points:

- `src/runtime/agent-memory-store.ts`
- `src/search/`
- `docs/guides/MEMORY-SYSTEM.md`

### 7. Repo Hygiene and Security Claim Defensibility

For a product that positions itself as a secure harness, repo hygiene matters. Committed runtime artifacts, loose CI coverage, or missing secret scanning undermine the credibility of security claims.

Recommended additions:

- secret scanning in CI
- artifact hygiene checks for `tmp/`, logs, and generated databases
- dedicated security CI lane
- dependency audit policy
- explicit regression coverage for auth, approvals, sandbox posture, and browser-boundary protections

Key design point:

Security posture is not just runtime behavior. It includes how the project itself is maintained and evidenced.

Suggested starting point:

- reuse the repo-guardrail direction already outlined in `ZEROTRUSTAGENT-UPLIFTS-PROPOSAL.md`

---

## Priority Order

### P0: Required for Business Deployment Confidence

- hard cost governance and schedule kill-switches
- enterprise identity providers and role-based authorization
- scheduled automation approval expiry and scope-bound revalidation

### P1: Required for Product Competitiveness

- richer browser automation
- broader business integrations and channels
- adapter SDK for external frameworks

### P2: Important Quality and Differentiation Uplifts

- improved semantic memory recall and ranking
- repo guardrails and stronger CI/security evidence
- richer operator reporting and budget analytics

---

## Proposed Phases

### Phase 1: Cost and Schedule Safety

- add spend tracking and provider-aware cost accounting
- introduce hard caps and soft alerts
- add schedule circuit breakers and approval expiry
- expose budget state in CLI/web surfaces

Success criteria:

- a misconfigured schedule cannot exceed a configured daily spend ceiling
- operators can see which tasks are consuming budget
- schedules auto-pause after repeated failures or cap violations

### Phase 2: Enterprise Identity

- add auth provider abstraction
- implement OIDC and Entra ID first
- map authenticated principals to approval roles
- preserve local bearer mode as default

Success criteria:

- multi-user deployment with real named approvers
- audit records identify individual actors
- privileged actions can be restricted by role

### Phase 3: Capability Expansion

- deliver Playwright-based browser uplift
- add PDF/media understanding
- add one or two additional business channels/integrations

Success criteria:

- GuardianAgent closes the highest-value capability gaps without bypassing security controls
- new tools inherit the existing policy/approval/sandbox stack

### Phase 4: Adapter and Control Plane Positioning

- ship adapter SDK v1
- publish first two framework adapters
- add integration tests proving runtime controls remain authoritative

Success criteria:

- GuardianAgent can secure at least two external agent frameworks without weakening its enforcement model

### Phase 5: Memory and Evidence Quality

- improve semantic recall and summarization
- tighten CI and repo hygiene
- expand operator-facing budget and security reporting

Success criteria:

- better retrieval quality on long-running workflows
- stronger evidence for security and reliability claims

---

## What GuardianAgent Should Not Do

- weaken the current mandatory runtime enforcement model in exchange for easier integrations
- replace brokered isolation with prompt-level conventions
- make budget controls advisory-only for scheduled autonomous paths
- add enterprise auth in a way that weakens localhost/browser-boundary hardening
- pursue capability breadth by introducing unmanaged side channels around Guardian

GuardianAgent's differentiator is not just that it can act. It is that it can act through an opinionated, auditable, enforceable control plane.

---

## Recommended Immediate Next Steps

1. Define a cost-accounting schema and budget policy model.
2. Add approval-expiry and scope-drift logic to scheduled tasks.
3. Introduce an auth-provider abstraction with OIDC/Entra as first targets.
4. Start the browser uplift track using the existing OpenClaw capability analysis.
5. Define the public adapter contract for external frameworks.

---

## Success Definition

GuardianAgent should be considered successfully uplifted for this business-harness roadmap when:

- autonomous or scheduled agent activity cannot silently run away on cost
- business deployments can use named identities and role-based approvals
- stored automations have bounded, reviewable authority
- major missing business capabilities are covered through managed tools
- external agent frameworks can reuse GuardianAgent as a security control plane
- the project can defend its security claims with tests, docs, and operational evidence
