# General Chat Canonical Coding Sessions — Implementation And Cleanup Plan

**Status:** Draft  
**Date:** 2026-03-27  
**Primary source proposal:** [General Chat As Canonical Coding Surface Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md)  
**Related docs:** [CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md), [BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md), [CODING-ASSISTANT-CURATED-UPLIFTS-IMPLEMENTATION-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/CODING-ASSISTANT-CURATED-UPLIFTS-IMPLEMENTATION-PLAN.md)

## Objective

Reshape Guardian’s coding product into:

1. one canonical chat surface for coding work
2. one backend-owned session model across all channels
3. one workbench-style Code page for files, trust, terminals, and activity
4. one explicit focus model per surface
5. optional external coding backends for Claude Code and Codex

This plan assumes **no backward compatibility requirement** for the old duplicate Code chat model.

The target operator model should stay close to OpenClaw ACP:

- a conversation surface binds to one default coding session at a time
- the system can still list and supervise many sessions globally
- one-off work against another session is explicit rather than magical
- the workbench is not a second chat transport

## Architectural Decision

### Default focus vs global awareness

The system should support:

- many known code sessions
- one default focused session per conversational surface
- explicit targeting of any other session when needed

This means Guardian can know about many coding sessions at once without implicitly mixing all repo contexts into every turn.

### Why this is the right split

Keep one default focused session because:

- repo-scoped tool execution needs one default workspace root
- trust state and approval logic are workspace-scoped
- repo retrieval and working set should have one default anchor
- user intent is clearer for mutating actions

Keep global awareness because:

- users need cross-session summaries and orchestration
- Guardian should be able to supervise work across many repos
- external backend tasks should be launchable against non-focused sessions

## Non-Negotiable Cleanup Rules

- Do not leave the Code page as a second primary chat product.
- Do not keep dual chat architectures for compatibility.
- Do not keep ambiguous surface attachment semantics.
- Do not silently share one implicit focus across unrelated surfaces.
- Do not silently cross from one workspace to another on mutating operations.
- Do not build new coding UX on top of compatibility shims for the old Code chat.

## Current Gaps To Fix

The current codebase is already close, but not clean enough for the target model:

- normal web chat does not expose code-session attach/detach/focus as first-class UI
- the Code page still contains a duplicate chat surface
- web code-session attachment currently defaults to blank `surfaceId` values through [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts), which effectively collapses attachment state to a user/channel scope unless more explicit surface ids are used
- runtime and tool-side surface-id logic are not fully aligned
- code-session APIs still assume the Code page itself is a conversational endpoint
- external coding backends do not exist yet

## Phase 1: Session Semantics Cleanup

### Goal

Make session attachment and focus semantics explicit and consistent before changing the UI shape.

### Deliver

- define explicit surface identities for:
  - web main chat
  - web chat panel
  - web Code workbench
  - CLI
  - Telegram
- standardize surface-id resolution in:
  - [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
  - [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
  - [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
- formalize:
  - known sessions
  - focused session per surface
  - explicit target session override per request
- fail closed when an explicit code session id is invalid

### Likely implementation areas

- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)

### Exit criteria

- each surface has its own stable default focus attachment
- main chat and Code workbench no longer accidentally share one attachment just because they are both `web`
- explicit session targeting works consistently across channels

## Phase 2: Make General Chat Session-Aware

### Goal

Turn normal Guardian chat into the canonical coding chat.

### Deliver

- add session-awareness UI to normal web chat:
  - current attached session badge
  - attach/switch/detach controls
  - optional workspace/session picker
- expose session registry actions in chat-friendly form:
  - list sessions
  - current session
  - attach
  - detach
  - switch focus
- ensure general chat uses the focused session automatically for coding requests
- show clear notices when the chat is attached to a coding session

### Likely implementation areas

- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js)
- [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

### Exit criteria

- users can do coding work from normal chat without opening a duplicate Code chat
- the current workspace/session is obvious
- switching the default workspace from chat is low-friction

## Phase 3: Turn Code Into A Workbench

### Goal

Remove the duplicate Code chat and keep only the capabilities that are uniquely valuable in the Code page.

### Deliver

- remove the assistant chat tab from the Code page
- keep:
  - `Activity`
  - explorer
  - editor/diff
  - terminals
  - trust state/review
  - investigation/impact views
- add actions such as:
  - `Open in Chat`
  - `Attach Chat To This Session`
  - `Show Current Chat Focus`
- clean up stale Code-chat-only state:
  - `activeAssistantTab` assumptions
  - chat history rendering in `code.js`
  - Code-only message send paths

### Likely implementation areas

- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js)
- [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)

### Cleanup target

Remove the need for:

- any separate code-session-only chat transport as a primary user-facing chat path
- duplicated routing mode selectors in Code
- duplicated pending-message rendering logic in Code chat

### Exit criteria

- Code is clearly a workbench, not a second chat app
- no user-facing coding workflow requires the old Code chat

## Phase 4: Cross-Session Awareness And Orchestration

### Goal

Let one chat surface supervise many sessions without implicitly merging all repo contexts.

### Deliver

- session registry summaries with:
  - title
  - workspace root
  - status
  - failing checks
  - pending approvals
  - recent activity
  - bound backend
- commands and UI flows for:
  - summarize blocked sessions
  - inspect another session without switching focus
  - switch focus explicitly
- explicit request-level session targeting for non-focused work

### Likely implementation areas

- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)

### Exit criteria

- Guardian can talk coherently about many sessions at once
- implicit coding actions still go to exactly one default session
- cross-session orchestration is explicit rather than magical

## Phase 5: External Coding Backends V1

### Goal

Add Guardian-managed delegation to Claude Code and Codex without turning Guardian into a wrapper mess.

### Recommended first slice

Implement **one-shot delegated coding tasks** before persistent backend-bound sessions.

### Deliver

- an external coding backend interface, for example:
  - `guardian-native`
  - `claude-code`
  - `codex`
- a bounded task launcher that can:
  - choose a workspace/code session
  - pass a brief
  - launch the backend
  - collect status and outputs
  - surface results in Guardian activity
- initial backend adapters for:
  - Claude Code
  - Codex

### Backend contract

The contract should return structured results, not raw terminal dumps:

- backend name
- session id / task id
- status
- summary
- changed files or diff refs
- tests/build/lint outcomes
- error details

### Likely implementation areas

- new `src/runtime/external-coding/` module family
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)

### Safety rules

- Guardian remains the approval and audit boundary
- backend tasks stay workspace-scoped
- no hidden cross-workspace execution
- backend launch is explicit in UI and activity

### Exit criteria

- Guardian can launch Claude Code or Codex for a bounded task against a chosen session
- operators can see what backend ran and what came back
- failure states are visible and actionable

## Phase 6: Optional Persistent Backend-Bound Sessions

### Goal

Only if Phase 5 proves useful, allow a code session to bind to a default execution backend.

### Deliver

- code session backend field
- backend-aware routing for delegated coding operations
- backend-specific capability checks and health reporting

### Non-goal

Do not start here. This is explicitly later than one-shot delegation.

## API And Runtime Cleanup

### APIs to remove or demote

- remove any code-session-only message transport from the primary workflow path
- remove Code-page-only assumptions from session message flow
- remove old Code-chat-specific payload/state handling once the workbench migration is complete

### Runtime cleanup

- remove duplicate routing mode handling from Code
- unify response-source and progress rendering under normal chat
- remove any leftover “Code chat is special” prompt/routing assumptions that are no longer needed

## Testing And Verification

### Focused tests

- `npx vitest run src/runtime/code-sessions.test.ts`
- `npx vitest run src/runtime/message-router.test.ts`
- `npx vitest run src/runtime/runtime.test.ts`
- `npx vitest run src/channels/channels.test.ts`

### Harnesses

- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`

### Harness follow-up cleanup

Once the duplicate Code chat is removed, rename or replace harnesses that still encode the old product model.

### New scenario coverage

- main web chat can attach, switch, and detach coding sessions
- Code workbench reflects the same current session without being a second chat
- different web surfaces do not accidentally share focus unless intended
- Guardian can summarize many sessions while keeping one default focused session
- Claude Code and Codex delegated tasks return structured status and artifacts

## Success Criteria

This plan is complete when Guardian:

- uses one canonical chat surface for coding work
- keeps the Code page as a workbench, not a second chat app
- supports many known code sessions with one default focused session per surface
- can explicitly target other sessions without implicit context bleed
- can orchestrate Claude Code and Codex as optional coding backends
- does all of the above without compatibility shims for the old duplicate Code chat model
