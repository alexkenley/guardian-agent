# Test Results: Approval Flow Suite (`test-approvals.ps1`)

**Date:** 2026-03-09
**Result:** 48 PASS, 0 FAIL, 0 SKIP — **100% pass**

## Environment

- LLM Providers: ollama (gpt-oss:latest, local) + openai (gpt-4o, external)
- Platform: Windows (PowerShell)

## Results by Section

### Setup (1 test)
| Test | Result |
|------|--------|
| autonomous policy + sandbox | PASS |

### Section 1: Direct API — Single Tool Approval (11 tests)
| Test | Result |
|------|--------|
| policy set to approve_by_policy, fs_write/delete = manual | PASS |
| fs_write returned pending_approval | PASS |
| response includes approvalId | PASS |
| approval object has toolName = fs_write | PASS |
| approval object has args with file path | PASS |
| approval object includes risk level (mutating) | PASS |
| deny decision accepted | PASS |
| second fs_write returned pending_approval | PASS |
| approve decision accepted | PASS |
| approved fs_write succeeded | PASS |
| fs_list (read_only) auto-executes in approve_by_policy | PASS |

### Section 2: Direct API — Multiple Simultaneous Approvals (6 tests)
| Test | Result |
|------|--------|
| all 3 tools returned pending_approval | PASS |
| 3 approvals pending simultaneously | PASS |
| pending approvals have tool names: fs_delete, fs_write | PASS |
| pending approvals have distinct args | PASS |
| denied 1 of 3 (fs_delete) | PASS |
| approved 2 remaining approvals | PASS |

### Section 3: Policy Mode Transitions (6 tests)
| Test | Result |
|------|--------|
| approve_each allows read_only fs_list | PASS |
| approve_each gates mutating fs_write | PASS |
| autonomous mode auto-executes fs_write | PASS |
| per-tool deny blocks fs_delete even in autonomous | PASS |
| autonomous fs_write still auto-executes (no manual override) | PASS |
| per-tool manual forces approval for fs_delete in autonomous | PASS |

### Section 4: LLM Path — Contextual Approval Prompts (6 tests)
| Test | Result |
|------|--------|
| LLM responded to write request | PASS |
| LLM response references the action (not generic) | PASS |
| approval prompt includes tool name 'fs_write' | PASS |
| approval prompt includes args context | PASS |
| LLM processed denial | PASS |
| approval was denied after 'no' | PASS |

### Section 5: LLM Path — Post-Approval Result Synthesis (4 tests)
| Test | Result |
|------|--------|
| approved fs_write via API | PASS |
| LLM responded to follow-up | PASS |
| LLM describes result (not just 'tool completed') | PASS |
| response is more than 'Tool X completed' | PASS |

### Section 6: LLM Path — Double-Approval Flow (4 tests)
| Test | Result |
|------|--------|
| sandbox restricted to '.' only | PASS |
| LLM responded to out-of-sandbox write | PASS |
| LLM explains policy update needed | PASS |
| fs_write pending directly (LLM skipped policy step) | PASS |

### Section 7: Edge Cases (4 tests)
| Test | Result |
|------|--------|
| bogus approval ID rejected gracefully | PASS |
| double-deny accepted (idempotent) | PASS |
| cannot approve after deny (immutable decision) | PASS |
| auto-allowed tool has no approvalId | PASS |

### Section 8: Job History & Approval Audit (5 tests)
| Test | Result |
|------|--------|
| 19 tool jobs recorded | PASS |
| 12 approval records tracked | PASS |
| both approved (4) and denied (8) decisions recorded | PASS |
| all approval records have toolName | PASS |
| job statuses seen: denied, succeeded | PASS |

### Cleanup (1 test)
| Test | Result |
|------|--------|
| policy restored to defaults | PASS |

## Notes

- All 8 sections passed on first run with no failures or skips
- Section 6 (double-approval): LLM skipped the `update_tool_policy` step and went directly to `fs_write` — still valid behavior, just a different path than the ideal two-step flow
- Section 7 confirms idempotent double-deny and immutable deny→approve rejection
- 19 tool jobs and 12 approval records tracked across the session (4 approved, 8 denied)
