# Test Run: Functional Baseline

- **Date:** 2026-03-08
- **Script:** `scripts/test-harness.ps1` (17 functional tests, pre-security suite)
- **Platform:** Windows + WSL2, PowerShell 7.5.4
- **LLM:** Ollama llama3.2 (local)
- **Result:** 17 PASS / 0 FAIL / 0 SKIP

## Output

```
[harness] Killing 3 existing GuardianAgent process(es)...
[harness] Starting GuardianAgent with token: <redacted-harness-token>
[harness] App PID: 24040, waiting for /health...
[harness] App is healthy after 1s
[harness] Ready with auth token: <redacted-harness-token>

[harness] === Health & Auth ===
  PASS GET /health returns valid JSON
  PASS Unauthenticated request returns 401
  PASS Authenticated GET /api/status succeeds

[harness] === Stream A: Deferred Tool Loading ===
  PASS tool_search: valid response
  PASS tool_search: mentions network tools

[harness] === Stream A: Parallel Execution ===
  PASS parallel: valid response
  PASS parallel: response returned (check logs for concurrent execution)

[harness] === Stream B: PII Scanning ===
  PASS PII write: valid response
  PASS PII write: file not created (blocked by Guardian)

[harness] === Stream B: Shell Injection Defense ===
  PASS shell inject: valid response
  PASS shell inject: control operator blocked

[harness] === Stream B: Output Guardian ===
  PASS output guardian: valid response
  PASS output guardian: responded to sensitive file request

[harness] === Basic Conversation ===
  PASS greeting: valid response
  PASS greeting: non-empty content
  PASS math: valid response
  PASS math: correct answer

============================================
  PASS: 17  FAIL: 0  SKIP: 0  Total: 17
============================================

[harness] Full app log: %LOCALAPPDATA%\\Temp\\guardian-harness.log
[harness] Stopping app (PID 24040)...
```

## Notes

- First clean run after fixing rate-limit delays and stray boolean output
- PII write blocked entirely by Guardian (file never created)
- Shell injection `&&` operator rejected
- All LLM-dependent tests passed on first attempt with llama3.2
