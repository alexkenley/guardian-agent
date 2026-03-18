# Brokered Agent Isolation

**Status:** Implemented
**Date:** 2026-03-12
**Proposal:** `docs/proposals/BROKERED-AGENT-ISOLATION-PROPOSAL.md`
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
- pending-approval continuation state

For Code-session turns, that supervisor-provided state now includes the resolved backend coding-session context, including workspace root, workspace profile, repo map, working set, and Code-session memory scope. The brokered worker should reason from that session-owned context rather than from Guardian host-app identity or global memory.

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
  - Code-session memory for Code turns
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
- final responses are still scanned by `OutputGuardian`
- tool results returned across the broker now include `trustLevel` and `taintReasons`
- quarantined tool output is suppressed from raw planner reinjection in the worker loop
- worker crashes do not crash the supervisor
- supervisor audit can correlate brokered tool actions via `broker_action`
- `memory_save` suppression enforced both in the worker loop and at the broker level
- partial approval continuation: mixed approval/success tool rounds handled correctly
- context budget compaction applied in the worker loop
- quality-based fallback to external provider via broker-proxied `llm.chat`
- degraded hosts use `workspace-write` profile (not `full-access`)

Not yet guaranteed:
- streaming responses from worker to channels
- a universal persistent taint graph across every subsystem
- broker-native memory/event/dispatch APIs
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

The brokered approval harness validates:
- supervisor starts with brokered execution enabled
- multi-step approval flow (update_tool_policy -> approve -> fs_write -> approve -> final response)
- no spurious `memory_save` calls during operational flow
- direct tool report via `job.list` RPC returns formatted records
- `pendingApprovals` metadata propagated correctly through the brokered path

## Unified Operator Controls

Three simplified config aliases map to internal machinery:

```yaml
# Simplified controls (top-level)
sandbox_mode: strict           # off | workspace-write | strict
approval_policy: auto-approve  # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox additionalWritePaths
  - /home/user/projects
```

These are convenience aliases resolved at config load time. Internal config sections take precedence when set alongside the aliases.

## Open Items

The following remain follow-up work, not implemented behavior:
- worker response streaming
- finer-grained capability-token authorization
- explicit broker RPC for memory/event/dispatch
- taint-aware broker policy
- dedicated worker tests beyond the focused brokered harness
