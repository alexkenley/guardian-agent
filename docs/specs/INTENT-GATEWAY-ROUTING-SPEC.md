# Intent Gateway And Smart Routing Specification

**Status:** Implemented current architecture

This spec defines how Guardian interprets each incoming user turn, resolves clarification and correction turns, and chooses the local or external chat tier in Auto mode.

It is the authoritative spec for:
- top-level turn interpretation
- clarification and correction handling
- Auto-mode local vs external chat routing
- pre-routed intent metadata reuse across channel dispatch

This spec does **not** define per-tool provider routing. Tool provider routing is a separate control-plane concern.

Shared prompt-footprint and compact-inventory rules live in:
- `docs/specs/CONTEXT-ASSEMBLY-SPEC.md`

## Primary Files

- `src/runtime/intent-gateway.ts`
- `src/runtime/message-router.ts`
- `src/runtime/pending-actions.ts`
- `src/index.ts`
- `src/runtime/direct-intent-routing.ts`

## Goals

- Interpret every normal user turn through one authoritative structured gateway.
- Route Auto-mode chat tiers from structured intent, not raw keyword heuristics.
- Preserve corrections and clarification answers across web, CLI, and Telegram.
- Prevent client-controlled routing metadata from bypassing server-side interpretation.

## Non-Goals

- Replacing approval continuation handling. Approvals remain control-plane resumes.
- Replacing per-tool smart provider routing in the Tools control plane.
- Moving all direct actions into a single giant router. Downstream deterministic handlers still exist after gateway interpretation.

## Turn Pipeline

Normal user-turn flow:

```text
Incoming message
  -> Slash-command parsing in channel adapter, if applicable
  -> Real approval / continuation detection, if applicable
  -> IntentGateway classification
  -> Clarification or correction resolution
  -> Auto-mode tier selection from structured intent result
  -> Dispatch to selected chat agent
  -> Direct deterministic route handling and/or normal tool loop
```

Key rule:
- slash commands and real approval/continuation resumes are the only allowed pre-gateway intercepts
- every other normal turn must be classified by the gateway before capability-specific handling runs

Approval fallback detail:
- plain-text approval detection is a control-plane path
- runtime strips leading UI context wrappers such as `[Context: ...]` before matching fallback approval text
- this fallback exists for cases where a channel cannot use its native approval controls, but the primary UX remains the structured pending-action controls

## Intent Gateway Contract

The gateway returns an `IntentGatewayRecord` with:
- `available`
- `model`
- `latencyMs`
- `decision`

The `decision` is structured and includes:
- `route`
- `confidence`
- `operation`
- `summary`
- `turnRelation`
- `resolution`
- `missingFields`
- `resolvedContent`
- `entities`

### Routes

Current route values:
- `automation_authoring`
- `automation_control`
- `automation_output_task`
- `ui_control`
- `browser_task`
- `personal_assistant_task`
- `workspace_task`
- `email_task`
- `search_task`
- `memory_task`
- `filesystem_task`
- `coding_task`
- `coding_session_control`
- `security_task`
- `general_assistant`
- `unknown`

### Personal Assistant Route Ownership

`personal_assistant_task` is the current route for `Second Brain` and personal productivity work.

Current ownership includes:
- overview reads
- notes
- tasks
- local calendar planning, local calendar CRUD, and provider-backed event context
- people context
- routines
- briefs and follow-up drafts
- personal retrieval across messages, docs, events, and notes

Boundary rules:
- use `automation_authoring` when the user explicitly asks to create an automation, workflow, or scheduled automation in the Automations system
- prefer `personal_assistant_task` when the user is asking for personal productivity help, meeting prep, follow-up drafting, or cross-source personal retrieval
- use `personal_assistant_task` with `personalItemType=routine` when the user explicitly asks for a `Second Brain` routine or names a built-in routine such as `Morning Brief`, `Pre-Meeting Brief`, or `Follow-Up Watch`
- unqualified calendar create, update, or delete requests default to the local `Second Brain` calendar under `personal_assistant_task`
- use `workspace_task` for explicit provider CRUD or administration in Google Workspace or Microsoft 365 surfaces such as `Google Calendar` or `Outlook calendar`
- use `email_task` for direct mailbox reads, replies, sends, forwards, or draft management in Gmail or Outlook

Calendar target metadata:
- `entities.calendarTarget=local` means the user is targeting the local Guardian `Second Brain` calendar
- `entities.calendarTarget=gws` means the user explicitly targeted Google Calendar
- `entities.calendarTarget=m365` means the user explicitly targeted Outlook or Microsoft 365 calendar

Direct-routing note:
- `direct-intent-routing.ts` maps `personal_assistant_task` to the bounded `personal_assistant` candidate
- `chat-agent.ts` may answer simple `Second Brain` reads directly from the shared store without a full tool loop

### Turn Relations

The gateway must classify the current turn as one of:
- `new_request`
- `follow_up`
- `clarification_answer`
- `correction`

### Resolution

The gateway must classify whether the request is:
- `ready`
- `needs_clarification`

When `needs_clarification` is returned, `missingFields` must identify the unresolved requirement.

## Pending Action And Continuity Context

The gateway no longer receives a dedicated pending-clarification object. It receives:
- a summarized active `PendingAction`
- a summarized active continuity thread when one exists

Keying:
- logical assistant context
- canonical user id
- channel
- surface id

This means blocked-work context survives local/external tier selection and remains aligned with the specific chat surface.

Pending-action blocker kinds currently include:
- `approval`
- `clarification`
- `workspace_switch`
- `auth`
- `policy`
- `missing_context`

Gateway behavior:
- if the runtime creates a pending action, the next gateway call sees the blocker summary and original request
- short answers like `Use Outlook`, `Codex`, `switch to Test Tactical Game App`, or `okay, now do that` are interpreted against that active pending action before ordinary bounded-history repair logic
- an active pending action does not automatically make the next turn a follow-up; a clearly different request such as `Check my email.` must still classify as a fresh `new_request`

Current implementation details:
- pending action state is a single active slot per logical assistant context, canonical user id, channel, and surface
- blocked-work state currently uses the same 30 minute TTL family as approval flows
- unrelated turns do not clear the active slot
- if a later turn fully resolves the blocker, the pending action is completed or cancelled
- if a new blocked request collides with the active slot, Guardian asks whether to switch the slot instead of silently replacing it

Continuity summary currently includes:
- continuity key
- linked-surface count
- optional focus summary
- optional last actionable request
- optional active execution refs

This continuity summary is bounded context for the classifier. It is not a second transcript.

## Conversation Context Window

Turn interpretation is not based on the full raw transcript.

Conversation storage and prompt assembly are owned by `ConversationService`.

Current defaults:
- conversation retention: 30 days
- stored turns per active session: 12 user/assistant turns
- stored message cap: 4000 characters per message
- live prompt history cap: 12000 characters total

Intent Gateway prompt inputs:
- the current user message
- the last 6 recent conversation entries, if available
- any summarized active pending action
- any summarized active continuity thread
- enabled provider / coding-backend context

Implications:
- Guardian usually understands recent pivots and short repairs when the relevant request is still inside the bounded history window
- older requests outside that bounded window are not guaranteed to be reconstructable from ordinary conversation history alone
- dropped history can be summarized into the knowledge base, but that summary is not a byte-for-byte replacement for the recent-turn window

## Compact Availability Inventories

The gateway follows the shared context-assembly rule: route-relevant availability data should be compact by default and detailed only when the classifier actually needs more. The authoritative contract for that pattern, including local/external parity and follow-on optimization work, lives in:

- `docs/specs/CONTEXT-ASSEMBLY-SPEC.md`

Gateway-specific application:
- `enabledManagedProviders` stays a compact provider-identity list
- `availableCodingBackends` stays a compact backend-identity list
- pending actions and continuity remain explicit bounded state, not deferred detail

## Correction Handling

Corrections are interpreted by the gateway instead of raw keyword repair logic.

Examples:
- `No, Codex the CLI coding assistant`
- `Claude Code`
- `Use Gmail`
- `the TempInstallTest workspace`

The gateway can return:
- `turnRelation: correction`
- `resolvedContent` containing the repaired actionable request

If `resolvedContent` is present, downstream routing and execution use that repaired request content.

Guardian also uses the latest actionable prior user request from bounded recent history when reconstructing corrections such as:
- `No, Codex the CLI coding assistant`
- `Use Gmail`

This means short correction turns work best when the original actionable request is still present in recent history.

## Auto-Mode Tier Routing

Auto-mode tier routing is owned by `MessageRouter.routeWithTierFromIntent(...)`.

### Inputs

- structured gateway decision
- original or repaired request content
- tier mode
- complexity threshold

### Preference Rules

Hard local preference:
- any request with `entities.codingBackend` and `entities.codingBackendRequested=true`

Attached coding sessions:
- an attached coding session may carry a remembered `agentId`, but tier-tagged session agents such as `local` or `external` do not override gateway-first Auto routing
- explicit coding-backend delegation such as `Use Codex ...` or `Use Claude Code ...` must still prefer the local Guardian tier, because Guardian is orchestrating the CLI rather than acting as the coding model itself
- questions about why Codex or another backend produced a given artifact, permission, diff, or output should not be treated as explicit backend delegation unless the user actually asks Guardian to use that backend for investigation

Local-preferred routes:
- `memory_task`
- `filesystem_task`
- `coding_task`
- `coding_session_control`
- `ui_control`
- `automation_control`

External-preferred routes:
- `browser_task`
- `workspace_task`
- `email_task`
- `search_task`
- `security_task`

Special case:
- `automation_authoring` can still use automation-complexity scoring to choose external when the request is substantially orchestration-heavy

Fallback:
- if no intent-specific preference applies, Auto mode falls back to normal complexity scoring

### Single-Tier Degradation

When only one tier exists:
- Auto mode routes to the available tier
- `local-only` falls back to external if local is unavailable
- `external-only` falls back to local if external is unavailable

This degradation must be explicit and reflected in the route reason.

## Pre-Routed Intent Metadata

The routing layer can classify once before agent dispatch and attach the result to message metadata using the internal key:

- `__guardian_pre_routed_intent_gateway`

Purpose:
- avoid a second gateway call inside the selected agent
- preserve one authoritative interpretation across channel dispatch

Security rule:
- client-supplied pre-routed metadata is not trusted
- server dispatch strips any incoming copy of that metadata key
- only server-computed gateway results may be reattached

## Channel Behavior

Web, CLI, and Telegram all use the same prepare-and-dispatch pattern:

```text
channel message
  -> prepareIncomingDispatch(...)
  -> resolveAgentForIncomingMessage(...)
  -> optional pre-routed gateway metadata attachment
  -> dashboard/runtime dispatch
```

This avoids divergent routing behavior between channels.

## Interaction With Direct Deterministic Handlers

The gateway does not directly execute tools.

After routing:
- deterministic session control handlers
- deterministic memory prerouters
- deterministic automation/browser/output prerouters
- normal chat/tool loop

all consume the structured gateway output rather than re-inferring the user’s intent from raw text.

Direct-lane rule:
- capability-specific deterministic handlers only run from an explicit structured gateway decision
- gateway-unavailable and low-confidence `general_assistant` / `unknown` results do not trigger heuristic capability fallback
- bounded degraded behavior may still exist, but it does not impersonate a successful capability-lane classification
- current bounded degraded exception: explicit trusted `remember` / `save to memory` requests may fall back to the direct memory-save lane when the gateway is unavailable or returns an unstructured `unknown` result; the routing trace and response metadata must keep the original gateway outcome visible instead of pretending `memory_task` was classified successfully

## Observability

Relevant diagnostics:
- `IntentGatewayRecord.latencyMs`
- client-safe `intentGateway` metadata on responses
- route reason and selected tier in routing metadata
- operator-facing run traces from `src/runtime/orchestrator.ts` and `src/runtime/run-timeline.ts`
- durable routing trace files under `~/.guardianagent/routing/intent-routing.jsonl`

The durable routing trace is distinct from the existing run timeline:
- the run timeline is the operator UI story for queueing, approvals, tool progress, verification, and completion
- the routing trace is the low-level decision log for gateway classification, clarification prompts, tier selection, direct-intent candidates, direct tool execution, and final response locality

Current routing trace stages include:
- `incoming_dispatch`
- `gateway_classified`
- `clarification_requested`
- `tier_routing_decided`
- `pre_routed_metadata_attached`
- `direct_candidates_evaluated`
- `direct_tool_call_started`
- `direct_tool_call_completed`
- `direct_intent_response`
- `dispatch_response`

Persistence:
- default path: `~/.guardianagent/routing/intent-routing.jsonl`
- rotation defaults: 5 MB active file, 5 retained files total
- config knob: `routing.intentTrace`

Operator affordances:
- the routing trace is filterable by `continuityKey` and `activeExecutionRef`
- dashboard rows can correlate a routing decision to the matched run, the best-fit execution-timeline event, and the attached coding session when one exists
- routing-trace deep links are allowed to land on `assistantRunId` plus a specific `assistantRunItemId` so operators can open the exact timeline event that best explains the routed outcome

Expected operator-visible behavior:
- clear direct routing when intent is obvious
- one targeted clarification when a required field is missing
- short correction replies repairing the previous misunderstanding instead of starting an unrelated new task
- unrelated questions asked while blocked work exists stay in normal assistant flow without clearing the blocked slot
- unrelated questions asked while no formal continuation state exists are handled as ordinary new turns, using bounded recent history rather than a full workflow stack

## Acceptance Criteria

The implementation is correct when all of the following hold:

- `Use Codex to ...` routes through the intent gateway and prefers the local tier in Auto mode.
- `Check my email.` asks for Gmail vs Outlook only when both providers are enabled and the provider is still unspecified.
- `Use Outlook.` continues the earlier mailbox request instead of creating a new unrelated task.
- approval continuations bypass normal gateway interpretation and resume the suspended action.
- bounded recent history plus active pending-action context are sufficient for short repairs, while a colliding new blocked request requires explicit switch confirmation before it takes over the active slot.
- if only one tier is configured, Auto mode still works without special-case user handling.
- a client cannot inject fake pre-routed intent metadata to override server-side interpretation.

## Verification

Primary automated coverage:
- `src/runtime/intent-gateway.test.ts`
- `src/runtime/message-router.test.ts`
- `src/prompts/guardian-core.test.ts`
- `src/prompts/code-session-core.test.ts`
- integration and channel tests under `src/channels/` and `src/runtime/`

Recommended harness coverage:
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`
