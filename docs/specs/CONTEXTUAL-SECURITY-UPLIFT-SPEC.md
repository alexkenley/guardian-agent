# Contextual Security Uplift Spec

**Status:** Implemented  
**Date:** 2026-03-16  
**Proposal Origin:** [docs/implemented/CONTEXTUAL-SECURITY-UPLIFT-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/implemented/CONTEXTUAL-SECURITY-UPLIFT-PROPOSAL.md)

## Purpose

Define the shipped contextual-security model for GuardianAgent.

This spec covers the runtime behavior that now exists in production code:
- taint-aware tool-result classification and planner reinjection control
- trust-aware memory with quarantine states
- principal-bound approvals
- bounded schedule authority and runaway breakers
- per-chain tool overspend suppression for broken or looping tool paths
- postcondition verification for selected mutating tools

This is a runtime spec, not a proposal. The original proposal remains in `docs/proposals/` as rationale.

## Design Goals

GuardianAgent already had strong action-time controls. The uplift closes the gap between:
- detecting suspicious content
- deciding whether that content may influence planning, memory, delegation, or automation

The implemented model enforces five properties:
1. Remote content is classified before it can steer downstream behavior.
2. Durable memory stores trust and quarantine state, not just text.
3. Approval authority is bound to the authenticated principal surface that made the request.
4. Saved automations have bounded authority instead of indefinite implicit approval.
5. High-impact tool completions can be marked verified, unverified, or failed.

## Runtime Trust Model

### Tool-result trust levels

`OutputGuardian.scanToolResult()` classifies tool output into:
- `trusted`
- `low_trust`
- `quarantined`

It also returns:
- `taintReasons`
- `allowPlannerRawContent`
- `allowMemoryWrite`
- `allowDownstreamDispatch`

Current defaults:
- local/provider-internal results start as `trusted`
- remote/external results start as `low_trust`
- prompt-injection-like results escalate to `quarantined`

### Planner reinjection behavior

- `trusted`: sanitized content may re-enter the planner normally
- `low_trust`: sanitized content re-enters with trust metadata
- `quarantined`: raw content is suppressed and replaced with a constrained summary envelope

The brokered worker path and the in-process chat path both propagate:
- `trustLevel`
- `taintReasons`
- `derivedFromTaintedContent`

This trust state follows subsequent tool decisions in the same run.

## Contextual Tool Enforcement

`ToolExecutor` now consumes contextual request inputs:
- `principalId`
- `principalRole`
- `contentTrustLevel`
- `taintReasons`
- `derivedFromTaintedContent`
- `scheduleId`

Implemented enforcement rules:
- quarantined content cannot directly drive non-read-only tools
- tainted content driving mutating tools requires approval
- assistant-origin memory mutation tools are denied unless the user explicitly established remember/save intent
- trusted direct memory writes auto-allow by default, even in `approve_each`, unless a stronger explicit policy overrides them
- `memory_save` from tainted content is approval-gated or denied depending on trust level
- direct tool API and brokered tool calls both carry these contextual inputs
- repeated identical failed tool calls in one chain are blocked before retry loops can overspend
- total tool calls, repeated identical calls, and non-read-only calls are capped per execution chain

## Trust-Aware Memory

`AgentMemoryStore` is now a markdown-plus-sidecar store:
- readable markdown for active memory
- `.index.json` sidecar for trust metadata

Per-entry metadata includes:
- `sourceType`
- `trustLevel`
- `status`
- `createdByPrincipal`
- `provenance`
- optional expiry

Statuses:
- `active`
- `quarantined`
- `expired`
- `rejected`

Current behavior:
- trusted user/local writes may become `active`
- low-trust or tainted remote-derived writes default to `quarantined`
- quarantined memory is excluded from default planner context
- verification distinguishes active memory writes from quarantined ones
- `assistant.memory.knowledgeBase.readOnly` freezes normal assistant/runtime durable writes in both global and Code-session memory
- verified memory indexes are now the canonical durable state; prompt loads reject tampered indexes instead of trusting cached markdown
- automatic flush skips durable writes while the freeze is enabled
- persistent memory enforces `maxEntryChars`, `maxEntriesPerScope`, and `maxFileChars`
- prompt-time persistent memory injection is entry-aware and summary-aware instead of raw string slicing

## Principal-Bound Approvals

Approval requests now capture:
- requesting principal
- requesting role
- allowed principals
- allowed roles
- decision principal
- decision role

The web channel now derives approval actors from the authenticated session/bearer path rather than trusting request-body actor identifiers.

Current roles:
- `owner`
- `operator`
- `approver`
- `viewer`

Multi-user tenancy is not yet implemented. Current web fallback may still collapse bearer-authenticated requests into a shared `web-bearer` principal. This is acceptable for the current single-user deployment model and is a known future extension point.

## Bounded Schedule Authority

Scheduled tasks no longer rely on indefinite "approved once created" semantics.

Each task now stores:
- `approvedByPrincipal`
- `approvalExpiresAt`
- `lastApprovedAt`
- `scopeHash`
- `maxRunsPerWindow`
- `dailySpendCap`
- `providerSpendCap`
- failure and denial counters
- `autoPausedReason`

Execution is blocked when:
- approval expires
- the scope hash drifts
- run-window limits are exceeded
- token budgets are exceeded

Tasks auto-pause after repeated failures or denials.

## Broken-Tool Overspend Controls

`ToolExecutor` now keeps short-lived per-chain execution budgets keyed to the originating request or approval chain.

Current guards include:
- total tool-call cap per chain
- non-read-only tool-call cap per chain
- identical-call cap per tool/argument tuple
- repeated identical failure cap per tool/argument tuple

These guards fail closed before higher-level token budgets are exhausted. They exist to contain:
- broken tool implementations that keep returning retryable failures
- planner loops that repeatedly invoke the same mutation
- approval-granted chains that would otherwise keep spending after a tool starts failing

These controls complement, rather than replace:
- runtime token and provider budgets
- schedule run-window and spend caps
- watchdog stall detection
- approval gating for mutating tools

## Verification Model

Tool results and jobs can now carry:
- `verificationStatus`
- `verificationEvidence`

Current verifier coverage includes:
- `memory_save`
- `task_create`
- `task_update`

Semantics:
- `verified`: postcondition confirmed
- `unverified`: tool reported success but runtime could not confirm the final state
- `failed`: verification failed or the tool returned failed state

## Affected Files

Primary implementation:
- `src/guardian/output-guardian.ts`
- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`
- `src/tools/approvals.ts`
- `src/runtime/scheduled-tasks.ts`
- `src/runtime/budget.ts`
- `src/index.ts`
- `src/channels/web.ts`
- `src/broker/broker-server.ts`
- `src/worker/worker-llm-loop.ts`

## Verification

Unit/integration coverage:
- `src/runtime/agent-memory-store.test.ts`
- `src/guardian/output-guardian.test.ts`
- `src/runtime/budget.test.ts`
- `src/runtime/scheduled-tasks.test.ts`
- `src/tools/executor.test.ts`

Harness coverage:
- `scripts/test-contextual-security-uplifts.mjs`

The harness validates:
- quarantined context cannot directly drive filesystem mutation
- trusted vs low-trust memory behavior
- approval-bound low-trust memory persistence
- privileged-ticket gating for security-sensitive config mutation used by the harness itself
- expired schedule denial and re-approval
- failure-driven task auto-pause
- repeated broken-tool retries are stopped before they can continue spending

## Non-Goals

This uplift does not yet implement:
- multi-user tenant isolation
- a standalone secret-broker process
- a persistent global taint graph across every runtime subsystem
- declarative policy-authoritative enforcement for every security family

Those remain separate follow-on efforts. This spec describes the contextual-security controls that are already implemented.
