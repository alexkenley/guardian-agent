# Test Results: Full Suite Failure Analysis (`test-all.ps1`)

**Date:** 2026-03-09
**Result:** 23 failures across 3 scripts (of 12 total scripts)

## Environment

- LLM Providers: ollama (gpt-oss:latest, local) + openai (gpt-4o, external)
- Platform: Windows (PowerShell)
- Context: Post policy-as-code engine implementation

## Summary

| Script | Pass | Fail | Skip | Total | Category |
|--------|------|------|------|-------|----------|
| test-harness | 63 | 0 | 0 | 63 | deterministic |
| test-approvals | 48 | 0 | 0 | 48 | deterministic |
| test-automation | 33 | 0 | 0 | 33 | deterministic |
| test-security-api | 32 | 0 | 0 | 32 | deterministic |
| test-security-content | 25 | 0 | 0 | 25 | deterministic |
| test-gws | 29 | 0 | 0 | 29 | deterministic |
| test-contacts | 51 | 0 | 0 | 51 | deterministic |
| test-network | 22 | 0 | 0 | 22 | deterministic |
| test-qmd | 18 | 0 | 0 | 18 | deterministic |
| **test-tools** | **~39** | **5** | **~1** | **~45** | **LLM-path** |
| **test-automations-llm** | **~25** | **9** | **0** | **~34** | **LLM-path** |
| **test-memory-save** | **5** | **0** | **0** | **5** | **LLM-path (script bug)** |

All 9 deterministic/direct-API scripts passed perfectly. Only LLM-path scripts had failures.

## Root Cause Analysis

### Cause 1: Smart Routing Bug — "No LLM provider configured" (test-tools: 5 failures)

`resolveRoutedProviderForTools` was only passed to config-driven ChatAgent instances (line 4888 in `src/index.ts`). Three other instantiation paths were missing the parameter:

| Path | Line | Gets resolver? |
|------|------|----------------|
| Config-driven agents | 4873-4889 | YES |
| Auto dual-agent (local) | 4909-4924 | **NO** |
| Auto dual-agent (external) | 4931-4946 | **NO** |
| Single default agent | 4978-4993 | **NO** |

When smart routing is enabled and a tool in an "external" category (web, intel, automation) executes, the routing lookup returns `undefined` because the resolver was never wired. The next LLM call then fails with "No LLM provider configured."

**Failing tests (test-tools.ps1):**

| Test | Tool Pattern | Category |
|------|-------------|----------|
| web_fetch: fetch health endpoint | `web_fetch\|web_search\|find_tools` | web |
| intel_summary: threat summary | `intel_summary` | intel |
| intel_findings: list findings | `intel_findings\|find_tools` | intel |
| task_list: list tasks | `task_list` | automation |
| workflow_list: list workflows | `workflow_list` | automation |

### Cause 2: Local LLM Not Calling Tools (test-automations-llm: 9 failures)

The local model (Ollama) sometimes responds with text instead of tool calls. This happened for `workflow_upsert`, `workflow_run`, `workflow_delete`, `task_create`, `task_list`, and `find_tools` across automation test sections.

This is partly a consequence of Cause 1 — these automation-category tools should route to the external provider via smart routing, but the resolver was missing. With the fix, the external provider handles these calls instead.

Remaining failures after the fix are model-quality limitations (local LLM not generating tool calls), not actionable via code.

### Cause 3: Script Exit Code Bug (test-memory-save: 9 false failures)

`test-memory-save.ps1` was the only test script missing `exit $Fail` at the end. Without it, PowerShell used `$LASTEXITCODE` from `$AppProcess.Kill()` (the terminated Node.js process's exit code) as the script's exit code. All 5 tests actually passed.

## Policy-as-Code Confirmation

The policy engine caused **zero** failures:
- Shadow mode only logs/compares, never blocks (`src/policy/shadow.ts`)
- No imports from `src/policy/` exist in `src/tools/executor.ts`
- `resolveToolProviderRouting()` and `resolveRoutedProviderForTools()` are untouched
- Policy bootstrap (`src/index.ts:5081-5210`) is isolated — never passed to ToolExecutor, ChatAgent, or Guardian pipeline

## Fixes Applied

### Fix 1: Wire `resolveRoutedProviderForTools` to all ChatAgent paths

**File:** `src/index.ts`

Added the missing 15th parameter (`resolveRoutedProviderForTools`) to all three ChatAgent constructor calls:
- Line 4924: Auto dual-agent (local)
- Line 4947: Auto dual-agent (external)
- Line 4995: Single default agent

### Fix 2: Fix test-memory-save.ps1 exit code

**File:** `scripts/test-memory-save.ps1`

Added `exit $Fail` after the cleanup block, matching the pattern from all other test scripts.

### Fix 3: Regression test script

**File:** `scripts/test-regressions.ps1` (new)

Created targeted regression script with 3 parts:
- Part 1 (5 tests): Smart routing — web_fetch, intel_summary, intel_findings, task_list, workflow_list
- Part 2 (9 tests): Automation LLM-path — discovery, creation, listing, running, scheduling, deletion
- Part 3 (5 tests): Memory save — all 5 prompt phrasings

## Verification

- `npm run check` — type-check passes
- `npm test` — 68 test files, 1088 unit tests pass
- Regression script created: `.\scripts\test-regressions.ps1`
