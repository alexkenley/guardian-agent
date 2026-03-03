# GuardianAgent — Event-Driven AI Agent System

## Overview

GuardianAgent is an event-driven AI agent orchestration system. Agents are async classes that respond to messages, events, and cron schedules. The Guardian security system protects users by enforcing capabilities, scanning for secrets, and blocking access to sensitive paths.

**Core idea:** Agents implement simple async handlers (`onMessage`, `onEvent`, `onSchedule`) instead of generators. The runtime dispatches work to agents and manages their lifecycle.

## Build & Run

```bash
npm test          # Run tests (vitest)
npm run build     # TypeScript compilation
npm run dev       # Run with tsx (starts CLI)
npm start         # Run compiled (node dist/index.js)

npx tsx examples/single-agent.ts   # Single agent demo
npx tsx examples/multi-agent.ts    # Multi-agent communication demo
npx tsx examples/llm-chat.ts       # LLM provider demo
npx vitest run --reporter=verbose  # Verbose test output
```

## Architecture

### Event-Driven Runtime
- **Runtime** orchestrator wires: Config → LLM Providers → Registry → EventBus → Guardian → Budget → Watchdog → Scheduler → Channels
- **Agents** are async classes extending `BaseAgent` with handlers: `onStart`, `onStop`, `onMessage`, `onEvent`, `onSchedule`
- **Orchestration Agents** — `SequentialAgent`, `ParallelAgent`, `LoopAgent` compose sub-agents into workflows. All dispatches go through full Guardian pipeline via `ctx.dispatch()`
- **SharedState** — per-invocation, orchestrator-owned key-value store for inter-agent data passing. `temp:` prefix convention for invocation-scoped data
- **EventBus** provides immediate async dispatch (replaces batch-drain queue)
- **CronScheduler** uses `croner` for periodic agent invocations

### LLM Provider Layer
- Unified `LLMProvider` interface for **Ollama**, **Anthropic**, and **OpenAI**
- No LangChain — direct SDK calls for debuggability
- Ollama uses OpenAI-compatible `/v1/chat/completions` + native `/api/tags` for discovery
- Each provider supports both `chat()` and `stream()` (AsyncGenerator)

### Guardian Security System
- **Admission Controller Pipeline**: Composable controllers run in order (mutating → validating)
- **CapabilityController**: Per-agent capability grants (`read_files`, `write_files`, `execute_commands`, etc.)
- **SecretScanController**: Regex detection for AWS keys, API tokens, JWTs, PEM headers, connection strings
- **DeniedPathController**: Blocks access to `.env`, `*.pem`, `*.key`, `credentials.*`, `id_rsa*`

### MCP Client
- **MCPClient** — JSON-RPC 2.0 over stdio, connects to external MCP tool servers
- **MCPClientManager** — multi-server management with tool name namespacing (`mcp:<serverId>:<toolName>`)
- All MCP tool calls pass through Guardian admission pipeline
- MCP tools classified as `network` risk level

### Evaluation Framework
- **EvalRunner** runs test cases through the real Runtime (Guardian active during eval)
- Content matchers: exact, contains, not_contains, regex, not_empty
- Safety metrics: secret scanning, blocked patterns, denial detection, injection scoring
- Tool trajectory and metadata validation
- JSON-based test suites (`.eval.json`) and code-based test cases

### Channel Adapters
- **CLI**: Interactive readline prompt with `/help`, `/agents`, `/status`, `/quit` commands
- **Telegram**: grammy bot framework, polling mode, allowed_chat_ids filtering
- **Web**: Node.js HTTP server with REST API (`/health`, `/api/status`, `/api/message`)

### Key Patterns
- **Explicit state machine** for agent lifecycle (Created → Ready → Running → Idle/Paused/Stalled → Errored → Dead)
- **Exponential backoff** on errors: [30s, 1m, 5m, 15m, 60m]
- **Timestamp-based watchdog** stall detection (default 60s)
- **Compute budgets** per-agent per-invocation wall-clock tracking
- **Token usage tracking** for rate limiting

## Code Conventions

- **Pure functions** preferred; isolate side effects at boundaries
- **Explicit state machines** for agent lifecycle (no implicit state)
- **Structured logging** via pino (JSON logs with context)
- **Immutable interfaces** — agent contexts are read-only
- Errors are values, not exceptions (use discriminated unions where possible)
- All time values in milliseconds unless suffixed

## File Organization

```
src/config/     — Config types, YAML loader with env var interpolation
src/llm/        — LLM provider interface, Ollama/Anthropic/OpenAI implementations
src/agent/      — Agent base class, Registry, Lifecycle state machine, orchestration agents, types
src/runtime/    — Runtime orchestrator, BudgetTracker, Watchdog, CronScheduler, SharedState
src/queue/      — EventBus for inter-agent communication
src/guardian/    — Capabilities, SecretScanner, Guardian admission pipeline
src/channels/   — CLI, Telegram, Web channel adapters
src/tools/      — Tool executor, MCP client (MCPClient, MCPClientManager)
src/eval/       — Agent evaluation framework (types, metrics, runner)
src/util/       — Backoff, logging utilities
examples/       — single-agent, multi-agent, llm-chat demos
docs/           — Architecture docs, specs, & research
```

## Configuration

Config loaded from `~/.guardianagent/config.yaml` with `${ENV_VAR}` interpolation:

```yaml
llm:
  ollama:
    provider: ollama
    model: llama3.2
  claude:
    provider: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-20250514

defaultProvider: ollama

channels:
  cli:
    enabled: true
  telegram:
    enabled: true
    botToken: ${TELEGRAM_BOT_TOKEN}
    allowedChatIds: [12345678]
  web:
    enabled: true
    port: 3000

guardian:
  enabled: true
  logDenials: true

runtime:
  maxStallDurationMs: 60000
  watchdogIntervalMs: 10000
```

## Testing

- **See `docs/guides/ASSISTANT-TESTING-RUNBOOK.md`** for full manual testing procedures (server startup, API functional tests, security tests, cleanup)
- See `docs/guides/MCP-TESTING-GUIDE.md` for MCP-specific testing scenarios
- Use vitest with `vi.useFakeTimers()` for time-dependent tests
- Test state machine transitions exhaustively (valid + invalid)
- Mock HTTP/SDK for LLM provider tests
- Test Guardian pipeline with known secret patterns
- Orchestration agent tests use mock `ctx.dispatch()` to verify step ordering and state passing
- Eval framework tests use real metrics against crafted responses (no Runtime needed for metric unit tests)
- Agent eval integration tests run through real Runtime with Guardian active

## Debugging and Decision-Making Protocol

### Core Rule: Data Before Conclusions
Never conclude a root cause or dismiss a hypothesis based on reasoning alone. Run the diagnostic, read the output, then decide. A 30-second test beats a 10-paragraph theory.

### Before Changing Direction on a Diagnosis
- State what data you collected that contradicts the current theory
- Show the actual output (logs, key counts, error messages, screenshots)
- If you haven't collected data yet, collect it first — do NOT change course based on a new theory you read or reasoned about

### Flip-Flop Prevention
When you identify a root cause, write a one-line summary of it and the evidence that supports it.

If you later want to change that root cause, you MUST:
- Reference the original diagnosis
- Explain specifically what new DATA (not reasoning) invalidates it
- Show the data

"I think" and "likely" are not evidence. Logs, key counts, error outputs, and test results are evidence.

Do not remove diagnostic code until the diagnostic has actually been run and results reviewed.

### When Investigating Pipeline Failures
1. Add logging/diagnostics FIRST
2. Run the pipeline with diagnostics
3. Read the output
4. THEN form a conclusion

Do not skip steps 1-3 and jump to 4.

### External Research vs Local Debugging
GitHub issues and forum posts describe OTHER people's setups. They may not apply to ours.

- When you find an external issue that seems relevant, verify it applies by checking OUR code, OUR configs, OUR model files — not by assuming
- If external research and local evidence conflict, local evidence wins

### Uncertainty is OK
- If you don't know the root cause yet, say so. "I need to run X to confirm" is better than guessing
- Do not present a hypothesis as a conclusion. Label hypotheses as hypotheses
- When presenting options, include "run diagnostic X to determine which" as the recommended first step
