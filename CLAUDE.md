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
- **Orchestration Agents** — `SequentialAgent`, `ParallelAgent`, `LoopAgent`, `ConditionalAgent` compose sub-agents; all dispatches go through full Guardian pipeline via `ctx.dispatch()`. Per-step retry with exponential backoff (`StepRetryPolicy`), fail-branch error handling (`StepFailBranch`), array iteration mode for LoopAgent (`LoopArrayConfig`), and conditional branching (`ConditionalAgent`). Shared orchestration utilities extracted as module-level functions.
- **SharedState** — per-invocation key-value store for inter-agent data. `temp:` prefix for invocation-scoped data
- **EventBus** — immediate async dispatch (not batch-drain)
- **CronScheduler** — uses `croner` for periodic agent invocations
- **ScheduledTaskService** — unified CRUD scheduling for tools and playbooks with persistence, presets, and EventBus integration

### LLM Provider Layer
- Unified `LLMProvider` interface with `chat()` and `stream()` (AsyncGenerator) for **Ollama**, **Anthropic**, **OpenAI**, plus 6 OpenAI-compatible providers (**Groq**, **Mistral**, **DeepSeek**, **Together**, **xAI**, **Google Gemini**) via `ProviderRegistry`
- No LangChain — direct SDK calls
- `GuardedLLMProvider` wraps raw providers to scan all LLM responses for secrets
- `CircuitBreaker` + `ModelFallbackChain` + `FailoverProvider` for resilience
- Ollama uses OpenAI-compatible `/v1/chat/completions` + native `/api/tags`
- **Prompt Caching**: Anthropic provider sends system prompt with `cache_control: { type: 'ephemeral' }` for automatic prompt caching
- **Per-Tool Provider Routing**: `assistant.tools.providerRouting` maps tool names or categories to `'local'` or `'external'`. After a tool executes, the routing table is checked and the *next* LLM call in the tool loop uses the preferred provider — so the model that synthesizes the tool result can differ from the one that initiated the call. Resolution order: tool-name override > category override > smart category default > default provider. Configured via web UI (Configuration > Tools) or YAML. See `resolveToolProviderRouting()` and `resolveRoutedProviderForTools()` in `src/index.ts`.
- **Smart Category Defaults**: When `providerRoutingEnabled` is `true` (default) and both local and external providers exist, tools auto-route by category: local categories (filesystem, shell, network, system, memory) use the local model; external categories (web, browser, workspace, email, contacts, forum, intel, search, automation) use the external model. When only one provider type exists, smart routing is a no-op. Toggle via `assistant.tools.providerRoutingEnabled` or the "Smart LLM Routing" checkbox in Configuration > Tools tab.
- **Provider Registry**: `ProviderRegistry` (`src/llm/provider-registry.ts`) manages all built-in provider factories. OpenAI-compatible providers reuse `OpenAIProvider` with provider-specific default base URLs. All providers are curated and ship with the codebase — no external plugin loading or dynamic imports (supply chain security).

### Tool Performance
- **Deferred Loading**: 10 always-loaded tools sent to LLM (`find_tools`, `web_search`, `fs_read`, `fs_list`, `fs_search`, `shell_safe`, `memory_search`, `memory_save`, `sys_info`, `sys_resources`). All other 60+ tools discovered via `find_tools` meta-tool.
- **Parallel Execution**: Multiple tool calls per LLM response executed concurrently via `Promise.allSettled()`
- **Short Descriptions**: `ToolDefinition.shortDescription` field used for LLM context to reduce token usage
- **Tool Examples**: `ToolDefinition.examples` field provides usage patterns for complex tools
- **Per-Tool Result Compaction**: Tool-specific formatters in `compactToolOutputForLLM()` for fs_read, fs_search, shell_safe, web_fetch, net_arp_scan
- **Context Budget**: Configurable token limit (`contextBudget`, default 80K) auto-compacts oldest tool results at 80%

### Guardian Security System
- **Admission Controller Pipeline**: Composable controllers run in order (mutating → validating)
- **CapabilityController**: Per-agent capability grants (`read_files`, `write_files`, `execute_commands`, etc.)
- **SecretScanController**: Regex detection for 30+ credential and PII patterns (AWS, GCP, GitHub, OpenAI, Stripe, etc.)
- **PiiScanController**: High-signal PII detection for tool arguments (address, DOB, MRN, passport, driver's license)
- **DeniedPathController**: Blocks `.env`, `*.pem`, `*.key`, `credentials.*`, `id_rsa*`
- **SsrfController**: Centralized SSRF protection blocking private IPs (RFC1918), loopback, link-local, cloud metadata endpoints, IPv4-mapped IPv6, and decimal/hex/octal IP obfuscation. Config: `guardian.ssrf`
- **InputSanitizer**: Prompt injection detection with invisible Unicode stripping
- **RateLimiter**: Per-agent burst/per-minute/per-hour sliding windows
- **GuardianAgentService**: Inline LLM-powered evaluation of tool actions before execution (Layer 2)
- **OutputGuardian**: Response scanning plus tool-result secret/PII redaction and prompt-injection hardening before untrusted content re-enters the model
- **SentinelAuditService**: Retrospective anomaly detection on cron or on-demand (Layer 4)
- **Policy-as-Code Engine** (`src/policy/`): Declarative JSON rule engine with compiled matchers, shadow mode, hot-reload. Config: `guardian.policy` (enabled, mode: off/shadow/enforce, rulesPath). Rule files in `policies/`.

### Runtime Services (`src/runtime/`)
- **ConversationService** — SQLite-backed session memory with FTS5 full-text search and memory flush
- **AgentMemoryStore** — per-agent persistent knowledge base files (`~/.guardianagent/memory/{agentId}.md`)
- **SearchService** (`src/search/`) — native hybrid search (BM25 + vector) over user-defined document collections
- **IdentityService** — cross-channel user mapping (`single_user` / `channel_user`)
- **AnalyticsService** — SQLite-backed usage analytics
- **ThreatIntelService** — watchlist scanning, findings triage
- **ConnectorPlaybookService** — declarative connector packs + playbook execution; supports both tool steps and LLM instruction steps (instruction steps invoke the LLM with prior step outputs as context)
- **AssistantOrchestrator** — routes messages, orchestrates tool calls, manages assistant behavior
- **MessageRouter** — intent classification and route decisions
- **ScheduledTaskService** — unified CRUD scheduling for tools/playbooks, persisted to JSON, preset templates, EventBus integration
- **BudgetTracker** — per-agent per-invocation wall-clock tracking
- **Watchdog** — timestamp-based stall detection (default 60s)

### MCP Client
- **MCPClient** — JSON-RPC 2.0 over stdio to external MCP tool servers
- **MCPClientManager** — multi-server with tool name namespacing (`mcp-<serverId>-<toolName>`)
- MCP tool risk is inferred from tool metadata (`read_only`, `mutating`, `external_post`) with optional per-server trust overrides and rate limits

### Google Workspace (`src/google/`)
- **Native mode (default):** `GoogleAuth` (OAuth 2.0 PKCE, encrypted token storage) + `GoogleService` (direct googleapis SDK calls). Config: `assistant.tools.google` (enabled, mode: `native`, services, oauthCallbackPort, credentialsPath). 3-step setup.
- **CLI mode (legacy):** `GWSService` (`src/runtime/gws-service.ts`) — subprocess wrapper for the `gws` CLI. Config: `assistant.tools.mcp.managedProviders.gws`.
- Both backends share the same `gws` / `gws_schema` tool names. ToolExecutor routes to native first, CLI fallback.
- Spec: `docs/specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md`

### Microsoft 365 (`src/microsoft/`)
- **Native mode:** `MicrosoftAuth` (OAuth 2.0 PKCE, encrypted token storage) + `MicrosoftService` (direct Graph REST API calls). Config: `assistant.tools.microsoft` (enabled, services, oauthCallbackPort, clientId, tenantId).
- No MSAL, no Graph SDK, no `@azure/identity` — hand-rolled PKCE + direct `fetch()` to `graph.microsoft.com/v1.0`.
- Tools: `m365` (generic Graph API), `m365_schema` (curated endpoint reference), `outlook_draft`, `outlook_send` (convenience email tools).
- 3-step setup: register app in Entra → enter client ID → connect via OAuth.
- Spec: `docs/specs/MICROSOFT-365-INTEGRATION-SPEC.md`

### Browser Automation (MCP-based)
- **Playwright MCP** (`@playwright/mcp`) — managed MCP server providing 55+ browser automation tools via real Chromium/Firefox/WebKit. Registered as `mcp-playwright-*` tools. Config: `assistant.tools.browser.playwrightEnabled` (default: true), `playwrightBrowser`, `playwrightCaps`
- **Lightpanda** (`@lightpanda/browser`) — optional lightweight MCP server for fast page reads (7 tools: goto, markdown, links, evaluate, semantic_tree, interactiveElements, structuredData). Registered as `mcp-lightpanda-*` tools. Config: `assistant.tools.browser.lightpandaEnabled` (default: false)
- Both run as stdio subprocesses via MCPClientManager — no custom session management
- Policy rules in `policies/base/browser.json`: `browser_run_code` denied, `browser_evaluate` requires approval, `browser_file_upload` and `browser_storage_state` require approval
- Start scripts auto-install Playwright Chromium binary on first run
- Spec: `docs/specs/BROWSER-AUTOMATION-SPEC.md`

### Channel Adapters
- **CLI** (`src/channels/cli.ts`) — readline prompt with `/help`, `/agents`, `/status`, `/config`, `/tools`, `/connectors`, etc. Structured approval prompts via interactive `Approve (y) / Deny (n):` readline question with auto-continuation.
- **Telegram** (`src/channels/telegram.ts`) — grammy bot, polling mode, `allowed_chat_ids` filtering. Inline keyboard buttons for tool approvals with callback query handling and auto-continuation.
- **Web** (`src/channels/web.ts`) — Node.js HTTP server, REST API (`/health`, `/api/status`, `/api/message`), serves static files from `web/public/`, vendor routes for xterm (`/vendor/xterm/`) and Monaco (`/vendor/monaco/`), bearer token auth. Structured Approve/Deny buttons via `response.metadata.pendingApprovals` with auto-continuation.
- **Approval UX**: All channels use structured `response.metadata.pendingApprovals` (array of `{ id, toolName, argsPreview }`) for native approval UI rendering. On approval, each channel auto-dispatches a continuation message so the LLM completes multi-step tasks (e.g., add path → write file).

### Web Frontend (`web/public/`)
Vanilla JavaScript — no framework, no build step. Static HTML/CSS/JS served directly by the WebChannel HTTP server. Monaco Editor vendored in `web/public/vendor/monaco/` (gitignored, copied from npm by `postinstall`). Consolidated into 6 sidebar pages with tabbed navigation:
- **Dashboard** (`#/`) — status cards, agent table, LLM status, recent alerts, assistant state (sessions, jobs, cron, policy)
- **Security** (`#/security`) — Audit tab, Monitoring tab, Threat Intel tab
- **Network** (`#/network`) — Connectors tab, Devices tab
- **Automations** (`#/automations`) — unified automation catalog (single-tool and multi-step pipelines), optional cron scheduling, examples, clone, run history, engine settings
- **Configuration** (`#/config`) — Providers tab, Tools tab, Policy tab (interactive allowlist editor), Search Sources tab, Settings tab
- **Reference Guide** (`#/reference`) — wiki-style operator guide backed by `src/reference-guide.ts`; update it whenever user-facing capabilities, workflows, controls, output handling, or export behavior changes anywhere in the app
- **Chat** — persistent right panel

### Memory System
- **FTS5 Search**: Full-text search index on conversation_messages with BM25 ranking, porter stemming, content-sync triggers
- **Knowledge Base**: Per-agent markdown files (`~/.guardianagent/memory/{agentId}.md`) always loaded into LLM context
- **Memory Flush**: Automatic extraction of dropped context to knowledge base when sliding window trims history
- **Memory Tools**: `memory_search` (FTS5 query), `memory_get` (read knowledge base), `memory_save` (persist facts) — all Guardian-gated, with tool-result scanning before memory content re-enters LLM context
- **Config**: `assistant.memory.knowledgeBase` — enable/disable, maxContextChars, autoFlush
- See `docs/guides/MEMORY-SYSTEM.md` for full documentation

### Document Search
- **SearchService** (`src/search/search-service.ts`) — native TypeScript hybrid search pipeline
- **Search modes**: `keyword` (BM25 via FTS5), `semantic` (vector similarity), `hybrid` (RRF fusion of both)
- **Multi-protocol sources**: `directory` (local path + globs), `git` (repo URL + branch), `url` (web content), `file` (single file)
- **Parent-child chunking**: Parents (~768 tokens) provide context, children (~192 tokens) provide search precision
- **Embedding providers**: Ollama (`/api/embed`) and OpenAI, with batch support; vector search optional (graceful fallback to keyword-only)
- **Search Tools**: `doc_search`, `doc_search_status`, `doc_search_reindex` — category: `search`, all Guardian-gated
- **Config**: `assistant.tools.search` — enable/disable, sqlitePath, defaultMode, maxResults, sources array, embedding, chunking, reranker
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
src/llm/            — LLMProvider interface, Ollama/Anthropic/OpenAI, ProviderRegistry, circuit breaker, failover
src/runtime/        — Runtime, services (Conversation, Identity, Analytics, ThreatIntel,
                      Connectors, Orchestrator, JobTracker, ScheduledTasks, AgentMemoryStore),
                      BudgetTracker, Watchdog, Scheduler
src/search/         — Native search pipeline (SearchService, DocumentStore, FTSStore, VectorStore,
                      HybridSearch, chunker, document parser, embedding providers, reranker)
src/queue/          — EventBus for inter-agent communication
src/guardian/       — Capabilities, SecretScanner, PiiScanner, InputSanitizer, OutputGuardian, SsrfProtection,
                      RateLimiter, audit log/persistence, Guardian admission pipeline
src/channels/       — CLI, Telegram, Web channel adapters
src/policy/         — Policy-as-Code engine (types, matcher, compiler, engine, rules, shadow mode)
src/google/         — Native Google Workspace integration (GoogleAuth, GoogleService)
src/microsoft/      — Native Microsoft 365 integration (MicrosoftAuth, MicrosoftService)
src/tools/          — ToolExecutor, MCP client (MCPClient, MCPClientManager), approvals
src/broker/         — BrokerServer/Client, capability tokens, provenance — JSON-RPC 2.0 bridge
                      between supervisor and worker (tool calls, approvals, LLM chat proxy).
                      IMPORTANT: BrokerClient.callTool and BrokerServer must forward codeContext
                      for code-session auto-approve to work through the brokered path.
src/supervisor/     — WorkerManager — spawns/manages sandboxed worker processes.
                      tryDirectAutomationAuthoring must also forward codeContext from message metadata.
src/worker/         — Worker entry point, BrokeredWorkerSession, runLlmLoop
src/sandbox/        — OS sandbox profiles, bwrap/ulimit/env hardening, capability detection
src/eval/           — Evaluation framework (types, metrics, runner)
src/prompts/        — System prompt composition (composeGuardianSystemPrompt)
src/util/           — Backoff, logging (pino), crypto guardrails, memory-intent, response-quality,
                      context-budget, tool-report (shared utilities for both execution paths)
web/public/         — Static frontend (vanilla JS, no build step), Monaco Editor vendored in vendor/monaco/
examples/           — Demo scripts (single-agent, multi-agent, llm-chat)
policies/           — Declarative JSON policy rule files (base tool rules shipped)
docs/               — Architecture docs, specs, guides, research
scripts/            — Dev/deploy shell scripts
```

## Configuration

Config loaded from `~/.guardianagent/config.yaml` with `${ENV_VAR}` interpolation. Most users configure via web Config Center (`#/config`) or CLI (`/config`, `/auth`, `/tools`).

Key config sections: `llm`, `defaultProvider`, `channels` (cli/telegram/web), `guardian`, `assistant` (soul, memory, analytics, tools, quickActions, threatIntel, connectors), `runtime`.

See README.md for the full config reference.

## Documentation

- Keep `src/reference-guide.ts` in sync with the app. Any change to user-facing behavior, workflows, controls, tool output, exports, automation behavior, or navigation should include a Reference Guide update in the same change.
- If a feature is exposed in multiple channels, document the shared behavior once in the Reference Guide and keep channel-specific notes aligned in the relevant docs.

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

### Integration Test Harness (Post-Implementation Verification)

**After any implementation that touches the web UI, coding assistant, tool execution, approval flow, or security pipeline**, run the relevant integration harness tests. These exercise the full stack (config, Guardian, LLM, tools, response formatting) and catch regressions that unit tests miss. See `docs/guides/INTEGRATION-TEST-HARNESS.md` for the complete guide.

**Minimum post-implementation checklist:**

```bash
npm test                                    # Unit tests (vitest, 1500+ tests)
node scripts/test-coding-assistant.mjs      # Code-session transport, approval scoping, memory isolation
node scripts/test-code-ui-smoke.mjs         # Browser smoke: explorer, chat, approvals, editor, persistence (Playwright)
```

**Extended verification (run when touching the relevant subsystem):**

```bash
node scripts/test-contextual-security-uplifts.mjs   # Quarantine, trust-aware memory, bounded schedules
node scripts/test-automation-authoring-compiler.mjs  # Conversational automation compiler, dedup, no-script drift
node --import tsx scripts/test-cli-approvals.mjs     # CLI readline approval flow
```

**PowerShell harnesses (Windows / cross-platform):**
- `scripts/test-harness.ps1` — Functional + security (~39 assertions)
- `scripts/test-tools.ps1` — Tool exercise + approval flow (~50+ assertions)
- `scripts/test-approvals.ps1` — Approval UX, contextual prompts, multi-approval (~45+ assertions)

The harness scripts are self-contained: they start a temporary backend, run tests via HTTP, and shut down. No running instance needed.

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

### Estimation
- Do not give time estimates in human days/hours for implementation plans. You are not a human developer — "2 days" is meaningless for your work. Instead, describe effort in terms of scope: number of files, number of tests, number of phases, and dependencies between them.
