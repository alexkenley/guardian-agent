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

**Primary files:** `src/runtime/pending-actions.ts`, `src/runtime/executions.ts`, `src/index.ts`, `src/runtime/intent-gateway.ts`, `src/runtime/chat-agent/intent-gateway-orchestration.ts`

Related execution contract:
- `docs/specs/EXECUTION-STATE-SPEC.md`

Each pending action record stores:
- scope: logical assistant id, canonical user id, channel, and surface id
- current status
- blocker description
- original structured intent summary
- optional resume payload
- optional code session id
- timestamps and expiry

Pending actions are the operator-facing blocker view.

Execution state is the durable request-state view.

Current as-built rule:
- blocked work should be recoverable from the pending action and its paired execution record
- Guardian should not need to rediscover blocked intent from transcript heuristics

Only one active pending action is allowed per logical surface:
- same assistant
- same canonical user
- same channel
- same surface id

A newer blocked request does not silently replace the older active pending action. If it is clearly resolving the same blocked work, Guardian updates the active slot. If it is a genuinely different blocked request, Guardian asks whether to switch the slot.

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
- optional blocker options
- blocker prompt
- original request

That allows short follow-up turns such as:
- `Use Outlook`
- `Gmail`
- `Codex`
- `switch to Test Tactical Game App`
- `okay, now do that`

to be interpreted against the active blocked action instead of raw bounded history alone.

Route-ambiguity clarification contract:
- `field=intent_route` is the shared blocker field for "I am not sure which top-level route you mean"
- when Guardian has a deterministic ambiguity pair, the pending action should also carry explicit `options` and `entities.intentRouteCandidates`
- when the classifier asks for route clarification without a deterministic option set, the runtime still stores `field=intent_route` plus the original request so the answer can resume the same execution-backed task instead of becoming a brand-new request

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

The canonical design is direct resume from the stored pending action rather than trying to reconstruct blocked work from transcript heuristics.

Current continuation priority:
1. active pending action
2. active execution intent
3. continuity-thread fallback such as `lastActionableRequest`
4. clarification if the reference is still ambiguous

For brokered worker approvals, the resume handoff should use structured continuation metadata rather than a synthetic user-like message such as `[User approved ...]`. Approval-backed resume should replay the suspended execution state directly.

Approval-backed execution must not depend only on transient in-memory executor context. The supervisor/runtime must retain a durable or reconstructable execution envelope until the approved action finishes, is denied, or expires; otherwise stale approval controls devolve into misleading missing-context errors.

Clarification-backed resume follows the same rule:
- if Guardian asks a targeted clarification and offers a concrete stored fallback such as `save it inside the current workspace instead`, that fallback must be represented as pending-action state
- a generic continuation reply such as `yes` or `okay` must resume the stored clarified request directly
- Guardian must not force the Intent Gateway to rebuild the clarified action from bounded transcript history alone
- route-ambiguity confirmations follow the same model: the reply should resolve against the stored `intent_route` blocker and then replay the original request on the chosen route instead of executing the short reply text as a separate task

Correction-backed follow-up also follows the same rule:
- if the user is clearly correcting the blocked request, Guardian may use gateway `resolvedContent` or execution-backed prior intent
- if the new turn is classified as `new_request`, Guardian must not silently rewrite it into the blocked task just because it is short

For direct filesystem export/save flows, the runtime must capture the exact assistant output snapshot that is being written. Approval or clarification continuation must reuse that stored snapshot rather than re-reading truncated conversation context after the blocked turn has already changed the transcript.

If the approved prerequisite mutates live tool policy, for example `update_tool_policy add_path`, `add_domain`, or `add_command`, the runtime must apply that policy change to the live executor/runtime before resuming the stored pending action. Resume must not race a stale in-memory allowlist.

## Channel Behavior

### Web

The web chat renders the assistant message normally and uses `pendingAction.blocker.approvalSummaries` to show native `Approve` / `Deny` controls when the blocker kind is `approval`.

Web requirements:
- approval buttons should appear on the same blocked response that asks for approval
- approving or denying from native web buttons must clear the same shared pending approval ids that plain-language `yes` / `no` or `/approve` / `/deny` would clear
- the transcript should only inline blocker UI when the current response carries `response.metadata.pendingAction`
- `/api/chat/pending-action` is the canonical recovery/status fallback when streamed response metadata is missing, delayed, or the page reconnects
- if the web chat exposes a manual `Clear Pending` action, it must clear the shared pending-action record for the visible chat surface and deny any still-pending approvals being surfaced for that same web user/channel; it must not merely hide the local UI while leaving resumable blocked work behind
- the fallback lookup must use the canonical user id and the current chat surface id
- live activity and tooling progress must be request-scoped; a new request in the same coding session must not reuse timeline/status events from an older run
- page, panel, or route changes must not silently drop the visible in-flight / pending-action state for the current Guardian chat surface
- switching the focused coding workspace must not swap the visible Guardian chat transcript; pending actions remain surface-scoped and continue inside the same transcript
- approval buttons for prerequisite policy changes such as `add_path` must be able to continue the same shared pending action after approval instead of stopping at the policy update and leaving the user to restate the original save/export request

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
- approval follow-ups for prerequisite policy changes can also reuse a stored direct-route resume payload, for example `add_path` followed by `fs_write`
- channels no longer need a separate approval-only orchestration model
- if a surface is attached to a coding workspace, approval submission may still need surface-specific routing, but the pending-action model remains the canonical blocked-work contract
- unrelated turns can proceed normally while the approval-backed slot remains durable in shared state

## Design Rule

When a bug is about blocked execution, prerequisites, approvals, clarifications, workspace switching, or cross-turn resume, fix it by extending the shared pending-action system together with execution-state orchestration rather than adding a bespoke per-tool flow.
