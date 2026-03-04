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

## Tool Catalog (Initial)
- Filesystem/document: `fs_list`, `fs_search`, `fs_read`, `fs_write`, `doc_create`
- Shell/browser: `shell_safe`, `chrome_job`
- Campaign/email: `contacts_discover_browser`, `contacts_import_csv`, `contacts_list`, `campaign_create`, `campaign_list`, `campaign_add_contacts`, `campaign_dry_run`, `gmail_send`, `campaign_run`
- Threat intel: `intel_summary`, `intel_watch_add`, `intel_watch_remove`, `intel_scan`, `intel_findings`, `intel_draft_action`
- External interaction: `forum_post` (restricted by policy)
- Search: `qmd_search` (hybrid BM25 + vector + LLM re-rank), `qmd_status` (install/collection info), `qmd_reindex` (trigger embedding reindex)
  - Category: `search` — disabled via `disabledCategories` like any other
  - `qmd_search` and `qmd_status` are `read_only`; `qmd_reindex` is `mutating`
  - All pass through Guardian admission checks

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
