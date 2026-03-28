# Proposal: Backend-Owned Coding Sessions for Channel-Agnostic Agentic Work

## Summary

GuardianAgent's current Coding Assistant is effective as a web workspace, but its session model is still browser-owned. The `Code` page stores sessions in browser `localStorage` and sends `metadata.codeContext` on each request so the backend can scope tool execution. That is sufficient for a web-first coding UI, but it is the wrong architecture if Guardian should be able to continue coding work through the main assistant, Telegram, CLI, or future remote surfaces.

This proposal shifts coding from a web-owned feature to a backend-owned runtime capability:

- introduce a first-class server-side `CodeSession`
- let the web `#/code` page, main Guardian chat, Telegram, CLI, and automation attach to that session
- keep channel transcripts separate while sharing one canonical coding work object
- give the main agent visibility into all active coding sessions without implicitly merging their full context into every chat
- move workspace identity, approvals, work-state, verification, and compaction under backend ownership
- retain the specialized web Code chat and workspace UI as the richest client for coding work

The web Code page remains the richest operator interface, but it becomes a client over the same backend session model rather than the owner of coding state.

## Why This Change Is Needed

Today, the shipped Coding Assistant spec says:

- Code sessions are stored in browser `localStorage`
- Code chat is separate from the rest of the app's general chat
- the browser sends `metadata.codeContext.sessionId` and `metadata.codeContext.workspaceRoot`
- server-side Code session persistence is still a listed limitation

That model is documented in:

- [CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md)
- [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)

This creates four architectural problems:

1. The backend does not own the canonical coding session.
2. The main assistant cannot naturally resume or inspect coding work started in the Code page.
3. Telegram and other remote channels cannot cleanly continue a coding session without the browser acting as the source of truth.
4. Security-critical scoping still depends partly on client-supplied context instead of server-resolved session state.

## Design Goals

- Make coding sessions durable and backend-owned.
- Preserve the current repo-scoped coding sandbox model.
- Allow multiple channels to attach to the same coding session deliberately.
- Keep normal assistant chat and coding work logically distinct.
- Give the main assistant and operators visibility into active coding work without causing transcript cross-talk.
- Support multiple concurrent coding sessions per user.
- Keep the web Code page as the best UI for explorer, editor, diffs, approvals, and terminals.

## Non-Goals

- Do not merge all user conversations into one giant shared transcript.
- Do not make PTY terminals remotely controllable in v1.
- Do not dismantle the dedicated web Code chat or collapse all coding UX into the main chat.
- Do not weaken Guardian approval or workspace-bound shell policy.
- Do not replace the existing automation/compiler architecture with a coding-engine-specific runtime.

## External Patterns Worth Reusing

The target shape is consistent with how strong agentic systems model long-running work:

- **OpenCode** treats the agent runtime as a server with first-class sessions, multiple clients, attach/continue semantics, and shared config across interfaces.
- **OpenHands** models work as a backend conversation object reachable through WebSocket and Cloud APIs, with resume support.
- **Goose** keeps shared session records across interfaces instead of making one UI the owner of the work.
- **Claude Code** exposes session management and headless use through an SDK and GitHub Actions rather than limiting coding work to a single UI surface.
- **OpenClaw** is especially relevant for its binding-router pattern: the important idea is that a surface can be explicitly bound to a runtime target without changing the overall identity model.

Those systems differ in implementation details, but the architectural commonality is more important than the product surface: the session/work object lives in the backend, and UIs attach to it.

## Proposed Model

### 1. Introduce a First-Class `CodeSession`

Add a durable server-side session object:

```ts
interface CodeSession {
  id: string;
  ownerPrincipalId: string;
  title: string;
  workspaceRoot: string;
  resolvedRoot: string;
  branch?: string;
  status: 'idle' | 'active' | 'awaiting_approval' | 'blocked' | 'failed' | 'completed';
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  boundAgentId?: string;
  compactedSummary?: string;
  activeTaskId?: string;
  attachmentPolicy: 'explicit_only' | 'same_principal';
}
```

This becomes the canonical identity for coding work.

The browser no longer invents the coding session as local UI state. It requests, attaches to, and updates a backend session.

### 2. Split Durable Coding State from UI State

Backend-owned state:

- workspace root and resolved root
- coding transcript/journal
- approvals
- tasks/todos
- verification results
- compacted summary and archive refs
- changed files / artifacts
- branch and repo metadata
- security policy and workspace scoping

Client-owned state:

- active sidebar tab
- editor scroll/cursor position
- terminal pane arrangement
- local draft input
- window layout preferences

This keeps the backend authoritative without turning every cosmetic browser preference into server state.

### 3. Add a `CodeSessionWorkState`

Durable coding state should not be inferred from chat text alone.

```ts
interface CodeSessionWorkState {
  planSummary: string;
  todos: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'blocked';
  }>;
  recentTasks: Array<{
    id: string;
    role: 'parent' | 'researcher' | 'implementer' | 'reviewer' | 'triager';
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    summary: string;
  }>;
  verification: Array<{
    id: string;
    kind: 'test' | 'lint' | 'build' | 'manual';
    status: 'pass' | 'warn' | 'fail' | 'not_run';
    summary: string;
    timestamp: number;
  }>;
  pendingApprovals: Array<{
    approvalId: string;
    kind: string;
    summary: string;
    requestedAt: number;
  }>;
  changedFiles: string[];
  artifactRefs: string[];
}
```

This is the canonical state the main assistant can inspect without replaying a full transcript.

### 4. Add Channel Attachments Instead of Transcript Merging

One of the user's practical concerns is valid: if people move between sessions and channels, naive history merging becomes confusing.

The fix is not one giant transcript. The fix is explicit attachment records:

```ts
interface CodeSessionAttachment {
  id: string;
  codeSessionId: string;
  principalId: string;
  channel: 'web' | 'cli' | 'telegram' | 'discord' | 'system';
  surfaceId: string;
  mode: 'observer' | 'participant' | 'controller';
  attachedAt: number;
  lastSeenAt: number;
  active: boolean;
}
```

Interpretation:

- a web `#/code` view can attach to a `CodeSession`
- the main web chat can attach to a `CodeSession`
- a Telegram chat can attach to a `CodeSession`
- a CLI shell can attach to a `CodeSession`

All of those are views over the same coding work object, but they remain separate surfaces with separate local chat histories.

## Main Agent Visibility Model

The main assistant should have visibility into coding sessions, but not by automatically swallowing all coding transcripts into normal chat.

The right visibility model is:

- the main assistant can list active coding sessions for the current principal
- it can inspect a structured summary for each session
- it can attach to a selected session
- once attached, tool execution is scoped to that `CodeSession`
- when detached, the main assistant returns to ordinary chat behavior

In plain terms: the main assistant sees the coding session registry and can step into a coding session when needed, but it does not permanently become every coding session at once.

### What the Main Assistant Should Be Able to See

Without attaching, the main assistant should see:

- session title
- workspace root
- current branch
- last activity time
- status
- pending approval count
- active/failing check summary
- compacted work summary
- recent task summaries

That is enough for prompts like:

- "What coding sessions are active right now?"
- "Continue the Shopify billing fix"
- "Which repo is blocked on approvals?"
- "Summarize the session working on Telegram auth"

### How Session Selection Should Work

Routing order for coding continuation:

1. explicit session id
2. explicit title/workspace match
3. bound session for the current surface
4. most recently active session for the principal
5. clarification prompt if still ambiguous

This reuses the same surface-aware routing logic Guardian already needs for richer channels. It is very similar in spirit to the OpenClaw binding-router idea: channel or thread context can bind to a runtime target without collapsing all context into one pool.

## Canonical Journal vs Channel Chat

The backend should maintain a canonical coding journal for continuity:

- user directives that affect the coding task
- assistant summaries of important decisions
- tool actions
- file mutations
- approvals and denials
- verification outcomes
- compaction/archive events

Channel chat transcripts remain channel-local presentation surfaces.

This means:

- the Code page can keep its conversational UX
- Telegram can remain concise
- the main assistant can stay readable
- the coding runtime still has one durable record of what work happened

## Channel Behavior

### Web Code Page

The web Code page becomes a full-featured client over `CodeSession`:

- attach to session
- browse files
- edit/diff
- manage approvals
- view tasks/checks
- open PTY terminals

Its existing session rail should become a server-backed session list.

### Main Guardian Chat

The main chat gets coding-session awareness without becoming the Code page:

- `list code sessions`
- `attach to code session`
- `detach from code session`
- `continue the active code session`
- `summarize blocked code sessions`
- run coding tools and guarded repo-scoped shell commands while attached to a `CodeSession`

When attached, the main assistant uses the session's backend-owned workspace and policy instead of client-supplied `workspaceRoot`.

The main chat does not replace the web Code chat. It becomes another client over the same backend-owned coding session. The web Code chat remains the richer surface for file browsing, diffs, approvals, checks, and terminals.

### Telegram

Telegram should be able to:

- list the user's coding sessions
- attach the current chat/thread to one
- continue work
- see pending approvals and high-level diffs
- approve/deny simple actions
- hand off to the web UI for richer diff review when needed

Telegram should not try to replicate the full web coding UI. It is a remote control surface, not the canonical owner of the coding session.

### CLI

CLI should be able to:

- attach to a `CodeSession`
- continue work in the same backend session
- inspect tasks/checks/approvals
- detach or switch sessions

### Automation / Scheduled Runs

Longer-term, a scheduled automation should be able to resume a `CodeSession` as a background worker, subject to the same policy and approval constraints.

## Shell Execution vs PTY Terminals

This proposal intentionally separates two different capabilities:

- assistant-driven coding execution through Guardian tools such as `code_*` tools and repo-scoped guarded shell commands
- manual interactive PTY terminals exposed in the web Code page

The backend-owned `CodeSession` model should allow the main assistant, Telegram, CLI, and automation to perform coding work through the first path when they are attached to a session. That means they can still:

- run tests
- run linters and builds
- run repo-scoped scripts
- use `git` and other allowlisted coding commands

What they should not do in v1 is remotely drive a live PTY terminal pane as if they were controlling the browser terminal directly.

In plain terms:

- yes, attached non-web clients should still be able to execute the shell commands needed for coding work
- no, they should not remote-control a live terminal surface in the first version

## Approvals

Approvals should belong to the `CodeSession`, not to a particular browser tab.

That means:

- the same approval queue is visible from web Code, main chat, Telegram, and CLI
- approval records include session id, workspace, action summary, and artifact refs
- approval decisions are durable events in the coding journal
- approval backlog rules are enforced per `CodeSession`

Channel-specific rendering stays different:

- web shows rich approval cards and diffs
- Telegram shows concise summaries and buttons
- main chat shows compact notices and can link the user to details

## Security Model

This proposal does not weaken the current coding sandbox work. It tightens it.

Changes:

- `workspaceRoot` is resolved from server-side `CodeSession`, not trusted from browser metadata
- session policy travels with the `CodeSession`
- approvals are attached to the session and auditable across channels
- the main assistant only gains code-session visibility for sessions the principal is allowed to access
- explicit attach/detach prevents accidental transcript cross-talk

Recommended rule:

- same principal can access their own sessions
- privileged operators can inspect sessions if Guardian's policy layer allows it
- cross-user session access is denied by default

## Relationship to the Existing Memory System

Guardian already has a durable memory stack:

- per-agent knowledge base files via `AgentMemoryStore`
- SQLite conversation history via `ConversationService`
- FTS5 search over conversation history
- automatic memory flush from trimmed conversation history into the knowledge base

That existing memory system should be reused, but it is not sufficient by itself to be the canonical store for active coding work.

### What Should Stay in the Existing Memory System

- per-surface conversational transcripts
- durable agent knowledge and lessons learned
- user preferences
- architectural decisions worth reusing later
- searchable historical chat records
- summaries flushed from trimmed conversation context

This is the right home for remembered context.

### What Should Move into a New `CodeSessionStore`

- canonical `CodeSession` records
- `CodeSessionWorkState`
- coding journal/events
- session attachments across web/main chat/Telegram/CLI
- pending approvals and approval decisions
- verification/check results
- artifact references
- changed-file summaries
- compaction archive references
- session-level security and workspace policy

This is the right home for live workflow state.

### Why the Split Matters

The memory system is optimized for remembering and retrieving context. A backend `CodeSessionStore` is optimized for representing the current truth of an active coding workflow.

That distinction prevents two failure modes:

1. treating live workflow state as if it were just more chat history
2. polluting long-lived agent memory with transient operational details such as every pending approval or failing test run

The recommended model is:

- transcripts and durable lessons continue to use Guardian's memory system
- active coding state lives in the backend `CodeSessionStore`
- selected high-value outcomes can still be promoted into the knowledge base when they are actually worth remembering

## Terminals

PTY terminals should remain a separate concern.

For the first backend-owned session rollout:

- keep PTY panes web-only
- keep manual terminal control separate from assistant-driven tool execution
- store terminal metadata under the `CodeSession`
- do not promise Telegram or main-chat remote shell control yet

If remote terminal control is ever added, it should be treated as a separate high-risk capability with stronger approval and isolation, closer to an OpenClaw-style `tmux`/remote-control adapter than a casual extension of chat.

## Migration Plan

### Phase 1: Introduce Backend Session Store

- add `CodeSessionStore`
- add CRUD/read/list APIs
- persist `CodeSession`, `CodeSessionWorkState`, approvals, checks, artifacts, and attachments
- keep current web UI, but change it to load/save sessions from the backend

### Phase 2: Replace Browser-Owned Session Authority

- stop treating browser `localStorage` as authoritative
- keep browser storage only for local UI preferences
- change Code chat to send `codeSessionId`, not authoritative `workspaceRoot`
- derive effective workspace and policy from the backend session

### Phase 3: Add Main-Chat and Telegram Attachment

- add commands and APIs to list/attach/detach/summarize code sessions
- add session summary cards for non-Code channels
- add approval handling for remote channels

### Phase 4: Add Operations View

- expose a cross-session operator view in web
- show active, blocked, awaiting-approval, and failing sessions
- share that backend state with main chat and other channels

### Phase 5: Optional Background Continuation

- allow automation or scheduled tasks to resume a `CodeSession`
- preserve approval gates and audit trail

## Practical User Experience

Example:

1. The user starts a coding session in web for `/srv/shopify-app`.
2. Guardian creates `codeSession:abc123`.
3. Later, from Telegram, the user says "continue the Shopify billing fix".
4. Guardian resolves that request to `codeSession:abc123` using title/workspace/recent-activity metadata.
5. Telegram attaches to that `CodeSession` and continues work.
6. A write approval is needed.
7. The same approval appears in web Code, main chat, and Telegram because it belongs to the session.
8. The user approves in web, and the Telegram-controlled run continues.

That is the target model: one coding session, many surfaces.

## Risks and Tradeoffs

- Backend ownership adds persistence complexity.
- Cross-channel session attachment needs clear identity and authorization rules.
- Remote channels need concise rendering so coding work stays understandable.
- The main assistant must not auto-attach to the wrong coding session when multiple sessions are active.

Those are manageable tradeoffs. They are preferable to keeping the browser as the source of truth for long-running coding work.

## Recommendation

Adopt backend-owned `CodeSession` as the canonical coding work model and treat the web Code page as one client over that runtime.

This proposal should be the architectural bridge between:

- the current shipped Code page spec
- the earlier durable-state direction already described in the OpenDev proposal
- Guardian's broader multi-channel agent strategy

In effect:

- keep the current UI investment
- keep the current repo-scoped sandbox
- move coding session authority into the backend
- let the main agent and remote channels deliberately attach to active coding work

## Related Guardian Documents

- [CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md)
- [MEMORY-SYSTEM.md](/mnt/s/Development/GuardianAgent/docs/guides/MEMORY-SYSTEM.md)
- [OPENDEV-INTEGRATION-AND-CODING-ASSISTANT-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/OPENDEV-INTEGRATION-AND-CODING-ASSISTANT-PROPOSAL.md)
- [DISCORD-CHANNEL-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/DISCORD-CHANNEL-PROPOSAL.md)

## External References

- OpenCode docs: https://opencode.ai/docs/server/
- OpenCode docs: https://opencode.ai/docs/cli/
- OpenHands docs: https://docs.openhands.dev/openhands/usage/developers/websocket-connection
- OpenHands docs: https://docs.openhands.dev/openhands/usage/cloud/cloud-api
- Goose docs: https://block.github.io/goose/docs/guides/managing-goose-sessions
- Claude Code docs: https://docs.anthropic.com/en/docs/claude-code/sdk
- OpenClaw docs: https://docs.openclaw.ai/core-concepts/binding-router
