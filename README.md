<p align="center">
  <img src="docs/images/guardian agent banner.png" alt="GuardianAgent banner" width="100%"/>
</p>

<h1 align="center">GuardianAgent</h1>

<h3 align="center">Security-first AI assistant with a Second Brain and operator tooling.</h3>

<p align="center">
  GuardianAgent combines a daily-use Second Brain with guarded power-user surfaces for coding, workstation operations, automations, security, network, and cloud operations. The same assistant is available in web, CLI, and Telegram, with approvals and policy boundaries enforced by the runtime.
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

## Product Overview

### Second Brain

Second Brain (`#/`) is the default web home.

- Capture and organize tasks, notes, people, routines, and calendar context
- Use the assistant for planning, retrieval, and deterministic brief generation
- Keep daily context separate from the operator and workstation consoles
- Further reading: [Second Brain As-Built Spec](docs/specs/SECOND-BRAIN-AS-BUILT-SPEC.md)

### Power User Capabilities

- `Performance` (`#/performance`) for workstation health, editable profiles, live processes, and reviewed cleanup. See [Performance Management Spec](docs/specs/PERFORMANCE-MANAGEMENT-SPEC.md).
- `Code` (`#/code`) for repo-scoped coding sessions with chat, Monaco editor, diffing, approvals, and terminals. See [Coding Workspace Spec](docs/specs/CODING-WORKSPACE-SPEC.md).
- `Automations` (`#/automations`) for saved and scheduled Guardian workflows and assistant tasks. See [Automation Framework Spec](docs/specs/AUTOMATION-FRAMEWORK-SPEC.md).
- `Security`, `Network`, and `Cloud` for alerts, posture, diagnostics, and infrastructure oversight. Start with [WebUI Design Spec](docs/specs/WEBUI-DESIGN-SPEC.md) and [SECURITY.md](SECURITY.md).
- `Configuration` and `Reference Guide` for setup, integrations, policy, and operator guidance.

### Shared Assistant

- Web, CLI, and Telegram all use the same guarded assistant model
- Local and external LLM providers are supported, including Ollama, Anthropic, OpenAI, and others
- Built-in tools, integrations, memory, and automations stay behind approval and policy controls
- More detail: [WebUI Design Spec](docs/specs/WEBUI-DESIGN-SPEC.md), [Tools Control Plane Spec](docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)

## Screenshots

Second Brain is the default web home at `#/`. The screenshot gallery below still includes the operator-focused Dashboard alias while a dedicated Second Brain capture is pending.

### Operator Dashboard
<p align="center">
  <img src="docs/images/dashboard.png" alt="GuardianAgent dashboard" width="100%"/>
</p>

<p align="center">
  <em>Operator summary, alert queue, runtime health, and the integrated assistant panel at the legacy `#/dashboard` route.</em>
</p>

<details>
  <summary>Open the full application gallery</summary>

  <p><em>Second Brain is the main landing page. The gallery below currently shows the operator Dashboard alias plus the remaining major product surfaces.</em></p>

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
        <a href="docs/images/Coding-assistant-gruvbox.png">
          <img src="docs/images/Coding-assistant-gruvbox.png" alt="GuardianAgent coding assistant view" width="100%"/>
        </a>
        <br/>
        <strong>Coding Assistant</strong>
      </td>
    </tr>
    <tr>
      <td align="center" colspan="2">
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

## Core Capabilities

- A daily-use Second Brain for planning, capture, retrieval, and personal context
- Power-user surfaces for performance management, coding, security, network, cloud, and automations
- A shared assistant across Web, CLI, and Telegram
- Multi-provider LLM support with guarded tools, approvals, and policy controls
- Search, integrations, and workflow automation without collapsing everything into raw shell access
- Specs and architecture docs for the deeper implementation detail when you need it

## Project Structure

- `src/` — core application runtime, orchestration, tools, channels, prompts, and memory systems
- `web/public/` — dashboard UI, chat panel, code workspace UI, and browser-side assets
- `scripts/` — setup helpers, test harnesses, and verification scripts
- `docs/` — architecture notes, specs, guides, research, and supporting documentation
- `docs/plans/` — implementation roadmaps and status trackers
- `policies/` — rule and policy files
- `native/windows-helper/` — Windows native helper components

## Development Commands

- `npm run dev` — start GuardianAgent in development mode
- `npm run build` — compile TypeScript into `dist/`
- `npm run check` — run TypeScript checking without emitting output
- `npm test` — run the Vitest suite
- `node scripts/test-code-ui-smoke.mjs` — run the web/code UI smoke harness
- `node scripts/test-coding-assistant.mjs` — run the coding assistant smoke harness

## Security at a Glance

GuardianAgent enforces security at the Runtime level — agents cannot bypass it. Every message, LLM call, tool action, and response passes through mandatory chokepoints.

| Layer | When | What It Does |
|-------|------|--------------|
| **1 — Admission** | Before the agent sees input | Prompt injection detection, rate limiting, capability checks, secret/PII scanning, path blocking, SSRF protection |
| **1.5 — Process Sandbox** | During tool execution | OS-level isolation via bwrap namespaces (Linux), native helper (Windows), or ulimit/env hardening fallback |
| **2 — Guardian Agent** | Before tool execution | Inline LLM evaluates every non-read-only tool action; blocks high/critical risk. Fail-closed by default |
| **3 — Output Guardian** | After execution, before delivery or reinjection | Scans LLM responses and tool results, classifies trust (`trusted` / `low_trust` / `quarantined`), redacts secrets/PII, and can suppress raw reinjection |
| **4 — Sentinel Audit** | Retrospective (scheduled or on-demand) | Analyzes audit log for anomaly patterns: capability probing, volume spikes, repeated secret detections, error storms |

The built-in chat/planner loop runs in a **brokered worker process** with no network access. Tools, approvals, trust metadata, and LLM API calls are mediated through broker RPC.

Install-like public package-manager actions are also routed through a dedicated managed path. Guardian uses `package_install` to stage the requested top-level package artifacts, review them before execution, and surface caution or blocked findings in the unified security workflow instead of treating package installs as ordinary shell commands.

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
3. **Open Second Brain** at `#/` to confirm the default daily-home surface is live and the assistant is ready for task, note, calendar, and people workflows.
4. **Connect Google Workspace or Microsoft 365 if needed** — use Configuration > Integrations when you want provider-backed calendar and contacts synced into Second Brain.
5. **Review tool policy** — defaults to `on-request` / `approve_each` for the main assistant, with a read-only shell allowlist. Mutating tools still require approval, and public package-manager installs should go through the managed `package_install` path instead of `shell_safe`.
6. **Enable optional channels** — Telegram bot setup is in Settings > Telegram Channel
7. **Set web auth** — a secure random token is generated by default; customize in Settings if needed
8. **Open the Coding Assistant if needed** — go to `#/code` for a project-scoped coding workspace with its own session history, terminals, approvals, and verification surfaces

Most configuration is done through the **web UI** or **CLI commands** (`/config`, `/auth`, `/tools`). Manual `config.yaml` editing is optional and intended for advanced use.

### Using GuardianAgent

GuardianAgent is accessible through three channels:

| Channel | Access | Best For |
|---------|--------|----------|
| **Web** | Browser at the configured port | Second Brain, dashboard/operator surfaces, configuration, monitoring, chat, and coding workspace |
| **CLI** | Terminal where GuardianAgent is running | Quick commands, scripting, and local development |
| **Telegram** | Telegram bot (requires setup) | Mobile access and notifications |

**What you can do:**
- Chat with the built-in AI assistant
- Use Second Brain as the default daily home for tasks, notes, people, routines, and calendar-aware planning
- Use Performance, Security, Network, Cloud, and Automations as dedicated operator surfaces instead of burying everything in chat
- Use the Coding Assistant for repository-scoped work with editor, diffing, approvals, checks, and terminals
- Run guarded tools, integrations, search, and automation workflows across the same assistant

**Approvals and safety:** Actions may run automatically, wait for approval, or be denied depending on policy, trust level, and tool risk. For the detailed behavior, see [SECURITY.md](SECURITY.md) and [Tools Control Plane Spec](docs/specs/TOOLS-CONTROL-PLANE-SPEC.md).

### Coding Assistant

The web `Code` page is a dedicated repo-scoped workspace with its own session context, editor, diffing, approvals, checks, and terminals.

Implementation detail and current limitations are documented in [docs/specs/CODING-WORKSPACE-SPEC.md](docs/specs/CODING-WORKSPACE-SPEC.md).

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
approval_policy: on-request    # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox writePaths
  - /home/user/projects
```

By default, tool sandboxing is `strict` — risky subprocess-backed tools are blocked unless a strong sandbox backend is available. Switching to `permissive` is an explicit opt-in.

For detailed configuration documentation:
- [Config Center Spec](docs/specs/CONFIG-CENTER-SPEC.md)
- [Setup Wizard Spec](docs/specs/SETUP-WIZARD-SPEC.md)

---

## Further Reading

- [SECURITY.md](SECURITY.md) for the security model and trust boundaries
- [WebUI Design Spec](docs/specs/WEBUI-DESIGN-SPEC.md) for page ownership and product-surface design
- [Second Brain As-Built Spec](docs/specs/SECOND-BRAIN-AS-BUILT-SPEC.md) for the daily-home experience
- [Performance Management Spec](docs/specs/PERFORMANCE-MANAGEMENT-SPEC.md) for workstation operations
- [Coding Workspace Spec](docs/specs/CODING-WORKSPACE-SPEC.md) for the repo-scoped IDE surface
- [Automation Framework Spec](docs/specs/AUTOMATION-FRAMEWORK-SPEC.md) for saved and scheduled automation behavior
- [Config Center Spec](docs/specs/CONFIG-CENTER-SPEC.md) for setup, integrations, and policy controls
- [docs/](docs/) for the full architecture, specs, guides, proposals, and research set

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
