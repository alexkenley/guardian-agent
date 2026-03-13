<p align="center">
  <img src="docs/images/guardian agent banner.png" alt="GuardianAgent banner" width="100%"/>
</p>

<h1 align="center">GuardianAgent</h1>

<h3 align="center">Security-first AI agent orchestration.</h3>

<p align="center">
  An event-driven AI agent system with a four-layer security defense that enforces capabilities, scans for secrets and PII, blocks sensitive paths, and evaluates tool actions via inline LLM — agents cannot bypass it.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/v1.0.0-release-brightgreen?style=for-the-badge" alt="Version 1.0.0"/>
  <img src="https://img.shields.io/badge/LICENSE-Apache--2.0-blue?style=for-the-badge" alt="Apache 2.0 License"/>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js >= 20"/>
  <br/>
  <img src="https://img.shields.io/badge/SECURITY-FOUR--LAYER%20DEFENSE-critical?style=for-the-badge" alt="Four-Layer Defense"/>
  <img src="https://img.shields.io/badge/LLM-Ollama%20%7C%20Anthropic%20%7C%20OpenAI-blueviolet?style=for-the-badge&logo=openai&logoColor=white" alt="Multi-LLM"/>
  <img src="https://img.shields.io/badge/CHANNELS-CLI%20%7C%20Web%20%7C%20Telegram-2496ED?style=for-the-badge" alt="Multi-Channel"/>
</p>

## Features

- **Four-layer security defense** — proactive admission controls, inline LLM-powered action evaluation (Guardian Agent), output-time leak prevention, and Sentinel audit analysis, all mandatory at the Runtime level
- **Brokered agent isolation by default** — the built-in chat/planner loop runs in a separate worker process with brokered tool and approval access, instead of executing the LLM/tool loop in the privileged supervisor
- **Multi-provider LLM support** — Ollama (local), Anthropic (Claude), OpenAI (GPT), plus Groq, Mistral, DeepSeek, Together, xAI, and Google Gemini via curated ProviderRegistry — with interactive model selection, circuit breaker, automatic failover, and smart LLM routing that automatically directs tools to local or external models by category
- **Multi-channel access** — CLI, Telegram bot, and Web UI with bearer token auth and cross-channel identity mapping
- **Web dashboard** — real-time status, LLM providers, agent monitoring, session queue, scheduled jobs, integrated chat panel, and SSE-driven live refresh when config, automation, or network state changes
- **Multi-agent orchestration** — Sequential, Parallel, Loop, and Conditional agents with per-step retry, fail-branch error handling, array iteration, and inter-step state passing through SharedState
- **Guardian security pipeline** — per-agent capabilities, secret scanning (30+ credential and PII patterns), PII detection/redaction, prompt injection detection, rate limiting, sensitive path blocking, SSRF protection, and output redaction
- **Tool governance** — approval workflows, per-tool policy overrides, path/command/domain allowlists, and risk-tiered tool classes with interactive policy editor
- **MCP tool server integration** — JSON-RPC 2.0 over stdio with namespaced tools, inferred trust levels, optional per-server rate limits, and full Guardian admission on every call
- **Connector and playbook framework** — declarative connector packs with host/path/command allowlists, bounded step execution, dry-run mode, and signed definitions
- **Conversation memory** — SQLite-backed session history with FTS5 full-text search, per-agent knowledge base, automatic memory flush, and shared memory/session state across tier-routed local/external chat backends
- **Native document search** — hybrid BM25 keyword + vector similarity search over directories, git repos, URLs, and files
- **Scheduled task management** — CRUD scheduling for tools and playbooks with presets, run history, inspectable step output, and EventBus integration
- **Security monitoring** — network threat posture plus host monitoring, host firewall drift, gateway firewall drift, active alerts, audit log integrity, and SQLite DB hardening
- **Security alert routing** — configurable CLI, web, and Telegram notification delivery with severity filters, event-type filters, and alert-family suppression
- **Threat intelligence** — watchlist scanning, findings triage, response drafts with human approval gates
- **Campaign automation** — contact discovery and approval-gated Gmail send workflows
- **Quick actions** — templated workflows for email, task, and calendar operations
- **Analytics** — SQLite-backed usage tracking and channel analytics
- **Agent evaluation framework** — content matchers, tool trajectory validation, safety metrics, and JSON test suites for CI
- **SOUL personality system** — configurable personality profiles with primary/delegated injection modes
- **Cryptographic audit trail** — SHA-256 hash-chained JSONL persistence, tamper-evident policy changes, and constant-time auth

## Start Here

- [Installation](INSTALLATION.md)
- [Usage](USAGE.md)
- [Security](SECURITY.md)
- [Architecture](docs/architecture/OVERVIEW.md)

## Screenshots

### Web Dashboard
![Web Dashboard](docs/images/web-dashboard.png)
*Real-time status cards, LLM provider table, agent monitoring, assistant state, session queue, scheduled cron jobs, and integrated chat panel.*

### Security Monitoring
![Security Monitoring](docs/images/security-monitoring.png)
*Network, host, and gateway security posture with active alerts, self-policing signals, and security event tracking.*

### Network Connectors
![Network Connectors](docs/images/network-connectors.png)
*Playbook management with Run/Dry Run/Delete actions, recent execution history, inspectable step output, and chat panel.*

### Automations
![Automations](docs/images/operations.png)
*Unified automation catalog — simple edit flow for common changes, advanced configuration for power users, centered pipeline disclosure, examples, clone, live-updating run history, and per-step output inspection.*

## What This Is

GuardianAgent is a self-contained orchestrator for personal assistant AI. The Runtime manages agent lifecycle, admission checks, audit logging, tool execution, and approvals. The built-in chat/planner execution path runs in a brokered worker process by default.

The supervisor process owns config loading, admission, audit logging, tool execution, approvals, and orchestration. The worker process owns prompt assembly, conversation-context assembly, and the LLM chat/tool loop.

Structured orchestration agents execute in the supervisor process. Their sub-agent dispatches pass through `Runtime.dispatchMessage()`, which routes built-in chat-agent execution into the brokered worker path.

All security enforcement is **mandatory at the Runtime level**. Agents cannot bypass it.

## Multi-Agent Orchestration

Four orchestration primitives compose sub-agents into structured workflows:

- **SequentialAgent** — pipeline of steps with inter-step state passing via `inputKey`/`outputKey`
- **ParallelAgent** — concurrent fan-out with optional `maxConcurrency` limit
- **LoopAgent** — iterative refinement with configurable condition, mandatory `maxIterations` safety cap, and array iteration mode with configurable concurrency
- **ConditionalAgent** — ordered branch evaluation where the first matching condition wins, with optional default steps

All orchestration steps support **per-step retry** (`StepRetryPolicy` with exponential backoff) and **fail-branch** error handling (`StepFailBranch` — alternative agent invoked when a step fails all retries). Shared orchestration utilities (`executeWithRetry`, `runStepsSequentially`, `runWithConcurrencyLimit`, `prepareStepInput`, `recordStepOutput`) are extracted as reusable module-level functions.

Every sub-agent dispatch passes through the full Guardian pipeline. Orchestration does not create a security bypass path. Inter-step data flows through `SharedState` — a per-invocation, orchestrator-owned key-value store that sub-agents cannot access.

For built-in chat agents, that dispatch path crosses the broker boundary into the worker process before the LLM/tool loop runs.

## MCP Tool Server Integration

The MCP (Model Context Protocol) client consumes tools from external MCP-compatible servers over stdio transport. Tool names are namespaced (`mcp-<serverId>-<toolName>`) to prevent collisions. All MCP tool calls pass through Guardian admission, can infer `read_only` / `mutating` / `external_post` risk from MCP metadata, and support optional per-server `trustLevel` and `maxCallsPerMinute` overrides.

## Agent Evaluation Framework

Test agent behavior through the real Runtime with Guardian active:

- 5 content matchers (exact, contains, not_contains, regex, not_empty)
- Tool trajectory validation with ordered matching and optional steps
- 4 independent safety metrics (secret scanning, blocked patterns, denial detection, injection scoring)
- JSON-based test suites (`.eval.json`) for CI integration
- Human-readable reports with per-metric pass rates

## Four-Layer Defense

**Layer 1 — Proactive (before the agent sees input):**
- Prompt injection detection with invisible Unicode stripping (18 signal patterns)
- Per-agent rate limiting (burst, per-minute, per-hour sliding windows)
- Capability enforcement (per-agent permission grants)
- Secret scanning (30+ credential and PII patterns: AWS, GCP, GitHub, OpenAI, Stripe, Slack, and more)
- High-signal PII scanning on tool arguments (addresses, DOB, MRN, passport, driver's license)
- Sensitive path blocking with traversal normalization
- SSRF protection — centralized blocking of private IPs (RFC1918), loopback, link-local, cloud metadata endpoints (169.254.169.254, metadata.google.internal), IPv4-mapped IPv6, and decimal/hex/octal IP obfuscation
- **Policy-as-Code engine** — declarative JSON rules with deterministic evaluation, shadow mode for safe migration, and hot-reload

**Layer 2 — Guardian Agent (inline LLM evaluation before tool execution):**
- Evaluates every non-read-only tool action via LLM before execution
- Blocks high/critical risk actions; allows safe/low/medium with audit logging
- Configurable LLM: local (Ollama), external (OpenAI/Anthropic), or auto (local-first fallback)
- Fail-closed by default — actions blocked if LLM is unavailable (configurable: `failOpen: true` to override)
- All evaluations logged to audit trail with `controller: 'GuardianAgent'`

**Layer 3 — Output (after the agent responds, before output reaches anyone):**
- GuardedLLMProvider scans every LLM response for secrets automatically
- Response redaction replaces detected credentials with `[REDACTED]`
- Inter-agent event payloads are scanned before dispatch
- Tool results are wrapped as structured `<tool_result ...>` envelopes before they return to the model
- Tool-result strings are stripped of invisible Unicode, checked for prompt-injection signals, and PII-redacted before reinjection
- All detections logged to the audit trail

**Layer 4 — Sentinel Audit (retrospective, scheduled or on-demand):**
- Analyzes the audit log on a cron schedule or on-demand via web UI / API
- Detects anomaly patterns: capability probing, repeated secret detections, volume spikes, error storms
- Optional LLM-enhanced analysis for deeper pattern recognition

## Core Security Layers, Hardening, and AI Guardrails

- Layered defense lifecycle: proactive admission controls, inline LLM action evaluation (Guardian Agent), output-time leak prevention, and Sentinel audit analysis.
- Mandatory runtime chokepoints: every message, LLM call, response, and event is mediated by Runtime enforcement (not optional agent hooks).
- Brokered worker boundary: the default chat/planner execution loop runs in a separate worker process with no network access. Tools, approvals, and LLM API calls are all mediated through broker RPC.
- Prompt-injection resistance: invisible Unicode stripping plus weighted injection signal scoring before agent execution.
- Least-privilege capability model: per-agent capability grants with immutable frozen context (`Object.freeze`).
- Tool governance and sandboxing: approval workflows, per-tool policy overrides, path/command/domain allowlists, and risk-tiered tool classes.
- Connector + playbook guardrails (Option 2): declarative connector packs with host/path/command/capability allowlists, bounded step execution, and signed/dry-run controls.
- Secret exfiltration controls: multi-pattern secret scanning, response redaction/blocking, and inter-agent payload blocking.
- Intent hardening via SOUL profile: configurable `assistant.soul` injection with primary/delegated modes (`full`, `summary`, `disabled`) to balance consistency vs token overhead.
- Cryptographic correlation for tool actions: deterministic SHA-256 hashes of redacted tool args (`argsHash`) for approval/job traceability without raw secret retention.
- Web auth hardening: constant-time bearer comparison plus short-lived signed privileged tickets for auth configuration/rotation/reveal/revoke endpoints.
- Tamper-evident policy-change trail: SHA-256 config snapshots (`oldPolicyHash`/`newPolicyHash`) recorded as `policy_changed` audit events.
- Audit integrity: SHA-256 hash-chained JSONL persistence with chain verification support.
- SQLite integrity hardening: periodic `PRAGMA quick_check`, secure permissions, and hashed integrity checkpoints to detect storage drift/tampering.
- Resource containment: invocation budgets, queue/concurrency controls, token-rate constraints, and stall/error recovery backoff.

## Mandatory Enforcement

The Runtime controls every chokepoint where data flows in or out of an agent:

| Path | Enforcement |
|------|-------------|
| Message input | Guardian pipeline runs before agent sees it |
| LLM access | Agents get GuardedLLMProvider, not the raw provider |
| Response output | Scanned and redacted before reaching user |
| Event emission | Payloads scanned for secrets before dispatch |
| Resource limits | Concurrent, queue depth, token rate, wall-clock budgets |
| Agent context | Frozen with Object.freeze — capabilities immutable |

There is no `ctx.fs`, `ctx.http`, or `ctx.exec`. Framework-managed interaction points are `ctx.llm` (guarded), `ctx.emit()` (scanned), `ctx.dispatch()` (Guardian-checked per call), managed tools, and returning a response (scanned).

For the built-in chat/planner path, those interactions occur inside the brokered worker process.

## Policy-as-Code Engine

Declarative JSON rule files replace hard-coded approval logic with an auditable, version-controlled policy engine.

Policies are version-controlled, auditable, and hot-reloadable. They evaluate tool requests deterministically and support staged rollout through shadow and enforce modes.

See [`docs/specs/POLICY-AS-CODE-SPEC.md`](docs/specs/POLICY-AS-CODE-SPEC.md) for the full specification.

## Quick Start

Requires Node.js `>=20.0.0`.
SQLite persistence/security monitoring is enabled when the Node build includes `node:sqlite`; otherwise assistant memory/analytics automatically run in-memory.

Start GuardianAgent from the repository root using the platform start script in `scripts/`.

Then configure from web or CLI:
- Web: open `#/config` (Configuration Center). Telegram setup is in `Settings` -> `Telegram Channel`.
- CLI: use `/config`, `/auth`, `/tools`, `/connectors`, and `/playbooks` commands as needed

This configures local/external LLM providers, optional Telegram, web auth, and tool policy.

## Configuration

Most users should configure the assistant via the web Config Center or CLI `/config`, `/auth`, and `/tools` commands.
`config.yaml` is created/updated automatically by those flows.
Manual editing is optional and intended only for advanced troubleshooting.

Configuration details are documented in:

- [`docs/specs/CONFIG-CENTER-SPEC.md`](docs/specs/CONFIG-CENTER-SPEC.md)
- [`docs/specs/SETUP-WIZARD-SPEC.md`](docs/specs/SETUP-WIZARD-SPEC.md)

By default, GuardianAgent keeps tool sandboxing in `strict` mode. If a host cannot provide strong subprocess isolation, risky tool classes stay blocked until you either run on Linux/Unix with bubblewrap, or use the Windows portable app that bundles `guardian-sandbox-win.exe`. Switching to `assistant.tools.sandbox.enforcementMode: permissive` is an explicit opt-in to higher host risk.

Brokered agent isolation is enabled by default. LLM API calls are proxied through the broker — the worker has no network access. On strong hosts the worker uses the `agent-worker` sandbox profile with namespace isolation. On degraded hosts the worker uses the `workspace-write` profile with a hardened environment.

Three simplified top-level config aliases map to the internal machinery:

```yaml
sandbox_mode: strict           # off | workspace-write | strict
approval_policy: auto-approve  # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox additionalWritePaths
  - /home/user/projects
```

### Telegram Setup (Web + CLI)

1. Open Telegram, search for `@BotFather`, press **Start**, then run `/newbot`.
2. Follow prompts for bot name and username (username must end with `bot`), then copy the bot token.
3. Add the token in the web Configuration Center or the CLI configuration flow.
4. Restrict access with allowed chat IDs.
5. Restart GuardianAgent after Telegram channel changes.

## LLM Providers

- **Ollama** — local models via OpenAI-compatible API
- **Anthropic** — Claude models via `@anthropic-ai/sdk`
- **OpenAI** — GPT models via `openai` SDK

### Using Local and External Providers Together

When both a local (Ollama) and external (Anthropic/OpenAI) provider are configured, the system automatically splits work between them based on task type:

| Routes to **Local** model | Routes to **External** model |
|---|---|
| Filesystem, Shell, Network, System, Memory | Web, Browser, Workspace, Email, Contacts, Forum, Threat Intel, Search, Automation |

Local operations (file reads, shell commands, network scans) are fast and don't need a powerful model for result synthesis. External operations (Google Workspace, web search, email campaigns) benefit from the higher-quality reasoning of cloud models.

**Single-provider setups** work without configuration — when only one provider type exists, all tools route through it.

**Set the default provider** via the "Set as Default" button in Configuration > Providers. This controls which model handles general conversation and any tools without a routing preference.

**Smart LLM Routing** can be toggled off in Configuration > Tools if you want all tools to use the default provider regardless of category. Per-tool and per-category overrides are available via the LLM column dropdowns in the same tab.

**Quality-based fallback**: when the local model produces a degraded response (empty, refusal, or boilerplate), the system automatically retries through the fallback chain (typically the external provider). Configure explicitly with `fallbacks: [openai, anthropic]` or let it auto-detect from available providers.

## Channel Adapters

- **CLI** — interactive readline prompt
- **Telegram** — grammy bot framework with chat ID filtering
- **Web** — HTTP REST API with bearer token auth

## Personal Assistant UX Features

- Unified configuration center in web (`#/config`) and CLI (`/config`)
- Web authentication control plane in web Config Center and CLI (`/auth`)
- Cross-channel identity mapping (`single_user` or `channel_user` + aliases)
- SQLite-persisted conversation memory with sessions
- Tier-routed chat keeps one shared assistant conversation and knowledge base when switching between `auto`, `local-only`, and `external-only`
- SQLite DB hardening + monitoring (permission enforcement + integrity quick checks)
- Tools control plane in web (Configuration > Tools tab) and CLI (`/tools`) for approvals, policies, and workstation-safe actions
- Interactive sandbox allowlist editor in web (Configuration > Policy tab) for paths, commands, and domains
- Connector/playbook control plane in web (Network > Connectors tab) and CLI (`/connectors`, `/playbooks`) for pack governance, playbook registry, and guarded execution
- Security alert routing controls in web (Configuration > Settings > Security > Security Alerts) for CLI/web/Telegram delivery, severity thresholds, event families, and noisy-alert suppression
- Host and gateway monitoring in web (Security > Monitoring) with posture cards, active alerts, manual checks, and expanded raw audit details
- Campaign automation tools for contact discovery and approval-gated Gmail send workflows (`/campaign`)
- Quick actions for `email`, `task`, and `calendar` workflows
- Threat-intel workflow in web (Security > Threat Intel tab) for watchlist scans, findings triage, and response action drafts (human approval-gated publishing)
- Moltbook connector with hostile-site guardrails (strict host allowlist, timeout/size limits, payload sanitization)
- Channel analytics and monitoring in web (Security > Monitoring tab) and CLI (`/analytics`)
- Native document search (BM25 keyword + vector similarity) over user-defined collections — configure sources (directories, git repos, URLs, files) in web Config Center (`#/config` > Search Sources tab)

## Development

For local development, packaging, and platform-specific setup, use the scripts in `scripts/` and the architecture/spec documentation linked below. The README is intentionally kept high-level.

## Architecture

Full documentation in `docs/architecture/`:
- [Overview](docs/architecture/OVERVIEW.md) — system architecture and component map
- [Security](SECURITY.md) — four-layer defense system details
- [Guardian API](docs/architecture/GUARDIAN-API.md) — complete API reference
- [Decisions](docs/architecture/DECISIONS.md) — architecture decision records
- [SOUL](SOUL.md) — non-negotiable operating intent and guardrail constitution

Implementation specs in `docs/specs/`:
- [Brokered Agent Isolation](docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md)
- [Orchestration Agents](docs/specs/ORCHESTRATION-AGENTS-SPEC.md)
- [MCP Client](docs/specs/MCP-CLIENT-SPEC.md)
- [Native Skills](docs/specs/SKILLS-SPEC.md) — implemented local skills foundation and prompt injection model
- [Google Workspace Integration](docs/specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md) — managed `gws` MCP provider foundation and Google skill packs
- [Evaluation Framework](docs/specs/EVAL-FRAMEWORK-SPEC.md)
- [Shared State](docs/specs/SHARED-STATE-SPEC.md)
- [Setup And Config Flow](docs/specs/SETUP-WIZARD-SPEC.md)
- [Config Center](docs/specs/CONFIG-CENTER-SPEC.md)
- [Assistant Orchestrator](docs/specs/ASSISTANT-ORCHESTRATOR-SPEC.md)
- [Web Auth Configuration](docs/specs/WEB-AUTH-CONFIG-SPEC.md)
- [Tools Control Plane](docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)
- [Marketing Campaign Automation](docs/specs/MARKETING-CAMPAIGN-SPEC.md)
- [Identity & Memory](docs/specs/IDENTITY-MEMORY-SPEC.md)
- [Analytics](docs/specs/ANALYTICS-SPEC.md)
- [Quick Actions](docs/specs/QUICK-ACTIONS-SPEC.md)
- [Threat Intel](docs/specs/THREAT-INTEL-SPEC.md)
- [Threat Intel Research](docs/specs/THREAT-INTEL-RESEARCH.md)
- [Hostile Forum Connectors](docs/specs/HOSTILE-FORUM-CONNECTORS-SPEC.md)
- [Automation Framework](docs/specs/AUTOMATION-FRAMEWORK-SPEC.md)

Proposals in `docs/proposals/`:
- [Windows App Options](docs/proposals/WINDOWS-APP-OPTIONS.md) — deployment options for Windows local enforcement and native helper packaging
- [Windows Portable Isolation Option](docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md) — optional portable zip distribution for Windows users who want the extra native isolation layer without a traditional installer
- [Pipelock Comparison Roadmap](docs/proposals/PIPELOCK-COMPARISON-ROADMAP.md) — proposed MCP, egress, audit, and SIEM uplifts inspired by Pipelock's public architecture

## Disclaimer

This software is provided as-is, without warranty of any kind. GuardianAgent implements security controls designed to reduce risk in AI agent systems, but **no software can guarantee complete security**. The developers and contributors accept no liability for any damages, data loss, credential exposure, financial loss, or other harm arising from the use of this software.

By using GuardianAgent, you acknowledge that:
- AI systems are inherently unpredictable and may produce unexpected outputs
- Security patterns (secret scanning, prompt injection detection) rely on known signatures and heuristics, and may not catch novel or obfuscated attack vectors
- You are solely responsible for the configuration, deployment, and operation of this software in your environment
- You should independently evaluate whether the security controls are sufficient for your use case
- This software should not be used as a sole security control for systems handling sensitive data without additional safeguards

This project is not affiliated with any security certification body and makes no compliance claims.

## License

Apache 2.0
