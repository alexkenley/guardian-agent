# General Chat As Canonical Coding Surface Proposal

**Status:** Draft  
**Date:** 2026-03-27  
**Primary runtime files:** [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts), [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts), [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts), [src/channels/web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts), [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts), [src/channels/telegram.ts](/mnt/s/Development/GuardianAgent/src/channels/telegram.ts)  
**Primary web files:** [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js), [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js), [web/public/js/api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js)  
**Related docs:** [CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md), [BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md), [CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/CODING-ASSISTANT-CURATED-UPLIFTS-PROPOSAL.md)

## Goal

Simplify Guardian’s coding product shape without weakening the underlying coding system:

- make normal Guardian chat the canonical conversational surface for coding work
- keep backend-owned code sessions, workspace trust, repo awareness, approvals, and activity
- turn the current Code page into a workbench rather than a duplicate chat product
- add optional Claude Code and Codex orchestration as external coding backends instead of trying to make Guardian itself a top-of-class coding engine

This should mirror the OpenClaw/ACP mental model as closely as practical:

- many known coding sessions in a registry
- one default focused session per conversation surface
- explicit one-off targeting for other sessions
- normal conversation flow bound to the current session instead of a separate code-only chat transport

## Core Product Posture

Guardian should be the control plane, not the coding celebrity model.

Guardian’s strengths are:

- session ownership
- workspace scoping
- trust and approval controls
- auditability
- run/activity visibility
- cross-surface continuity

Top-class coding agents such as Claude Code and Codex are better treated as optional execution engines that Guardian can launch, supervise, and summarize.

## Clarifying The Session Model

### What “active” should mean

The system should distinguish between:

- **known sessions**: all code sessions the user can list, inspect, and summarize
- **focused session**: the default coding session currently attached to a specific chat surface
- **explicitly targeted session**: a non-focused session named directly in a request or action

The focused session is not “the only workspace Guardian knows about.” It is only the default workspace for implicit coding actions on that surface.

### Why one focused session per surface is still the right default

Implicit coding actions need one unambiguous workspace root because:

- filesystem and shell policy are workspace-scoped
- trust state is workspace-scoped
- retrieved repo evidence and working set should come from one repo by default
- approvals and job status need a single target context
- operators need to know which repo a mutation will hit without guessing

Trying to make one chat implicitly act on multiple workspaces at once creates ambiguity, larger prompts, and higher risk for the most important actions.

### Why awareness of multiple sessions is still useful

Guardian should still be aware of all sessions at the summary level:

- list active coding sessions
- summarize blocked sessions
- inspect recent work, status, approvals, and failing checks across sessions
- launch or supervise backend work for another session without permanently switching the current focus

So the right model is:

- one default focused session per surface
- many visible known sessions in a registry
- explicit cross-session targeting when needed

## Recommended Shape

### 1. General Chat Becomes The Canonical Coding Chat

Normal Guardian chat should be the main conversational surface for coding work.

That means:

- attach chat to a code session
- show the current attached workspace/session clearly
- allow switching or detaching explicitly
- route coding requests through the attached session by default

This removes the product duplication between “general chat” and “Code chat.”

### 2. Code Page Becomes A Workbench

Keep the Code system, but narrow the page to what is uniquely valuable:

- session rail
- explorer
- editor and diff
- terminals
- activity
- trust/repo review
- approvals
- deterministic structure/impact investigation

Remove or de-emphasize:

- the duplicate assistant chat tab
- separate mode/routing controls that duplicate general chat
- a second primary conversational history

The Code page should support actions like:

- `Open attached session in Chat`
- `Switch Chat focus to this session`
- `Show activity / trust / files / terminal`

### 3. Session Registry + Focus Model

Expose two layers clearly:

- **Session Registry**: all known sessions with summary state
- **Current Focus**: the default attached session for the current chat surface

Recommended operator actions:

- `list coding sessions`
- `show current coding session`
- `attach to session <id>`
- `detach from coding session`
- `switch focus to workspace <title/path>`
- `summarize blocked coding sessions`

### 4. External Coding Backends

Guardian should support external coding engines as optional execution backends.

Initial targets:

- Claude Code
- Codex

Guardian’s role:

- launch the backend in a scoped workspace/session
- pass a bounded task brief
- capture status, artifacts, and failures
- enforce approvals at Guardian’s layer where applicable
- summarize and expose results in normal Guardian UX

Do not make Guardian’s own chat pretend to be those tools.

## Options

### Option A: One focused session per surface, registry awareness across all sessions

This is the recommended model.

Pros:

- safe default for implicit actions
- clear operator mental model
- works across web chat, CLI, and Telegram
- still supports multi-session supervision

Cons:

- explicit switching is required when the user changes default workspace

### Option B: No focused session, every coding request must name a session

Pros:

- mechanically explicit
- no ambiguity in principle

Cons:

- too much operator friction
- poor default UX for normal iterative coding work

### Option C: Implicit awareness of many workspaces at once inside one chat

Pros:

- sounds powerful

Cons:

- ambiguous target for file/shell/test actions
- bloated prompt and retrieval context
- worse approval clarity
- higher risk of the wrong repo being touched

This should not be the default model.

## External Backend Modes

### Mode 1: One-shot delegated task

Guardian sends a bounded task to Claude Code or Codex and gets back:

- summary
- changed files or patch refs
- test/build outputs
- failure state

This is the best first step.

### Mode 2: Persistent session backend

Each code session has an execution backend, for example:

- `guardian-native`
- `claude-code`
- `codex`

This is a stronger long-term model, but it should come after the one-shot mode proves useful.

## No-Backward-Compatibility Cleanup Rule

Do not preserve duplicate chat pathways for the sake of compatibility.

The target shape should remove:

- the Code page as a second primary chat product
- duplicate routing/mode selectors for Code chat
- duplicate message transport semantics where one path is enough
- old assumptions that coding UX requires a separate dedicated chat surface

Where behavior changes, update the product cleanly rather than layering compatibility shims.

## Recommendation

Adopt this shape:

1. main Guardian chat becomes the canonical coding chat
2. Code becomes a workbench/activity/trust/editor surface
3. each chat surface has one default focused session, but the system can see many sessions
4. Guardian can orchestrate Claude Code and Codex for bounded coding work
5. persistent external backends per code session can come later if the one-shot mode proves valuable
