# Coding Workspace Spec

**Status:** As Built
**Date:** 2026-03-21  
**Primary UI:** [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)  
**Primary Runtime:** [index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)  
**Code Session Store:** [code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)  
**Workspace Trust Runtime:** [code-workspace-trust.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-workspace-trust.ts)  
**Native AV Runtime:** [code-workspace-native-protection.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-workspace-native-protection.ts)  
**Primary Web API:** [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)  
**Primary Tools:** [executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)

## Purpose

The Coding Workspace is Guardian’s repo-scoped coding workflow surface.

It provides:

- backend-owned coding sessions
- repo-aware Guardian chat with backend workspace profiling, bounded repo indexing, and retrieval-backed working context
- explorer and source/diff inspection
- approval-aware coding execution
- PTY terminals for manual operator shell work
- session resume across web, main chat, CLI, and Telegram
- broader Guardian actions performed from the active workspace context

It is not a separate runtime. It is a coding mode built on the main Guardian runtime, tool executor, conversation service, and policy system.

Guardian no longer has a separate built-in "coding assistant" identity. The product model is:

- one Guardian agent
- zero or one attached coding session per surface at a time
- a session-local coding transcript and session-local long-term memory scope while that attachment is active

## Architecture Summary

The important architectural change is that coding sessions are now backend-owned.

The browser no longer owns the authoritative coding session. The browser is now a client of a backend `CodeSession`.

Core layers:

- backend `CodeSessionStore` persists coding sessions and surface attachments
- backend workspace profiling, repo trust review, async native-AV enrichment, and repo indexing build durable repo identity plus retrievable workspace context for each session
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
  - `agentId` (legacy metadata only; automatic chat routing does not bind new turns to it)
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
  - `terminalCollapsed`
  - `terminalTabs`
- `CodeSessionWorkState`
  - `focusSummary`
  - `planSummary`
  - `compactedSummary`
  - `workspaceProfile`
  - `workspaceTrust`
  - `workspaceTrustReview`
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

The Coding Workspace no longer relies only on a workspace path and ad hoc prompt wording.

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
- `workspaceTrust`
  - bounded static review of the attached repo before Guardian treats repo execution as low-friction
  - persisted trust state: `trusted`, `caution`, `blocked`
  - summary plus finding list for suspicious prompt-injection or execution indicators
  - optional `nativeProtection` sub-state for host malware scan results such as Windows Defender or ClamAV
- `workspaceTrustReview`
  - optional session-scoped manual acceptance of the current `workspaceTrust` findings
  - stores who accepted the findings, when, and which assessment fingerprint was accepted
  - does not erase or rewrite the raw trust findings; it only changes the effective trust state used by the runtime
  - auto-clears when findings change, the workspace root changes, or a native AV detection appears
- `focusSummary`
  - short durable summary of the current coding objective for that session

Workspace profiling is still built from lightweight backend inspection of the session root, `README`, and primary manifest/config files, but Code sessions now also maintain workspace trust assessment, async native-AV scan status, a bounded repo map, and a per-turn working set. The coding-session prompt gets the repo profile plus the current working-set evidence, so the model starts from actual repo files rather than generic host-app context or ad hoc prompt wording.

The shared prompt-footprint, compaction, and compact-inventory rules for coding-session context are defined centrally in:
- `docs/specs/CONTEXT-ASSEMBLY-SPEC.md`

The shipped repo-assessment boundary is intentionally narrow: `workspaceTrust` is a bounded static heuristic review plus optional native AV enrichment. It is not an agentic repo assessment, it does not execute repo code, and a `trusted` result only means the shipped checks did not find current indicators.

Current trust-review heuristics also distinguish between strong execution indicators and review-only context:

- native AV detections and other blocking indicators are surfaced first in the bounded findings list
- prompt-injection matches in documentation or prompt-testing content remain visible as caution signals, not direct malware proof
- inline `node -e` helpers are treated as review indicators unless they pair with stronger execution signals such as fetch-and-exec or encoded payloads

When a user manually accepts the current findings, the session records `workspaceTrustReview` and derives an effective trust state from `workspaceTrust + workspaceTrustReview`. This is intentionally separate from the raw assessment so the UI can still show the underlying findings and why the workspace would otherwise remain `caution` or `blocked`.

When `workspaceTrust` is not `trusted`, prompt assembly suppresses README-derived summary text and raw working-set snippets and instead instructs the model to treat repo content as untrusted data, not instructions. The implementation details are in [CODE-WORKSPACE-TRUST-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODE-WORKSPACE-TRUST-SPEC.md).

This is the mechanism that gives the Coding Workspace durable repo grounding: not “all file contents in one prompt,” but backend repo awareness plus retrieval-backed working context.

## Conversation Model

Each coding session gets its own backend conversation identity:

- `conversationUserId = code-session:<sessionId>`
- `conversationChannel = code-session`

That means:

- a coding session has one durable coding transcript
- the transcript is separate from the regular Guardian chat transcript on that surface
- web Code, main chat, CLI, and Telegram can all attach to the same coding session and continue that same coding transcript
- sharing the same backend coding transcript does not make those clients equivalent; the web Code page remains the dedicated coding-session client, while main chat, CLI, and Telegram remain their own chat surfaces
- the default coding-session focus is shared across first-party chat surfaces for the same user/principal, so switching the current workspace from web, CLI, or Telegram updates what the other surfaces see as current by default
- explicit session targeting still overrides the shared focus for one request without permanently changing it

The Code page is still a separate coding conversation surface in UX terms, but it is no longer a browser-only conversation.

## Attach And Resume Model

Guardian supports two ways to enter a coding session:

1. Explicit session targeting  
   A client targets a backend coding session by attaching its conversational surface and then using the normal message path. Other surfaces can still use `metadata.codeContext.sessionId` for explicit one-off targeting.

2. Surface attachment  
   A chat surface is attached to a `CodeSession`, and later messages on that surface inherit it automatically.

Surface attachment is tracked in `CodeSessionStore`.

Current behavior:

- the canonical chat surface sends turns through the normal message path while attached to a code session
- main chat, CLI, and Telegram can use `code_session_attach`
- once attached, later messages on that surface resolve to the same coding session
- the default attachment policy is `same_principal`, which mirrors the current coding-session focus across the same user’s web, CLI, and Telegram surfaces
- attaching a different coding session promotes that session to the shared current workspace for the same principal, so later coding turns on other surfaces inherit it without a second attach step
- detaching clears that shared current workspace focus for the same principal unless another session is explicitly attached afterward
- cross-surface reuse shares the backend session and transcript, not the full Code-page explorer/tasks/approvals/checks/terminal UI

## Active Uplift: Multi-Workspace Portfolio Model

The current shipped product still uses one attached coding session per surface as the only implicit mutable target. The active multi-workspace uplift extends that model into a session portfolio without changing the implicit-write safety rule.

Target roles:

- `primary`: the current mutable coding session for the surface; repo-local writes, git actions, tests, builds, and mutation-capable shell work default here
- `referenced`: additional coding sessions that Guardian may inspect, compare, search, or summarize without treating them as implicit mutation targets
- `child lane`: an explicit delegated or background execution lane against another session or workspace, with its own approvals, status, and timeline lineage back to the parent session/request

Target orchestration rules:

- Guardian may reason about many coding sessions in one conversation, but implicit mutation still lands in exactly one `primary` workspace per lane
- switching the current workspace changes the `primary` session; it does not merge several mutable workspaces into one ambiguous context
- concurrent work in another workspace should be modeled as a `child lane`, not as silent multi-repo mutation from the same foreground chat flow
- referenced sessions are inspectable by default and writable only after an explicit workspace switch or through an explicit child lane

## Routing Behavior

Routing is code-session-aware.

When an incoming message is tied to a coding session:

- Guardian first checks for an explicit or attached backend coding session
- the coding session stays attached for workspace context, approvals, and continuity
- routing still goes through the shared Intent Gateway and execution-profile selector instead of dispatching directly to a stored session `agentId`
- Auto mode can therefore keep lighter coding turns on managed cloud or escalate heavier repo-grounded/security-heavy turns to frontier when policy allows it
- operator-forced chat mode or request-scoped provider overrides still apply normally for that turn

This prevents “continue that coding session” style follow-ups from losing workspace context without bypassing normal tier and provider selection.

## Capability Model

The Coding Workspace is session-grounded, not host-app-grounded.

That means:

- the default reasoning context comes from the active backend code session: workspace root, workspace profile, indexed repo map, current working set, focus summary, selected file, recent work, approvals, and checks
- Guardian's own host-app repo/application context is not part of the default Code-session context
- Code uses a dedicated Code-session prompt architecture rather than inheriting the main Guardian host prompt and trying to rewrite it after the fact
- Code sessions use a separate durable long-term memory store as bounded workspace-scoped augment context while still keeping Guardian global memory as the primary durable memory scope
- repo-local actions such as file edits, shell commands, git operations, tests, builds, and lint runs stay scoped to the active `workspaceRoot`
- Coding-session shell execution prefers structured direct exec for simple repo-local binaries and blocks known interpreter/launcher trampoline forms instead of treating every command as an opaque shell string
- broader Guardian capabilities remain available from within the Coding Workspace, including research, web/docs lookup, automation creation, and unrelated assistant tasks
- using broader capabilities does not replace the session's repo identity or current focus unless the user explicitly changes sessions or retargets the work

In practice, Code and main chat differ by contextual grounding rather than by tool inventory. The active code session stays the anchor even when the user does something broader from that surface.

## Code Page UI Model

The Code page keeps the existing layout:

- session rail
- explorer
- Monaco Editor / diff editor
- terminal panes
- assistant sidebar

Session edit now also exposes repo-trust review controls when the active workspace is flagged:

- the Edit Session form shows the current raw trust state and trust findings
- trust findings render as expandable deterministic review rows with `Why this matters`, `Investigate next`, and observed context
- users can acknowledge the current findings and mark the workspace as manually trusted for that session
- the edit form keeps its own scroll position and bounds the trust-review area so large scans remain usable
- the session rail still shows `TRUST: TRUSTED` only as an effective state, while activity and the edit form keep the raw findings visible

### Monaco Editor

The code editor is powered by Monaco Editor (the engine behind VS Code), vendored from npm and served from `web/public/vendor/monaco/`. Monaco is loaded on demand via AMD loader injection (`loadMonaco()`) the first time the code page renders.

Editor capabilities provided by Monaco out of the box:

- syntax highlighting for 100+ languages via built-in Monarch tokenizers
- line numbers, code folding, minimap, find/replace, command palette
- bracket pair colorization, indent guides, multi-cursor editing
- autocomplete and IntelliSense for TypeScript/JavaScript/JSON/CSS/HTML (runs in Web Workers, no backend)
- Ctrl+S / Cmd+S save via Monaco keybinding system
- `automaticLayout: true` for responsive resizing

Language detection uses `mapMonacoLanguageId(filePath)` which maps 40+ file extensions to Monaco's built-in language IDs: TypeScript, JavaScript, JSON, CSS/SCSS/LESS, HTML/XML, Markdown, YAML, Python, Shell, Go, Rust, C/C++, C#, Java, Ruby, PHP, SQL, GraphQL, Swift, Kotlin, Lua, Dart, Scala, and more.

### Diff Editor

When `showDiff` is toggled, Monaco's `createDiffEditor()` replaces the regular editor with a side-by-side diff view. The original (read-only) model shows the last saved file content, and the modified (editable) model shows the current file content with changes. The diff editor supports both side-by-side and inline rendering modes.

### Editor Model Lifecycle

Each open tab gets its own `monaco.editor.ITextModel` keyed by file URI (`monaco.Uri.file(filePath)`):

- models persist in memory while the tab is open, preserving undo history
- cursor position, scroll position, and selection are saved per tab via `editor.saveViewState()` and restored on tab switch via `editor.restoreViewState()`
- on tab close, the model is disposed
- on session switch, all models are disposed
- on full DOM rerender (e.g. terminal output, chat messages), the editor is disposed and recreated with saved view state

### Theme System

14 bundled editor themes defined in `web/public/js/monaco-themes.js`:

- **Guardian Agent** (default) — maps existing CSS color variables to Monaco theme format
- Threat Vector Security, Dracula, Monokai, Nord, Gruvbox Dark/Light, Solarized Dark/Light, GitHub Dark/Light, Night Owl, One Dark, Catppuccin Mocha

Theme selection persists in localStorage (`guardianagent_monaco_theme`). A dropdown in the editor panel header switches themes instantly via `monaco.editor.setTheme()`. Themes are global to all editor instances.

### Vendoring

Monaco is installed as a devDependency (`monaco-editor`). The `postinstall` script copies `node_modules/monaco-editor/min/vs/` to `web/public/vendor/monaco/vs/`. The vendor directory is gitignored. The WebChannel serves it from `/vendor/monaco/` with caching headers.

### Workspace Activity Panel

The workbench no longer owns a duplicate coding chat surface.

Behavior:

- Guardian chat is the canonical conversation surface for coding work
- the `#/code` workbench keeps the session-scoped `Activity` panel for approvals, trust state, recent work, and verification outcomes
- `Activity` preserves its own scroll position across normal session rerenders so long review lists remain navigable
- the UI does not auto-switch panels when approvals appear
- the web chat surface should not become a duplicate session manager; primary-session switching belongs to the workbench session rail
- normal web chat should not render separate coding-session controls or status rows; the Code Sessions panel owns that product surface
- the Sessions rail keeps one current mutable workspace selected at a time on the web surface
- clicking another session card promotes it to the current Guardian chat workspace instead of exposing separate per-card attach/reference/target controls
- other saved sessions in the rail are treated as referenced context by default
- the saved session portfolio is capped at four total sessions so the reference set stays bounded without additional per-session reference toggles
- trace/run deep links may still focus the relevant session or activity context without duplicating a second session-management surface in chat
- trace/run deep links that include `assistantRunId` or `assistantRunItemId` should open the `Activity` panel automatically for that inspected session
- when a deep link includes `assistantRunItemId`, the activity panel should render and highlight the exact matching event with a bounded nearby-context window instead of only showing the last few items
- `CURRENT` means the session currently attached to Guardian chat on that web surface; all other saved sessions are referenced context by default unless a future delegated or explicit-target flow narrows scope more tightly

### Code Inspector

The Code page now includes a first-class detachable code inspector for supported `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `mts`, and `cts` files.

Shipped behavior:

- the editor header exposes an `Inspect` button for the active file
- Monaco adds CodeLens actions above detected symbols
- `Inspect` and Monaco CodeLens open an editor-owned modal inspector on the `Investigate` tab
- the inspector can detach into a dedicated window and dock back into the editor surface
- the `Investigate` tab renders natural-language guidance for the current file or section: what the code does, what it talks to, potential risks, quality issues, hotspots, and recommended next inspection steps
- the `Flow` tab renders a focus diagram that shows callers, the selected symbol, callees, and nearby file context for the current file or scoped section
- the `Impact` tab renders a deterministic cross-file view for the active file using the workspace map, including local importers, imports, directory peers, working-set files, and notable files
- large files are inspected section by section, with the inspector anchored to the current cursor or a chosen section rather than failing as too large by default
- symbol cards still show exact source range, signature, deterministic summary, excerpt, side effects, trust-boundary tags, quality notes, security notes, and local callers/callees
- clicking a symbol in the inspector or a Monaco CodeLens entry selects that symbol and reveals the range in the editor
- clicking an impact node opens that file in the editor while keeping the inspector on the impact view
- Monaco highlights the selected symbol range in the editor, minimap, and overview ruler

The structure model is deterministic and runtime-owned. Natural-language investigation copy is derived from those deterministic facts rather than replacing them with opaque model-only output.

### Live Structure Preview

When the active editor buffer is dirty and the file is structure-previewable:

- the browser sends a debounced structure-preview request using the unsaved Monaco buffer
- the runtime re-parses the unsaved source via the same TypeScript AST logic used for saved-file inspection
- Monaco CodeLens and inspector details refresh without requiring a save
- the Investigate and Flow inspector tabs update after a short pause while the operator types
- stale preview responses are ignored through request sequencing so older parses do not overwrite newer edits
- a normal file refresh or save invalidates pending preview state and returns the structure view to the saved-file path

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
- `GET /api/code/sessions/:id/structure`
  - returns deterministic structure analysis for the selected or requested file on disk
- `POST /api/code/sessions/:id/structure-preview`
  - returns deterministic structure analysis for unsaved editor content without writing to disk
- `POST /api/message`
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

- `POST /api/message`

The generic chat path can still carry coding context through `metadata.codeContext`, but it now follows stricter rules:

- `metadata.codeContext.sessionId` is authoritative when present
- if that `sessionId` cannot be resolved, the request fails closed with `CODE_SESSION_UNAVAILABLE`
- `workspaceRoot` may still appear for compatibility or for ad hoc workspace-aware chat outside the Code page, but backend session resolution is the real authority whenever a session id is present

Chat flow:

- the Code page resolves a backend session id and keeps Guardian chat attached to that coding session
- coding turns still use the normal Guardian message path
- the backend resolves that session before routing or prompt assembly
- if the session is missing or stale, the request returns a structured error instead of silently falling back to normal Guardian chat
- `ChatAgent` and tool dispatch receive the authoritative backend session context
- prompt assembly includes structured coding-session context plus the durable workspace profile and focus summary
- prompt assembly for Code keeps Guardian global memory as the primary persistent memory scope and injects bounded Code-session memory as session-local augment context
- when the coding prompt is compacted for budget, the session now keeps a bounded `compactedSummary` plus trace-safe compaction diagnostics instead of silently dropping that context
- tool execution gets a repo-scoped `codeContext`
- session snapshots expose `pendingApprovals` and `recentJobs` derived from records bound to that code session id
- the session timeline now also surfaces bounded model-response provenance and context-compaction diagnostics for recent runs
- chat/blocking state for coding flows is tracked separately through the cross-channel `PendingActionStore`

## Main Chat And Remote Channels

The single Guardian agent can see coding sessions through coding-session tools:

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

- `memory_recall` and `memory_save` default to Guardian global memory even when the current request is inside a Code session; `scope: "code_session"` is the explicit session-local path
- `memory_search` can search Code-session conversation history, persistent memory, or both; inside Code, persistent search defaults to both global memory and the attached Code-session memory unless `persistentScope` narrows it
- `memory_bridge_search` provides explicit read-only lookup across the global/code-session memory boundary without changing the current session context or objective
- the shared `assistant.memory.knowledgeBase.readOnly` freeze also applies to Code-session durable memory, so `memory_save` and automatic flush writes are blocked while it is enabled
- Code-session memory context is rebuilt from the verified `codeSessionId.index.json` state; if that index is tampered with, the session memory is treated as empty rather than trusting the markdown cache

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

## External Coding Backends

Guardian also supports optional external coding backends for bounded delegation work inside an attached coding session.

As built:

- the runtime exposes `coding_backend_list`, `coding_backend_run`, and `coding_backend_status`
- delegation is opt-in and should only happen when the user explicitly asks to use an external coding tool such as Claude Code, Codex, Gemini CLI, or Aider
- mentioning Codex or another backend as the subject of a question should not relaunch it by itself; explanation or investigation questions about backend-produced artifacts should stay on the normal Guardian chat path unless the user explicitly asks Guardian to use that backend
- backend launches are tied to the current coding session and open a visible terminal tab so the operator can observe progress
- approval copy for delegated backend runs names the active coding workspace before launch so the operator can verify the target repo
- if a delegated coding request explicitly names a different saved coding workspace than the current attachment, Guardian should auto-switch that chat surface to the requested workspace before running the task there
- if the requested coding workspace is ambiguous or cannot be matched, Guardian should stop instead of silently writing into the wrong repo
- once that required workspace switch is satisfied on the same chat surface, Guardian should resume the stored delegated coding request automatically instead of asking for the request again
- UI-only chat context prefixes should not be forwarded into the external coding backend task payload or shown verbatim in operator-facing delegated-task previews
- switching the focused coding workspace should not fork or clear the visible Guardian chat transcript on that surface; the transcript belongs to the chat surface and the coding workspace is attached execution context inside it
- trace- and run-driven workbench deep links may open a different session for inspection and may land on an exact session-local timeline event, but they must not silently retarget the attached Guardian chat session
- the web config surface for this lives at `Configuration > Integrations > Coding Assistants`
- that config panel now shows a fixed built-in list of Claude Code, Codex, Gemini CLI, and Aider rather than a preset add/remove editor
- each built-in backend row supports `Enable` / `Disable` plus `Set Default`
- the same panel owns orchestration enablement, max concurrent delegated runs, version-check interval, and auto-update controls
- custom non-built-in backends may still exist in saved config, but the simplified web panel preserves them without exposing direct editing

This keeps Guardian in control of approvals, audit, routing, and verification while still allowing explicit delegation to terminal-first coding agents when the operator wants that path.

## Sandbox And Security Model

Assistant-driven coding requests remain repo-scoped.

As built:

- the active coding workspace root comes from the backend `CodeSession`
- effective file access for coding requests is pinned to that single workspace root
- coding requests use the Coding Workspace shell allowlist instead of widening the global assistant shell policy
- path-like shell arguments are validated against the active workspace root
- repo-escape patterns like `git -C`, `--git-dir`, `--work-tree`, `--prefix`, `--cwd`, `--cache*`, `--global`, `-g`, and similar global-install or external-path patterns are blocked
- common command caches are redirected into `<workspaceRoot>/.guardianagent/cache`

This wider coding shell surface applies only when a request is running with coding-session context.

### Code Session Auto-Approve

Coding-session auto-approve is now split between safe repo-local edits/reads and trust-cleared execution.

Always auto-approved inside the code session workspace root:

- **Coding tools:** code_edit, code_patch, code_create, code_plan, code_git_diff, code_symbol_search
- **Filesystem tools:** fs_read, fs_write, fs_search, fs_list, fs_mkdir, fs_move, fs_copy, fs_delete
- **Memory tools:** memory_search, memory_recall
- **Document tools:** doc_create

Auto-approved only when the effective workspace trust state is `trusted`:

- **Repo shell:** repo-scoped mutating `shell_safe`
- **Git mutation:** `code_git_commit`
- **Execution tools:** code_test, code_build, code_lint
- **Persistence tools:** memory_save
- **Automation tools:** task_create, task_update, task_delete, workflow_upsert, workflow_run, workflow_delete

Additional current behavior:

- read-only shell commands such as `git status` remain low-friction
- non-read-only shell execution in `caution` or `blocked` workspaces requires approval even under autonomous policy mode
- creating the code session authorizes the workspace path, but it no longer means the repo itself is accepted as safe for automatic execution
- a manual trust acceptance makes the effective trust state `trusted`, so the same repo-scoped auto-approve rules apply until the findings change

Auto-approve bypasses only the `decide()` approval step. All other security layers remain active:

- Guardian admission pipeline (secret scanning, PII, SSRF, input sanitization)
- Path validation (`resolveAllowedPath()` still enforces workspace root boundary)
- **Guardian Agent inline LLM evaluation** (Layer 2) — `onPreExecute` evaluates every non-read-only tool action before execution, including auto-approved ones. This catches contextually dangerous actions (e.g., prompt-injected automations) that static rules cannot detect.
- Output Guardian scanning on all tool results
- Bearer token authentication on the web channel

The workspace root is authorized through the active Code session's `codeContext`, not by mutating the global `allowedPaths` policy. Non-Code chat surfaces do not inherit access to a repo just because a Code session exists; they must attach to that session or use an explicitly allowlisted path.

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

The code session uses a standalone system prompt (`code-session-core.ts`) that does not inherit the Guardian host-app identity. The model-facing context identifies as a neutral coding agent operating inside the Coding Workspace rather than as GuardianAgent. This prevents deictic references like "this app" from resolving to the host product instead of the attached workspace.

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
- prompt-time memory injection only when that Code session is active, and only as bounded augment context layered after global memory
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

As built, the Coding Workspace still does not provide:

- assistant-driven remote control of live PTY terminals
- repo-jailed PTYs matching the assistant shell validator exactly
- dedicated subagent `task` orchestration in the coding runtime yet
- automatic smart-routing escalation when the model gets stuck yet
- fully event-driven cross-client live sync; the Code page currently relies on refresh/polling and normal session reload paths
- LSP backend integration for cross-file intelligence beyond Monaco's built-in TS/JS/JSON/CSS/HTML workers
- agentic repo trust review or sandbox detonation before classifying a workspace as `trusted`
- cross-file or repo-wide call graphs with symbol resolution beyond the current local-file matching
- structure inspection for non-TypeScript/JavaScript languages
- a visual structure or flow map beyond the current explorer, detachable inspector, and git graph
- first-class provenance labels that distinguish deterministic findings from future model-generated explanations, because the shipped structure layer is deterministic-only

## Verification

Relevant checks:

- typecheck: `npm run check`
- focused tests: `npx vitest run src/runtime/code-workspace-structure.test.ts`
- WebChannel route tests: `npx vitest run src/channels/channels.test.ts src/runtime/code-workspace-structure.test.ts`
- code UI smoke: [test-code-ui-smoke.mjs](/mnt/s/Development/GuardianAgent/scripts/test-code-ui-smoke.mjs)
- coding workspace harness: [test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs)
- contextual security harness: [test-contextual-security-uplifts.mjs](/mnt/s/Development/GuardianAgent/scripts/test-contextual-security-uplifts.mjs)
- broader regression run: `npm test`
- Windows Defender host helper: [test-windows-defender-workspace-scan.ps1](/mnt/s/Development/GuardianAgent/scripts/test-windows-defender-workspace-scan.ps1)

Validated during this implementation:

- `npx vitest run src/runtime/code-workspace-structure.test.ts`
- `npx vitest run src/channels/channels.test.ts src/runtime/code-workspace-structure.test.ts`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`
- `npm test`
- a final `npm run check` attempt surfaced an unrelated repo issue: `tsconfig.json` still includes `src/runtime/graph-runner.ts`, but that file is missing in the current workspace
