# Multi-Agent Workflow Hardening Design

**Status:** Implemented current architecture
**Date:** 2026-03-10

This specification formalizes the implementation of [MULTI-AGENT-WORKFLOW-HARDENING-PROPOSAL.md](../../implemented/MULTI-AGENT-WORKFLOW-HARDENING-PROPOSAL.md).

## Overview

GuardianAgent is hardening its multi-agent layer by introducing typed orchestration contracts, strict tool schema validation, dispatch lineage tracking, causal workflow tracing, and conflict-aware parallel tool execution.

This hardening assumes top-level user-turn interpretation has already happened before orchestration begins. Corrections, clarification answers, and route selection are resolved by the main `IntentGateway` path; multi-agent dispatch consumes that structured interpretation rather than re-deciding user intent ad hoc inside downstream agents.

Related execution-state contract:
- `docs/design/EXECUTION-STATE-DESIGN.md`

## Current As-Built Delegation Contract

Guardian's current multi-agent / delegated-worker path is hardened around these rules:

- top-level user intent is decided once by the `IntentGateway`
- the originating request should carry durable execution identity before or during delegation
- delegated workers preserve lineage back to the originating assistant run, continuity key, and execution lineage where available
- delegated workers may publish structured orchestration role identity such as coordinator, explorer, implementer, or verifier
- the coordinator resolves an effective delegated workload contract from the routed intent plus the orchestration role, so retry/evidence policy can still apply even when the live child handoff is missing some pre-routed metadata
- exact repo-grounded delegated inspections are subject to a server-owned sufficiency gate, so a child answer that only reports truncation or uncertainty can be retried once on a stronger eligible profile or failed instead of being treated as a successful completion
- delegated child runs that stop at a progress-only reply are also eligible for one stronger retry instead of being accepted as terminal work
- operator-facing follow-up is normalized server-side into bounded reporting modes instead of forcing channels to parse arbitrary worker prose

Current server-owned delegated follow-up modes:
- `inline_response`
- `held_for_approval`
- `status_only`
- operator-held review for long-running or automation-owned delegated runs

Current as-built limitation:
- delegated completion still normalizes around worker `content` plus bounded handoff metadata
- the current sufficiency gate improves reliability, but it does not eliminate upstream tool-result truncation or guarantee that the first delegated worker chose the strongest search strategy
- the stronger typed return contract split into channels such as `userSummary`, `evidence`, `progressEvents`, and `nextAction` remains follow-on work

## Phases

### Phase 1: Boundary Hardening (Completed)

**Priority: P0**

*   [x] **Strict Tool Schema Validation:** Replaced manual type checks with full JSON Schema validation using `Ajv` in `ToolExecutor`. This enforces nested schemas, enums, and rejects invalid arguments before approval or execution.
*   [x] **Dispatch Lineage & Depth Tracking:** Introduced `DispatchLineage` interface. Threaded lineage through `AgentContext` and `Runtime.dispatchMessage`.
*   [x] **Cycle Detection:** Added hard limits: `maxDispatchDepth = 5` and `maxRepeatedAgentInPath = 2`. Violations are blocked and logged as `critical` audit events.

### Phase 2: Orchestration Contracts (Completed)

**Priority: P1**

*   [x] Extend `OrchestrationStep` to support `inputContract` and `outputContract`.
*   [x] Implement `SharedState` storage limits (`maxStateBytes`) and per-key metadata.
*   [x] Validate inputs and outputs against contracts using `Ajv` during `SequentialAgent`, `ParallelAgent`, and `LoopAgent` execution.
*   [x] Support both `warn` and `enforce` modes for validation.

### Phase 3: Trace and Eval Completion (Completed)

**Priority: P1**

*   [x] Add `WorkflowTraceNode` to capture causal graphs of requests, agent dispatches, tool calls, and approvals.
*   [x] Record actual executed tool calls during a request.
*   [x] Update `EvalActualResponse` in the eval framework to populate `toolCalls` from real execution data instead of an empty array.

### Phase 4: Conflict-Aware Parallelism (Completed)

**Priority: P2**

*   [x] Partition tool calls into execution groups (read-only vs. mutating).
*   [x] Generate conflict keys based on resources (e.g., target file paths, browser session IDs).
*   [x] Batch safe/read-only tools using `Promise.allSettled()`.
*   [x] Serialize conflicting mutating operations to prevent race conditions.
