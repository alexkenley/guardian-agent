# GuardianAgent Architecture Overview

## Design Philosophy

GuardianAgent is a **security-first, event-driven AI agent orchestration system**. It is a self-contained orchestrator where agents are developer-authored TypeScript classes with curated capabilities and strict guardrails on what they can and cannot do.

The agents are your code. The LLM output is the untrusted component. All security enforcement is **mandatory at the Runtime level** — the Runtime controls every chokepoint where data flows in or out of an agent. Agents cannot bypass the three-layer defense system that protects users from credential leaks, prompt injection, capability escalation, and data exfiltration.

Core principles:
- **Actively protect users from security mistakes** rather than providing opt-in guardrails
- **Mandatory enforcement at Runtime chokepoints** — not advisory checks that agents opt into
- **The LLM is untrusted, not the agent code** — enforcement targets the data path where risk lives

## Architecture Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│                              Runtime                                  │
│                                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  Config   │  │   LLM    │  │ Watchdog  │  │  Budget   │            │
│  │  Loader   │  │ Providers│  │ (stalls)  │  │ Tracker   │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │              │              │              │                   │
│  ┌────▼──────────────▼──────────────▼──────────────▼──────────────┐  │
│  │                       Agent Registry                           │  │
│  │  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐        │  │
│  │  │ Agent A  │  │ Agent B  │  │ Agent C  │  │ Sentinel  │        │  │
│  │  └────┬────┘  └────┬────┘  └────┬─────┘  └────┬─────┘        │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │  Orchestration Agents (optional composition layer)       │  │  │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐         │  │  │
│  │  │  │ Sequential │  │  Parallel  │  │    Loop    │         │  │  │
│  │  │  │   Agent    │  │   Agent    │  │   Agent    │         │  │  │
│  │  │  └────────────┘  └────────────┘  └────────────┘         │  │  │
│  │  │  Uses ctx.dispatch() → full Guardian pipeline per step   │  │  │
│  │  │  SharedState: per-invocation, orchestrator-owned         │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └───────┼─────────────┼────────────┼──────────────┼──────────────┘  │
│          │             │            │              │                   │
│  ┌───────▼─────────────▼────────────▼──────────────▼──────────────┐  │
│  │                       EventBus                                 │  │
│  │  Immediate async dispatch, type & target routing               │  │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                                │                                      │
│  ═══════════════════════════════════════════════════════════════════  │
│  ║               THREE-LAYER DEFENSE SYSTEM                       ║  │
│  ║                                                                ║  │
│  ║  Layer 1: PROACTIVE (inline, before agent)                     ║  │
│  ║  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐       ║  │
│  ║  │  Input    │→│   Rate    │→│Capability│→│  Secret  │→┐     ║  │
│  ║  │Sanitizer  │ │  Limiter  │ │Controller│ │  Scanner │ │     ║  │
│  ║  └───────────┘ └───────────┘ └──────────┘ └──────────┘ │     ║  │
│  ║  ┌──────────┐  ┌──────────┐                              │     ║  │
│  ║  │  Denied  │→ │  Shell   │←─────────────────────────────┘     ║  │
│  ║  │  Path    │  │ Command  │                                    ║  │
│  ║  └──────────┘  └──────────┘                                    ║  │
│  ║                                                                ║  │
│  ║  Layer 2: OUTPUT (inline, after agent)                         ║  │
│  ║  ┌───────────────┐  ┌───────────────┐                         ║  │
│  ║  │ OutputGuardian │  │ Event Payload │                         ║  │
│  ║  │ (responses)    │  │ Scanner       │                         ║  │
│  ║  └───────────────┘  └───────────────┘                         ║  │
│  ║                                                                ║  │
│  ║  Layer 3: SENTINEL (retrospective, scheduled)                  ║  │
│  ║  ┌───────────────┐  ┌───────────────┐  ┌──────────────┐      ║  │
│  ║  │ AuditLog      │→ │ SentinelAgent │  │   Audit      │      ║  │
│  ║  │ (ring buffer) │  │ (anomaly det) │  │ Persistence  │      ║  │
│  ║  └───────┬───────┘  └───────────────┘  │ (hash chain) │      ║  │
│  ║          └────────────────────────────▶ └──────────────┘      ║  │
│  ═══════════════════════════════════════════════════════════════════  │
│                                │                                      │
│  ┌─────────────────────────────▼──────────────────────────────────┐  │
│  │                    Channel Adapters                             │  │
│  │  ┌──────┐  ┌──────────┐  ┌──────┐                             │  │
│  │  │ CLI  │  │ Telegram  │  │ Web  │                             │  │
│  │  └──────┘  └──────────┘  └──────┘                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    External Integrations                       │  │
│  │  ┌──────────────────┐  ┌──────────────────┐                   │  │
│  │  │  MCP Client Mgr  │  │  Eval Runner     │                   │  │
│  │  │  (tool servers)  │  │  (agent testing)  │                   │  │
│  │  └──────────────────┘  └──────────────────┘                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

## Component Map

```
Runtime (src/runtime/runtime.ts)
├── Config (src/config/)                — YAML config with env var interpolation
├── LLM Providers (src/llm/)            — Ollama, Anthropic, OpenAI
├── Assistant Orchestrator (src/runtime/orchestrator.ts) — per-session queueing + timing state
├── Registry (src/agent/registry.ts)    — agent registration/discovery
├── EventBus (src/queue/event-bus.ts)   — inter-agent events (immediate dispatch)
├── Identity (src/runtime/identity.ts)  — channel user → canonical identity mapping
├── Memory (src/runtime/conversation.ts) — SQLite-backed conversation/session persistence
├── Analytics (src/runtime/analytics.ts) — SQLite-backed channel interaction telemetry
├── Quick Actions (src/quick-actions.ts) — structured assistant workflows
├── Threat Intel (src/runtime/threat-intel.ts) — watchlist scans, findings triage, response drafting
│   └── Moltbook Connector (src/runtime/moltbook-connector.ts) — hostile-site constrained forum ingestion
├── Connector Framework (assistant.connectors) — Option 2 connector-pack/playbook policy controls
├── Guardian (src/guardian/)             — three-layer defense system
│   ├── guardian.ts                     — admission controller pipeline
│   ├── input-sanitizer.ts             — prompt injection detection (Layer 1)
│   ├── rate-limiter.ts                — request throttling (Layer 1)
│   ├── capabilities.ts               — per-agent permission model (Layer 1)
│   ├── secret-scanner.ts             — 28+ credential patterns (Layer 1 & 2)
│   ├── shell-validator.ts            — POSIX shell tokenizer + command validation (Layer 1)
│   ├── shell-command-controller.ts   — shell command admission controller (Layer 1)
│   ├── output-guardian.ts             — response redaction (Layer 2)
│   ├── audit-log.ts                   — structured event logging (Layer 3)
│   ├── audit-persistence.ts          — SHA-256 hash-chained JSONL persistence (Layer 3)
│   └── trust-presets.ts              — predefined security postures (locked/safe/balanced/power)
├── Orchestration (src/agent/orchestration.ts) — SequentialAgent, ParallelAgent, LoopAgent
├── Shared State (src/runtime/shared-state.ts) — per-invocation inter-agent data passing
├── MCP Client (src/tools/mcp-client.ts) — Model Context Protocol tool server consumption
├── Eval Framework (src/eval/)           — agent evaluation with metrics and reporting
│   ├── types.ts                        — test case, matcher, and result types
│   ├── metrics.ts                      — content, trajectory, metadata, and safety metrics
│   └── runner.ts                       — test runner with real Runtime dispatch
├── Sentinel (src/agents/sentinel.ts)   — retrospective anomaly detection (Layer 3)
├── Budget (src/runtime/budget.ts)      — compute budget tracking
├── Watchdog (src/runtime/watchdog.ts)  — stall detection (timestamp-based)
├── Scheduler (src/runtime/scheduler.ts)— cron scheduling (croner)
├── ScheduledTasks (src/runtime/scheduled-tasks.ts) — unified CRUD scheduling for tools/playbooks
└── Channels (src/channels/)            — CLI, Telegram, Web adapters
```

## Agent Model

Agents are **async classes** that extend `BaseAgent` and override handlers:

```typescript
class MyAgent extends BaseAgent {
  constructor() {
    super('my-agent', 'My Agent', {
      handleMessages: true,
      handleEvents: true,
    });
  }

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    // ctx.checkAction() — request Guardian permission for sensitive actions
    // ctx.capabilities  — read-only list of granted capabilities
    // ctx.emit()        — send events (payload scanned for secrets)
    // ctx.llm           — assigned LLM provider
    const response = await ctx.llm.chat([
      { role: 'user', content: message.content },
    ]);
    return { content: response.content };
  }

  async onEvent(event: AgentEvent, ctx: AgentContext): Promise<void> {
    // Process inter-agent event
  }

  async onSchedule(ctx: ScheduleContext): Promise<void> {
    // Periodic work (ctx.auditLog available for security agents)
  }
}
```

This gives us:
- **Simple async/await** — no generators, no cooperative scheduling complexity
- **Natural error handling** via try/catch and the runtime's error pipeline
- **Budget enforcement** via wall-clock tracking per invocation
- **Lifecycle management** via explicit state machine
- **Mandatory security** — the Runtime checks every message before it reaches the agent, scans every LLM response via GuardedLLMProvider, scans every outbound response before it reaches the user, and scans every inter-agent event payload before dispatch

### Orchestration Agents

Three orchestration primitives extend `BaseAgent` to compose sub-agents into structured workflows:

```typescript
// Sequential: pipeline of steps with state passing
const pipeline = new SequentialAgent('scan', 'Security Pipeline', {
  steps: [
    { agentId: 'analyzer', outputKey: 'analysis' },
    { agentId: 'scanner',  inputKey: 'analysis', outputKey: 'vulns' },
    { agentId: 'reporter', inputKey: 'vulns',    outputKey: 'report' },
  ],
});

// Parallel: fan-out with optional concurrency limit
const research = new ParallelAgent('search', 'Multi-Source', {
  steps: [
    { agentId: 'web-search',  outputKey: 'web' },
    { agentId: 'doc-search',  outputKey: 'docs' },
  ],
  maxConcurrency: 3,
});

// Loop: iterate until condition or maxIterations
const refiner = new LoopAgent('refine', 'Refiner', {
  agentId: 'editor',
  maxIterations: 5,
  condition: (i, resp) => !resp?.content.includes('[DONE]'),
});
```

Key design: every sub-agent dispatch goes through `ctx.dispatch()` → `Runtime.dispatchMessage()` → full Guardian pipeline. Orchestration does not create a bypass path.

See [Orchestration Agents Spec](../specs/ORCHESTRATION-AGENTS-SPEC.md) for full details.

### MCP Client

The MCP (Model Context Protocol) client consumes tools from external MCP-compatible servers:

```typescript
const manager = new MCPClientManager();
await manager.addServer({
  id: 'filesystem', name: 'FS Tools',
  transport: 'stdio',
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

// Tool names are namespaced: mcp:filesystem:read_file
const result = await manager.callTool('mcp:filesystem:read_file', { path: '/a.txt' });
```

MCP tools are classified as `network` risk and all calls pass through Guardian. See [MCP Client Spec](../specs/MCP-CLIENT-SPEC.md).

### Agent Evaluation Framework

The eval framework tests agent behavior through the real Runtime (Guardian active):

```typescript
const runner = new EvalRunner({ runtime });
const suite = await loadEvalSuite('tests/assistant.eval.json');
const result = await runner.runSuite(suite.name, suite.tests);
console.log(formatEvalReport(result));
```

Supports content matchers, tool trajectory validation, metadata checks, and 4 independent safety metrics. See [Evaluation Framework Spec](../specs/EVAL-FRAMEWORK-SPEC.md).

### Shared State

`SharedState` enables inter-agent data passing within orchestration patterns:

- **Owned by orchestrator** — sub-agents cannot read or write
- **Scoped to invocation** — fresh state per `onMessage()` call, no persistence
- **Temp key convention** — `temp:` prefixed keys cleaned up via `clearTemp()`

See [Shared State Spec](../specs/SHARED-STATE-SPEC.md).

## Message Flow with Security

```
User Message
    │
    ▼
┌──────────────────────────────┐
│ LAYER 1: Proactive Guardian  │
│                              │
│ 1. InputSanitizer            │──▶ Strip invisible Unicode
│    (mutating)                │    Score injection signals
│                              │    Block if score ≥ threshold
│ 2. RateLimiter               │──▶ Check burst/minute/hour
│    (validating)              │    Per-agent sliding windows
│                              │
│ 3. CapabilityController      │──▶ Agent has permission?
│ 4. SecretScanController      │──▶ Content contains secrets?
│ 5. DeniedPathController      │──▶ Path is sensitive?
└──────────┬───────────────────┘
           │ ✓ allowed
           ▼
    Agent.onMessage()
           │
           ▼
┌──────────────────────────────┐
│ LAYER 2: Output Guardian     │
│                              │
│ Scan response for secrets    │──▶ Redact with [REDACTED]
│ Log to AuditLog              │    (configurable: redact or block)
└──────────┬───────────────────┘
           │
           ▼
    Response to User

           ┌──────────────────────────────┐
           │ LAYER 3: Sentinel Agent      │
           │ (runs on cron schedule)      │
           │                              │
           │ Analyze AuditLog             │
           │ Detect anomaly patterns      │
           │ Optional LLM-enhanced review │
           └──────────────────────────────┘
```

## Security: Mandatory Enforcement at Runtime Chokepoints

All security enforcement is mandatory. The Runtime controls every path where data enters or leaves an agent:

- **Message input** — Guardian pipeline runs before the agent sees the message
- **LLM access** — Agents receive a `GuardedLLMProvider`, not the raw provider. Every LLM response is scanned for secrets and tracked for token usage automatically.
- **Response output** — After the agent responds, the Runtime scans for secrets and redacts before the response reaches anyone
- **Event emission** — `ctx.emit()` scans payloads for secrets before dispatch
- **Resource limits** — Concurrent limits, queue depth, token rate limits, and wall-clock budgets enforced before every invocation
- **Context immutability** — Agent contexts are frozen. Agents cannot modify their own capabilities.

There is no `ctx.fs`, `ctx.http`, or `ctx.exec`. The agent's only interaction points are `ctx.llm` (guarded), `ctx.emit()` (scanned), `ctx.dispatch()` (Guardian-checked per call), and returning a response (scanned).

### Orchestration Message Flow

When an orchestration agent dispatches to sub-agents, each dispatch passes through the full security pipeline:

```
SequentialAgent.onMessage()
    │
    ▼
  SharedState created (orchestrator-owned)
    │
    ├── ctx.dispatch('step-1', msg)
    │       │
    │       ▼
    │     LAYER 1: Guardian Pipeline (full check)
    │       │ ✓
    │       ▼
    │     step-1.onMessage()
    │       │
    │       ▼
    │     LAYER 2: OutputGuardian (scan response)
    │       │
    │       ▼
    │     state.set('step-1', response)
    │
    ├── ctx.dispatch('step-2', enrichedMsg)
    │       │
    │       ▼
    │     LAYER 1 → step-2.onMessage() → LAYER 2
    │       │
    │       ▼
    │     state.set('step-2', response)
    │
    ▼
  state.clearTemp()
  Return final response
```

See [SECURITY.md](./SECURITY.md) for comprehensive security documentation.

See [GUARDIAN-API.md](./GUARDIAN-API.md) for API reference.

## Agent Lifecycle

```
Created → Ready → Running ⟷ Idle
                      │
                      ▼
                   Errored (with exponential backoff)
                   │     │
                   │     ▼ (after max retries)
                   │   Dead
                   │
                   ▼ (on user message)
                  Ready (auto-recovery)
```

- **Created → Ready**: On `registerAgent()`, agent is initialized
- **Ready → Running**: On first invocation (message, event, or schedule)
- **Running → Idle**: After handler completes successfully
- **Idle → Running**: On next invocation
- **Running → Errored**: On handler error; exponential backoff [30s, 1m, 5m, 15m, 60m]
- **Errored → Ready**: On user message dispatch — auto-recovery transitions the agent back to Ready so the user gets the actual error instead of a dead-end "cannot accept work" rejection
- **Errored → Dead**: After 5 consecutive failures (via watchdog backoff, not user messages)

## LLM Provider Layer

Unified `LLMProvider` interface for **Ollama**, **Anthropic**, and **OpenAI**:

- No LangChain — direct SDK calls for full debuggability
- Ollama uses OpenAI-compatible `/v1/chat/completions` + native `/api/tags`
- Both `chat()` (full response) and `stream()` (AsyncGenerator) methods
- Each agent gets its own provider assignment via config
- **Failover Provider** (`src/llm/failover-provider.ts`): wraps multiple providers with priority-based failover and per-provider circuit breakers. On transient/quota/timeout errors, automatically retries with the next available provider.
- **Circuit Breaker** (`src/llm/circuit-breaker.ts`): per-provider state machine (closed → open → half_open) that prevents cascading failures by short-circuiting requests to unhealthy providers.

## Channel Adapters

- **CLI**: Interactive readline prompt with `/help`, `/agents`, `/status`, `/quit`
- **Telegram**: grammy framework, polling mode, `allowed_chat_ids` filtering
- **Web**: Node.js HTTP server with REST API (`/health`, `/api/status`, `/api/message`)
- **Web Auth**: `channels.web.auth.mode` supports `bearer_required`, `localhost_no_auth`, or `disabled`; if no token is configured, runtime can generate an ephemeral bearer token per process start
- **Assistant State**: web Dashboard (assistant state section) and CLI `/assistant` orchestration queue/latency visibility, priority queue stats, request-step traces, job tracking, and policy-decision telemetry
- **Configuration Center**: web `#/config` (Providers/Tools/Policy/Settings tabs) + CLI `/config` onboarding/provider/channel configuration flow (no setup wizard)
- **Tools Control Plane**: web Configuration > Tools tab + CLI `/tools` for tool execution, manual approvals, policy mode, and sandbox boundaries
- **Connector Studio (Option 2)**: web Network > Connectors tab + configurable connector packs + playbook controls via `assistant.connectors` (runtime-ready policy layer)
- **Operations**: web `#/operations` page — unified scheduled tasks for any tool or playbook with CRUD, presets, run history, and EventBus integration (`ScheduledTaskService`)
- **Threat Intel**: web Security > Threat Intel tab, CLI `/intel`, Telegram `/intel` command surfaces
