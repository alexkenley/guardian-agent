# Multi-Agent Workflow Hardening Proposal

**Status:** Historical proposal; core items implemented
**Date:** 2026-03-10
**Informed by:**
- GitHub Engineering: [Multi-agent workflows often fail. Here's how to engineer ones that don't](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/)
- GuardianAgent runtime, orchestration, tools, and eval code

Update 2026-03-24:
- The proposal is retained for rationale, but the core hardening items are now implemented.
- See [ORCHESTRATION-DESIGN.md](../design/ORCHESTRATION-DESIGN.md) for current status. The former standalone hardening design is archived at `docs/archive/design/MULTI-AGENT-WORKFLOW-HARDENING-DESIGN.md`.

---

## Executive Summary

GuardianAgent already implements several controls that the GitHub article argues are necessary for reliable multi-agent systems:

- mandatory runtime chokepoints
- approval-gated mutating actions
- audit logging and watchdog recovery
- per-session serialization and request tracing
- provider failover and circuit breaking

The remaining weakness is not basic safety. It is **contract rigor**.

At proposal time, GuardianAgent's multi-agent layer still relied heavily on free-form text handoffs, shallow schema validation, and incomplete execution telemetry. Those specific gaps have since been materially reduced by the hardening work captured in the linked specification.

This proposal recommends six focused changes:

1. Add typed orchestration contracts for step inputs and outputs.
2. Replace shallow tool-argument checks with real schema enforcement.
3. Add dispatch lineage, max-depth, and cycle detection.
4. Add causal workflow tracing across agent hops and tool calls.
5. Capture actual tool trajectories in the eval framework.
6. Make parallel tool execution conflict-aware for mutating actions.

These changes do **not** require a rewrite of the Runtime, Guardian pipeline, or ChatAgent tool loop. They are targeted hardening changes that preserve the current architecture.

---

## Problem Statement

The GitHub article's core argument is that multi-agent systems fail when they behave like loosely coupled prompts instead of engineered systems. The recurring recommendations are:

- use multi-agent decomposition only where it creates real leverage
- keep agent boundaries narrow and explicit
- validate data at every boundary
- reduce the action space visible to the model
- treat workflow execution as a distributed systems problem with tracing, retries, and failure isolation
- test real execution paths, not idealized behavior

GuardianAgent already does well on security enforcement, but it is weaker on:

- structured inter-agent contracts
- deep schema validation
- causal visibility across workflow hops
- runtime verification of actual tool behavior
- deterministic handling of concurrent side effects

---

## Current State Assessment

### What Already Aligns Well

- **Runtime chokepoints are mandatory.** Agents do not bypass Guardian admission, output scanning, or audit logging.
- **Approval and policy controls already exist.** Mutating and external actions are governed centrally.
- **Failure handling is stronger than average.** Watchdog recovery, backoff, and provider failover are already implemented.
- **Session orchestration exists.** The assistant layer serializes work per session and exposes timing traces.

These are strong foundations. The proposal deliberately builds on them instead of replacing them.

### Main Gaps

1. **Inter-agent state is mostly untyped.**
   Sequential, Parallel, and Loop agents pass `response.content` strings through `SharedState` with no per-key schema validation.

2. **Tool schemas are only partially enforced.**
   The executor validates required fields and top-level primitive types, but not nested schemas, enums, ranges, patterns, or unexpected properties.

3. **Agent dispatch has no lineage guardrails.**
   There is no explicit max dispatch depth, parent-child invocation tree, or cycle detection across agents.

4. **Workflow traces are incomplete.**
   Request traces exist, but there is no first-class causal graph connecting top-level request -> sub-agent dispatches -> tool calls -> approvals -> final response.

5. **Eval trajectory support is effectively stubbed.**
   The eval runner exposes tool-trajectory assertions but does not populate actual tool call data.

6. **Parallel tool execution is optimistic.**
   The tool loop executes model-emitted tool calls in parallel without checking for resource conflicts between mutating operations.

---

## Proposed Changes

### 1. Typed Orchestration Contracts

### Goal

Replace free-form step handoffs with explicitly validated step contracts.

### Why

The article's most important recommendation is to stop treating agent handoffs as unrestricted natural language. GuardianAgent currently preserves security at the boundaries, but not precision. This creates failure modes such as:

- downstream steps receiving malformed or ambiguous text
- hidden prompt injection surviving as ordinary content
- oversized state blobs accumulating in memory
- weak debuggability because state semantics are implicit

### Proposal

Extend orchestration step definitions to support input and output contracts:

```ts
interface OrchestrationStepContract {
  key: string;
  schema: JsonSchema;
  maxBytes?: number;
  sanitize?: 'none' | 'llm_text' | 'json_text';
}

interface OrchestrationStep {
  agentId: string;
  inputKey?: string;
  outputKey?: string;
  inputContract?: OrchestrationStepContract;
  outputContract?: OrchestrationStepContract;
}
```

### Behavior

- Before dispatching a step, validate the value loaded from `inputKey`.
- After a step completes, validate the output before writing to `SharedState`.
- Support both:
  - structured state objects
  - explicit text envelopes such as `{ kind: 'summary', payload: '...' }`
- Add a `maxStateBytes` limit to `SharedState`.
- Add per-key metadata: producer agent, timestamp, schema ID, and validation status.

### Initial Scope

- `SequentialAgent`
- `ParallelAgent`
- `LoopAgent`
- `SharedState`

### Files

- `src/agent/orchestration.ts`
- `src/runtime/shared-state.ts`
- `src/agent/types.ts`
- `src/runtime/runtime.ts`

### Migration Strategy

- Phase 1: contracts optional, warn-only validation
- Phase 2: opt-in enforce mode per orchestration agent
- Phase 3: require contracts for new multi-agent workflows

---

### 2. Real Schema Enforcement for Tool Arguments

### Goal

Make tool invocation failures deterministic by enforcing full parameter schemas, not just partial type checks.

### Why

The current executor checks:

- required fields
- top-level primitive type shape

It does not reliably enforce:

- nested object structure
- enum membership
- string patterns
- min/max values
- array item schemas
- `additionalProperties: false`

This leaves too much ambiguity at the model-to-tool boundary.

### Proposal

Adopt a real schema validator for tool parameters.

Recommended path:

- Use JSON Schema as the runtime contract surface.
- Validate tool args with `Ajv` or equivalent.
- Reject unknown fields by default for new tools.
- Allow tool definitions to opt into coercion only where explicitly justified.

### Additional Changes

- Validate discovered MCP tools with the same mechanism.
- Store schema validation failures as structured audit events.
- Include schema IDs and validation errors in tool job records.

### Files

- `src/tools/executor.ts`
- `src/tools/types.ts`
- `src/tools/mcp-client.ts`

### Acceptance Criteria

- Nested schemas are enforced.
- Enum violations are rejected.
- Unexpected properties are rejected for strict tools.
- Validation errors are machine-readable and auditable.

---

### 3. Dispatch Lineage, Max Depth, and Cycle Detection

### Goal

Prevent recursive or circular agent dispatch patterns from degrading into hidden loops.

### Why

`LoopAgent.maxIterations` only protects one workflow shape. It does not protect:

- agent A -> agent B -> agent A recursion
- deep dispatch trees that exhaust budget without obvious failure
- repeated cross-agent retries with no new state

The GitHub article's distributed-systems framing implies that workflow hops need lineage and loop prevention.

### Proposal

Introduce dispatch metadata threaded through agent invocations:

```ts
interface DispatchLineage {
  rootRequestId: string;
  parentInvocationId?: string;
  invocationId: string;
  depth: number;
  path: string[];
}
```

### Runtime Rules

- Reject when `depth > maxDispatchDepth`
- Reject when the next target would create a direct cycle beyond a configured threshold
- Record lineage on:
  - audit events
  - orchestrator traces
  - tool jobs

### Suggested Defaults

- `maxDispatchDepth = 5`
- `maxRepeatedAgentInPath = 2`

### Files

- `src/runtime/runtime.ts`
- `src/agent/types.ts`
- `src/agent/orchestration.ts`
- `src/runtime/orchestrator.ts`

---

### 4. Causal Workflow Tracing

### Goal

Make multi-agent workflows explainable after the fact.

### Why

GuardianAgent already tracks top-level request traces, but not a complete execution graph. For debugging and evaluation, operators need to answer:

- which sub-agent ran
- what state key it consumed
- what contract it produced
- which tools it called
- which approvals were created
- which retry or fallback path was taken

### Proposal

Add a workflow trace model that spans:

- assistant request
- sub-agent dispatches
- tool jobs
- approvals
- fallback provider calls

Example:

```ts
interface WorkflowTraceNode {
  id: string;
  parentId?: string;
  kind: 'agent_dispatch' | 'tool_call' | 'approval' | 'provider_call';
  name: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'succeeded' | 'failed' | 'blocked';
  metadata?: Record<string, unknown>;
}
```

### Operator Value

- faster debugging of dead ends and retries
- clearer root-cause analysis for denial or timeout paths
- stronger evidence for eval failures

### Files

- `src/runtime/orchestrator.ts`
- `src/runtime/runtime.ts`
- `src/tools/executor.ts`
- web and CLI assistant-state consumers

---

### 5. Real Tool Trajectory Capture in Evals

### Goal

Make the eval framework verify what the system actually did, not just what it said.

### Why

The current eval API supports expected tool trajectories, but the runner populates `toolCalls: []`. This means one of the most important workflow assertions is not operational.

### Proposal

Capture executed tool calls from the real runtime path and attach them to eval outputs.

### Design

- Add a lightweight per-request execution collector.
- Record:
  - tool name
  - normalized args
  - job ID
  - approval status
  - result status
- Thread collector data into `EvalActualResponse.toolCalls`.

### Extensions

- Add assertions for:
  - approval expectation
  - denied-tool expectation
  - provider fallback expectation
  - dispatch lineage expectation

### Files

- `src/eval/runner.ts`
- `src/eval/types.ts`
- `src/tools/executor.ts`
- `src/runtime/runtime.ts`

---

### 6. Conflict-Aware Parallel Tool Execution

### Goal

Keep parallel execution for safe work while preventing race conditions between mutating actions.

### Why

The current tool loop runs model-emitted tool calls in parallel with `Promise.allSettled()`. That is correct for read-only calls, but risky for:

- multiple writes to the same file
- write + move/copy/delete on the same path
- non-idempotent external actions
- ordering-sensitive shell operations

### Proposal

Partition tool calls into execution groups:

- **always parallel:** read-only calls
- **parallel by resource:** writes to distinct resources
- **always serialized:** approvals, shell mutations, external posts, ambiguous targets

### Resource Keys

Compute a conflict key before execution:

- filesystem tools -> normalized target path(s)
- browser actions -> session ID + page target
- Gmail send/forum post -> serialized by default
- shell tools -> serialized unless explicitly declared read-only

### Files

- `src/index.ts`
- `src/tools/executor.ts`
- `src/tools/types.ts`

---

## Non-Goals

This proposal does **not** recommend:

- replacing the current Runtime with a new agent framework
- removing Guardian or policy enforcement in favor of prompt-only controls
- introducing persistent cross-session shared state for orchestration
- defaulting all tool execution to sequential mode

The current architecture is sound. The goal is to harden it, not replace it.

---

## Implementation Plan

### Phase 1: Boundary Hardening

Priority: P0

- Add strict tool schema validation
- Add dispatch depth and lineage threading
- Add audit events for schema failures and cycle blocks

Expected impact:

- immediate reduction in malformed tool requests
- safer multi-agent recursion behavior
- better root-cause visibility

### Phase 2: Orchestration Contracts

Priority: P1

- Add `SharedState` limits and metadata
- Add optional step contracts
- Add warn-only and enforce modes

Expected impact:

- more reliable step composition
- smaller blast radius from malformed outputs
- better multi-agent debuggability

### Phase 3: Trace and Eval Completion

Priority: P1

- Add causal workflow trace nodes
- Record real tool trajectories in evals
- expose trace graph in assistant state

Expected impact:

- stronger operator tooling
- meaningful workflow regression testing

### Phase 4: Conflict-Aware Parallelism

Priority: P2

- add resource conflict detection
- batch safe tool calls in parallel
- serialize ambiguous mutating operations

Expected impact:

- fewer nondeterministic workflow failures
- preserved latency wins for safe parallel work

---

## Suggested Priority Order

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Real tool schema enforcement | Medium | High |
| P0 | Dispatch lineage + max depth | Small | High |
| P1 | Typed orchestration contracts | Medium | High |
| P1 | Real tool trajectory capture in evals | Small | High |
| P1 | Causal workflow tracing | Medium | Medium |
| P2 | Conflict-aware parallel execution | Medium | Medium |

---

## Risks and Tradeoffs

### Increased Strictness May Break Existing Flows

Stronger validation will surface existing malformed tool calls that currently slip through. This is desirable, but rollout should be staged.

Mitigation:

- warn-only mode first
- metrics on validation failures
- per-tool migration exceptions where necessary

### More Metadata Means More Storage

Workflow lineage and richer traces increase in-memory and persisted metadata.

Mitigation:

- bounded retention
- summarized web/CLI views
- trace-detail opt-in for heavy workflows

### Contract Authoring Adds Developer Work

Structured step contracts are more effort than raw text chaining.

Mitigation:

- keep contracts optional at first
- provide helpers for common text-envelope patterns
- require contracts only for workflows with multiple dependent steps

---

## Acceptance Criteria

This proposal should be considered complete when:

1. Multi-agent workflows can declare and enforce typed step contracts.
2. Tool schemas are enforced with full runtime validation.
3. Cross-agent dispatch has depth and cycle protection.
4. Operators can inspect a causal trace from request to sub-agent to tool to approval.
5. Eval suites can assert actual tool trajectories from real execution.
6. Parallel tool execution preserves concurrency for safe reads while preventing conflicting writes.

---

## Recommendation

Approve this proposal as an incremental hardening stream focused on **workflow correctness**, not architectural replacement.

GuardianAgent already has stronger security controls than the average multi-agent system. The next step is to make its multi-agent workflows behave like engineered pipelines with:

- typed boundaries
- strict validation
- causal observability
- deterministic side-effect handling
- real execution-based testing

That is the closest match to the engineering direction recommended by the GitHub article, and it fits the current codebase cleanly.
