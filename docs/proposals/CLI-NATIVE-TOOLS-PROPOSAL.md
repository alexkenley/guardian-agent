# Proposal: CLI-Native Tool Adapters & GitHub Integration

**Date:** 2026-03-09
**Status:** Proposal
**Scope:** Tool architecture direction, GitHub CLI integration, MCP positioning
**Current as-built references:** [TOOLS-CONTROL-PLANE-DESIGN.md](/mnt/s/Development/GuardianAgent/docs/design/TOOLS-CONTROL-PLANE-DESIGN.md), [NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-DESIGN.md](/mnt/s/Development/GuardianAgent/docs/design/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-DESIGN.md)

This proposal is still forward-looking. Guardian already ships some direct CLI/native tool patterns, but the proposal's main GitHub CLI adapter direction is not implemented as a dedicated built-in tool surface yet.

---

## 1. Problem Statement

GuardianAgent's MCP client (`src/tools/mcp-client.ts`) implements a full JSON-RPC 2.0 protocol to spawn and manage persistent server processes for tool execution. This architecture solves a real problem — giving AI agents tool access without shell access — but introduces significant overhead when the tools being wrapped are CLIs already on PATH.

### The MCP Tax

| Cost | Detail |
|------|--------|
| **Token overhead** | GitHub's MCP server exposes 93 tool definitions. At ~590 tokens per definition, that's ~55,000 tokens burned before the agent writes a single line of code. Even with deferred loading, a `find_tools` search returns full schemas. |
| **Process overhead** | Each MCP server is a persistent subprocess with JSON-RPC framing, request correlation, and lifecycle management. When it crashes, tool access stops until reconnection. |
| **Protocol complexity** | Content-Length framing + newline-delimited JSON fallback, async request/response correlation, initialize handshake, notifications — all to call `gh pr list`. |
| **Security surface** | 43% of tested MCP servers have command injection flaws (per industry audit data). The JSON-RPC transport adds an attack surface that the underlying CLI never had. GuardianAgent mitigates this with `inferMcpToolRisk()` heuristics, but heuristic risk classification is inherently less precise than explicit per-operation classification. |
| **Protocol instability** | MCP transport has changed three times in one year (stdio, SSE, Streamable HTTP). GuardianAgent currently pins to stdio (`protocolVersion: "2024-11-05"`). |

### What GuardianAgent Already Does Well

GuardianAgent already has a proven CLI-native pattern that avoids all of the above:

GuardianAgent already ships several direct native/CLI-style patterns that avoid MCP overhead:
- native Google and Microsoft services exposed through curated first-party tools
- direct subprocess-backed network/system tooling where Guardian remains the approval and audit boundary
- `shell_safe` for tightly allowlisted CLI access without a separate JSON-RPC transport

**Network tools** (`net_ping`, `net_arp_scan`, etc.) follow the same pattern — detect platform, build command, run via `sandboxExec()`, parse output.

**shell_safe** already allowlists `git`, `docker`, `npm`, `kubectl` and other CLIs with operator blocking and read-only bypass.

The LLM already knows these CLIs from training data. `gh pr create --help` teaches it everything it needs — on demand, not upfront.

---

## 2. Current MCP Implementation Analysis

### Architecture

```
MCPClientManager (multi-server orchestrator)
  └── MCPClient[] (per-server JSON-RPC connection)
        ├── Process spawn (sandboxed, stdio pipes)
        ├── Initialize handshake (protocolVersion, capabilities)
        ├── Tool discovery (tools/list → cache definitions)
        ├── Tool execution (tools/call → JSON-RPC request/response)
        └── Rate limiting (per-server sliding window)
```

**Key files:**
- `src/tools/mcp-client.ts` — MCPClient (lines 112-470) + MCPClientManager (lines 480-590)
- `src/tools/executor.ts` — `registerMCPTools()` (lines 276-296), `inferMCPGuardAction()` (lines 6181-6226)
- `src/config/types.ts` — `MCPServerEntry`, `AssistantMCPConfig` (lines 651-696)
- `src/index.ts` — MCP bootstrap (lines 4225-4288)

### Tool Naming

MCP tools are namespaced as `mcp-<serverId>-<toolName>` to avoid collisions with builtin tools. This means an LLM calling a GitHub MCP tool uses names like `mcp-github-create_pull_request` instead of the `gh pr create` it already knows.

### Risk Classification

MCP tools use `inferMcpToolRisk()` — a heuristic function that guesses risk from tool name and description keywords:

```typescript
// Heuristic: scan name + description for keywords
const combined = `${tool.name} ${tool.description ?? ''} ${fields}`.toLowerCase();

if (/* matches send/post/publish + create/write */) return 'external_post';
if (/* matches create/write/update/delete */)       return 'mutating';
if (/* matches read/get/list/search */)              return 'read_only';
return 'network'; // default guess
```

This works but is inherently imprecise. A tool named `get_user_settings` is classified `read_only`, but `update_user_settings` might be classified `mutating` or might not, depending on how the MCP server describes it. CLI-native tools use explicit classification per operation.

### Guardian Integration

MCP tools pass through the same Guardian pipeline as builtin tools:
1. Category enable/disable gating
2. Sandbox allowlist
3. Argument validation
4. Policy decision (allow/deny/require_approval)
5. Guardian Agent LLM evaluation (if configured)
6. Output scanning (secrets, PII, prompt injection)

This is good — and CLI-native tools use the exact same pipeline, with the added benefit of explicit (not heuristic) risk classification.

### When MCP is Still Appropriate

MCP solves one real problem: **AI without shell access.**

- Chat UIs (web, mobile) where the model has no terminal
- Enterprise sandboxes with locked-down execution environments
- Proprietary protocol servers with no CLI equivalent
- Third-party tool providers that only ship MCP servers

For the 86% of deployments running locally with terminal access, MCP wraps CLIs in JSON-RPC for no benefit.

---

## 3. Proposal: CLI-Native Tool Adapters

### 3.1 Design Principle

> If a tool has a CLI on PATH, wrap it as a direct subprocess — not as an MCP server.

The GWSService pattern is the template:
- **Service class** in `src/runtime/` — handles subprocess execution, argument building, output parsing
- **Two tools** in `src/tools/executor.ts` — one for execution, one for schema/help discovery
- **Explicit risk classification** — per-operation, not heuristic
- **Custom approval logic** — service-specific policy in `decide*Tool()` method
- **Deferred loading** — zero tokens until discovered via `find_tools`

### 3.2 Shared CLI Utilities

Extract reusable subprocess execution from `GWSService` into `src/runtime/cli-service-base.ts`:

```
execCLI(command, args, options) → { success, data?, error?, rawOutput? }
```

- Platform-aware: `execFile` (Linux/macOS) vs `exec` with shell quoting (Windows)
- JSON parse attempt on stdout, raw text fallback
- Structured error extraction from stderr
- Configurable timeout and max output buffer
- `buildShellCommand()` and `shellQuote()` moved here from `gws-service.ts`

This is ~80 lines of utility code. GWSService refactored to use it internally.

### 3.3 GitHub CLI Integration (First Adapter)

**Why GitHub first:**
- `gh` CLI is mature, well-documented, supports `--json` structured output
- PR/issue/CI workflows are the most common MCP use case
- LLMs know `gh` from training data — zero learning curve
- Auth handled entirely by `gh auth` — no token storage in GuardianAgent
- Strongest contrast to MCP: GitHub's MCP server has 93 tools / ~55K tokens; CLI-native needs 2 deferred tools / 0 upfront tokens

**Service:** `src/runtime/github-cli-service.ts` (~250 lines)

```
GitHubCLIService
  ├── execute(subcommand, action, args) → CLIExecResult
  ├── authStatus() → CLIExecResult
  └── classifyGhRisk(subcommand, action) → ToolRisk
```

**Argument mapping:** JSON object → CLI flags
- `{ state: 'open', limit: 10 }` → `--state open --limit 10`
- `{ draft: true }` → `--draft` (boolean flag)
- `{ labels: ['bug', 'p1'] }` → `--label bug --label p1`
- Always prefer `--json` for structured output where supported

**Registered tools:**

| Tool | Risk | Purpose | Token Cost |
|------|------|---------|------------|
| `gh` | Per-operation | Execute GitHub CLI operations | ~200 tokens (deferred, via find_tools) |
| `gh_schema` | read_only | Run `gh <sub> [action] --help` for option discovery | ~200 tokens (deferred) |

Compare: GitHub MCP server = 93 tools, ~55,000 tokens loaded eagerly or ~2,000 per find_tools match.

**Explicit risk classification:**

| Operation | Risk | Approval |
|-----------|------|----------|
| `pr list`, `pr view`, `pr diff`, `issue list`, `run list` | `read_only` | Auto-allow |
| `issue create`, `pr create`, `pr comment`, `pr review` | `external_post` | Require approval (unless autonomous) |
| `pr merge` | `external_post` | Always require approval |
| `run rerun`, `run cancel` | `mutating` | Require approval (unless autonomous) |

This is explicit — not inferred from keyword scanning.

### 3.4 Token Cost Comparison

**Scenario: Agent needs to list open PRs and create an issue**

| Approach | Setup Tokens | Discovery Tokens | Call Tokens | Total |
|----------|-------------|-----------------|-------------|-------|
| GitHub MCP (eager) | ~55,000 | 0 | ~300 | ~55,300 |
| GitHub MCP (deferred) | 0 | ~2,000 per search | ~300 | ~4,300 |
| CLI-native `gh` | 0 | ~200 (find_tools) | ~200 | ~400 |
| `shell_safe` + `gh` | 0 | 0 (always loaded) | ~150 | ~150 |

CLI-native is 100-350x more token-efficient than eager MCP, and 10x more efficient than deferred MCP.

### 3.5 Future Adapters

The same pattern extends to any CLI:

| CLI | Existing Coverage | CLI-Native Adapter Value |
|-----|------------------|------------------------|
| `gh` | `shell_safe` (basic) | Full structured access, per-op approval, JSON output |
| `docker` | `shell_safe` (basic) | Container lifecycle management, risk-aware (run vs inspect) |
| `kubectl` | `shell_safe` (basic) | Cluster operations, namespace-scoped approval |
| `git` | `shell_safe` (read-only bypass) | Already well-served by shell_safe + read-only optimization |
| `npm`/`bun` | `shell_safe` (basic) | Package operations, install approval |

Each adapter is ~250 lines following the established pattern. No new architecture needed.

---

## 4. MCP Positioning

### Keep MCP — But Deprioritize

**No MCP code removed.** The existing MCP client is well-built and serves real use cases:

- Proprietary protocol servers with no CLI equivalent
- Sandboxed/containerized environments without shell access
- Third-party MCP servers users have already invested in
- Chat-only interfaces (web, mobile) where the agent has no terminal

### Guidance Change

When a user configures a tool that has a CLI equivalent, the documentation and config UI should recommend the CLI-native adapter:

> **Recommended:** Enable `assistant.tools.github` for GitHub operations via the `gh` CLI.
> **Alternative:** Configure an MCP server if `gh` is not available or you need MCP-specific features.

### Config Coexistence

Both can be enabled simultaneously. If `gh` builtin tool and an MCP GitHub server are both available, the builtin tool takes precedence (same pattern as how `gws` builtin coexists with the MCP managed provider config namespace).

---

## 5. Security Comparison

| Dimension | MCP Server | CLI-Native Adapter |
|-----------|------------|-------------------|
| **Risk classification** | Heuristic (keyword scan of name + description) | Explicit (per-operation lookup table) |
| **Attack surface** | JSON-RPC transport + server code + tool implementations | CLI binary only (same as terminal usage) |
| **Auth** | Varies per server (tokens, env vars, embedded) | Delegates to CLI auth (`gh auth`, `gcloud auth`, etc.) |
| **Process isolation** | Persistent subprocess with network access | Per-call subprocess (no persistent state) |
| **Approval granularity** | Risk-level based (read_only vs mutating) | Operation-specific (e.g., "pr merge" always requires approval) |
| **Output scanning** | Same Guardian pipeline | Same Guardian pipeline |
| **Command injection** | Possible via MCP server code | Blocked by `execFile` (no shell interpretation) + argument sanitizer |

CLI-native adapters have a strictly smaller attack surface and more precise security controls.

---

## 6. Implementation Estimate

| Component | Files | Effort |
|-----------|-------|--------|
| Shared CLI utilities | 2 new (service + test) | Small — extract from existing GWSService |
| GitHub CLI service | 2 new (service + test) | Medium — follows GWSService pattern exactly |
| Tool registration | 1 modified (executor.ts) | Small — ~150 lines following gws pattern |
| Type updates | 1 modified (types.ts) | Trivial — add category |
| Config types + defaults | 1 modified (config/types.ts) | Small — ~15 lines |
| Bootstrap wiring | 1 modified (index.ts) | Small — ~20 lines following gws pattern |
| System prompt | 1 modified (guardian-core.ts) | Trivial — one paragraph |
| Policy rules | 1 new (policies/base/github.json) | Small — 2-3 rules |
| Web UI config panel | 1 modified (config.js) | Small — follows gws panel pattern |
| Documentation | 1 modified (CLAUDE.md) | Trivial |

**Total:** ~5 new files, ~5 modified files, following established patterns throughout.

---

## 7. Open Questions

1. **Should `gh` be always-loaded or deferred?** Currently proposed as deferred (discovered via `find_tools`). Could argue for always-loaded given how common GitHub workflows are. Deferred is more consistent with the optimization strategy.

2. **`shell_safe` overlap:** Users can already run `gh pr list` via `shell_safe`. The dedicated `gh` tool adds structured JSON output, per-operation approval, and schema discovery. Should `shell_safe` block `gh` commands when the dedicated tool is available, or allow both paths?

3. **Scope of first implementation:** Start with GitHub only, or also include Docker/kubectl stubs? Recommendation: GitHub first, prove the pattern, then extend.

4. **MCP deprecation timeline:** Should there be a formal deprecation path for MCP servers that have CLI equivalents, or just documentation guidance? Recommendation: guidance only — no forced migration.
