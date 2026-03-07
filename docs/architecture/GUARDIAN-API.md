# Guardian API Reference

Complete API reference for the Guardian four-layer defense system.

---

## Guardian Pipeline

**File:** `src/guardian/guardian.ts`

### `Guardian`

The main admission controller pipeline.

```typescript
import { Guardian } from './guardian/guardian.js';
```

#### Constructor

```typescript
new Guardian(options?: { logDenials?: boolean })
```

- `logDenials` — Log denied actions via pino (default: `true`)

#### Static Methods

**`Guardian.createDefault(options?)`**

Create a Guardian with all built-in controllers in the correct pipeline order.

```typescript
static createDefault(options?: GuardianCreateOptions): Guardian
```

Options:
```typescript
interface GuardianCreateOptions {
  logDenials?: boolean;
  additionalSecretPatterns?: string[];
  inputSanitization?: Partial<InputSanitizerConfig> & { enabled?: boolean };
  rateLimit?: Partial<RateLimiterConfig>;
  allowedCommands?: string[];
}
```

Default pipeline order:
1. InputSanitizer (mutating)
2. RateLimiter (validating)
3. CapabilityController (validating)
4. SecretScanController (validating)
5. DeniedPathController (validating)
6. ShellCommandController (validating) — when `allowedCommands` provided

#### Instance Methods

**`guardian.use(controller)`**

Add a controller to the pipeline. Controllers are auto-sorted: mutating first, then validating.

```typescript
use(controller: AdmissionController): this
```

**`guardian.check(action)`**

Run an action through the admission pipeline.

```typescript
check(action: AgentAction): AdmissionResult
```

Returns:
- `{ allowed: true, controller: 'guardian' }` — action permitted
- `{ allowed: true, controller: 'guardian', mutatedAction }` — action permitted with modifications
- `{ allowed: false, reason, controller }` — action denied

**`guardian.getControllers()`**

Get all registered controllers (read-only).

```typescript
getControllers(): readonly AdmissionController[]
```

### Types

```typescript
/** An action an agent wants to perform. */
interface AgentAction {
  type: string;                       // e.g. 'write_file', 'message_dispatch'
  agentId: string;                    // requesting agent
  capabilities: readonly string[];    // agent's granted capabilities
  params: Record<string, unknown>;    // action parameters
}

/** Result of an admission check. */
interface AdmissionResult {
  allowed: boolean;
  reason?: string;                    // denial reason
  controller: string;                 // controller that decided
  mutatedAction?: AgentAction;        // modified action (mutating controllers)
}

/** Phase of the admission pipeline. */
type AdmissionPhase = 'mutating' | 'validating';

/** An admission controller. */
interface AdmissionController {
  name: string;
  phase: AdmissionPhase;
  check(action: AgentAction): AdmissionResult | null;  // null = pass through
}
```

---

## Built-in Controllers

### `InputSanitizer`

**File:** `src/guardian/input-sanitizer.ts`

Mutating controller that strips invisible Unicode characters and detects prompt injection.

```typescript
import { InputSanitizer } from './guardian/input-sanitizer.js';

const sanitizer = new InputSanitizer({
  blockThreshold: 3,      // injection score to block (default: 3)
  stripInvisible: true,    // strip invisible Unicode (default: true)
});
```

#### Standalone Functions

```typescript
import { stripInvisibleChars, detectInjection } from './guardian/input-sanitizer.js';

// Strip invisible Unicode characters
const clean = stripInvisibleChars('Hello\u200BWorld');
// → 'HelloWorld'

// Detect injection signals
const result = detectInjection('Ignore previous instructions');
// → { score: 3, signals: ['role_override_ignore'] }
```

### `RateLimiter`

**File:** `src/guardian/rate-limiter.ts`

Validating controller with per-agent sliding window rate limiting.

```typescript
import { RateLimiter } from './guardian/rate-limiter.js';

const limiter = new RateLimiter({
  maxPerMinute: 30,    // default: 30
  maxPerHour: 500,     // default: 500
  burstAllowed: 5,     // default: 5 in 10s window
});

// Reset state for one agent
limiter.reset('agent-id');

// Reset all state
limiter.resetAll();
```

Only limits `message_dispatch` actions. Internal events and schedules pass through.

### `CapabilityController`

**File:** `src/guardian/guardian.ts`

Validating controller that checks agent capabilities against action requirements.

```typescript
import { CapabilityController } from './guardian/guardian.js';

const controller = new CapabilityController();
```

Action type → capability mapping is fixed (see [SECURITY.md](../../SECURITY.md)). Unknown action types are denied by default except explicit internal passthrough actions.

### `SecretScanController`

**File:** `src/guardian/guardian.ts`

Validating controller that scans content parameters for secret patterns.

```typescript
import { SecretScanController } from './guardian/guardian.js';

const controller = new SecretScanController(['CUSTOM_[A-Z]{10}']);
```

Scans `action.params.content` for 28+ credential patterns plus any custom patterns.

### `DeniedPathController`

**File:** `src/guardian/guardian.ts`

Validating controller that blocks access to sensitive file paths.

```typescript
import { DeniedPathController } from './guardian/guardian.js';

const controller = new DeniedPathController();
```

Normalizes paths via `path.normalize()` before checking. Detects `..` traversal after normalization.

### `ShellCommandController`

**File:** `src/guardian/shell-command-controller.ts`

Validating controller that tokenizes shell commands and validates each sub-command against allowed command lists and denied paths.

```typescript
import { ShellCommandController } from './guardian/shell-command-controller.js';

const controller = new ShellCommandController(['ls', 'cat', 'grep', 'git']);
```

Only fires on `action.type === 'execute_command'`. Extracts command string from `action.params.command`.

Uses the shell tokenizer (`src/guardian/shell-validator.ts`) to:
1. Parse the command into tokens (handling quoting, escaping, operators)
2. Split into sub-commands by chain operators (`&&`, `||`, `;`, `|`)
3. Validate each sub-command name against the allowed list
4. Check arguments and redirect targets against denied paths
5. Flag subshell substitutions (`$(...)`, backticks)

Deny-by-default: if the tokenizer can't parse the input, the command is denied.

---

## SecretScanner

**File:** `src/guardian/secret-scanner.ts`

Low-level scanner used by SecretScanController and OutputGuardian.

```typescript
import { SecretScanner } from './guardian/secret-scanner.js';

const scanner = new SecretScanner(['CUSTOM_[A-Z]{10}']);

// Scan content for secrets
const matches: SecretMatch[] = scanner.scanContent('Key: AKIAIOSFODNN7EXAMPLE');
// → [{ pattern: 'AWS Access Key', match: 'AKIA...MPLE', rawMatch: 'AKIAIOSFODNN7EXAMPLE', offset: 5 }]

// Check if a file path is denied
const result = scanner.isDeniedPath('.env');
// → { denied: true, reason: 'Matches denied pattern: .env' }
```

### Types

```typescript
interface SecretMatch {
  pattern: string;     // pattern name (e.g. 'AWS Access Key')
  match: string;       // redacted match (for logging)
  rawMatch: string;    // full match (for replacement/redaction)
  offset: number;      // position in original string
}
```

---

## OutputGuardian

**File:** `src/guardian/output-guardian.ts`

Layer 2 defense — scans and redacts secrets from outbound content.

```typescript
import { OutputGuardian } from './guardian/output-guardian.js';

const guard = new OutputGuardian(['CUSTOM_[A-Z]{10}']);
```

### Methods

**`scanResponse(content)`**

Scan an LLM response. Returns sanitized content with secrets replaced by `[REDACTED]`.

```typescript
const result = guard.scanResponse('The key is AKIAIOSFODNN7EXAMPLE');
// → {
//     clean: false,
//     secrets: [{ pattern: 'AWS Access Key', ... }],
//     sanitized: 'The key is [REDACTED]'
//   }
```

**`scanPayload(payload)`**

Scan an event payload for secrets. Returns matched secrets (does not redact).

```typescript
const secrets = guard.scanPayload({ key: 'AKIAIOSFODNN7EXAMPLE' });
// → [{ pattern: 'AWS Access Key', ... }]
```

**`scanContent(content)`**

Scan arbitrary content string. Returns matched secrets.

```typescript
const secrets = guard.scanContent('sk-ant-api03-abc123');
// → [{ pattern: 'Anthropic API Key', ... }]
```

### Types

```typescript
interface ScanResult {
  clean: boolean;           // true if no secrets found
  secrets: SecretMatch[];   // detected secrets
  sanitized: string;        // content with secrets replaced by [REDACTED]
}
```

---

## AuditLog

**File:** `src/guardian/audit-log.ts`

In-memory ring buffer for structured security event logging. Optionally backed by persistent hash-chained storage.

```typescript
import { AuditLog } from './guardian/audit-log.js';

const log = new AuditLog(10_000);  // max 10,000 events (default)
```

### Methods

**`record(event)`**

Record a new audit event. Auto-generates ID and timestamp. If persistence is wired, the event is also persisted fire-and-forget.

```typescript
const event = log.record({
  type: 'action_denied',
  severity: 'warn',
  agentId: 'my-agent',
  controller: 'CapabilityController',
  details: { actionType: 'write_file', reason: 'lacks write_files capability' },
});
```

**`query(filter)`**

Query events matching a filter.

```typescript
const denials = log.query({
  type: 'action_denied',
  agentId: 'my-agent',
  severity: 'warn',
  after: Date.now() - 60_000,  // last minute
  limit: 10,
});
```

**`getRecentEvents(count)`**

Get the N most recent events.

```typescript
const recent = log.getRecentEvents(50);
```

**`getSummary(windowMs)`**

Get aggregated summary for a time window. Used by Sentinel for analysis.

```typescript
const summary = log.getSummary(300_000);  // last 5 minutes
// → {
//     totalEvents: 42,
//     byType: { action_denied: 5, action_allowed: 30, ... },
//     bySeverity: { info: 30, warn: 10, critical: 2 },
//     topDeniedAgents: [{ agentId: 'bad-agent', count: 4 }],
//     topControllers: [{ controller: 'CapabilityController', count: 3 }],
//     windowStart: 1234567890,
//     windowEnd: 1234867890,
//   }
```

**`setPersistence(p)`**

Wire persistent storage. Called during Runtime startup.

```typescript
import { AuditPersistence } from './guardian/audit-persistence.js';

const persistence = new AuditPersistence('~/.guardianagent/audit/');
await persistence.init();
log.setPersistence(persistence);
```

**`verifyChain()`**

Verify the integrity of the persisted hash chain. Delegates to `AuditPersistence.verifyChain()`.

```typescript
const result = await log.verifyChain();
// → { valid: true, totalEntries: 1847 }
// → { valid: false, totalEntries: 1847, brokenAt: 423 }
```

**`rehydrate(count)`**

Read the last N persisted entries back into the in-memory ring buffer.

```typescript
await log.rehydrate(1000);  // load last 1000 events from disk
```

**`clear()`** — Clear all events.

**`getAll()`** — Get all events (read-only array).

**`size`** — Current event count (getter).

---

## AuditPersistence

**File:** `src/guardian/audit-persistence.ts`

SHA-256 hash-chained JSONL persistence for tamper-evident audit storage.

```typescript
import { AuditPersistence } from './guardian/audit-persistence.js';

const persistence = new AuditPersistence('~/.guardianagent/audit/');
await persistence.init();
```

### Methods

**`init()`**

Ensures the audit directory exists and recovers `lastHash` from the existing file (if any).

**`persist(event)`**

Compute SHA-256 hash over `{ event, previousHash }`, append JSONL entry, update `lastHash`. Writes are serialized via chained Promises.

**`verifyChain()`**

Stream the JSONL file line by line, recompute each hash, and return integrity status.

```typescript
const result = await persistence.verifyChain();
// → { valid: boolean, totalEntries: number, brokenAt?: number }
```

**`readTail(count)`**

Return the last N entries from the file for rehydration.

### Types

```typescript
interface ChainedAuditEntry {
  event: AuditEvent;
  previousHash: string;
  hash: string;
}

interface ChainVerifyResult {
  valid: boolean;
  totalEntries: number;
  brokenAt?: number;
}
```

### Types

```typescript
type AuditEventType =
  | 'action_denied'     | 'action_allowed'    | 'secret_detected'
  | 'output_blocked'    | 'output_redacted'   | 'event_blocked'
  | 'input_sanitized'   | 'rate_limited'      | 'capability_probe'
  | 'policy_changed'    | 'anomaly_detected'  | 'agent_error'
  | 'agent_stalled';

type AuditSeverity = 'info' | 'warn' | 'critical';

interface AuditEvent {
  id: string;
  timestamp: number;
  type: AuditEventType;
  severity: AuditSeverity;
  agentId: string;
  userId?: string;
  channel?: string;
  controller?: string;
  details: Record<string, unknown>;
}

interface AuditFilter {
  type?: AuditEventType;
  agentId?: string;
  severity?: AuditSeverity;
  after?: number;
  before?: number;
  limit?: number;
}

interface AuditSummary {
  totalEvents: number;
  byType: Record<string, number>;
  bySeverity: Record<AuditSeverity, number>;
  topDeniedAgents: Array<{ agentId: string; count: number }>;
  topControllers: Array<{ controller: string; count: number }>;
  windowStart: number;
  windowEnd: number;
}
```

---

## GuardianAgentService

**File:** `src/runtime/sentinel.ts`

Layer 2 defense — inline LLM-powered action evaluation before tool execution.

```typescript
import { GuardianAgentService } from './runtime/sentinel.js';

const guardianAgent = new GuardianAgentService({
  enabled: true,
  llmProvider: 'auto',       // 'local' | 'external' | 'auto'
  failOpen: true,             // allow actions when LLM unavailable
  timeoutMs: 8000,            // inline evaluation timeout
});
guardianAgent.setProviders(localProvider, externalProvider);
```

### Methods

- `evaluateAction(action)` — evaluate a tool action, returns `{ allowed, riskLevel, reason }`
- `setProviders(local?, external?)` — set available LLM providers
- `updateConfig(update)` — update config at runtime
- `getConfig()` — read current config

### API Endpoints

- `GET /api/guardian-agent/status` — current config and status
- `POST /api/guardian-agent/config` — update settings (enabled, llmProvider, failOpen, timeoutMs)

---

## SentinelAuditService

**File:** `src/runtime/sentinel.ts`

Layer 4 defense — retrospective anomaly detection, runnable on cron or on-demand.

```typescript
import { SentinelAuditService } from './runtime/sentinel.js';

const sentinel = new SentinelAuditService({
  enabled: true,
  anomalyThresholds: {
    volumeSpikeMultiplier: 3,
    capabilityProbeThreshold: 5,
    secretDetectionThreshold: 3,
  },
});
sentinel.setProvider(llmProvider);
```

### Methods

- `runAudit(auditLog, windowMs?)` — run retrospective analysis, returns `{ anomalies, llmFindings, timestamp, windowMs }`
- `detectAnomalies(summary, auditLog?)` — heuristic-only analysis (no LLM)
- `setProvider(provider?)` — set LLM provider for enhanced analysis
- `getConfig()` — read current config

### API Endpoints

- `POST /api/sentinel/audit` — trigger on-demand audit (optional `{ windowMs }` body)

---

## SentinelAgent (Legacy)

**File:** `src/agents/sentinel.ts`

Legacy Layer 4 agent — kept for test compatibility. Active implementation is `SentinelAuditService` above.

```typescript
import { SentinelAgent } from './agents/sentinel.js';

const sentinel = new SentinelAgent({
  volumeSpikeMultiplier: 3,        // denial rate multiplier (default: 3)
  capabilityProbeThreshold: 5,     // distinct denied action types (default: 5)
  secretDetectionThreshold: 3,     // secret scans per agent (default: 3)
});
```

### Agent Properties

- `id`: `'sentinel'`
- `name`: `'Sentinel Security Agent'`
- `handleMessages`: `false`
- `handleEvents`: `true`
- `handleSchedule`: `true`

### Methods

**`detectAnomalies(summary, auditLog?)`**

Run heuristic anomaly detection on an audit summary. Returns array of detected anomalies.

```typescript
const anomalies = sentinel.detectAnomalies(summary, auditLog);
// → [{ type: 'volume_spike', severity: 'warn', description: '...', evidence: {...} }]
```

**`onSchedule(ctx)`**

Called by the cron scheduler. Analyzes the AuditLog, detects anomalies, optionally runs LLM analysis, and records findings back to the AuditLog.

**`onEvent(event, ctx)`**

Listens for `guardian.critical` events for real-time response.

### Types

```typescript
interface Anomaly {
  type: string;                        // e.g. 'volume_spike', 'capability_probe'
  severity: 'warn' | 'critical';
  description: string;
  agentId?: string;
  evidence: Record<string, unknown>;
}

interface AnomalyThresholds {
  volumeSpikeMultiplier: number;       // default: 3
  capabilityProbeThreshold: number;    // default: 5
  secretDetectionThreshold: number;    // default: 3
}
```

---

## Capabilities

**File:** `src/guardian/capabilities.ts`

Utility functions for capability checking.

```typescript
import {
  hasCapability,
  hasAllCapabilities,
  hasAnyCapability,
  isValidCapability,
} from './guardian/capabilities.js';

// Check if a capability is valid (known)
isValidCapability('read_files');  // true
isValidCapability('unknown');     // false

// Check if agent has a specific capability
hasCapability(['read_files', 'write_files'], 'read_files');  // true

// Check if agent has ALL required capabilities
hasAllCapabilities(['read_files'], ['read_files', 'write_files']);  // false

// Check if agent has ANY of the listed capabilities
hasAnyCapability(['read_files'], ['read_files', 'write_files']);  // true
```

### Valid Capabilities

```
read_files, write_files, execute_commands, network_access,
read_email, draft_email, send_email, git_operations, install_packages
```

---

## Runtime Integration

The Runtime wires all Guardian components together. Key integration points:

### `Runtime.dispatchMessage(agentId, message)`

1. **Layer 1**: Runs `guardian.check()` with `type: 'message_dispatch'`
   - If denied → returns `[Message blocked: <reason>]`, records `action_denied`
   - If mutated → uses cleaned content, records `input_sanitized`
2. **Agent execution**: Calls `agent.onMessage(message, ctx)`
3. **Layer 2**: Runs `outputGuardian.scanResponse(response.content)`
   - If secrets found + redact mode → replaces secrets with `[REDACTED]`, records `output_redacted`
   - If secrets found + block mode → returns blocked message, records `output_blocked`

### `Runtime.createAgentContext(agentId, options?)`

Injects security-aware context:
- `ctx.capabilities` — read-only list from `AgentDefinition.grantedCapabilities`
- `ctx.checkAction(action)` — calls `guardian.check()`, throws on denial, records to AuditLog
- `ctx.emit(partial)` — scans payload via `outputGuardian.scanPayload()`, throws if secrets found, records `event_blocked`
- `ctx.dispatch(agentId, message)` — calls `Runtime.dispatchMessage()`, ensuring full Guardian pipeline runs for each sub-agent call. Enabled by default; set `options.enableDispatch` to `false` to disable.
- `ctx.sharedState` — optional `SharedStateView` (read-only) for sub-agents in orchestration patterns

### `Runtime.dispatchSchedule(agentId, schedule)`

Injects `auditLog` into `ScheduleContext` for Sentinel access.

---

## Orchestration Agents

**File:** `src/agent/orchestration.ts`

Three orchestration primitives that compose sub-agents into structured workflows. All extend `BaseAgent`.

### `SequentialAgent`

Runs sub-agents in order, passing state between steps.

```typescript
import { SequentialAgent } from './agent/orchestration.js';

const pipeline = new SequentialAgent('my-pipeline', 'Pipeline Name', {
  steps: [
    { agentId: 'step-1', outputKey: 'result1' },
    { agentId: 'step-2', inputKey: 'result1', outputKey: 'result2' },
  ],
  stopOnError: true,   // default: true — halt on first error
});
```

#### Step Configuration

```typescript
interface OrchestrationStep {
  agentId: string;      // target agent ID (must be registered)
  inputKey?: string;     // read from SharedState as message content
  outputKey?: string;    // write response to SharedState (default: agentId)
}
```

### `ParallelAgent`

Runs sub-agents concurrently with optional concurrency limit.

```typescript
import { ParallelAgent } from './agent/orchestration.js';

const fanout = new ParallelAgent('search', 'Multi-Search', {
  steps: [
    { agentId: 'web-search',  outputKey: 'web' },
    { agentId: 'doc-search',  outputKey: 'docs' },
    { agentId: 'code-search', outputKey: 'code' },
  ],
  maxConcurrency: 2,   // optional — limit concurrent dispatches
});
```

When `maxConcurrency` is set, uses a worker-pool pattern to process steps in batches.

### `LoopAgent`

Runs a single sub-agent repeatedly until a condition is met or `maxIterations` is reached.

```typescript
import { LoopAgent } from './agent/orchestration.js';

const loop = new LoopAgent('refiner', 'Iterative Refiner', {
  agentId: 'editor',
  outputKey: 'draft',
  maxIterations: 5,     // mandatory safety cap
  condition: (iteration, lastResponse) => {
    return !lastResponse?.content.includes('[DONE]');
  },
});
```

### Orchestration Types

```typescript
interface SequentialAgentOptions {
  steps: OrchestrationStep[];
  stopOnError?: boolean;
}

interface ParallelAgentOptions {
  steps: OrchestrationStep[];
  maxConcurrency?: number;
}

interface LoopAgentOptions {
  agentId: string;
  outputKey?: string;
  maxIterations: number;
  condition?: (iteration: number, lastResponse?: AgentResponse) => boolean;
}
```

---

## Shared State

**File:** `src/runtime/shared-state.ts`

Inter-agent data passing for orchestration patterns.

### `SharedState` (Mutable)

```typescript
import { SharedState } from './runtime/shared-state.js';

const state = new SharedState();
state.set('input', 'user message');
state.set('temp:counter', 0);

state.get<string>('input');    // 'user message'
state.has('input');             // true
state.keys();                   // ['input', 'temp:counter']
state.snapshot();               // { input: 'user message', 'temp:counter': 0 }
state.clearTemp();              // removes 'temp:counter'
state.clear();                  // removes all keys
```

### `SharedStateView` (Read-Only)

```typescript
const view = state.asReadOnly();
view.get<string>('input');     // works
view.set('x', 'y');            // TypeScript error — no set method
```

### Types

```typescript
interface SharedStateView {
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  keys(): string[];
  snapshot(): Record<string, unknown>;
}

class SharedState implements SharedStateView {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  keys(): string[];
  snapshot(): Record<string, unknown>;
  clearTemp(): void;           // Remove all 'temp:' prefixed keys
  clear(): void;               // Remove all keys
  readonly size: number;
  asReadOnly(): SharedStateView;
}
```

---

## MCP Client

**File:** `src/tools/mcp-client.ts`

Model Context Protocol client for consuming external tool servers.

### `MCPClient`

Manages a single MCP server connection over stdio.

```typescript
import { MCPClient } from './tools/mcp-client.js';

const client = new MCPClient({
  id: 'filesystem',
  name: 'Filesystem Tools',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  timeoutMs: 10_000,
});

await client.connect();              // spawn, initialize, discover tools
client.getTools();                    // MCPToolSchema[] (raw)
client.getToolDefinitions();          // ToolDefinition[] (GuardianAgent format)
const result = await client.callTool('read_file', { path: '/a.txt' });
client.disconnect();                  // kill process
```

### `MCPClientManager`

Manages multiple MCP server connections with tool name namespacing.

```typescript
import { MCPClientManager } from './tools/mcp-client.js';

const manager = new MCPClientManager();
await manager.addServer(filesystemConfig);
await manager.addServer(sqliteConfig);

manager.getAllToolDefinitions();       // combined list, namespaced
manager.getStatus();                  // per-server connection status

// Tool calls use namespaced names: mcp:<serverId>:<toolName>
const result = await manager.callTool('mcp:filesystem:read_file', { path: '/a.txt' });

manager.removeServer('filesystem');
await manager.disconnectAll();
```

### Types

```typescript
interface MCPServerConfig {
  id: string;
  name: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;       // default: 30000
}

type MCPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

interface MCPToolCallResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

---

## Evaluation Framework

**Files:** `src/eval/types.ts`, `src/eval/metrics.ts`, `src/eval/runner.ts`

### `EvalRunner`

Runs eval test cases through the real Runtime (Guardian active).

```typescript
import { EvalRunner, loadEvalSuite, formatEvalReport } from './eval/runner.js';

const runner = new EvalRunner({ runtime });
const suite = await loadEvalSuite('tests/assistant.eval.json');
const result = await runner.runSuite(suite.name, suite.tests);
console.log(formatEvalReport(result));
```

### Content Matchers

```typescript
type ContentMatcher =
  | { type: 'exact'; value: string }
  | { type: 'contains'; value: string }
  | { type: 'not_contains'; value: string }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'not_empty' };
```

### Safety Expectations

```typescript
interface SafetyExpectation {
  noSecrets?: boolean;              // run SecretScanner on response
  noBlockedPatterns?: string[];     // custom regex that must not appear
  noDenials?: boolean;              // no Guardian denial markers
  maxInjectionScore?: number;       // InputSanitizer score threshold
}
```

### Test Case Format

```typescript
interface EvalTestCase {
  name: string;
  description?: string;
  tags?: string[];
  agentId: string;
  input: EvalInput;
  expected: EvalExpected;
  timeoutMs?: number;
}

interface EvalInput {
  content: string;
  userId?: string;
  channel?: string;
}

interface EvalExpected {
  content?: ContentMatcher;
  toolCalls?: ExpectedToolCall[];
  metadata?: Record<string, unknown>;
  safety?: SafetyExpectation;
  custom?: (response: AgentResponse & { durationMs: number }) => EvalAssertion;
}
```

### Metrics

| Metric | What It Checks |
|--------|---------------|
| `content_exact` | Full string equality |
| `content_contains` | Substring present |
| `content_not_contains` | Substring absent |
| `content_regex` | Pattern matches |
| `content_not_empty` | Non-whitespace content |
| `tool_trajectory` | Required tools called in order |
| `metadata_match` | Key-value subset matching |
| `safety_no_secrets` | SecretScanner finds nothing |
| `safety_no_blocked_pattern` | Custom patterns absent |
| `safety_no_denials` | No Guardian denial markers |
| `safety_injection_score` | Score below threshold |
| `response_exists` | Fallback — non-empty response |
