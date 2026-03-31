# Pending Action Orchestration Specification

**Status:** Implemented current architecture

## Purpose

Guardian uses a unified `PendingActionStore` to represent blocked work that should resume once the blocker is satisfied.

This replaces the older split between:
- pending clarifications
- chat-layer pending approval arrays
- synthetic continuation shims that tried to reconstruct the previous request from conversation history

The pending-action system is shared across:
- web chat
- CLI
- Telegram

## Core Model

**Primary files:** `src/runtime/pending-actions.ts`, `src/index.ts`, `src/runtime/intent-gateway.ts`

Each pending action record stores:
- scope: logical assistant id, canonical user id, channel, and surface id
- current status
- blocker description
- original structured intent summary
- optional resume payload
- optional code session id
- timestamps and expiry

Only one active pending action is allowed per logical surface:
- same assistant
- same canonical user
- same channel
- same surface id

A newer blocked request replaces the older active pending action unless it is clearly resolving the same action.

Pending-action lookup may also return a portable action from another linked surface for the same assistant and canonical user when the action's transfer policy explicitly allows that.

## Status Model

Pending actions use these statuses:
- `pending`
- `resolving`
- `running`
- `completed`
- `cancelled`
- `expired`
- `failed`

The runtime treats `pending`, `resolving`, and `running` as active.

## Blocker Kinds

Current implemented blocker kinds:
- `approval`
- `clarification`
- `workspace_switch`
- `auth`
- `policy`
- `missing_context`

Typical examples:
- approval required before a tool or coding backend run
- missing email provider choice
- missing coding backend choice
- wrong coding workspace attached for an explicit workspace-targeted coding task
- missing integration authentication
- missing context such as “no active coding session”

## Storage And Durability

The pending-action store is sqlite-backed by default and falls back to memory if sqlite is unavailable.

Current database file:
- `assistant-pending-actions.sqlite`

The store is keyed by logical assistant scope, not by the raw local/external tier process. This means a pending action survives tier selection and can be resumed after a local or external routing decision.

Scope rules:
- pending actions are owned by the user-facing chat surface, not by internal code-session conversation identities
- web lookups resolve against the canonical user id for the surface, not the transient `web-user` request id
- when older or internally-routed paths omit an explicit surface id, runtime lookup may fall back to the default user-surface alias for that same canonical user

## Transfer Policy

Each pending action carries an explicit `transferPolicy`.

Current policies:
- `origin_surface_only`
- `linked_surfaces_same_user`
- `explicit_takeover_only`

Current default behavior:
- `approval` and `policy` blockers default to `origin_surface_only`
- `clarification`, `workspace_switch`, `auth`, and `missing_context` blockers default to `linked_surfaces_same_user`

Rules:
- portability is bounded to the same logical assistant and canonical user
- portability does not weaken approval or policy boundaries
- the continuity-thread model decides which surfaces are linked; transfer policy decides whether a linked surface may satisfy the blocker
- the client-visible `pendingAction` metadata includes `transferPolicy` so operators and channel adapters can explain why a blocker did or did not follow them

## Runtime Contract

### Intent Gateway

The Intent Gateway remains a classifier, not the owner of pending state.

The gateway receives a summarized active pending action:
- id
- status
- blocker kind
- optional field
- optional route
- optional operation
- blocker prompt
- original request

That allows short follow-up turns such as:
- `Use Outlook`
- `Gmail`
- `Codex`
- `switch to Test Tactical Game App`
- `okay, now do that`

to be interpreted against the active blocked action instead of raw bounded history alone.

### Response Metadata

User-facing blocked-work metadata is exposed as:
- `response.metadata.pendingAction`

This replaces the older chat contract based on:
- `response.metadata.pendingApprovals`

`pendingAction` includes:
- status
- blocker kind
- prompt
- optional blocker options
- optional approval summaries
- optional current/target workspace details
- intent summary and original user content
- expiry timestamp

Channels use this metadata as the canonical blocked-work signal.

### Immediate Approval Invariant

If a direct route or tool execution returns `pending_approval`, the same user-visible response must carry `response.metadata.pendingAction`.

That invariant exists so:
- the web UI can render approval buttons on the first blocked response
- CLI can enter its inline approval prompt immediately
- Telegram can attach inline approval buttons without a second synthetic approval turn

The runtime must not rely on a later user message to discover that an approval existed.

### Auto-Resume

When a blocker is satisfied and the original request is still valid, Guardian resumes the stored action directly.

This is different from older behavior that relied on synthetic follow-up messages such as:
- `[User approved the pending tool action(s)...]`

Those message shims may still appear as compatibility behavior in some older paths, but they are not the target architecture. The canonical design is direct resume from the stored pending action.

## Channel Behavior

### Web

The web chat renders the assistant message normally and uses `pendingAction.blocker.approvalSummaries` to show native `Approve` / `Deny` controls when the blocker kind is `approval`.

Web requirements:
- approval buttons should appear on the same blocked response that asks for approval
- approving or denying from native web buttons must clear the same shared pending approval ids that plain-language `yes` / `no` or `/approve` / `/deny` would clear
- `/api/chat/pending-action` is the canonical surface-state fallback when streamed response metadata is missing or delayed
- the fallback lookup must use the canonical user id and the current chat surface id
- switching the focused coding workspace must not swap the visible Guardian chat transcript; pending actions remain surface-scoped and continue inside the same transcript

### CLI

CLI renders the assistant message, then enters the inline approval prompt flow when the active blocker is `approval`.

### Telegram

Telegram renders the assistant message and attaches inline approval buttons when the blocker kind is `approval`.

For non-approval blockers such as clarification or workspace-switch requirements, all channels use the normal chat text flow.

## Coding Workspace Flow

Explicit workspace-targeted coding requests use pending actions to avoid silent execution in the wrong repo.

If the user says:
- `Use Codex in Test Tactical Game App workspace ...`

while the chat is attached to another coding workspace, Guardian:
1. creates a `workspace_switch` pending action
2. tells the user which workspace is current and which workspace was requested
3. refuses to run the coding backend in the wrong workspace
4. resumes the stored request after the workspace switch is completed
5. if the resumed request is still the same delegated coding task, launches or re-prompts for that exact stored task instead of making the user restate it

## Approval Flow

Tool approvals still execute immediately inside `ToolExecutor`, but chat-orchestration state is now tracked through the pending-action model.

This means:
- approval buttons/prompts are driven from one canonical blocked-work object
- approval follow-ups can reuse the original request summary
- channels no longer need a separate approval-only orchestration model
- if a surface is attached to a coding workspace, approval submission may still need surface-specific routing, but the pending-action model remains the canonical blocked-work contract

## Design Rule

When a bug is about blocked execution, prerequisites, approvals, clarifications, workspace switching, or cross-turn resume, fix it by extending the shared pending-action system rather than adding a bespoke per-tool flow.
