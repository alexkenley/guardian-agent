# Proposal: Contextual Security Uplifts for GuardianAgent

**Date:** 2026-03-16
**Status:** Superseded by implemented spec
**Author:** Comparison against "51 attacks and 60 defenses from 128 papers: the AI agent security map" and GuardianAgent runtime

This proposal has been carried forward into the shipped runtime spec at [`docs/design/CONTEXTUAL-SECURITY-UPLIFT-DESIGN.md`](../design/CONTEXTUAL-SECURITY-UPLIFT-DESIGN.md). It remains here as design rationale and historical context.

---

## Executive Summary

GuardianAgent already has stronger runtime security than many agent systems:

- mandatory admission chokepoints
- brokered worker isolation
- approval-gated mutations
- OS sandbox integration
- output secret scanning
- tamper-evident audit persistence

That is a real advantage. The main remaining gap is not basic action blocking. It is **contextual security**.

Today, GuardianAgent is good at:

- blocking high-signal malicious user input
- denying unsafe tool executions
- redacting secrets from outputs
- requiring approval for many mutations

Today, GuardianAgent is weaker at:

- treating remote content as tainted all the way through planning
- preventing poisoned content from entering long-lived memory
- stopping inter-agent and cross-step cascades before they amplify
- proving high-impact actions actually succeeded before reporting success

This proposal recommends five focused uplifts:

1. Make provenance and taint enforcement real, not advisory.
2. Harden persistent memory against poisoning and backdoor persistence.
3. Extend policy-as-code to taint, memory, and contextual decisions.
4. Add live cascade breakers for inter-agent and multi-step workflows.
5. Add postcondition verification for high-impact actions.

These changes build on the current architecture. They do not require replacing the brokered worker model, the Guardian admission pipeline, or the ToolExecutor.

Relevant overlap from the business-harness roadmap should be incorporated at the same time:

- actor-aware authorization instead of coarse shared identity assumptions
- bounded authority for saved schedules and automations
- hard cost and runaway controls for autonomous and scheduled paths

---

## Problem Statement

GuardianAgent's current model is strongest at the moment when an action is about to happen:

- `InputSanitizer` blocks some prompt injection at message ingress.
- `GuardianAgentService` can deny risky tool actions before execution.
- `OutputGuardian` redacts secrets and flags suspicious tool-result content.

The weakness is what happens between those controls.

Suspicious remote content is still usually:

- sanitized
- labeled with warnings
- passed back into the planner model
- eligible to influence downstream tool selection
- sometimes eligible to be written into memory or reused later

That means the system has strong **action-time blocking**, but incomplete **context-time containment**.

This matters because the highest-value modern agent attacks are often:

- indirect prompt injection through fetched content
- memory poisoning and persistence
- tainted-content-driven mutation
- cascades across workflows or agent hops
- runaway scheduled or autonomous execution after compromise or drift
- false success claims after partially completed or failed actions

---

## Current State Assessment

### What GuardianAgent Already Does Well

- `src/runtime/runtime.ts` enforces admission before `agent.onMessage()`.
- `src/supervisor/worker-manager.ts` and `src/broker/broker-server.ts` keep the built-in planner loop brokered and network-disabled.
- `src/guardian/guardian.ts` applies capability checks, secret/PII scanning, denied-path checks, shell validation, and SSRF controls.
- `src/runtime/sentinel.ts` runs inline action evaluation and retrospective anomaly review.
- `src/guardian/output-guardian.ts` sanitizes tool results before they re-enter model context.
- `src/policy/engine.ts` provides a real policy engine with shadow and enforce modes.

These are strong foundations and should remain the base architecture.

### Main Gaps

1. **Provenance exists, but policy does not really consume it yet.**
   `src/broker/provenance.ts` assigns `tainted` metadata, but taint-aware enforcement is not active by default.

2. **Remote-content scanning is mostly warn-and-sanitize, not quarantine-and-gate.**
   `src/guardian/output-guardian.ts` can detect injection-like tool output, but the current flow generally still forwards sanitized content to the model.

3. **Memory is persistence-friendly, not trust-aware.**
   `src/runtime/agent-memory-store.ts` is a simple append/search store without source trust labels, review state, TTLs, or poisoning controls.

4. **Policy defaults are still softer than they should be for contextual security.**
   Policy-as-code defaults to shadow mode, and there are not yet first-class rules for tainted-content-driven actions.

5. **Inter-agent and workflow cascades are only partially contained.**
   Dispatch depth controls exist, but there is no full taint propagation, event-hop budget, or live causal circuit breaker across all workflow surfaces.

6. **Success reporting is not generally verified.**
   High-impact tools can return outputs, but there is no universal "verify system state before claiming success" layer.

---

## Proposed Uplifts

### 1. Taint-Aware Quarantine for Remote Content

### Goal

Treat remote content as untrusted data that cannot directly drive privileged behavior.

### Why

GuardianAgent currently flags suspicious remote content, but flagged content still often reaches the main planner. Warnings are useful, but warnings alone do not create a hard boundary.

### Proposal

Upgrade tool-result handling from:

- sanitize
- annotate
- pass to planner

to a tiered model:

- `clean`: pass through after normal sanitization
- `tainted`: pass only through a constrained low-trust envelope
- `quarantined`: do not pass raw content to the planner at all

For `quarantined` content:

- block raw reinjection into the main planner context
- run a constrained extraction path that returns only factual fields
- strip imperative language and instruction-like content
- require approval before tainted remote content can trigger mutating actions

### Initial Policy Effects

- tainted content cannot directly drive mutating tool calls
- tainted content cannot be treated as user intent
- tainted content cannot be written to memory without sanitization and explicit policy allowance
- quarantined content cannot be forwarded raw to downstream agents

### Suggested Touch Points

- `src/guardian/output-guardian.ts`
- `src/index.ts`
- `src/worker/worker-llm-loop.ts`
- `src/broker/provenance.ts`
- `src/config/types.ts`
- `src/policy/engine.ts`

### Acceptance Criteria

- remote tool results receive `clean`, `tainted`, or `quarantined` classification
- quarantined content is not injected back into the main planner as raw text
- tainted-content-driven mutations are blocked or approval-gated by policy
- audit events clearly record when content was quarantined and why

---

### 2. Memory Poisoning Resistance

### Goal

Prevent untrusted or compromised content from becoming durable long-term memory.

### Why

Persistent memory increases usefulness, but it also creates a cross-turn attack surface. Right now memory is easy to append and easy to reload, which is good for utility and bad for poisoning resilience.

### Proposal

Replace the current flat memory model with trust-aware memory entries that carry:

- source type: `user`, `local_tool`, `remote_tool`, `system`, `operator`
- trust level: `trusted`, `untrusted`, `reviewed`
- provenance metadata: tool name, domain, timestamp, session
- status: `active`, `quarantined`, `expired`, `rejected`
- optional TTL and review requirements

Add write-time gates:

- remote-derived memory writes require sanitization
- tainted remote content cannot be stored as active memory by default
- high-risk categories require explicit approval or operator review

Add read-time gates:

- quarantined memory is excluded from normal planner context
- unreviewed remote memory is either omitted or injected in a clearly low-trust wrapper
- stale memory can expire automatically or require refresh
- sensitive memory classes can have tighter retention and recall rules by workspace or user class

### Suggested Touch Points

- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`
- `src/util/memory-intent.ts`
- `src/broker/provenance.ts`
- `src/config/types.ts`

### Acceptance Criteria

- each memory entry has source, trust, and status metadata
- remote-derived memory is not treated the same as direct user-authored memory
- quarantined memory cannot silently re-enter planner context
- memory audit trails show who or what created each entry and why it was admitted

---

### 3. Contextual Policy Enforcement

### Goal

Make context trust and provenance first-class policy inputs.

### Why

GuardianAgent already has a policy engine. The gap is that its highest-value contextual decisions are still mostly outside the policy surface.

### Proposal

Extend policy inputs to include:

- acting principal and role
- provenance source and trust
- taint state
- whether content originated remotely
- whether a planned mutation is derived from tainted content
- whether a memory write is derived from tainted or remote content
- whether a downstream dispatch includes quarantined material
- whether the action originated from a saved schedule or automation
- schedule approval age, scope hash, and drift status
- budget and spend state for the current chain, schedule, user, and provider

Add initial rule families or rule patterns for:

- tainted-content-driven mutation
- tainted memory writes
- quarantined event payload dispatch
- low-trust remote content being escalated into high-power actions
- role-scoped approval authority for tainted or high-impact actions
- schedule re-approval after meaningful scope change or approval expiry
- fail-closed budget enforcement for autonomous and scheduled execution

Recommended rollout:

- Phase 1: shadow mode with audit-only mismatches
- Phase 2: enforce for remote mutation and memory-write paths
- Phase 3: enforce for workflow and dispatch propagation

### Suggested Touch Points

- `src/policy/engine.ts`
- `src/policy/types.ts`
- `src/policy/compiler.ts`
- `policies/base/tools.json`
- `src/tools/executor.ts`

### Acceptance Criteria

- policy evaluation can inspect principal, role, schedule metadata, and budget state
- policy evaluation can inspect taint/provenance fields
- base policies can approval-gate or deny tainted-content-driven actions
- saved schedules can lose authority when scope drifts or approval expires
- shadow mismatches are measurable before full enforcement
- contextual decisions become auditable and version-controlled

---

### 4. Cascade Breakers for Inter-Agent and Workflow Chains

### Goal

Stop local failures from becoming system-wide cascades.

### Why

The article's framework emphasizes how attacks propagate across components. GuardianAgent already has some depth and budget controls, but it still needs stronger live containment for cross-step and inter-agent amplification.

### Proposal

Add causal security controls:

- event hop count and per-chain TTL
- causal IDs across request -> agent -> tool -> approval -> downstream dispatch
- per-chain mutation budgets
- per-user, per-agent, per-provider, and per-schedule spend caps
- taint propagation through event payloads and workflow state
- live circuit breakers when a chain exceeds risk thresholds

Trigger conditions can include:

- too many hops in a single causal chain
- repeated denied actions in one chain
- repeated tainted-content reuse
- repeated approval requests caused by the same tainted source
- excessive memory or storage writes in a single chain
- repeated schedule failures or denials
- repeated budget overruns or unusual token acceleration

Saved schedules and automations should behave like bounded execution contracts, not indefinite standing permission. That means:

- approval expiry windows
- automatic re-approval after meaningful scope changes
- separate policy for autonomous schedules vs attended schedules
- operator-visible provenance for why a schedule is still authorized

### Suggested Touch Points

- `src/runtime/runtime.ts`
- `src/queue/event-bus.ts`
- `src/runtime/shared-state.ts`
- `src/agent/orchestration.ts`
- `src/runtime/sentinel.ts`

### Acceptance Criteria

- each workflow chain has a causal ID and hop count
- event chains can be blocked or paused when thresholds are exceeded
- tainted content cannot silently spread through events or shared state
- schedules auto-pause after repeated failures, denials, or budget-cap violations
- Sentinel can see and summarize cascades by causal chain, not just by individual event type

---

### 5. Postcondition Verification for High-Impact Actions

### Goal

Do not claim success until the system has evidence the action actually succeeded.

### Why

Security is not only about blocking bad actions. It is also about preventing false assurances after incomplete, partial, or spoofed outcomes.

### Proposal

Add optional verification hooks to mutating tools and other high-impact operations.

Examples:

- filesystem mutation verifies path existence, file size, or hash
- email send verifies provider-confirmed draft ID or message ID
- cloud changes verify the resource now exists in the expected state
- policy changes verify persistence and the active runtime snapshot

Response rules:

- the assistant may say "completed" only if the tool returns a success artifact or verifier success
- otherwise the assistant must say "attempted" or "pending verification"

### Suggested Touch Points

- `src/tools/executor.ts`
- `src/tools/types.ts`
- `src/index.ts`
- `src/worker/worker-llm-loop.ts`

### Acceptance Criteria

- high-impact tools can declare a verifier
- verified and unverified completions are distinct in job records and audit events
- user-facing success language is grounded in real verification state

---

## Proposed Rollout

### Phase 1: Taint Foundations

- extend provenance metadata into a real trust model
- add `clean` / `tainted` / `quarantined` classification for remote tool results
- emit audit events for quarantine decisions
- run policy in shadow mode for tainted-content-driven mutations

### Phase 2: Memory Hardening

- introduce structured memory entry metadata
- gate remote-derived memory writes
- exclude quarantined memory from normal planner context
- add review and TTL support

### Phase 3: Contextual Policy Enforcement

- add taint-aware policy inputs and base rules
- move selected taint policies from shadow to enforce
- approval-gate tainted-content-driven mutations by default

### Phase 4: Cascade Containment

- add causal IDs, hop counts, and chain budgets
- propagate taint through events and workflow state
- add live circuit breakers for chain-level abuse

### Phase 5: Verification and UX Grounding

- add verifier hooks to high-impact tools
- surface verified vs unverified completion in jobs, audit, and UI
- tighten final response wording rules around completion claims

---

## Success Criteria

- suspicious remote content no longer flows raw from fetch -> planner -> mutation by default
- poisoned or remote-derived memory cannot silently become trusted persistent context
- policy rules can explicitly govern taint-driven actions and memory writes
- inter-agent and workflow cascades can be detected and stopped in-band
- high-impact actions are verified before the assistant reports them as complete

---

## Non-Goals

- replacing the brokered worker architecture
- replacing the existing Guardian admission pipeline
- eliminating all use of remote content in planner context
- introducing heavy always-on semantic classifiers as a mandatory runtime dependency

This proposal is about tightening the existing architecture, not discarding it.

---

## Recommended Priority Order

1. Taint-aware quarantine for remote content
2. Memory poisoning resistance
3. Contextual policy enforcement
4. Cascade breakers
5. Postcondition verification

This order addresses the highest-leverage risk first: tainted context steering privileged behavior.

---

## Initial File Targets

- `src/guardian/output-guardian.ts`
- `src/broker/provenance.ts`
- `src/runtime/agent-memory-store.ts`
- `src/policy/engine.ts`
- `src/tools/executor.ts`
- `src/runtime/runtime.ts`
- `src/queue/event-bus.ts`
- `src/worker/worker-llm-loop.ts`
- `src/index.ts`
- `policies/base/tools.json`
