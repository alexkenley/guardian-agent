# Multi-Agent Team Orchestration Plan

**Status:** Draft
**Date:** 2026-04-17
**Source Research:** [multica-research/](/mnt/s/Development/GuardianAgent/multica-research)
**Primary references:** [SECURITY.md](SECURITY.md), [Orchestration Specification](../design/ORCHESTRATION-DESIGN.md), [Brokered Agent Isolation Spec](../design/BROKERED-AGENT-ISOLATION-DESIGN.md), [Second Brain As-Built Specification](../design/SECOND-BRAIN-AS-BUILT.md), [Agent Platform Uplift Implementation Plan](./AGENT-PLATFORM-UPLIFT-IMPLEMENTATION-PLAN.md)

## Executive Summary

Guardian should present one primary assistant across web, CLI, and Telegram. That assistant is the user-facing coordinator and team lead, but it should not delegate every request by default.

The correct target model is:

- keep the main Guardian assistant as the front door and summarizer
- keep the Intent Gateway as the top-level route selector
- perform delegation inside the shared orchestration and assistant-job system after routing, not by creating a second parallel orchestration stack
- use a small core role library instead of a large starter pack of overlapping named specialists
- keep `Second Brain` as Guardian's bounded executive-assistant and personal-context lane, not as a competing generic manager

This plan therefore favors shared runtime integration over new bespoke stores, bespoke event wakeups, or many persistent specialist personas.

Phase 1 of this plan depends on the routing and delegated-execution convergence now targeted by [DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md](./DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md), because delegated specialist work must bind to shared execution identity, graph state, artifacts, and blocker state rather than transcript heuristics or ad hoc recovery flows.

## 1. Interaction Model: One Lead, Bounded Specialists

### 1.1 Main Guardian as coordinator

- The primary Guardian assistant in web UI, chat CLI, and Telegram remains the single entry point and user-facing team lead.
- The coordinator should handle simple or already-direct-routed requests itself when delegation would add latency or complexity.
- Delegation should be used when it creates clear leverage:
  - parallel research or retrieval
  - fresh-context verification or review
  - bounded implementation work
  - long-running background work that should not keep the foreground turn open

### 1.2 Keep the Intent Gateway gateway-first

- The Intent Gateway should remain responsible for top-level turn interpretation and route selection.
- Do **not** turn the gateway into an internal delegation planner by adding a `delegate_task` route or operation.
- After the gateway selects the route, the shared orchestration layer may decide whether that route is best handled:
  - directly
  - with in-invocation agent composition
  - with delegated background work

This keeps Guardian aligned with the current architecture, where the gateway decides *what kind of request this is*, while orchestration decides *how to execute it safely*.

### 1.3 Reuse shared runtime ledgers before creating new stores

- Do not introduce a new `AgentTaskStore` by default.
- Guardian already has shared request orchestration, assistant-job ledgers, delegated run classes, bounded handoff objects, traces, and held-result controls.
- If durable specialist state is needed, extend the existing shared ledgers and assistant-job metadata first so:
  - approvals remain bound to the shared `PendingActionStore`
  - traces stay unified
  - continuity remains shared across surfaces
  - operator views do not have to merge multiple competing task systems

### 1.4 Concurrency and responsiveness

- `workerMaxConcurrent` should continue to represent the brokered execution ceiling for delegated work.
- Per-session foreground turns remain serialized by the shared assistant orchestrator, which is desirable for correctness.
- To keep the main assistant responsive, long-running work should be converted into delegated runs with bounded follow-up policy rather than keeping the foreground turn occupied.
- When compute slots are full, delegated work should stay queued in shared assistant-job state and the UI should surface "Waiting for compute resources" from that shared state rather than from a separate queue subsystem.
- When multiple suitable provider profiles are configured, the coordinator may assign different child tasks to different providers concurrently, but that choice must stay server-owned and deterministic.

### 1.5 Asynchronous handoff model

- Do not depend on raw `task:completed` event wakeups or system-prompt reinjection into the lead agent's active chat.
- Completion handoff should stay server-owned and structured, using the existing delegated handoff shape:
  - summary
  - artifacts or changed resources
  - blockers encountered
  - approvals encountered
  - suggested next action
- Completion reporting should continue to use the shared reporting policy:
  - `inline_response`
  - `held_for_approval`
  - `status_only`
  - operator-held review

This is safer and more accurate than treating specialist output as ad hoc system text.

### 1.6 Targeting and mentions

- Optional user-facing `@mentions` can be added later as an operator affordance for explicit targeting.
- `@mentions` must never bypass the Intent Gateway, approval flow, or shared orchestration model.
- Agent-to-agent dispatch should remain structured through handoff contracts and runtime-owned metadata, not natural-language mentions between workers.

## 2. Security and Isolation

### 2.1 Brokered isolation remains the foundation

- Delegated specialist execution should use the same brokered worker isolation model as the built-in chat/planner path.
- Supervisor-side code remains the trusted control plane for:
  - approvals
  - tool execution
  - audit
  - memory
  - routing and follow-up policy
- The plan must not claim stronger guarantees than the current as-built runtime provides. In particular, fine-grained broker token narrowing is not yet the broker's source of truth for every capability decision; supervisor/runtime enforcement remains authoritative.

### 2.2 Capability narrowing must be runtime-owned

- Specialist roles should map to frozen per-agent capability sets and trust presets.
- Authorization must come from runtime capability checks and tool policy, not from prompt text or role description alone.
- Role prompts or SOUL fragments may shape behavior, but they must never be treated as the thing that enforces authority.

### 2.3 Approval and pending-action rules stay shared

- All non-read-only actions remain subject to the shared approval and pending-action model.
- Approvals stay principal-bound and origin-surface aware.
- Delegated work may surface different follow-up modes for different blocker types, but it must not invent a second approval system or cross-surface approval shortcut.

### 2.4 Trust-aware output, memory, and delegation

- Specialist outputs, tool results, and remote content remain untrusted until they pass through `OutputGuardian` and trust classification.
- Quarantined or low-trust output must not:
  - re-enter planning as raw instruction text
  - directly drive non-read-only actions
  - become active durable memory by default
- This is especially important where delegation interacts with provider-backed or remote-derived `Second Brain` material.

### 2.5 Out-of-scope designs for the first implementation

The first implementation should explicitly avoid:

- a second orchestration queue that duplicates assistant jobs
- raw system-prompt reinjection from specialist completion
- natural-language agent-to-agent control via `@mentions`
- role proliferation that widens authority without materially different contracts
- turning `Second Brain` into a generic unrestricted worker bus

## 3. Core Role Library, Not a Large Starter Pack

Guardian should not start with a broad "specialist starter pack" of many overlapping personas. The better initial shape is a small core role library with optional domain lenses.

### 3.1 Recommended core roles

| Role | Primary responsibility | Typical posture |
| :--- | :--- | :--- |
| **Coordinator** | user communication, decomposition, progress reporting, final synthesis | balanced, delegation-aware, minimal direct mutation |
| **Explorer** | retrieval, documentation lookup, repo or provider inspection, evidence gathering | read-heavy, bounded network when allowed |
| **Implementer** | bounded execution work, edits, tool use, follow-through on a defined task slice | scoped write and exec only where needed |
| **Verifier** | fresh-context review, testing, security checks, policy validation, acceptance judgment | read-heavy plus targeted validation tools |

### 3.2 Domain lenses should stay lightweight

Domain specialization should usually be implemented as a role lens or capability pack on top of the core roles, not as a permanently distinct worker.

Examples:

- frontend lens
- security lens
- research lens
- provider-admin lens
- coding-workspace lens

This keeps overlap low while still allowing Guardian to specialize when context, tools, or output contracts differ.

### 3.3 Security sentinel as a verifier mode

`Security Sentinel` is valuable, but it is usually best modeled as a security-focused verifier mode rather than as a fifth always-on worker with broad standing autonomy.

## 4. Second Brain Integration

`Second Brain` should not become a second team lead. It already has a clearer role in the product:

- bounded personal-assistant capability lane
- shared personal context and retrieval layer
- bounded routine execution and proactive delivery
- default user-facing proactive delivery through Telegram, with web and CLI as operator surfaces

### 4.1 Relationship to the main coordinator

- The main Guardian assistant remains the top-level coordinator across surfaces.
- When the Intent Gateway classifies work as `personal_assistant_task`, the coordinator should lean on the existing `Second Brain` route and services instead of delegating that work to a generic specialist team by default.
- For simple reads and CRUD in `Second Brain`, preserve the existing direct deterministic handling where it already exists.

### 4.2 Executive-assistant behavior

- If the desired product feel is "Guardian as executive assistant," `Second Brain` is the bounded subsystem that should own most of that behavior.
- The coordinator can still be the conversational face of that executive-assistant behavior, but the underlying memory, routines, and proactive delivery should remain in the shared `Second Brain` plane.
- This means the coordinator and the executive assistant are complementary roles, not competing ones:
  - coordinator = front door, delegation, synthesis, cross-capability control
  - `Second Brain` = bounded personal context, routines, briefs, proactive assistant outcomes

### 4.3 Proactive delivery rules

- Proactive `Second Brain` outcomes should continue to reuse shared runtime delivery.
- Notifications should carry bounded summaries and artifact references, not raw worker transcripts.
- `Second Brain` should remain capability-bounded and should not turn into a free-form automation or agent platform.

## 5. UI and UX

### 5.1 Team panel first, private mini-chats later if needed

- A Team panel is useful if it reflects shared runtime truth:
  - active delegated runs
  - queued work
  - held results
  - blockers
  - approvals
  - compute saturation
- The first drill-down should be job, trace, and handoff detail, not private worker chats by default.

### 5.2 Avoid fragmenting continuity too early

- Private specialist lanes add complexity around continuity, approvals, pending actions, and workspace identity.
- They should be treated as a later, optional operator feature only if the shared continuity and blocked-work model can represent them cleanly.
- The first implementation should favor:
  - one main conversation
  - shared background progress HUD
  - bounded worker detail views

### 5.3 Composite identities only when truly needed

- If specialist private lanes are eventually added, composite conversation keys are the right general direction.
- They should be introduced only after the shared job, continuity, and approval models are proven to work cleanly for delegated runs.

## 6. Implementation Phasing

1. **Phase 1: Shared runtime integration**
   Extend delegated run metadata, role descriptors, child execution-profile selection, and bounded handoff contracts in the existing assistant-job, trace, and reporting surfaces. Do not create a parallel queueing subsystem.
2. **Phase 2: Core role library**
   Land `Coordinator`, `Explorer`, `Implementer`, and `Verifier` with frozen capability mappings and lightweight domain lenses.
3. **Phase 3: Operator visibility**
   Add Team panel and Background Progress UI driven from shared assistant-job, trace, held-result, and pending-action state.
4. **Phase 4: Explicit targeting**
   Add optional operator-facing `@mentions` or explicit specialist targeting only if it resolves through shared routing and does not bypass approvals or continuity.
5. **Phase 5: Advanced specialist lanes**
   Consider private specialist lanes only after the shared continuity, approval, and workspace identity model has proven sufficient.

## 7. Acceptance Criteria

- The main Guardian assistant remains the single front door across web, CLI, and Telegram.
- Delegation improves latency, verification quality, or long-running responsiveness rather than adding ceremony to simple turns.
- Shared runtime ledgers remain the canonical truth for delegated state, approvals, traces, and follow-up.
- Explicit provider overrides stay sticky through delegated handoff, while auto-selected child work can specialize onto different configured providers by role and workload.
- Specialist roles differ because of capability, context, or output contract, not because of prompt-only branding.
- `Second Brain` remains the bounded executive-assistant and personal-context lane instead of becoming a competing orchestration manager.
- No new delegation behavior bypasses the security guarantees in `SECURITY.md`.
