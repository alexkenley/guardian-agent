# Architecture Decision Records

## ADR-001: Tick Loop over Cron/Event-Driven

**Status:** Superseded by ADR-005

**Context:** Traditional AI agent systems use cron jobs or event-driven architectures. These have latency gaps between events and make it hard to monitor agent progress in real-time.

**Decision:** Use a game-engine-style tick loop with accumulator pattern.

**Outcome:** Replaced in v2 — see ADR-005.

---

## ADR-002: Agents as Async Generators

**Status:** Superseded by ADR-005

**Context:** Need a mechanism for agents to yield control, report progress, and resume without losing state.

**Decision:** Agents are `AsyncGenerator<AgentYield, void, TickContext>`.

**Outcome:** Replaced by async class pattern in v2 — see ADR-005.

---

## ADR-003: bigint Tick Counters

**Status:** Retired

**Context:** At 100Hz, `Number.MAX_SAFE_INTEGER` would overflow in ~2,854 years.

**Decision:** Use `bigint` for all tick counters.

**Outcome:** Tick system removed in v2. Timestamp-based tracking uses standard `number` (ms).

---

## ADR-004: Exponential Backoff Schedule

**Status:** Accepted

**Context:** Need a fixed backoff strategy for agent errors that is simple, predictable, and wide enough to handle transient failures without causing retry storms.

**Decision:** Use `ERROR_BACKOFF_SCHEDULE_MS = [30s, 1m, 5m, 15m, 60m]`.

**Consequences:**
- (+) Proven in production
- (+) Prevents thundering herd on transient failures
- (+) Reasonable progression for LLM API errors

---

## ADR-005: Tick Engine → Event-Driven Pivot

**Status:** Accepted

**Context:** The tick loop was over-engineered for a personal assistant. LLM inference (2-30s) dominates all timing, making sub-10ms event response irrelevant. The tick engine added complexity for generators, accumulators, and layer scheduling with no practical benefit for the target use case.

**Decision:** Replace tick-based architecture with event-driven async class pattern. Agents implement `onMessage`, `onEvent`, `onSchedule` handlers. Runtime dispatches work directly.

**Consequences:**
- (+) Simpler agent authoring (async classes vs generators)
- (+) Enables future SaaS deployment (no persistent tick loop)
- (+) Easier to reason about and debug
- (+) Natural fit for LLM latencies (2-30s per call)
- (-) Lost sub-second cooperative scheduling (not needed for LLM agents)
- (-) Required full codebase rewrite of tick/ and executor

**What was kept:** Agent lifecycle state machine, exponential backoff, watchdog (adapted to timestamp-based), budget tracking.

---

## ADR-006: Unified LLM Provider Abstraction

**Status:** Accepted

**Context:** Need to support Ollama (local), Anthropic (Claude), and OpenAI from a single agent codebase. LangChain was considered but rejected for being too heavy and opaque.

**Decision:** Direct SDK wrappers behind a unified `LLMProvider` interface with `chat()` and `stream()` methods.

**Consequences:**
- (+) Full debuggability — no framework abstraction layers
- (+) Minimal dependencies per provider
- (+) Streaming via AsyncGenerator is natural
- (-) Must maintain provider-specific mapping code
- (-) ~~No automatic retry/fallback (must implement ourselves)~~ (resolved: ADR-013 adds failover with circuit breakers)

---

## ADR-007: Guardian Security System

**Status:** Accepted (expanded in ADR-008)

**Context:** AI agents can accidentally exfiltrate secrets, write to sensitive paths, or perform actions outside their intended scope. Users need protection from agents.

**Decision:** Admission controller pipeline with composable validators: CapabilityController (per-agent permissions), SecretScanController (regex-based secret detection), DeniedPathController (blocked file paths).

**Consequences:**
- (+) Defense-in-depth: multiple independent checks
- (+) Extensible via custom controllers
- (+) Fail-closed: deny by default if controller rejects
- (-) Regex-based secret detection has false positives/negatives
- (-) Capability model needs careful design as features grow

---

## ADR-008: Four-Layer Defense Architecture

**Status:** Accepted (updated: added Layer 2 Guardian Agent inline evaluation)

**Context:** The original Guardian (ADR-007) was built but **never wired into the Runtime dispatch path**. Messages reached agents without any security checks. Additionally, analysis of real AI agent incidents and internal security reviews revealed critical gaps: no input sanitization, no rate limiting, no output scanning, no audit trail, and no retrospective analysis. A further gap was identified: sync admission controllers cannot evaluate contextual risk of tool actions — only an LLM can reason about whether a tool invocation is appropriate given the conversation context.

**Decision:** Expand Guardian into a four-layer defense system:

- **Layer 1 (Admission):** Sync admission controller pipeline wired into `Runtime.dispatchMessage()` before agent execution. Five controllers in order: InputSanitizer (mutating), RateLimiter, CapabilityController, SecretScanController, DeniedPathController.
- **Layer 2 (Guardian Agent):** `GuardianAgentService` performs inline LLM-powered evaluation of non-read-only tool actions before execution. Uses a dedicated security-focused system prompt (no SOUL/skills injection). Configurable LLM provider (`local`/`external`/`auto`), fail-open/closed mode, and timeout. Runs as an `onPreExecute` hook in `ToolExecutor`.
- **Layer 3 (Output):** OutputGuardian scans LLM responses after agent execution but before user delivery. Also scans inter-agent event payloads in `ctx.emit()`.
- **Layer 4 (Sentinel Audit):** `SentinelAuditService` runs on cron schedule or on-demand, analyzes AuditLog for anomalous patterns using heuristic rules and optional LLM-enhanced analysis.

Cross-cutting: AuditLog records all security events in an in-memory ring buffer (12 event types, queryable, configurable) with optional SHA-256 hash-chained JSONL persistence for tamper detection and crash recovery (see ADR-012).

**Consequences:**
- (+) Defense-in-depth at every stage: input → tool evaluation → output → retrospective
- (+) Input sanitization catches prompt injection before agent sees the message
- (+) Guardian Agent catches contextually dangerous tool actions that regex rules cannot detect
- (+) Output redaction prevents credential leaks in LLM responses without blocking useful content
- (+) AuditLog provides structured data for both real-time monitoring and forensic analysis
- (+) Sentinel Audit detects slow-burn attacks that individual controllers miss
- (+) All features configurable and individually toggleable
- (-) Additional latency for each message (~ms for regex scanning, negligible)
- (-) Guardian Agent adds LLM call latency for non-read-only tool actions (~1-3s depending on provider)
- (-) ~~In-memory audit log loses data on restart~~ (resolved: ADR-012 adds hash-chained persistence)
- (-) Heuristic injection detection has false positive/negative tradeoffs

---

## ADR-009: Output Redaction vs Blocking

**Status:** Accepted

**Context:** When the OutputGuardian detects a secret in an LLM response, two strategies are possible: (1) block the entire response, or (2) redact just the secret and let the rest through.

**Decision:** Default to **redaction** (`[REDACTED]` markers) with blocking as a configurable fallback.

**Rationale:**
- LLM responses are expensive (latency + tokens). Blocking wastes the entire response for a single leaked credential.
- Users expect useful output. A response like "The API key is [REDACTED] and you should configure it in..." is far more useful than "[Response blocked: credential leak detected]".
- The AuditLog records every redaction with pattern details, so operators have full visibility.
- Blocking is still available via `guardian.outputScanning.redactSecrets: false` for high-security deployments.

**Implementation:** Offset-based replacement using `rawMatch` field on `SecretMatch` — replace from end of string backward to preserve earlier offsets.

**Consequences:**
- (+) Users get useful responses even when secrets leak
- (+) AuditLog captures full detection details for review
- (+) Configurable: operators can choose block mode for stricter security
- (-) Redacted response may be confusing if context around the secret is also important
- (-) Requires accurate `rawMatch` tracking (added to SecretMatch interface)

---

## ADR-010: Mutating vs Validating Controller Phases

**Status:** Accepted

**Context:** The Guardian pipeline needs to support two types of controllers: those that modify the action (e.g., stripping invisible characters from input) and those that only approve/deny (e.g., capability checks).

**Decision:** Two-phase pipeline: **mutating** controllers run first, **validating** controllers run second. Controllers return `null` to pass through, a denial result to short-circuit, or a result with `mutatedAction` to modify the action for downstream controllers.

**Rationale:**
- Mutating controllers (InputSanitizer) must run first so validating controllers see cleaned content
- This mirrors Kubernetes admission controller design (mutating webhooks → validating webhooks)
- Pipeline ordering is enforced by `Guardian.use()` which sorts by phase

**Consequences:**
- (+) Clean separation of concerns between mutation and validation
- (+) Validating controllers always see sanitized input
- (+) Familiar pattern for anyone who knows Kubernetes admission control
- (-) Mutating controllers can mask original input, making debugging harder (mitigated by AuditLog recording original lengths)

---

## ADR-011: Agent Self-Check via Context

**Status:** Accepted

**Context:** Agents sometimes need to know whether a planned action would be allowed before attempting it (e.g., check if a file write is permitted before doing expensive computation to generate the content).

**Decision:** Add `checkAction()` and `capabilities` to `AgentContext`. The `checkAction()` method calls `Guardian.check()` with the agent's granted capabilities and throws on denial.

**Rationale:**
- Agents should be able to fail gracefully instead of attempting denied actions
- The capabilities list lets agents adapt their behavior based on permissions
- Throwing on denial is consistent with the rest of the error handling model

**Implementation:** `Runtime.createAgentContext()` injects both fields, wired to the Guardian instance and the agent's `AgentDefinition.grantedCapabilities`.

**Consequences:**
- (+) Agents can make informed decisions about what they can/cannot do
- (+) Denied actions still recorded in AuditLog even when pre-checked
- (+) Read-only capabilities list prevents privilege escalation
- (-) Adds to AgentContext interface surface area

---

## ADR-012: Hash-Chained Audit Persistence

**Status:** Accepted

**Context:** The in-memory AuditLog ring buffer loses all events on process restart. For a security product, audit trail persistence and tamper detection are critical — an attacker who compromises the process shouldn't be able to silently erase evidence.

**Decision:** Persist audit events to a JSONL file with SHA-256 hash chaining. Each entry stores `{ event, previousHash, hash }` where hash is computed over `JSON.stringify({ event, previousHash })`. Genesis hash is 64 zero characters. Writes are serialized via chained Promises (fire-and-forget from the hot path). A `verifyChain()` method streams the file and recomputes hashes to detect tampering.

**Consequences:**
- (+) Audit events survive restarts
- (+) Tamper detection at line-level granularity
- (+) Fire-and-forget write doesn't block message processing
- (+) No external dependencies (uses `node:crypto` and `node:fs`)
- (-) Single JSONL file will grow without bound (future: rotation/archival)
- (-) Hash chain can only detect tampering, not prevent it (attacker with disk access could rewrite entire file)

---

## ADR-013: LLM Provider Failover with Circuit Breaker

**Status:** Accepted

**Context:** ADR-006 noted "must implement retry/fallback ourselves" as a consequence. A single LLM provider outage makes the entire system unresponsive. Repeated retries against a dead endpoint waste resources and increase latency.

**Decision:** Implement a `FailoverProvider` that wraps multiple LLM providers with priority-based failover and per-provider circuit breakers. Circuit breaker follows the standard pattern: closed → open (after N failures) → half_open (after timeout) → closed (on success). Errors are classified as auth/quota/transient/permanent/timeout — only transient/quota/timeout trigger failover.

**Consequences:**
- (+) Automatic failover on transient provider failures
- (+) Circuit breaker prevents cascading failures from hammering dead providers
- (+) Error classification avoids futile failovers for auth issues
- (+) Priority ordering gives operators control over preferred providers
- (-) Adds complexity to provider initialization path
- (-) Failover mid-stream (for `stream()`) may produce partial responses from the first provider

---

## ADR-014: Trust Presets for Security Posture

**Status:** Accepted

**Context:** Security configuration requires tuning rate limits, capabilities, resource limits, and tool policies across multiple config sections. New users don't know sensible defaults for their use case.

**Decision:** Four named presets — `locked`, `safe`, `balanced`, `power` — each defining a complete security posture. Applied during config loading with priority: user explicit > preset > defaults. Presets configure guardian rate limits, agent capabilities (for agents without explicit ones), and tool approval policy.

**Consequences:**
- (+) One-line security configuration for common use cases
- (+) Progressive trust levels make security trade-offs explicit
- (+) Explicit user values always win, so presets are non-destructive
- (-) Preset names are opinionated and may not match all deployment models
- (-) Adding new config fields requires updating all four presets

---

## ADR-015: Shell Command Tokenization and Validation

**Status:** Accepted

**Context:** The DeniedPathController validates file paths but can't parse chained shell commands like `rm -rf / && cat .env`. An LLM-generated command could chain a dangerous operation after an innocuous one, bypassing simple string matching.

**Decision:** Implement a POSIX shell tokenizer that handles single/double quoting, backslash escaping, chain operators (`&&`, `||`, `;`, `|`), redirects (`>`, `>>`, `<`), and subshell detection (`$(...)`, backticks). Each sub-command is validated against the `allowedCommands` allowlist and `deniedPaths` checker. Deny-by-default: if the tokenizer can't parse the input, the command is denied.

**Consequences:**
- (+) Catches chained command attacks that bypass simple path checks
- (+) Respects shell quoting rules (won't false-positive on `echo "&&"`)
- (+) Subshell detection flags command substitution
- (+) Deny-by-default on parse failure is safe
- (-) Tokenizer covers common POSIX shell — exotic syntax (heredocs, process substitution) may cause false denials
- (-) Allowlist-based approach requires maintaining the command list

---

## ADR-016: Tool Dry-Run Mode

**Status:** Accepted

**Context:** Mutating tool operations (file writes, shell commands, HTTP requests) are irreversible. Operators need a way to preview what would happen without executing the side effect, especially when testing new tool configurations or investigating LLM behavior.

**Decision:** Add `dryRun?: boolean` to `ToolExecutionRequest`. When set and the tool has a mutating risk level (`!== 'read_only'`), the executor runs all validation (Guardian checks, path allowlists, policy approval) but returns a preview result instead of executing the side effect. Read-only tools execute normally regardless of the flag.

**Consequences:**
- (+) Safe preview of destructive operations
- (+) Validation still runs, so policy violations are caught in preview
- (+) Read-only tools unaffected (no unnecessary overhead)
- (-) Preview text is approximation — actual execution may differ
- (-) Adds a branch to every mutating tool handler

---

## ADR-017: Structured Orchestration Agents

**Status:** Accepted

**Context:** GuardianAgent's EventBus provides low-level pub/sub communication between agents. Google ADK demonstrated that structured orchestration primitives (SequentialAgent, ParallelAgent, LoopAgent) significantly simplify multi-agent workflows without requiring developers to manage state passing and error handling manually.

**Decision:** Add three orchestration agent types extending `BaseAgent`:
- **SequentialAgent**: Runs sub-agents in order, passing state between steps via `inputKey`/`outputKey`
- **ParallelAgent**: Runs sub-agents concurrently with optional `maxConcurrency`, combining results
- **LoopAgent**: Runs a sub-agent repeatedly with configurable condition and mandatory `maxIterations` cap

All sub-agent invocations use `ctx.dispatch()`, which calls `Runtime.dispatchMessage()` — ensuring every sub-call passes through the full Guardian admission pipeline.

**Consequences:**
- (+) Declarative multi-agent composition (no manual event wiring)
- (+) Security preserved by construction — every dispatch goes through Guardian
- (+) Fault tolerance built in (stopOnError toggle, error isolation in parallel)
- (+) LoopAgent has mandatory iteration cap preventing infinite loops
- (-) Dispatch loops possible if orchestrating agents invoke each other (mitigated by budget timeouts)
- (-) Amplification risk — single message can trigger N sub-agent calls (mitigated by rate limiting)
- (-) Indirect prompt injection through state pipeline is an open challenge

**Spec:** `docs/specs/ORCHESTRATION-SPEC.md`

---

## ADR-018: MCP Client Support

**Status:** Accepted

**Context:** GuardianAgent's tool system is closed — all tools are built-in. The Model Context Protocol (MCP) is an emerging standard for tool interoperability across AI systems. Adding MCP client support extends the tool ecosystem without requiring built-in implementations for every integration.

**Decision:** Implement an MCP client using JSON-RPC 2.0 over stdio transport. An `MCPClientManager` manages multiple server connections. Tool names are namespaced as `mcp:<serverId>:<toolName>` to prevent collisions. All MCP tools are classified as `network` risk since they communicate with an external process.

**Key security decision:** MCP tool calls must pass through the Guardian admission pipeline before execution. The MCP server process is treated as untrusted — it runs in a child process with no direct access to GuardianAgent's runtime.

**Consequences:**
- (+) Access to the entire MCP tool ecosystem (filesystem, databases, APIs, etc.)
- (+) Namespacing prevents tool name collisions with built-in tools
- (+) Guardian validates all MCP calls — security model is preserved
- (+) Server processes are isolated in child processes
- (-) MCP server process has same OS-level permissions as GuardianAgent (mitigation: container isolation)
- (-) No automatic reconnection on server crash (planned for future)
- (-) TypeScript MCP SDK not yet GA — we implement the protocol directly
- (-) Only stdio transport supported initially (SSE planned)

**Spec:** `docs/specs/MCP-CLIENT-SPEC.md`

---

## ADR-019: Agent Evaluation Framework

**Status:** Accepted

**Context:** GuardianAgent has comprehensive unit tests but no structured way to evaluate agent *behavior* — whether agents produce correct, safe, helpful responses to realistic inputs. Google ADK's `.test.json` evalset format demonstrated a lightweight approach to agent evaluation.

**Decision:** Build an evaluation framework with three components:
1. **Types** — `EvalTestCase` with input, expected content/tools/metadata/safety criteria
2. **Metrics** — Content matching (5 strategies), tool trajectory, metadata match, safety checks (secrets, patterns, denials, injection score)
3. **Runner** — Dispatches through real Runtime (Guardian active), computes per-metric pass rates

**Key design choice:** Evaluations run through the real Runtime, not mocks. Guardian, output scanning, rate limiting, and budget tracking are all active. This tests the actual security posture.

**Consequences:**
- (+) Structured, repeatable agent behavior testing
- (+) JSON-based test format compatible with CI pipelines
- (+) Safety metrics use the same SecretScanner and InputSanitizer as production
- (+) Real Runtime testing catches security regressions
- (+) Per-metric pass rates enable targeted debugging
- (-) Real Runtime eval is slower than mock-based testing
- (-) Rate limiting may throttle rapid eval runs
- (-) No LLM-as-judge or semantic matching (planned for future)

**Spec:** `docs/specs/EVAL-FRAMEWORK-SPEC.md`

---

## ADR-020: Shared State for Inter-Agent Data Passing

**Status:** Accepted

**Context:** Orchestration agents need to pass intermediate results between sub-agent invocations. Google ADK uses `session.state` with `output_key` — a shared dict that any agent in the graph can read/write. This creates cross-agent data leakage risks.

**Decision:** Implement `SharedState` as a key-value store with stricter access control than ADK:
- **Owned by orchestrator** — Only the orchestrating agent creates and writes to SharedState
- **Sub-agents cannot read or write** — They receive input as a `UserMessage`, not state references
- **Per-invocation scope** — Fresh state for each `onMessage()` call, no persistence between messages
- **Temp key convention** — Keys prefixed with `temp:` are bulk-cleaned via `clearTemp()`
- **Read-only view** — `asReadOnly()` provides a `SharedStateView` interface (for future sub-agent access)

**Consequences:**
- (+) No cross-agent state leakage — sub-agents are unaware state exists
- (+) Per-invocation scoping prevents stale state bugs
- (+) Temp keys enable clean separation of scratch vs output data
- (+) Sub-agent responses pass through OutputGuardian before being written to state
- (-) More restrictive than ADK's open model — sub-agents can't self-coordinate via state
- (-) State is in-memory only — no persistence for long-running orchestrations
- (-) State poisoning via crafted response content is an open challenge (InputSanitizer helps but doesn't fully solve)

**Spec:** `docs/specs/SHARED-STATE-SPEC.md`

---

## ADR-021: Connector Pack + Playbook Framework (Option 2)

**Status:** Accepted

**Context:** We need workflow automation for infrastructure operations (home labs, enterprise labs, building management) without pulling in a heavyweight external orchestration runtime. External platforms add operational overhead and can create policy bypass risk if execution leaves GuardianAgent control planes.

**Decision:** Adopt a native Connector + Playbook framework:
- `assistant.connectors` defines bounded connector packs (capabilities, hosts, paths, commands, auth mode).
- Playbook execution is step-limited and timeout-bounded with optional parallelism caps.
- Visual studio mode is policy-driven (`read_only` or `builder`) and designed to reuse privileged-ticket patterns for mutating controls.
- Connector actions are intended to route through existing ToolExecutor + Guardian chokepoints rather than introducing a parallel execution path.

**Consequences:**
- (+) Lower complexity than embedding a separate workflow engine.
- (+) Security posture remains consistent with existing Guardian, tool approvals, and audit chain.
- (+) Declarative packs provide explicit least-privilege boundaries per operational domain.
- (+) Enables phased rollout (policy first, runtime execution second, visual builder third).
- (-) Requires building native runtime modules for connector registry/playbook execution.
- (-) Limited ecosystem compared with mature workflow products until connector catalog grows.

**Spec:** `docs/specs/AUTOMATION-FRAMEWORK-SPEC.md`

---

## ADR-022: Agent Auto-Recovery on User Messages

**Status:** Accepted

**Context:** When an agent enters the Errored state (e.g., due to a misconfigured provider returning 404), users receive an unhelpful "Agent cannot accept work in state 'errored'" rejection. The only recovery path was waiting for the watchdog's exponential backoff schedule [30s, 1m, 5m, 15m, 60m], which could leave agents unusable for extended periods — especially frustrating when the user has already fixed the underlying config issue.

**Decision:** In `Runtime.dispatchMessage()`, before `assertExecutable()`, check if the target agent is in Errored state. If so, automatically transition it to Ready before proceeding. If the transition fails, fall through to the original `assertExecutable()` which throws the standard rejection.

**Consequences:**
- (+) Users get the actual underlying error instead of a dead-end lifecycle rejection
- (+) Agents can recover immediately after config fixes without waiting for backoff
- (+) No change to the Dead state — agents that exhaust max retries are still permanently dead
- (+) Safe: if the underlying issue persists, the agent will error again and the user sees the real cause
- (-) The consecutive error counter is not reset, so repeated auto-recoveries still accumulate toward Dead

---

## ADR-023: Dedicated Web Search Config Endpoint

**Status:** Accepted

**Context:** The Config Center's web search save handler used the same `POST /api/setup/apply` endpoint as LLM provider saves. It sent hardcoded `llmMode: 'ollama'` plus the current model name, which overwrote the provider type to `'ollama'` even when the actual provider was OpenAI/Anthropic — silently corrupting the LLM configuration.

**Decision:** Create a dedicated `POST /api/config/search` endpoint that accepts only web search fields (`webSearchProvider`, API keys, `fallbacks`). This endpoint updates only `assistant.tools.webSearch` in config — it never touches LLM fields. The frontend's web search save handler now calls `api.saveSearchConfig()` instead of `api.applyConfig()`.

Additionally, `POST /api/setup/apply` was hardened: when `providerType` is missing, the backend preserves the existing provider's type instead of defaulting to `'openai'`. If no existing provider exists and no `providerType` is provided, it returns an error.

**Consequences:**
- (+) Eliminates the root cause of cross-domain config corruption
- (+) Web search settings can be saved independently without risk to LLM config
- (+) Provider saves are now safer — explicit `providerType` required
- (+) API key clearing supported (empty string = delete)
- (-) Two endpoints for config writes instead of one (acceptable trade-off for safety)

---

## ADR-024: Dynamic Agent Capabilities from Trust Presets

**Status:** Accepted

**Context:** Auto-registered agents (local, external, default) had hardcoded capability lists at registration time. The `local` agent initially lacked `network_access`, which blocked web search even when the user's trust preset would have granted it. This violated the design intent that the Guardian system should be user-authorized — capabilities should come from the user's security posture configuration, not developer hardcoding.

**Decision:** Resolve agent capabilities dynamically from the configured trust preset at bootstrap time. All auto-registered agents share the same capability set derived from `TRUST_PRESETS[config.guardian.trustPreset]`. When no preset is configured, a sensible default set is used.

**Consequences:**
- (+) User's trust preset selection directly controls agent capabilities
- (+) Consistent capabilities across all auto-registered agents
- (+) Changing the trust preset changes what agents can do (after restart)
- (-) All auto-registered agents share the same capabilities — no per-agent differentiation for auto-registered agents (config-defined agents still have explicit capabilities)

---

## ADR-025: Native TypeScript Search Pipeline for Hybrid Document Search

**Status:** Accepted (supersedes original QMD subprocess approach)

**Context:** The memory system only supports BM25 keyword search (FTS5) over conversation history. There was no semantic/vector search capability, and no way to search external document collections (notes, codebases, wikis). A native in-process search pipeline eliminates external binary dependencies while providing hybrid search.

**Decision:** Implement a native TypeScript search pipeline (`src/search/`) using SQLite FTS5 for BM25 keyword search and in-JS cosine similarity over embeddings stored as BLOBs for vector search. Results are merged via Reciprocal Rank Fusion (RRF). Parent-child chunking provides both context and search precision. Embedding providers (Ollama, OpenAI) are optional — the system gracefully degrades to keyword-only search.

**Consequences:**
- (+) Zero external dependencies — pure TypeScript/JS, no native extensions, no subprocess overhead
- (+) Supply chain security: no external binaries to trust or bundle
- (+) Clean separation: search tools live in their own `search` category, independent of `memory` tools
- (+) Multi-protocol sources allow indexing diverse document collections
- (+) Graceful degradation: works with keyword-only if no embedding provider is configured
- (+) In-process search eliminates ~50-200ms subprocess overhead per query
- (-) Vector search KNN is O(n) cosine similarity in JS rather than ANN index; acceptable for typical collection sizes

---

## ADR-026: Native Skills Complement MCP Rather Than Replacing It

**Status:** Accepted
**Implementation Status:** Foundation implemented and uplifted (`SkillRegistry`, trigger-aware `SkillResolver`, prompt injection, skill telemetry, bundled local skills with templates/scripts)

**Context:** GuardianAgent needs a reusable workflow and procedural-knowledge layer. External skill ecosystems show strong utility, but they also expand supply-chain risk and do not provide the typed, policy-enforced execution model that GuardianAgent already has through built-in tools and MCP. Replacing MCP with skills would collapse execution and guidance into the same trust domain.

**Decision:** Add a native skills layer while keeping MCP and built-in tools as the execution plane.

- Skills provide reusable instructions, templates, references, and workflow guidance.
- Skills do not execute directly and do not bypass ToolExecutor.
- Skills do not grant capabilities or define a parallel approval model.
- MCP remains the typed interface for external executable capabilities.

**Consequences:**
- (+) Skills improve planning and consistency without weakening the execution boundary.
- (+) MCP continues to provide schemas, structured arguments, and external integration support.
- (+) Supply-chain exposure is reduced by defaulting to local reviewed skills.
- (-) Two concepts to explain to users: skills for guidance, tools for action.
- (-) Requires prompt-budget discipline so skill context does not bloat every request.

**Specs:** `docs/specs/SKILLS-SPEC.md`, `docs/specs/MCP-CLIENT-SPEC.md`

---

## ADR-027: Google Workspace Uses Managed MCP + Native Skills

**Status:** Accepted (extended with native mode)
**Implementation Status:** Both native googleapis SDK and managed `gws` CLI backends are implemented. Native mode is the default. Bundled Google skills and service-specific capability hooks apply to both modes.

**Context:** Broad Google Workspace support is valuable, but building and maintaining bespoke first-party integrations for Gmail, Calendar, Drive, Docs, and Sheets would be slow and inconsistent. Giving the agent unrestricted shell access to a general-purpose Google CLI would weaken GuardianAgent's policy surface and audit story. Additionally, the CLI-based path required a 7-step setup (global npm install, Cloud Console credentials, terminal auth, manual config) that was too complex for typical users.

**Decision:** Support two backends, with native mode as the default:

- **Native mode (default):** `src/google/` module calls Google APIs directly via the `googleapis` SDK. OAuth 2.0 PKCE handled within GuardianAgent with a localhost callback. 3-step setup.
- **CLI mode (legacy):** Managed MCP provider built around `gws` CLI subprocess. Retained for power users with existing setups.
- Both share the same `gws` tool name, Guardian policy pipeline, and curated native Google skills.
- GuardianAgent owns policy, approvals, capabilities, audit, and sandboxing in both modes.

**Consequences:**
- (+) Native mode eliminates the external CLI dependency and reduces setup from 7 steps to 3.
- (+) Direct SDK calls remove ~200ms subprocess overhead per API call.
- (+) Encrypted token storage keeps credentials under GuardianAgent's control.
- (+) CLI fallback preserves backward compatibility for existing deployments.
- (+) Consistent control plane — both modes route through the same tool handlers and Guardian checks.
- (-) Dynamic provider surfaces require stricter service allowlists and capability mapping.
- (-) Two code paths to maintain (mitigated by shared tool interface and shared policy layer).

**Specs:** `docs/specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md` (native mode), `docs/specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md` (CLI mode)

---

## ADR-028: Strict Sandbox Availability for Risky Tool Classes

**Status:** Accepted
**Implementation Status:** Implemented for sandbox health detection, strict tool gating, user-facing notices, and a Windows helper adapter/config surface; shipping the native Windows/macOS helper binaries remains follow-up work

**Context:** GuardianAgent currently improves subprocess containment with bwrap on Linux and softer fallbacks elsewhere, but silent degradation is not a strong enough contract for high-risk tools. Users need the system to be explicit about when strong isolation is unavailable, especially on Windows and macOS.

**Decision:** Introduce a sandbox availability model and a strict enforcement mode for risky tool classes.

- Sandbox health is classified as `strong`, `degraded`, or `unavailable`.
- In strict mode, risky subprocess-backed tools are disabled unless a strong backend is present.
- All channels must surface disable reasons clearly.
- Windows will use a native sandbox helper built on platform primitives rather than relying on JavaScript-only policy checks.

**Consequences:**
- (+) No silent downgrade for risky tool execution.
- (+) Users get explicit, actionable feedback in CLI, web, Telegram, and chat.
- (+) Establishes a realistic path to stronger Windows support without requiring WSL2 or Docker.
- (-) Some capabilities will be unavailable on hosts without strong sandbox support.
- (-) Requires additional platform-specific runtime code and UX states.

**Refs:** `SECURITY.md`, `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`

## ADR-029: Per-Tool LLM Provider Routing

**Status:** Accepted (updated: added smart category defaults and routing toggle)

**Context:** When using a local LLM (Ollama) as the default provider, tool result synthesis is often poor — the model returns uninformative responses like "Tool 'fs_write' completed" instead of describing what actually happened. Quality-based fallback (`isResponseDegraded()`) only catches empty/refusal patterns, not low-quality-but-non-empty responses. Users with both local and external providers configured needed a way to selectively route specific tools through higher-quality models without switching their entire default provider.

Manual per-tool routing configuration was too granular for most users. A natural locality pattern emerged: local operations (filesystem, shell, network, system, memory) are well-handled by local models, while operations requiring structured reasoning or external APIs (web, browser, workspace, email, contacts, forum, intel, search, automation) benefit from stronger external models. Automation was initially categorized as local but moved to external after testing showed local models consistently failed to invoke tools with complex multi-step structured arguments. This led to smart category defaults.

**Decision:** Add `assistant.tools.providerRouting` — a map from tool names or category names to `'local'` or `'external'`. The routing decision happens per-round in the ChatAgent tool loop: after tools execute, `resolveToolProviderRouting()` checks executed tool names and categories against the routing map. If a preference is found, the `chatFn` is swapped to the preferred provider for the *next* LLM call — meaning the model that processes the tool result and generates the user-facing response is the routed one, not the one that initiated the tool call.

Resolution order: tool-name match > category match > smart category default > default provider locality. When multiple tools in one round conflict, `external` wins. If the routed provider is unavailable, routing is silently skipped. Web UI exposes Local/External dropdowns per category and per tool, with category changes cascading to child tools.

**Smart category defaults:** When both local and external providers are configured, `providerRoutingEnabled` (default: `true`) activates automatic category-based routing:
- Local categories: filesystem, shell, network, system, memory, automation
- External categories: web, browser, workspace, email, contacts, forum, intel, search
- When only one provider type exists, smart routing is a no-op
- Explicit `providerRouting` entries always override smart defaults

**`providerRoutingEnabled` toggle:** A master switch (`assistant.tools.providerRoutingEnabled`, default: `true`) enables or disables smart routing. When off, all tools use the default provider unless explicitly overridden in `providerRouting`. Exposed in the web UI as a "Smart LLM Routing" checkbox in the Tools tab. The Providers tab also gained a "Set as Default" button per provider row (`POST /api/providers/default`).

**Consequences:**
- (+) Users can route expensive synthesis (file writes, workspace operations) through external models while keeping fast reads on local.
- (+) Smart defaults provide sensible routing out of the box with zero configuration.
- (+) Hot-reloadable — changes via web UI or config edit take effect immediately, no restart needed.
- (+) Graceful degradation — missing providers silently fall back to default; single-provider setups are unaffected.
- (+) Category-level defaults reduce per-tool configuration burden.
- (-) Adds one round of routing logic per tool execution in the LLM loop.
- (-) External provider routing incurs API costs for those tool calls.
- (-) Smart defaults are opinionated — users who disagree can disable via toggle or override per-category.

**Refs:** `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`, `src/index.ts` (`resolveToolProviderRouting`, `resolveRoutedProviderForTools`)

---

## ADR-030: Code Session Auto-Approve with Guardian Agent Safety Net

**Status:** Accepted

**Context:** In `approve_by_policy` mode, every mutating tool call requires manual user approval. This creates excessive friction in coding sessions — the user must approve every file edit, file create, and automation setup individually, even though they have already granted trust to the workspace by creating the session. The approval flow also broke frequently because `codeContext` was not propagated through the broker pipeline, causing tools to fall back to the generic approval path.

Additionally, auto-approving automation tools (`task_create`, `workflow_upsert`) raised a security concern: unlike filesystem tools which are scoped to the workspace root by `resolveAllowedPath()`, automation tools create system-level scheduled tasks that are not inherently workspace-scoped.

**Decision:** Auto-approve coding, filesystem, memory, document, and automation tools when operating inside a code session with a valid workspace root. The auto-approve bypasses only the `decide()` approval step in `ToolExecutor`. All other security layers remain active:

- Guardian admission pipeline (Layer 1)
- **Guardian Agent inline LLM evaluation (Layer 2)** — `onPreExecute` evaluates every non-read-only tool action before execution, including auto-approved ones. This is the safety net for automation tools: the Guardian Agent LLM can detect and block contextually dangerous actions (e.g., prompt-injected malicious automations) that static approval gates cannot.
- Output Guardian scanning (Layer 3)
- Sentinel Audit (Layer 4)
- Path validation via `resolveAllowedPath()` for filesystem tools
- Bearer token authentication on the web channel

The workspace root is authorized through `codeContext` while the request is inside a Code session. It is not added to the global `allowedPaths` policy, so ordinary non-Code chat does not inherit repo access just because a Code session exists.

**Implementation note — codeContext propagation:** Auto-approve depends on `codeContext` reaching `ToolExecutor.decide()`. Three execution paths carry it: (1) the inline ChatAgent LLM loop, (2) the brokered worker pipeline (ChatAgent → message metadata → worker session → BrokerClient → BrokerServer → ToolExecutor), and (3) the supervisor-side `tryDirectAutomationAuthoring` pre-route in WorkerManager. All three must forward `codeContext` or auto-approve silently fails. See `docs/specs/CODING-ASSISTANT-SPEC.md` § codeContext Propagation.

**Consequences:**
- (+) Eliminates approval friction for coding workflow — edits, creates, tests, and automations execute immediately
- (+) Guardian Agent LLM evaluation catches contextually dangerous actions that static rules miss
- (+) Path validation still enforces workspace boundary for filesystem tools
- (+) All four security layers remain active — only the approval gate is bypassed
- (+) Bearer token + session ownership provide authentication context
- (-) Automation tools are not workspace-scoped — relies on Guardian Agent evaluation to catch misuse
- (-) If Guardian Agent is disabled or configured as fail-open, automation tools execute without any approval checkpoint
- (-) codeContext propagation is fragile — if any layer in the broker/worker chain drops it, auto-approve silently degrades to require_approval

**Refs:** `docs/specs/CODING-ASSISTANT-SPEC.md`, `src/tools/executor.ts` (`isCodeSessionWorkspaceTool`), `src/index.ts` (workspace root auto-add), `src/supervisor/worker-manager.ts` (automation pre-route codeContext), `src/broker/broker-client.ts` + `src/broker/broker-server.ts` (broker codeContext forwarding)
