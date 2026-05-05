# Diagnostics Issue Reporting Design

## Status

Implemented: shared read-only diagnostics evidence collection, quick routing-trace inspection, diagnostics issue drafting, and user-approved GitHub issue creation through an explicit external-post capability.

Detailed GitHub connector direction is defined in [`GITHUB-INTEGRATION-DESIGN.md`](GITHUB-INTEGRATION-DESIGN.md).

Issue repository:

- The operator must configure the target GitHub owner/organization and repository.
- Product builds must not pre-fill a specific organization or repository.

## Goal

Guardian should help operators turn real assistant failures into high-quality engineering feedback without making the app self-modifying. When a request routes poorly, loses context, asks the wrong clarification, gets stuck on approvals, or produces an ungrounded answer, the user should be able to ask Guardian to draft a problem report from its own redacted diagnostics.

The capability must improve the feedback loop while staying inside Guardian's existing security model.

## Non-Goals

- Do not automatically change code, prompts, config, policy, or approval settings.
- Do not silently open GitHub issues.
- Do not bypass the Intent Gateway with keyword or regex intent routing.
- Do not expose raw trace payloads, secrets, email bodies, document contents, or local file contents in issue drafts.
- Do not make channel-specific diagnostic behavior that differs between Web, CLI, Telegram, and API.

## User Flow

```text
assistant behaves incorrectly
        ↓
user asks Guardian to draft/report the problem
        ↓
Intent Gateway routes diagnostics_task
        ↓
direct diagnostics candidate calls guardian_issue_draft
        ↓
tool reads shared redacted diagnostics evidence from routing trace and Guardian/audit summaries
        ↓
assistant shows issue title/body/labels/severity
        ↓
user explicitly approves GitHub issue creation
        ↓
external-post GitHub tool creates issue
```

## Capability Boundaries

### Read-Only Draft

The `guardian_issue_draft` tool is a built-in read-only tool. It:

- uses the shared diagnostics evidence collector,
- inspects `IntentRoutingTraceLog` through its redacted `listRecent` API,
- inspects recent Guardian/audit events through `AuditLog.query`,
- chooses a target diagnostic window such as latest completed request, current request, recent window, or explicit request id,
- drafts a GitHub-ready issue title, body, labels, severity, suspected subsystem list, expected behavior, actual behavior, and evidence summary,
- explicitly reports that no external issue has been created.

The tool does not:

- post externally,
- modify files,
- mutate memory,
- change policy,
- execute shell commands,
- fetch network resources.

### Read-Only Trace Inspection

The `guardian_trace_inspect` tool is a built-in read-only tool for quick operational diagnosis. It uses the same shared diagnostics evidence collector as issue drafting, but formats the result as a concise trace summary instead of a GitHub-ready report.

It:

- selects the latest relevant request window by default, excluding the current inspection request,
- accepts an explicit request id when supplied,
- reports request ids, stage counts, blockers, latest user/assistant previews, and a short timeline,
- explicitly avoids issue drafting or external posting.

This keeps "what happened?" diagnostics and "draft a problem report" diagnostics on one evidence model while preserving different user-facing outputs.

### User-Approved GitHub Issue Creation

GitHub issue creation is a separate capability from issue drafting. It:

- requires explicit user approval after showing the redacted draft,
- uses the dedicated `github_issue_create` external-post tool,
- carries the draft id/content as structured input rather than re-reading raw logs,
- records audit metadata with the target repository, title, labels, and created issue URL,
- fails closed if GitHub is unavailable or unauthenticated.

The runtime has no built-in default repository. Authentication goes through the configured GitHub OAuth connection in the Cloud connections UI, with a CLI adapter retained only as a compatibility fallback for development environments. The read-only diagnostics draft tool must never post externally as a side effect.

## Intent Gateway Contract

Requests to diagnose Guardian behavior, draft a problem report, or create/open/file a GuardianAgent GitHub issue about app behavior route to `diagnostics_task`.

Examples:

- "Draft a GuardianAgent problem report from diagnostics for the last bad response."
- "Report this assistant behavior as a bug, but don't post it yet."
- "Use the routing trace to draft an issue for why the last request got stuck."
- "Create a GuardianAgent GitHub issue for the last bad response."

Expected classification:

- `route`: `diagnostics_task`
- `operation`: usually `draft` or `inspect`; initial GitHub issue requests draft first
- `executionClass`: `tool_orchestration`
- `requiresToolSynthesis`: `true`
- direct candidate: `diagnostics_issue_draft` for reports, or `diagnostics_trace_inspect` for quick trace inspection

This route exists so diagnostic issue reporting does not rely on ad hoc text matching or a generic assistant answer.

## Data Sources

Primary data sources are already-redacted or summarized runtime surfaces:

- `IntentRoutingTraceLog.getStatus()`
- `IntentRoutingTraceLog.listRecent()`
- `AuditLog.query()`

The diagnostic draft may include:

- request ids,
- channels,
- timestamps,
- route and operation decisions,
- selected tool calls and statuses,
- clarification/blocker summaries,
- Guardian/audit event types, controllers, severities, and redacted reasons,
- final response previews.

The diagnostic draft must not include:

- raw tool output,
- raw email/document/browser content,
- secrets, bearer tokens, API keys, cookies, credentials,
- long trace payload bodies.

## Security And Privacy

The diagnostics read is read-only and uses existing trace redaction before issue-body construction. The issue draft also runs through normal tool execution, policy, Guardian checks, audit hooks, and job history.

GitHub posting is `external_post` approval-gated behavior. The user approves the external post, not the diagnostic read.

Recommended default copy:

> Drafted a redacted GuardianAgent issue report. No GitHub issue was created.

## Architecture Placement

Runtime:

- `src/runtime/diagnostics/evidence.ts` owns diagnostic evidence selection, redaction, trace-window selection, blocker extraction, tool-call summaries, and Guardian/audit summaries.
- `src/runtime/diagnostics/trace-inspect.ts` owns concise trace-inspection formatting over the shared evidence model.
- `src/runtime/diagnostics/issue-draft.ts` owns issue draft construction over the shared evidence model.

Tool layer:

- `src/tools/builtin/diagnostics-tools.ts` exposes the read-only `guardian_issue_draft` tool.
- `src/tools/builtin/diagnostics-tools.ts` also exposes the read-only `guardian_trace_inspect` tool for quick trace summaries.
- `src/tools/executor.ts` wires redacted routing trace and audit dependencies into the registrar.

Intent/direct routing:

- `diagnostics_task` is added to the Intent Gateway route contract.
- `diagnostics_issue_draft` is resolved as a direct candidate for issue/report drafting.
- `diagnostics_trace_inspect` is resolved as a direct candidate for quick trace inspection.
- `src/runtime/chat-agent/direct-diagnostics.ts` calls the selected diagnostics tool and formats the user-facing response.

Operator guide:

- `src/reference-guide.ts` describes that Guardian can draft a redacted problem report and does not open GitHub issues without separate approval.

## Testing Strategy

Required coverage:

- unit tests for draft construction from trace/audit inputs,
- unit tests for shared diagnostics evidence selection used by issue drafting and trace inspection,
- unit tests for quick trace-inspection summaries,
- tool registration and execution tests proving no external post,
- capability resolver tests for `diagnostics_task`,
- direct route tests proving chat dispatch calls `guardian_issue_draft`,
- focused typecheck/build,
- real API smoke through `/api/tools/run`,
- real chat/API smoke once the gateway route is reliable.
- approval-continuity tests for external issue creation,
- GitHub unavailable/auth-missing tests,
- redaction regression tests on issue payloads,
- channel parity harness coverage.
