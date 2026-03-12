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

Not implemented today:
- `memory.search`
- `memory.get`
- `memory.save`
- `event.emit`
- `dispatch.agent`
- `llm.credentials`

Those are intentionally not claimed as part of the current implementation. Instead, the supervisor sends the worker the context it needs for each message:
- system prompt
- trimmed conversation history
- per-agent knowledge base excerpt
- active skills
- tool context
- runtime notices
- effective provider config

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

### Strong hosts

When sandbox availability is `strong`, the worker uses the `agent-worker` sandbox profile:
- dedicated writable workspace
- `HOME` and `TMPDIR` remapped into that workspace
- pid/ipc isolation where supported by the backend

### Degraded or unavailable hosts

When strong sandboxing is not available, the worker still runs brokered, but the process launch falls back to a hardened direct spawn path:
- process boundary remains
- capability-token mediation remains
- dedicated worker cwd remains
- hardened environment remains

What is not guaranteed on degraded hosts:
- filesystem namespace isolation
- broker-enforced network egress allowlisting
- strong OS confinement equivalent to Linux `bwrap`

This is an intentional graceful-degradation path so brokered execution remains the default even when strong host isolation is unavailable.

## Security Guarantees This Feature Actually Provides

Implemented and accurate:
- the built-in chat/planner LLM loop no longer runs in the privileged supervisor process
- all tool execution still flows through supervisor-side `ToolExecutor`
- approvals remain supervisor-side
- final responses are still scanned by `OutputGuardian`
- worker crashes do not crash the supervisor
- supervisor audit can correlate brokered tool actions via `broker_action`

Not yet guaranteed:
- streaming responses from worker to channels
- taint propagation / taint-aware policy
- broker-native memory/event/dispatch APIs
- strict LLM-endpoint-only network egress enforcement from the worker
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
- `node scripts/test-brokered-isolation.mjs`

The brokered harness validates:
- supervisor starts with brokered execution enabled
- a worker is spawned successfully
- `/api/message` executes through the brokered path
- the response is non-empty and not the old worker stub output

## Open Items

The following remain follow-up work, not implemented behavior:
- worker response streaming
- finer-grained capability-token authorization
- explicit broker RPC for memory/event/dispatch
- taint-aware broker policy
- tighter worker egress controls
- dedicated worker tests beyond the focused brokered harness
