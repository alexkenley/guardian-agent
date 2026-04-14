# GuardianAgent Architecture Overview

## Design Philosophy

GuardianAgent is a **security-first, event-driven AI agent orchestration system**. It is a self-contained orchestrator with curated capabilities, strict guardrails, and a brokered worker boundary for the built-in chat/planner execution path.

The Runtime controls every chokepoint where data flows in or out of an agent. The built-in chat/planner LLM loop is isolated into a brokered worker by default. Supervisor-side framework code still owns admission, audit, approvals, and tool execution. Agents cannot bypass the four-layer defense system that protects users from credential leaks, prompt injection, capability escalation, and data exfiltration.

Current runtime hardening also treats content trust and authority as first-class execution inputs. Remote/tool output is classified before reinjection, durable memory carries trust/quarantine state, scheduled automations run with bounded authority, and broken tools are stopped by per-chain runaway budgets before they can overspend.

Conversational automation creation is now gateway-routed and compiler-driven. The `IntentGateway` decides whether a request is automation authoring, automation control, browser work, workspace work, search, coding, or general assistant behavior. It also decides whether the current turn is a new request, follow-up, clarification answer, or correction, and can restate a corrected actionable request before execution continues. Internally, that gateway is now being split into staged modules under `src/runtime/intent/` so prompt-profile selection, route-scoped entity repair, normalization, and workload derivation can evolve without growing the facade into another monolith. In Auto mode, Guardian now also chooses the local vs external chat tier from that structured gateway result instead of raw-text routing heuristics. Automation authoring requests then compile into a typed `AutomationIR`, are repaired and validated, and persist through the canonical automation control-plane contract (`automation_save`) before the generic chat/tool loop runs. This path is shared by both the direct runtime path and the brokered worker path, so agent isolation does not change automation semantics.

Gateway-first routing is now also a hard runtime invariant for normal turns. Every normal user turn goes through the `IntentGateway` before any direct capability lane runs. Low-confidence `general_assistant` / `unknown` results and gateway-unavailable states do not auto-enter browser, automation, workspace, or coding direct lanes. Guardian falls back to normal assistant handling or a bounded degraded path instead of heuristic lane capture.

Blocked-work state is owned by one shared pending-action slot per logical surface. Unrelated turns do not clear that slot, and unrelated replies do not re-render blocker UI inline unless the current response itself carries `response.metadata.pendingAction`. If a second blocked request arrives while a slot is already active, Guardian asks whether to switch the slot instead of silently overwriting it.

Deterministic workflows are also no longer just stored step arrays at execution time. The workflow runtime compiles them into a graph-backed run model with stable `runId`s, node-level orchestration events, checkpointed state transitions, and persisted resume context for approval-gated runs. This gives Guardian a cleaner foundation for approval interrupts, richer run history, and replay-safe deterministic resume.

Multi-agent delegation is now contract-bound instead of implicit. Orchestration steps can declare handoff contracts, and runtime dispatch validates those contracts, filters context, preserves taint deliberately, and blocks approval-gated or capability-invalid handoffs before the target agent executes. Guardian also ships reusable orchestration recipes for role-separated flows such as `planner -> executor -> validator` and `research -> draft -> verify`. Scheduled/background execution keeps a per-task active-run lock so the same automation cannot overlap itself and duplicate side effects.

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
│  ║  │ (trust + redact)│ │ Scanner       │                         ║  │
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
├── Intent Gateway (src/runtime/intent-gateway.ts) — authoritative top-level direct-action route classification plus Auto-mode tier preference inputs
├── Automation Authoring + Control Plane (src/runtime/automation-authoring.ts, src/runtime/automation-prerouter.ts, src/runtime/automation-control-prerouter.ts, src/runtime/automation-runtime-service.ts) — natural-language automation requests -> canonical automation contract
├── Skills (src/skills/)                — native procedural knowledge, templates, and references
├── Threat Intel (src/runtime/threat-intel.ts) — watchlist scans, findings triage, response drafting
│   └── Moltbook Connector (src/runtime/moltbook-connector.ts) — hostile-site constrained forum ingestion
├── Connector Framework (assistant.connectors) — access profiles, workflow engine settings, and connector-backed automation execution controls
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
│   ├── output-guardian.ts             — trust classification, quarantined reinjection suppression, and response redaction (Layer 3)
│   ├── audit-log.ts                   — structured event logging (Layer 2 & 4)
│   ├── audit-persistence.ts          — SHA-256 hash-chained JSONL persistence (Layer 4)
│   └── trust-presets.ts              — predefined security postures (locked/safe/balanced/power)
├── Guardian Agent (src/runtime/sentinel.ts) — inline LLM action evaluation (Layer 2)
├── Sentinel Audit (src/runtime/sentinel.ts) — retrospective anomaly detection (Layer 4)
├── Orchestration (src/agent/orchestration.ts) — SequentialAgent, ParallelAgent, LoopAgent
│   ├── ConditionalAgent (src/agent/conditional.ts) — conditional branching orchestration
│   └── Recipes (src/agent/recipes.ts) — reusable planner/executor/reviewer workflow templates
├── Shared State (src/runtime/shared-state.ts) — per-invocation inter-agent data passing
├── Document Search (src/search/) — native hybrid search (BM25 + vector) over document collections
├── MCP Client (src/tools/mcp-client.ts) — Model Context Protocol tool server consumption
├── Native Google Service (src/google/)  — direct googleapis SDK integration (OAuth PKCE, encrypted tokens)
├── Managed MCP Providers               — curated provider wrappers, including Google Workspace via `gws` CLI (legacy)
├── Eval Framework (src/eval/)           — agent evaluation with metrics and reporting
│   ├── types.ts                        — test case, matcher, and result types
│   ├── metrics.ts                      — content, trajectory, metadata, workflow, evidence, and safety metrics
│   └── runner.ts                       — test runner with real Runtime dispatch
├── Sentinel (src/agents/sentinel.ts)   — legacy agent (kept for test compat, see src/runtime/sentinel.ts)
├── Budget (src/runtime/budget.ts)      — compute budget tracking, schedule caps, and budget exhaustion decisions
├── Watchdog (src/runtime/watchdog.ts)  — stall detection (timestamp-based)
├── Scheduler (src/runtime/scheduler.ts)— cron scheduling (croner)
├── ScheduledTasks (src/runtime/scheduled-tasks.ts) — unified CRUD scheduling with approval expiry, scope drift checks, budgets, and auto-pause
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
- **Mandatory security** — the Runtime checks every message before it reaches the agent, scans every LLM response via GuardedLLMProvider, classifies tool output before reinjection, scans every outbound response before it reaches the user, and scans every inter-agent event payload before dispatch

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

See [Orchestration Spec](../specs/ORCHESTRATION-SPEC.md) for full details.

### MCP Client

The MCP (Model Context Protocol) client consumes tools from external MCP-compatible servers:

```typescript
const manager = new MCPClientManager();
await manager.addServer({
  id: 'filesystem', name: 'FS Tools',
  transport: 'stdio',
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  source: 'third_party',
  startupApproved: true,
  networkAccess: false,
  inheritEnv: false,
});

// Tool names are namespaced: mcp-filesystem-read_file
const result = await manager.callTool('mcp-filesystem-read_file', { path: '/a.txt' });
```

Third-party MCP servers are conservative by default: startup is blocked until explicitly approved, server metadata is treated as untrusted, parent environment inheritance is off, and network access is off unless the operator opts in. Managed browser MCP remains available through the browser tool path. See [MCP Client Spec](../specs/MCP-CLIENT-SPEC.md).

## Native Skills Layer

GuardianAgent includes a native skills foundation to package reusable procedural knowledge, templates, and references without introducing a parallel execution plane.

Design intent:

- skills influence planning and prompt context
- routing and orchestration decide which agent runs; skills only shape how that agent plans
- tools and MCP remain the only execution surfaces
- Guardian and sandboxing remain the enforcement boundary

Current implementation:

- `SkillRegistry` loads local skill bundles from configured roots
- supports both Guardian-native `skill.json` manifests and reviewed frontmatter-only `SKILL.md` imports
- `SkillResolver` auto-selects relevant skills for chat requests
- resolver combines keywords, explicit skill mentions, and trigger-oriented description terms, then prefers more specific matches
- active skills are injected as a catalog, and the model reads the most relevant `SKILL.md` before acting
- first-party bundles can carry `references/`, `templates/`, `scripts/`, and `assets/` for progressive disclosure
- active skill IDs are included in chat response metadata, and analytics tracks resolution, prompt injection, bundle reads, and tool execution while skills are active
- runtime skill inspection and toggling are available via `/skills` in CLI and `GET/POST /api/skills`
- skill enable/disable updates persist to `assistant.skills.disabledSkills`
- bundled skills now span personal assistant work, IT operations, and security workflows, including Google Workspace, cloud operations, automations, file workflows, web research, host and network operations, triage, and threat intel

Not yet implemented:

- reviewed install flows for third-party skills

See [Native Skills Spec](../specs/SKILLS-SPEC.md).

## Managed Providers

GuardianAgent includes a managed MCP provider foundation for complex ecosystems where both tool schemas and procedural guidance matter.

Google Workspace integration supports two backends:

**Native mode (default, recommended):**

- `src/google/` module calls Google APIs directly via `googleapis` SDK
- OAuth 2.0 PKCE with localhost callback, tokens encrypted at `~/.guardianagent/secrets.enc.json`
- 3-step setup: create Cloud Console credentials → upload JSON → click Connect
- No external CLI dependency, no subprocess overhead
- Config: `assistant.tools.google` (enabled, mode: `native`, services, oauthCallbackPort, credentialsPath)

**CLI mode (legacy, power users):**

- execution via `gws` CLI subprocess (`@googleworkspace/cli`)
- separate install and terminal auth required
- Config: `assistant.tools.mcp.managedProviders.gws`

Both modes:

- use the same `gws` and `gws_schema` tool names (transparent routing in ToolExecutor)
- safety and approvals via ToolExecutor + Guardian
- workflow guidance via native Google skills
- Google Workspace tools mapped into Gmail/Calendar/Drive/Docs/Sheets capability checks before execution

See [Native Google Integration Spec](../specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md) and [Google Workspace CLI Spec](../specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md).

## Brokered Execution Boundary

GuardianAgent defaults to brokered worker execution for the built-in chat/planner flow. The worker process has **no network access** — LLM API calls are proxied through the broker RPC.

Supervisor responsibilities:

- config loading
- Guardian admission checks
- audit logging
- tool execution (all tool calls mediated via broker)
- LLM provider calls (proxied via `llm.chat` RPC)
- approval state
- worker lifecycle

Worker responsibilities:

- prompt assembly
- conversation-context assembly from supervisor-provided state
- LLM chat/tool loop (via broker-proxied chat function)
- pending-approval continuation
- memory_save suppression (user intent detection)
- context budget compaction
- quality-based fallback (requests via broker with `useFallback` flag)

Shared prompt/context rules are specified in [Context Assembly Spec](../specs/CONTEXT-ASSEMBLY-SPEC.md).

What this does not mean:

- orchestration agents are not moved into the worker
- every arbitrary developer-authored code path is not automatically sandboxed

See [Brokered Agent Isolation Spec](../specs/BROKERED-AGENT-ISOLATION-SPEC.md).

## Sandbox Availability

The current subprocess sandbox layer now uses an explicit availability model:

- detect whether strong sandboxing is available on the current host
- fail closed for risky tool classes in strict mode
- surface warnings and disable reasons in CLI, web, and chat paths
- degraded hosts use `workspace-write` profile (not `full-access`) for brokered workers
- degraded Linux hosts do not apply a virtual-memory `ulimit` to long-lived brokered Node workers, because that cap destabilizes worker startup without adding meaningful filesystem isolation

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
│ 5. DeniedPathController      │──▶ Path is sensitive? (.guardianagent/, .env, *.pem, etc.)
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
│ Classify tool-result trust   │──▶ Trusted / low_trust / quarantined
│ Scan response for secrets    │──▶ Redact with [REDACTED]
│ Suppress raw quarantined     │    reinjection into planner
│ Log to AuditLog              │    (configurable redact/block paths)
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
- **Tool execution** — `ToolExecutor` consumes trust/principal context, blocks quarantined-context mutation, approval-gates tainted mutation, and stops runaway chains before broken tools can overspend
- **Response output** — After the agent responds, the Runtime scans for secrets, classifies tool-result trust, and redacts before the response reaches anyone
- **Event emission** — `ctx.emit()` scans payloads for secrets before dispatch
- **Memory persistence** — durable memory stores trust, provenance, and quarantine state; inactive entries stay out of default planner context
- **Automation execution** — scheduled tasks require still-valid approval authority, matching scope hash, and available budget before each run
- **Resource limits** — Concurrent limits, queue depth, token rate limits, per-chain tool-call budgets, and wall-clock budgets enforced before every invocation
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
- **Coding Workspace**: web `#/code` page — workbench client for backend Code sessions, with repo explorer, file/diff viewer, PTY-backed terminals, trust review, inspection views, and a workspace activity rail; Guardian chat is the canonical conversational surface and can attach to the same backend Code session, while the workbench keeps the repo explorer, editor, activity, approvals, and verification state anchored to the active workspace. Code sessions carry backend workspace profiles plus a bounded repo map and per-turn working set, use retrieval-backed repo grounding instead of relying only on prompt wording, use separate Code-session long-term memory instead of Guardian global memory, default their reasoning context to the active session/workspace rather than the Guardian host app, fail closed if the targeted session cannot be resolved, keep assistant-driven file/shell actions pinned to the active workspace root, and still expose broader Guardian tools without turning the surface back into generic chat
- **Tools Control Plane**: web Configuration > Tools tab + CLI `/tools` for tool execution, manual approvals, policy mode, and sandbox boundaries
- **Connector Studio (Option 2)**: web Network > Connectors tab + configurable connector packs and engine controls via `assistant.connectors` (runtime-ready policy layer)
- **Automations**: web `#/automations` page — the single automation surface for saved step-based automations, assistant automations, standalone tool automations, schedules, starter examples, run history, raw definition editing for saved step-based automations, and engine settings. The assistant creates and controls these through the canonical automation tools (`automation_list`, `automation_save`, `automation_set_enabled`, `automation_run`, `automation_delete`)
- **Network History**: web `#/network` includes recent network run history plus inline output views for quick scans and threat checks, so scheduled and manual network actions are inspectable beyond the device inventory snapshot
- **Threat Intel**: web Security > Threat Intel tab, CLI `/intel`, Telegram `/intel` command surfaces
