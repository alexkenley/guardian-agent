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

## Screenshots

### Dashboard
<p align="center">
  <img src="docs/images/dashboard.png" alt="GuardianAgent dashboard" width="100%"/>
</p>

<p align="center">
  <em>Real-time system summary, alert queue, agent runtime health, and the integrated Guardian Assistant panel.</em>
</p>

<details>
  <summary>Open the full application gallery</summary>

  <p><em>Ordered the same way the app is navigated: Security, Network, Cloud, Automations, Configuration, and Reference Guide.</em></p>

  <table>
    <tr>
      <td align="center" width="50%">
        <a href="docs/images/security.png">
          <img src="docs/images/security.png" alt="GuardianAgent security view" width="100%"/>
        </a>
        <br/>
        <strong>Security</strong>
      </td>
      <td align="center" width="50%">
        <a href="docs/images/network.png">
          <img src="docs/images/network.png" alt="GuardianAgent network view" width="100%"/>
        </a>
        <br/>
        <strong>Network</strong>
      </td>
    </tr>
    <tr>
      <td align="center" width="50%">
        <a href="docs/images/cloud.png">
          <img src="docs/images/cloud.png" alt="GuardianAgent cloud view" width="100%"/>
        </a>
        <br/>
        <strong>Cloud</strong>
      </td>
      <td align="center" width="50%">
        <a href="docs/images/automations.png">
          <img src="docs/images/automations.png" alt="GuardianAgent automations view" width="100%"/>
        </a>
        <br/>
        <strong>Automations</strong>
      </td>
    </tr>
    <tr>
      <td align="center" width="50%">
        <a href="docs/images/configuration.png">
          <img src="docs/images/configuration.png" alt="GuardianAgent configuration view" width="100%"/>
        </a>
        <br/>
        <strong>Configuration</strong>
      </td>
      <td align="center" width="50%">
        <a href="docs/images/reference-guide.png">
          <img src="docs/images/reference-guide.png" alt="GuardianAgent reference guide view" width="100%"/>
        </a>
        <br/>
        <strong>Reference Guide</strong>
      </td>
    </tr>
  </table>
</details>

---

## Features

**AI & LLM**
- Multi-provider support — Ollama (local), Anthropic, OpenAI, plus Groq, Mistral, DeepSeek, Together, xAI, and Google Gemini
- Smart LLM routing — automatically directs tools to local or external models by category
- Circuit breaker, automatic failover, and quality-based fallback between providers
- Prompt caching for Anthropic (reduced latency on repeated system prompts)

**Agent Orchestration**
- Four orchestration primitives — Sequential, Parallel, Loop, and Conditional agents
- Per-step retry with exponential backoff and fail-branch error handling
- Inter-agent state passing through SharedState
- SOUL personality system with configurable profiles

**Security**
- Four-layer defense — admission controls, inline LLM action evaluation, output leak prevention, and retrospective audit
- Brokered agent isolation — the chat/planner loop runs in a separate worker process by default
- Guardian admission pipeline — capabilities, secret/PII scanning, path blocking, SSRF protection, prompt injection detection, rate limiting
- Policy-as-Code engine with shadow mode, hot-reload, and declarative JSON rules
- Cryptographic audit trail — SHA-256 hash-chained, tamper-evident event log

**Tools & Integrations**
- 70+ built-in tools with deferred loading and parallel execution
- MCP tool server integration with namespaced tools and Guardian admission on every call
- Native skills layer with Guardian manifests plus frontmatter-compatible reviewed imports for reusable workflow guidance
- Connector and playbook framework with allowlists, bounded execution, and dry-run mode
- Google Workspace integration (Gmail, Calendar, Drive, Docs, Sheets) via managed MCP
- Tool governance — approval workflows, per-tool policy overrides, risk-tiered tool classes

**Channels & Dashboard**
- CLI, Web UI, and Telegram bot with cross-channel identity mapping
- Web dashboard — real-time status, providers, agents, sessions, jobs, alerts, and integrated chat
- SSE-driven live refresh when config, automation, or network state changes

**Memory & Search**
- SQLite-backed conversation memory with FTS5 full-text search
- Per-agent knowledge base with automatic memory flush
- Native document search — hybrid BM25 keyword + vector similarity over directories, git repos, URLs, and files

**Monitoring & Operations**
- Host workstation monitoring — process, persistence, path, network, and firewall drift detection
- Gateway firewall monitoring for edge devices (OPNsense, pfSense, UniFi)
- Security alert routing — CLI, web, and Telegram delivery with severity and event-type filters
- Scheduled task management with presets, run history, and EventBus integration
- Threat intelligence — watchlist scanning, findings triage, and approval-gated response actions
- SQLite-backed analytics and usage tracking

---

## Security at a Glance

GuardianAgent enforces security at the Runtime level — agents cannot bypass it. Every message, LLM call, tool action, and response passes through mandatory chokepoints.

| Layer | When | What It Does |
|-------|------|--------------|
| **1 — Admission** | Before the agent sees input | Prompt injection detection, rate limiting, capability checks, secret/PII scanning, path blocking, SSRF protection |
| **1.5 — Process Sandbox** | During tool execution | OS-level isolation via bwrap namespaces (Linux), native helper (Windows), or ulimit/env hardening fallback |
| **2 — Guardian Agent** | Before tool execution | Inline LLM evaluates every non-read-only tool action; blocks high/critical risk. Fail-closed by default |
| **3 — Output Guardian** | After execution, before delivery | Scans all LLM responses and event payloads for secrets; redacts or blocks before output reaches anyone |
| **4 — Sentinel Audit** | Retrospective (scheduled or on-demand) | Analyzes audit log for anomaly patterns: capability probing, volume spikes, repeated secret detections, error storms |

The built-in chat/planner loop runs in a **brokered worker process** with no network access. Tools, approvals, and LLM API calls are mediated through broker RPC.

For the full security architecture, threat model, and configuration details, see [SECURITY.md](SECURITY.md).

---

## Getting Started

### Requirements

- **Node.js 20** or newer
- A local or external **LLM provider** (Ollama, Anthropic, OpenAI, etc.)

SQLite-backed persistence and monitoring are enabled when the Node build includes `node:sqlite`. Otherwise, assistant memory and analytics run in-memory automatically.

### Install & Start

Clone the repository and use the platform start script:

**Windows:**
```powershell
.\scripts\start-dev-windows.ps1
```

**Linux / macOS:**
```bash
bash scripts/start-dev-unix.sh
```

These scripts handle dependency installation, build, startup, and the initial configuration bootstrap.

### First Run

After startup:

1. **Open the web UI** and go to the **Configuration Center** (`#/config`)
2. **Add your LLM provider** — select Ollama for local models, or add an API key for Anthropic/OpenAI/etc.
3. **Review tool policy** — defaults to `approve_by_policy` (read-only tools auto-approved, mutating actions require approval)
4. **Enable optional channels** — Telegram bot setup is in Settings > Telegram Channel
5. **Set web auth** — a secure random token is generated by default; customize in Settings if needed

Most configuration is done through the **web UI** or **CLI commands** (`/config`, `/auth`, `/tools`). Manual `config.yaml` editing is optional and intended for advanced use.

### Using GuardianAgent

GuardianAgent is accessible through three channels:

| Channel | Access | Best For |
|---------|--------|----------|
| **Web** | Browser at the configured port | Full dashboard, configuration, monitoring, and chat |
| **CLI** | Terminal where GuardianAgent is running | Quick commands, scripting, and local development |
| **Telegram** | Telegram bot (requires setup) | Mobile access and notifications |

**What you can do:**
- Chat with the built-in AI assistant
- Run guarded filesystem, web, network, and automation tasks
- Create and schedule automations (single-tool and multi-step pipelines)
- Review audit logs, security alerts, and threat intelligence
- Monitor host and gateway security posture
- Search across documents, git repos, and web content
- Manage connectors, playbooks, and scheduled jobs

**Approvals and safety:** Depending on the tool policy and risk level, actions may run automatically, wait for your approval, or be denied before execution. Approval prompts appear natively in all channels (buttons in web/Telegram, interactive prompt in CLI).

### Telegram Setup

1. Open Telegram, search for `@BotFather`, press **Start**, run `/newbot`
2. Follow prompts for bot name and username (must end with `bot`), copy the bot token
3. Add the token in the web Configuration Center or CLI configuration flow
4. Restrict access with allowed chat IDs
5. Restart GuardianAgent after Telegram channel changes

### Windows Portable Build (Optional)

For additional native subprocess isolation on Windows:

```powershell
npm run portable:windows     # Portable zip with sandbox helper
npm run installer:windows    # Traditional installer
```

See [INSTALLATION.md](INSTALLATION.md) for the full list of Windows packaging options.

---

## LLM Providers

GuardianAgent supports 9 LLM providers through a curated ProviderRegistry:

| Provider | Type | Notes |
|----------|------|-------|
| **Ollama** | Local | OpenAI-compatible API, runs models locally |
| **Anthropic** | External | Claude models with prompt caching |
| **OpenAI** | External | GPT models |
| **Groq** | External | Fast inference |
| **Mistral** | External | Mistral models |
| **DeepSeek** | External | DeepSeek models |
| **Together** | External | Open-source model hosting |
| **xAI** | External | Grok models |
| **Google Gemini** | External | Gemini models |

### Smart Routing

When both local and external providers are configured, tools automatically route by category:

| Routes to **Local** model | Routes to **External** model |
|---|---|
| Filesystem, Shell, Network, System, Memory | Web, Browser, Workspace, Email, Contacts, Search, Automation |

Single-provider setups work without configuration. Smart routing can be toggled off in Configuration > Tools. Per-tool and per-category overrides are available via the LLM column dropdowns.

**Quality-based fallback:** When the local model produces a degraded response (empty, refusal, or boilerplate), the system automatically retries through the fallback chain.

---

## Configuration

Most users configure GuardianAgent through the **web Config Center** (`#/config`) or **CLI commands**. The `config.yaml` file at `~/.guardianagent/config.yaml` is created and updated automatically by those flows.

Three simplified top-level config aliases cover the most common settings:

```yaml
sandbox_mode: strict           # off | workspace-write | strict
approval_policy: auto-approve  # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox writePaths
  - /home/user/projects
```

By default, tool sandboxing is `strict` — risky subprocess-backed tools are blocked unless a strong sandbox backend is available. Switching to `permissive` is an explicit opt-in.

For detailed configuration documentation:
- [Config Center Spec](docs/specs/CONFIG-CENTER-SPEC.md)
- [Setup Wizard Spec](docs/specs/SETUP-WIZARD-SPEC.md)

---

## Architecture & Documentation

**Architecture:**
- [Overview](docs/architecture/OVERVIEW.md) — system architecture and component map
- [Security](SECURITY.md) — four-layer defense system, threat model, and security configuration
- [Guardian API](docs/architecture/GUARDIAN-API.md) — complete API reference
- [Decisions](docs/architecture/DECISIONS.md) — architecture decision records
- [SOUL](SOUL.md) — operating intent and guardrail constitution

**Specs:**
- [Brokered Agent Isolation](docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md)
- [Orchestration Agents](docs/specs/ORCHESTRATION-AGENTS-SPEC.md)
- [MCP Client](docs/specs/MCP-CLIENT-SPEC.md)
- [Native Skills](docs/specs/SKILLS-SPEC.md)
- [Google Workspace](docs/specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md)
- [Evaluation Framework](docs/specs/EVAL-FRAMEWORK-SPEC.md)
- [Policy-as-Code](docs/specs/POLICY-AS-CODE-SPEC.md)
- [Tools Control Plane](docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)
- [Identity & Memory](docs/specs/IDENTITY-MEMORY-SPEC.md)
- [Automation Framework](docs/specs/AUTOMATION-FRAMEWORK-SPEC.md)

<details>
<summary>All specs</summary>

- [Shared State](docs/specs/SHARED-STATE-SPEC.md)
- [Setup And Config Flow](docs/specs/SETUP-WIZARD-SPEC.md)
- [Config Center](docs/specs/CONFIG-CENTER-SPEC.md)
- [Assistant Orchestrator](docs/specs/ASSISTANT-ORCHESTRATOR-SPEC.md)
- [Web Auth Configuration](docs/specs/WEB-AUTH-CONFIG-SPEC.md)
- [Marketing Campaign Automation](docs/specs/MARKETING-CAMPAIGN-SPEC.md)
- [Analytics](docs/specs/ANALYTICS-SPEC.md)
- [Quick Actions](docs/specs/QUICK-ACTIONS-SPEC.md)
- [Threat Intel](docs/specs/THREAT-INTEL-SPEC.md)
- [Threat Intel Research](docs/specs/THREAT-INTEL-RESEARCH.md)
- [Hostile Forum Connectors](docs/specs/HOSTILE-FORUM-CONNECTORS-SPEC.md)

</details>

**Proposals:**
- [Windows App Options](docs/proposals/WINDOWS-APP-OPTIONS.md)
- [Windows Portable Isolation](docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md)
- [Pipelock Comparison Roadmap](docs/proposals/PIPELOCK-COMPARISON-ROADMAP.md)

---

## Development

```bash
npm test                              # Run all tests (vitest)
npm run test:verbose                  # Verbose test output
npm run test:coverage                 # Run with v8 coverage
npx vitest run src/path/to.test.ts   # Run a single test file

npm run check         # Type-check only (tsc --noEmit)
npm run build         # TypeScript compilation → dist/
npm run dev           # Run with tsx (starts CLI channel)
```

For local development, packaging, and platform-specific setup, use the scripts in `scripts/` and the architecture/spec documentation linked above.

---

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
