# Test Run: Tool Exercise Baseline (Pre-Fix)

- **Date:** 2026-03-08
- **Script:** `scripts/test-tools.ps1` (84 tests)
- **Platform:** Windows + WSL2, PowerShell
- **LLM:** Ollama gpt-oss:latest (local), OpenAI gpt-4o (external)
- **Result:** 62 PASS / 21 FAIL / 1 SKIP
- **Context:** Baseline before tool selection & approval blocking architecture fixes

## Root Cause Analysis

The 21 failures trace to three systemic issues:

1. **Path not in allowedPaths (7 failures):** `/tmp/harness-tools-test` not in sandbox config → LLM calls `update_tool_policy` (risk: `external_post`, always requires approval) instead of fs_mkdir/fs_write/fs_copy/etc.
2. **`echo` not in allowedCommands (2 failures):** LLM sees `<tool-context>` showing `echo` is not in the allowed commands list, refuses to call `shell_safe`.
3. **LLM doesn't call `tool_search` for deferred tools (11 failures):** LLM answers from its own knowledge instead of discovering tools via `tool_search`. Affects: sys_processes, net_connections, memory_get, memory_search, web_fetch, intel_summary, intel_findings, task_list, workflow_list.
4. **Test assertion mismatch (1 failure):** Discovery test expected `tool_search` for filesystem tools, but fs_list/fs_search are now always-loaded so the LLM doesn't need to search.

## Output

```
[tools] Killing 3 existing GuardianAgent process(es)...
[tools] Starting GuardianAgent with token: <redacted-harness-token>
[tools] App PID: 34260, waiting for /health...
[tools] App is healthy after 1s
[tools] Ready with auth token: <redacted-harness-token>

[tools] LLM Provider: ollama (ollama) — model: gpt-oss:latest, locality: local
[tools] LLM Provider: openai (openai) — model: gpt-4o, locality: external
  PASS setup: autonomous policy for tool exercise

[tools] === Tool Discovery (tool_search) ===
  PASS discovery: filesystem tools
  PASS discovery: mentions file tools
  FAIL discovery: tool_search was invoked - no tool calls detected
  PASS discovery: network tools
  PASS discovery: mentions network tools
  PASS discovery: automation tools
  PASS discovery: mentions task/workflow tools

[tools] === Filesystem: Read Operations ===
  PASS fs_list: project directory
  FAIL fs_list: shows project structure - expected 'src|package\.json|README|tsconfig' in: We have listed the current project directory. There's more entries but omitted. Provide summary.**Current project directory (`S:\Development\GuardianAgent`):**

| Name | Type |
|------|------|
| `.cla...
  PASS fs_list: tool was called (called: fs_list, fs_list, fs_list)
  PASS fs_search: find test files
  PASS fs_search: found test files
  PASS fs_search: tool was called (called: fs_search)
  PASS fs_read: package.json
  PASS fs_read: shows package.json content
  PASS fs_read: tool was called (called: fs_read)

[tools] === Filesystem: Write Operations ===
  PASS fs_mkdir: create test dir
  FAIL fs_mkdir: tool was called - expected tool matching 'fs_mkdir', got: update_tool_policy, update_tool_policy, update_tool_policy
  PASS fs_write: write hello.txt
  FAIL fs_write: tool was called - expected tool matching 'fs_write|doc_create', got: tool_search, update_tool_policy, update_tool_policy
  PASS fs_read: verify written file
  FAIL fs_read: content matches what we wrote - expected 'Hello from the tool exercise' in: I prepared 2 actions that need your approval.
Approval IDs: 99addd14-a046-41c8-abb9-ac020679fb4b, c5cee297-f964-457a-bd36-c8f22e6fd637
Reply "yes" to approve all or "no" to deny all (expires in 30 min...
  PASS fs_copy: copy file
  FAIL fs_copy: tool was called - expected tool matching 'fs_copy', got: update_tool_policy, tool_search
  PASS fs_move: rename file
  FAIL fs_move: tool was called - no tool calls detected
  PASS fs_delete: delete file
  FAIL fs_delete: tool was called - expected tool matching 'fs_delete', got: tool_search, fs_list
  PASS doc_create: create markdown doc
  FAIL doc_create: tool was called - expected tool matching 'doc_create|fs_write', got: update_tool_policy, tool_search, fs_list

[tools] === Shell Tool ===
  PASS shell_safe: echo
  FAIL shell_safe: echo output returned - expected 'hello-from-tool-harness' in: I'm sorry, but I can't execute that command. The policy only allows a restricted set of commands (e.g., `node`, `npm`, `git`, `ls`, `dir`, `pwd`, etc.). If you need to echo text, you can do it manuall...
  FAIL shell_safe: tool was called - no tool calls detected
  PASS shell_safe: node --version
  PASS shell_safe: version number returned
  PASS shell_safe: git log
  PASS shell_safe: git allowed (called: shell_safe)

[tools] === System Tools ===
  PASS sys_info: system info
  PASS sys_info: tool was called (called: sys_info)
  PASS sys_resources: resource usage
  PASS sys_resources: tool was called (called: sys_resources)
  PASS sys_processes: process list
  FAIL sys_processes: tool was called - no tool calls detected

[tools] === Network Tools ===
  PASS net_interfaces: list interfaces
  PASS net_interfaces: tool was called (called: net_interfaces)
  PASS net_ping: ping loopback
  PASS net_ping: tool was called (called: net_ping, net_ping)
  PASS net_dns_lookup: resolve localhost
  PASS net_dns_lookup: tool was called (called: net_dns_lookup, net_dns_lookup, net_dns_lookup)
  PASS net_port_check: check web port
  PASS net_port_check: tool was called (called: net_port_check, net_port_check)
  PASS net_connections: active connections
  FAIL net_connections: tool was called - no tool calls detected

[tools] === Memory Tools ===
  PASS memory_save: store entry
  PASS memory_save: tool was called (called: memory_save, memory_save)
  PASS memory_get: retrieve knowledge
  FAIL memory_get: tool was called - no tool calls detected
  PASS memory_search: search memory
  FAIL memory_search: tool was called - expected tool matching 'memory_search', got: web_search

[tools] === Web Tools ===
  PASS web_fetch: fetch health endpoint
  FAIL web_fetch: health response returned - expected 'status|ok|health' in: I can't assist with that.
  FAIL web_fetch: tool was called - no tool calls detected

[tools] === Threat Intel Tools ===
  PASS intel_summary: threat summary
  FAIL intel_summary: tool was called - no tool calls detected
  PASS intel_findings: list findings
  FAIL intel_findings: tool was called - no tool calls detected

[tools] === Task & Workflow Tools ===
  PASS task_list: list tasks
  FAIL task_list: tool was called - no tool calls detected
  PASS workflow_list: list workflows
  FAIL workflow_list: tool was called - no tool calls detected

[tools] === Approval Flow ===
  PASS approval: policy set to approve_by_policy
  PASS approval: read_only auto-executes
  PASS approval: fs_list returned directory contents
  PASS approval: fs_write set to manual
  PASS approval: LLM responded to write request
  SKIP approval: pending check - LLM may not have attempted the write
  PASS approval: fs_delete set to deny
  PASS approval: deny-policy response received
  PASS approval: LLM handled denial (may not have attempted tool)

[tools] === Cleanup ===
  PASS cleanup: policy restored to defaults

[tools] === Job History Verification ===
  PASS job history: 49 tool executions recorded
  PASS job history: tools used: fs_list, fs_read, fs_search, memory_save, net_dns_lookup, net_interfaces, net_ping, net_port_check, shell_safe, sys_info, sys_resources, tool_search, update_tool_policy, web_search
  PASS job history: statuses: failed, pending_approval, succeeded

============================================
  PASS: 62  FAIL: 21  SKIP: 1  Total: 84
============================================
```

## Fixes Applied

- **Non-blocking approvals:** Removed early-return gate in `ChatAgent.onMessage()` that blocked all messages when pending approvals exist. Replaced with context note in system prompt.
- **Tool selection guidance:** Added tool selection instructions to `GUARDIAN_CORE_SYSTEM_PROMPT` directing LLM to prefer specialized tools over `shell_safe`.
- **Always-loaded tools expanded:** Promoted `fs_list`, `fs_search`, `sys_info`, `sys_resources` from deferred to always-loaded (9 total, was 5).
- **Read-only shell bypass:** `shell_safe` commands like `ls`, `pwd`, `cat`, `git status` skip approval under `approve_by_policy`.
- **Default allowedCommands expanded:** Added `echo`, `cat`, `head`, `tail`, `whoami`, `hostname`, `uname`, `date` to defaults.
- **Harness sandbox setup:** Added `/tmp/harness-tools-test` to `allowedPaths` and broadened `allowedCommands` via policy API before tool exercise.
- **Harness prompt improvements:** Explicit tool names in prompts for deferred tools; updated discovery assertion for always-loaded fs tools.
- **Harness policy mode:** Set `autonomous` before tool exercise section (approval flow tested separately).
