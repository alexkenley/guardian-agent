# Coding Assistant Spec

**Status:** As Built  
**Date:** 2026-03-17  
**Primary UI:** [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)  
**Primary Runtime:** [index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)  
**Code Session Store:** [code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)  
**Primary Web API:** [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)  
**Primary Tools:** [executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)

## Purpose

The Coding Assistant is Guardian’s repo-scoped coding workflow surface.

It provides:

- backend-owned coding sessions
- repo-aware assistant chat with backend workspace profiling, bounded repo indexing, and retrieval-backed working context
- explorer and source/diff inspection
- approval-aware coding execution
- PTY terminals for manual operator shell work
- session resume across web, main chat, CLI, and Telegram
- broader Guardian actions performed from the active workspace context

It is not a separate runtime. It is a coding mode built on the main Guardian runtime, tool executor, conversation service, and policy system.

## Architecture Summary

The important architectural change is that coding sessions are now backend-owned.

The browser no longer owns the authoritative coding session. The browser is now a client of a backend `CodeSession`.

Core layers:

- backend `CodeSessionStore` persists coding sessions and surface attachments
- backend workspace profiling and repo indexing build durable repo identity plus retrievable workspace context for each session
- `ConversationService` stores the coding transcript for each session conversation identity
- `ChatAgent` resolves attached or explicit coding sessions before prompt assembly and tool execution
- `ToolExecutor` exposes coding-session tools and enforces repo-scoped coding sandbox rules
- the Code page renders and edits a server-owned session, but still keeps transient UI cache locally

## Backend-Owned Code Sessions

Code sessions are persisted in the backend by [code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts).

Primary persisted shape:

- `CodeSessionRecord`
  - `id`
  - `ownerUserId`
  - `ownerPrincipalId`
  - `title`
  - `workspaceRoot`
  - `resolvedRoot`
  - `agentId`
  - `status`
  - `attachmentPolicy`
  - `createdAt`
  - `updatedAt`
  - `lastActivityAt`
  - `conversationUserId`
  - `conversationChannel`
  - `uiState`
  - `workState`
- `CodeSessionUiState`
  - `currentDirectory`
  - `selectedFilePath`
  - `showDiff`
  - `expandedDirs`
  - `activeAssistantTab`
  - `terminalCollapsed`
  - `terminalTabs`
- `CodeSessionWorkState`
  - `focusSummary`
  - `planSummary`
  - `compactedSummary`
  - `workspaceProfile`
  - `workspaceMap`
  - `workingSet`
  - `activeSkills`
  - `pendingApprovals`
  - `recentJobs`
  - `changedFiles`
  - `verification`
- `CodeSessionAttachmentRecord`
  - `codeSessionId`
  - `userId`
  - `principalId`
  - `channel`
  - `surfaceId`
  - `mode`
  - `attachedAt`
  - `lastSeenAt`
  - `active`

Persistence uses SQLite when available and falls back to in-memory storage otherwise.

## Workspace Awareness Model

The Coding Assistant no longer relies only on a workspace path and ad hoc prompt wording.

Each backend `CodeSession` carries durable workspace awareness state:

- `workspaceProfile`
  - repo name
  - repo kind
  - stack/framework hints
  - key manifests inspected
  - top-level entries
  - likely entry/focus points
  - summary of what the repo appears to be
- `workspaceMap`
  - bounded backend index of the attached repo
  - indexed file count, notable files, and directory summaries
  - compact file-level summaries and symbol/import hints for prompt-time retrieval
- `workingSet`
  - per-turn retrieved repo files for the current request
  - bounded excerpts from the most relevant files
  - survives vague follow-up questions so the assistant keeps answering from the same repo evidence
- `focusSummary`
  - short durable summary of the current coding objective for that session

Workspace profiling is still built from lightweight backend inspection of the session root, `README`, and primary manifest/config files, but Code sessions now also maintain a bounded repo map and a per-turn working set. The coding-session prompt gets the repo profile plus the current working-set evidence, so the model starts from actual repo files rather than generic host-app context or ad hoc prompt wording.

This is the mechanism that moves the Coding Assistant closer to a dedicated coding agent: not “all file contents in one prompt,” but backend repo awareness plus retrieval-backed working context.

## Conversation Model

Each coding session gets its own backend conversation identity:

- `conversationUserId = code-session:<sessionId>`
- `conversationChannel = code-session`

That means:

- a coding session has one durable coding transcript
- the transcript is separate from the normal main-chat transcript
- web Code, main chat, CLI, and Telegram can all attach to the same coding session and continue that same coding transcript
- sharing the same backend coding transcript does not make those clients equivalent; the web Code page remains the dedicated coding-session client, while main chat, CLI, and Telegram remain their own chat surfaces

The Code page is still a separate coding conversation surface in UX terms, but it is no longer a browser-only conversation.

## Attach And Resume Model

Guardian supports two ways to enter a coding session:

1. Explicit session targeting  
   A client targets a backend coding session directly. The web Code page does this with `POST /api/code/sessions/:id/message`. Other surfaces can still use `metadata.codeContext.sessionId`.

2. Surface attachment  
   A chat surface is attached to a `CodeSession`, and later messages on that surface inherit it automatically.

Surface attachment is tracked in `CodeSessionStore`.

Current behavior:

- the Code page sends turns through `POST /api/code/sessions/:id/message`
- main chat, CLI, and Telegram can use `code_session_attach`
- once attached, later messages on that surface resolve to the same coding session
- cross-surface reuse shares the backend session and transcript, not the full Code-page explorer/tasks/approvals/checks/terminal UI

## Routing Behavior

Routing is code-session-aware.

When an incoming message is tied to a coding session:

- Guardian first checks for an explicit or attached backend coding session
- if one exists, routing prefers that session’s bound `agentId`
- if the session is not yet bound, routing prefers the local/coding-capable agent tier
- only non-coding messages fall back to normal tier routing

This prevents “continue that coding session” style follow-ups from being routed as unrelated general chat.

## Capability Model

The Coding Assistant is session-grounded, not host-app-grounded.

That means:

- the default reasoning context comes from the active backend code session: workspace root, workspace profile, indexed repo map, current working set, focus summary, selected file, recent work, approvals, and checks
- Guardian's own host-app repo/application context is not part of the default Code-session context
- Code uses a dedicated Code-session prompt architecture rather than inheriting the main Guardian host prompt and trying to rewrite it after the fact
- Code sessions use a separate durable long-term memory store instead of preloading Guardian's global memory
- repo-local actions such as file edits, shell commands, git operations, tests, builds, and lint runs stay scoped to the active `workspaceRoot`
- broader Guardian capabilities remain available from within the Coding Assistant, including research, web/docs lookup, automation creation, and unrelated assistant tasks
- using broader capabilities does not replace the session's repo identity or current focus unless the user explicitly changes sessions or retargets the work

In practice, Code and main chat differ by contextual grounding rather than by tool inventory. The active code session stays the anchor even when the user does something broader from that surface.

## Code Page UI Model

The Code page keeps the existing layout:

- session rail
- explorer
- editor/diff viewer
- terminal panes
- assistant sidebar

The assistant sidebar remains tabbed:

- `Chat`
- `Tasks`
- `Approvals`
- `Checks`

Behavior:

- `Chat` is the main back-and-forth coding conversation
- `Tasks` shows workspace profile, indexed repo map, current working set, plan state, and recent coding activity
- `Approvals` shows queued coding approvals
- `Checks` shows recent verification outcomes
- the UI does not auto-switch tabs when approvals appear
- chat shows only a small approval notice instead of dumping approval cards inline

## Code Page State Ownership

Authoritative server state:

- session list
- session metadata
- workspace root and resolved root
- workspace profile
- workspace map
- working set
- focus summary
- coding transcript
- conversation identity
- pending approvals
- recent jobs
- active skills
- plan/compaction summaries

Browser-side cache only:

- cached session copies for faster reload
- unsent chat draft
- live terminal output buffer
- temporary runtime terminal ids
- dir-picker state

If the browser cache disagrees with the backend, the backend wins.

## Web API Methods

Primary backend-owned session methods:

- `GET /api/code/sessions`
  - returns the user’s backend coding sessions and the currently attached session for that surface
- `POST /api/code/sessions`
  - creates a backend coding session
- `GET /api/code/sessions/:id`
  - returns session metadata plus coding transcript history
- `PATCH /api/code/sessions/:id`
  - updates session metadata or persisted UI/work state
- `DELETE /api/code/sessions/:id`
  - deletes the backend coding session
- `POST /api/code/sessions/:id/attach`
  - attaches the current surface to that coding session
- `POST /api/code/sessions/detach`
  - detaches the current surface
- `POST /api/code/sessions/:id/reset`
  - resets the coding transcript for that session
- `POST /api/code/sessions/:id/message`
  - sends a chat turn through the authoritative backend coding session
- `POST /api/code/sessions/:id/approvals/:approvalId`
  - approves or denies an approval that belongs to that coding session

Session-backed direct Code UI methods:

- `POST /api/code/fs/list`
- `POST /api/code/fs/read`
- `POST /api/code/git/diff`
- `POST /api/code/terminals`
- `POST /api/code/terminals/:id/input`
- `POST /api/code/terminals/:id/resize`
- `DELETE /api/code/terminals/:id`

For `fs`, `diff`, and terminal open requests, the client can supply `sessionId`. The backend resolves the session and enforces the workspace root from the session record instead of trusting a browser-supplied root path.

## Code Session Messaging

Authoritative Code-page messaging uses:

- `POST /api/code/sessions/:id/message`

The generic chat path can still carry coding context through `metadata.codeContext`, but it now follows stricter rules:

- `metadata.codeContext.sessionId` is authoritative when present
- if that `sessionId` cannot be resolved, the request fails closed with `CODE_SESSION_UNAVAILABLE`
- `workspaceRoot` may still appear for compatibility or for ad hoc workspace-aware chat outside the Code page, but backend session resolution is the real authority whenever a session id is present

Chat flow:

- the Code page resolves a backend session id and sends the turn through the dedicated Code-session message endpoint
- the backend resolves that session before routing or prompt assembly
- if the session is missing or stale, the request returns a structured error instead of silently falling back to normal Guardian chat
- `ChatAgent` and tool dispatch receive the authoritative backend session context
- prompt assembly includes structured coding-session context plus the durable workspace profile and focus summary
- prompt assembly for Code uses Code-session memory only; Guardian global memory is not injected into Code-session turns
- tool execution gets a repo-scoped `codeContext`
- session snapshots expose `pendingApprovals` and `recentJobs` derived from records bound to that code session id

## Main Chat And Remote Channels

The main Guardian agent can see coding sessions through coding-session tools:

- `code_session_list`
- `code_session_current`
- `code_session_create`
- `code_session_attach`
- `code_session_detach`

That means:

- main chat can inspect available coding sessions
- main chat can attach to one and continue it
- CLI and Telegram can do the same
- all of them can continue the same backend coding transcript
- CLI and Telegram do this through their normal chat transports plus code-session attach/resume tools; they are not the same client as the web Code page

The web Code page is still the richest coding client, but it is no longer the only client.

## Coding Tooling

Built-in coding session tools:

- `code_session_list`
- `code_session_current`
- `code_session_create`
- `code_session_attach`
- `code_session_detach`

Memory behavior:

- `memory_recall` and `memory_save` bind to Code-session memory when the current request is inside a Code session
- `memory_search` continues to search the current conversation history, which is already Code-session-scoped for Code turns
- `memory_bridge_search` provides explicit read-only lookup across the global/code-session memory boundary without changing the current session context or objective

Built-in coding implementation tools:

- `code_symbol_search`
- `code_edit`
- `code_patch`
- `code_create`
- `code_plan`
- `code_git_diff`
- `code_git_commit`
- `code_test`
- `code_build`
- `code_lint`

These remain global tools in the main executor. The Code page uses them through session-aware context, not through a separate coding runtime.

## Sandbox And Security Model

Assistant-driven coding requests remain repo-scoped.

As built:

- the active coding workspace root comes from the backend `CodeSession`
- effective file access for coding requests is pinned to that single workspace root
- coding requests use the Coding Assistant shell allowlist instead of widening the global assistant shell policy
- path-like shell arguments are validated against the active workspace root
- repo-escape patterns like `git -C`, `--git-dir`, `--work-tree`, `--prefix`, `--cwd`, `--cache*`, `--global`, `-g`, and similar global-install or external-path patterns are blocked
- common command caches are redirected into `<workspaceRoot>/.guardianagent/cache`

This wider coding shell surface applies only when a request is running with coding-session context.

### Code Session Auto-Approve

Coding and filesystem tools operating within the code session workspace root are auto-approved without requiring manual user approval. The user implicitly grants trust to the workspace by creating the session. Auto-approved tools:

- **Coding tools:** code_edit, code_patch, code_create, code_plan, code_git_diff, code_test, code_build, code_lint, code_symbol_search
- **Filesystem tools:** fs_read, fs_write, fs_search, fs_list, fs_mkdir, fs_move, fs_copy, fs_delete
- **Memory tools:** memory_save, memory_search, memory_recall
- **Document tools:** doc_create
- **Automation tools:** task_create, task_update, task_delete, workflow_upsert, workflow_run, workflow_delete

Auto-approve bypasses only the `decide()` approval step. All other security layers remain active:

- Guardian admission pipeline (secret scanning, PII, SSRF, input sanitization)
- Path validation (`resolveAllowedPath()` still enforces workspace root boundary)
- **Guardian Agent inline LLM evaluation** (Layer 2) — `onPreExecute` evaluates every non-read-only tool action before execution, including auto-approved ones. This catches contextually dangerous actions (e.g., prompt-injected automations) that static rules cannot detect.
- Output Guardian scanning on all tool results
- Bearer token authentication on the web channel

The workspace root is also auto-added to the persistent `allowedPaths` on session create and attach, so the LLM sees it in `<tool-context>` and does not attempt to call `update_tool_policy` preemptively.

### codeContext Propagation

Auto-approve depends on `codeContext` reaching the `decide()` method inside `ToolExecutor`. The `codeContext` object (`{ workspaceRoot, sessionId }`) must flow through every execution path:

1. **ChatAgent** attaches `codeContext` to the message metadata before passing to `WorkerManager.handleMessage()`.
2. **WorkerManager.tryDirectAutomationAuthoring** — extracts `codeContext` from `input.message.metadata` and forwards it to `executeModelTool()` on each tool call. Without this, automation tools (`task_create`, `workflow_upsert`) called from the supervisor-side automation pre-route would not auto-approve.
3. **WorkerManager.dispatchToWorker** — sends the full message (including metadata) to the worker process via `brokerServer.sendNotification()`.
4. **Worker session** — extracts `codeContext` from `params.message.metadata` and injects it into every `executeModelTool()` call.
5. **BrokerClient.callTool** — includes `codeContext` in the JSON-RPC params sent to the supervisor.
6. **BrokerServer** — reads `codeContext` from `request.params` and includes it in the `ToolExecutionRequest` passed to `ToolExecutor.runTool()`.

If any link in this chain drops `codeContext`, auto-approve silently fails and tools fall back to `require_approval`.

### Code Session Prompt Isolation

The code session uses a standalone system prompt (`code-session-core.ts`) that does not inherit the Guardian host-app identity. The model-facing context identifies as a neutral "AI Coding Assistant" attached to a workspace, not as GuardianAgent. This prevents deictic references like "this app" from resolving to the host product instead of the attached workspace.

## Terminal Model

The Code page terminal area is still a manual PTY surface.

As built:

- terminals are opened from the current coding session workspace
- terminals are session-associated in the UI
- output is streamed over SSE
- terminals use `xterm.js`
- multiple panes are supported

Important boundary:

- PTY terminals are still operator-controlled
- the assistant does not remote-control those PTYs in v1
- assistant-driven coding shell execution still goes through the guarded tool path, not through PTY takeover

## Persistence Split

Guardian now uses two different persistence layers for coding:

General memory system:

- durable cross-channel memory facts
- searchable chat history
- normal conversation sessions
- memory flush/compaction support

Code-session memory system:

- durable long-term memory keyed by `codeSessionId`
- prompt-time memory injection only for that Code session
- Code-session-only memory flush/compaction targets
- explicit read-only bridge lookup into global memory when requested

Backend `CodeSessionStore`:

- active coding session records
- surface attachments
- coding UI state
- coding work state
- shared coding conversation identity

The global memory system is not the live coding session state machine. The backend `CodeSessionStore` is, and Code-session long-term memory remains separate from global memory by default.

## Current Limitations

As built, the Coding Assistant still does not provide:

- assistant-driven remote control of live PTY terminals
- repo-jailed PTYs matching the assistant shell validator exactly
- dedicated subagent `task` orchestration in the coding runtime yet
- automatic smart-routing escalation when the model gets stuck yet
- fully event-driven cross-client live sync; the Code page currently relies on refresh/polling and normal session reload paths

## Verification

Relevant checks:

- typecheck: `npm run check`
- executor unit tests: `npm test -- src/tools/executor.test.ts`
- code UI smoke: [test-code-ui-smoke.mjs](/mnt/s/Development/GuardianAgent/scripts/test-code-ui-smoke.mjs)
- coding assistant harness: [test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs)

Validated during this implementation:

- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`
- `HARNESS_USE_REAL_OLLAMA=1 node scripts/test-coding-assistant.mjs --use-ollama`
