# Cross-Surface Continuity Uplift Plan

**Date:** 2026-03-30  
**Status:** Draft  
**Origin:** Cross-channel continuity and orchestration review after manual testing  
**Key files:** `src/runtime/intent-gateway.ts`, `src/runtime/message-router.ts`, `src/runtime/pending-actions.ts`, `src/runtime/conversation.ts`, `src/runtime/code-sessions.ts`, `src/index.ts`, `src/channels/web.ts`, `src/channels/cli.ts`, `src/channels/telegram.ts`, `web/public/js/chat-panel.js`  
**Primary specs impacted:** `docs/specs/ORCHESTRATION-SPEC.md`, `docs/specs/PENDING-ACTION-ORCHESTRATION-SPEC.md`, `docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md`, `docs/specs/CODING-WORKSPACE-SPEC.md`, `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`, `docs/specs/AUDIT-PERSISTENCE-SPEC.md`, `docs/specs/INTELLIGENCE-IN-DEPTH-SPEC.md`

---

## Goal

Give Guardian one coherent continuity model across its primary user-facing channels without weakening existing trust boundaries.

The target outcome is:

- the same operator can continue the same assistant thread across linked channels
- the assistant keeps the right focus, blockers, and recent objective across those channels
- approvals, auth, policy changes, and trusted execution contexts remain explicitly bounded
- Coding Workspace continuity improves without collapsing code-session identity into ordinary chat

This plan is intentionally about orchestration quality, continuity, and bounded intelligence selection. It is not a proposal to make Guardian universally more permissive.

---

## Non-Goals

- merging every transcript into one raw global conversation log
- making all pending actions resumable from any surface
- weakening approval requirements or policy gates
- treating coding sessions as ordinary chat history
- replacing the Intent Gateway with heuristic routing
- coupling continuity to any one local or external model provider

---

## Why This Work Matters

Current architecture already has several strong pieces:

- canonical pending actions
- backend-owned coding sessions
- canonical user identity on chat surfaces
- shared routing through the Intent Gateway

What it still lacks is a first-class concept for "this is the same ongoing assistant thread across multiple linked surfaces".

Today, Guardian is strong at:

- surface-local continuation
- code-session continuation
- single-surface approval and blocker handling

It is weaker at:

- carrying the same objective across multiple user-facing channels
- distinguishing "same human, different surface" from "different request"
- exposing which blockers are portable across surfaces and which are not
- preserving continuity while still respecting workspace trust, auth, and approvals

---

## Design Principles

1. Continuity is not permission.
2. Shared context is not shared authority.
3. Cross-surface resume must be explicit in the data model, not reconstructed from transcript text.
4. Coding Workspace identity remains separate from ordinary chat identity.
5. The minimum sufficient healthy intelligence layer should be used for continuity-sensitive reasoning.
6. If a continuity feature cannot be made safe, it should remain surface-local.

---

## Target Runtime Model

Guardian should distinguish five different things that are currently too easy to blur together:

### 1. Logical Assistant

The assistant persona/runtime boundary the user is talking to.

Examples:

- main Guardian assistant
- a backend-owned coding session
- a deterministic automation runtime

### 2. Canonical User

The authenticated operator identity that links web, CLI, Telegram, and other surfaces.

### 3. Surface

A concrete channel endpoint with its own rendering and input mechanics.

Examples:

- web main chat tab
- CLI session
- Telegram thread
- web Code page

### 4. Continuity Thread

A new shared runtime concept representing the ongoing user objective across linked surfaces.

It should store a bounded continuity state such as:

- `continuityKey`
- logical assistant id
- canonical user id
- linked surfaces
- current focus summary
- last actionable request summary
- active execution references
- active transferable blockers
- safe cross-surface summary
- timestamps and expiry

This is not a raw transcript merge. It is a bounded orchestration state object.

### 5. Execution Context

A privileged or specialized runtime context that may be referenced by the continuity thread but is not equivalent to it.

Examples:

- attached code session
- active workspace target
- active automation draft
- auth flow
- approval token set

---

## Continuity Policy

Different blocker classes should have different transfer policies.

| Blocker / state | Default cross-surface policy |
|---|---|
| Clarification | Portable across linked surfaces |
| Missing context | Portable across linked surfaces when the missing field is not surface-sensitive |
| Auth provider choice | Portable across linked surfaces |
| Workspace switch | Portable across linked surfaces for the same canonical user |
| Read-only status / run status | Visible across linked surfaces |
| Tool approval | Origin-surface only in phase 1 |
| Coding backend approval | Origin-surface only in phase 1 |
| Policy changes | Origin-surface only |
| Security-sensitive control-plane changes | Origin-surface only or privileged-only |

Later phases may add secure takeover for some approval classes, but only with explicit operator confirmation and full audit logging.

---

## Proposed Architecture Changes

### Uplift 0: Terminology And Spec Alignment

### Problem

The current specs describe:

- pending actions
- code-session attachment
- bounded history
- routing

But they do not describe a shared continuity object across linked surfaces.

### Solution

Add continuity-thread language to the architecture before implementation so later work does not fragment into per-channel patches.

### Required spec deltas

- `ORCHESTRATION-SPEC.md`
  - add a continuity layer between Intent Gateway and pending-action resume
  - define continuity thread vs surface vs execution context
- `PENDING-ACTION-ORCHESTRATION-SPEC.md`
  - define portable vs origin-bound blocker classes
- `INTENT-GATEWAY-ROUTING-SPEC.md`
  - define continuity summary as a gateway input
- `CODING-WORKSPACE-SPEC.md`
  - clarify how code sessions participate in continuity without losing session isolation
- `TOOLS-CONTROL-PLANE-SPEC.md`
  - define approval transfer restrictions and origin-surface invariants
- `AUDIT-PERSISTENCE-SPEC.md`
  - add cross-surface handoff and resume events

---

### Uplift 1: Continuity Thread Store

### Problem

Guardian currently persists:

- conversation history
- pending actions
- code sessions

It does not persist a bounded, channel-independent representation of the current user objective.

### Solution

Introduce a `ContinuityThreadStore` or equivalent extension to the existing runtime state model.

Recommended shape:

```ts
interface ContinuityThreadRecord {
  continuityKey: string;
  assistantId: string;
  canonicalUserId: string;
  linkedSurfaces: Array<{
    channel: string;
    surfaceId: string;
    active: boolean;
    lastSeenAt: string;
  }>;
  focusSummary?: string;
  lastActionableRequest?: string;
  activeExecutionRefs?: Array<{
    kind: 'code_session' | 'automation' | 'pending_action' | 'auth_flow';
    id: string;
  }>;
  safeSummary?: string;
  updatedAt: string;
  expiresAt?: string;
}
```

### Design rules

- one continuity thread per logical assistant and canonical user by default
- individual surfaces can opt out when isolation is required
- continuity state is bounded and summarised, not transcript-complete
- code-session continuity is referenced, not flattened into the general chat thread

### Likely files

- `src/runtime/conversation.ts`
- `src/runtime/pending-actions.ts`
- `src/index.ts`
- new runtime store file if needed

---

### Uplift 2: Gateway And Prompt Inputs

### Problem

The Intent Gateway currently sees:

- current user message
- bounded recent conversation
- summarized active pending action

That is enough for many single-surface repairs, but not enough for reliable linked-surface continuity.

### Solution

Make the continuity thread a first-class bounded gateway input.

The gateway should receive:

- current user message
- current surface identity
- recent surface-local turns
- continuity summary
- active pending actions relevant to this continuity thread
- attached execution context references

### Important rule

The gateway must still classify whether the user is making:

- a fresh request
- a follow-up on the continuity thread
- a clarification answer
- a correction

Continuity context should improve that judgment, not force every turn into a follow-up.

---

### Uplift 3: Shared Resume Semantics With Security Classes

### Problem

The current pending-action model is surface-scoped, which is correct for some blockers but too narrow for others.

### Solution

Keep pending actions surface-aware, but add an explicit continuity-scope policy field such as:

```ts
type PendingActionTransferPolicy =
  | 'origin_surface_only'
  | 'linked_surfaces_same_user'
  | 'explicit_takeover_only';
```

### Rules

- `clarification`, `auth`, and many `missing_context` blockers can use `linked_surfaces_same_user`
- `approval` remains `origin_surface_only` in the first implementation
- privileged operations can opt into `explicit_takeover_only` later
- channels may render the same blocked state differently, but the policy must be server-owned

### Why this matters

This gives Guardian one shared blocked-work model while preserving the boundary between:

- "you may answer this from another channel"
- "you may view this from another channel"
- "you may not approve or resume this from another channel"

---

### Uplift 4: Transcript And UI Behavior

### Problem

Users experience continuity through UI behavior before they understand it through architecture.

### Solution

Make continuity visible and predictable on each surface.

### Web, CLI, and Telegram requirements

- show when the assistant is continuing an active shared thread
- show the active focus summary when it exists
- show when a blocker belongs to another surface and is view-only here
- show the active code session or automation reference without pretending that it is the entire conversation

### Design rule

The same continuity thread does not require the same visible transcript on every client. Different surfaces can keep different local render histories while still sharing bounded orchestration state.

---

### Uplift 5: Coding Workspace Integration

### Problem

Coding Workspace already has strong session identity, but it currently behaves more like a special side channel than a first-class participant in user continuity.

### Solution

Integrate code sessions into the continuity model without collapsing the code transcript into general chat.

### Proposed behavior

- continuity thread may reference the active code session id and focus summary
- ordinary chat can ask about or continue work tied to that code session
- code-session transcript remains authoritative for repo-specific coding turns
- wrong-workspace protection remains enforced through pending actions
- workspace trust review remains session-scoped and cannot be bypassed by continuity alone

### Guardrail

Cross-surface continuity must never cause Guardian to execute repo work in a different workspace because "the user probably meant the same thing".

---

### Uplift 6: Intelligence-In-Depth Integration

### Recommendation

Yes, this should be considered in the same planning pass, but it should be treated as an enabling architecture track, not as a blocker to continuity implementation.

### Why it matters

Continuity quality depends heavily on small but high-frequency judgments:

- is this a fresh request or a continuation
- is this answer resolving a blocker
- is this blocker portable across linked surfaces
- which execution context should be resumed

Those are exactly the kinds of bounded structured decisions that belong in the layered intelligence architecture.

### Integration target

- Layer 0
  - deterministic resumes
  - exact-id control actions
  - approval enforcement
  - policy enforcement
- Layer 1
  - degraded continuity classification when stronger local lanes are unavailable
- Layer 2
  - primary lane for intent classification, blocker-resolution classification, and continuity-sensitive routing judgments
- Layer 3 / Layer 4
  - main assistant loop, synthesis, broader task execution

### Design rule

Continuity state must be model-agnostic. The runtime model cannot assume that one specific provider owns continuity.

### Required spec delta

`INTELLIGENCE-IN-DEPTH-SPEC.md` should explicitly name cross-surface continuity and blocked-work resolution as Layer 2 candidate workloads.

---

### Uplift 7: Security, Audit, And Privacy

### Security invariants

- continuity does not grant cross-surface approval authority
- continuity does not share auth credentials between surfaces
- continuity does not bypass workspace trust review
- continuity does not bypass code-session attachment rules
- continuity summaries must strip unsafe raw tool output and secrets

### Audit events to add

- continuity thread created
- surface linked to continuity thread
- surface detached from continuity thread
- blocker resumed from linked surface
- blocker denied due to origin-surface restriction
- execution context switched within continuity thread
- secure takeover requested
- secure takeover approved or denied

---

### Uplift 8: Metrics And Operator Visibility

### Success metrics

- reduction in wrong-context replies after surface switching
- reduction in "I could not find that" after the operator continues from another linked surface
- no increase in cross-surface approval bypasses
- no increase in wrong-workspace execution
- stable or improved routing accuracy in web, CLI, and Telegram

### Operator tooling

- continuity thread inspector in the web UI
- routing trace fields for `continuityKey`, `continuityRelation`, and transfer-policy decisions
- clearer pending-action diagnostics in logs and traces

---

## Delivery Phases

### Phase 1: Spec And State Foundations

- align specs around continuity-thread terminology
- add bounded continuity state store
- plumb continuity identifiers through routing trace and runtime metadata

### Phase 2: Safe Cross-Surface Continuation

- gateway consumes continuity summary
- clarification/auth/missing-context blockers become portable across linked surfaces
- UI shows shared-thread state and origin-surface restrictions

### Phase 3: Coding Workspace And Automation Integration

- continuity thread references code sessions and automation drafts/runs
- preserve existing workspace-switch and trust-review boundaries
- improve attached-session follow-up behavior from non-Code surfaces

### Phase 4: Intelligence-Layer Uplift

- route continuity-sensitive classification to Layer 2 when available
- add Layer 1 degraded fallback for continuity/routing decisions
- keep deterministic Layer 0 behavior for approvals and exact resumes

### Phase 5: Takeover And Advanced Controls

- evaluate explicit secure takeover for limited approval classes
- add admin/operator controls for continuity links and thread reset

---

## Testing Strategy

### Unit and integration coverage

- continuity thread store tests
- pending-action transfer-policy tests
- gateway classification tests with linked-surface context
- code-session continuity tests
- channel adapter tests for web, CLI, and Telegram

### Harness coverage

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`
- targeted multi-surface continuity harnesses to add

### Manual smoke matrix

- start a request on web, resolve clarification in CLI
- start a request on Telegram, inspect status on web
- attach a coding workspace on web Code, continue from main chat without losing repo context
- verify that approval buttons remain origin-bound in the first phase
- verify that wrong-workspace protection still blocks cross-surface mistakes

---

## Open Questions

1. Should continuity thread linking be automatic for all authenticated first-party surfaces, or opt-in per surface?
2. Should Telegram share the same continuity thread as web and CLI by default, or require an explicit trust setting?
3. How much of the continuity summary should be operator-visible versus runtime-only?
4. Should continuity state expire independently from conversation retention?
5. When a code session is active, should general chat default to that session's focus summary or require explicit recall language from the user?

---

## Recommendation

Proceed with this work as a shared orchestration uplift, not as a set of per-channel fixes.

The right order is:

1. define continuity as a first-class runtime concept
2. classify blocker portability explicitly
3. preserve approval and trust boundaries
4. integrate layered intelligence where it improves bounded routing quality

If done in that order, Guardian should gain the "same assistant across channels" feeling without becoming looser, less auditable, or more likely to execute the wrong thing.
