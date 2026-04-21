# Remediation Plan: Post-Stress Test Orchestration Hardening

## Executive Summary
This document identifies and addresses orchestration vulnerabilities discovered during "Stress Test" scenarios. The most critical failure was the accidental deletion of the repository's `.git` directory by a delegated worker despite standard security policies.

## Identified Issues

### 1. Destructive Tool Call Safety (Failure #4)
**Symptom:** A delegated worker successfully executed `fs_delete` on the `.git` directory when requested by the user during a stress test.
**Root Cause:**
- **Policy Gap:** The standard tool policy failed to block the deletion of critical hidden directories (e.g., `.git`, `.github`, `.guardianagent`).
- **Confirmation Bypass:** The orchestrator correctly identified a "Destructive Action" intent, but because the user context was "Stress Testing," the safety confirmation might have been bypassed or automatically approved by a model that didn't understand the long-term impact.
- **Worker Autonomy:** The delegated worker followed the user's literal instructions ("Delete .git") without a secondary safety check from the `Guardian` layer for repository-wide destruction.

### 2. Multi-Agent Result Truncation (Failure #1, #6)
**Symptom:** Workers performed complex searches but returned truncated object lists (`[Object omitted]`), preventing the orchestrator from completing sequential tasks (e.g., finding files then reading them).
**Root Cause:** The `ToolExecutor` and worker IPC (Inter-Process Communication) serialize large results as JSON. When results exceed a token/memory threshold, the serialization layer omits nested objects, losing the critical file paths and line numbers needed for follow-on steps.

### 3. Session Targeting & Cross-Session Isolation (Failure #2)
**Symptom:** Workers reported "No coding session matched" when attempting to switch back to a previously active session during a multi-session workflow.
**Root Cause:** The worker sandbox identity (`code-session:<id>`) does not maintain a persistent mapping of all available global sessions unless explicitly passed through the request context. While `principalId` threading (Remediation #8/9) fixed *authorization*, it didn't guarantee *visibility* of all session aliases.

## Remediation Steps

### Phase 1: Immediate Safety (Hardened Deletion Guards)
- **Implement Repository Preservation:** Update `src/tools/builtin/filesystem-tools.ts` to explicitly block `fs_delete`, `fs_move`, or `fs_write` operations targeting `.git/` or its contents, regardless of policy overrides.
- **Confirmation Uplift:** Force a manual "User-in-the-loop" approval for any tool call that targets more than 10 files or affects the repository's version control structure.

### Phase 2: Orchestration Robustness (Full Data Serialization)
- **Hardened Search Results:** Modify the worker loop to serialize `fs_search` and `fs_list` results in a more robust way (e.g., using a flat array of strings or a specialized protocol) to prevent object truncation during multi-agent delegation.
- **Trace Inspectability:** Ensure the routing trace (`intent-routing.jsonl`) includes the full raw tool output when a verifier fails, helping diagnose *why* evidence was missing.

### Phase 3: Identity & Session Sync (Alias Persistence)
- **Session Registry Sync:** When spawning a worker, include a registry of all active session titles and IDs in the `principalContext` so the worker can disambiguate fuzzy titles (e.g., "Guardian Agent") against its sandboxed identity.

## Post-Remediation Verification
- Attempt to delete `.git` again in the web UI; verify the `Guardian` blocks it at the tool level with a "Critical System Path" error.
- Run the `src/runtime/` auth audit task again; verify the worker successfully reads line numbers without object truncation.
- Re-run the cross-session switch task; verify the worker can find sessions by both ID and fuzzy title.
