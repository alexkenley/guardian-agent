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

## Core Security Layers, Hardening, and AI Guardrails

- Layered defense lifecycle: proactive admission controls, output-time leak prevention, and scheduled Sentinel anomaly analysis.
- Mandatory runtime chokepoints: every message, LLM call, response, and event is mediated by Runtime enforcement (not optional agent hooks).
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
- CLI: use `/config`, `/auth`, `/tools`, `/connectors`, and `/playbooks` commands as needed

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
  soul:
    enabled: true
    path: ./SOUL.md
    primaryMode: full
    delegatedMode: summary
    maxChars: 8000
    summaryMaxChars: 1000
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
    qmd:
      enabled: false
      # binaryPath: qmd          # Path to QMD binary (default: 'qmd' via PATH)
      defaultMode: query          # search | vsearch | query
      queryTimeoutMs: 30000
      maxResults: 20
      sources:
        - id: my-notes
          name: My Notes
          type: directory           # directory | git | url | file
          path: ~/Documents/notes
          globs: ['**/*.md', '**/*.txt']
          enabled: true
        # - id: wiki
        #   name: Team Wiki
        #   type: git
        #   path: https://github.com/org/wiki
        #   branch: main
        #   globs: ['**/*.md']
        #   enabled: true
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
  connectors:
    enabled: false
    executionMode: plan_then_execute
    maxConnectorCallsPerRun: 12
    packs: []
    playbooks:
      enabled: true
      maxSteps: 12
      maxParallelSteps: 3
      defaultStepTimeoutMs: 15000
      requireSignedDefinitions: true
      requireDryRunOnFirstExecution: true
    studio:
      enabled: true
      mode: builder
      requirePrivilegedTicket: true

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
- Tools control plane in web (Configuration > Tools tab) and CLI (`/tools`) for approvals, policies, and workstation-safe actions
- Interactive sandbox allowlist editor in web (Configuration > Policy tab) for paths, commands, and domains
- Connector/playbook control plane in web (Network > Connectors tab) and CLI (`/connectors`, `/playbooks`) for pack governance, playbook registry, and guarded execution
- Campaign automation tools for contact discovery and approval-gated Gmail send workflows (`/campaign`)
- Quick actions for `email`, `task`, and `calendar` workflows
- Threat-intel workflow in web (Security > Threat Intel tab) for watchlist scans, findings triage, and response action drafts (human approval-gated publishing)
- Moltbook connector with hostile-site guardrails (strict host allowlist, timeout/size limits, payload sanitization)
- Channel analytics and monitoring in web (Security > Monitoring tab) and CLI (`/analytics`)
- QMD hybrid document search (BM25 + vector + LLM re-ranking) over user-defined collections — configure sources (directories, git repos, URLs, files) in web Config Center (`#/config` > Search Sources tab)

### Key Commands

- CLI: `/config`, `/auth`, `/tools`, `/connectors`, `/playbooks`, `/campaign`, `/assistant`, `/quick`, `/session`, `/analytics`, `/intel`, `/guide`
- Telegram: `/help`, `/guide`, `/reset`, `/quick`, `/intel`
- Web: Dashboard, Security (Audit/Monitoring/Threat Intel), Network (Connectors/Devices), Operations (Scheduled Tasks/Run History), Configuration (Providers/Tools/Policy/Search Sources/Settings), Reference Guide, Chat

### Connector + Playbook CLI (Web Parity)

- Connector framework status + packs: `/connectors status`, `/connectors packs`
- Connector settings: `/connectors settings ...` with `enable|disable`, `mode`, `limit`, `playbooks` controls, `studio` controls, and `json` bulk updates
- Playbook controls: `/playbooks list`, `/playbooks runs`, `/playbooks run <playbookId> [--dry-run]`, `/playbooks upsert <json>`, `/playbooks delete <playbookId>`
- Pack controls: `/connectors pack upsert <json>`, `/connectors pack delete <packId>`

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
- [Security](SECURITY.md) — three-layer defense system details
- [Guardian API](docs/architecture/GUARDIAN-API.md) — complete API reference
- [Decisions](docs/architecture/DECISIONS.md) — architecture decision records
- [SOUL](SOUL.md) — non-negotiable operating intent and guardrail constitution

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
- [Connector + Playbook Framework (Option 2)](docs/specs/CONNECTOR-PLAYBOOK-FRAMEWORK-SPEC.md)

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
