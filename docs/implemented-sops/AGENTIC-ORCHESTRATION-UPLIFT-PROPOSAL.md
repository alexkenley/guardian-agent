# Agentic Orchestration Uplift Proposal

**Status:** Implemented
**Date:** 2026-03-16
**Informed by:**
- `docs/research/OPEN-SOURCE-AGENTIC-ORCHESTRATION-LANDSCAPE-2026-03-16.md`
- `docs/research/GUARDIAN-OPEN-SOURCE-ORCHESTRATION-ADOPTION-MAP-2026-03-16.md`
- GuardianAgent automation, orchestration, scheduling, and control-plane runtime
- Local analysis of:
  - `/mnt/s/Development/agentic-orchestration-repos/langgraphjs`
  - `/mnt/s/Development/agentic-orchestration-repos/openai-agents-js`
  - `/mnt/s/Development/agentic-orchestration-repos/mastra`
  - `/mnt/s/Development/agentic-orchestration-repos/temporal`
  - `/mnt/s/Development/agentic-orchestration-repos/pydantic-ai`

---

## Executive Summary

GuardianAgent already has the right security foundation for serious agentic orchestration:

- approval-gated mutations
- policy-enforced tool execution
- contextual-security controls
- brokered worker isolation
- scheduled tasks and workflows
- compiler-first conversational automation creation

The main remaining gap is not basic safety. It is **runtime maturity**.

Today, Guardian can:
- compile native automations from chat
- validate execution readiness before save
- run workflows, scheduled tasks, and assistant automations
- trace requests at a useful high level

Today, Guardian is weaker at:
- representing automations as a typed intermediate form instead of heuristic direct compilation
- running deterministic workflows as a first-class checkpointed graph runtime
- treating approvals, interrupts, and resumptions as unified orchestration events
- modeling multi-agent handoffs as explicit contracts
- tracing orchestration runs across save, schedule, approval, handoff, resume, and verification
- hardening long-running automations with replay-safe run semantics

This uplift was implemented in six linked parts:

1. Replace heuristic automation authoring with a typed `AutomationIR` and repair loop.
2. Introduce a first-class graph runtime for deterministic workflows.
3. Formalize approvals, interrupts, and resumptions as runtime events.
4. Add typed handoffs and richer orchestration traces.
5. Harden scheduled/background execution with durability and active-run protection.
6. Validate the authoring/runtime stack through fake-provider and real WSL Ollama brokered harness lanes.

This is a **selective adoption** proposal. Guardian should borrow orchestration ideas from strong open-source systems, but it should keep its own security and control plane authoritative.

---

## Problem Statement

Guardian's current orchestration model is strong enough to create and run automations, but it still relies on a mixed architecture:

- semantic interpretation is partly handled by heuristics in automation authoring
- deterministic workflows are still closer to stored step arrays than a graph runtime
- scheduled assistant tasks are powerful, but not yet grounded in a unified run-state model
- traces explain requests, but not full orchestration lifecycles
- delegation is possible, but not yet formalized as bounded handoffs

This creates practical failure modes:

- prompt-family edge cases need new compiler heuristics instead of flowing through a typed authoring contract
- workflows are harder to pause, resume, branch, and inspect consistently
- approvals are strong, but are not yet normal runtime state transitions
- run history is useful, but not rich enough for true orchestration debugging
- long-running automations need stronger replay, retry, and compensation discipline

The solution is not to replace Guardian with another framework. The solution is to evolve Guardian toward a more mature orchestration runtime while preserving its existing trust and policy model.

---

## Architectural Position

Guardian should keep these native and authoritative:

- `src/tools/executor.ts`
- policy and approval enforcement
- contextual trust and taint controls
- brokered worker isolation
- bounded schedule authority
- postcondition verification

Guardian should selectively borrow:

- from `langgraphjs`
  - graph execution primitives
  - checkpoints
  - interrupts/resume
  - run identity separation

- from `openai-agents-js`
  - handoff contracts
  - guardrail staging semantics
  - orchestration tracing concepts
  - session/run distinction

- from `mastra`
  - explicit `agent | workflow | tool` primitive separation
  - suspend/resume product model
  - built-in eval mindset
  - validation-aware primitive routing

- from `temporal`
  - durable execution mindset
  - replay-safe workflows
  - idempotency and activity/workflow separation

- from `pydantic-ai`
  - typed model-authored IR
  - validation and repair loops
  - contract-first testing discipline

---

## Target Architecture

### End State

The intended flow is:

`user request`
`-> intent pre-router`
`-> model-authored AutomationIR`
`-> deterministic IR validator`
`-> repair loop if invalid`
`-> compile to task/workflow/graph`
`-> approval/policy gate`
`-> checkpointed runtime execution`
`-> orchestration trace/evals`

### Core Runtime Layers

1. **Intent Pre-Router**
   - authoritative first decision point for all inbound requests
   - decides between:
     - automation authoring
     - direct bounded action
     - generic agent loop

2. **Automation IR Layer**
   - typed representation of proposed automations
   - replaces direct heuristic emission of `task_create` and `workflow_upsert`

3. **Validation + Repair Layer**
   - deterministic readiness, schema, and policy preflight
   - structured blockers and warnings
   - optional repair iteration instead of ad hoc heuristic expansion

4. **Graph Runtime**
   - node/edge execution for deterministic workflows
   - checkpointing after node transitions
   - native interrupt/resume support

5. **Orchestration Event Layer**
   - approvals
   - interrupts
   - resumes
   - handoffs
   - verification
   - all represented as normal run-state transitions

6. **Trace + Eval Layer**
   - orchestration spans across compilation, validation, save, run, approval, handoff, resume, and verification
   - prompt-family regressions and real-model harnesses

---

## Proposed Uplifts

### 1. Typed Automation IR

### Goal

Move semantic automation authoring out of prompt-family heuristics and into a typed authoring contract.

### Proposal

Add:
- `src/runtime/automation-ir.ts`
- `src/runtime/automation-ir-validator.ts`
- `src/runtime/automation-ir-repair.ts`

Define a typed `AutomationIR` that captures:
- primitive type: `agent | workflow | tool`
- schedule intent
- required inputs and outputs
- expected tool categories
- high-impact mutations
- negative constraints such as `no_scripts`, `built_in_tools_only`
- user-facing description
- runtime prompt or graph body

### Behavior

- The authoring layer should first emit `AutomationIR`, not `task_create` or `workflow_upsert`.
- The IR validator should check:
  - schema validity
  - missing required fields
  - readiness blockers
  - policy conflicts
  - contradictions between requested primitive and generated content
- If invalid, Guardian should attempt a bounded repair loop rather than relying on more heuristics.
- Only validated IR should compile into control-plane mutations.

### Why

This keeps:
- semantic flexibility with the model
- safety/readiness enforcement in code

It also reduces the need to keep encoding edge cases as one-off compiler regexes.

### Initial Files

- `src/runtime/automation-prerouter.ts`
- `src/runtime/automation-authoring.ts`
- `src/runtime/automation-validation.ts`

---

### 2. First-Class Graph Runtime

### Goal

Evolve deterministic workflows from stored step arrays into a checkpointed graph runtime.

### Proposal

Add:
- `src/runtime/graph-types.ts`
- `src/runtime/graph-runner.ts`
- `src/runtime/graph-checkpoints.ts`
- `src/runtime/run-state-store.ts`

Graph node types should include:
- tool
- instruction/model transform
- branch
- parallel fan-out
- join
- approval interrupt
- resume
- finalize

### Behavior

- `workflow_upsert` should compile deterministic workflows into a graph representation.
- Graph execution should persist run state after each node.
- Approvals should suspend the run at a node instead of existing only as tool-side pauses.
- Resume should target a run/checkpoint id, not only the chat session.

### Why

This is the cleanest way to get:
- better pause/resume semantics
- richer run inspection
- reusable subgraphs later
- more reliable long-running deterministic automation

### Initial Files

- `src/runtime/workflows.ts`
- `src/runtime/scheduled-tasks.ts`

---

### 3. Unified Run Events For Approval, Interrupt, And Resume

### Goal

Make orchestration pauses and resumes explicit runtime behavior rather than a mix of executor-side and session-side mechanisms.

### Proposal

Add:
- `src/runtime/run-events.ts`
- `src/runtime/approval-interrupts.ts`

Run events should cover:
- approval requested
- approval granted
- approval denied
- runtime interrupted
- runtime resumed
- verification pending
- verification completed
- handoff started
- handoff completed

### Behavior

- `task_create`, `workflow_upsert`, scheduled assistant tasks, and future handoffs should all use the same run-event vocabulary.
- Brokered worker resume should bind to run state, not only message history snapshots.
- The UI and API should be able to show current run state from event history.

### Why

Guardian already has the controls. This uplift makes those controls first-class orchestration primitives.

### Initial Files

- `src/tools/executor.ts`
- `src/runtime/scheduled-tasks.ts`
- `src/supervisor/worker-manager.ts`
- `src/worker/worker-session.ts`

---

### 4. Typed Handoffs And Orchestration Tracing

### Goal

Make multi-agent orchestration explicit, bounded, and debuggable.

### Proposal

Add:
- `src/runtime/handoffs.ts`
- `src/runtime/handoff-policy.ts`
- `src/runtime/orchestration-tracing.ts`

Define handoff contracts with:
- source agent
- target agent
- allowed capability set
- context/message filter
- provenance and taint propagation
- approval requirements
- bounded authority

Extend tracing with span types for:
- compile
- validate
- repair
- save
- graph node execute
- approval interrupt
- resume
- handoff
- verification

### Behavior

- Handoffs should no longer be implicit prompt behavior.
- All handoffs should be auditable and traceable.
- Request traces in `src/runtime/orchestrator.ts` should evolve into orchestration traces with `runId`, `groupId`, `parentRunId`, and stable node spans.

### Why

Without this, multi-agent orchestration remains harder to reason about than it should be.

### Initial Files

- `src/runtime/orchestrator.ts`
- `src/supervisor/worker-manager.ts`

---

### 5. Durability And Replay Discipline For Scheduled Automation

### Goal

Harden background automations against retries, resumptions, duplicate side effects, and partial failures.

### Proposal

Upgrade scheduled/background execution with:
- idempotency keys per run and per activity
- explicit retry metadata
- replay-safe state transitions
- activity vs orchestration separation
- compensation guidance for partially applied mutations

### Behavior

- scheduled assistant and workflow runs should persist enough run metadata to avoid duplicate side effects on retry
- suspended or resumed runs should not silently rerun already-confirmed side effects
- repeated failures should preserve enough context for repair, not only for audit

### Why

Guardian now supports more serious automations. That means durable execution needs to move closer to a first-class concern.

### Initial Files

- `src/runtime/scheduled-tasks.ts`
- `src/runtime/orchestrator.ts`
- queue and task persistence paths

---

### 6. Evals And Harnesses As A Core Orchestration Surface

### Goal

Stop improving orchestration only by ad hoc observation.

### Proposal

Expand the current harness and eval model so orchestration improvements are regression-tested across:
- compiler prompt families
- negative constraints
- readiness blockers
- approval interrupts
- resume flows
- handoffs
- scheduled execution
- brokered worker path
- local real-model path

### Required Coverage

- fake deterministic harness lane
- WSL-local Ollama lane
- brokered worker lane
- prompt-family regression suite for native automations
- trace assertions for orchestration spans
- replay/idempotency scenarios

### Why

This is how Guardian avoids turning orchestration behavior into folklore and prompt cargo cult.

### Initial Files

- `scripts/test-automation-authoring-compiler.mjs`
- new orchestration harness scripts
- runtime/orchestration tests

---

## Implementation Plan

### Phase 1: Automation IR And Repair Loop

Deliver:
- `AutomationIR`
- schema validator
- repair loop
- compiler output refactor
- regression suite for failed prompt families

Exit criteria:
- native automation requests are model-authored into valid IR before save
- edge cases are fixed through IR schema/repair logic rather than only new heuristics

### Phase 2: Graph Runtime Core

Deliver:
- graph representation for workflows
- checkpoint store
- graph runner
- run-state inspection

Exit criteria:
- deterministic workflows can pause/resume cleanly
- workflow runs are represented as graph executions, not only step lists

### Phase 3: Unified Run Events

Deliver:
- approval interrupts as runtime events
- resume by run/checkpoint id
- event-backed run state

Exit criteria:
- approvals, interrupts, and resumptions share one orchestration model

### Phase 4: Handoffs And Trace Uplift

Deliver:
- typed handoff contracts
- orchestration spans
- parent/child run relationships

Exit criteria:
- multi-agent delegation is explicit and auditable

### Phase 5: Durability And Replay Safety

Deliver:
- idempotency keys
- retry metadata
- replay-safe side-effect handling

Exit criteria:
- background automations are safer under retry and resume

### Phase 6: Eval Expansion

Deliver:
- real-model orchestration harnesses
- trace-grade assertions
- negative-constraint regression suite

Exit criteria:
- orchestration behavior improves through measured regressions, not guesswork

---

## File-Level Impact

### New Files

- `src/runtime/automation-ir.ts`
- `src/runtime/automation-ir-validator.ts`
- `src/runtime/automation-ir-repair.ts`
- `src/runtime/graph-types.ts`
- `src/runtime/graph-runner.ts`
- `src/runtime/graph-checkpoints.ts`
- `src/runtime/run-state-store.ts`
- `src/runtime/run-events.ts`
- `src/runtime/approval-interrupts.ts`
- `src/runtime/handoffs.ts`
- `src/runtime/handoff-policy.ts`
- `src/runtime/orchestration-tracing.ts`

### Major Refactors

- `src/runtime/automation-prerouter.ts`
- `src/runtime/automation-authoring.ts`
- `src/runtime/automation-validation.ts`
- `src/runtime/workflows.ts`
- `src/runtime/scheduled-tasks.ts`
- `src/runtime/orchestrator.ts`
- `src/tools/executor.ts`
- `src/supervisor/worker-manager.ts`
- `src/worker/worker-session.ts`

### Supporting Docs To Update During Implementation

- `README.md`
- `SECURITY.md`
- `docs/architecture/OVERVIEW.md`
- `docs/architecture/AUTOMATION-AUTHORING-COMPILER.md`
- `docs/specs/AUTOMATION-FRAMEWORK-SPEC.md`
- `docs/specs/ORCHESTRATION-SPEC.md`
- `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`
- `docs/guides/INTEGRATION-TEST-HARNESS.md`

---

## Non-Goals

This proposal does not recommend:
- replacing Guardian with LangGraphJS, Mastra, or OpenAI Agents SDK
- weakening Guardian's approval or policy controls
- moving contextual-security decisions out of code and into model discretion
- introducing Temporal's full infrastructure footprint at this stage

---

## Acceptance Criteria

The uplift is successful when:

1. Conversational automation creation flows through typed IR before save.
2. Deterministic workflows run on a checkpointed graph runtime.
3. Approval and resume are represented as normal orchestration events.
4. Multi-agent delegation uses explicit handoff contracts.
5. Orchestration traces explain full run lifecycles, not only request execution.
6. Scheduled/background runs are safer under retry, pause, and resume.
7. The harness can regress these behaviors on both fake and real local-model lanes.

---

## Recommended Next Step

The first implementation spec should be:

- `AutomationIR`
- validator
- repair loop

That is the best first move because it improves authoring quality immediately without forcing a graph-runtime rewrite on day one.
