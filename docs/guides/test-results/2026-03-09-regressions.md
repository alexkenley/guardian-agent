# Test Results: Regression Suite (`test-regressions.ps1`)

**Date:** 2026-03-09
**Result:** 45 PASS, 0 FAIL, 0 SKIP — **100% pass**

## Environment

- LLM Providers: ollama (gpt-oss:latest, local) + openai (gpt-4o, external)
- Platform: Windows (PowerShell)
- Context: Verifying fixes for 23 failures reported by `test-all.ps1`

## Fixes Validated

1. **Smart routing bug** — `resolveRoutedProviderForTools` wired to all 3 missing ChatAgent instantiation paths in `src/index.ts`
2. **Script exit code bug** — `exit $Fail` added to `scripts/test-memory-save.ps1`
3. **LLM tool-calling for external categories** — external provider now correctly handles web, intel, and automation tools via smart routing

## Results by Section

### Setup (1 test)
| Test | Result |
|------|--------|
| autonomous policy | PASS |

### Part 1: Smart Routing Fixes — from test-tools (11 tests)

Previously failed with "No LLM provider configured" when smart routing tried to resolve a provider for external-category tools.

| Test | Result | Notes |
|------|--------|-------|
| 1.1 web_fetch: fetch health endpoint | PASS | |
| 1.1 web_fetch: health response returned | PASS | |
| 1.1 web_fetch: tool was called | PASS | called: web_search |
| 1.2 intel_summary: threat summary | PASS | |
| 1.2 intel_summary: tool was called | PASS | called: intel_summary |
| 1.3 intel_findings: list findings | PASS | |
| 1.3 intel_findings: tool was called | PASS | called: intel_findings, find_tools |
| 1.4 task_list: list tasks | PASS | |
| 1.4 task_list: tool was called | PASS | called: task_list (x5) |
| 1.5 workflow_list: list workflows | PASS | |
| 1.5 workflow_list: tool was called | PASS | called: workflow_list |

### Part 2: Automation LLM-Path — from test-automations-llm (28 tests)

Previously failed due to both smart routing (provider errors) and local LLM not generating tool calls. With routing fixed, external provider handles automation-category tools correctly.

| Test | Result | Notes |
|------|--------|-------|
| 2.0 prerequisite: automation tools available | PASS | |
| 2.1 discovery: automation tools query | PASS | |
| 2.1 discovery: mentions automation concepts | PASS | |
| 2.1 discovery: find_tools was invoked | PASS | called: find_tools |
| 2.2 create-single: basic creation | PASS | |
| 2.2 create-single: confirms creation | PASS | |
| 2.2 create-single: workflow_upsert was called | PASS | called: workflow_upsert (x2) |
| 2.3 create-single: verify via list | PASS | |
| 2.3 create-single: automation appears in list | PASS | |
| 2.3 create-single: workflow_list was called | PASS | called: workflow_list |
| 2.4 create-pipeline: sequential creation | PASS | |
| 2.4 create-pipeline: confirms multi-step creation | PASS | |
| 2.4 create-pipeline: workflow_upsert was called | PASS | called: workflow_upsert |
| 2.5 run: dry run | PASS | |
| 2.5 run: confirms dry run execution | PASS | |
| 2.5 run: workflow_run was called | PASS | called: workflow_run |
| 2.6 run: real execution | PASS | |
| 2.6 run: confirms real execution | PASS | |
| 2.6 run: workflow_run was called | PASS | called: workflow_run |
| 2.7 schedule: create scheduled task | PASS | |
| 2.7 schedule: confirms schedule creation | PASS | |
| 2.7 schedule: task_create was called | PASS | called: task_create |
| 2.8 delete: single automation | PASS | |
| 2.8 delete: confirms deletion | PASS | |
| 2.8 delete: workflow_delete was called | PASS | called: workflow_delete |
| 2.9 delete: pipeline + task cleanup | PASS | |
| 2.9 delete: cleanup tools were called | PASS | called: task_delete, task_list (x2), workflow_delete (x2) |

### Part 3: Memory Save — from test-memory-save (5 tests)

Previously reported 9 false failures due to missing `exit $Fail` in the script. All 5 tests pass (and always did).

| Test | Result | Notes |
|------|--------|-------|
| 3.1 memory_save: original prompt | PASS | called: memory_save |
| 3.2 memory_save: explicit tool name | PASS | called: memory_save |
| 3.3 memory_save: find_tools then save | PASS | called: memory_save |
| 3.4 memory_save: remember this | PASS | called: memory_save |
| 3.5 memory_save: two-step discover then save | PASS | called: memory_save |

### Cleanup (1 test)
| Test | Result |
|------|--------|
| policy restored to approve_by_policy | PASS |

## Conclusion

All 23 previously-failing tests now pass. The smart routing fix (`resolveRoutedProviderForTools` wired to all ChatAgent paths) resolved both the "No LLM provider configured" errors and the "no tool calls detected" failures — the latter because external-category tools now correctly route to the external provider (gpt-4o) which reliably generates tool calls.
