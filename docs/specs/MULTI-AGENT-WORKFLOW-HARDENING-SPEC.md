# Multi-Agent Workflow Hardening Specification

**Status:** Completed
**Date:** 2026-03-10

This specification formalizes the implementation of [MULTI-AGENT-WORKFLOW-HARDENING-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/implemented-sops/MULTI-AGENT-WORKFLOW-HARDENING-PROPOSAL.md).

## Overview

GuardianAgent is hardening its multi-agent layer by introducing typed orchestration contracts, strict tool schema validation, dispatch lineage tracking, causal workflow tracing, and conflict-aware parallel tool execution.

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
