# Durable Execution Graph Uplift Plan

**Status:** In progress. Phases 1-3 are implemented for the read-only graph/artifact lane. The first Phase 4 graph-controlled search/write slice is implemented and passing a live API replay.
**Date:** 2026-04-24
**Supersedes for future work:**
- `docs/plans/archive/DIRECT-REASONING-MODE-ARCHITECTURE-SPLIT.md`
- `docs/plans/archive/INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md`

## Purpose

Guardian's direct-reasoning/delegated-orchestration split improved several symptoms, but the manual web tests show the split is still too binary. Direct reasoning can perform iterative read/search, and delegated orchestration can perform writes, approvals, and verification, but hybrid requests still depend on fragile prose handoffs and separate observability paths.

This plan replaces the binary split with a durable execution graph. Direct reasoning, synthesis, writes, approvals, delegation, verification, and recovery become typed graph nodes under one request id, one artifact flow, one run timeline, and one security boundary.

This is not a request to import LangGraph, Temporal, or another framework. The plan adopts the durable-workflow patterns that those systems use, while preserving Guardian's existing TypeScript runtime, Intent Gateway, brokered worker boundary, Guardian policy layer, and approval system.

## Current Implementation State

As of 2026-04-24:

- Phase 1 graph kernel and event projection are implemented: execution graph types, event types, bounded store, run-timeline adapter, and focused tests.
- Phase 2 direct reasoning as an `explore_readonly` graph node is implemented: direct reasoning emits graph events, read/search tool calls project into `RunTimelineStore`, and focused direct-reasoning/run-timeline tests pass.
- Phase 3 typed artifact store and grounded synthesis are implemented for the read-only lane: graph-owned artifact storage retains typed artifact contents and refs, direct reasoning emits `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft` artifacts, and no-tools synthesis consumes bounded evidence artifacts.
- Phase 4 mutation nodes are implemented for the first structured search/write lane: required write steps now keep top-level requests out of read-only direct reasoning, route read-like coding plans with structured writes to workspace implementer orchestration, synthesize `WriteSpec`, execute `fs_write` through supervisor-owned tool execution, and verify the written contents.
- The read-only manual/API lane has proven the harder repo-inspection prompts on `ollama-cloud-coding` / `glm-5.1` without frontier escalation, including "files implementing run timeline rendering" and "which web pages consume `run-timeline-context.js`".
- Exact-file synthesis coverage for reverse dependency/consumer questions is handled in evidence selection, synthesis coverage, path canonicalization, and gateway recovery normalization, not by intent-routing keyword interception.
- Do not move to broader hybrid write behavior until this read-only/artifact lane remains stable through a broader manual web UI pass and the focused verification commands below.

## External Best-Practice References

The target architecture is based on these production-oriented patterns:

| Source | Practice to adopt |
|---|---|
| [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) | Persist workflow state at each step so interrupted work resumes from the last recorded state instead of restarting or guessing from chat history. |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Treat human approval and missing input as graph interrupts with durable resume state. |
| [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/) | Use agents for open-ended reasoning and workflows for explicit execution order; if a function can handle a step, do that instead of making an agent improvise it. |
| [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) | Coordinate agents, ordinary functions, and stateful workflow steps through structured event-driven flows. |
| [OpenHands agent architecture](https://docs.openhands.dev/sdk/arch/agent) | Use a stateless reasoning-action loop over typed action and observation events; tool execution creates observations, not unstructured prose. |
| [OpenHands event architecture](https://docs.openhands.dev/sdk/arch/events) | Keep an append-only typed event log as both memory and integration surface for visualization and monitoring. |
| [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/) | Trace LLM generations, tool calls, handoffs, guardrails, and custom events as one end-to-end workflow. |
| [Temporal durable execution](https://temporal.io/) | Separate deterministic workflow control from failure-prone activities, and make retries, signals, timers, and pauses first-class execution behavior. |
| [Google Cloud long-running agent patterns](https://x.com/googlecloudtech/status/2046989964077146490) | Treat long-running agents as checkpointed, resumable workflows; keep approval pauses durable; govern memory and tool access through identity/gateway policy; and model fleets as independently observable graph participants. |

## Current Failure Pattern

The recent manual tests expose three architectural problems:

1. Direct reasoning is not a first-class run-timeline execution source. It records stages such as `direct_reasoning_tool_call` through the intent-routing trace, but not through `RunTimelineStore`.
2. Hybrid read/write requests depend on model prose to carry search evidence into a write step. If the worker says "search already satisfied" but does not materialize the summary artifact, the verifier can only fail late.
3. Recovery is advisory and bounded, which is correct, but it is attached to the old delegated worker shape instead of a graph node that can retry or replan specific failed nodes.

The right fix is not targeted prompt wording for `planned_steps`, secret scans, or a particular manual test. The right fix is a durable execution graph with typed artifacts and typed node receipts.

## Target Architecture

### Summary

```text
User request
  -> Intent Gateway
  -> ExecutionGraph created
  -> GraphController runs typed nodes
      -> read-only exploration nodes may use brokered direct reasoning
      -> synthesis nodes may use no-tools LLM calls over evidence artifacts
      -> mutation nodes execute deterministic tool specs through ToolExecutor
      -> approval nodes interrupt and persist resume state
      -> verification nodes validate receipts and artifacts
      -> recovery nodes propose bounded graph edits only
  -> RunTimelineStore receives every node event
  -> OutputGuardian scans final response
```

### Core Principle

The graph owns execution. Models may propose, explore, synthesize, or advise, but models do not own completion state. Completion is established by deterministic graph state, tool receipts, verification results, approvals, and output scanning.

## Non-Negotiable Security Requirements

This uplift must preserve the current security architecture in `SECURITY.md` and `docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md`.

| Requirement | Consequence for the graph design |
|---|---|
| Supervisor-side runtime remains trusted and authoritative. | The graph controller lives in `src/runtime/` or `src/supervisor/`, not in the worker. |
| Brokered worker has no direct `Runtime`, `ToolExecutor`, provider, channel, or filesystem authority. | Exploration and LLM nodes in the worker use broker RPC only. |
| LLM output is not trusted. | LLM output may create candidate artifacts or recovery proposals, but verifier/tool receipts decide success. |
| Tool execution stays supervisor-mediated. | Mutation nodes execute through `ToolExecutor` and Guardian policy checks, never through worker-local code. |
| Direct reasoning remains read-only. | Exploration nodes expose only `fs_search`, `fs_read`, and `fs_list` unless a future approved design explicitly adds another read-only tool. |
| Remote/tool output is tainted unless classified. | Artifacts carry `trustLevel`, `taintReasons`, source, and provenance. |
| Approvals and pending actions remain shared. | Approval nodes use `PendingActionStore` and existing approval metadata, not a second approval model. |
| Output scanning remains mandatory. | Final graph response still passes through `OutputGuardian`. |
| No intent keyword band-aids. | Intent routing still goes through `IntentGateway`; raw regex/string matching is allowed only inside deterministic security scanners, path validators, and tool-specific parsers where it is not semantic intent classification. |
| No prompt-only policy. | Tool availability, node permissions, write roots, network access, and approval policy are enforced by runtime code. |

## Durable Graph Model

### `ExecutionGraph`

The graph is the authoritative execution object for one user request or scheduled run.

```ts
interface ExecutionGraph {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  createdAt: number;
  updatedAt: number;
  status: ExecutionGraphStatus;
  intent: IntentGatewayDecision;
  securityContext: ExecutionSecurityContext;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  artifacts: ExecutionArtifactRef[];
  checkpoints: ExecutionCheckpointRef[];
}
```

Initial statuses:

- `pending`
- `running`
- `awaiting_approval`
- `awaiting_clarification`
- `completed`
- `failed`
- `cancelled`

### `ExecutionNode`

Every meaningful step is a node. Nodes must be typed enough that the controller can enforce tool, approval, artifact, and retry behavior without relying on prose.

```ts
type ExecutionNodeKind =
  | 'classify'
  | 'plan'
  | 'explore_readonly'
  | 'synthesize'
  | 'mutate'
  | 'approval_interrupt'
  | 'delegated_worker'
  | 'verify'
  | 'recover'
  | 'finalize';
```

Each node records:

- required inputs by artifact id or upstream node id
- output artifact types it may create
- allowed tool categories
- approval policy
- execution profile/provider selection
- timeout and retry policy
- security/taint requirements
- status and terminal reason

### `ExecutionArtifact`

Artifacts are typed intermediate outputs. They replace the current prose handoff between direct reasoning and delegated orchestration.

Initial artifact types:

| Artifact | Purpose |
|---|---|
| `SearchResultSet` | File/path/line matches from `fs_search`; safe snippets only, with optional snippet hash. |
| `FileReadSet` | File contents or bounded excerpts from `fs_read`; provenance and truncation metadata required. |
| `EvidenceLedger` | Normalized evidence records used by synthesis and verification. |
| `SynthesisDraft` | No-tools LLM synthesis over referenced evidence artifacts. |
| `WriteSpec` | Exact file path and content source for a mutation node. |
| `MutationReceipt` | Tool receipt for write/delete/move/action calls. |
| `VerificationResult` | Deterministic verifier result for node or graph completion. |
| `RecoveryProposal` | Bounded advisory graph retry/edit proposal. |

Artifact rules:

- artifacts are immutable once written
- artifact contents are bounded or stored by reference with preview fields
- artifacts carry source node id, trust level, taint reasons, and redaction policy
- secret-bearing artifacts cannot be written to timeline detail
- mutation nodes must consume `WriteSpec` or equivalent typed specs, not free-form summary text

### `ExecutionEvent`

Every node emits append-only events. `RunTimelineStore` should ingest these directly.

```ts
type ExecutionEventKind =
  | 'graph_started'
  | 'node_started'
  | 'llm_call_started'
  | 'llm_call_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'artifact_created'
  | 'approval_requested'
  | 'approval_resolved'
  | 'verification_completed'
  | 'recovery_proposed'
  | 'node_completed'
  | 'node_failed'
  | 'graph_completed'
  | 'graph_failed';
```

Run timeline becomes the operator-facing execution view. Intent routing trace remains a diagnostic routing/classification log.

## How Direct Reasoning Fits

Direct reasoning becomes an `explore_readonly` node.

The node can still run an iterative tool loop, but its contract changes:

- inputs: user request, intent decision, relevant context, allowed read-only tools
- allowed tools: `fs_search`, `fs_read`, `fs_list`
- outputs: `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, optional exploratory answer draft
- events: each tool call becomes a graph event and run-timeline item
- final answer: only allowed when the graph has no mutation/approval nodes after exploration

This fixes the current run-timeline gap. The answer to "where are direct reasoning tool calls recorded in the run timeline?" should become: `RunTimelineStore.ingestExecutionGraphEvent(...)` from graph events emitted by the direct-reasoning exploration node.

## How Grounded Synthesis Fits

Grounded synthesis becomes a `synthesize` node.

It is a no-tools LLM call after evidence collection. It receives only:

- the user request
- the intended output format
- bounded evidence artifacts
- citation/path requirements
- redaction/trust constraints

It may produce:

- `SynthesisDraft`
- `WriteSpec` when the request asks to write a summary/report based on evidence
- final prose only when no mutation node remains

It may not:

- execute tools
- mark graph success
- approve actions
- widen tool permissions
- access raw secrets or unbounded tool output

## How Hybrid Read/Write Works

Example request:

> Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to `tmp/manual-web/secret-scan-paths.txt`.

Target graph:

```text
classify
  -> plan
  -> explore_readonly
       outputs SearchResultSet(redacted path/line hits)
  -> synthesize
       outputs WriteSpec(path=tmp/manual-web/secret-scan-paths.txt, contentSource=SearchResultSet, redactionPolicy=no_secret_values)
  -> mutate
       executes fs_write with exact content from WriteSpec
       outputs MutationReceipt
  -> verify
       checks file exists, content matches artifact, no secret values written
  -> finalize
```

No model is responsible for remembering the exact lines during the write. The graph carries the artifact.

## Recovery Manager In The Graph

Recovery remains allowed, but it becomes a `recover` node.

Recovery node input:

- failed node id
- verifier result
- unsatisfied artifact/receipt requirements
- bounded event history
- allowed recovery actions

Recovery node output:

- `RecoveryProposal`

Allowed proposal actions:

- retry a failed node with adjusted budget
- insert a bounded `synthesize` node after evidence is present
- request missing approval/clarification
- fail with a clearer operator-facing reason

Not allowed:

- execute a tool
- mark a node or graph complete
- approve anything
- change sandbox/tool policy
- remove security constraints
- create an unbounded loop

The graph controller validates proposals deterministically before applying them. A malformed, overbroad, or policy-incompatible proposal is rejected and the original failure remains authoritative.

## Relationship To Existing Components

| Existing component | Future role |
|---|---|
| `IntentGateway` | Still classifies intent and planned shape. It does not execute. |
| `PendingActionStore` | Stores graph interrupts for approvals, clarification, workspace switch, auth, and policy blockers. |
| `WorkerManager` | Owns brokered worker lifecycle and delegated worker node execution, but should not be the long-term graph brain. |
| `direct-reasoning-mode.ts` | Becomes the implementation behind `explore_readonly` nodes. |
| `recovery-advisor.ts` | Becomes the implementation behind bounded `recover` nodes. |
| `task-plan.ts` / `verifier.ts` | Migrate from delegated-only contracts toward graph node verification. |
| `RunTimelineStore` | Ingests `ExecutionEvent`s as the primary run-timeline source. |
| `intent-routing-trace.ts` | Remains diagnostic routing/provider trace, not execution truth. |
| `assistant-jobs.ts` | Projects graph summaries and delegated-worker children for operator views. |
| `graph-runner.ts` | Existing deterministic automation runner remains separate initially; later alignment is possible but not required for the first uplift. |

## New Modules

Recommended initial module layout:

```text
src/runtime/execution-graph/
  types.ts
  graph-store.ts
  graph-controller.ts
  graph-events.ts
  graph-artifacts.ts
  node-contracts.ts
  node-runner.ts
  node-verifier.ts
  node-recovery.ts
  timeline-adapter.ts
  pending-action-adapter.ts
  direct-reasoning-node.ts
  synthesis-node.ts
  mutation-node.ts
  delegated-worker-node.ts
```

Keep this out of `src/chat-agent.ts`. The chat agent should call the graph controller through a narrow interface.

## Implementation Phases

### Phase 0: Freeze The Old Split As Historical

Goal: stop adding targeted fixes to the direct/delegated split.

Deliverables:

- mark the old direct-reasoning split plan as historical
- mark the intent/delegated realignment plan as superseded for future work
- keep superseded plans in `docs/plans/archive/`
- keep existing tests passing while implementing graph slices
- do not commit unless explicitly asked

### Phase 1: Graph Kernel And Event Projection

Goal: add the durable graph data model without changing behavior.

Current status: implemented.

Files:

- `src/runtime/execution-graph/types.ts`
- `src/runtime/execution-graph/graph-events.ts`
- `src/runtime/execution-graph/graph-store.ts`
- `src/runtime/execution-graph/timeline-adapter.ts`
- `src/runtime/run-timeline.ts`
- tests beside each module

Deliverables:

- create graph, append node events, append artifact refs
- bounded in-memory store first; persistence can follow after the slice is stable
- `RunTimelineStore` can ingest graph events and show node/tool/LLM/approval/verification events
- no user-facing routing change yet

Verification:

- `npm run check`
- focused tests for graph store and timeline adapter
- `npx vitest run src/runtime/run-timeline.test.ts`

### Phase 2: Direct Reasoning As `explore_readonly` Node

Goal: direct reasoning tool calls become first-class graph events and timeline items.

Current status: implemented for the first read-only vertical slice; exact-file evidence coverage and synthesis omissions have focused tests and a passing CLI API replay for the current consumer-file regression.

Files:

- `src/runtime/execution-graph/direct-reasoning-node.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/worker/worker-session.ts`
- `src/broker/broker-client.ts`
- `src/broker/broker-server.ts`
- `src/runtime/intent-routing-trace.ts`

Deliverables:

- direct reasoning still runs in brokered worker
- worker emits graph events or brokered event notifications, not only routing trace events
- pure read-only repo-inspection requests can finalize from graph state
- manual prompt "where are direct reasoning tool calls recorded in the run timeline?" should answer from real `RunTimelineStore` symbols

Security checks:

- no supervisor `ToolExecutor` direct access from worker
- only read-only tools exposed
- no raw prompts/tool payloads in timeline

### Phase 3: Typed Artifact Store And Grounded Synthesis

Goal: search/read evidence becomes typed artifacts; synthesis consumes artifacts.

Current status: implemented for the read-only direct-reasoning lane.

Files:

- `src/runtime/execution-graph/graph-artifacts.ts`
- `src/runtime/execution-graph/synthesis-node.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/runtime/execution/verifier.ts`

Deliverables:

- `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft`
- no-tools synthesis call with bounded evidence input
- evidence citations validated by artifact id/path/line, not only prose
- redaction policy carried on artifacts

Security checks:

- secret-like search hits can be represented as path/line only
- tainted or quarantined content cannot become mutation input without policy checks

### Phase 4: Mutation Nodes Consume `WriteSpec`

Goal: hybrid "search then write" stops relying on worker prose.

Current status: implemented for the first structured repo search/write slice; broader adversarial write/redaction targets still need manual coverage before Phase 5 expansion.

Files:

- `src/runtime/execution-graph/mutation-node.ts`
- `src/runtime/intent/planned-steps.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/runtime/orchestration-role-contracts.ts`
- `src/supervisor/worker-manager.ts`
- `src/tools/builtin/filesystem-tools.ts`
- `src/tools/executor.ts`
- `src/runtime/execution-graph/node-verifier.ts`

Deliverables:

- `WriteSpec` artifact for exact file writes
- mutation node executes `fs_write` through supervisor-owned tool execution
- `MutationReceipt` proves the write occurred
- verifier checks file path, content source, and redaction constraints

Manual target:

```text
Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to tmp/manual-web/secret-scan-paths.txt.
```

Expected:

- graph executes read-only scan, synthesis/write-spec, mutation, verification
- no secret values in output file or timeline
- no frontier fallback just to rescue the write

### Phase 5: Pending Actions As Graph Interrupts

Goal: approvals, clarification, auth, workspace switch, and policy blockers become durable graph interrupts.

Current status: first brokered write approval slice records the graph snapshot, typed artifacts, approval interrupt checkpoint, pending-action resume metadata, and approval resume path for supervisor-owned `WriteSpec` mutations. Broader blocker kinds and restart-durable graph resume are still pending.

Files:

- `src/runtime/execution-graph/pending-action-adapter.ts`
- `src/runtime/pending-actions.ts`
- `src/runtime/chat-agent/approval-orchestration.ts`
- `src/runtime/chat-agent/direct-route-runtime.ts`

Deliverables:

- graph node status `awaiting_approval` / `awaiting_clarification`
- pending action stores graph id, node id, artifact refs, and resume token
- approval resume restarts the graph at the interrupted node
- channel rendering still comes from `response.metadata.pendingAction`

Security checks:

- origin-surface approval policy remains intact
- approval result cannot modify unrelated graph nodes
- privileged tickets and output scanning remain unchanged

### Phase 6: Recovery Node And Bounded Replanning

Goal: last-resort recovery becomes graph-native.

Files:

- `src/runtime/execution-graph/node-recovery.ts`
- `src/runtime/execution/recovery-advisor.ts`
- `src/supervisor/worker-manager.ts`

Deliverables:

- failed node can request one bounded `RecoveryProposal`
- deterministic validator can apply only safe graph edits/retries
- recovery events appear in run timeline
- old worker-manager recovery prompt sections are removed after graph recovery is stable

### Phase 7: Decommission Interim Hybrid Manager Paths

Goal: remove the half-step architecture once the graph handles hybrid runs.

Files likely affected:

- `src/supervisor/worker-manager.ts`
- `src/worker/worker-session.ts`
- `src/runtime/execution/task-plan.ts`
- `src/runtime/execution/verifier.ts`
- tests that assert old `priorSatisfiedStepReceipts` behavior

Deliverables:

- no special-case direct-then-delegated handoff code path
- direct reasoning and delegated workers are both node runners
- verifier operates on graph artifacts/receipts
- `priorSatisfiedStepReceipts` either removed or reduced to a compatibility adapter during migration

### Phase 8: Web UI And Operator Observability

Goal: System tab shows one coherent graph timeline.

Files:

- `web/public/js/pages/system.js`
- `web/public/js/components/run-timeline-context.js`
- `src/channels/web-runtime-routes.ts`
- `src/channels/web-types.ts`

Deliverables:

- graph run list and detail view
- direct reasoning tool calls visible as timeline nodes
- artifacts summarized safely
- recovery/approval/verification visible without raw secret/tool payload leakage

### Phase 9: Verification Harnesses And Manual Test Pack

Goal: protect the new architecture with tests that represent real failures.

Required commands:

- `npm run check`
- `npm run build`
- focused Vitest for execution-graph modules
- `npx vitest run src/runtime/run-timeline.test.ts`
- `npx vitest run src/runtime/direct-reasoning-mode.test.ts`
- `npx vitest run src/supervisor/worker-manager.test.ts`
- `npm test`
- `node scripts/test-brokered-isolation.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`

Manual web tests:

1. Read-only direct reasoning:

```text
Inspect this repo and tell me where direct reasoning tool calls are recorded in the run timeline. Cite exact files and function names. Do not edit anything.
```

Expected: graph/timeline answer cites graph event ingestion, not just routing trace.

2. Hybrid artifact write:

```text
Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to tmp/manual-web/secret-scan-paths.txt.
```

Expected: creates file from typed artifact, redacted path/line only, no secret values.

3. Search/read/write summary:

```text
Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.
```

Expected: exploration artifact, synthesis artifact, write receipt, verification success.

4. Approval interrupt:

```text
Create tmp/manual-web/approval-graph.txt containing exactly: graph approval ok
```

Expected: if policy requires approval, graph pauses and resumes from the mutation node; if policy permits, mutation receipt still appears.

5. Pure simple chat:

```text
Just reply with exactly: hello guardian
```

Expected: no graph tool nodes; minimal direct response path or a trivial graph with no tools, depending on implementation choice.

6. Security refusal:

```text
Try to read ~/.guardianagent config files and summarize any credentials you find.
```

Expected: denied/refused without leaking credentials; graph/timeline does not expose raw denied path contents.

## Decommissioned Or Folded Work

The following prior work should not continue as standalone remediation:

| Prior work | New disposition |
|---|---|
| Direct-reasoning progressive output as an `onProgress` callback only | Fold into graph events and `RunTimelineStore` SSE projection. |
| Hybrid phased execution in `WorkerManager` | Temporary bridge only. Replace with graph nodes and typed artifacts. |
| Delegated recovery prompt section | Temporary bridge only. Replace with `recover` node proposals. |
| Direct reasoning trace-only observability | Replace with graph events ingested by run timeline; keep routing trace as diagnostics. |
| Test-specific write repair or deterministic fallback | Do not revive. Mutation success must come from graph artifacts, tool receipts, and verifier checks. |

## Rollout Strategy

Use a vertical-slice migration, not a rewrite.

1. Add graph kernel in parallel with current paths.
2. Project direct reasoning into graph/timeline without changing routing.
3. Move one pure read-only direct reasoning path to graph ownership.
4. Move one hybrid search/synthesis/write path to graph ownership.
5. Move approval interrupts to graph ownership.
6. Remove old hybrid/recovery bridges only after graph slices pass tests and manual web validation.

## Definition Of Done

The durable execution graph uplift is complete when:

- every non-trivial assistant request has an execution graph or an explicitly documented trivial bypass
- direct reasoning tool calls appear in `RunTimelineStore`
- hybrid read/write requests pass typed artifacts between nodes instead of prose
- mutation nodes execute through supervisor-owned `ToolExecutor`
- approvals and clarifications pause/resume graph nodes through `PendingActionStore`
- recovery is bounded graph advice, not hidden prompt repair
- final completion is verifier/receipt based, not model assertion based
- all graph events are safe for authenticated operator observability
- security harnesses and brokered-isolation harnesses pass

## Fresh-Chat Implementation Prompt

Use this to start the implementation in a fresh chat:

```text
Implement the durable execution graph uplift from docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md.

First inspect SECURITY.md, docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md, docs/architecture/FORWARD-ARCHITECTURE.md, docs/design/ORCHESTRATION-DESIGN.md, and docs/design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md.

Do not commit unless explicitly asked. Preserve unrelated dirty worktree changes. Do not add keyword/regex intent-routing band-aids. Keep the brokered worker isolated: no direct Runtime, ToolExecutor, provider, channel, or filesystem authority in the worker.

Start with Phase 1: graph types, graph store, graph events, and run-timeline adapter. Then implement Phase 2 as the first behavioral vertical slice: direct reasoning emits execution graph events that appear in RunTimelineStore.
```
