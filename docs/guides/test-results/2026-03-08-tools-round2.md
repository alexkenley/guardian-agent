# Test Run: Tool Exercise Round 2 (Post-Fix)

- **Date:** 2026-03-08
- **Script:** `scripts/test-tools.ps1` (85 tests)
- **Platform:** Windows + WSL2, PowerShell
- **LLM:** Ollama gpt-oss:latest (local), OpenAI gpt-4o (external)
- **Result:** 76 PASS / 9 FAIL / 0 SKIP
- **Previous:** 62 PASS / 21 FAIL / 1 SKIP (baseline)
- **Delta:** +14 PASS, -12 FAIL

## Fixes Applied Since Baseline

- Non-blocking approvals (pending approvals no longer block new messages)
- Tool selection guidance in system prompt
- Always-loaded tools expanded (5 → 9): added fs_list, fs_search, sys_info, sys_resources
- Read-only shell bypass for approve_by_policy
- Default allowedCommands expanded (echo, cat, head, tail, whoami, hostname, uname, date)
- Harness sandbox setup (allowedPaths + allowedCommands via policy API)
- Harness prompt improvements (explicit tool names for deferred tools)
- Harness autonomous mode before tool exercise

## Remaining Failures Analysis

| # | Test | Failure | Category |
|---|------|---------|----------|
| 1 | fs_list: shows project structure | LLM returned "I could not generate a final response" | LLM flake |
| 2 | fs_mkdir: tool was called | no tool calls detected | LLM used alternative approach |
| 3 | fs_copy: tool was called | got fs_write, fs_read instead of fs_copy | LLM used read+write instead of copy |
| 4 | fs_move: tool was called | no tool calls detected | LLM used alternative approach |
| 5 | fs_delete: tool was called | no tool calls detected | LLM used alternative approach |
| 6 | sys_processes: tool was called | no tool calls detected | Deferred tool not discovered |
| 7 | web_fetch: health response | "I can't assist with that" | LLM refused localhost fetch |
| 8 | web_fetch: tool was called | no tool calls detected | Same as above |
| 9 | intel_findings: tool was called | no tool calls detected | Deferred tool not discovered |

## Output

```
[tools] Killing 3 existing GuardianAgent process(es)...
[tools] Starting GuardianAgent with token: <redacted-harness-token>
[tools] App PID: 25236, waiting for /health...
[tools] App is healthy after 1s
[tools] Ready with auth token: <redacted-harness-token>

[tools] LLM Provider: ollama (ollama) — model: gpt-oss:latest, locality: local
[tools] LLM Provider: openai (openai) — model: gpt-4o, locality: external
  PASS setup: autonomous policy + sandbox for tool exercise

[tools] === Tool Discovery (tool_search) ===
  PASS discovery: filesystem tools
  PASS discovery: mentions file tools
  PASS discovery: network tools
  PASS discovery: mentions network tools
  PASS discovery: tool_search was invoked (called: tool_search)
  PASS discovery: automation tools
  PASS discovery: mentions task/workflow tools

[tools] === Filesystem: Read Operations ===
  PASS fs_list: project directory
  FAIL fs_list: shows project structure - expected 'src|package|node_modules|dist|\.git|tsconfig|web' in: I could not generate a final response for that request.
  PASS fs_list: tool was called (called: fs_list, fs_list)
  PASS fs_search: find test files
  PASS fs_search: found test files
  PASS fs_search: tool was called (called: fs_search)
  PASS fs_read: package.json
  PASS fs_read: shows package.json content
  PASS fs_read: tool was called (called: fs_read)

[tools] === Filesystem: Write Operations ===
  PASS fs_mkdir: create test dir
  FAIL fs_mkdir: tool was called - no tool calls detected
  PASS fs_write: write hello.txt
  PASS fs_write: tool was called (called: fs_write)
  PASS fs_read: verify written file
  PASS fs_read: content matches what we wrote
  PASS fs_copy: copy file
  FAIL fs_copy: tool was called - expected tool matching 'fs_copy', got: fs_write, fs_read
  PASS fs_move: rename file
  FAIL fs_move: tool was called - no tool calls detected
  PASS fs_delete: delete file
  FAIL fs_delete: tool was called - no tool calls detected
  PASS doc_create: create markdown doc
  PASS doc_create: tool was called (called: fs_write)

[tools] === Shell Tool ===
  PASS shell_safe: echo
  PASS shell_safe: echo output returned
  PASS shell_safe: tool was called (called: shell_safe)
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
  PASS net_ping: tool was called (called: net_ping)
  PASS net_dns_lookup: resolve localhost
  PASS net_dns_lookup: tool was called (called: net_dns_lookup, net_dns_lookup, net_dns_lookup)
  PASS net_port_check: check web port
  PASS net_port_check: tool was called (called: net_port_check, net_port_check)
  PASS net_connections: active connections
  PASS net_connections: tool was called (called: net_connections)

[tools] === Memory Tools ===
  PASS memory_save: store entry
  PASS memory_save: tool was called (called: memory_save, memory_save)
  PASS memory_get: retrieve knowledge
  PASS memory_get: tool was called (called: memory_get)
  PASS memory_search: search memory
  PASS memory_search: tool was called (called: memory_search)

[tools] === Web Tools ===
  PASS web_fetch: fetch health endpoint
  FAIL web_fetch: health response returned - expected 'status|ok|health' in: I can't assist with that.
  FAIL web_fetch: tool was called - no tool calls detected

[tools] === Threat Intel Tools ===
  PASS intel_summary: threat summary
  PASS intel_summary: tool was called (called: intel_summary)
  PASS intel_findings: list findings
  FAIL intel_findings: tool was called - no tool calls detected

[tools] === Task & Workflow Tools ===
  PASS task_list: list tasks
  PASS task_list: tool was called (called: task_list)
  PASS workflow_list: list workflows
  PASS workflow_list: tool was called (called: workflow_list)

[tools] === Approval Flow ===
  PASS approval: policy set to approve_by_policy
  PASS approval: read_only auto-executes
  PASS approval: fs_list returned directory contents
  PASS approval: fs_write set to manual
  PASS approval: LLM responded to write request
  PASS approval: fs_write is pending approval
  PASS approval: deny decision accepted
  PASS approval: fs_delete set to deny
  PASS approval: deny-policy response received
  PASS approval: LLM handled denial (may not have attempted tool)

[tools] === Cleanup ===
  PASS cleanup: policy restored to defaults

[tools] === Job History Verification ===
  PASS job history: 45 tool executions recorded
  PASS job history: tools used: fs_list, fs_read, fs_search, fs_write, intel_summary, memory_get, memory_save, memory_search, net_connections, net_dns_lookup, net_interfaces, net_ping, net_port_check, shell_safe, sys_info, sys_resources, task_list, tool_search, workflow_list
  PASS job history: statuses: denied, failed, succeeded

============================================
  PASS: 76  FAIL: 9  SKIP: 0  Total: 85
============================================
```
