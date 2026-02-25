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
│  ║  ┌──────────┐                                           │     ║  │
│  ║  │  Denied  │←──────────────────────────────────────────┘     ║  │
│  ║  │  Path    │                                                  ║  │
│  ║  └──────────┘                                                  ║  │
│  ║                                                                ║  │
│  ║  Layer 2: OUTPUT (inline, after agent)                         ║  │
│  ║  ┌───────────────┐  ┌───────────────┐                         ║  │
│  ║  │ OutputGuardian │  │ Event Payload │                         ║  │
│  ║  │ (responses)    │  │ Scanner       │                         ║  │
│  ║  └───────────────┘  └───────────────┘                         ║  │
│  ║                                                                ║  │
│  ║  Layer 3: SENTINEL (retrospective, scheduled)                  ║  │
│  ║  ┌───────────────┐  ┌───────────────┐                         ║  │
│  ║  │ AuditLog      │→ │ SentinelAgent │                         ║  │
│  ║  │ (ring buffer) │  │ (anomaly det) │                         ║  │
│  ║  └───────────────┘  └───────────────┘                         ║  │
│  ═══════════════════════════════════════════════════════════════════  │
│                                │                                      │
│  ┌─────────────────────────────▼──────────────────────────────────┐  │
│  │                    Channel Adapters                             │  │
│  │  ┌──────┐  ┌──────────┐  ┌──────┐                             │  │
│  │  │ CLI  │  │ Telegram  │  │ Web  │                             │  │
│  │  └──────┘  └──────────┘  └──────┘                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

## Component Map

```
Runtime (src/runtime/runtime.ts)
├── Config (src/config/)                — YAML config with env var interpolation
├── LLM Providers (src/llm/)            — Ollama, Anthropic, OpenAI
├── Registry (src/agent/registry.ts)    — agent registration/discovery
├── EventBus (src/queue/event-bus.ts)   — inter-agent events (immediate dispatch)
├── Identity (src/runtime/identity.ts)  — channel user → canonical identity mapping
├── Memory (src/runtime/conversation.ts) — SQLite-backed conversation/session persistence
├── Analytics (src/runtime/analytics.ts) — SQLite-backed channel interaction telemetry
├── Quick Actions (src/quick-actions.ts) — structured assistant workflows
├── Threat Intel (src/runtime/threat-intel.ts) — watchlist scans, findings triage, response drafting
│   └── Moltbook Connector (src/runtime/moltbook-connector.ts) — hostile-site constrained forum ingestion
├── Guardian (src/guardian/)             — three-layer defense system
│   ├── guardian.ts                     — admission controller pipeline
│   ├── input-sanitizer.ts             — prompt injection detection (Layer 1)
│   ├── rate-limiter.ts                — request throttling (Layer 1)
│   ├── capabilities.ts               — per-agent permission model (Layer 1)
│   ├── secret-scanner.ts             — 28+ credential patterns (Layer 1 & 2)
│   ├── output-guardian.ts             — response redaction (Layer 2)
│   └── audit-log.ts                   — structured event logging (Layer 3)
├── Sentinel (src/agents/sentinel.ts)   — retrospective anomaly detection (Layer 3)
├── Budget (src/runtime/budget.ts)      — compute budget tracking
├── Watchdog (src/runtime/watchdog.ts)  — stall detection (timestamp-based)
├── Scheduler (src/runtime/scheduler.ts)— cron scheduling (croner)
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

There is no `ctx.fs`, `ctx.http`, or `ctx.exec`. The agent's only interaction points are `ctx.llm` (guarded), `ctx.emit()` (scanned), and returning a response (scanned).

See [SECURITY.md](./SECURITY.md) for comprehensive security documentation.

See [GUARDIAN-API.md](./GUARDIAN-API.md) for API reference.

## Agent Lifecycle

```
Created → Ready → Running ⟷ Idle
                      │
                      ▼
                   Errored (with exponential backoff)
                      │
                      ▼ (after max retries)
                    Dead
```

- **Created → Ready**: On `registerAgent()`, agent is initialized
- **Ready → Running**: On first invocation (message, event, or schedule)
- **Running → Idle**: After handler completes successfully
- **Idle → Running**: On next invocation
- **Running → Errored**: On handler error; exponential backoff [30s, 1m, 5m, 15m, 60m]
- **Errored → Dead**: After 5 consecutive failures

## LLM Provider Layer

Unified `LLMProvider` interface for **Ollama**, **Anthropic**, and **OpenAI**:

- No LangChain — direct SDK calls for full debuggability
- Ollama uses OpenAI-compatible `/v1/chat/completions` + native `/api/tags`
- Both `chat()` (full response) and `stream()` (AsyncGenerator) methods
- Each agent gets its own provider assignment via config

## Channel Adapters

- **CLI**: Interactive readline prompt with `/help`, `/agents`, `/status`, `/quit`
- **Telegram**: grammy framework, polling mode, `allowed_chat_ids` filtering
- **Web**: Node.js HTTP server with REST API (`/health`, `/api/status`, `/api/message`)
- **Setup Wizard**: web `#/setup` and CLI `/setup` onboarding flow
- **Threat Intel**: web `#/intel`, CLI `/intel`, Telegram `/intel` command surfaces
