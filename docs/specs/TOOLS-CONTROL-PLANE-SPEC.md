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
- **System**: `tool_search` (meta-tool for discovering deferred tools)
- Filesystem/document: `fs_list`, `fs_search`, `fs_read`, `fs_write`, `fs_mkdir`, `fs_delete`, `fs_move`, `fs_copy`, `doc_create`
- Shell/browser: `shell_safe`, `chrome_job`, `browser_open`, `browser_action`, `browser_snapshot`, `browser_close`, `browser_task`
- Web: `web_search`, `web_fetch`
- Campaign/email: `contacts_discover_browser`, `contacts_import_csv`, `contacts_list`, `campaign_create`, `campaign_list`, `campaign_add_contacts`, `campaign_dry_run`, `gmail_send`, `campaign_run`
- Google Workspace: `gws`, `gws_schema`
- Threat intel: `intel_summary`, `intel_watch_add`, `intel_watch_remove`, `intel_scan`, `intel_findings`, `intel_draft_action`
- External interaction: `forum_post` (restricted by policy)
- Network: `net_ping`, `net_arp_scan`, `net_port_check`, `net_interfaces`, `net_connections`, `net_dns_lookup`, `net_traceroute`, `net_oui_lookup`, `net_classify`, `net_banner_grab`, `net_fingerprint`, `net_wifi_scan`, `net_wifi_clients`, `net_connection_profiles`, `net_baseline`, `net_anomaly_check`, `net_threat_summary`, `net_traffic_baseline`, `net_threat_check`
- System: `sys_info`, `sys_resources`, `sys_processes`, `sys_services`
- Memory: `memory_search`, `memory_get`, `memory_save`
- Search: `qmd_search`, `qmd_status`, `qmd_reindex`
- Automation: `workflow_list`, `workflow_upsert`, `workflow_delete`, `workflow_run`, `task_list`, `task_create`, `task_update`, `task_delete`
- Policy: `update_tool_policy`

## Deferred Tool Loading

By default, only 5 tools are sent to the LLM on every request (**always-loaded**):
`tool_search`, `web_search`, `fs_read`, `shell_safe`, `memory_search`

All other tools have `deferLoading: true` and are only discovered via `tool_search`. When the LLM calls `tool_search`, matching tool definitions (including full parameter schemas) are merged into the active tool set for subsequent rounds.

This reduces tool definition tokens from ~15-25K to ~3K per request.

**Configuration:**
```yaml
assistant:
  tools:
    deferredLoading:
      enabled: true
      alwaysLoaded: [tool_search, web_search, fs_read, shell_safe, memory_search]
```

## Tool Definition Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique tool identifier |
| `description` | string | Full description (used in tool_search results) |
| `shortDescription` | string? | Compact description for LLM context (~60% fewer tokens) |
| `risk` | ToolRisk | `read_only`, `mutating`, `network`, `external_post` |
| `parameters` | object | JSON Schema for tool arguments |
| `category` | ToolCategory? | Category for enable/disable gating |
| `deferLoading` | boolean? | When true, tool is only loaded via tool_search |
| `examples` | Array? | Usage examples: `{ input: Record, description: string }` |

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

## Approval Workflow
- Tool run can return:
  - `succeeded`
  - `failed`
  - `pending_approval` with `approvalId`
- Pending approvals are listed in web/CLI and require explicit approve/deny decisions.
- Decision history is attached to job records for auditability.

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
