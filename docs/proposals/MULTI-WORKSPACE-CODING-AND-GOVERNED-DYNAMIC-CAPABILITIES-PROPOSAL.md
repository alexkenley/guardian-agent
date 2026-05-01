# Multi-Workspace Coding And Governed Dynamic Capabilities Proposal

**Status:** Draft
**Date:** 2026-04-08
**Basis:** Comparative review of GuardianAgent against inspected external reference runtimes with stronger session-centric orchestration, multi-session coordination, and provider-session transport patterns, including T3 Code as a useful lower-layer benchmark for delegated coding backend sessions
**Primary Guardian files:**
- `src/runtime/code-sessions.ts`
- `src/tools/builtin/coding-tools.ts`
- `src/runtime/coding-backend-service.ts`
- `src/runtime/intent-gateway.ts`
- `src/tools/registry.ts`
- `src/tools/executor.ts`
- `src/skills/registry.ts`
- `src/skills/prompt.ts`
**Related docs:**
- `docs/guides/CAPABILITY-AUTHORING-GUIDE.md`
- `docs/design/SKILLS-DESIGN.md`
- `docs/design/ORCHESTRATION-DESIGN.md`
- `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md`
- `docs/implemented/BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md`
- `docs/proposals/ORCHESTRATION-AND-DELEGATION-CAPABILITY-UPLIFTS-PROPOSAL.md`
- `docs/proposals/REFERENCE-CODING-RUNTIME-UPLIFT-PROPOSAL.md`

## Executive Summary

Guardian already has durable backend-owned coding sessions, shared same-principal focus, code-session-aware approvals, and bounded coding backend orchestration. That is a stronger security and ownership model than most terminal-first runtimes.

The main gaps exposed by the reference comparison are different:

- Guardian treats code sessions as durable work objects, but still mostly as one focused session per surface at a time rather than as a graph of addressable sessions a user or agent can inspect, compare, and coordinate explicitly.
- Guardian treats external coding backends as bounded one-shot terminal jobs rather than as persistent delegated provider sessions attached to a `CodeSession`.
- Guardian skills are intentionally prompt-only and reviewed. They cannot create new tools at runtime, which is the correct default. However, Guardian currently lacks a governed fallback lane for bespoke task-specific capability authoring when the existing intent route and curated tool catalog are insufficient.

The right uplift is not to make skills more permissive or to auto-load workspace-local executable extensions. The right uplift is:

1. add a session-portfolio model above the existing code-session store
2. add a delegated backend session broker below the existing code-session model so Codex and Claude can run as structured provider sessions rather than one-off terminal invocations
3. keep governed dynamic-capability authoring as a separate follow-on lane beside the existing curated skills and tools model

All three directions should remain runtime-owned, control-plane-audited, approval-aware, and Intent-Gateway-routed.

## Current Guardian Position

### What already exists

Guardian already supports:

- multiple durable backend-owned coding sessions per user
- cross-surface session continuity through `code_session_list`, `code_session_current`, `code_session_create`, `code_session_attach`, and `code_session_detach`
- shared same-principal focus across web, CLI, and Telegram
- per-session workspace trust, workspace maps, recent jobs, verification, changed files, and pending approvals
- bounded external coding backend runs with per-code-session concurrency limits

This means Guardian's gap is not "can it store multiple coding sessions?" It can.

The gap is:

- only one coding session is implicitly focused for repo-local work at a time
- non-focused sessions are durable records, but not first-class runtime peers that the current session can inspect, message, compare, or spawn against without switching focus
- external coding backends are launched as one-shot PTY commands instead of as durable provider sessions with structured events, approval handoff, and resume semantics
- there is no governed runtime path for "invent a temporary capability because the catalog is insufficient"

### Architectural constraints from current specs

The current docs impose hard constraints:

- `docs/design/SKILLS-DESIGN.md` explicitly says a skill cannot bypass Guardian, cannot directly expand capabilities, and cannot create new tools at runtime
- `docs/guides/CAPABILITY-AUTHORING-GUIDE.md` requires new capabilities to live in the owning runtime layer, use control-plane services for mutation, and preserve audit, approvals, and sandbox boundaries
- `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md` requires tool discovery to stay curated and deferred-loaded rather than bypassing `find_tools`
- `docs/design/ORCHESTRATION-DESIGN.md` requires blocked work and delegated follow-up to stay inside the shared orchestration model

Any uplift that weakens those rules would be a regression.

## Comparative Findings

| Area | Guardian today | Reference pattern | Uplift direction |
|---|---|---|---|
| Durable coding sessions | Strong. Backend-owned and cross-surface. | Strong. Sessions are first-class runtime objects. | Keep Guardian's backend-owned session model. |
| Implicit coding focus | One focused session per surface/principal. | One current session, but other sessions remain directly addressable. | Add session portfolio and explicit multi-session operations without losing one primary focus. |
| Cross-session inspection | Partial. List/current/switch exist. | Strong. Session list/history/status/send/spawn/yield are built-in. | Add explicit inspect, compare, and delegated child-session flows. |
| Child coding lanes | Partial. External coding backends exist, but are modeled as backend runs inside one code session. | Strong. Background child sessions have lineage and lifecycle. | Add child session lineage and session graph state. |
| External coding backend transport | Weak. Current model is mostly one-shot terminal delegation. | Strong. Provider sessions stay open and stream structured lifecycle events. | Add a delegated backend session broker with first-class adapters for Codex and Claude. |
| Skills | Strong reviewed prompt guidance. | Broader. Workspace skills, slash-command dispatch, and plugin-shipped skills. | Keep Guardian prompt-skill discipline. Do not copy workspace-autoloaded executable power. |
| Dynamic capability creation | Intentionally absent at runtime. | Looser. Workspace-local skills/plugins and install flows exist. | Add a governed candidate-capability pipeline instead of loosening skills. |
| Safety scanning for extensions | Partial. Strong tool/runtime policy, but no author-and-admit lane for generated capabilities. | Stronger. Extension/skill install paths include dangerous-code scanning and constrained discovery roots. | Add static scanning, isolated testing, approval, provenance, and expiry for generated capability candidates. |

## What Guardian Should Not Copy

Guardian should not copy these patterns directly:

- auto-loading executable workspace extensions from arbitrary project folders
- letting a `SKILL.md` silently widen runtime authority
- installing runtime-capable extensions directly from public registries into the live catalog
- treating slash-command metadata or skill frontmatter as a substitute for the tool control plane
- allowing session-to-session mutation against multiple workspaces implicitly in one turn

Those patterns are acceptable in more permissive runtimes, but they conflict with Guardian's current architecture and security posture.

## Proposal A: Multi-Workspace Coding Session Portfolio

## Goal

Keep one primary coding workspace for implicit repo-local actions, but let a chat or operator explicitly work with multiple coding sessions as addressable runtime objects.

## Why this is needed

Today, users can create several coding sessions, but the active chat can only really "be on" one of them at a time. That is good for safety but weak for orchestration tasks such as:

- compare two repositories without abandoning the current one
- inspect the status of several active coding lanes
- spawn a child coding lane in another workspace while keeping the current workspace as the main focus
- review or merge delegated results from another coding workspace

## Design principles

- Keep one `primary` code session as the implicit mutation root.
- Let additional code sessions be attached as `referenced` or `delegated` sessions.
- Keep Guardian's `CodeSession` as the canonical owner of workspace identity, trust, memory, approvals, and transcript state.
- Treat delegated coding backends as optional runtime adapters beneath a `CodeSession`, not as alternative owners of the workspace.
- Never silently broaden repo-local write authority across all attached sessions.
- Require explicit targeting for work against non-primary sessions.
- Preserve the existing same-principal focus model for ordinary user-facing simplicity.

## Proposed model

Introduce a session-portfolio layer above the current `CodeSessionStore`.

Suggested concepts:

- `primarySessionId`: the single implicit repo-local workspace for the current surface/principal
- `referencedSessionIds`: additional sessions visible for inspect, compare, and read-oriented coordination
- `sessionLinks`: typed relationships such as `comparison`, `delegated_worker`, `verification_lane`, `review_source`
- `lineage`: parent/child relationships for spawned coding lanes

Introduce a delegated backend session broker below the current `CodeSession` model.

Suggested concept:

```ts
interface DelegatedBackendSession {
  id: string;
  codeSessionId: string;
  backendId: 'codex' | 'claude-code' | 'terminal-cli' | string;
  adapterKind: 'codex_app_server' | 'claude_sdk' | 'terminal_cli';
  status: 'connecting' | 'ready' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'closed';
  currentTaskSummary?: string;
  providerSessionId?: string;
  startedAt: number;
  updatedAt: number;
}
```

Suggested relationship model:

```ts
interface CodeSessionLink {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  relation: 'reference' | 'comparison' | 'delegated_worker' | 'verification_lane' | 'review_source';
  createdAt: number;
  createdBy: string;
  active: boolean;
}
```

## Behavioral contract

Primary session:

- default target for repo-local reads, edits, tests, and coding-backend runs
- continues to drive tool-context workspace grounding

Referenced sessions:

- visible in prompt context only as bounded portfolio metadata, summaries, and status objects
- available for inspect, compare, and explicit target selection
- raw repo evidence from non-primary sessions requires explicit inspect or compare targeting rather than ambient injection
- not implicitly writable

Delegated child sessions:

- have explicit lineage back to a parent code session or request
- can run background coding or verification work in a different workspace
- report status and completion through shared orchestration and timeline surfaces

Delegated backend sessions:

- are optional runtime bindings attached to one `CodeSession`
- reuse Guardian-owned workspace/trust/memory state rather than replacing it
- surface provider-side approvals and user-input requests through the shared pending-action model
- emit structured lifecycle and artifact events into the run timeline and code-session work state
- keep the existing `coding_backend_run` terminal path as the generic fallback for non-first-class backends

## New control surface expectations

Guardian should support explicit operations equivalent to:

- list my coding session portfolio
- inspect a specific coding session summary/status
- add or remove a session as a reference to the current coding task
- compare the current coding session with another one
- spawn a child coding lane in another workspace
- start, inspect, interrupt, or resume a delegated backend session attached to a coding lane
- move primary focus without losing referenced sessions

This should remain `IntentGateway`-routed rather than string-matched.

## Session safety rules

- only one session is implicit for mutation per turn
- non-primary session mutation requires an explicit session target
- approvals and pending actions carry the targeted `codeSessionId`
- provider-session approval and continuation flow must still resolve through the shared pending-action and orchestration model
- tool context must label primary vs referenced sessions clearly
- cross-session memory or summary access remains bounded and provenance-aware

## Guardian implementation shape

Primary files:

- `src/runtime/code-sessions.ts`
- `src/runtime/coding-backend-service.ts`
- `src/tools/builtin/coding-tools.ts`
- `src/runtime/intent-gateway.ts`
- `src/runtime/context-assembly.ts`
- `src/runtime/run-timeline.ts`
- `src/runtime/pending-actions.ts`

Recommended additions:

- new `CodeSessionLinkStore` or link support inside `code-sessions.ts`
- new `DelegatedBackendSessionBroker` runtime plus typed backend session records
- first-class provider adapters such as `CodexAppServerAdapter`, `ClaudeSdkAdapter`, and a generic `TerminalCliAdapter` fallback
- new session-summary and session-compare operations
- child coding lane state attached to run timeline and assistant jobs
- prompt-context section that distinguishes primary session, referenced sessions, and child lanes
- typed backend bootstrap and availability descriptors so the runtime can report installed/authenticated/active state truthfully

## Expected outcome

Guardian keeps its safe one-primary-workspace model while gaining true multi-workspace orchestration.

That is the right compromise:

- safety remains implicit
- orchestration becomes explicit

## T3-Inspired Uplift Fit

T3 Code is not the model for Guardian's top-level coding workspace ownership.

Guardian should keep:

- `CodeSession` as the canonical workspace object
- Guardian-owned routing, trust, memory, approvals, and verification
- the shared run timeline and pending-action orchestration

T3 Code is useful as a lower-layer benchmark for delegated backend transport:

- Codex should move from one-shot `codex exec` style delegation toward a persistent adapter over `codex app-server`
- Claude should move from one-shot terminal delegation toward a persistent adapter over the official local Claude SDK/binary session path
- Guardian should reuse the operator's local authenticated Codex and Claude installations where available rather than inventing a parallel provider-auth model

The architectural fit is therefore:

- session portfolio above
- Guardian-owned `CodeSession` in the middle
- T3-inspired delegated backend session broker below

That lets Guardian gain structured provider sessions and subscription-backed local auth reuse without giving up Guardian's stronger shared orchestration and security model.

## Proposal B: Governed Dynamic Capability Authoring

This remains valuable, but it should not gate or be tightly coupled to the multi-workspace and delegated-backend-session rollout above. It is a separate follow-on control-plane and admission track.

## Goal

Create a safe fallback path for bespoke tooling and skill-like guidance when the current intent route and curated tool catalog cannot solve the user's request acceptably.

## Why this is needed

Guardian's current skill model is intentionally static and reviewed. That is correct for default trust.

However, some requests will fall into a gap:

- the Intent Gateway chooses the best existing route, but the available tools are still insufficient
- the user needs a one-off adapter, translator, or workflow
- a prompt-only skill is not enough, but granting arbitrary new runtime authority would be unsafe

The missing capability is not "make skills able to create tools." The missing capability is "create a governed candidate capability artifact and admit it through a controlled lane."

## Capability tiers

Guardian should support three progressively stronger fallback tiers.

### Tier 1: Prompt and workflow artifacts over existing tools

Use when the gap is procedural rather than technical.

Examples:

- a task-specific playbook
- a workflow template over existing tools
- a bounded prompt resource pack

Properties:

- no new runtime authority
- no new tool registration
- can be generated quickly
- may be attached to the current request or saved as reviewed material later

### Tier 2: Ephemeral candidate tool adapters

Use when the gap requires a new typed interface, but the underlying authority still comes from approved primitives such as:

- existing MCP servers
- approved network domains
- approved local binaries
- approved filesystem scopes

Properties:

- generated into a quarantined workspace
- must declare schema, domains, commands, paths, and expected outputs
- must pass static scanning and isolated tests
- expires automatically unless promoted
- admitted into the tool control plane only after explicit approval

### Tier 3: Promotable reviewed capabilities

Use when a candidate capability proves broadly useful.

Properties:

- reviewed and promoted into the curated registry
- documented through normal capability-authoring pathways
- no special runtime bypasses after promotion

## Proposed runtime artifact

Introduce a durable `CapabilityCandidate` model.

Suggested shape:

```ts
interface CapabilityCandidate {
  id: string;
  kind: 'prompt_artifact' | 'workflow_artifact' | 'tool_adapter';
  status: 'draft' | 'scanned' | 'tested' | 'approval_required' | 'active' | 'rejected' | 'expired' | 'promoted';
  summary: string;
  purpose: string;
  sourceRequestId: string;
  sourceIntentRoute: string;
  requestedBy: string;
  authorityClass: 'prompt_only' | 'existing_tools_only' | 'new_runtime_surface';
  requiredTools: string[];
  requiredDomains: string[];
  requiredCommands: string[];
  requiredPaths: string[];
  sandboxProfile: 'read-only' | 'workspace-write' | 'isolated-builder';
  scanSummary?: unknown;
  testSummary?: unknown;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

## Admission pipeline

1. route insufficiency is recognized through normal routing/orchestration, not by bypassing the `IntentGateway`
2. Guardian drafts a candidate capability spec
3. static policy validation checks authority claims, domains, commands, paths, and ownership
4. security scanning runs against generated source and installer metadata
5. isolated tests run in a quarantined workspace
6. operator approval admits the candidate
7. admission is time-boxed and fully auditable
8. successful candidates can later be promoted through the normal curated path

## Hard rules

- skills remain prompt-time guidance only
- no skill can directly create a runtime tool
- no candidate capability bypasses `ToolExecutor`
- no candidate capability bypasses approvals, sandboxing, or audit
- no public-registry install path becomes implicitly trusted
- no workspace-local artifact auto-loads into the live runtime without admission
- dynamic capabilities must declare provenance and expiry

## Guardian implementation shape

Primary files:

- `src/runtime/intent-gateway.ts`
- `src/tools/registry.ts`
- `src/tools/executor.ts`
- `src/skills/registry.ts`
- `src/runtime/pending-actions.ts`
- `src/runtime/control-plane/*`

Recommended additions:

- new `src/runtime/capability-candidates.ts`
- new `src/runtime/capability-candidate-scanner.ts`
- new `src/runtime/capability-candidate-harness.ts`
- new control-plane callbacks and web/CLI inspection surfaces
- optional new intent route for bespoke capability authoring requests

## Safety mechanisms to borrow conceptually from the reference benchmark

The reference runtime has several patterns worth adopting in Guardian-native form:

- dangerous-code scanning before admitting executable extension content
- constrained discovery roots instead of recursively trusting arbitrary workspace folders
- explicit install/update provenance metadata
- separation between prompt skills and runtime plugin/tool behavior

Guardian should borrow those ideas, but apply them under stricter admission rules and without automatic workspace execution trust.

## Recommended rollout

### Track A: Multi-workspace and delegated backend sessions

#### Phase 1

- add typed delegated backend descriptors and a `DelegatedBackendSessionBroker`
- keep the existing `coding_backend_run` path as the generic fallback
- ship a first-class Codex adapter first because it has the cleanest structured local runtime surface

#### Phase 2

- add session portfolio summaries and explicit referenced-session attachments
- add session inspect/compare operations
- add child coding lane lineage and explicit cross-session targeting
- record delegated backend session state in the run timeline and code-session work state

#### Phase 3

- add first-class Claude adapter support
- add explicit delegated-backend session lifecycle operations such as inspect, interrupt, resume, and status
- add operator dashboards for session graphs and delegated backend sessions

### Track B: Governed dynamic capability authoring

#### Phase 1

- add Tier 1 prompt/workflow capability candidates

#### Phase 2

- add candidate capability scanning, testing, and approval state
- add time-boxed Tier 2 tool-adapter admission

#### Phase 3

- add promotion flow from candidate capability to curated capability
- add operator dashboards for capability candidates
- add comparative harnesses to measure under-routing and capability-gap frequency

## Success criteria

Guardian should be able to do all of the following without weakening its current trust model:

- keep one coding workspace as the primary implicit target while referencing several others
- bind a persistent delegated Codex or Claude session to a coding lane without making that provider the owner of workspace state
- spawn child coding lanes in other workspaces with lineage and operator-visible status
- compare or inspect other coding sessions without full focus switching
- generate a prompt or workflow artifact when the current route is insufficient
- generate a quarantined candidate tool adapter, scan it, test it, require approval, and activate it temporarily
- promote successful recurring candidates into the normal curated capability authoring flow

## Final recommendation

Guardian should not copy permissive workspace-local extension behavior.

Guardian should instead implement:

- a multi-workspace coding session portfolio layered on top of the existing backend-owned code-session model
- a T3-inspired delegated backend session broker layered below the existing backend-owned code-session model
- a governed dynamic-capability authoring lane layered beside the current curated skills and tool control plane as a separate follow-on track

That gives Guardian the practical flexibility the reference runtime demonstrates while preserving the architectural strengths Guardian already has:

- authoritative top-level routing
- shared blocked-work orchestration
- curated deferred tool discovery
- backend-owned coding sessions
- approval and sandbox enforcement
- auditable control-plane mutation
