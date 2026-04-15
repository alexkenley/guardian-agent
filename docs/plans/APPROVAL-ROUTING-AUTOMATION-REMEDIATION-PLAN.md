# Approval, Routing, and Automation Remediation Plan

**Status:** Draft remediation plan  
**Date:** 2026-04-15  
**Scope:** Web approvals, brokered/delegated execution, coding-task routing, scheduled assistant automations, and release-readiness coverage

## Goal

Rectify the class of failures where Guardian appears to "go in circles" around approvals, delegated follow-up, and automation creation by fixing the owning layer instead of papering over symptoms.

This plan is intentionally split into:

- real product bugs
- capability/model-routing deficiencies
- harness/test deficiencies
- higher-level architecture gaps

## Guardrails

The fixes in this plan must preserve the existing security model in [SECURITY.md](../../SECURITY.md) and the brokered/supervisor-owned control model in:

- [docs/specs/PENDING-ACTION-ORCHESTRATION-SPEC.md](../specs/PENDING-ACTION-ORCHESTRATION-SPEC.md)
- [docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md](../specs/BROKERED-AGENT-ISOLATION-SPEC.md)
- [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](../specs/TOOLS-CONTROL-PLANE-SPEC.md)
- [docs/specs/AUTOMATION-FRAMEWORK-SPEC.md](../specs/AUTOMATION-FRAMEWORK-SPEC.md)

Non-goals:

- Do not "fix" approval UX by bypassing the broker, approval store, or `pendingAction` metadata.
- Do not turn scheduled assistant runs into unrestricted autonomous executions.
- Do not special-case Gmail, web fetch, or Codex/test-suite requests with one-off channel hacks.
- Do not treat policy-driven auto-approval as a security bypass. If a tool is pre-approved by policy, that is a configuration outcome, not a control-plane violation.

## Executive Summary

The pasted failures are not one bug. They cluster into four separate buckets:

1. **Shared approval/orchestration defects**
   - The original web-approval button regression was real.
   - Canonical brokered approval rendering now looks mostly correct again, but the generic non-brokered multi-step continuation path is still not fully healthy.

2. **Delegated execution and routing deficiencies**
   - Search and coding requests are reaching generic managed-cloud tool loops too often, so the model improvises with repeated approval hops instead of executing a bounded plan.

3. **Automation compiler/runtime defects**
   - Scheduled assistant automations are currently saving the wrong runtime prompt in some cases and can re-enter automation creation at execution time.
   - Scheduled `assistant_task` approval semantics do not match the architecture spec: save-time approval is not being cleanly carried into later assistant runs.

4. **Test-harness and observability gaps**
   - Some failures are product bugs.
   - Some are harness issues, especially where a harness unintentionally hits real provider auth or where background security automations add noisy trace/audit data.

## Evidence Baseline

Primary evidence reviewed:

- Windows routing trace: `/mnt/c/Users/kenle/.guardianagent/routing/intent-routing.jsonl`
- Windows audit log: `/mnt/c/Users/kenle/.guardianagent/audit/audit.jsonl`
- Saved task state: `/mnt/c/Users/kenle/.guardianagent/scheduled-tasks.json`
- Automation output index: `/mnt/c/Users/kenle/.guardianagent/automation-output/index.json`

Representative observed requests:

- `Search the web for the latest OpenAI API pricing.`  
  Trace shows correct `search_task` routing, then a blocked delegated path on `https://openai.com/api/pricing`, followed by 403/retry churn and extra approvals.

- `run the test suite for this repo`  
  Trace shows correct `coding_task` routing, but no direct candidate handling. The request falls into a managed-cloud coding tool loop and blocks on repeated `code remote exec` approvals.

- `Set up a scheduled automation that emails me a daily summary every morning.`  
  Trace shows correct `automation_authoring` routing, but the saved task prompt in `scheduled-tasks.json` is the original authoring request, not the intended runtime behavior.

- Gmail send/read flows in web chat  
  Current trace shows canonical `pendingAction` metadata for send approvals and normal direct completion for read paths, which suggests the specific web approval-button regression is no longer the main blocker.

## Classification Matrix

| Area | Current Classification | Why |
| --- | --- | --- |
| Web approval buttons not surfacing | **Real bug, largely fixed for canonical brokered flows** | The web UI depends on `response.metadata.pendingAction`. Earlier blocked responses were not consistently carrying canonical metadata. Current Gmail-send traces now show the expected metadata path again. |
| Generic non-brokered multi-step web continuation | **Real bug** | The generic web approval harness still falls back into "You already have blocked work waiting for input or approval" after approval continuation. That is shared continuation-state drift, not a Gmail-only issue. |
| OpenAI pricing request taking many approval cycles | **Capability/routing deficiency** | Routing is correct, but the delegated tool loop keeps making serial fetch attempts and asking for new approvals instead of executing a bounded retrieval plan. |
| `run npm test` / `run the test suite` causing repeated approvals and tool churn | **Architecture + routing deficiency** | The request is correctly classified as `coding_task`, but execution falls into a generic managed-cloud coding loop rather than a bounded coding backend or a single explicit execution plan. |
| `vitest: not found` leading to escalating command guesses (`npm install`, `npx vitest`, etc.) | **Capability deficiency** | This is model-side execution planning drift. The system lacks a deterministic repo-command strategy for prerequisite handling and approval bundling. |
| `Invalid capability token` shown near these failures | **Separate platform reliability item; not yet proven root cause of the pasted UX failures** | The audit stream shows `Invalid capability token` appearing as security-triage noise, but not as direct evidence that the pricing/test-suite user requests failed on token validation. |
| Scheduled assistant task asks for approval again at runtime | **Architecture gap** | The automation spec says save-time approval should cover bounded later runs while scope/TTL remain valid. `assistant_task` runs are not honoring that model yet. |
| Scheduled assistant task stores authoring prompt instead of runtime goal | **Real bug** | The saved task prompt is `Set up a scheduled automation...` instead of `check email and send/write a summary`. This is an authoring-compiler defect. |
| Automation name drift like `Daily You Are Executing Fulfill` | **Real bug** | This is title/name extraction drift in the automation compiler, not an approval bug. |
| Scheduled run recorded as succeeded even when it only emitted a blocked approval flow | **Real bug + architecture mismatch** | The run history/output path currently treats some assistant-task deliveries as success even when the assistant actually produced another blocked authoring turn. |
| Gmail web approval harness failing after approval because Google auth was required | **Harness deficiency** | That particular harness failure hit real provider auth after approval. It does not prove the approval-button path is broken. |

## Root-Cause Workstreams

### 1. Shared Pending-Action Continuity

**Owner layer:** `PendingActionStore`, shared continuation/resume logic, channel rendering  
**Primary files:** `src/chat-agent.ts`, `src/runtime/pending-actions.ts`, `src/runtime/chat-agent/*`, `web/public/js/chat-panel.js`

Fixes:

- Enforce the immediate-approval invariant on every blocked response path, not only the common brokered tool loop.
- Make approval continuation idempotent and scope-aware so a resumed turn does not rediscover its own still-active blocked slot.
- Treat `pendingAction` metadata as the single channel contract for approval UI state across web, CLI, and Telegram.
- Add explicit regression coverage for non-brokered direct routes, not only brokered tool calls.

Exit criteria:

- `scripts/test-web-approvals.mjs` passes without the blocked-work recursion.
- Approval buttons render on the first blocked response for direct-route and delegated paths alike.
- Post-approval continuation clears or updates the active pending slot exactly once.

### 2. Delegated Search And Coding Execution Discipline

**Owner layer:** intent-to-capability mapping, direct-candidate handling, delegated tool-loop policy  
**Primary files:** `src/runtime/intent-gateway.ts`, `src/runtime/intent/capability-resolver.ts`, `src/chat-agent.ts`

Fixes:

- For `search_task`, introduce a bounded retrieval plan so "search latest pricing" does not become a serial fetch roulette with one approval per fallback URL.
- For `coding_task` with an attached code session, prefer a deterministic coding execution path over a generic managed-cloud tool loop when the user is clearly asking to run repo commands.
- When a repo command likely needs setup (`npm ci`/`npm install`), build a single explicit plan and present one bounded approval request where possible instead of letting the model keep escalating commands ad hoc.
- Separate "I need approval to execute this plan" from "I am guessing at the next command."

Exit criteria:

- `run the test suite for this repo` produces a single bounded execution plan or cleanly routes to the coding backend.
- Search flows do not require a new approval for each fallback URL unless the requested scope genuinely widens.
- Failed fetches or missing binaries produce concrete diagnoses, not model churn.

### 3. Scheduled Assistant Automation Semantics

**Owner layer:** automation compiler plus scheduled-task runtime  
**Primary files:** `src/runtime/automation-authoring.ts`, `src/runtime/automation-prerouter.ts`, `src/runtime/automation-save.ts`, `src/runtime/scheduled-tasks.ts`

Fixes:

- Split **authoring request** from **runtime operator goal**. The runtime prompt must describe the future task to perform, not the act of creating an automation.
- Replace brittle title heuristics that can turn prompt boilerplate into the automation name.
- Introduce a bounded scheduled-assistant execution contract analogous to pre-approved scheduled tool/playbook runs:
  - principal-bound
  - scope-hash-bound
  - TTL-bound
  - still enforced through supervisor-owned broker/policy/audit controls
- Do not use a blanket runtime bypass. The correct fix is a scheduled-run authority model for assistant turns.
- Ensure scheduled `assistant_task` runs report `pending_approval` when blocked instead of being marked `succeeded` merely because a message was delivered.

Exit criteria:

- A saved scheduled email-summary automation stores a runtime prompt that actually checks email and produces a summary.
- Run history distinguishes `succeeded`, `failed`, and `pending_approval` correctly for assistant automations.
- Save-time approval is sufficient for bounded future assistant runs until TTL expiry or scope drift.
- Expired or drifted automations fail with a clean "needs re-approval" state instead of silently re-entering authoring.

### 4. Broker Token Reliability And Noise Isolation

**Owner layer:** broker/session lifecycle and security triage integration  
**Primary files:** `src/broker/capability-token.ts`, `src/broker/broker-server.ts`, security-triage wiring

Fixes:

- Reproduce the real `Invalid capability token` path with correlation to worker lifecycle, session reuse, and delayed tool calls.
- Distinguish platform-integrity signals from user-request failures so background triage noise does not get mistaken for the root cause of a front-end or automation issue.
- Add correlation IDs from user request -> delegated worker -> broker token -> tool call outcome.

Exit criteria:

- We can reproduce or dismiss the token issue with a deterministic test.
- Security triage alerts no longer muddy approval/routing debugging for unrelated user requests.

### 5. Harness And Release Coverage

**Owner layer:** integration harnesses and release gates  
**Primary files:** `scripts/test-web-approvals.mjs`, `scripts/test-web-gmail-approvals.mjs`, `scripts/test-brokered-approvals.mjs`, coding/task harnesses

Fixes:

- Keep provider auth fully stubbed in approval harnesses that are meant to verify orchestration, not live provider credentials.
- Add a release gate that separates:
  - product-orchestration failure
  - live-provider auth failure
  - harness setup failure
- Cover both brokered and non-brokered approval continuations.
- Cover both scheduled-tool/playbook and scheduled-assistant runtime behavior.

Exit criteria:

- Harness failures tell us exactly which layer broke.
- Live-provider auth is never mistaken for approval-rendering regressions.
- Release gates include at least one generic approval flow per capability class, not just Gmail.

## Prioritized Release Sequence

### Release blockers

1. Shared pending-action continuity for generic web approval flows
2. Scheduled assistant automation prompt/name corruption
3. Scheduled assistant runtime approval semantics
4. Coding-task execution/routing discipline for repo command requests

### High priority but can land in parallel

1. Search-task approval batching and fetch-planning cleanup
2. Capability-token reliability triage
3. Harness hardening and clearer failure taxonomy

## Concrete Test Matrix

These should become the minimum release-readiness matrix after the fixes:

- **Web direct-route approval**
  - Ask for a filesystem/tool-policy change that requires approval.
  - Verify buttons appear on the first blocked message.
  - Approve once and confirm the original action resumes instead of falling into blocked-work recursion.

- **Web Gmail send approval**
  - Ask to send a Gmail message.
  - Verify canonical `pendingAction` metadata, approval buttons, approval continuation, and final completion.

- **Web search with latest/current request**
  - Ask for latest pricing/news that requires web retrieval.
  - Verify bounded approval behavior and no multi-hop approval roulette.

- **Coding task with attached workspace**
  - `Run the test suite for this repo`
  - `Run npm test in the current workspace`
  - `Run npx vitest run src/tools/executor.test.ts`
  - Verify deterministic execution planning and no ad hoc command escalation.

- **Scheduled assistant automation create + run**
  - Create a daily inbox-summary automation.
  - Inspect the saved prompt and name.
  - Trigger a run.
  - Verify it performs the runtime task, not "create an automation" again.
  - Verify blocked runs are recorded as blocked, not succeeded.

- **Scheduled tool/playbook parity**
  - Run one scheduled tool and one scheduled playbook with pre-approved scope.
  - Confirm bounded no-reapproval behavior still works.

- **Expiry/scope drift**
  - Edit a saved automation to change schedule or behavior.
  - Verify scope hash changes force re-approval.
  - Verify unchanged metadata edits do not unnecessarily invalidate approval.

- **Cross-surface parity**
  - Repeat one approval scenario each on web, CLI, and Telegram.
  - Confirm all surfaces are driven by the same pending-action contract.

## Decision Summary

What should be treated as architecture work rather than bug-chasing:

- scheduled assistant run authority
- coding-task routing away from generic tool-loop improvisation
- shared post-approval continuation invariants

What should be treated as direct bugs:

- automation runtime prompt corruption
- automation name drift
- scheduled assistant run status misreporting
- residual non-brokered web continuation failure

What should be treated as harness cleanup:

- Gmail approval harnesses that accidentally depend on real Google auth
- noisy background security automation signals during unrelated UX debugging

## Success Definition

Guardian is ready for an initial packaged release when:

- approvals surface immediately and consistently on every channel
- approval continuation resumes the original work exactly once
- coding requests run through bounded, intelligible execution plans
- scheduled assistant automations execute the saved task rather than re-authoring themselves
- no fix requires bypassing the broker, the approval system, or supervisor-owned security controls
