# Tools Control Plane Spec

## Goal
Expose a safe, auditable tool-execution plane so the assistant can perform workstation tasks with Guardian policy enforcement.

## Scope
- Runtime modules:
  - `src/tools/registry.ts`
  - `src/tools/approvals.ts`
  - `src/tools/executor.ts`
- Dashboard API endpoints:
  - `GET /api/tools`
  - `POST /api/tools/run`
  - `POST /api/tools/policy`
  - `POST /api/tools/approvals/decision`
- Web Configuration > Tools tab (`#/config`) and CLI `/tools` command set
- LLM tool-calling integration through chat/orchestrator path

## Tool Catalog
- **System**: `find_tools` (meta-tool for discovering deferred tools)
- Filesystem/document: `fs_list`, `fs_search`, `fs_read`, `fs_write`, `fs_mkdir`, `fs_delete`, `fs_move`, `fs_copy`, `doc_create`
- Shell/browser: `shell_safe`, `chrome_job`, plus MCP-discovered browser tools (`mcp-playwright-*`, `mcp-lightpanda-*`)
- Web: `web_search`, `web_fetch`
- Campaign/email: `contacts_discover_browser`, `contacts_import_csv`, `contacts_list`, `campaign_create`, `campaign_list`, `campaign_add_contacts`, `campaign_dry_run`, `gmail_send`, `campaign_run`
- Google Workspace: `gws`, `gws_schema` (native googleapis SDK by default, gws CLI fallback)
- Threat intel: `intel_summary`, `intel_watch_add`, `intel_watch_remove`, `intel_scan`, `intel_findings`, `intel_draft_action`
- External interaction: `forum_post` (restricted by policy)
- Network: `net_ping`, `net_arp_scan`, `net_port_check`, `net_interfaces`, `net_connections`, `net_dns_lookup`, `net_traceroute`, `net_oui_lookup`, `net_classify`, `net_banner_grab`, `net_fingerprint`, `net_wifi_scan`, `net_wifi_clients`, `net_connection_profiles`, `net_baseline`, `net_anomaly_check`, `net_threat_summary`, `net_traffic_baseline`, `net_threat_check`
- System: `sys_info`, `sys_resources`, `sys_processes`, `sys_services`
- Memory: `memory_search`, `memory_recall`, `memory_save`, `memory_bridge_search`
- Search: `doc_search`, `doc_search_status`, `doc_search_reindex`
- Automation: `workflow_list`, `workflow_upsert`, `workflow_delete`, `workflow_run`, `task_list`, `task_create`, `task_update`, `task_delete` — managed via web Automations page (`#/automations`) or chat through the automation authoring compiler
- Policy: `update_tool_policy`

## Deferred Tool Loading

Memory scope note:

- outside Code, `memory_recall` and `memory_save` target the current agent's global memory
- inside a backend Code session, those same tools target Code-session memory keyed by `codeSessionId`
- `memory_bridge_search` is the explicit read-only cross-scope lookup path and does not switch the current context

By default, 11 tools are sent to the LLM on every request (**always-loaded**) when agent policy updates are enabled:
`find_tools`, `update_tool_policy`, `web_search`, `fs_read`, `fs_list`, `fs_search`, `shell_safe`, `memory_search`, `memory_save`, `sys_info`, `sys_resources`

If `assistant.tools.agentPolicyUpdates` is disabled, `update_tool_policy` is not registered and the always-loaded set drops back to 10 tools.

All other tools have `deferLoading: true` and are only discovered via `find_tools`. When the LLM calls `find_tools`, matching tool definitions (including full parameter schemas) are merged into the active tool set for subsequent rounds.

This reduces tool definition tokens from ~15-25K to ~5K per request.

**Local model adaptation:** When the active LLM provider is local (Ollama), always-loaded tools are sent with full `description` instead of `shortDescription` to improve tool selection accuracy. External providers (OpenAI, Anthropic) continue using short descriptions to save tokens.

**Quality-based fallback:** When the local LLM produces a degraded response (empty, refusal, or "I could not generate"), the system automatically retries the request through the fallback chain (typically an external provider like OpenAI). A fallback chain is auto-configured when multiple LLM providers are available, or can be explicitly set via `config.fallbacks`.

**Per-tool provider routing:** Users can route specific tools or entire tool categories to a preferred LLM provider (`local` or `external`). This controls which model *synthesizes the tool result* — the model that processes the output and generates the user-facing response after a tool executes. The routing decision happens per-round in the tool loop:

1. Tool(s) execute and results are appended to the message history
2. `resolveToolProviderRouting()` checks the routing map against executed tool names/categories
3. If a routing preference is found, `chatFn` is swapped to the preferred provider for the next LLM call
4. Tool definitions are re-mapped for the new provider's locality (full descriptions for local, short for external)

Resolution order: tool-name match > category match > smart category default > default provider. When multiple tools execute in one round with conflicting preferences, `external` wins (higher-quality synthesis).

If the routed provider is unavailable (e.g., no external provider configured), the routing is silently skipped and the default provider is used. The routed provider also falls back to the default chain on error.

**Smart category defaults:** When both local and external providers are configured and `providerRoutingEnabled` is `true` (the default), tools are automatically routed based on their category's natural locality:
- **Local categories** (filesystem, shell, network, system, memory) route to the local model — these are fast, low-complexity operations where local LLMs perform well.
- **External categories** (web, browser, workspace, email, contacts, forum, intel, search, automation) route to the external model — these involve richer content or structured multi-step arguments that benefit from stronger reasoning.
- When only one provider type exists (e.g., only Ollama or only Anthropic), smart routing is a no-op and everything uses that provider.
- Explicit `providerRouting` entries always override smart defaults.

**`providerRoutingEnabled` toggle:** Master switch for smart LLM routing (`assistant.tools.providerRoutingEnabled`, default: `true`). When disabled, all tools use the default provider regardless of category. Exposed in the web UI (Configuration > Tools tab) as a "Smart LLM Routing" checkbox with tooltip.

**Configuration:**
```yaml
assistant:
  tools:
    deferredLoading:
      enabled: true
      alwaysLoaded: [find_tools, update_tool_policy, web_search, fs_read, fs_list, fs_search, shell_safe, memory_search, memory_save, sys_info, sys_resources]
    providerRoutingEnabled: true    # enable smart category defaults (default: true)
    providerRouting:
      # Per-category: all tools in this category use external LLM for result synthesis
      workspace: external
      filesystem: external
      # Per-tool: overrides category default
      fs_list: local        # reads are fine on local
      # Omitted tools/categories use smart defaults (if enabled) or the default provider
```

**Web UI:** Configuration > Tools tab shows an "LLM" column on both the Tool Categories and Tool Catalog tables. Each row has a Local/External dropdown. Changing a category dropdown cascades to all tools in that category. A "Smart LLM Routing" checkbox toggles `providerRoutingEnabled`. Changes are saved immediately via `POST /api/tools/provider-routing` and persisted to the user's config YAML. The Providers tab includes a "Set as Default" button per provider row.

**API:**
- `POST /api/tools/provider-routing` with body `{ routing?: { "tool_or_category": "local" | "external" }, enabled?: boolean }`. The `enabled` field controls `providerRoutingEnabled`. The routing map is also returned in `GET /api/tools` as `providerRouting`. Only entries that differ from the default provider locality are persisted.
- `POST /api/providers/default` with body `{ name: string }` — sets the default LLM provider.

## Tool Definition Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique tool identifier |
| `description` | string | Full description (used in find_tools results) |
| `shortDescription` | string? | Compact description for LLM context (~60% fewer tokens) |
| `risk` | ToolRisk | `read_only`, `mutating`, `network`, `external_post` |
| `parameters` | object | JSON Schema for tool arguments |
| `category` | ToolCategory? | Category for enable/disable gating |
| `deferLoading` | boolean? | When true, tool is only loaded via find_tools |
| `examples` | Array? | Usage examples: `{ input: Record, description: string }` |

## Conversational Automation Creation

Conversational automation creation is no longer treated as a pure prompt-following problem.

Guardian now uses a native automation authoring compiler before the generic tool-calling loop:

```text
user request
  -> compiler detects automation intent
  -> extracts schedule + hard constraints
  -> chooses workflow vs scheduled agent task
  -> executes workflow_upsert / task_create / task_update through ToolExecutor
```

Compiler rules:
1. **Native automation first**: requests for Guardian workflows, automations, or scheduled tasks resolve to automation tools, not to `fs_write`, `code_create`, or `shell_safe`, unless the user explicitly asked for code.
2. **Open-ended work defaults to `task_create(type="agent")`**: inbox review, research, triage, recurring reports, and similar runtime-adaptive tasks compile into scheduled assistant turns.
3. **Deterministic graphs use `workflow_upsert`**: only fixed built-in tool graphs compile into workflows.
4. **Task duplication is avoided**: scheduled agent tasks check `task_list` first so clear re-creates become updates rather than duplicates.
5. **Creation stays inside the control plane**: approvals, verification, audit, principal binding, and bounded schedule authority still run through `ToolExecutor`.

The automation tools remain available to the LLM, but they are no longer the only authoring path. The compiler is the authoritative path for clear conversational automation requests.

### Web UI Parity

The web Automations page (`#/automations`) provides the same create/run/clone/delete/schedule capabilities. Old `#/workflows` and `#/operations` routes redirect to `#/automations`.
For operator-facing copy, the UI uses `Tool Access` and `Built-in tools` language instead of exposing `connector pack` terminology for default steps.

## Parallel Tool Execution

When the LLM returns multiple tool calls in a single response, they are executed concurrently via `Promise.allSettled()`. Results are pushed in original order. If any call fails, an error result is returned for that specific tool call.

## Context Window Awareness

A configurable `contextBudget` (default: 80,000 tokens) tracks approximate context usage. When tool result messages exceed 80% of the budget, oldest tool results are summarized to ~200 chars each to prevent context overflow.

```yaml
assistant:
  tools:
    contextBudget: 80000
```

## Policy Model
- Global mode:
  - `approve_each`: every tool run needs manual approval
  - `approve_by_policy`: apply tool policy first, request approval when needed
  - `autonomous`: run automatically unless explicitly denied
- Per-tool overrides:
  - `auto`, `policy`, `manual`, `deny`

Contextual additions now enforced at runtime:
- `principalId` / `principalRole`
- `contentTrustLevel`
- `taintReasons`
- `derivedFromTaintedContent`
- `scheduleId`

These inputs are consumed by `ToolExecutor` to block quarantined-context mutation, approval-gate tainted mutation, and bind approvals to the originating principal.

Current main-assistant defaults:
- shipped config defaults to `approve_each` (`approval_policy: on-request`)
- the main shell allowlist is intentionally read-oriented: `git status`, `git diff`, `git log`, `ls`, `dir`, `pwd`, `echo`, `cat`, `head`, `tail`, `whoami`, `hostname`, `uname`, `date`
- broad package-manager / interpreter prefixes such as bare `node`, `npm`, and `npx` are excluded from the main default allowlist
- Coding Assistant code sessions are a separate surface and use their own repo-scoped command allowlist

## Workspace Dependency Awareness

For workspace-local JS package mutations executed through `shell_safe`, the runtime keeps a repo-scoped dependency ledger instead of writing ad hoc package state into global memory.

- supported commands are detected from parsed shell commands (`npm`, `pnpm`, `yarn`, `bun`) for local add/install/remove flows
- global installs (`-g`, `--global`, `--location=global`) are ignored by this ledger path
- before/after snapshots diff the nearest workspace `package.json` and common lockfiles
- diffs are persisted to `.guardianagent/dependency-awareness.json` under the workspace root
- active entries are injected into tool context for later turns in that same workspace so the model can treat recently added packages as available only while they remain in the manifests
- this awareness is workspace-scoped and durable on disk; it is not stored in the agent's global memory store

## Approval Workflow
- Tool run can return:
  - `succeeded`
  - `failed`
  - `pending_approval` with `approvalId`
- approvals now carry requesting principal/role metadata and reject decisions from unauthorized principals or roles
- **Suspended Execution (Continuation Interception)**:
  - When an LLM tool call requires approval, `ChatAgent` suspends the internal tool loop by caching the entire message context (`suspendedSessions`) and returning a `pending_approval` state to the client.
  - The UI prompts the user and hits the `/api/tools/approvals/decision` REST endpoint.
  - The UI then sends a "continuation message" back to the agent.
  - `ChatAgent` detects the continuation message, restores the suspended `llmMessages` context, fetches the actual tool execution result from `ToolExecutor`, and injects it as the `tool` role response. This prevents the LLM from losing context and retrying identical calls.
- **Immediate Execution on Approval**:
  - When a user approves an action via the REST API or UI, `ToolExecutor.decideApproval` executes the tool handler immediately in the backend, rather than waiting for the LLM to reissue the command.
- **Retry Caching (Loop Prevention)**:
  - If the LLM generates a duplicate tool call for an action that was approved and executed within the last 5 minutes (matching `toolName` and `argsHash`), `ToolExecutor` bypasses the policy check and instantly returns the cached execution result (success or error) instead of requesting a new approval.
- **Runaway/Overspend Guards**:
  - `ToolExecutor` caps total calls and non-read-only calls per execution chain (`requestId` / `scheduleId`).
  - Repeated identical failed calls are blocked after a small number of attempts.
  - These guards exist to stop broken tools or broken planner loops from overspending before higher-level budgets are exhausted.
- **Non-blocking**: pending approvals do not block new messages. The LLM receives a context note about pending approvals but continues processing normally.
- **Dedup**: identical pending approvals (same `toolName` + `argsHash`) are deduplicated in `ToolApprovalStore.create()`.
- Decision history is attached to job records for auditability.

### Verification Status

Tool results and job records can also carry:
- `verificationStatus`: `verified` | `unverified` | `failed`
- `verificationEvidence`

This is used for operations such as `memory_save`, `task_create`, and `task_update` so the runtime can distinguish "reported success" from "state confirmed."

### Direct Tool API

`POST /api/tools/run` now accepts contextual execution inputs in addition to normal tool arguments:
- `principalId`
- `principalRole`
- `contentTrustLevel`
- `taintReasons`
- `derivedFromTaintedContent`
- `scheduleId`

This keeps direct API execution aligned with the brokered and planner-driven execution paths and allows black-box security harnesses to validate contextual gating behavior.

### Structured Approval UX (all channels)

When a tool returns `pending_approval`, the response includes structured metadata (`response.metadata.pendingApprovals`) with an array of `{ id, toolName, argsPreview }` objects. Channels use that metadata as the canonical approval source instead of trusting model-written approval prose.

#### Shared chat-flow rules

- Approval copy is normalized from structured metadata when the model emits weak placeholder text.
- Normalized copy must stay action-focused and must not leak internal planning/schema chatter such as:
  - `tool is unavailable`
  - `tool is available`
  - `action and value`
  - raw `Approval ID: ...` helper text in normal chat flows
- Chained approvals are supported. Common example:
  1. `Waiting for approval to add S:\Development to allowed paths.`
  2. user approves
  3. `Waiting for approval to write S:\Development\test26.txt.`
  4. user approves
  5. final completion message
- The approval decision executes immediately in `ToolExecutor.decideApproval`; the continuation message is only for getting the LLM to finish the original task cleanly.

#### Channel-specific behavior

- **Web UI**
  - Renders native Approve / Deny buttons in the chat panel.
  - Button clicks call `api.decideToolApproval()` directly.
  - The web channel then sends a continuation message so the LLM finishes the suspended task.
  - Web should not expose model-written approval chatter when structured metadata is present.
  - Web remains the reference UX for approval wording.

- **Telegram**
  - Sends the approval prompt as a separate message with inline keyboard buttons (✅ Approve / ❌ Deny).
  - Plain-text approvals such as `approved` / `yes approved` are also supported as a fallback for the current pending approval state.
  - Telegram ignores model-written manual approval prose when `pendingApprovals` metadata exists and always renders channel-owned copy instead.
  - Approval status lines are normalized to user-facing text such as `Approved and executed`; raw backend strings like `Tool 'fs_write' completed.` should not leak.

- **CLI**
  - Shows the approval prompt inline:
    - `Approve (y) / Deny (n):`
  - The CLI should not show legacy chat-style helper text such as:
    - `Reply "yes" to approve or "no" to deny`
    - `Approval ID: ...`
  - On approval, the CLI auto-dispatches a continuation message and handles chained approvals inline.
  - If an inline prompt references a stale approval ID, the CLI refreshes the current scoped pending approvals and re-prompts instead of surfacing raw `Approval '<id>' not found.` text.
  - If a bare `y/yes/no/deny` leaks through the normal readline message path while an inline approval is active, CLI intercepts it locally and routes it through the pending inline approval flow instead of sending it as a normal chat message.

#### Fallback approval commands

- CLI and Telegram still support explicit fallback commands:
  - `/approve <id>`
  - `/deny <id> [reason]`
- These commands are control-plane fallbacks, not the primary chat approval UX.

#### Examples

- `Waiting for approval to add S:\Development to allowed paths.`
- `Waiting for approval to write S:\Development\test26.txt.`
- CLI status lines:
  - `✓ update_tool_policy: Approved and executed`
  - `✓ fs_write: Approved and executed`

### Read-Only Shell Bypass
Under `approve_by_policy`, `shell_safe` commands that are purely read-only skip approval automatically. Recognized read-only commands: `ls`, `dir`, `pwd`, `whoami`, `hostname`, `uname`, `date`, `echo`, `cat`, `head`, `tail`, `wc`, `file`, `which`, `type`, plus prefixed commands like `git status`, `git diff`, `git log`, `git branch`, `node --version`, `npm --version`, `npm ls`.

This bypass is narrower than the Coding Assistant command surface. For the main assistant, the shipped default `allowedCommands` list stays read-oriented and does not include bare `node`, `npm`, or `npx`.

## Sandbox Boundaries
- Policy-managed allowlists:
  - `allowedPaths`
  - `allowedCommands`
  - `allowedDomains`
- Tool handlers must reject requests outside configured allowlists.
- High-risk external posting is disabled by default unless explicitly allowed.
- Path compatibility:
  - `allowedPaths` and tool path args accept both native and Windows/WSL formats.
  - Examples: `C:\Users\kenle\OneDrive\Technical and GRC` and `/mnt/c/Users/kenle/OneDrive/Technical and GRC`.

## Dry-Run Mode
- Tools support a `dryRun` flag on execution requests.
- When `dryRun: true` and the tool has a mutating risk level (`!= 'read_only'`), the executor:
  1. Runs all validation (Guardian checks, path allowlists, policy approval)
  2. Returns a preview result instead of executing the side effect
  3. Sets `dryRun: true` and `preview: string` on the result
- Read-only tools execute normally regardless of the flag.
- Tool-specific preview messages describe what would happen:
  - `fs_write` / `doc_create` → "Would write to <path>"
  - `run_command` / `shell_safe` → "Would execute: <command>"
  - `http_fetch` → "Would fetch: <url>"
  - `forum_post` → "Would post to forum"
  - `intel_action` → "Would execute threat intel action"
- Configuration: `assistant.tools.dryRunDefault` sets the default dry-run state.
- Web Tools page includes a "Dry Run" toggle checkbox.

## Security + Audit
- Tool execution checks route through Guardian action checks when available.
- All runs/approvals/denials are recorded in tool job history.
- External forum interactions (for example Moltbook) are treated as untrusted/hostile surfaces and remain policy-gated.
- Native skills are advisory only and must not create a bypass around ToolExecutor.
- Managed MCP providers still register tools through the same executor and policy model.
- Strict sandbox mode disables risky subprocess-backed tools when no strong sandbox backend is available and surfaces explicit disable reasons.
- Tool arguments must stay under the executor byte budget; oversized payloads fail before approval/execution.
- `shell_safe` rejects shell control operators and command substitution even when the command prefix is allowlisted.
- `shell_safe` also rejects blocked indirect-exec classes such as interpreter-inline eval (`python -c`, `node --eval`), package launchers (`npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `uv run`), and explicit shell-expression launchers (`bash -c`, `sh -c`).
- For simple single-command direct binaries, `shell_safe` now prefers structured direct exec (`entryCommand` + `argv`) instead of always routing through shell parsing.
- Shell fallback remains in place for shell-builtins, chained commands, redirects, and platform wrapper cases, so the top-level command boundary is stronger but not equivalent to descendant process enforcement.
- `fs_write` / `doc_create` content is scanned for secrets and PII before anything is persisted.

## Tool Result Scanning
- Tool results are scanned before they are reinjected into LLM context.
- Reinjected tool results are wrapped in structured `<tool_result ...>` envelopes with trust/source metadata.
- Tool-result strings are stripped of invisible Unicode, checked for prompt-injection signals, and redacted for secrets + configured PII entities.

## MCP Trust & Rate Limits
- MCP server tool risk can be inferred from MCP metadata, then overridden per server with `trustLevel` when operators need stricter or looser policy treatment.
- MCP servers can set `maxCallsPerMinute` to constrain noisy or high-cost external integrations at the client boundary.

## UX Requirements
- Web Tools tab includes:
  - catalog
  - run panel
  - policy editor
  - pending approvals
  - job history
- CLI includes:
  - `/tools list`
  - `/tools run <tool> [jsonArgs]`
  - `/tools approvals`
  - `/tools approve <id>`
  - `/tools deny <id> [reason]`
  - `/tools jobs`
  - `/tools policy mode <...>`
