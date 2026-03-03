# GuardianAgent

```
  ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ██╗ █████╗ ███╗   ██╗
  ██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██║██╔══██╗████╗  ██║
  ██║  ███╗██║   ██║███████║██████╔╝██║  ██║██║███████║██╔██╗ ██║
  ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║██║██╔══██║██║╚██╗██║
  ╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝██║██║  ██║██║ ╚████║
   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝

       █████╗  ██████╗ ███████╗███╗   ██╗████████╗
      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
  ═══════════════════════════════════════════════════════════════════
       ─────────────────────────────────────────────────────────
            ═══════════════════════════════════════════════
                  ─────────────────────────────────────
                        ═════════════════════════

        Three-Layer Defense  |  Real-Time Dashboard
```

Security-first AI agent orchestration system. Built-in agents with predefined capabilities, strict guardrails on what they can and cannot do, and a three-layer defense system that enforces security at every stage of the message lifecycle.

## What This Is

GuardianAgent is a self-contained orchestrator for personal assistant AI. Agents are built into the system with predefined capabilities. The Runtime manages their lifecycle. The LLM output is the untrusted component, not the agent code, and all enforcement targets the data path where risk lives.

All security enforcement is **mandatory at the Runtime level**. Agents cannot bypass it.

## Multi-Agent Orchestration

Three orchestration primitives compose sub-agents into structured workflows:

- **SequentialAgent** — pipeline of steps with inter-step state passing via `inputKey`/`outputKey`
- **ParallelAgent** — concurrent fan-out with optional `maxConcurrency` limit
- **LoopAgent** — iterative refinement with configurable condition and mandatory `maxIterations` safety cap

Every sub-agent dispatch passes through the full Guardian pipeline. Orchestration does not create a security bypass path. Inter-step data flows through `SharedState` — a per-invocation, orchestrator-owned key-value store that sub-agents cannot access.

## MCP Tool Server Integration

The MCP (Model Context Protocol) client consumes tools from external MCP-compatible servers over stdio transport. Tool names are namespaced (`mcp:<serverId>:<toolName>`) to prevent collisions. All MCP tool calls pass through Guardian admission and are classified as `network` risk.

## Agent Evaluation Framework

Test agent behavior through the real Runtime with Guardian active:

- 5 content matchers (exact, contains, not_contains, regex, not_empty)
- Tool trajectory validation with ordered matching and optional steps
- 4 independent safety metrics (secret scanning, blocked patterns, denial detection, injection scoring)
- JSON-based test suites (`.eval.json`) for CI integration
- Human-readable reports with per-metric pass rates

## Three-Layer Defense

**Layer 1 — Proactive (before the agent sees input):**
- Prompt injection detection with invisible Unicode stripping (18 signal patterns)
- Per-agent rate limiting (burst, per-minute, per-hour sliding windows)
- Capability enforcement (per-agent permission grants)
- Secret scanning (28+ credential patterns: AWS, GCP, GitHub, OpenAI, Stripe, Slack, and more)
- Sensitive path blocking with traversal normalization

**Layer 2 — Output (after the agent responds, before output reaches anyone):**
- GuardedLLMProvider scans every LLM response for secrets automatically
- Response redaction replaces detected credentials with `[REDACTED]`
- Inter-agent event payloads are scanned before dispatch
- All detections logged to the audit trail

**Layer 3 — Sentinel (retrospective, scheduled):**
- Sentinel agent analyzes the audit log on a cron schedule
- Detects anomaly patterns: capability probing, repeated secret detections, volume spikes, error storms
- Optional LLM-enhanced analysis for deeper pattern recognition

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

There is no `ctx.fs`, `ctx.http`, or `ctx.exec`. The agent's only interaction points are `ctx.llm` (guarded), `ctx.emit()` (scanned), and returning a response (scanned).

## Quick Start

```bash
npm install guardianagent
```

Requires Node.js `>=20.0.0`.
SQLite persistence/security monitoring is enabled when the Node build includes `node:sqlite`; otherwise assistant memory/analytics automatically run in-memory.

Run:

```bash
npx guardianagent
# or
guardianagent              # if installed globally
```

Then configure from web/CLI (no manual YAML editing required):
- Web: open `#/config` (Configuration Center)
- CLI: use `/config`, `/auth`, and `/tools` commands as needed

This configures local/external LLM providers, optional Telegram, web auth, and tool policy.

## Configuration

Most users should configure the assistant via the web Config Center or CLI `/config`, `/auth`, and `/tools` commands.
`config.yaml` is created/updated automatically by those flows.
Manual editing is optional and intended only for advanced troubleshooting.

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
    auth:
      mode: bearer_required
      token: ${WEB_AUTH_TOKEN}
      rotateOnStartup: false
      sessionTtlMinutes: 120

assistant:
  setup:
    completed: false
  identity:
    mode: single_user
    primaryUserId: owner
  memory:
    enabled: true
    sqlitePath: ~/.guardianagent/assistant-memory.sqlite
    retentionDays: 30
  analytics:
    enabled: true
    sqlitePath: ~/.guardianagent/assistant-analytics.sqlite
    retentionDays: 30
  tools:
    enabled: true
    policyMode: approve_by_policy
    allowExternalPosting: false
    allowedPaths: [./docs, ./workspace]
    allowedCommands: [npm, node, git]
    allowedDomains: [github.com, openai.com, anthropic.com, gmail.googleapis.com]
    toolPolicies:
      forum_post: deny
  quickActions:
    enabled: true
    templates:
      email: "Draft a concise, professional email based on these details:\n{details}"
      task: "Turn this into a clear prioritized task list:\n{details}"
      calendar: "Create a calendar-ready event plan from these details:\n{details}"
  threatIntel:
    enabled: true
    allowDarkWeb: false
    responseMode: assisted
    watchlist: []
    autoScanIntervalMinutes: 180
    moltbook:
      enabled: false
      mode: mock
      baseUrl: https://moltbook.com
      searchPath: /api/v1/posts/search
      requestTimeoutMs: 8000
      maxPostsPerQuery: 20
      maxResponseBytes: 262144
      allowedHosts: [moltbook.com, api.moltbook.com]
      allowActiveResponse: false

guardian:
  enabled: true
  logDenials: true
  inputSanitization:
    enabled: true
    blockThreshold: 3
  rateLimit:
    maxPerMinute: 30
    maxPerHour: 500
    burstAllowed: 5
  outputScanning:
    enabled: true
    redactSecrets: true
  sentinel:
    enabled: true
    schedule: '*/5 * * * *'
  auditLog:
    maxEvents: 10000
```

## LLM Providers

- **Ollama** — local models via OpenAI-compatible API
- **Anthropic** — Claude models via `@anthropic-ai/sdk`
- **OpenAI** — GPT models via `openai` SDK

## Channel Adapters

- **CLI** — interactive readline prompt
- **Telegram** — grammy bot framework with chat ID filtering
- **Web** — HTTP REST API with bearer token auth

## Personal Assistant UX Features

- Unified configuration center in web (`#/config`) and CLI (`/config`)
- Web authentication control plane in web Config Center and CLI (`/auth`)
- Cross-channel identity mapping (`single_user` or `channel_user` + aliases)
- SQLite-persisted conversation memory with sessions
- SQLite DB hardening + monitoring (permission enforcement + integrity quick checks)
- Tools control plane in web (`#/tools`) and CLI (`/tools`) for approvals, policies, and workstation-safe actions
- Campaign automation tools for contact discovery and approval-gated Gmail send workflows (`/campaign`)
- Quick actions for `email`, `task`, and `calendar` workflows
- Threat-intel workflow for watchlist scans, findings triage, and response action drafts (human approval-gated publishing)
- Moltbook connector with hostile-site guardrails (strict host allowlist, timeout/size limits, payload sanitization)
- Channel analytics summary in web Monitoring and CLI (`/analytics`)

### Key Commands

- CLI: `/config`, `/auth`, `/tools`, `/campaign`, `/assistant`, `/quick`, `/session`, `/analytics`, `/intel`, `/guide`
- Telegram: `/help`, `/guide`, `/reset`, `/quick`, `/intel`
- Web: Config Center, Chat quick-actions bar, Tools tab, Assistant tab, Threat Intel tab, Reference Guide tab

For Gmail campaign sends, provide OAuth token via `GOOGLE_OAUTH_ACCESS_TOKEN` (scope: `gmail.send`) or `accessToken` tool arg.

## Development

```bash
npm test              # Run tests (vitest)
npm run build         # TypeScript compilation
npm run dev           # Run with tsx (development)
npm start             # Run compiled (production)
```

## Architecture

Full documentation in `docs/architecture/`:
- [Overview](docs/architecture/OVERVIEW.md) — system architecture and component map
- [Security](docs/architecture/SECURITY.md) — three-layer defense system details
- [Guardian API](docs/architecture/GUARDIAN-API.md) — complete API reference
- [Decisions](docs/architecture/DECISIONS.md) — architecture decision records

Implementation specs in `docs/specs/`:
- [Orchestration Agents](docs/specs/ORCHESTRATION-AGENTS-SPEC.md)
- [MCP Client](docs/specs/MCP-CLIENT-SPEC.md)
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

[MIT](LICENSE)
