# Test Results: Automation Tools Suite (`test-automation.ps1`)

**Date:** 2026-03-09
**Result:** 24 PASS, 0 FAIL, 0 SKIP — **100% pass**

## Environment

- LLM Providers: ollama (gpt-oss:latest, local) + openai (gpt-4o, external)
- Platform: Windows (PowerShell)

## Prior Run

Initial run had 6 failures — all approval-gated tests returned `failed` instead of `pending_approval`. Root cause: test script used outdated parameter names that didn't match current tool schemas. Arg validation (`validateToolArgs`) rejected requests before the approval gate was reached. Fixed parameter names:

| Tool | Old args | Fixed args |
|------|----------|------------|
| `workflow_upsert` | `{ name, steps: [{tool}] }` | `{ id, name, mode, steps: [{id, toolName}] }` |
| `workflow_delete` | `{ name }` | `{ workflowId }` |
| `workflow_run` | `{ name }` | `{ workflowId }` |
| `task_create` | `{ name, schedule, action: {...} }` | `{ name, type, target, cron }` |
| `task_update` | `{ id, updates: {name} }` | `{ taskId, name }` |
| `task_delete` | `{ id }` | `{ taskId }` |

## Results by Section

### Prerequisite Check (1 test)
| Test | Result |
|------|--------|
| automation tools available (probe status: succeeded) | PASS |

### Read-Only Tests — Autonomous Mode (2 tests)
| Test | Result |
|------|--------|
| setup: autonomous policy | PASS |
| task_list: executed without approval (succeeded) | PASS |

### Autonomous Mode Execution (4 tests)
| Test | Result | Notes |
|------|--------|-------|
| workflow_upsert (autonomous): executed (failed) | PASS | Handler ran, failed (no control plane or missing service) |
| task_create (autonomous): executed (succeeded) | PASS | |
| workflow_delete (autonomous): executed (failed) | PASS | Workflow didn't exist |
| task_delete (autonomous): executed (failed) | PASS | Task didn't exist |

### Approval Tests — approve_by_policy (13 tests)
| Test | Result |
|------|--------|
| policy set to approve_by_policy | PASS |
| workflow_upsert: requires approval | PASS |
| workflow_upsert: denial accepted | PASS |
| workflow_delete: requires approval | PASS |
| workflow_delete: denial accepted | PASS |
| workflow_run: requires approval | PASS |
| workflow_run: denial accepted | PASS |
| task_create: requires approval | PASS |
| task_create: denial accepted | PASS |
| task_update: requires approval | PASS |
| task_update: denial accepted | PASS |
| task_delete: requires approval | PASS |
| task_delete: denial accepted | PASS |
| task_list: allowed without approval | PASS |

### Cleanup (1 test)
| Test | Result |
|------|--------|
| policy restored to approve_by_policy | PASS |

### Job History Verification (2 tests)
| Test | Result |
|------|--------|
| 13 automation tool executions recorded | PASS |
| automation statuses: denied, failed, succeeded | PASS |

## Notes

- Test script was updated to match current tool schemas (post unified automations refactor)
- All 6 mutating tools correctly gated by approval under `approve_by_policy`
- `task_list` (read_only) correctly bypasses approval in both modes
- `workflow_upsert` fails in autonomous mode — likely the automation control plane isn't fully wired for the harness config, but it passes the approval gate correctly which is what the test validates
