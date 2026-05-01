# Agentic DAG Planner Design

**Status:** Implemented with guarded limitations  
**Last updated:** 2026-04-13

## Overview

This specification describes the current brokered DAG-planning path used for `complex_planning_task`.

It supersedes the earlier "Phase 1" framing that described future delegation behavior as if it were already live. The current implementation does ship a DAG planner and orchestrator, but it does so inside the brokered worker and keeps unsupported planner actions fail-closed until their governance model is implemented.

## Current Execution Model

### Routing

- `IntentGateway` preserves the `complex_planning_task` route instead of normalizing it away.
- The brokered worker intercepts that route in `src/worker/worker-session.ts`.
- Complex-planning execution does not run in the supervisor process.

### Planner and Orchestrator Placement

- `TaskPlanner`
- `AssistantOrchestrator`
- `SemanticReflector`
- `ContextCompactor`
- `RecoveryPlanner`
- `ReflectiveLearningQueue`

These components are instantiated inside the brokered worker for the planner route.

### LLM Access

- Planner and reflection LLM calls use the worker's brokered chat path.
- The worker remains network-disabled; it does not call providers directly.
- The supervisor remains the owner of provider configuration and guarded LLM access.

### Tool Execution Bridge

Planner nodes execute through the brokered tool bridge:

- `tool_call` nodes map to `toolExecutor.executeModelTool(node.target, args, request)`
- `execute_code` nodes map to `toolExecutor.executeModelTool('code_remote_exec', { command }, request)`

This keeps planner-generated execution on the same supervisor-owned policy, approval, audit, sandbox, and taint-propagation path as the rest of the system.

## Supported Planner Actions

The planner schema may still contain broader action types, but the executable brokered surface is intentionally narrower today.

### Implemented

- `tool_call`
- `execute_code`

### Reserved but not implemented for execution

- `delegate_task`
- other non-tool planner action types from earlier design drafts

Unsupported actions fail closed in the worker with a non-recoverable planner error. They are not silently downgraded, emulated in the supervisor, or allowed to bypass the broker boundary.

## Approval Pause and Resume

The orchestrator supports paused execution when a planner node hits an approval gate.

- `AssistantOrchestrator.executePlan()` can return `paused`
- the worker captures pending planner node metadata
- approval IDs and job IDs are stored in a suspended planner session
- the worker preserves planner trust state across the pause
- resume continues the existing plan instead of synthesizing a new free-form request

This is the current contract that keeps brokered planner execution aligned with shared approval and pending-action orchestration.

## Trust and Taint Propagation

Planner execution is taint-aware.

- planner tool requests are built with the current `contentTrustLevel`
- accumulated `taintReasons` are forwarded with node execution requests
- tool results update the planner trust snapshot
- resumed planner sessions restore the trust snapshot before continuing

This keeps complex-planning execution aligned with the contextual-security and brokered-isolation contracts.

## Data Model

The planner still uses the shared DAG data model:

```ts
interface PlanNode {
  id: string;
  description: string;
  dependencies: string[];
  actionType: string;
  target: string;
  inputPrompt: string | Record<string, unknown>;
  status: 'pending' | 'running' | 'success' | 'failed';
  result?: unknown;
  compactedResult?: unknown;
}

interface ExecutionPlan {
  id: string;
  originalObjective: string;
  nodes: Record<string, PlanNode>;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}
```

Implementation note:

- the schema can express more actions than the brokered executor currently allows
- execution support is authoritative, not schema expressiveness

## Security Constraints

- planner execution stays inside the brokered worker
- tools still execute in the supervisor-owned `ToolExecutor`
- approvals remain supervisor-owned and durable through pending-action metadata
- `execute_code` is constrained through `code_remote_exec`, not arbitrary shell escape
- unsupported delegation remains blocked until a governed bounded-delegation design exists

## Verification

Relevant verification for the shipped implementation:

- `src/worker/worker-session.test.ts`
- `src/runtime/intent-gateway.test.ts`
- `node scripts/test-brokered-approvals.mjs`
- `node scripts/test-brokered-isolation.mjs`

## Follow-ups

- Add a governed `delegate_task` contract only when bounded sub-agent ownership, approvals, and resume semantics are specified end-to-end.
- Keep this spec aligned with `docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md` whenever planner execution semantics change.
