# Agentic System Broker Alignment Plan

**Status:** Completed  
**Last updated:** 2026-04-13

## Purpose

This document is retained as a closure record for the broker-alignment work.

The original goal was to move DAG planner execution out of the trusted supervisor process and into the brokered worker so the built-in chat/planner path stayed compliant with the brokered-isolation architecture.

That alignment is now implemented.

## What Was Aligned

### Brokered planner execution

- `complex_planning_task` is preserved by `IntentGateway`
- the worker intercepts the route in `src/worker/worker-session.ts`
- planner execution no longer depends on a supervisor-local shortcut path

### Brokered LLM access

- planner, reflection, recovery, and compaction LLM calls use the worker's brokered chat function
- the worker remains network-disabled

### Brokered tool execution

- planner `tool_call` nodes execute through `executeModelTool(...)`
- planner `execute_code` nodes are routed through `code_remote_exec`
- supervisor-owned policy, approvals, audit, sandbox, and taint handling remain authoritative

### Pause and resume

- planner execution can pause on pending approval
- the worker stores suspended planner session state, including pending node metadata
- resume continues the plan instead of synthesizing an unstructured follow-up

### Fail-closed unsupported actions

- unsupported planner action types, including `delegate_task`, do not bypass the broker boundary
- unsupported actions fail closed as non-recoverable planner errors until a governed delegation contract exists

## Primary Files

- `src/runtime/intent-gateway.ts`
- `src/runtime/planner/orchestrator.ts`
- `src/worker/worker-session.ts`
- `src/worker/worker-session.test.ts`
- `docs/specs/AGENTIC-DAG-PLANNER-SPEC.md`
- `docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md`

## Verification

The aligned path is covered by:

- `src/worker/worker-session.test.ts`
- `src/runtime/intent-gateway.test.ts`
- `node scripts/test-brokered-approvals.mjs`
- `node scripts/test-brokered-isolation.mjs`

## Remaining Follow-ups

- Implement governed `delegate_task` support only after bounded delegation ownership, approval semantics, and resume behavior are specified end-to-end.
- Keep planner docs and brokered-isolation docs synchronized whenever supported planner action types change.
