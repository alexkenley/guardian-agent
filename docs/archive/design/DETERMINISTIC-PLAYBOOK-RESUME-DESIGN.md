# Deterministic Playbook Resume Design

**Status:** Implemented baseline  
**Primary Files:** `src/runtime/run-state-store.ts`, `src/runtime/graph-types.ts`, `src/runtime/graph-checkpoints.ts`, `src/runtime/graph-runner.ts`, `src/runtime/connectors.ts`, `src/index.ts`

## Goal

Make deterministic playbook runs resumable after approval interrupts and process restarts without introducing a general-purpose persistent agent scratchpad.

## Implemented Model

### Durable Run State

Playbook checkpoints now persist through a `RunStateStore` abstraction.

Implemented stores:
- `InMemoryRunStateStore`
- `JsonFileRunStateStore`

The current runtime wires a JSON-backed store at:
- `~/.guardianagent/playbook-run-state.json`

### Checkpoint Data

`GraphRunCheckpoint` now records:
- `nextNodeId`
- `pendingApprovalIds`
- `resumeContext`

This is enough to:
- pause on approval
- correlate later approval decisions back to a run
- resume from the next deterministic node

### Approval Resume Path

`ConnectorPlaybookService.continueAfterApprovalDecision(...)` now:
- finds the affected checkpoint by `approvalId`
- updates the pending step result with the approval outcome
- marks hard failures when appropriate
- resumes the graph when all pending approvals for the interruption are resolved

## Benefits

- Approval-gated playbooks no longer dead-end at the first interrupt
- Run history stays attached to one stable `runId`
- Deterministic automations survive process restarts more cleanly
- The runtime has a safer foundation for later replay/recovery work

## Design Constraints

- Resume is limited to deterministic playbook graphs
- Persisted state stores structured node outputs, events, and bounded resume context only
- This is intentionally not a persistent shared multi-agent memory bus

## Current Boundaries

- No arbitrary branch replay UI yet
- No generalized resume for open-ended scheduled assistant turns
- JSON file persistence is local-host durability, not distributed orchestration storage

## Verification

- `src/runtime/graph-runner.test.ts`
- `src/runtime/run-state-store.test.ts`
- `src/runtime/connectors.test.ts`
