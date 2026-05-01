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
  <img src="https://img.shields.io/badge/LLM-Local%20%7C%20Managed%20Cloud%20%7C%20Frontier-blueviolet?style=for-the-badge" alt="Multi-LLM"/>
  <img src="https://img.shields.io/badge/CHANNELS-CLI%20%7C%20Web%20%7C%20Telegram-2496ED?style=for-the-badge" alt="Multi-Channel"/>
</p>

## Product Overview

### Second Brain

Second Brain (`#/`) is the default web home.

- `Today` centers the day around agenda, quick capture, priority tasks, briefs, notes, and routines
- `Calendar` combines synced and local events with assistant-aware planning and follow-up
- `Tasks` provides a lightweight board for priorities, due dates, and status tracking
- `Notes` keeps searchable, pinnable, and archivable notes in one place
- `Contacts`, `Library`, `Briefs`, and `Routines` round out the daily-use memory and upkeep workflow
- Keep daily context separate from the operator and workstation consoles
- Further reading: [Second Brain As-Built Design](docs/design/SECOND-BRAIN-AS-BUILT.md)

<p align="center">
  <a href="docs/images/secondbrain/Screenshot%202026-04-08%20134400.png">
    <img src="docs/images/secondbrain/Screenshot%202026-04-08%20134400.png" alt="GuardianAgent Second Brain Today view" width="100%"/>
  </a>
</p>

<p align="center">
  <em>Today is the default Second Brain landing view for agenda, capture, tasks, briefs, notes, and routines.</em>
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <a href="docs/images/secondbrain/Screenshot%202026-04-08%20134425.png">
        <img src="docs/images/secondbrain/Screenshot%202026-04-08%20134425.png" alt="GuardianAgent Second Brain Calendar view" width="100%"/>
      </a>
      <br/>
      <strong>Calendar</strong>
    </td>
    <td align="center" width="50%">
      <a href="docs/images/secondbrain/Screenshot%202026-04-08%20134510.png">
        <img src="docs/images/secondbrain/Screenshot%202026-04-08%20134510.png" alt="GuardianAgent Second Brain Tasks view" width="100%"/>
      </a>
      <br/>
      <strong>Tasks</strong>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/images/secondbrain/Screenshot%202026-04-08%20134540.png">
        <img src="docs/images/secondbrain/Screenshot%202026-04-08%20134540.png" alt="GuardianAgent Second Brain Notes view" width="100%"/>
      </a>
      <br/>
      <strong>Notes</strong>
    </td>
    <td align="center" width="50%">
      <a href="docs/images/secondbrain/Screenshot%202026-04-08%20134604.png">
        <img src="docs/images/secondbrain/Screenshot%202026-04-08%20134604.png" alt="GuardianAgent Second Brain Routines view" width="100%"/>
      </a>
      <br/>
      <strong>Routines</strong>
    </td>
  </tr>
</table>

### Power User Capabilities

- `Performance` (`#/performance`) for workstation health, editable profiles, live processes, and reviewed cleanup. See [Performance Management Spec](docs/design/PERFORMANCE-MANAGEMENT-DESIGN.md).
- `Code` (`#/code`) for repo-scoped coding sessions with chat, Monaco editor, diffing, approvals, trust review, session-bound terminals, and workspace-scoped execution. See [Coding Workspace Spec](docs/design/CODING-WORKSPACE-DESIGN.md).
- `Automations` (`#/automations`) for saved and scheduled Guardian workflows and assistant tasks. See [Automation Framework Spec](docs/design/AUTOMATION-FRAMEWORK-DESIGN.md).
- `Security`, `Network`, and `Cloud` for alerts, posture, diagnostics, and infrastructure oversight. Start with [WebUI Design](docs/design/WEBUI-DESIGN.md) and [SECURITY.md](SECURITY.md).
- `Configuration` and `Reference Guide` for setup, integrations, policy, and operator guidance.

### Shared Assistant

- Web, CLI, and Telegram all use the same guarded assistant model
- Local, managed-cloud, and frontier LLM providers are supported, including Ollama, Ollama Cloud, OpenRouter, NVIDIA Cloud, Anthropic, OpenAI, and other OpenAI-compatible providers
- Built-in tools, integrations, memory, and automations stay behind approval and policy controls
- More detail: [WebUI Design](docs/design/WEBUI-DESIGN.md), [Tools Control Plane Design](docs/design/TOOLS-CONTROL-PLANE-DESIGN.md)

## Screenshots

Second Brain screenshots are shown above in Product Overview. The gallery below covers the remaining major Guardian surfaces.

<details>
  <summary>Open the full application gallery</summary>

  <p><em>Security, Network, Cloud, Automations, Configuration, Coding Workspace, and Reference Guide.</em></p>

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
          <img src="docs/images/Coding-assistant-gruvbox.png" alt="GuardianAgent coding workspace view" width="100%"/>
        </a>
        <br/>
        <strong>Coding Workspace</strong>
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
- `docs/plans/` — active implementation roadmaps and status trackers
- `docs/implemented/` and `docs/archive/` — historical proposals and completed plans
- `policies/` — rule and policy files
- `native/windows-helper/` — Windows native helper components

## Development Commands

- `npm run dev` — start GuardianAgent in development mode
- `npm run build` — compile TypeScript into `dist/`
- `npm run check` — run TypeScript checking without emitting output
- `npm test` — run the Vitest suite
- `node scripts/test-code-ui-smoke.mjs` — run the web/code UI smoke harness
- `node scripts/test-coding-assistant.mjs` — run the coding workspace smoke harness

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

Install-like public package-manager actions are also routed through a dedicated managed path. Guardian uses `package_install` to stage the requested top-level package artifacts, review them before execution, resolve the install working directory through the active workspace or configured allowed paths, and surface caution or blocked findings in the unified security workflow instead of treating package installs as ordinary shell commands.

For the full security architecture, threat model, and configuration details, see [SECURITY.md](SECURITY.md).

---

## Getting Started

### Requirements

- **Node.js 20** or newer
- A local, managed-cloud, or frontier **LLM provider** (Ollama, Ollama Cloud, OpenRouter, NVIDIA Cloud, Anthropic, OpenAI, etc.)

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

1. **Open the web UI** and go to the **Configuration Center** (`#/config`, usually `http://localhost:3000`)
2. **Add your LLM provider** — select Ollama for local models, or add an API key for Ollama Cloud, OpenRouter, NVIDIA Cloud, Anthropic, OpenAI, or another supported external provider.
3. **Open Second Brain** at `#/` to confirm the default daily-home surface is live and the assistant is ready for task, note, calendar, and people workflows.
4. **Connect Google Workspace or Microsoft 365 if needed** — use `Cloud > Connections` when you want provider-backed calendar and contacts synced into Second Brain.
5. **Review tool policy** — defaults to `on-request` / `approve_each` for the main assistant, with a read-only shell allowlist. Mutating tools still require approval, and public package-manager installs should go through the managed `package_install` path instead of `shell_safe`.
6. **Enable optional channels** — Telegram bot setup is in `Configuration > Integration System > Telegram Channel`
7. **Set web auth** — web access defaults to bearer-protected mode; configure it in `Configuration > Integration System > Web Authentication` or with CLI `/auth ...`
8. **Open the Coding Workspace if needed** — go to `#/code` for a project-scoped coding workspace with its own session history, trust review, terminals, approvals, and verification surfaces

Most configuration is done through the **web UI** or **CLI commands** (`/config`, `/providers`, `/auth`, `/tools`). Manual `config.yaml` editing is optional and intended for advanced use.

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
- Use the Coding Workspace for repository-scoped work with editor, diffing, approvals, checks, trust review, and session-bound terminals
- Run guarded tools, integrations, search, and automation workflows across the same assistant

**Approvals and safety:** Actions may run automatically, wait for approval, or be denied depending on policy, trust level, and tool risk. For the detailed behavior, see [SECURITY.md](SECURITY.md) and [Tools Control Plane Design](docs/design/TOOLS-CONTROL-PLANE-DESIGN.md).

### Coding Workspace

The web `Code` page is a dedicated repo-scoped workspace backed by server-owned code sessions. It has its own session context, editor, diffing, approvals, checks, trust review, and session-bound terminals.

Implementation detail and current limitations are documented in [docs/design/CODING-WORKSPACE-DESIGN.md](docs/design/CODING-WORKSPACE-DESIGN.md).

### Telegram Setup

1. Open Telegram, search for `@BotFather`, press **Start**, run `/newbot`
2. Follow prompts for bot name and username (must end with `bot`), copy the bot token
3. Add the token in `Configuration > Integration System > Telegram Channel` or through the CLI configuration flow
4. Restrict access with allowed chat IDs
5. Save the channel settings; Telegram changes hot-reload when the token or credential ref and allowlist are valid

### Windows Portable Build (Optional)

For additional native subprocess isolation on Windows:

```powershell
npm run portable:windows     # Portable zip with sandbox helper
npm run installer:windows    # Traditional installer
```

See [INSTALLATION.md](INSTALLATION.md) for the full list of Windows packaging options.

---

## LLM Providers

GuardianAgent supports 12 built-in provider families across local, managed-cloud, and frontier tiers:

| Provider | Type | Notes |
|----------|------|-------|
| **Ollama** | Local | Runs models locally through the native Ollama path |
| **Ollama Cloud** | Managed cloud | Ollama-native remote tier between local and frontier providers |
| **OpenRouter** | Managed cloud | OpenAI-compatible model gateway for many hosted models |
| **NVIDIA Cloud** | Managed cloud | OpenAI-compatible NVIDIA-hosted inference endpoint |
| **Anthropic** | Frontier hosted | Claude models with prompt caching |
| **OpenAI** | Frontier hosted | GPT models |
| **Groq** | Frontier hosted | Fast OpenAI-compatible inference |
| **Mistral AI** | Frontier hosted | Mistral hosted models |
| **DeepSeek** | Frontier hosted | DeepSeek hosted models |
| **Together AI** | Frontier hosted | Open-source model hosting |
| **xAI (Grok)** | Frontier hosted | Grok models |
| **Google Gemini** | Frontier hosted | Gemini models through the OpenAI-compatible endpoint |

### Smart Routing

When both local and external providers are configured, tools automatically route by category:

| Routes to **Local** model | Routes to **External** model |
|---|---|
| Filesystem, Shell, Network, System, Memory | Web, Browser, Workspace, Email, Contacts, Search, Automation |

Single-provider setups work without configuration. Smart routing can be toggled off in Configuration > Tools. Per-tool and per-category overrides are available via the LLM column dropdowns.

Inside the external tier, `Configuration > AI Providers` controls whether Guardian prefers managed-cloud profiles such as Ollama Cloud, OpenRouter, or NVIDIA Cloud, or frontier-hosted profiles. The Model Auto Selection Policy can bind named managed-cloud profiles to general, direct, tool-loop, and coding roles.

**Quality-based fallback:** When the local model produces a degraded response (empty, refusal, or boilerplate), the system automatically retries through the fallback chain.

---

## Configuration

Most users configure GuardianAgent through the **web Configuration Center** (`#/config`) or **CLI commands**. The `config.yaml` file at `~/.guardianagent/config.yaml` is created and updated automatically by those flows.

Three simplified top-level config aliases cover the most common settings:

```yaml
sandbox_mode: workspace-write  # off | workspace-write | strict
approval_policy: on-request    # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox writePaths
  - /home/user/projects
```

The default runtime stays brokered with a `workspace-write` sandbox profile and permissive enforcement. Set `sandbox_mode: strict` when you want risky subprocess-backed tools to fail closed unless a strong sandbox backend is available.

For detailed configuration documentation:
- [Configuration Center Spec](docs/design/CONFIG-CENTER-DESIGN.md)
- [WebUI Design Spec](docs/design/WEBUI-DESIGN.md)

---

## Further Reading

- [SECURITY.md](SECURITY.md) for the security model and trust boundaries
- [WebUI Design](docs/design/WEBUI-DESIGN.md) for page ownership and product-surface design
- [Second Brain As-Built Design](docs/design/SECOND-BRAIN-AS-BUILT.md) for the daily-home experience
- [Performance Management Spec](docs/design/PERFORMANCE-MANAGEMENT-DESIGN.md) for workstation operations
- [Coding Workspace Spec](docs/design/CODING-WORKSPACE-DESIGN.md) for the repo-scoped coding surface
- [Automation Framework Spec](docs/design/AUTOMATION-FRAMEWORK-DESIGN.md) for saved and scheduled automation behavior
- [Configuration Center Spec](docs/design/CONFIG-CENTER-DESIGN.md) for setup, integrations, and policy controls
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
