# Multi-Workspace Coding And Governed Dynamic Capabilities — Implementation Plan

**Status:** Active; Phase 0A through Phase 0D foundation implemented on 2026-04-06  
**Date:** 2026-04-06  
**Primary source proposal:** [MULTI-WORKSPACE-CODING-AND-GOVERNED-DYNAMIC-CAPABILITIES-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/MULTI-WORKSPACE-CODING-AND-GOVERNED-DYNAMIC-CAPABILITIES-PROPOSAL.md)  
**Related plans:** [GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md), [BACKGROUND-DELEGATION-UPLIFT-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/BACKGROUND-DELEGATION-UPLIFT-PLAN.md), [SKILLS-QUALITY-DISCIPLINE-UPLIFT-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/SKILLS-QUALITY-DISCIPLINE-UPLIFT-PLAN.md), [CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md)  

## Objective

Deliver two connected uplifts without weakening Guardian's current security model, while adding the routing foundation those uplifts now depend on:

1. extend backend-owned coding sessions into a multi-workspace session-portfolio model
2. add a governed dynamic-capability authoring lane for cases where curated routes and tools are insufficient
3. add a deterministic provider/model-profile selection layer after `IntentGateway` routing so Guardian does not collapse all external work into one generic lane or ask smaller models to make opaque execution-planning decisions at runtime

The implementation should preserve Guardian's current strengths:

- one authoritative top-level `IntentGateway`
- shared pending-action orchestration
- curated deferred tool discovery
- backend-owned code-session identity
- approval and sandbox enforcement
- operator-auditable control-plane mutation

The routing foundation is now in scope for this plan because the current shipped model is still too coarse for the new provider stack:

- Auto mode performs real routing, but only at the `local` vs `external` tier boundary
- inside the external lane, the current runtime prefers `managed_cloud` before `frontier`
- higher-capability frontier models therefore often enter only as a later fallback instead of as the deterministic first choice for harder coding and synthesis work
- smaller local or managed-cloud models are also being asked to carry prompt/context burdens that should instead be bounded by profile-specific context budgets and deterministic direct-answer paths

This plan therefore treats routing, profile selection, and context-budgeting as mandatory pre-foundation work for the later multi-workspace and governed-capability tracks.

## Current Note

One important prerequisite foundation is already landed in the worker transport path.

The `worker message dispatch timed out` failure mode was not an `IntentGateway` classification problem. It was a worker-transport and lane-isolation problem in:

- [src/supervisor/worker-manager.ts](/mnt/s/Development/GuardianAgent/src/supervisor/worker-manager.ts)
- [src/worker/worker-session.ts](/mnt/s/Development/GuardianAgent/src/worker/worker-session.ts)
- [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts)

The landed fix established these invariants:

- worker reuse is keyed by `(sessionId, agentId)` instead of `sessionId` alone
- per-worker dispatch is serialized so overlapping `message.handle` calls cannot overwrite one another's callback state
- suspended-approval tracking uses the concrete worker session key rather than a broad shared session key
- dispatch fails fast when the worker is no longer available instead of silently reusing stale state
- downstream tool execution preserves the route that was already selected upstream, including locally routed Second Brain paths

An additional foundation slice is now landed in the brokered approval path:

- brokered worker approval continuation uses structured control-plane metadata instead of synthetic `[User approved ...]` transcript shims
- approval execution failures no longer ask channels to continue the worker conversation as if the tool had succeeded
- shared pending-action cleanup no longer clears approval-backed blocked state on failed approval execution
- duplicate/stale approval clicks now resolve to the settled job outcome when the approval was already executed, instead of surfacing a misleading missing-context error

This is not the full orchestration uplift yet. The broader direct-resume and shared pending-action unification work below is still required, but this slice removes one concrete source of worker resume drift that would otherwise destabilize multi-workspace child lanes.

This matters directly to this plan.

Both multi-workspace coding lanes and candidate-capability quarantine runs depend on:

- lane-specific worker identity
- serialized dispatch on a worker
- approval resume scoped to the concrete execution lane
- route preservation from upstream routing into downstream tool execution

These worker-transport guarantees should be treated as an already-landed prerequisite for the shared-foundation work in this plan, not as optional cleanup.

## Architectural Position

This plan intentionally does not turn Guardian into an open extension host.

The target design is:

- one implicit mutable coding session per conversational surface
- optional explicit visibility into other coding sessions
- explicit cross-session targeting for non-primary work
- no skill-driven runtime authority expansion
- no workspace-local auto-loaded executable capabilities
- candidate capabilities that are built, scanned, tested, approved, and only then activated

## Session Portfolio Operating Model

This uplift is intentionally not a move to "one chat mutates many repos at once."

The target operating model is:

- `primary`: the current mutable coding session for a surface or lane; repo-local writes, git actions, tests, builds, and shell mutations default here
- `referenced`: additional coding sessions that are visible to the agent for inspect, compare, summarize, and read-oriented reasoning, but are not implicit mutation targets
- `child lane`: an explicit delegated or background execution lane against another coding session or workspace, with its own status, approvals, and lineage back to the parent session/request

In practice:

- if the operator wants to compare repo A and repo B while still editing in repo A, repo A stays `primary` and repo B is `referenced`
- if the operator wants repo B to become the default mutable target, Guardian switches `primary` focus from repo A to repo B
- if the operator wants real concurrent work in repo B while keeping repo A as the foreground workspace, Guardian should start a `child lane` rather than turning one foreground chat lane into an ambiguous multi-repo mutation context

This is how Guardian breaks out of the old "one meaningful coding workspace" limitation without weakening the safety invariant that implicit mutation lands in exactly one workspace per lane.

## Relationship To Existing Plans

### General chat canonical coding sessions

This plan builds on the session-focus cleanup from [GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md).

That plan establishes:

- one canonical coding chat surface
- one backend-owned session model
- one focused session per surface

This plan extends that model with:

- explicit referenced sessions
- child coding lanes
- cross-session inspect/compare flows

### Background delegation uplift

This plan should reuse, not replace, the delegated lineage and follow-up model from [BACKGROUND-DELEGATION-UPLIFT-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/BACKGROUND-DELEGATION-UPLIFT-PLAN.md).

Child coding lanes should appear as another bounded producer of shared delegation state rather than a second delegation subsystem.

### Skills plans

This plan must preserve the current skills discipline:

- skills remain reviewed prompt artifacts
- skills do not create tools at runtime
- dynamic capabilities are a separate runtime-controlled path

## Non-Negotiable Rules

- Do not add regex or ad hoc keyword routing around the `IntentGateway`.
- Do not let a skill widen runtime authority.
- Do not auto-load executable capability content from arbitrary workspace paths.
- Do not silently mutate a non-primary coding session.
- Do not bypass `ToolExecutor`, approvals, audit, or sandboxing for candidate capabilities.
- Do not treat temporary activation as equivalent to permanent promotion.

## Scope

### In scope

- session portfolio metadata above the current code-session store
- explicit primary vs referenced vs delegated coding session semantics
- child coding lanes with lineage and status
- inspect, compare, and explicit target session operations
- candidate prompt/workflow artifacts
- candidate tool-adapter artifacts with quarantine, scanning, testing, approval, and expiry
- operator-visible control-plane surfaces for candidate capability review and promotion

### Out of scope

- auto-installing third-party executable skills or plugins from public registries
- changing Guardian skills to create runtime tools
- unrestricted multi-workspace mutation from one implicit chat context
- collapsing all coding sessions into one shared transcript
- bypassing `find_tools` or promoting all deferred tools to always-loaded

## Program Structure

Run the work in three tracks plus one shared foundation track.

### Track 0: Shared Foundation

- contracts
- routing
- gateway-emitted workload metadata
- deterministic provider/model-profile selection
- context-budget and prompt-footprint policy
- structured continuation and resume semantics
- worker transport and lane identity invariants
- control-plane state
- control-plane service boundaries
- event streaming and replay contracts
- quota and rate-limit policy
- audit and timeline
- test harnesses

### Track R: Intent-To-Execution Model Profile Routing

- extend gateway output with execution-relevant workload metadata without letting the gateway pick raw provider names
- deterministic selection of:
  - tier
  - provider
  - model profile
  - context budget
  - escalation/fallback path
- external-lane subrouting between:
  - managed cloud
  - frontier
- response-quality escalation rules
- route and profile observability in routing trace and run timeline

### Track A: Multi-Workspace Coding Session Portfolio

- explicit referenced sessions
- inspect and compare flows
- child coding lanes
- session graph and lineage

### Track B: Governed Dynamic Capability Authoring

- candidate artifact model
- quarantine build lane
- security and policy checks
- temporary activation
- promotion flow

## Sequencing Principles

- **Keep one implicit mutable target.** Multi-workspace awareness must not become multi-workspace ambiguity.
- **Inspect first, mutate explicitly.** Other sessions are inspectable by default, not writable by default.
- **Use child lanes for real parallel work.** Concurrent work in another workspace should become an explicit lane with lineage, not an implicit second mutable target inside the same foreground chat flow.
- **Do not ask a chat model to pick its own provider.** The gateway may emit workload metadata, but provider/model-profile selection should be deterministic from configured state.
- **Treat gateway and profile selection as one routing pipeline.** The gateway classifies intent and workload shape; the selector deterministically chooses the concrete execution profile from current configuration.
- **Guard capability growth at runtime.** Build is separate from activate. Activate is separate from promote.
- **Bound context to the selected profile.** Smaller local or managed-cloud models should receive smaller, profile-appropriate context footprints rather than the same prompt burden as frontier models.
- **Server-owned truth only.** Chat surfaces, CLI, and Code are clients of runtime state, not separate owners.
- **Reuse shared orchestration.** Child coding lanes and candidate activation must project into existing pending-action, timeline, and audit systems.

## Execution Path And Decision Points

Target path after the routing uplift:

```text
Incoming message
  -> Slash-command parsing / real approval resume only
  -> IntentGateway classification
       returns:
       - route
       - turn relation / resolution
       - entities
       - workload metadata / execution hints
  -> Deterministic tier routing
       chooses:
       - auto/local/managed cloud/frontier mode outcome
       - allowed tier set
  -> Deterministic provider/model-profile selection
       chooses from configured providers:
       - provider
       - model profile
       - context budget
       - fallback/escalation plan
  -> Context assembly for selected profile
  -> Direct deterministic handler and/or normal tool loop
  -> Response-quality evaluation
       if needed:
       - deterministic escalation to a stronger configured profile
  -> Final response + trace/timeline metadata
```

Design rule:

- the `IntentGateway` remains the authoritative front door for turn classification
- the new provider/model-profile decision point is part of the same server-side routing pipeline
- the provider/model-profile selector should be deterministic and driven by:
  - gateway output
  - current configured providers
  - operator policy
  - user-forced chat mode
  - available tool/coding-session context
- the selector should not be an opaque second LLM deciding raw provider names at runtime

## Configuration Direction

This plan should not immediately remove the current provider defaults. They are still needed as deterministic anchors while the profile selector is introduced.

Direction:

- keep configured provider entries as the low-level source of truth
- keep routed defaults for:
  - `local`
  - `managedCloud`
  - `frontier`
- introduce a higher-level selection-policy layer above them so users influence the auto decision without editing raw provider names for every behavior
- treat the current defaults as advanced fallback anchors, not as the only routing control

Likely UI/control-plane direction:

- basic view:
  - preferred auto behavior and routing policy
  - whether hard coding/search tasks escalate directly to frontier
  - whether lighter external tasks prefer managed cloud
- advanced view:
  - explicit provider entries
  - per-tier routed defaults
  - model-profile and context-budget overrides
  - escalation/fallback policy

This means the current defaults should probably survive in the runtime model, but the user-facing configuration can become simpler and more policy-oriented over time.

## Phase 0A: Intent Gateway Workload Contract

### Goal

Extend `IntentGateway` so it remains the authoritative top-level router while also emitting the structured workload metadata needed for deterministic provider/model-profile selection.

### Delivery posture

Treat this as the first mandatory foundation slice. The rest of the routing uplift should not proceed until the gateway contract clearly distinguishes:

- route ownership
- turn continuity
- workload shape
- likely context burden
- cases that warrant direct deterministic handling instead of expensive model synthesis

### Deliver

- update [INTENT-GATEWAY-ROUTING-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md) so the gateway contract explicitly covers:
  - route classification
  - tier preference
  - execution/workload metadata
  - the handoff into deterministic provider/model-profile selection
- define structured workload fields on the gateway output, for example:
  - `executionClass`
  - `requiresRepoGrounding`
  - `requiresToolSynthesis`
  - `expectedContextPressure`
  - `preferredAnswerPath` such as `direct`, `tool_loop`, or `chat_synthesis`
- keep provider-name choice out of the raw LLM classifier result
- define the routing-trace stages for the new routing slice, for example:
  - `gateway_classified`
  - `tier_routing_decided`
  - `profile_selection_decided`
  - `context_budget_decided`
- document how direct deterministic handlers continue to consume gateway output without bypassing it

### Likely implementation areas

- [docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md)
- [docs/specs/CONTEXT-ASSEMBLY-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXT-ASSEMBLY-SPEC.md)
- [src/runtime/intent-gateway.ts](/mnt/s/Development/GuardianAgent/src/runtime/intent-gateway.ts)
- [src/runtime/message-router.ts](/mnt/s/Development/GuardianAgent/src/runtime/message-router.ts)
- [src/runtime/direct-intent-routing.ts](/mnt/s/Development/GuardianAgent/src/runtime/direct-intent-routing.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)

### Exit criteria

- the gateway remains the one authoritative turn classifier
- provider/model-profile selection has the structured routing inputs it needs
- low-context direct-answer opportunities are visible before the runtime commits to a weaker synthesis model
- the spec explicitly documents the new gateway-to-selector handoff

## Phase 0B: Deterministic Provider And Model Profile Selection

### Goal

Replace the current coarse `local` vs `external` execution choice with a deterministic selector that maps gateway output and configured providers to a concrete provider/model profile.

### Deliver

- introduce a runtime-owned `ModelProfile` or `ExecutionProfile` concept above raw provider entries
- make the selector deterministic from:
  - gateway route and workload metadata
  - user-forced chat mode
  - configured providers
  - configured per-tier defaults
  - operator routing policy
  - coding-session / tool-context state
- explicitly subroute the external tier between:
  - `managed_cloud`
  - `frontier`
- ensure `auto` can select frontier as the first execution profile for harder coding/search/synthesis work instead of always trying managed cloud first
- keep forced chat modes as hard overrides:
  - `local`
  - `managed cloud`
  - `frontier`
- define deterministic degradation behavior when:
  - a preferred tier has no configured provider
  - only one tier is configured
  - only one provider exists inside a tier
- define deterministic response-quality escalation rules for retrying on a stronger configured profile when the first profile underperforms

### Important rule

Smaller local or managed-cloud models should not be responsible for deciding which provider/model profile should handle the request. That selection belongs to the server-side selector, not the chat model being selected.

### Likely implementation areas

- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/runtime/message-router.ts](/mnt/s/Development/GuardianAgent/src/runtime/message-router.ts)
- [src/llm/provider-metadata.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-metadata.ts)
- [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts)
- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)

### Exit criteria

- `auto` no longer means “pick managed cloud first for any external work”
- provider/model-profile choice is deterministic and traceable
- forced modes remain explicit and understandable
- smaller models are not relied on to perform orchestration-quality provider selection

## Phase 0C: Context Budgets And Profile-Aware Prompt Assembly

### Goal

Prevent smaller or cheaper profiles from failing simply because Guardian handed them the same context burden as a stronger frontier model.

### Deliver

- define per-profile context budgets, including:
  - compact availability inventory limits
  - session-summary limits
  - tool-result summarization policy
  - direct-answer vs synthesis thresholds
- make prompt assembly consume the selected profile and its budget rather than one generic chat footprint
- bias repo-search and similar tasks toward:
  - deterministic search
  - path/snippet summaries
  - minimal synthesis burden
- define when the runtime should skip weaker-profile synthesis and escalate directly to a stronger configured profile
- keep profile-aware context assembly deterministic and observable

### Likely implementation areas

- [docs/specs/CONTEXT-ASSEMBLY-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXT-ASSEMBLY-SPEC.md)
- [src/runtime/context-assembly.ts](/mnt/s/Development/GuardianAgent/src/runtime/context-assembly.ts)
- [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts)
- [src/chat-agent-helpers.ts](/mnt/s/Development/GuardianAgent/src/chat-agent-helpers.ts)
- [src/worker/worker-llm-loop.ts](/mnt/s/Development/GuardianAgent/src/worker/worker-llm-loop.ts)

### Exit criteria

- smaller models receive bounded, profile-appropriate context
- deterministic repo-grounded flows do not overuse synthesis
- frontier escalation is driven by policy and workload shape instead of only by a bad final answer

## Phase 0D: Contract And Dependency Alignment

### Goal

Define the shared contracts and sequencing dependencies before runtime behavior changes.

### Delivery posture

Treat this phase as mandatory pre-flight work, not optional groundwork.

Tracks R, A, and B should not start landing new runtime behavior above the routing foundation until Phases 0A through 0D have removed the worker-resume fragility and enforced worker-spawn backpressure in the shared execution path.

### Deliver

- align this plan with:
  - [GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/GENERAL-CHAT-CANONICAL-CODING-SESSIONS-IMPLEMENTATION-PLAN.md)
  - [BACKGROUND-DELEGATION-UPLIFT-PLAN.md](/mnt/s/Development/GuardianAgent/docs/plans/BACKGROUND-DELEGATION-UPLIFT-PLAN.md)
  - [SKILLS-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/SKILLS-SPEC.md)
  - [TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)
- define draft types for:
  - `CodeSessionLink`
  - `CodeSessionPortfolio`
  - `CapabilityCandidate`
  - candidate scan/test/admission records
- define canonical event records for:
  - child coding-lane lifecycle
  - candidate build/scanning/testing/admission
  - live subscription and replay projections
- replace synthetic string-based worker continuation detection with a structured contract, for example:
  - metadata flagging a control-plane continuation message, or
  - a dedicated shared orchestration resume route
- keep failed approval execution as a first-class blocked/failure state rather than auto-continuing with a synthetic follow-up turn
- replace transient `ToolExecutor.pendingApprovalContexts` with a durable or reconstructable approval-execution envelope so approved actions do not fail with `No pending context found` after process/worker drift, stale controls, or delayed approval
- decide whether candidate-capability authoring gets:
  - a new top-level intent route, or
  - an operation under an existing architectural route
- record the already-landed worker transport prerequisites as part of the shared execution contract:
  - `(sessionId, agentId)` worker identity
  - serialized worker dispatch
  - worker-session-key-scoped suspended approvals
  - route preservation into downstream tool execution
- define quota and backpressure rules for:
  - child coding-lane spawn
  - concurrent candidate builds
  - temporary activation and promotion actions
- wire worker-spawn admission to the existing `AgentIsolationConfig.workerMaxConcurrent` limit and add child-lane-specific fairness rules such as:
  - per-principal limits
  - per-parent-session limits
  - bounded verification-lane recursion
- establish the control-plane ownership rule:
  - web, CLI, and channel adapters stay thin
  - portfolio mutation, candidate admission, and activation/promotion live in runtime or control-plane services rather than route handlers
- define lineage fields by extending the existing delegated-worker metadata path instead of inventing a parallel store:
  - `requestId`
  - `parentRunId`
  - `originSurfaceId`
  - parent/child code-session identifiers

### Likely implementation areas

- [docs/specs/ORCHESTRATION-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/ORCHESTRATION-SPEC.md)
- [docs/specs/SKILLS-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/SKILLS-SPEC.md)
- [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)
- [src/runtime/intent-gateway.ts](/mnt/s/Development/GuardianAgent/src/runtime/intent-gateway.ts)
- [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts)
- [src/supervisor/worker-manager.ts](/mnt/s/Development/GuardianAgent/src/supervisor/worker-manager.ts)
- [src/worker/worker-session.ts](/mnt/s/Development/GuardianAgent/src/worker/worker-session.ts)
- [src/chat-agent.ts](/mnt/s/Development/GuardianAgent/src/chat-agent.ts)

### Exit criteria

- one agreed contract vocabulary for portfolio sessions and capability candidates
- no conflict with the existing skill and tool-control-plane rules
- implementation phases can land incrementally without architectural ambiguity
- event and quota contracts are defined before UI surfaces depend on them
- worker resumes no longer depend on ad hoc message text matching
- worker concurrency limits are enforced in the spawn path before child-lane fan-out is enabled

## Phase 1: Session Portfolio Core Model

### Goal

Add explicit portfolio state above the current one-primary-session model without breaking existing attachment semantics.

### Deliver

- extend the code-session runtime to support:
  - one primary session
  - zero or more referenced sessions
  - typed links between sessions
- store relationships such as:
  - `reference`
  - `comparison`
  - `delegated_worker`
  - `verification_lane`
  - `review_source`
- keep current attach/detach behavior for the primary session intact
- add read-only portfolio summary projection for chat, CLI, and web

### Likely implementation areas

- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/tools/builtin/coding-tools.ts](/mnt/s/Development/GuardianAgent/src/tools/builtin/coding-tools.ts)
- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [src/channels/web-runtime-routes.ts](/mnt/s/Development/GuardianAgent/src/channels/web-runtime-routes.ts)

### Data model direction

Suggested additions:

- `code_session_links` persistence table or equivalent durable store
- portfolio summary API per principal/surface
- session summary payload that distinguishes:
  - `primary`
  - `referenced`
  - `child/delegated`

### Exit criteria

- existing primary focus behavior still works
- referenced sessions can be attached and removed without becoming implicit mutation roots
- operators can tell whether another workspace is `referenced` or running as a `child/delegated` lane
- portfolio state is durable and inspectable

## Phase 2: Intent Gateway And Tooling For Explicit Multi-Session Operations

### Goal

Make cross-session work an explicit routed capability rather than a prompt convention.

### Deliver

- extend `IntentGateway` so it can reliably distinguish:
  - current-session navigation
  - list/inspect other sessions
  - compare sessions
  - add/remove referenced sessions
  - explicit cross-session targeting
- add or extend tools for:
  - portfolio summary
  - session inspect
  - session compare
  - reference add/remove
- define a strict execution `TargetingContext` that is carried from routing into execution, including:
  - targeted `codeSessionId`
  - targeted workspace root
  - target role such as `primary`, `referenced`, or `child`
  - whether mutation is allowed for that target
- require `ToolExecutor` and pending-action state to use `TargetingContext` as the execution pin so ambiguous prose cannot silently retarget the lane
- ensure the model sees clear tool descriptions that reinforce:
  - one primary session for implicit mutation
  - explicit targeting required for non-primary mutations

### Likely implementation areas

- [src/runtime/intent-gateway.ts](/mnt/s/Development/GuardianAgent/src/runtime/intent-gateway.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/tools/builtin/coding-tools.ts](/mnt/s/Development/GuardianAgent/src/tools/builtin/coding-tools.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

### Exit criteria

- natural-language requests for inspect/compare/reference/session-target actions route consistently
- ambiguous multi-workspace mutation requests fail closed or ask for clarification
- explicit target session requests carry the targeted `codeSessionId` through execution and pending-action state
- execution remains pinned to the structured target even when the model response text is vague or shifts wording mid-turn

## Phase 3: Prompt Context And Safety Semantics For Multi-Session Coding

### Goal

Teach Guardian how to reason about several coding sessions without confusing their scopes.

### Deliver

- update context assembly to expose:
  - primary session summary
  - bounded referenced-session summaries
  - child lane status summaries
- preserve compaction state per session and render it as distinct labeled blocks rather than flattening several workspaces into one shared summary
- label each session in prompt context by role
- ensure tool context and prompt context agree on:
  - current mutable workspace
  - non-primary inspect-only sessions
- keep code-session memory scope explicit per session

### Likely implementation areas

- [src/runtime/context-assembly.ts](/mnt/s/Development/GuardianAgent/src/runtime/context-assembly.ts)
- [src/tools/tool-context.ts](/mnt/s/Development/GuardianAgent/src/tools/tool-context.ts)
- [src/prompts/code-session-core.ts](/mnt/s/Development/GuardianAgent/src/prompts/code-session-core.ts)
- [src/prompts/guardian-core.ts](/mnt/s/Development/GuardianAgent/src/prompts/guardian-core.ts)

### Exit criteria

- the model can discuss multiple sessions coherently without losing the primary workspace anchor
- prompt context never implies that referenced sessions are implicit mutation targets
- session-scoped memory stays unambiguous
- compacted summaries from different sessions cannot bleed into one another in prompt context

## Phase 4: Child Coding Lanes And External Backend Lineage

### Goal

Turn background coding work in another workspace into a first-class child lane rather than an opaque backend run.

### Deliver

- define child coding-lane lineage back to:
  - originating request
  - originating code session
  - principal/surface
- reuse the existing delegated-worker job path as the first lineage carrier, extending it with:
  - `parentRunId`
  - explicit child session identifiers
  - explicit parent session identifiers
- allow explicit spawning of child coding lanes into another workspace or session
- enforce bounded concurrency for child lanes, for example by:
  - principal
  - parent session
  - workspace or portfolio
- project child-lane status into:
  - assistant jobs
  - run timeline
  - code-session summaries
- persist machine-readable child-lane lifecycle events so Guardian can:
  - stream live status updates
  - replay prior lane execution for operators
  - attach delegated results to the parent timeline without lossy transcript scraping
- keep one-shot external coding backend runs supported, but let them report through the child-lane model when they operate outside the primary workspace

### Likely implementation areas

- [src/runtime/coding-backend-service.ts](/mnt/s/Development/GuardianAgent/src/runtime/coding-backend-service.ts)
- [src/runtime/code-sessions.ts](/mnt/s/Development/GuardianAgent/src/runtime/code-sessions.ts)
- [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts)
- [src/runtime/assistant-jobs.ts](/mnt/s/Development/GuardianAgent/src/runtime/assistant-jobs.ts)
- [src/supervisor/worker-manager.ts](/mnt/s/Development/GuardianAgent/src/supervisor/worker-manager.ts)
- [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts)

### Exit criteria

- background work against another workspace is no longer just “a backend session happened”
- users and operators can see which child lane belongs to which parent session
- child lane completion uses the shared delegated-result and follow-up rules
- child-lane fan-out is bounded by explicit quotas rather than accidental unlimited spawning
- lane status can be inspected live and replayed after completion

## Phase 5: Candidate Capability Model And Quarantine Build Lane

### Goal

Create the runtime-owned artifact model for bespoke capability authoring without activating anything yet.

### Deliver

- keep capability authoring out of the general `ChatAgent` control flow by introducing a dedicated authoring lane or agent role that is only reachable through structured routing
- add a durable `CapabilityCandidate` store
- define candidate kinds:
  - `prompt_artifact`
  - `workflow_artifact`
  - `tool_adapter`
- create a Guardian-owned quarantine location, for example:
  - `~/.guardianagent/capability-candidates/<id>/`
- record provenance:
  - source request
  - source route
  - requested authority
  - required tools/domains/commands/paths
  - owner principal
  - expiry
- emit a build manifest and evidence bundle for each candidate, including:
  - generated files
  - declared authority contract
  - build timestamps and owner
  - pointers to scan/test/admission records
- add a build-only pipeline that can generate candidate artifacts into quarantine

### Likely implementation areas

- new `src/runtime/capability-candidates.ts`
- new `src/runtime/capability-candidate-store.ts`
- new dedicated capability-authoring runtime or agent entrypoint
- [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts)
- [src/runtime/intent-gateway.ts](/mnt/s/Development/GuardianAgent/src/runtime/intent-gateway.ts)
- [src/runtime/pending-actions.ts](/mnt/s/Development/GuardianAgent/src/runtime/pending-actions.ts)
- [src/agent/](/mnt/s/Development/GuardianAgent/src/agent)

### User workflow contract

The expected interaction should be:

1. Guardian identifies that the current catalog is insufficient.
2. Guardian asks whether it should author a candidate capability.
3. If the user approves, Guardian builds it in quarantine only.
4. Guardian runs checks and reports the results.
5. The user can then choose discard, temporary activate, or promote.

### Exit criteria

- Guardian can build candidate artifacts without activating them
- all candidate artifacts are durable, auditable, and easy to inspect
- build is clearly separated from activate/promote

## Phase 6: Guardian Policy Checks, Security Scanning, And Isolated Tests

### Goal

Make Guardian itself the admission gate for generated capabilities.

### Deliver

- add Guardian rule-set checks for candidate capabilities:
  - requested commands vs allowlists
  - requested domains vs allowed domains
  - requested filesystem scopes
  - requested authority class
  - trust-boundary conflicts
- add static scanning for generated source/artifacts
- add isolated execution tests in a quarantined sandbox
- emit machine-readable scan/test records
- rate-limit and quota-govern privileged candidate-control actions such as:
  - author/build
  - import-like ingestion
  - activation
  - promotion
- block activation on critical failures by default

### Likely implementation areas

- new `src/runtime/capability-candidate-scanner.ts`
- new `src/runtime/capability-candidate-harness.ts`
- [src/guardian/](/mnt/s/Development/GuardianAgent/src/guardian)
- [src/sandbox/](/mnt/s/Development/GuardianAgent/src/sandbox)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- [scripts/](/mnt/s/Development/GuardianAgent/scripts)

### Security stance

Guardian should enforce several gates, not one:

- policy gate
- static scan gate
- isolated test gate
- approval gate
- activation gate
- promotion gate

### Exit criteria

- a candidate can be blocked by Guardian policy before activation
- failing scan/test results are explicit and user-visible
- no candidate activation path bypasses sandbox or approval logic
- privileged candidate-control actions are bounded against spam, runaway retries, and unsafe fan-out

## Phase 7: Temporary Activation And Time-Boxed Admission

### Goal

Allow approved candidates to be used temporarily without making them permanent.

### Deliver

- add explicit temporary activation state
- activation should bind:
  - candidate id
  - owner principal
  - activation scope
  - expiry
- admit temporary tool adapters into the live tool plane only through runtime-owned registration
- ensure temporary activations:
  - appear in `/api/tools` style inventories
  - remain auditable
  - can be revoked
  - expire automatically
- add an automatic policy-cleanup job for temporary activations so revocation or expiry removes any temporary tool-policy or allowlist mutations from the live registry in the same transactional change

### Likely implementation areas

- [src/tools/registry.ts](/mnt/s/Development/GuardianAgent/src/tools/registry.ts)
- [src/tools/executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- new activation support under `src/runtime/capability-candidates.ts`
- control-plane routes in [src/channels/web-runtime-routes.ts](/mnt/s/Development/GuardianAgent/src/channels/web-runtime-routes.ts)

### Hard rules

- temporary activation does not equal permanent registration
- activation never converts a candidate into a skill
- temporary tools still participate in `find_tools` and ordinary policy enforcement
- activation is denied if the candidate requests authority beyond its approved contract
- revocation or expiry must not leave orphaned `update_tool_policy` effects or stale live-registry entries behind

### Exit criteria

- users can temporarily activate an approved candidate safely
- temporary capabilities expire or can be revoked cleanly
- the live tool catalog can describe why a capability is temporary and when it expires
- expiry or revocation performs registry and policy cleanup atomically enough that temporary authority does not linger after deactivation

## Phase 8: Promotion And Permanent Capability Authoring Flow

### Goal

Turn successful candidates into curated first-class capabilities only through an explicit promotion step.

### Deliver

- add a promotion workflow that can:
  - copy reviewed content into the right permanent location
  - create or update the correct manifest/config metadata
  - require explicit approval separate from activation
  - emit audit records
- promotion targets should differ by candidate kind:
  - prompt/workflow artifacts may promote into reviewed skill/resource locations
  - tool adapters should promote through the normal capability-authoring path, not ad hoc runtime state

### Likely implementation areas

- [docs/guides/CAPABILITY-AUTHORING-GUIDE.md](/mnt/s/Development/GuardianAgent/docs/guides/CAPABILITY-AUTHORING-GUIDE.md)
- [src/skills/](/mnt/s/Development/GuardianAgent/src/skills)
- [src/tools/](/mnt/s/Development/GuardianAgent/src/tools)
- control-plane callbacks in [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)

### Exit criteria

- permanent promotion is an explicit operator-approved action
- promoted artifacts land in the correct curated locations
- the runtime no longer depends on quarantined candidate state after promotion

## Phase 9: Control-Plane And UX Surfaces

### Goal

Make both uplifts operable and inspectable from the existing Guardian surfaces.

### Deliver

- web UI surfaces for:
  - current session portfolio
  - referenced sessions
  - child coding lanes
  - candidate capability inventory
  - scan/test/admission state
  - temporary activation and promotion actions
- CLI surfaces for:
  - inspect portfolio
  - inspect candidate
  - activate/revoke/promote candidate
- server-owned live update surfaces for:
  - child coding-lane lifecycle events
  - candidate build/scanning/testing/admission events
  - replay of prior lane or candidate evidence from persisted records
- timeline and audit visibility for:
  - child coding lane lifecycle
  - candidate build/scanning/testing
  - activation/promotion/revocation

### Likely implementation areas

- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [src/channels/web-runtime-routes.ts](/mnt/s/Development/GuardianAgent/src/channels/web-runtime-routes.ts)
- [web/public/](/mnt/s/Development/GuardianAgent/web/public)
- [src/channels/cli.ts](/mnt/s/Development/GuardianAgent/src/channels/cli.ts)
- [src/runtime/run-timeline.ts](/mnt/s/Development/GuardianAgent/src/runtime/run-timeline.ts)

### Exit criteria

- operators can inspect the session graph and candidate-capability pipeline without digging into raw files
- privileged actions stay ticket-gated
- UI surfaces are informative without becoming the source of truth
- live status views do not depend on scraping chat transcripts; they are backed by persisted runtime events

## Testing Strategy

### Unit and service tests

- gateway workload-metadata classification
- deterministic provider/model-profile selection
- per-profile context-budget selection and prompt assembly
- `CodeSessionStore` portfolio and link semantics
- explicit target-session validation
- prompt-context primary vs referenced session formatting
- candidate artifact persistence and expiry
- scan/test/admission rule evaluation
- temporary activation and revocation

### Integration and harness tests

- auto-mode selection between managed-cloud and frontier for the same routed intent under different configured-provider sets
- deterministic escalation from a weaker configured profile to a stronger configured profile
- repo-search and repo-grounding flows proving path/snippet answers do not overburden smaller models
- multi-session attach/reference/compare flows
- structured worker resume/continuation flow without string-marker dependence
- child coding-lane lineage and completion handoff
- child coding-lane live status stream and replay
- quota enforcement for child-lane spawning
- worker spawn admission enforcing configured concurrency caps
- blocked cross-session mutation when target is implicit or ambiguous
- candidate build -> scan -> test -> report workflow
- candidate activation denial on policy or scan failure
- temporary activation inventory visibility
- candidate-control rate limiting and concurrent-build backpressure
- candidate evidence replay from persisted admission records
- promotion flow requiring separate approval

### Regression emphasis

The plan must explicitly protect against regressions where:

- the selector becomes a hidden second LLM making opaque provider choices
- `auto` still collapses managed cloud and frontier into one undifferentiated external lane
- smaller profiles receive the same context burden as frontier profiles
- a referenced session becomes implicitly writable
- multi-session prompt context collapses distinct session summaries into one ambiguous block
- a skill starts behaving like a runtime tool loader
- worker continuation depends on fragile synthetic text markers
- child coding lanes bypass configured worker concurrency limits
- candidate capabilities bypass `find_tools`
- candidate activation bypasses approval or sandboxing
- candidate promotion writes directly into permanent locations without a separate approval step

## Documentation Updates Required

- [docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md)
- [docs/specs/CONTEXT-ASSEMBLY-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXT-ASSEMBLY-SPEC.md)
- [docs/specs/ORCHESTRATION-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/ORCHESTRATION-SPEC.md)
- [docs/specs/SKILLS-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/SKILLS-SPEC.md)
- [docs/specs/TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)
- [docs/specs/CODING-WORKSPACE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-WORKSPACE-SPEC.md)
- [docs/specs/WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

## Recommended Delivery Order

The safest implementation order is:

1. Phase 0A
2. Phase 0B
3. Phase 0C
4. Phase 0D
5. Phase 1
6. Phase 2
7. Phase 3
8. Phase 5
9. Phase 6
10. Phase 7
11. Phase 4
12. Phase 8
13. Phase 9

Reasoning:

- Phases 0A through 0D are mandatory pre-flight because gateway contract, deterministic profile selection, context budgets, and worker resume semantics stabilize every later track
- deterministic provider/model-profile routing should be corrected before multi-workspace child lanes increase routing and context pressure further
- session portfolio semantics should be stabilized before child lanes
- build/scanning/admission contracts should be stabilized before activation
- activation should be proven before promotion
- child coding lanes should reuse the shared lineage and follow-up model rather than inventing their own early

## First Slice Recommendation

If this needs to be staged tightly, the best first implementation slice is:

- deterministic gateway workload metadata
- deterministic provider/model-profile selector
- profile-aware context budgeting for coding/search flows
- session portfolio summaries and explicit referenced sessions
- session inspect/compare tools
- candidate prompt/workflow artifacts only
- build-only quarantine lane
- Guardian policy/scanner/test contracts without activation yet

That slice provides visible value while avoiding the higher-risk parts:

- fixes current model-selection quality problems before broader multi-workspace fan-out
- no temporary executable activation yet
- no permanent promotion yet
- no cross-workspace background mutation yet

## End-State Success Criteria

Guardian should be able to:

- classify a turn once through `IntentGateway`, then deterministically choose the right configured provider/model profile without asking the chat model to pick its own execution lane
- keep smaller local or managed-cloud models on bounded, profile-appropriate context budgets
- keep one primary coding workspace per surface for implicit repo-local work
- inspect and compare other coding sessions without losing primary focus
- run child coding lanes in another workspace with visible lineage and bounded follow-up
- detect when the current catalog is insufficient and ask whether to author a candidate capability
- build that candidate in quarantine
- inspect it against Guardian rules and block it if necessary
- report its location and check results to the user
- let the user choose discard, temporary activate, or promote
- require a separate approval for permanent promotion

If the implementation cannot preserve those constraints, it should stop short of activation rather than weakening Guardian's current security posture.
