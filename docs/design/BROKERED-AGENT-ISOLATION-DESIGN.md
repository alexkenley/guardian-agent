# Brokered Agent Isolation

**Status:** Implemented
**Date:** 2026-03-31
**Proposal:** `docs/implemented/BROKERED-AGENT-ISOLATION-PROPOSAL.md`
**Code:** `src/broker/`, `src/supervisor/`, `src/worker/`

## Overview

GuardianAgent now runs the built-in chat/planner path in a brokered worker process by default.

The supervisor process remains responsible for:
- config loading
- Runtime admission checks
- audit logging
- tool execution and approvals
- worker lifecycle

The worker process owns:
- prompt assembly
- conversation-context assembly from supervisor-provided state
- the LLM chat/tool loop
- the read-only direct-reasoning loop for repo-inspection/coding analysis turns
- bounded suspended tool-loop state for approval-backed resumes
- post-gateway direct deterministic handling that reuses the same structured intent contract as the supervisor path

Brokered approval continuation should use structured supervisor-owned metadata over the broker boundary. The worker should resume suspended approval-backed execution from stored tool/approval state rather than reclassifying a synthetic user-like continuation prompt.
The supervisor-side approval executor must also retain a durable or reconstructable execution envelope for approved actions; brokered isolation should not force approvals to depend on a fragile in-memory callback map that can vanish before execution.
Execution identity remains supervisor-owned. When delegated work, blocked work, or approval-backed resumes cross the broker boundary, the runtime should preserve execution lineage such as `executionId`, `parentExecutionId`, and `rootExecutionId` where that lineage is available.

The shared prompt/context contract for both supervisor-provided state and worker-side assembly is defined in:
- `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`

For Code-session turns, that supervisor-provided state now includes the resolved backend coding-session context, including workspace root, workspace profile, repo map, working set, Guardian global memory, and bounded session-local Code-session memory context. The brokered worker should reason from that structured session-owned state rather than from stale host-app identity assumptions or unscoped prior chat context.

The boundary is JSON-RPC over stdio. The worker has no direct reference to `Runtime`, `ToolExecutor`, or channel adapters.

## Current Architecture

```text
Channel -> Runtime.dispatchMessage()
        -> Guardian Layer 1
        -> ChatAgent.onMessage()
        -> WorkerManager.handleMessage()
        -> brokered worker process
             -> LLM provider call
             -> broker RPC tool.call / approval.*
             -> brokered direct reasoning for read-only repo inspection
        -> worker returns final response
        -> OutputGuardian final scan
        -> channel response
```

Important scope notes:
- This isolation is the default path for the built-in chat agent flow.
- Structured orchestration agents still execute as trusted framework code in the supervisor process, but any sub-agent dispatch they perform goes back through `Runtime.dispatchMessage()` and therefore into the same brokered chat path for chat agents.
- This is not a claim that arbitrary developer-authored code is universally sandboxed. The isolated boundary applies to the shipped chat/planner execution path.

## Defaults

`runtime.agentIsolation` now defaults to:

```yaml
runtime:
  agentIsolation:
    enabled: true
    mode: brokered
    workerIdleTimeoutMs: 300000
    workerMaxMemoryMb: 512
    workerHeartbeatIntervalMs: 30000
    workerShutdownGracePeriodMs: 10000
    workerMaxConcurrent: 4
    workerEntryPoint: ""
    capabilityTokenTtlMs: 600000
    capabilityTokenMaxToolCalls: 0
```

`workerEntryPoint: ""` means "use the built-in worker entrypoint".

## Implemented RPC Surface

JSON-RPC 2.0 newline-delimited messages are used on stdio.

### Worker -> Supervisor requests

Implemented today:
- `tool.listLoaded`
- `tool.search`
- `tool.call`
- `approval.status`
- `approval.decide`
- `approval.result`
- `job.list`
- `llm.chat` — **LLM calls are proxied through the broker**. The worker sends chat messages and options via RPC; the supervisor resolves the provider and makes the API call. This eliminates worker network egress requirements for LLM access.

Not implemented today:
- `memory.search`
- `memory.get`
- `memory.save`
- `event.emit`
- `dispatch.agent`

Those are intentionally not claimed as part of the current implementation. Instead, the supervisor sends the worker the context it needs for each message:
- system prompt
- trimmed conversation history
- scoped persistent-memory excerpt
  - global agent memory for normal chat
  - global agent memory plus bounded Code-session memory augment context for Code turns
- active skills
- tool context
- runtime notices

### Supervisor -> Worker notifications

Implemented:
- `worker.initialize`
- `message.handle`
- `worker.shutdown`

Accepted by worker client:
- `capability.refreshed`

### Worker -> Supervisor notifications

Implemented:
- `worker.ready`
- `worker.heartbeat`
- `message.response`
- `trace.record` — brokered workers can publish routing/diagnostic trace events such as direct-reasoning start, tool-call, completion, and failure without gaining direct access to supervisor observability internals

## Direct Reasoning Boundary

Read-only direct reasoning is an execution mode inside the brokered worker, not a supervisor-side shortcut. The supervisor still owns intent routing, execution-profile selection, capability tokens, audit logging, approvals, and tool execution. The worker receives an explicit `directReasoning` dispatch flag and then uses injected broker-backed dependencies:

- LLM calls go through `llm.chat`
- filesystem inspection goes through `tool.call` for the read-only allowlist `fs_search`, `fs_read`, and `fs_list`
- diagnostic events go through `trace.record`

Direct reasoning must not call supervisor `ToolExecutor` or provider objects directly when brokered isolation is enabled. If the read-only loop exhausts its budget, the direct turn fails closed instead of automatically falling into delegated orchestration.

Forward target: `docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md` moves direct reasoning from a standalone execution mode into a durable graph `explore_readonly` node. This does not weaken the broker boundary. The worker still receives only broker-backed LLM/tool/event dependencies, and the supervisor remains the owner of graph state, tool execution, approvals, audit, and run-timeline projection.

## Capability Tokens

Capability tokens are held only in supervisor memory.

Implemented validation:
- token exists
- token is bound to the worker
- token is not expired
- optional tool-call budget is not exceeded

Implemented lifecycle:
- mint on worker spawn
- revoke on worker cleanup/crash
- pass token ID string to worker via environment

Current limitation:
- the current implementation does not yet enforce fine-grained capability scopes or per-category token narrowing at the broker layer

## Worker Lifecycle

Current behavior:
- one worker per user session key (`<userId>:<channel>`)
- workers are reused across messages for that session
- idle workers are reaped after `workerIdleTimeoutMs`
- worker workspace is created under `/tmp/ga-worker-<id>/`
- workspace is deleted on cleanup
- unexpected exits record `worker_crash` audit events
- token state is revoked on cleanup

The supervisor sends a lightweight initialization notification after spawn, then waits for `worker.ready` before dispatching work.

## Sandbox Behavior

### Network isolation

LLM API calls are proxied through the broker via the `llm.chat` RPC. The worker is spawned with `networkAccess: false` regardless of sandbox strength. The worker process never makes outbound network connections — all LLM provider calls, tool executions, and approval decisions are mediated by the supervisor.

### Strong hosts

When sandbox availability is `strong`, the worker uses the `agent-worker` sandbox profile:
- dedicated writable workspace
- explicit read-only bind for the worker runtime bundle (entrypoint plus the supporting app/runtime tree it imports from)
- `HOME` and `TMPDIR` remapped into that workspace
- pid/ipc/network namespace isolation via bwrap (`--unshare-net`)

### Degraded or unavailable hosts

When strong sandboxing is not available, the worker still runs brokered with the `workspace-write` profile (NOT `full-access`):
- process boundary remains
- capability-token mediation remains
- dedicated worker cwd remains
- hardened environment remains
- network isolation maintained through broker-proxied LLM calls

What is not guaranteed on degraded hosts:
- filesystem namespace isolation (bwrap not available)
- strong OS confinement equivalent to Linux `bwrap`

This is an intentional graceful-degradation path so brokered execution remains the default even when strong host isolation is unavailable.

## Security Guarantees This Feature Actually Provides

Implemented and accurate:
- the built-in chat/planner LLM loop no longer runs in the privileged supervisor process
- all tool execution still flows through supervisor-side `ToolExecutor`
- LLM API calls are proxied through the broker — the worker has no network access
- approvals remain supervisor-side
- brokered direct routes still respect the gateway-first contract; weak or unavailable gateway results do not trigger heuristic capability-lane fallback
- continuation and approval-backed resume remain control-plane driven; the brokered worker does not become a second semantic routing authority
- supervisor-owned delegated follow-up policy can normalize delegated completion output before it reaches channels, while keeping the worker unable to widen authority
- final responses are still scanned by `OutputGuardian`
- tool results returned across the broker now include `trustLevel` and `taintReasons`
- quarantined tool output is suppressed from raw planner reinjection in the worker loop
- worker crashes do not crash the supervisor
- supervisor audit can correlate brokered tool actions via `broker_action`
- `memory_save` suppression enforced both in the worker loop and at the broker level
- partial approval continuation: mixed approval/success tool rounds handled correctly
- brokered approval continuation uses structured control-plane metadata instead of synthetic `[User approved ...]` text shims
- delegated child runs and resumed work can preserve execution lineage for downstream timeline and chat correlation when that metadata is available
- context budget compaction applied in the worker loop
- quality-based fallback to external provider via broker-proxied `llm.chat`
- degraded hosts use `workspace-write` profile (not `full-access`)
- delegated follow-up metadata is attached as bounded response metadata rather than exposing raw worker-only status internals to channels
- held delegated-result replay runs back through supervisor-owned output scanning before it is returned to the operator

Not yet guaranteed:
- streaming responses from worker to channels
- a universal persistent taint graph across every subsystem
- broker-native memory/event/dispatch APIs
- fine-grained per-tool or per-category capability narrowing inside broker capability tokens
- full isolation of every possible developer-authored agent implementation

## Files

Primary implementation files:
- `src/broker/broker-server.ts`
- `src/broker/broker-client.ts`
- `src/broker/capability-token.ts`
- `src/broker/provenance.ts`
- `src/supervisor/worker-manager.ts`
- `src/worker/worker-entry.ts`
- `src/worker/worker-session.ts`
- `src/worker/worker-llm-loop.ts`
- `src/runtime/runtime.ts`
- `src/index.ts`
- `src/sandbox/profiles.ts`
- `src/guardian/audit-log.ts`

## Validation

Focused validation currently used for this feature:
- `npm run check`
- `npm run build`
- `node scripts/test-brokered-isolation.mjs` — basic brokered smoke test
- `node scripts/test-brokered-approvals.mjs` — multi-step approval flow, memory_save suppression, direct tool report via `job.list`
- `node scripts/test-security-verification.mjs` — privileged policy reads, approval-gated writes, and brokered safety controls
- `node scripts/test-policy-update-visibility.mjs` — policy-update request visibility and approval routing through the brokered path

Harness note:
- brokered harnesses should spawn Guardian with an isolated temporary `HOME`/`USERPROFILE`/`XDG_*` directory so SQLite state, routing traces, and other runtime artifacts do not bleed in from the operator's real host profile during validation

The brokered approval harness validates:
- supervisor starts with brokered execution enabled
- multi-step approval flow (update_tool_policy -> approve -> fs_write -> approve -> final response)
- no spurious `memory_save` calls during operational flow
- direct tool report via `job.list` RPC returns formatted records
- `pendingAction` approval metadata propagated correctly through the brokered path
- delegated follow-up metadata survives the brokered path without bypassing supervisor-side approval control
- held delegated-result replay stays supervisor-mediated and output-scanned instead of reading raw worker memory directly from a channel

## Unified Operator Controls

Three simplified config aliases map to internal machinery:

```yaml
# Simplified controls (top-level)
sandbox_mode: strict           # off | workspace-write | strict
approval_policy: on-request    # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox additionalWritePaths
  - /home/user/projects
```

These are convenience aliases resolved at config load time. Internal config sections take precedence when set alongside the aliases.

## Open Items

The following remain follow-up work, not implemented behavior:
- worker response streaming
- finer-grained capability-token authorization
- explicit broker RPC for memory/event/dispatch
- graph-event notification support for durable execution graph node events
- taint-aware broker policy
- dedicated worker tests beyond the focused brokered harness
