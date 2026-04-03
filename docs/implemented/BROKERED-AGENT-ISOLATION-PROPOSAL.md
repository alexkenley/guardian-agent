# Brokered Agent Isolation Proposal

**Status:** Proposed  
**Date:** 2026-03-08  
**Informed by:** `https://mrinal.com/articles/agent-sandboxes/`

## Objective

Strengthen GuardianAgent's security model by moving from:

- strong policy and subprocess sandboxing around managed tool execution

to:

- a brokered architecture where the agent runtime itself is isolated and all host capabilities are mediated across a privileged boundary

This proposal is aimed at the main gap exposed by the article and by our current architecture: **the model output is treated as untrusted, but the planning/runtime loop that consumes it still lives in the main Node.js process.**

## Current State

GuardianAgent is already materially ahead of many agent systems:

- runtime-managed capabilities are narrow and frozen
- managed tool effects are routed through `ToolExecutor`
- mutating and high-risk actions are approval-gated or LLM-reviewed
- managed child processes use OS sandboxing where strong backends exist
- strict sandbox mode disables risky subprocess-backed tools when strong isolation is unavailable

Current strengths live in these areas:

- runtime mediation: [runtime.ts](/mnt/s/Development/GuardianAgent/src/runtime/runtime.ts)
- tool governance and approvals: [executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- subprocess sandboxing: [index.ts](/mnt/s/Development/GuardianAgent/src/sandbox/index.ts), [profiles.ts](/mnt/s/Development/GuardianAgent/src/sandbox/profiles.ts)

Current architectural limitation:

- agent code and the model/planning loop still run in the main process, which is explicitly acknowledged in [SECURITY.md](/mnt/s/Development/GuardianAgent/SECURITY.md#L18)

That means GuardianAgent currently enforces:

- strong boundaries for managed effects

but not yet:

- a strong privilege boundary between the agent runtime itself and the host control plane

## Why Change

The article's key design idea is sound: **treat the agent as hostile, give it a workspace, and force it through a broker for all real-world effects.**

Applied to GuardianAgent, that would improve:

- containment of prompt-injected or misaligned planning behavior
- separation between untrusted model output and trusted control-plane state
- secret minimization
- MCP and broad-provider risk reduction
- future multi-tenant support

It also gives us a cleaner answer to a hard question:

- today we can say "managed tools are sandboxed and policy-gated"
- after this change we can say "the agent runtime itself is isolated, and the only way out is through brokered capabilities"

## Design Goals

1. Run agent planning/LLM loops outside the privileged main process.
2. Keep host credentials, filesystem access, browser sessions, MCP servers, and outbound side effects behind a broker.
3. Preserve Guardian policy, approvals, audit logging, and OutputGuardian semantics.
4. Reduce ambient authority: no inherited host env, no ambient `HOME`, no broad raw network access by default.
5. Make the migration incremental so current features do not need to be rewritten all at once.

## Non-Goals

- rewriting all built-in agents immediately
- replacing the current Guardian/ToolExecutor policy model
- claiming arbitrary developer-authored code is fully safe
- introducing a full container orchestrator or VM layer in the first phase

## Proposed Architecture

### 1. Trusted Supervisor

Keep a small trusted runtime in the main process responsible for:

- config loading
- identity and auth
- policy state
- approvals
- audit persistence
- sandbox health detection
- spawning and supervising isolated agent workers

This becomes the only component allowed to touch:

- config files
- long-lived credentials
- tool policy updates
- approval decisions
- audit persistence

### 2. Privileged Capability Broker

Move all host-effecting services behind a broker boundary:

- file operations
- shell execution
- browser automation
- GWS operations
- MCP tool servers
- web fetch/search
- memory persistence
- event emission beyond the local worker boundary

The broker exposes a narrow RPC surface such as:

- `tool.search`
- `tool.call`
- `approval.request`
- `approval.status`
- `memory.search`
- `memory.get`
- `event.emit`

The broker continues to run:

- Guardian admission checks
- ToolExecutor policy
- approval creation/decision flow
- OutputGuardian scanning of tool results before model reinjection

### 3. Unprivileged Agent Worker

Run the model loop, conversation assembly, and planning inside a sandboxed worker process.

The worker should have:

- no direct file access outside its sandbox workspace
- no direct access to long-lived host credentials
- no direct access to MCP server stdio
- no ability to update policy
- no ambient authority via inherited env vars

The worker should get:

- an ephemeral workspace
- a broker RPC client
- a guarded subset of conversation and tool context
- optional egress only for explicitly allowed model endpoints if LLM calls remain worker-local

### 4. Per-Run Workspace

Each worker invocation or session should have a dedicated workspace root:

- ephemeral by default
- optionally persisted for explicit workflows
- mounted as the only writable filesystem area available to the worker

This workspace should be separate from:

- the repo root
- config and credentials
- audit storage
- browser profile storage
- MCP-managed state

## Capability Model Changes

The current tool model is already policy-rich, but still broad in places. This proposal adds two refinements.

### Narrower Broker APIs

Prefer narrower actions over broad generic surfaces.

Examples:

- instead of broad `gws` as the default write surface, add brokered higher-level actions for common tasks like `gmail.list_messages`, `gmail.read_message`, `gmail.create_draft`, `gmail.send_message`
- keep generic backdoors like raw MCP or broad provider adapters behind stronger trust tiers and explicit opt-in

### Capability Tokens

Broker calls should carry explicit capability tokens minted by the supervisor:

- scoped to one worker
- scoped to one session or invocation
- scoped to allowed action families
- short-lived

This prevents a compromised worker from holding ambient privilege indefinitely.

## Sandbox Model Changes

### Worker Sandbox

We should add a first-class sandbox profile for agent workers, separate from today's subprocess-backed tool profiles.

Recommended properties:

- read-only bind of application/runtime code where feasible
- dedicated writable workspace
- isolated `HOME`
- fresh `TMPDIR`
- stripped env
- network disabled by default
- optional narrowly scoped network egress only when required

### Broker Sandbox

The broker remains trusted, but its own subprocess-backed tools continue to use current strict sandbox policy:

- `bwrap` on Linux
- Windows helper when available
- strict-mode blocking when strong backends are unavailable

## LLM Placement Options

There are two viable designs.

### Option A: LLM Calls Stay In The Worker

Pros:

- keeps untrusted model output fully inside the low-privilege boundary
- simplest conceptual model

Cons:

- worker needs controlled network egress to provider endpoints
- provider auth material must be delivered carefully

### Option B: LLM Calls Move Behind The Broker

Pros:

- worker has no direct network egress
- provider credentials stay entirely in trusted code

Cons:

- broker now handles raw untrusted model output
- tighter care needed to avoid model output influencing privileged control flow

## Recommendation

Start with **Option A**:

- keep the LLM loop in the worker
- allow worker egress only to configured provider hosts
- provide short-lived provider credentials or signed request capability to the worker

That keeps the most untrusted component inside the least-privileged boundary.

## Provenance And Taint

The article's model is stronger when external data stays marked as untrusted all the way through execution.

GuardianAgent should add first-class provenance metadata to broker/tool results:

- `source = local | remote`
- `trust = internal | external`
- `tainted = true | false`
- `originTool = web_fetch | browser_task | mcp-* | gws | ...`

Policy consequences:

- tainted remote content cannot directly trigger mutating broker calls without stronger policy or approval
- tainted content should not be written to memory or knowledge base without sanitization
- tainted content should not be treated as user intent

## Proposed Rollout

### Phase 0: Boundary Preparation

Goal:

- prepare the codebase for process separation without changing behavior

Work:

- define RPC contracts for tool calls, approvals, memory, and event emission
- separate pure policy/evaluation code from process-local wiring
- define broker-safe payload schemas and redaction rules

Likely touch points:

- [runtime.ts](/mnt/s/Development/GuardianAgent/src/runtime/runtime.ts)
- [executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)

### Phase 1: Broker Process

Goal:

- move ToolExecutor and policy-governed effect surfaces into a distinct broker service/process

Work:

- create broker RPC server
- route tool execution through broker RPC
- keep supervisor responsible for auth, approvals, and audit

Success criteria:

- main app no longer calls tool handlers directly from the agent loop path

### Phase 2: Agent Worker Isolation

Goal:

- run the assistant/model loop inside a sandboxed worker

Work:

- spawn isolated worker with dedicated workspace
- move conversation assembly and tool-calling loop into worker
- replace direct tool access with broker RPC

Success criteria:

- worker has no ambient filesystem/network/credential access beyond explicit sandbox grants

### Phase 3: Narrow Capability Surfaces

Goal:

- reduce dependence on broad generic tools

Work:

- introduce broker-native task APIs for common Gmail, filesystem, browser, and workflow operations
- classify generic tools like MCP and broad `gws` under elevated trust requirements

Success criteria:

- common user actions do not require broad generic capability surfaces

### Phase 4: Taint-Aware Policy

Goal:

- make provenance a policy input, not just an annotation

Work:

- propagate taint labels through tool results, memory, and event payloads
- add policy rules that block tainted-content-driven mutation unless explicitly approved

Success criteria:

- indirect prompt injection from remote content is materially harder to operationalize

## Risks And Tradeoffs

### Complexity

This adds:

- another process boundary
- RPC contracts
- worker lifecycle management
- more operational debugging complexity

That is real cost. It should only be paid if we want a stronger answer than "our tools are guarded."

### Performance

Brokered calls add latency.

Expected impact:

- modest overhead for read-heavy tool flows
- more visible overhead for chat loops with many tool calls

Mitigation:

- batchable RPC calls
- session-local caches
- compact broker payloads

### Cross-Platform Burden

Linux is easiest because `bwrap` already exists.

Hard parts:

- macOS needs a real strong backend
- Windows worker isolation needs to align with the existing helper path

## Recommended First Implementation Slice

The highest-value first slice is:

1. create a broker process around `ToolExecutor`
2. move the assistant tool-calling loop into an isolated worker
3. give the worker an ephemeral workspace and no direct host credentials

That gets the main architectural win without requiring every capability surface to be redesigned on day one.

## Open Questions

1. Should LLM calls remain in the worker or move behind the broker later?
2. Do we want one long-lived worker per user session, or one worker per invocation?
3. Should MCP servers stay broker-local only, with workers never touching stdio-based providers directly?
4. How much of the current `gws` surface should be preserved versus replaced by narrower broker APIs?
5. Do we want taint policy to hard-block, approval-gate, or only warn in the first rollout?

## Recommendation

GuardianAgent should adopt a **brokered agent isolation architecture** as the next major security uplift.

The current design already provides:

- strong policy enforcement
- strong approval and audit paths
- strong subprocess sandboxing where supported

But the next step is clear:

- isolate the agent runtime itself
- remove ambient authority from the planning loop
- force all meaningful host effects through a brokered capability boundary

That is the most important improvement suggested by the article that GuardianAgent does not yet implement.
