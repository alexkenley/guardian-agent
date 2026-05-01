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
- **The built-in chat/planner/direct-reasoning loops are isolated from the supervisor** — they run in a brokered worker and reach LLM providers, tools, trace events, and approvals through broker RPC
- **Automation authoring is compiler-mediated** — clear "create a workflow/automation" requests are compiled into native control-plane mutations before the generic planner can drift into script generation
- **Inter-agent delegation is contract-mediated** — orchestration handoffs are validated in runtime code before downstream agents receive filtered context, and core specialist roles narrow known capabilities through runtime-owned contracts instead of prompt-only labels
- **LLM output is NOT trusted** — Models can hallucinate, leak secrets, or be prompt-injected
- **User input is NOT trusted** — External input may contain injection attempts
- **Remote/tool output is NOT trusted by default** — tool results are classified as `trusted`, `low_trust`, or `quarantined` before they re-enter planning, memory, or delegation
- **Durable memory is not equivalent to reviewed truth** — memory entries carry trust, provenance, and quarantine state

For the shipped local defensive overlay on top of the runtime security model, see:

- [Agentic Defensive Security Suite - As-Built Design](docs/design/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md)
- [Contextual Security Uplift Spec](docs/design/CONTEXTUAL-SECURITY-UPLIFT-DESIGN.md)
- [Security Isolation Spec](docs/design/SECURITY-ISOLATION-DESIGN.md)

The as-built spec is the canonical current-state document for the defensive suite. The earlier proposal and implementation-plan material has been moved into implemented/archive documentation.

### Threats Addressed

| Threat / failure mode | Implemented controls | Default posture | Current boundary |
|---|---|---|---|
| Prompt injection in direct user input | `InputSanitizer`, invisible-character stripping, weighted injection scoring, admission before `agent.onMessage()` | Enabled by default | semantic jailbreaks still rely on the runtime/model stack to behave correctly |
| Indirect prompt injection via remote or tool output | `OutputGuardian` trust classification, quarantined reinjection suppression, taint reminders, taint-aware tool gating | Enabled by default | low-trust summaries can still be misleading evidence even when they are no longer active instructions |
| Credential leakage through model output | `GuardedLLMProvider`, recursive secret scanning, redaction/blocking, audit trail | Enabled by default | credentials are still resolved in-process, not through a separate secret broker |
| Secret leakage through inter-agent events | event-payload secret scanning, source validation, audit logging | Enabled by default | events are mediated only on managed framework paths |
| Unauthorized managed file access | `allowedPaths`, denied-path patterns, path normalization, symlink resolution, code-session workspace scoping, session-required web workbench file/diff APIs | Restricted by default | valid web access still allows operations inside the resolved active code-session root |
| Capability escalation by an agent | frozen per-agent capabilities, runtime-owned orchestration role contracts for known capability narrowing, Guardian action checks, no raw `ctx.fs` / `ctx.http` / `ctx.exec` | Enabled by default | supervisor/runtime code is still the trusted computing base |
| Tool-policy widening from chat or remote channels | `update_tool_policy` approval flow plus `assistant.tools.agentPolicyUpdates.*` gates | Disabled by default for paths, commands, domains, and per-tool policy changes | if operators enable these gates, each change still needs explicit approval |
| Shell command injection and shell-expression abuse | tokenizer, shell chain splitting, redirect validation, execution-class checks, direct exec for simple binaries | Restricted by default | descendant executable identity is not fully enforced after the allowed top-level launch |
| Package-manager or remote-launch trampoline abuse on degraded hosts | degraded-backend package-manager block, coding-session launcher bans, explicit allowlist requirements | Disabled by default on degraded backends | once explicitly enabled, package managers can still execute third-party code on the real host |
| Descendant child-process abuse | strict-mode fail-closed on weak hosts, degraded-backend locks on browser/MCP/package-manager/manual-terminal surfaces | Partially reduced by default | Guardian does not yet provide full descendant executable identity enforcement on general hosts |
| SSRF through managed HTTP or browser targets | `SsrfController`, private-IP blocking, cloud-metadata blocking, obfuscated-IP detection, domain allowlists | Enabled by default | raw non-managed processes with network access remain outside SSRF mediation |
| Data exfiltration from degraded sandbox hosts | strict mode, `allowedDomains`, network-off worker, degraded-backend network/browser/MCP defaults | Network and browser-style degraded fallback is disabled by default | permissive degraded hosts still have more host exposure than strong sandbox backends |
| Browser-session abuse | domain allowlists, browser containment, alert-driven containment, degraded-backend browser block | Disabled by default on degraded backends | Guardian does not control the operator's normal browser outside managed browser tools |
| Over-broad third-party MCP servers | MCP startup admission (`startupApproved`), MCP namespacing, Guardian/tool policy checks, conservative third-party risk defaults, risk-floor-only `trustLevel`, call limits, degraded-backend MCP block | Third-party MCP is restricted by default | MCP server code still runs as a local process when operators explicitly trust and enable it |
| Manual PTY abuse in Code | code-session-required terminal creation, session-root cwd resolution, hardened workspace environment, session ownership checks, degraded-backend terminal block | Disabled by default on degraded backends | PTY keystrokes remain an operator-controlled shell surface inside the selected workspace |
| Dangerous non-read-only tool actions | approval workflows, per-tool policies, Guardian Agent inline LLM evaluation, host/gateway containment hooks | `approve_each` by default for the main assistant | if operators switch to looser policy modes, more risk moves to runtime boundaries and approvals |
| Read-only direct reasoning drift | direct reasoning runs inside the brokered worker, exposes only `fs_search`, `fs_read`, and `fs_list`, preserves brokered tool context, and fails closed on budget exhaustion | Enabled for eligible non-local repo-inspection turns | semantic correctness still depends on the model reading and citing the right evidence |
| Memory poisoning / durable backdoors | trust-aware memory, quarantined memory status, provenance, low-trust writes quarantined by default | Enabled by default | reviewed but incorrect content can still be promoted by an operator |
| Broken-tool overspend / runaway retries | per-chain tool budgets, repeated-failure suppression, schedule caps, auto-pause | Enabled by default | expensive but varied failure patterns can still consume approved budget |
| Overlapping scheduled side effects | per-task active-run locks, approval expiry, principal binding, scope hash drift checks | Enabled by default | different schedules can still target overlapping real-world systems if operators configure them that way |
| Script drift during automation creation | native automation compiler, intercepted automation-intent path, script/code-file authoring bans for native Guardian automations | Enabled by default | generic chat outside automation-authoring intent still requires normal tool governance |
| Suspicious repo/workspace content in coding sessions | bounded repo trust review, SaaS anti-pattern checks, native AV enrichment, approval gating for execution/persistence, trust invalidation on drift | Enabled by default | a `trusted` result is not a proof the repo is safe |
| Malicious or hijacked public package installs | managed `package_install` staging path, allowed-path cwd resolution, bounded archive review, native AV enrichment, caution acceptance, unified install alerts | Available through the dedicated tool path | coverage is currently limited to Guardian-managed installs and v1 stages the requested top-level artifacts rather than the full resolved dependency closure |
| Host drift or suspicious local activity | host monitor, unified alerts, containment recommendations, risk-action blocking under critical or stacked alerts | Available but operator-configurable | this is practical host monitoring, not full EDR-grade telemetry |
| Gateway firewall drift | gateway monitor, unified alerts, containment recommendations, risky-network-action blocking | Available but operator-configurable | relies on operator-supplied collectors and normalized gateway state |
| Browser-to-localhost attacks against the web UI | bearer auth, HttpOnly `SameSite=Strict` cookies, CORS validation, privileged tickets, auth-failure rate limiting, SSE auth | Enabled by default | a valid bearer token still grants web access within the authorization model |
| LLM provider failure or degraded model routing | circuit breaker, provider failover, guarded fallback chain | Enabled by default | failover preserves availability, not correctness |

### Default-Safe Posture

The shipped security posture is intentionally restrictive on the paths that widen blast radius:

| Surface | Shipped default | Why it matters |
|---|---|---|
| `assistant.tools.policyMode` | `approve_each` | non-read-only tool actions stop at an approval boundary by default |
| `assistant.tools.agentPolicyUpdates.allowedPaths` | `false` | the assistant cannot widen filesystem scope from chat unless the operator opts in |
| `assistant.tools.agentPolicyUpdates.allowedCommands` | `false` | the assistant cannot widen shell scope from chat unless the operator opts in |
| `assistant.tools.agentPolicyUpdates.allowedDomains` | `false` | the assistant cannot widen outbound host scope from chat unless the operator opts in |
| `assistant.tools.agentPolicyUpdates.toolPolicies` | `false` | the assistant cannot loosen per-tool policy from chat unless the operator opts in |
| `assistant.tools.sandbox.networkAccess` | `false` | sandboxed child processes start network-isolated by default |
| `assistant.tools.sandbox.enforcementMode` | `permissive` | broad host compatibility is preserved, but degraded high-risk surfaces stay shut unless explicitly re-enabled |
| `assistant.tools.sandbox.degradedFallback.allowNetworkTools` | `false` | degraded hosts do not expose network and web-search tooling by default |
| `assistant.tools.sandbox.degradedFallback.allowBrowserTools` | `false` | degraded hosts do not expose browser automation by default |
| `assistant.tools.sandbox.degradedFallback.allowMcpServers` | `false` | degraded hosts do not expose third-party MCP server processes by default |
| `assistant.tools.sandbox.degradedFallback.allowPackageManagers` | `false` | degraded hosts do not allow install-like package-manager commands by default |
| `assistant.tools.sandbox.degradedFallback.allowManualCodeTerminals` | `false` | degraded hosts keep manual code PTYs closed unless the operator opts in |
| `assistant.tools.mcp.servers[].startupApproved` | `false` unless the operator explicitly sets it | third-party MCP commands do not auto-launch from config until they are explicitly trusted |
| `assistant.tools.mcp.servers[].networkAccess` | `false` unless the operator explicitly sets it | third-party MCP subprocesses do not get broad outbound egress by default |
| `assistant.tools.mcp.servers[].inheritEnv` | `false` unless the operator explicitly sets it | third-party MCP subprocesses start from a minimal inherited environment instead of the full parent env |

## Dependency And Packaging Source Of Truth

GuardianAgent now treats its shipped Node dependency contract as a reviewed artifact instead of a floating semver surface.

- The repo-root `package.json` and `package-lock.json` are the authoritative source for shipped GuardianAgent Node dependencies and SDK versions.
- Guardian-owned direct runtime/tooling dependencies and SDKs are pinned to exact reviewed versions in the root manifest instead of floating semver ranges.
- Security remediations for transitive Node dependencies are expressed through exact-version root `overrides`, so the reviewed dependency contract stays explicit.
- The Windows staged app manifests under `build/windows/app/` are generated packaging artifacts copied from the root manifests during packaging; they are not an independent source of truth.
- Windows packaging validates both the root dependency contract and the generated staged manifests before release artifacts are produced.

## Managed Package Install Trust

GuardianAgent includes a host-level package supply-chain control for public package repositories. This capability is separate from coding-workspace repo trust. It reduces the risk of installing hijacked or malicious packages by forcing supported install commands through a managed pre-install review path.

### Scope

- The primary surface is the `package_install` tool
- The package review is separate from workspace trust, but the install working directory must resolve inside the active workspace or configured `allowedPaths`
- Package-manager target flags such as `--prefix`, `--target`, `--user`, or `-g` remain explicit command-level target choices when supported by the managed parser
- The current v1 path supports explicit public-registry installs for `npm`, `pnpm`, `yarn`, `bun`, and `pip install`
- Current coverage applies to Guardian-managed installs only; unmanaged terminal installs are not yet intercepted by the same trust path

### Execution Model

1. Guardian parses the package-manager command and rejects unsupported or ambiguous forms such as command chaining, redirects, direct URLs, VCS specs, local paths, requirements files, and editable installs.
2. Guardian stages the requested top-level package artifacts into a quarantine directory before the real install step runs.
3. The staged archives go through bounded static inspection for install-time lifecycle scripts, Python build hooks, fetch-and-exec patterns, encoded execution chains, native binaries, and transitive-dependency indicators.
4. When native malware scanning is available, Guardian enriches the staged review with Windows Defender or ClamAV results.
5. `blocked` findings stop the install before the package manager executes against the requested target.
6. `caution` findings pause the install and require an explicit operator re-run with `allowCaution`.
7. If the review is `trusted`, or the operator explicitly accepts a `caution` result, Guardian installs from the staged artifacts rather than re-resolving the original package spec directly.

### Current Boundary

- The review is intentionally bounded rather than a full package sandbox
- v1 stages and inspects the requested top-level artifacts, not the complete resolved dependency closure
- A `trusted` result means the current bounded checks did not find deterministic indicators; it is not a proof the package is safe
- `blocked` results are not overridable through `allowCaution`
- On degraded sandbox backends, install-like package-manager commands remain disabled unless the operator explicitly enables degraded package-manager fallback

## Coding Workspace Web Boundary

The web Coding Workspace is a client of backend-owned `CodeSession` records. It does not authorize workspace access from browser-supplied filesystem paths or browser-supplied owner identifiers.

Current boundary:

- Web file and git workbench routes require a `sessionId`; requests without a resolvable backend code session fail closed.
- File read/write/list and git diff paths are resolved through the selected session root and rejected if they escape that root.
- Web code-session routes derive the web owner/channel on the server side and do not trust client-supplied `userId` or `channel` values for session ownership.
- Manual Code terminals require a backend code session; terminal cwd is resolved under that session root.
- Manual Code terminals start with a minimal workspace-scoped environment and filter secret-like environment names instead of inheriting the full Guardian process environment.

### Operator Surfaces

- The web, CLI, and Telegram assistant flows can invoke `package_install` instead of sending install-like commands to `shell_safe`
- Package-install findings are normalized into the unified local security alert model as source `install`
- The Security page can show package-install caution and blocked alerts alongside host, network, gateway, native, and Assistant Security findings
- Package-install findings also contribute to posture-oriented risk summaries, but they are treated as posture evidence rather than direct incident proof on their own

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
│  LAYER 1.5: Execution Isolation Boundary                │
│                                                         │
│  Guardian selects the strongest available boundary that  │
│  matches the workload while keeping approvals, audit,    │
│  memory, policy, and secrets supervisor-owned.           │
│  This layer can use brokered workers, local process      │
│  sandboxes, or stronger virtualized backends. Weak       │
│  hosts still keep degraded high-risk surfaces disabled   │
│  unless the operator explicitly re-enables them.         │
│                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ Brokered     │  │ Process     │  │ Virtualized   │  │
│  │ Worker       │  │ Sandbox     │  │ Backends      │  │
│  │ (no network) │  │ (local OS)  │  │ (local/remote)│  │
│  └──────────────┘  └─────────────┘  └───────────────┘  │
│                                                         │
│  Execution receives a bounded run/session contract.      │
│  Stronger backends add containment; they do not bypass   │
│  the normal approval, policy, audit, or output layers.   │
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
│  LAYER 3: Output Guardian + Trust Classification        │
│                                                         │
│  Scans agent response and tool results after execution, │
│  before delivery or planner reinjection                 │
│                                                         │
│  • 30+ secret patterns (AWS, GCP, Azure, GitHub, etc.)  │
│  • Redact mode: replace secrets with [REDACTED]         │
│  • Block mode: return "[Response blocked]" entirely     │
│  • Event payloads also scanned before inter-agent send  │
│  • Tool results classified as trusted / low_trust /     │
│    quarantined                                           │
│  • Quarantined raw content is suppressed from planner    │
│    reinjection and replaced with constrained summaries   │
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
│  web UI Configuration > Security > Sentinel Audit panel.│
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
- On strong hosts the worker uses the `agent-worker` sandbox profile with full namespace isolation, an ephemeral writable worker workspace, and an explicit read-only bind for the worker runtime bundle it needs to boot
- On degraded hosts the worker uses the `workspace-write` profile with a hardened environment
- Capability tokens remain the worker-side authority boundary; fine-grained per-tool capability narrowing is still future work

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
| `network_access` | HTTP requests to allowed domains and external post deliveries (like channel delivery and forum posting) |
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

Current contextual additions:
- approvals are bound to the requesting principal and role
- quarantined content cannot directly drive non-read-only tools
- tainted-content-driven mutation is approval-gated or denied
- repeated identical failures in one execution chain are blocked before they can overspend further
- non-read-only tools are capped per execution chain to reduce broken-tool runaway spend

Current default operator posture for the main assistant:
- shipped config defaults to `approval_policy: on-request` / `assistant.tools.policyMode: approve_each`
- the default main-assistant shell allowlist is read-oriented: `git status`, `git diff`, `git log`, `ls`, `dir`, `pwd`, `echo`, `cat`, `head`, `tail`, `whoami`, `hostname`, `uname`, `date`
- broad package-manager and interpreter entry points such as bare `node`, `npm`, and `npx` are not in the main default allowlist; Coding Assistant code sessions continue to use their separate repo-scoped command policy
- agent-driven policy expansion (`allowedPaths`, `allowedCommands`, `allowedDomains`, and per-tool policy edits through chat) is disabled by default
- on degraded sandbox backends, network/search tools, browser automation, third-party MCP servers, install-like package manager commands, and manual code terminals all remain disabled until the operator explicitly enables them
- approved workspace-local JS dependency mutations are recorded in `.guardianagent/dependency-awareness.json` and surfaced back into workspace tool context; dependency state is not persisted through the global memory store

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
- **Execution classes**: `shell_safe` blocks interpreter-inline eval, package launchers, and shell-expression launchers even when the base command prefix is allowlisted
- **Structured exec path**: simple direct-binary commands run through structured argv execution when possible; shell fallback is reserved for builtins, chained commands, redirects, and platform wrapper cases
- **Domain whitelist**: Network requests limited to configured domains
- **Provider host checks**: `web_search` verifies required provider hosts are allowlisted before making requests
- **Dry-run mode**: Preview mutating operations without execution

### Coding Assistant Workspace Scoping

The web `#/code` workspace adds a request-scoped sandbox layer for assistant-driven coding actions.

When a Code session sends a chat/tool request with `codeContext`:

- file and coding tools are pinned to that session `workspaceRoot`, even though the global tool policy remains unchanged
- `shell_safe` uses a Code-specific repo-work allowlist instead of the global `allowedCommands` list
- `shell_safe` classifies commands by execution type and prefers structured direct exec for simple binaries instead of always routing through shell parsing
- shell validation blocks repo-escape flags and global-install patterns such as `git -C`, `--git-dir`, `--work-tree`, `--prefix`, `--cwd`, `--cache*`, `--userconfig`, `--globalconfig`, `-g`, `--global`, `global`, and `--user`
- shell validation also blocks interpreter-inline and launcher trampoline forms such as `python -c`, `node --eval`, `bash -c`, `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, and `uv run`
- path-like shell args and redirect targets that resolve outside the active workspace root are denied before execution
- common package/build caches are redirected under `<workspaceRoot>/.guardianagent/cache` to reduce spillover into the user profile

This lets the Coding Assistant run repo-local `git` / build / test flows without globally broadening the shell policy for the rest of the assistant.

Important boundary:

- Code chat history is separate from the main web chat for UX/session isolation
- repo-scoped enforcement applies to assistant-driven tool calls, not to the manual PTY terminal surface
- on degraded sandbox backends, web PTY code terminals now stay blocked unless the operator explicitly enables `assistant.tools.sandbox.degradedFallback.allowManualCodeTerminals`
- PTY terminals still launch as user-operated shells in the chosen cwd and currently rely on the normal OS/process sandbox plus session ownership checks, not the assistant’s repo-bound command validator
- Guardian currently validates the requested top-level command and execution class. It does not yet provide descendant executable identity enforcement for arbitrary child processes launched beneath an allowed parent.

### Contextual Policy Enforcement

GuardianAgent now ships contextual enforcement directly in the runtime decision path.

Current enforced inputs include:
- `principalId`
- `principalRole`
- `contentTrustLevel`
- `taintReasons`
- `derivedFromTaintedContent`
- `scheduleId`
- schedule approval/budget state

Current enforced behaviors include:
- deny non-read-only actions from quarantined context
- require approval for tainted-content-driven mutation
- inject a tainted-content reminder before additional planning turns so remote/tool text is treated as evidence, not instructions
- quarantine low-trust memory writes by default
- bind approvals to the requesting principal/role
- enforce bounded schedule authority via approval expiry, scope hash drift, and token/run budgets

The longer-term declarative rule-engine work remains documented in [`docs/design/POLICY-AS-CODE-DESIGN.md`](docs/design/POLICY-AS-CODE-DESIGN.md). That spec is now about consolidating these shipped contextual controls into a shared declarative engine, not about introducing contextual security for the first time.

---

## Execution Isolation (Layer 1.5)

Managed child processes spawned by tool execution are wrapped in OS-level isolation using [bubblewrap (bwrap)](https://github.com/containers/bubblewrap) on Linux, an optional native helper on Windows, and graceful fallback to `ulimit` + environment hardening when stronger backends are unavailable.

The brokered chat worker is also launched through the managed sandbox layer with `networkAccess: false`. LLM API calls are proxied through the broker RPC (`llm.chat`), so the worker process never makes outbound network connections.

### Unified Isolation Model

Guardian treats Layer 1.5 as a capability-driven execution boundary, not as a single sandbox implementation.

- **Intelligent Routing Heuristics:** Guardian analyzes your project (e.g., detecting `Makefile`, `go.mod`, `node-pty`) to automatically select the most compatible backend. It prioritize **Daytona** for complex builds requiring a full OS environment and **Vercel** for fast, stateless burst tasks.
- **Language-Agnostic Fingerprinting:** The system works out behavioral equivalence for Python, Go, Rust, and C/C++ projects by scanning for build manifests and native dependencies, ensuring the "Build Essential" tier is used where appropriate.
- **Manual Lifecycle Control & Visibility:** Persistent sandboxes can be manually **Stopped** or **Started** from the web UI to optimize cloud resource usage. Real-time status badges (**RUNNING**, **STOPPED**, **UNREACHABLE**) provide visibility into the active state of remote environments.
- **Brokered worker isolation** for the built-in chat/planner loop.
- local process sandboxing for managed child processes
- stronger local virtualized execution for hostile or semi-trusted jobs when available
- remote virtualized execution for bounded jobs when an operator has configured a trusted provider-backed sandbox
- built-in control-plane allowances for the shipped remote sandbox endpoints (`api.vercel.com` and `app.daytona.io`) so sandbox routing does not depend on chat-driven `allowedDomains` widening; custom endpoints remain policy-gated

Regardless of backend, Guardian keeps ownership of:

- intent routing
- approvals and pending actions
- audit logging
- memory and tool policy
- secret resolution and provider connectivity
- output scanning and trust classification

The execution backend receives only a bounded run contract and returns status, logs, and artifacts. Stronger backends add containment; they do not create a second authority plane.

### Isolation Tier Selection

Guardian should prefer the least-complex boundary that safely satisfies the workload and fail closed when a stronger boundary is required but unavailable.

| Workload class | Preferred isolation posture | Notes |
|---|---|---|
| Built-in chat/planner loop | Brokered worker, `networkAccess: false` | Implemented today; the worker never makes direct LLM network calls |
| Read-only or low-risk subprocess work | Local process sandbox | Current default for managed child processes |
| Hostile or semi-trusted command execution | Strong local isolation when available | In `strict` mode, risky subprocess-backed tools stay blocked unless the host can provide a strong tier |
| Remote bounded job execution | Remote virtualized backend | Intended for job-style execution, not for replacing Guardian's routing, memory, or approval layers |
| Second Brain, memory, contacts, notes, provider mutations | Supervisor-owned runtime path by default | These are data-plane and control-plane operations, not phase-1 remote-sandbox targets |

### Sandbox Profiles

| Profile | Filesystem | Network | Use Case |
|---------|-----------|---------|----------|
| `read-only` | Root bind (read-only), `/tmp` writable | Isolated by default | System info, document search, network probes |
| `workspace-write` | Workspace writable, `.git`/`.env*` forced read-only | Isolated by default | `execute_command`, MCP servers, browser |
| `agent-worker` | Dedicated worker workspace, read-only runtime bundle bind, remapped `HOME`/`TMPDIR` | Network-disabled (LLM proxied via broker) | Brokered chat/planner worker (strong hosts) |
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

In `strict` mode, risky subprocess-backed tools are disabled unless sandbox availability is `strong`.

In `permissive` mode:

- broad host compatibility is preserved
- but degraded or unavailable backends do **not** automatically reopen every risky surface
- the following degraded-fallback allowances are explicit operator opt-ins and are **disabled by default**:

| Degraded-backend allowance | Default | Effect when enabled |
|---|---|---|
| `allowNetworkTools` | off | re-enables network tools and `web_search` on degraded hosts |
| `allowBrowserTools` | off | re-enables browser automation and browser-like job tooling on degraded hosts |
| `allowMcpServers` | off | re-enables third-party MCP server processes on degraded hosts |
| `allowPackageManagers` | off | re-enables install-like package-manager commands on degraded hosts |
| `allowManualCodeTerminals` | off | re-enables manual web PTY code terminals on degraded hosts |

Important boundary:

- current execution-identity enforcement is app-layer and top-level only
- Guardian can classify and constrain the requested command, and it can run simple binaries without shell parsing
- Guardian does not yet enforce descendant executable identity for arbitrary child processes on general hosts

**Risky tool classes blocked in `strict` mode:** shell execution, browser automation, MCP server processes, subprocess-backed search/indexing, and broad host-access categories (`network`, `system`).

Install bwrap on Debian/Ubuntu: `sudo apt install bubblewrap`

### Windows Local Isolation Tiers

- Current shipped Windows local isolation is the process-sandbox/helper tier:
  - AppContainer-backed process launch for sandboxed profiles (`read-only`, `workspace-write`)
  - Job Object `KILL_ON_JOB_CLOSE` enforcement for child process trees
  - strict-mode fail-closed behavior when the helper is missing or unhealthy
  - optional portable zip bundle ships the sandbox helper alongside the runtime
- A Hyper-V-backed strong-isolation tier should be modeled as a distinct backend, not as a rename of the helper/AppContainer tier
- Diagnostics, setup, policy, and UI copy should report the actual backend that ran rather than treating every Windows path as equivalent strength

See `docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md` for packaging details.

### Virtualized Isolation Backends

The same Layer 1.5 contract can host stronger virtualization-backed execution backends for bounded jobs.

- Local examples include Windows Hyper-V and future Linux VM-backed execution
- Remote examples include provider-attached sandbox or workspace-VM backends
- These backends should expose honest backend identity, availability, and supported network modes rather than collapsing everything into one generic `strong` label
- Provider choice is an adapter concern below this contract; Guardian should keep one shared routing, approval, audit, and memory model above it

The canonical cross-backend contract is documented in [docs/design/SECURITY-ISOLATION-DESIGN.md](docs/design/SECURITY-ISOLATION-DESIGN.md).

### Configuration

```yaml
assistant:
  tools:
    agentPolicyUpdates:
      allowedPaths: false           # Disabled by default
      allowedCommands: false        # Disabled by default
      allowedDomains: false         # Disabled by default
      toolPolicies: false           # Disabled by default
    sandbox:
      enabled: true
      enforcementMode: permissive      # strict | permissive
      mode: workspace-write            # Default profile
      networkAccess: false             # Default: isolate network
      additionalWritePaths: []         # Extra writable paths
      additionalReadPaths: []          # Extra read-only paths
      degradedFallback:
        allowNetworkTools: false       # Disabled by default
        allowBrowserTools: false       # Disabled by default
        allowMcpServers: false         # Disabled by default
        allowPackageManagers: false    # Disabled by default
        allowManualCodeTerminals: false # Disabled by default
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
approval_policy: on-request    # on-request | auto-approve | autonomous
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
- Tool results are classified into `trusted`, `low_trust`, or `quarantined`
- Tool results are wrapped as structured `<tool_result ...>` envelopes before they return to the model
- Tool-result strings are stripped of invisible Unicode, checked for prompt-injection signals, and PII-redacted before reinjection
- `web_fetch` normalizes HTML before scanning by skipping obvious hidden DOM (`hidden`, `aria-hidden`, inline hidden styles) and preserving inline text continuity so tag-fragmented phrases are harder to hide from the scanner
- Quarantined tool output does not re-enter the planner as raw text; the runtime injects a constrained summary instead
- When planning continues from tainted remote content, the planner receives an extra system reminder to treat tool output as data only and to ignore approval-like or role-changing text embedded in fetched content
- Low-trust or quarantined content cannot become active memory by default
- All detections logged to the audit trail

### Trust-Aware Memory

- Per-agent memory now uses readable markdown plus a structured sidecar index
- Each entry stores source, trust, status, principal, and provenance metadata
- Status values: `active`, `quarantined`, `expired`, `rejected`
- Quarantined memory is excluded from normal planner context
- Remote-derived or tainted memory writes default to quarantine instead of silently becoming active context

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

**Operator surfaces:** audit events (`host_alert`), configurable notification fanout, Security page (`Overview`, `Alerts`, `Agentic Security Log`), manual checks, acknowledgement/resolve/suppress controls, built-in automation starters.

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

### Native Host Protection Integration

GuardianAgent now integrates with Microsoft Defender as a native host-security provider on Windows.

Current behavior:

- Defender status, signatures, scan ages, firewall state, and Controlled Folder Access state are queryable from tools and the Security page
- Defender detections are normalized into the unified local security alert model
- approved quick/full/custom scans and signature refreshes can be requested through GuardianAgent
- third-party antivirus coexistence is handled explicitly so Defender can be marked inactive/passive rather than always treated as a hard failure

GuardianAgent is the policy, correlation, and response layer above native host protection. It is not currently a replacement antivirus engine.

### Unified Local Alerting, Posture, and Containment

Local defensive signals are normalized across:

- host monitoring
- network monitoring
- gateway monitoring
- native Windows Defender integration

Current operator surfaces include:

- unified local alert queue
- advisory posture recommendations across `monitor`, `guarded`, `lockdown`, and `ir_assist`
- bounded containment decisions that can restrict risky browser mutation, scheduled mutation, network egress, and command execution depending on effective mode

The memory boundary is explicit:

- raw security alerts stay in security-specific state
- reviewed summaries may be promoted to memory separately
- security monitoring API responses, audit/routing trace/run timeline web API responses, structured error logs, and raw Security page detail panes redact credential-like values before operator delivery or persistence in process logs

### Agentic Security Triage And Activity Logging

GuardianAgent now includes a dedicated LLM-backed security triage loop on top of the deterministic alerting stack.

Current behavior:

- a dedicated `security-triage` agent investigates selected security events with read-first tooling
- a `security-triage-dispatcher` wakes the triage agent only for higher-value events
- low-confidence noise families are skipped
- repeated events are deduped by cooldown
- completed triage is written to audit as `automation_finding`
- the Security page now includes a persisted live activity tab labeled `Agentic Security Log`

This makes the defensive stack partly agentic without handing full autonomous remediation to the model layer.

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
  - current ticket-gated web mutations include `/api/tools/policy`, `/api/guardian-agent/config`, `/api/policy/config`, `/api/policy/reload`, security-sensitive `/api/config` changes, memory-sensitive `/api/config` changes, and `/api/killswitch`
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

Integration with Gmail, Calendar, Drive, Docs, and Sheets. Two backends:

**Native mode (default):** Uses `googleapis` SDK directly — no external CLI dependency.

- OAuth 2.0 PKCE with localhost callback, handled entirely within GuardianAgent
- Tokens encrypted at rest in `~/.guardianagent/secrets.enc.json` (AES-256-GCM, machine-specific key)
- Callback server binds `127.0.0.1` only and closes immediately after receiving the authorization code
- Each service maps to the narrowest OAuth scope (e.g. `gmail.modify` not `gmail.full`)
- Token refresh is transparent; refresh tokens never logged

**CLI mode (legacy):** Uses external `@googleworkspace/cli` via subprocess.

- The GWS CLI is **not bundled** — installed separately by the user
- OAuth 2.0 requires an interactive browser flow (`gws auth login`) — cannot be initiated headlessly
- Credentials stored in the OS keyring by `gws`, not by GuardianAgent

**Shared security properties (both modes):**

- Only configured Google services are exposed (opt-in via `services` array)
- External send/post actions (e.g. `gmail_send`) remain approval-gated
- All Google API calls logged to audit trail with service/method/resource
- Email addresses exempted only in addressing fields for email/calendar tools (see PII Exemptions above)
- Access token and refresh token patterns covered by SecretScanController

### MCP Tool Servers

- Tool names namespaced (`mcp-<serverId>-<toolName>`) to prevent collisions
- All MCP tool calls pass through Guardian admission
- Third-party MCP servers require explicit `startupApproved: true` before Guardian launches the configured command
- Third-party MCP subprocesses default to `networkAccess: false` and `inheritEnv: false`; operators must opt in to broader egress or parent-env inheritance
- Third-party MCP tool metadata is treated as untrusted input; descriptions/schemas are sanitized before registration and risk defaults conservatively to approval-gated behavior
- Managed browser MCP stays on a bounded fast path, but Playwright startup is pinned to the installed package path rather than `@latest`
- `trustLevel` is a stricter risk floor, not a downgrade override
- Optional per-server `maxCallsPerMinute` limits still apply

### Orchestration Security

Multi-agent orchestration (Sequential, Parallel, Loop, Conditional agents) maintains security invariants:

- All sub-agent invocations go through `Runtime.dispatchMessage()`
- Each sub-agent call passes through the full Guardian admission pipeline
- Shared state between agents is scoped and cleaned between runs
- Orchestration agents receive `ctx.dispatch()` — a guarded wrapper, not raw runtime access
- Scheduled orchestration is bounded by approval expiry, scope drift checks, and runaway budgets rather than indefinite saved approval
- Scheduled or chained broken-tool retries are capped to reduce overspend amplification

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
- Contextual security: trust classification, quarantined reinjection suppression, principal-bound approvals, and trust-aware memory
- Immutable security baseline: Guardian, Guardian Agent, fail-closed action evaluation, the approval floor, and the policy-engine floor cannot be weakened through normal config/API changes
- Control-plane integrity: HMAC-tracked config, scheduled-task state, policy files, and memory index files are verified against a signed manifest under `~/.guardianagent/`
- Memory freeze control: `assistant.memory.knowledgeBase.readOnly` blocks normal durable memory writes, including `memory_save` and automatic flush
- Guardian data-directory permission hardening: files under `~/.guardianagent` are created/tightened toward `0600` and directories toward `0700` on normal managed write paths and startup
- Connector + playbook guardrails: host/path/command/capability allowlists, bounded step execution, signed/dry-run controls
- Automation authority bounds: approval expiry, scope hashes, run/token caps, and auto-pause on repeated failures/denials
- Secret exfiltration controls: multi-pattern scanning, response redaction/blocking, inter-agent payload blocking
- Intent hardening via SOUL profile: configurable injection with primary/delegated modes
- Cryptographic correlation: deterministic SHA-256 hashes of redacted tool args for traceability
- Web auth hardening: constant-time bearer comparison plus short-lived signed privileged tickets
- Tamper-evident policy-change trail: SHA-256 config snapshots recorded as `policy_changed` audit events
- SQLite integrity hardening: periodic `PRAGMA quick_check`, secure permissions, and hashed integrity checkpoints
- Memory hardening: prompt/context loads now trust the signed `*.index.json` state, not the markdown cache, and suspicious memory entries are suppressed before reinjection

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
- `scripts/test-contextual-security-uplifts.mjs`
- `scripts/test-web-approvals.mjs`
- `scripts/test-cli-approvals.mjs`

---

## External Coding Backend Boundary Note

Optional external coding backends such as Claude Code, Codex CLI, Gemini CLI, or Aider are a separate delegated trust surface.

- Guardian governs launch approval, workspace/session binding, orchestration, audit, and post-run verification expectations for these delegated runs.
- Guardian does **not** replace the backend CLI's own internal parser, permission, or sandbox model after launch.
- As a result, upstream security flaws in an enabled delegated coding backend can still affect delegated runs even when Guardian's native managed shell validation remains fail-closed.
- Keep external coding backends disabled by default unless there is a clear operator need, and prefer running them with stronger host sandboxing, reduced credentials, and constrained network access.
