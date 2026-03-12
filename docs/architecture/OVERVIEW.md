# GuardianAgent Architecture Overview

## Design Philosophy

GuardianAgent is a **security-first, event-driven AI agent orchestration system**. It is a self-contained orchestrator with curated capabilities, strict guardrails, and a brokered worker boundary for the built-in chat/planner execution path.

The Runtime controls every chokepoint where data flows in or out of an agent. The built-in chat/planner LLM loop is isolated into a brokered worker by default. Supervisor-side framework code still owns admission, audit, approvals, and tool execution. Agents cannot bypass the four-layer defense system that protects users from credential leaks, prompt injection, capability escalation, and data exfiltration.

Core principles:
- **Actively protect users from security mistakes** rather than providing opt-in guardrails
- **Mandatory enforcement at Runtime chokepoints** — not advisory checks that agents opt into
- **Broker the highest-risk execution loop away from the supervisor** — the default chat/planner path runs in a separate worker process
- **Keep the supervisor narrow and authoritative** — admission, audit, approvals, and tools stay supervisor-owned

Current extensions:
- **Native skills layer** for reusable procedural knowledge, templates, and task guidance
- **Managed MCP providers** for curated external capability bundles such as Google Workspace via `gws`
- **Brokered worker execution** for the built-in chat/planner path, enabled by default
- **Strict sandbox availability model** that disables risky tools when strong OS isolation is unavailable

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
│  │  │  ┌────────────┐  Per-step retry + fail-branch            │  │  │
│  │  │  │Conditional │  Array iteration mode for LoopAgent      │  │  │
│  │  │  │   Agent    │                                          │  │  │
│  │  │  └────────────┘                                          │  │  │
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
│  ║               FOUR-LAYER DEFENSE SYSTEM                        ║  │
│  ║                                                                ║  │
│  ║  Layer 1: PROACTIVE (inline, before agent)                     ║  │
│  ║  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐       ║  │
│  ║  │  Input    │→│   Rate    │→│Capability│→│  Secret  │→┐     ║  │
│  ║  │Sanitizer  │ │  Limiter  │ │Controller│ │  Scanner │ │     ║  │
│  ║  └───────────┘ └───────────┘ └──────────┘ └──────────┘ │     ║  │
│  ║  ┌──────────┐  ┌──────────┐  ┌──────────┐                │     ║  │
│  ║  │  Denied  │→ │  Shell   │→ │   SSRF   │←──────────────┘     ║  │
│  ║  │  Path    │  │ Command  │  │Controller│                      ║  │
│  ║  └──────────┘  └──────────┘  └──────────┘                      ║  │
│  ║                                                                ║  │
│  ║  Layer 2: GUARDIAN AGENT (inline LLM, before tool execution)   ║  │
│  ║  ┌───────────────────────┐                                    ║  │
│  ║  │ GuardianAgentService  │  LLM evaluates tool actions        ║  │
│  ║  │ (onPreExecute hook)   │  blocks high/critical risk         ║  │
│  ║  └───────────────────────┘                                    ║  │
│  ║                                                                ║  │
│  ║  Layer 3: OUTPUT (inline, after agent)                         ║  │
│  ║  ┌───────────────┐  ┌───────────────┐                         ║  │
│  ║  │ OutputGuardian │  │ Event Payload │                         ║  │
│  ║  │ (responses)    │  │ Scanner       │                         ║  │
│  ║  └───────────────┘  └───────────────┘                         ║  │
│  ║                                                                ║  │
│  ║  Layer 4: SENTINEL AUDIT (retrospective, scheduled/on-demand)  ║  │
│  ║  ┌───────────────┐  ┌───────────────────┐ ┌──────────────┐   ║  │
│  ║  │ AuditLog      │→ │SentinelAuditService│ │   Audit      │   ║  │
│  ║  │ (ring buffer) │  │ (anomaly + LLM)   │ │ Persistence  │   ║  │
│  ║  └───────┬───────┘  └───────────────────┘ │ (hash chain) │   ║  │
│  ║          └────────────────────────────────▶└──────────────┘   ║  │
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
├── LLM Providers (src/llm/)            — Ollama, Anthropic, OpenAI + 6 OpenAI-compatible via ProviderRegistry
├── Assistant Orchestrator (src/runtime/orchestrator.ts) — per-session queueing + timing state
├── Registry (src/agent/registry.ts)    — agent registration/discovery
├── EventBus (src/queue/event-bus.ts)   — inter-agent events + opt-in classify/policy pipeline hooks
│   └── Event Pipeline (src/queue/event-pipeline.ts) — event category + policy decision primitives
├── Identity (src/runtime/identity.ts)  — channel user → canonical identity mapping
├── Memory (src/runtime/conversation.ts) — SQLite-backed conversation/session persistence
├── Analytics (src/runtime/analytics.ts) — SQLite-backed channel interaction telemetry
├── Quick Actions (src/quick-actions.ts) — structured assistant workflows
├── Skills (src/skills/)                — native procedural knowledge, templates, and references
├── Threat Intel (src/runtime/threat-intel.ts) — watchlist scans, findings triage, response drafting
│   └── Moltbook Connector (src/runtime/moltbook-connector.ts) — hostile-site constrained forum ingestion
├── Connector Framework (assistant.connectors) — Option 2 connector-pack/playbook policy controls
├── Guardian (src/guardian/)             — four-layer defense system
│   ├── guardian.ts                     — admission controller pipeline
│   ├── workflows.ts                    — pure admission decisions (no side effects)
│   ├── operations.ts                   — side-effectful admission operations (logging, result mapping)
│   ├── input-sanitizer.ts             — prompt injection detection (Layer 1)
│   ├── rate-limiter.ts                — request throttling (Layer 1)
│   ├── capabilities.ts               — per-agent permission model (Layer 1)
│   ├── secret-scanner.ts             — 28+ credential patterns (Layer 1 & 3)
│   ├── shell-validator.ts            — POSIX shell tokenizer + command validation (Layer 1)
│   ├── shell-command-controller.ts   — shell command admission controller (Layer 1)
│   ├── ssrf-protection.ts           — centralized SSRF protection + SsrfController (Layer 1)
│   ├── output-guardian.ts             — response redaction (Layer 3)
│   ├── audit-log.ts                   — structured event logging (Layer 2 & 4)
│   ├── audit-persistence.ts          — SHA-256 hash-chained JSONL persistence (Layer 4)
│   └── trust-presets.ts              — predefined security postures (locked/safe/balanced/power)
├── Guardian Agent (src/runtime/sentinel.ts) — inline LLM action evaluation (Layer 2)
├── Sentinel Audit (src/runtime/sentinel.ts) — retrospective anomaly detection (Layer 4)
├── Orchestration (src/agent/orchestration.ts) — SequentialAgent, ParallelAgent, LoopAgent
│   └── ConditionalAgent (src/agent/conditional.ts) — conditional branching orchestration
├── Shared State (src/runtime/shared-state.ts) — per-invocation inter-agent data passing
├── Document Search (src/search/) — native hybrid search (BM25 + vector) over document collections
├── MCP Client (src/tools/mcp-client.ts) — Model Context Protocol tool server consumption
├── Managed MCP Providers               — curated provider wrappers, including Google Workspace via `gws`
├── Eval Framework (src/eval/)           — agent evaluation with metrics and reporting
│   ├── types.ts                        — test case, matcher, and result types
│   ├── metrics.ts                      — content, trajectory, metadata, and safety metrics
│   └── runner.ts                       — test runner with real Runtime dispatch
├── Sentinel (src/agents/sentinel.ts)   — legacy agent (kept for test compat, see src/runtime/sentinel.ts)
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

Four orchestration primitives extend `BaseAgent` to compose sub-agents into structured workflows:

```typescript
// Sequential: pipeline of steps with state passing, per-step retry + fail-branch
const pipeline = new SequentialAgent('scan', 'Security Pipeline', {
  steps: [
    { agentId: 'analyzer', outputKey: 'analysis' },
    { agentId: 'scanner',  inputKey: 'analysis', outputKey: 'vulns',
      retry: { maxRetries: 2, initialDelayMs: 1000, backoffMultiplier: 2 },
      onError: { agentId: 'fallback-scanner' } },
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

// Loop: array iteration mode with configurable concurrency
const processor = new LoopAgent('process', 'Batch Processor', {
  agentId: 'item-handler',
  items: { key: 'itemList', concurrency: 3, collectKey: 'results' },
});

// Conditional: ordered branch evaluation, first match wins
const router = new ConditionalAgent('route', 'Intent Router', {
  branches: [
    { name: 'billing', condition: (s) => s.get('intent') === 'billing', steps: billingSteps },
    { name: 'technical', condition: (s) => s.get('intent') === 'technical', steps: techSteps },
  ],
  defaultSteps: generalSteps,
});
```

Key design: every sub-agent dispatch goes through `ctx.dispatch()` → `Runtime.dispatchMessage()` → full Guardian pipeline. When the target is a built-in chat agent, that dispatch then crosses into the brokered worker path. Orchestration does not create a bypass path.

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

## Native Skills Layer

GuardianAgent includes a native skills foundation to package reusable procedural knowledge, templates, and references without introducing a parallel execution plane.

Design intent:

- skills influence planning and prompt context
- tools and MCP remain the only execution surfaces
- Guardian and sandboxing remain the enforcement boundary

Current implementation:

- `SkillRegistry` loads local skill bundles from configured roots
- `SkillResolver` auto-selects relevant skills for chat requests
- active skill summaries are injected into the system prompt
- active skill IDs are included in chat response metadata
- runtime skill inspection and toggling are available via `/skills` in CLI and `GET/POST /api/skills`
- skill enable/disable updates persist to `assistant.skills.disabledSkills`

Not yet implemented:

- reviewed install flows for third-party skills

See [Native Skills Spec](../specs/SKILLS-SPEC.md).

## Managed Providers

GuardianAgent includes a managed MCP provider foundation for complex ecosystems where both tool schemas and procedural guidance matter.

The first managed provider is Google Workspace:

- execution via `gws mcp`
- safety and approvals via ToolExecutor + Guardian
- workflow guidance via native Google skills

Current implementation:

- config-driven managed provider materialization for `gws`
- default service scope of Gmail, Calendar, and Drive
- optional skill exposure tied to successful managed-provider enablement
- provider-linked Google skills expose readiness state through the skills CLI/API
- Google Workspace MCP tools are mapped into Gmail/Calendar/Drive/Docs/Sheets capability checks before execution

Not yet implemented:

- richer provider diagnostics in UI
- multi-account selection flow

See [Google Workspace Integration Spec](../specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md).

## Brokered Execution Boundary

GuardianAgent now defaults to brokered worker execution for the built-in chat/planner flow.

Supervisor responsibilities:

- config loading
- Guardian admission checks
- audit logging
- tool execution
- approval state
- worker lifecycle

Worker responsibilities:

- prompt assembly
- conversation-context assembly from supervisor-provided state
- LLM chat/tool loop
- pending-approval continuation

What this does not mean:

- orchestration agents are not moved into the worker
- every arbitrary developer-authored code path is not automatically sandboxed
- degraded hosts do not imply strong filesystem or network namespace isolation

See [Brokered Agent Isolation Spec](../specs/BROKERED-AGENT-ISOLATION-SPEC.md).

## Sandbox Availability

The current subprocess sandbox layer now uses an explicit availability model:

- detect whether strong sandboxing is available on the current host
- fail closed for risky tool classes in strict mode
- surface warnings and disable reasons in CLI, web, and chat paths

Next stage:

- ship the native Windows sandbox helper binary that matches the implemented adapter contract
- add native macOS strong-backend support

See [Security](../../SECURITY.md) for the security details and remaining gaps.

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
    Runtime routes execution
           │
           ▼
┌──────────────────────────────┐
│ Brokered worker path         │
│ (built-in chat/planner)      │
│ or supervisor handler path   │
│ (framework/orchestration)    │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ LAYER 2: Guardian Agent      │
│ (inline LLM evaluation)     │
│                              │
│ Evaluate tool actions via LLM│──▶ Block high/critical risk
│ Log to AuditLog              │    (configurable: fail-open/closed)
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ LAYER 3: Output Guardian     │
│                              │
│ Scan response for secrets    │──▶ Redact with [REDACTED]
│ Log to AuditLog              │    (configurable: redact or block)
└──────────┬───────────────────┘
           │
           ▼
    Response to User

           ┌──────────────────────────────┐
           │ LAYER 4: Sentinel Audit      │
           │ (cron schedule / on-demand)  │
           │                              │
           │ Analyze AuditLog             │
           │ Detect anomaly patterns      │
           │ Optional LLM-enhanced review │
           └──────────────────────────────┘
```

## Security: Mandatory Enforcement at Runtime Chokepoints

All security enforcement is mandatory. The Runtime controls every path where data enters or leaves an agent:

- **Message input** — Guardian pipeline runs before the agent sees the message
- **Chat agent execution** — The built-in chat/planner loop runs in a brokered worker by default; it reaches tools and approvals only through broker RPC
- **LLM access** — Agents receive a `GuardedLLMProvider`, not the raw provider. Every LLM response is scanned for secrets and tracked for token usage automatically.
- **Response output** — After the agent responds, the Runtime scans for secrets and redacts before the response reaches anyone
- **Event emission** — `ctx.emit()` scans payloads for secrets before dispatch
- **Resource limits** — Concurrent limits, queue depth, token rate limits, and wall-clock budgets enforced before every invocation
- **Context immutability** — Agent contexts are frozen. Agents cannot modify their own capabilities.

There is no default `ctx.fs`, `ctx.http`, or `ctx.exec`. The agent's framework-managed interaction points are `ctx.llm` (guarded), `ctx.emit()` (scanned), `ctx.dispatch()` (Guardian-checked per call), and returning a response (scanned). For built-in chat execution, these interactions occur inside the worker-backed brokered path.

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

See [SECURITY.md](../../SECURITY.md) for comprehensive security documentation.

See [GUARDIAN-API.md](./GUARDIAN-API.md) for API reference.

## Agent Lifecycle

```
Created → Ready → Running ⟷ Idle
                      │
                      ▼
                   Errored (with exponential backoff)
                   │
                   ├──▼ (on backoff expiry)
                   │ Ready (watchdog retry)
                   │
                   ▼ (on user message)
                  Ready (auto-recovery)
```

- **Created → Ready**: On `registerAgent()`, agent is initialized
- **Ready → Running**: On first invocation (message, event, or schedule)
- **Running → Idle**: After handler completes successfully
- **Idle → Running**: On next invocation
- **Running → Errored**: On handler error; exponential backoff [30s, 1m, 5m, 15m, 60m]
- **Errored → Ready**: On watchdog retry after backoff expiry (continues indefinitely at max backoff)
- **Errored → Ready**: On user message dispatch — auto-recovery transitions the agent back to Ready so the user gets the actual error instead of a dead-end "cannot accept work" rejection
- **Any → Dead**: Explicit unregister/shutdown path only

## LLM Provider Layer

Unified `LLMProvider` interface for **Ollama**, **Anthropic**, and **OpenAI**:

- No LangChain — direct SDK calls for full debuggability
- Ollama uses OpenAI-compatible `/v1/chat/completions` + native `/api/tags`
- Both `chat()` (full response) and `stream()` (AsyncGenerator) methods
- Each agent gets its own provider assignment via config
- **Failover Provider** (`src/llm/failover-provider.ts`): wraps multiple providers with priority-based failover and per-provider circuit breakers. On transient/quota/timeout errors, automatically retries with the next available provider.
- **Circuit Breaker** (`src/llm/circuit-breaker.ts`): per-provider state machine (closed → open → half_open) that prevents cascading failures by short-circuiting requests to unhealthy providers.

## Channel Adapters

- **CLI**: Interactive readline prompt with `/help`, `/agents`, `/status`, `/factory-reset`, `/quit`
- **Telegram**: grammy framework, polling mode, `allowed_chat_ids` filtering
- **Web**: Node.js HTTP server with REST API (`/health`, `/api/status`, `/api/message`, `/api/message/stream`, `/api/auth/session`, `/api/factory-reset`)
- **Web Auth**: `channels.web.auth.mode` is enforced as `bearer_required`; browser clients can use HttpOnly `guardianagent_sid` session cookies after bearer authentication
- **Live Dashboard Invalidation**: mutating web/API operations emit SSE `ui.invalidate` events so the active dashboard page refreshes in place without a manual browser reload
- **Assistant State**: web Dashboard (assistant state section) and CLI `/assistant` orchestration queue/latency visibility, priority queue stats, request-step traces, job tracking, and policy-decision telemetry
- **Configuration Center**: web `#/config` (Providers/Tools/Policy/Settings tabs) + CLI `/config` onboarding/provider/channel configuration flow (no setup wizard)
- **Tools Control Plane**: web Configuration > Tools tab + CLI `/tools` for tool execution, manual approvals, policy mode, and sandbox boundaries
- **Connector Studio (Option 2)**: web Network > Connectors tab + configurable connector packs + playbook controls via `assistant.connectors` (runtime-ready policy layer)
- **Automations**: web `#/automations` page — unified automation catalog merging playbooks + scheduled tasks, with single-tool and pipeline creation, optional cron scheduling, examples, clone, run history, per-step output inspection, and engine settings. The assistant can also create automations conversationally via `workflow_upsert` and `task_create` tools
- **Network History**: web `#/network` includes recent network run history plus inline output views for quick scans and threat checks, so scheduled and manual network actions are inspectable beyond the device inventory snapshot
- **Threat Intel**: web Security > Threat Intel tab, CLI `/intel`, Telegram `/intel` command surfaces
