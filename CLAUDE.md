# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

GuardianAgent is an event-driven AI agent orchestration system with a four-layer security defense. Agents are async classes that respond to messages, events, and cron schedules. The Guardian security system enforces capabilities, scans for secrets and PII, blocks sensitive paths, and evaluates tool actions via inline LLM (Guardian Agent) at the Runtime level — agents cannot bypass it.

**Core idea:** Agents implement simple async handlers (`onMessage`, `onEvent`, `onSchedule`) instead of generators. The Runtime dispatches work to agents and manages their lifecycle.

## Build & Run

```bash
npm test                              # Run all tests (vitest)
npm run test:verbose                  # Verbose test output
npm run test:coverage                 # Run with v8 coverage
npx vitest run src/path/to.test.ts   # Run a single test file
npx vitest run -t "test name"         # Run tests matching a name pattern

npm run check         # Type-check only (tsc --noEmit)
npm run build         # TypeScript compilation → dist/
npm run dev           # Run with tsx (starts CLI channel)
npm start             # Run compiled (node dist/index.js)

npx tsx examples/single-agent.ts     # Single agent demo
npx tsx examples/multi-agent.ts      # Multi-agent communication demo
npx tsx examples/llm-chat.ts         # LLM provider demo
```

**Requirements:** Node.js >= 20.0.0, ESM (`"type": "module"` in package.json).

## Architecture

### Runtime Bootstrap (`src/index.ts`)

The entry point is a large (~107KB) bootstrap that wires everything together:
Config → LLM Providers → Registry → EventBus → Guardian → Budget → Watchdog → Scheduler → Channels → Services (Conversation, Identity, Analytics, ThreatIntel, Connectors, Orchestrator, JobTracker, ScheduledTasks)

It registers built-in agents, injects SOUL personality profiles, starts channel adapters, and handles graceful shutdown.

### Event-Driven Runtime
- **Runtime** (`src/runtime/runtime.ts`) — central orchestrator, every message/event/response passes through it
- **Agents** extend `BaseAgent` with handlers: `onStart`, `onStop`, `onMessage`, `onEvent`, `onSchedule`
- **Orchestration Agents** — `SequentialAgent`, `ParallelAgent`, `LoopAgent` compose sub-agents; all dispatches go through full Guardian pipeline via `ctx.dispatch()`
- **SharedState** — per-invocation key-value store for inter-agent data. `temp:` prefix for invocation-scoped data
- **EventBus** — immediate async dispatch (not batch-drain)
- **CronScheduler** — uses `croner` for periodic agent invocations
- **ScheduledTaskService** — unified CRUD scheduling for tools and playbooks with persistence, presets, and EventBus integration

### LLM Provider Layer
- Unified `LLMProvider` interface with `chat()` and `stream()` (AsyncGenerator) for **Ollama**, **Anthropic**, **OpenAI**
- No LangChain — direct SDK calls
- `GuardedLLMProvider` wraps raw providers to scan all LLM responses for secrets
- `CircuitBreaker` + `ModelFallbackChain` + `FailoverProvider` for resilience
- Ollama uses OpenAI-compatible `/v1/chat/completions` + native `/api/tags`
- **Prompt Caching**: Anthropic provider sends system prompt with `cache_control: { type: 'ephemeral' }` for automatic prompt caching

### Tool Performance
- **Deferred Loading**: Only 5 always-loaded tools sent to LLM (`tool_search`, `web_search`, `fs_read`, `shell_safe`, `memory_search`). All other 70+ tools discovered via `tool_search` meta-tool.
- **Parallel Execution**: Multiple tool calls per LLM response executed concurrently via `Promise.allSettled()`
- **Short Descriptions**: `ToolDefinition.shortDescription` field used for LLM context to reduce token usage
- **Tool Examples**: `ToolDefinition.examples` field provides usage patterns for complex tools
- **Per-Tool Result Compaction**: Tool-specific formatters in `compactToolOutputForLLM()` for fs_read, fs_search, shell_safe, web_fetch, net_arp_scan
- **Context Budget**: Configurable token limit (`contextBudget`, default 80K) auto-compacts oldest tool results at 80%

### Guardian Security System
- **Admission Controller Pipeline**: Composable controllers run in order (mutating → validating)
- **CapabilityController**: Per-agent capability grants (`read_files`, `write_files`, `execute_commands`, etc.)
- **SecretScanController**: Regex detection for 28+ credential patterns (AWS, GCP, GitHub, OpenAI, Stripe, etc.)
- **PiiScanController**: High-signal PII detection for tool arguments (address, DOB, MRN, passport, driver's license)
- **DeniedPathController**: Blocks `.env`, `*.pem`, `*.key`, `credentials.*`, `id_rsa*`
- **InputSanitizer**: Prompt injection detection with invisible Unicode stripping
- **RateLimiter**: Per-agent burst/per-minute/per-hour sliding windows
- **GuardianAgentService**: Inline LLM-powered evaluation of tool actions before execution (Layer 2)
- **OutputGuardian**: Response scanning plus tool-result secret/PII redaction and prompt-injection hardening before untrusted content re-enters the model
- **SentinelAuditService**: Retrospective anomaly detection on cron or on-demand (Layer 4)

### Runtime Services (`src/runtime/`)
- **ConversationService** — SQLite-backed session memory with FTS5 full-text search and memory flush
- **AgentMemoryStore** — per-agent persistent knowledge base files (`~/.guardianagent/memory/{agentId}.md`)
- **QMDSearchService** — hybrid search (BM25 + vector + LLM re-rank) over user-defined document collections via QMD CLI subprocess
- **IdentityService** — cross-channel user mapping (`single_user` / `channel_user`)
- **AnalyticsService** — SQLite-backed usage analytics
- **ThreatIntelService** — watchlist scanning, findings triage
- **ConnectorPlaybookService** — declarative connector packs + playbook execution
- **AssistantOrchestrator** — routes messages, orchestrates tool calls, manages assistant behavior
- **MessageRouter** — intent classification and route decisions
- **ScheduledTaskService** — unified CRUD scheduling for tools/playbooks, persisted to JSON, preset templates, EventBus integration
- **BudgetTracker** — per-agent per-invocation wall-clock tracking
- **Watchdog** — timestamp-based stall detection (default 60s)

### MCP Client
- **MCPClient** — JSON-RPC 2.0 over stdio to external MCP tool servers
- **MCPClientManager** — multi-server with tool name namespacing (`mcp-<serverId>-<toolName>`)
- MCP tool risk is inferred from tool metadata (`read_only`, `mutating`, `external_post`) with optional per-server trust overrides and rate limits

### Channel Adapters
- **CLI** (`src/channels/cli.ts`) — readline prompt with `/help`, `/agents`, `/status`, `/config`, `/tools`, `/connectors`, etc.
- **Telegram** (`src/channels/telegram.ts`) — grammy bot, polling mode, `allowed_chat_ids` filtering
- **Web** (`src/channels/web.ts`) — Node.js HTTP server, REST API (`/health`, `/api/status`, `/api/message`), serves static files from `web/public/`, bearer token auth

### Web Frontend (`web/public/`)
Vanilla JavaScript — no framework, no build step. Static HTML/CSS/JS served directly by the WebChannel HTTP server. Consolidated into 6 sidebar pages with tabbed navigation:
- **Dashboard** (`#/`) — status cards, agent table, LLM status, recent alerts, assistant state (sessions, jobs, cron, policy)
- **Security** (`#/security`) — Audit tab, Monitoring tab, Threat Intel tab
- **Network** (`#/network`) — Connectors tab, Devices tab
- **Operations** (`#/operations`) — scheduled tasks CRUD, preset installation, run history
- **Configuration** (`#/config`) — Providers tab, Tools tab, Policy tab (interactive allowlist editor), Search Sources tab (QMD), Settings tab
- **Reference Guide** (`#/reference`) — unchanged
- **Chat** — persistent right panel

### Memory System
- **FTS5 Search**: Full-text search index on conversation_messages with BM25 ranking, porter stemming, content-sync triggers
- **Knowledge Base**: Per-agent markdown files (`~/.guardianagent/memory/{agentId}.md`) always loaded into LLM context
- **Memory Flush**: Automatic extraction of dropped context to knowledge base when sliding window trims history
- **Memory Tools**: `memory_search` (FTS5 query), `memory_get` (read knowledge base), `memory_save` (persist facts) — all Guardian-gated, with tool-result scanning before memory content re-enters LLM context
- **Config**: `assistant.memory.knowledgeBase` — enable/disable, maxContextChars, autoFlush
- See `docs/guides/MEMORY-SYSTEM.md` for full documentation

### QMD Document Search
- **QMDSearchService** (`src/runtime/qmd-search.ts`) — wraps [QMD CLI](https://github.com/tobi/qmd) for hybrid search
- **Search modes**: `search` (BM25 keyword), `vsearch` (vector similarity), `query` (hybrid + LLM re-rank)
- **Multi-protocol sources**: `directory` (local path + globs), `git` (repo URL + branch), `url` (web content), `file` (single file)
- **Search Tools**: `qmd_search`, `qmd_status`, `qmd_reindex` — category: `search`, all Guardian-gated
- **Config**: `assistant.tools.qmd` — enable/disable, binaryPath, defaultMode, maxResults, sources array
- **Web UI**: Configuration > Search Sources tab — source CRUD, toggle, reindex, status

### Evaluation Framework
- **EvalRunner** runs test cases through the real Runtime (Guardian active)
- Content matchers: exact, contains, not_contains, regex, not_empty
- Safety metrics: secret scanning, blocked patterns, denial detection, injection scoring
- JSON-based test suites (`.eval.json`)

## Code Conventions

- **Pure functions** preferred; isolate side effects at boundaries
- **Explicit state machines** for agent lifecycle: Created → Ready → Running → Idle/Paused/Stalled → Errored → Dead
- **Structured logging** via pino (JSON logs with context)
- **Immutable interfaces** — agent contexts are read-only (`Object.freeze`)
- Errors are values, not exceptions (discriminated unions where possible)
- All time values in milliseconds unless suffixed
- **Exponential backoff** on errors: [30s, 1m, 5m, 15m, 60m]

## File Organization

```
src/index.ts        — Entry point / bootstrap (large file, wires everything)
src/agent/          — BaseAgent, Registry, Lifecycle state machine, orchestration agents
src/agents/         — Built-in agent implementations (SentinelAgent)
src/config/         — Config types, YAML loader with ${ENV_VAR} interpolation
src/llm/            — LLMProvider interface, Ollama/Anthropic/OpenAI, circuit breaker, failover
src/runtime/        — Runtime, services (Conversation, Identity, Analytics, ThreatIntel,
                      Connectors, Orchestrator, JobTracker, ScheduledTasks, AgentMemoryStore,
                      QMDSearchService), BudgetTracker, Watchdog, Scheduler
src/queue/          — EventBus for inter-agent communication
src/guardian/       — Capabilities, SecretScanner, PiiScanner, InputSanitizer, OutputGuardian,
                      RateLimiter, audit log/persistence, Guardian admission pipeline
src/channels/       — CLI, Telegram, Web channel adapters
src/tools/          — ToolExecutor, MCP client (MCPClient, MCPClientManager), approvals
src/eval/           — Evaluation framework (types, metrics, runner)
src/prompts/        — System prompt composition (composeGuardianSystemPrompt)
src/util/           — Backoff, logging (pino), crypto guardrails
web/public/         — Static frontend (vanilla JS, no build step)
examples/           — Demo scripts (single-agent, multi-agent, llm-chat)
docs/               — Architecture docs, specs, guides, research
scripts/            — Dev/deploy shell scripts
```

## Configuration

Config loaded from `~/.guardianagent/config.yaml` with `${ENV_VAR}` interpolation. Most users configure via web Config Center (`#/config`) or CLI (`/config`, `/auth`, `/tools`).

Key config sections: `llm`, `defaultProvider`, `channels` (cli/telegram/web), `guardian`, `assistant` (soul, memory, analytics, tools, quickActions, threatIntel, connectors), `runtime`.

See README.md for the full config reference.

## Testing

- Tests are **co-located** with source files (`*.test.ts` alongside `*.ts`)
- Vitest with **forks** pool (process isolation), 30s timeout per test
- Coverage thresholds: 70% lines/functions/statements, 55% branches (v8 provider)
- See `docs/guides/ASSISTANT-TESTING-RUNBOOK.md` for manual testing procedures
- See `docs/guides/MCP-TESTING-GUIDE.md` for MCP-specific testing
- Use `vi.useFakeTimers()` for time-dependent tests
- Mock HTTP/SDK for LLM provider tests
- Orchestration tests mock `ctx.dispatch()` to verify step ordering and state passing
- Eval integration tests run through real Runtime with Guardian active

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
