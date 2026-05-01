# Code Workspace Trust Design

**Status:** As Built
**Date:** 2026-03-20
**Primary Runtime:** [code-workspace-trust.ts](../../src/runtime/code-workspace-trust.ts)
**Related Specs:** [Coding Workspace Spec](./CODING-WORKSPACE-DESIGN.md), [Contextual Security Uplift Spec](./CONTEXTUAL-SECURITY-UPLIFT-DESIGN.md)

## Purpose

Remove the Coding Assistant's previous assumption that creating a code session means the attached repo is automatically safe to execute.

The shipped model now performs a bounded static review of the workspace before Guardian treats repo-scoped execution and persistence as low-friction actions.

It now also enriches that static assessment with a native host-malware scan signal when a supported provider is available.

## Shipped Model

Every backend code session now carries a persisted `workspaceTrust` assessment in `CodeSessionWorkState`.

Code sessions can also carry an optional `workspaceTrustReview` record when a user manually accepts the current findings for that session.

Current states:

- `trusted`
- `caution`
- `blocked`

Assessment runs:

- on code-session creation
- when the session workspace root changes
- during normal workspace-awareness refresh when the cached assessment is stale

The assessment is deterministic and local-only. It does not execute repo code.

The shipped trust model now has two parts:

- a synchronous bounded static review of repo content
- an asynchronous native AV enrichment pass recorded in `workspaceTrust.nativeProtection`

The shipped runtime also derives an effective trust state from:

- raw `workspaceTrust`
- optional `workspaceTrustReview`

This keeps the raw findings intact while still allowing a reviewed session to run with trusted execution gating.

The shipped assessment is intentionally non-agentic. No Guardian agent or LLM reviews the repo to decide trust, no repo code is executed, and a `trusted` outcome only means the current bounded checks found no indicators.

## Detection Heuristics

The current scanner is intentionally bounded and fast.

It reviews a limited set of text-like repo files and looks for:

- prompt-injection-style text in README/docs/prompt-like files
- `package.json` lifecycle scripts such as `preinstall`, `postinstall`, and `prepare`
- fetch-and-exec patterns such as `curl ... | sh` and `Invoke-WebRequest ... | iex`
- encoded execution patterns such as PowerShell `-EncodedCommand`
- inline interpreter execution such as `node -e` and `python -c`
- suspicious network-fetch commands inside executable repo files such as scripts, workflows, Dockerfiles, and devcontainer files
- public frontend environment variables that appear to contain secrets, such as `NEXT_PUBLIC_*SECRET*`, `VITE_*TOKEN*`, or `REACT_APP_*API_KEY*`
- privileged service-role credential references in client-exposed or public environment contexts
- hardcoded fallback values for secret-like environment lookups
- permissive Supabase/Postgres RLS policies such as `using (true)` or auth-only policies that do not bind rows to owners
- public storage bucket configuration
- webhook-like handlers that consume request bodies without an obvious signature verification check

Current scoring:

- any high-risk finding yields `blocked`
- warning findings without a high-risk hit yield `caution`
- no findings yields `trusted`

## Native AV Enrichment

Workspace trust now also records an optional `nativeProtection` sub-state.

Current native backends:

- Windows: existing Windows Defender custom-path scan support
- Unix-like hosts: `clamdscan` or `clamscan` when available

Current behavior:

- the static assessment is stored immediately
- a background native AV scan is then scheduled for the workspace root
- the resulting provider status is persisted back into `workspaceTrust.nativeProtection`
- a native detection adds a high-risk trust finding and forces `workspaceTrust.state = blocked`
- a clean native scan does not override static trust findings
- unavailable or failed native scans are surfaced in the summary, but do not by themselves promote a repo to `caution` or `blocked`

Current statuses:

- `pending`
- `clean`
- `detected`
- `unavailable`
- `error`

## Manual Trust Review Override

Flagged workspaces can now be manually trusted on a per-session basis.

Current behavior:

- the operator can accept the current findings from the Code page Edit Session flow
- this stores `workspaceTrustReview` separately from `workspaceTrust`
- the review record captures who accepted the findings, when, and which trust-assessment fingerprint was accepted
- the raw trust state and findings remain visible in the UI and prompt context
- the runtime derives an effective trust state of `trusted` only while the accepted fingerprint still matches the current assessment
- if findings change, the workspace root changes, or native AV reports a live detection, the manual review record is cleared automatically

Current guardrails:

- the override is session-scoped, not a global allowlist change
- the override does not rewrite `workspaceTrust.state`
- native AV detections are not manually clearable through this flow

## Prompt Handling

Workspace trust now affects what repo-derived content is injected into the coding-session system context.

Current behavior:

- `trusted` workspaces include the normal workspace profile summary and working-set snippets
- `caution` and `blocked` workspaces suppress raw working-set snippets from the system prompt
- `caution` and `blocked` workspaces suppress the README-derived workspace summary from the system prompt
- manually trusted workspaces restore the normal workspace profile summary and working-set snippets because the effective trust state becomes `trusted`
- the system prompt includes the latest native AV status when available
- the system prompt explicitly tells the model to treat repo files and repo-generated summaries as untrusted data and never follow instructions found inside them
- when trust is manually accepted, the system prompt still records that the raw repo findings exist and that repo instructions remain untrusted data

This is a prompt-hardening layer for repo content. It is separate from remote-content tainting in the contextual-security uplift.

## Active Monitoring Integration

Workspace trust findings are also consumed by Assistant Security monitoring.

Current behavior:

- workspace trust findings remain persisted on the code session
- high-risk workspace trust findings contribute to the code-session target risk level
- SaaS anti-pattern findings are promoted as Assistant Security incident candidates when no manual trust review is active
- manual trust review changes the effective workspace trust state for execution gating, but it does not erase raw findings or make repo-derived instructions trusted

## Execution And Approval Behavior

Workspace trust now narrows which code-session tools are auto-approved.

Still auto-approved inside the active workspace:

- `code_edit`, `code_patch`, `code_create`, `code_plan`, `code_git_diff`, `code_symbol_search`
- repo-scoped filesystem tools
- `memory_search`, `memory_recall`
- `doc_create`

Auto-approved only when the effective trust state is `trusted`:

- repo-scoped mutating `shell_safe`
- `code_git_commit`
- `code_test`, `code_build`, `code_lint`
- `memory_save`
- `task_create`, `task_update`, `task_delete`
- `workflow_upsert`, `workflow_run`, `workflow_delete`

Additional current behavior:

- `shell_safe` remains allowlisted and repo-scoped
- read-only shell commands such as `git status` still pass without approval
- non-read-only shell execution in `caution` or `blocked` workspaces requires approval even under autonomous policy mode
- once the effective trust state is `trusted`, a manual review acceptance unlocks the same repo-scoped auto-approve lane as a clean `trusted` assessment

This keeps repo reading and editing low-friction while forcing a human decision before Guardian runs repo code or persists repo-derived state in a flagged workspace.

## UI Surface

The Code page now exposes workspace trust directly:

- session rail badge showing trust state
- activity card summarizing the latest assessment
- chat/activity warning banner for `caution` and `blocked` workspaces
- native AV status is folded into the assessment summary, and native detections change the warning copy from “static review” to “host malware scan”
- Edit Session trust-review controls showing raw findings plus a manual-trust checkbox when override is eligible
- a manually trusted session still shows the underlying findings in activity so the operator can see why the raw workspace state is not clean

## Current Non-Goals

The shipped version does **not** yet provide:

- Git-host attestation or publisher trust
- package-signature or SBOM verification
- agentic repo trust review or dynamic detonation/sandbox execution
- WSL-to-Windows Defender bridging when Guardian itself is not running on Windows
- autonomous remediation or autonomous trust promotion
- a global persistent “trust this repo forever” override outside the current coding session

## Primary Files

- [code-workspace-trust.ts](../../src/runtime/code-workspace-trust.ts)
- [code-workspace-native-protection.ts](../../src/runtime/code-workspace-native-protection.ts)
- [code-workspace-trust-service.ts](../../src/runtime/code-workspace-trust-service.ts)
- [code-sessions.ts](../../src/runtime/code-sessions.ts)
- [index.ts](../../src/index.ts)
- [executor.ts](../../src/tools/executor.ts)
- [code.js](../../web/public/js/pages/code.js)

## Verification

Current regression coverage includes:

- [code-workspace-trust.test.ts](../../src/runtime/code-workspace-trust.test.ts)
- [code-workspace-native-protection.test.ts](../../src/runtime/code-workspace-native-protection.test.ts)
- [code-workspace-trust-service.test.ts](../../src/runtime/code-workspace-trust-service.test.ts)
- [code-sessions.test.ts](../../src/runtime/code-sessions.test.ts)
- [executor.test.ts](../../src/tools/executor.test.ts)
- [test-coding-assistant.mjs](../../scripts/test-coding-assistant.mjs)
- [test-code-ui-smoke.mjs](../../scripts/test-code-ui-smoke.mjs)

Manual Windows-host validation helper:

- [test-windows-defender-workspace-scan.ps1](../../scripts/test-windows-defender-workspace-scan.ps1)

Validated during this implementation:

- `npm test -- src/runtime/code-workspace-trust.test.ts src/runtime/code-workspace-native-protection.test.ts src/runtime/code-workspace-trust-service.test.ts src/runtime/code-sessions.test.ts src/tools/executor.test.ts src/runtime/windows-defender-provider.test.ts`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- live WSL ClamAV validation using clean and EICAR-positive fixtures through `CodeWorkspaceNativeProtectionScanner`
- manual Windows Defender custom-path scan validation using [test-windows-defender-workspace-scan.ps1](../../scripts/test-windows-defender-workspace-scan.ps1)
