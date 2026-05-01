# Intent Gateway And Capability Plane Uplift Plan

**Status:** Draft
**Date:** 2026-04-14
**Primary external references:** [IntentKit](https://github.com/crestalnetwork/intentkit), [IntentKit docs](https://docs.intentkit.io/), [Composio](https://github.com/ComposioHQ/composio), [Composio docs](https://docs.composio.dev/docs/toolkits/custom-tools-and-toolkits)
**Secondary external references:** Open Agents snapshot-backed sandbox startup research at commit `45f687b5`, Daytona TypeScript SDK docs, Vercel sandbox docs
**Related Guardian docs:** [INTENT-GATEWAY-ROUTING-DESIGN.md](../design/INTENT-GATEWAY-ROUTING-DESIGN.md), [TOOLS-CONTROL-PLANE-DESIGN.md](../design/TOOLS-CONTROL-PLANE-DESIGN.md), [BROKERED-AGENT-ISOLATION-DESIGN.md](../design/BROKERED-AGENT-ISOLATION-DESIGN.md), [SECURITY-ISOLATION-DESIGN.md](../design/SECURITY-ISOLATION-DESIGN.md), [CONTEXT-ASSEMBLY-DESIGN.md](../design/CONTEXT-ASSEMBLY-DESIGN.md), [CODING-WORKSPACE-DESIGN.md](../design/CODING-WORKSPACE-DESIGN.md), [REMOTE-SANDBOXING-DESIGN.md](../design/REMOTE-SANDBOXING-DESIGN.md), [FORWARD-ARCHITECTURE.md](../architecture/FORWARD-ARCHITECTURE.md), [OVERVIEW.md](../architecture/OVERVIEW.md), [SECURITY.md](../../SECURITY.md)

## Objective

Uplift Guardian’s current monolithic intent gateway into a staged intent decision plane, add a distinct capability-resolution plane after routing, harden the planner-to-broker contract, and align remote sandbox lifecycle behavior with the snapshot/prewarm patterns already emerging in the Vercel/Daytona work.

This plan is not a rewrite license.

The goal is to:

1. reduce routing drift without bypassing the gateway architecture
2. reduce prompt footprint and latency by splitting responsibilities cleanly
3. keep security, approvals, pending actions, and trust boundaries supervisor-owned
4. avoid letting tool/provider/sandbox complexity expand the gateway into a larger monolith
5. make documentation, traces, and harness coverage move with the architecture so the uplift does not create hidden tech debt

Priority order for tradeoffs in this program:

1. security
2. accuracy
3. latency

## Why This Uplift Is Needed

Recent manual and trace-backed findings showed the current architecture is carrying too much responsibility in one place:

- route classification, entity resolution, route repair, workload derivation, and execution shaping are all entangled in `src/runtime/intent-gateway.ts`
- fallback paths can preserve the route while losing critical route-specific entities such as `emailProvider` and `mailboxReadMode`
- coding workspace target inference can collide with remote-sandbox phrasing because entity parsing is too generic
- provider configuration work depends too heavily on prompt examples instead of a dedicated post-route extractor/resolver path
- the complex-planning path can emit actions the brokered worker cannot execute, which is a contract-boundary failure rather than a model-quality issue
- progress visibility and routing traces explain some of the system, but not the full decision chain cleanly enough for operators

These are architecture symptoms, not just isolated bugs.

## LLM Versus Deterministic Split

The default target is not "more LLM everywhere."

The target is:

- one primary LLM route-classification turn for normal requests
- deterministic normalization from structured state plus deterministic capability resolution after classification
- a second bounded LLM turn only when route-critical fields are missing, conflicting, or semantically ambiguous

That gives the common case a fast path while still allowing intelligence where deterministic repair would be too brittle or under-specified.

The deterministic part here is intentionally narrow. It should normalize or validate known structured inputs such as pending-action state, continuity state, session metadata, known enums, and already-captured route hints. It should not try to infer ambiguous free-text meaning by ad hoc heuristics.

The important design choice is that `simpleVsComplex` should come out of the first classifier result. It should not become a separate ad hoc pre-router in front of the Intent Gateway.

## Recommended Stage Semantics

### Stage 1: Route Classifier

This should remain an LLM inference step.

It should decide:

- `route`
- `operation`
- `turnRelation`
- `resolution`
- `simpleVsComplex`
- coarse workload hints

This is the right place to spend model intelligence because it decides which narrower path the turn should enter.

### Stage 2: Route-Scoped Entity Resolution

This should be hybrid, not purely LLM and not heuristic-first.

Default path:

- deterministic normalization and validation from structured state such as continuity state, pending action state, known session metadata, known enums, and already-resolved route hints
- route-scoped validation of required entities

Escalation path:

- a small route-scoped LLM resolution call when route-critical fields still require inference from ambiguous free text, or remain missing, conflicting, or semantically unclear after deterministic normalization

That keeps the normal case fast while avoiding the current failure mode where one universal prompt has to solve both routing and all downstream entity recovery.

### Stage 3: Clarification And Correction Resolver

This should also be hybrid.

Default path:

- deterministic resolution for explicit short answers such as provider names, yes/no confirmations, mailbox scope, or direct corrections to a single field

Escalation path:

- a bounded LLM clarification pass when the answer is semantically ambiguous, partially corrective, or refers implicitly to prior context

Fail-safe path:

- if the clarification cannot be resolved confidently, it should go back through the normal front door as a shared pending-action or follow-up flow rather than creating a bespoke side channel

This keeps the clarification system intelligent without turning every short answer into another full prompt cycle.

### Stage 4: Capability Resolution

This should stay deterministic and control-plane owned.

It should decide:

- direct answer versus tool loop versus planner
- provider/session readiness
- coding backend and remote-execution lane
- sandbox/backend selection inputs

This stage should not become another LLM router. The job here is policy-safe execution shaping after the user intent is already understood.

## External Findings To Reuse

### 1. IntentKit patterns worth borrowing

IntentKit’s most reusable ideas are structural:

- separate classifier, extractor, clarification, and action nodes
- explicit validation between stages
- route-scoped context instead of one giant universal prompt
- clarification as a first-class graph step rather than a side effect of the main prompt
- context updates as structured patches rather than ad hoc text mutation

What to borrow:

- staged interpretation
- route-scoped extractors or resolvers
- validation boundaries between stages
- structured clarification resolution

What not to borrow:

- a wholesale graph runtime for every Guardian turn
- a second orchestration substrate that competes with Guardian’s existing shared runtime state

### 2. Composio patterns worth borrowing

Composio’s most reusable ideas sit after intent classification:

- capability discovery before execution
- schema and auth/session resolution as separate concerns
- a workbench-style execution environment for higher-complexity tasks
- provider/tool mediation instead of embedding every tool nuance into the classifier

What to borrow:

- a capability-resolution plane after routing
- explicit tool-family and provider-session resolution
- discovery plus drilldown rather than stuffing the gateway with tool-specific prompt knowledge

What not to borrow:

- making Guardian’s core trust boundary depend on an external orchestration model
- collapsing supervisor-owned approvals/policy into tool-specific logic

### 3. Open Agents / Daytona / Vercel patterns worth borrowing

The strongest adjacent pattern is snapshot-backed sandbox startup and prewarmed isolated execution targets.

What to borrow:

- snapshot-backed target preference
- lifecycle-aware reusable sandboxes for repeated coding work
- clearer separation between bounded one-shot isolated execution and longer-lived managed sandbox workbenches

What not to borrow:

- transplanting their agent/task model into Guardian’s shared orchestration system

## Target End State

Guardian should have four distinct but connected layers:

### Layer 1: Intent Decision Plane

This layer remains gateway-first and LLM-owned for normal turns, but it is split internally into stages.

Target stages:

1. `route-classifier`
   Returns:
   - `route`
   - `operation`
   - `turnRelation`
   - `resolution`
   - `simpleVsComplex`
   - coarse workload hints

2. `route-entity-resolver`
   Route-scoped resolution only.
   Deterministic normalization from structured state first, with bounded route-scoped LLM escalation when route-critical meaning still has to be inferred.
   Examples:
   - `email_task`: `emailProvider`, `mailboxReadMode`
   - `coding_task`: `codingBackend`, `codingRemoteExecRequested`, `sessionTarget`, `profileId`
   - `general_assistant/config`: provider inventory intent, model catalog intent, config mutation intent

3. `clarification-and-correction resolver`
   Shared handling of:
   - pending action answers
   - corrections
   - bounded continuity-based restatement
   Deterministic for explicit short field answers, with bounded LLM escalation for semantically ambiguous replies.

4. `workload-derivation`
   Derives:
   - `executionClass`
   - `preferredTier`
   - `preferredAnswerPath`
   - `expectedContextPressure`

Important rule:
- deterministic parsing after classification is allowed
- deterministic pre-gateway routing is not
- extra LLM turns inside the intent plane must be route-scoped, supervisor-mediated, and justified by unresolved ambiguity rather than used as a default second pass
- deterministic logic in this layer may normalize known structured inputs, but it must not replace semantic route understanding or guess ambiguous free-text intent

### Layer 2: Capability Resolution Plane

This sits after route and entity resolution.

Responsibilities:

- choose tool family or direct lane
- resolve auth/provider session requirements
- resolve coding backend and remote execution lane
- decide whether the request can be handled directly, via tool loop, or via planner
- keep provider and sandbox details out of the top-level route classifier prompt

This is where Guardian should borrow the strongest Composio pattern.

### Layer 3: Planner Contract Layer

The planner may only emit actions the brokered runtime can actually execute.

Responsibilities:

- declare the supported planner node contract
- validate plans before execution
- compile or reject unsupported node types
- keep recovery planning on the same contract

This layer must exist between `TaskPlanner` and `BrokeredWorkerSession`, not only as a late worker error.

### Layer 4: Execution Workspace And Sandbox Lifecycle

This is where the Open Agents / Daytona / Vercel snapshot-backed work belongs.

Responsibilities:

- explicit one-shot isolated execution vs managed reusable sandboxes
- snapshot-backed ready-target preference
- session-aware sandbox reuse in coding work
- capability-lane selection that does not overload the gateway

## Proposed Module Shape

This uplift should mechanically extract the current monolith into a staged module set under `src/runtime/intent/` while keeping `src/runtime/intent-gateway.ts` as the compatibility facade during migration.

Suggested modules:

- `src/runtime/intent/types.ts`
- `src/runtime/intent/route-classifier.ts`
- `src/runtime/intent/prompt-profiles.ts`
- `src/runtime/intent/structured-recovery.ts`
- `src/runtime/intent/clarification-resolver.ts`
- `src/runtime/intent/workload-derivation.ts`
- `src/runtime/intent/entity-resolvers/email.ts`
- `src/runtime/intent/entity-resolvers/coding.ts`
- `src/runtime/intent/entity-resolvers/provider-config.ts`
- `src/runtime/intent/entity-resolvers/personal-assistant.ts`
- `src/runtime/intent/capability-resolver.ts`
- `src/runtime/intent/planner-contract.ts`

Adjacent execution modules:

- `src/runtime/planner/task-planner.ts`
- `src/runtime/planner/recovery.ts`
- `src/worker/worker-session.ts`
- `src/runtime/remote-execution/policy.ts`
- `src/runtime/remote-execution/remote-execution-service.ts`

## Architectural Guardrails

The uplift must not do any of the following:

- add regex or keyword routing before the Intent Gateway for normal turns
- duplicate clarification behavior inside individual direct handlers
- duplicate provider/session selection logic in both `chat-agent.ts` and control-plane callbacks
- let the planner emit broker-unsupported actions and rely on runtime failure as the enforcement mechanism
- push more tool/provider examples into a single massive gateway prompt instead of moving them into route-specific extraction or capability resolution
- create a second plans location outside `docs/plans/`

## Security Compliance Check

This uplift remains compliant with [SECURITY-ISOLATION-DESIGN.md](../design/SECURITY-ISOLATION-DESIGN.md) only if these constraints stay true throughout implementation:

- Guardian keeps control-plane ownership of routing, approvals, pending actions, audit, policy, memory, secret resolution, and final output scanning.
- Extra LLM turns for route extraction or clarification stay in Guardian-owned or broker-proxied provider paths. They do not give workers or sandboxes direct provider authority.
- Route-entity resolvers and clarification resolvers may enrich structured intent state, but they do not directly choose unsafe execution backends or bypass admission controls.
- Capability resolution stays deterministic and control-plane owned. Choosing a tool family, provider session, or sandbox lane is not delegated to a free-form model pass.
- Remote sandboxes remain execution substrates, not routing owners, memory owners, or approval owners.
- Planner validation happens before brokered execution begins, so unsupported action types are rejected or compiled at the contract boundary rather than discovered during execution.
- Any stronger isolation backend adds containment only. It does not expand authority beyond the existing Guardian control plane.

## Phased Implementation Plan

## Phase 0: Contracts And Documentation First

### Goal

Make the target architecture explicit before extracting code.

### Deliver

- add this plan
- update the intent gateway spec to describe staged routing
- update the tools control-plane spec to introduce the capability-resolution plane
- update the brokered isolation spec to introduce the planner contract boundary
- update the security isolation spec to reflect the staged routing plus capability-resolution ownership split where it affects shared isolation contracts

### Exit criteria

- no ambiguous ownership between gateway, capability resolver, and planner contract
- migration path is documented before code starts spreading across modules

## Phase 1: Route Classifier Split

### Goal

Split top-level route classification from route-specific entity resolution.

### Deliver

- extract the current top-level route/operation/turn-relation prompt into `route-classifier.ts`
- keep compact vs full prompt-profile selection here
- add a `simpleVsComplex` or equivalent coarse complexity signal as classifier output
- keep `IntentGateway` as the orchestrating facade

### Initial file targets

- `src/runtime/intent-gateway.ts`
- `src/runtime/intent/route-classifier.ts`
- `src/runtime/intent/prompt-profiles.ts`
- `src/runtime/intent/types.ts`

### Documentation to update in same phase

- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`
- `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`
- `docs/design/SECURITY-ISOLATION-DESIGN.md`
- `docs/architecture/FORWARD-ARCHITECTURE.md`

### Exit criteria

- top-level route classification can be tested independently of entity resolution
- short simple turns no longer require a giant universal prompt to classify correctly

## Phase 2: Route-Scoped Entity Resolvers

### Goal

Move critical entity inference and repair into route-specific resolvers.

### Deliver

- `email` resolver for provider/read-mode resolution and repair
- `coding` resolver for backend/session/remote-exec/profile resolution and collision handling
- `provider-config` resolver for AI provider inventory/model/config requests
- `personal-assistant` resolver for Second Brain item targeting and local-vs-provider boundaries

### Initial file targets

- `src/runtime/intent/entity-resolvers/email.ts`
- `src/runtime/intent/entity-resolvers/coding.ts`
- `src/runtime/intent/entity-resolvers/provider-config.ts`
- `src/runtime/intent/entity-resolvers/personal-assistant.ts`
- `src/chat-agent.ts`
- `src/runtime/direct-intent-routing.ts`

### Documentation to update in same phase

- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`
- `docs/architecture/OVERVIEW.md`
- `docs/design/SECURITY-ISOLATION-DESIGN.md` if resolver ownership or route-to-execution handoff contracts change
- `src/reference-guide.ts` when user-visible routing behavior changes

### Exit criteria

- provider/entity loss can no longer silently drift execution after the route is already correct
- coding workspace target extraction no longer collides with remote sandbox phrasing
- provider inventory/config requests no longer rely mainly on prompt examples

## Phase 3: Shared Clarification And Continuity Resolver

### Goal

Normalize pending-action, clarification, correction, and continuity handling as shared structured state.

### Deliver

- one resolver for clarification answers and corrections
- explicit structured patches for resolved fields
- provenance on resolved fields so traces can show where a value came from

Suggested patch/provenance model:

- `intent.route`
- `intent.operation`
- `intent.entities.*`
- `intent.executionLane`
- provenance such as `classifier.primary`, `resolver.email`, `clarification.answer`, `repair.route_only`

### Initial file targets

- `src/runtime/pending-actions.ts`
- `src/runtime/continuity-threads.ts`
- `src/runtime/intent/clarification-resolver.ts`
- `src/runtime/intent-routing-trace.ts`

### Documentation to update in same phase

- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`
- `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`
- `docs/design/SECURITY-ISOLATION-DESIGN.md` if clarification ownership or cross-boundary state handling changes
- `docs/guides/INTEGRATION-TEST-HARNESS.md`

### Exit criteria

- short follow-up answers resolve through one shared pathway
- traces show classification source, resolver source, and clarification source clearly

## Phase 4: Capability Resolution Plane

### Goal

Move tool-family, provider-session, and sandbox-lane decisions out of the gateway prompt and into a dedicated post-route resolver.

### Deliver

- resolve direct-lane candidates from route plus entities
- resolve provider/session readiness before execution
- resolve whether coding work should use local tool loop, coding backend, direct filesystem search, or remote sandbox
- keep the `find_tools` plus deferred loading model, but improve the capability lookup and drilldown contract

### Initial file targets

- `src/runtime/intent/capability-resolver.ts`
- `src/runtime/direct-intent-routing.ts`
- `src/runtime/execution-profiles.ts`
- `src/tools/executor.ts`
- `src/runtime/control-plane/provider-dashboard-callbacks.ts`
- `src/runtime/control-plane/provider-runtime-adapters.ts`

### Documentation to update in same phase

- `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md`
- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`
- `docs/design/SECURITY-ISOLATION-DESIGN.md`
- `docs/architecture/FORWARD-ARCHITECTURE.md`

### Exit criteria

- gateway prompt no longer needs to grow linearly with tool/provider complexity
- capability resolution can evolve without turning routing into a larger monolith

## Phase 5: Planner Contract And Broker Validation

### Goal

Make planner execution contract-bound and broker-safe.

### Deliver

- introduce `planner-contract.ts`
- define the supported node types and payload shapes
- validate plans before execution
- compile or reject unsupported actions before worker execution starts
- keep recovery planner on the same contract

### Initial file targets

- `src/runtime/intent/planner-contract.ts`
- `src/runtime/planner/task-planner.ts`
- `src/runtime/planner/recovery.ts`
- `src/runtime/planner/types.ts`
- `src/worker/worker-session.ts`

### Documentation to update in same phase

- `docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md`
- `docs/design/SECURITY-ISOLATION-DESIGN.md`
- `SECURITY.md`
- `docs/architecture/OVERVIEW.md`

### Exit criteria

- no planner path can propose actions the broker cannot execute without being rejected or compiled first
- planner and recovery prompts are aligned to the same supported contract

## Phase 6: Sandbox Lifecycle And Workbench Uplift

### Goal

Apply the reusable sandbox and snapshot-backed patterns in the correct layer.

### Deliver

- keep snapshot-backed target preference in remote-execution policy
- formalize ephemeral vs managed sandbox lanes
- improve managed coding-session sandbox reuse
- keep sandbox lifecycle and target selection in remote execution, not in the gateway

### Initial file targets

- `src/runtime/remote-execution/policy.ts`
- `src/runtime/remote-execution/remote-execution-service.ts`
- `src/runtime/remote-execution/providers/daytona-remote-execution.ts`
- `src/runtime/remote-execution/providers/vercel-remote-execution.ts`
- `src/tools/cloud/vercel-sandbox-client.ts`
- `src/tools/cloud/daytona-sandbox-client.ts`
- `web/public/js/pages/cloud.js`
- `web/public/js/pages/code.js`

### Documentation to update in same phase

- `docs/design/REMOTE-SANDBOXING-DESIGN.md`
- `docs/design/CLOUD-HOSTING-INTEGRATION-DESIGN.md`
- `docs/design/CODING-WORKSPACE-DESIGN.md`
- `docs/design/SECURITY-ISOLATION-DESIGN.md`
- `docs/design/WEBUI-DESIGN.md`
- `docs/archive/plans/VERCEL-REMOTE-SANDBOX-CONNECTOR-IMPLEMENTATION-PLAN.md` as the historical implementation record

### Exit criteria

- sandbox lifecycle is clearly owned by the remote-execution layer
- gateway only expresses intent and execution-lane hints, not provider-specific sandbox orchestration

## Phase 7: UX, Traces, And Diagnostics

### Goal

Make the new staged architecture visible to operators and developers.

### Deliver

- routing trace includes classifier stage, resolver stage, clarification stage, capability resolution stage, and selected execution lane
- progress UI shows fuller run states without truncating the useful sentence
- diagnostics expose prompt profile, route source, entity source, and planner-contract validation

### Initial file targets

- `src/runtime/intent-routing-trace.ts`
- `src/runtime/run-timeline.ts`
- `web/public/js/chat-panel.js`
- `web/public/css/style.css`
- `src/channels/cli.ts`

### Documentation to update in same phase

- `docs/design/WEBUI-DESIGN.md`
- `docs/guides/INTEGRATION-TEST-HARNESS.md`
- `src/reference-guide.ts`

### Exit criteria

- operators can explain why a turn routed the way it did from shared traces
- long-running planner and coding work show meaningful progress across web and CLI

## Phase 8: Harnesses, Migration, And Cleanup

### Goal

Prevent the uplift from landing as an under-tested refactor.

### Deliver

Add or expand:

- route-classifier unit coverage
- route-specific resolver tests
- clarification/correction regression tests
- planner contract tests
- remote sandbox target-selection tests including snapshot-backed preference
- managed-cloud integration harness coverage for the affected paths

Minimum harness updates:

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`
- `node scripts/test-brokered-isolation.mjs`
- `node scripts/test-brokered-approvals.mjs`
- `node scripts/test-code-ui-smoke.mjs`

Recommended managed-cloud validation lanes:

- coding backend lane against managed-cloud Ollama
- provider inventory/config lane against web chat
- explicit remote sandbox lane for coding-session execution

### Exit criteria

- old and new architecture do not coexist indefinitely in parallel logic
- compatibility shims are removed after the staged modules fully own the behavior

## Documentation Inventory

These are the documentation surfaces that must be treated as part of the uplift, not optional follow-up work.

### Must update

- `SECURITY.md`
  Why: planner-contract hardening, staged routing, and sandbox-lifecycle ownership change the documented security story.

- `docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md`
  Why: planner execution contract and worker responsibilities change.

- `docs/design/SECURITY-ISOLATION-DESIGN.md`
  Why: the uplift adds more internal routing stages, but control-plane ownership and backend neutrality must stay explicit so routing intelligence does not drift into a second runtime.

- `docs/design/INTENT-GATEWAY-ROUTING-DESIGN.md`
  Why: this is the primary contract for the whole uplift.

- `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md`
  Why: capability resolution, provider/tool discovery, and post-route execution ownership move here.

- `docs/design/CONTEXT-ASSEMBLY-DESIGN.md`
  Why: prompt-footprint changes are a core goal of the uplift.

- `docs/architecture/FORWARD-ARCHITECTURE.md`
  Why: new modules and ownership boundaries need to be recorded as the migration target.

- `docs/architecture/OVERVIEW.md`
  Why: the product-level architecture narrative must not keep describing the old monolith.

- `docs/guides/INTEGRATION-TEST-HARNESS.md`
  Why: the required green loops must follow the new architecture boundaries.

### Update when affected by the implementation slice

- `docs/design/CODING-WORKSPACE-DESIGN.md`
- `docs/design/REMOTE-SANDBOXING-DESIGN.md`
- `docs/design/CLOUD-HOSTING-INTEGRATION-DESIGN.md`
- `docs/design/WEBUI-DESIGN.md`
- `src/reference-guide.ts`
- `docs/archive/plans/VERCEL-REMOTE-SANDBOX-CONNECTOR-IMPLEMENTATION-PLAN.md`

## Tech Debt Prevention Checklist

Every implementation PR in this program should answer these questions:

1. Did this reduce logic in the gateway facade, or did it just move code around without changing ownership?
2. Did we add a new route-specific resolver instead of adding more generic repair heuristics?
3. Did we keep normal turns gateway-first?
4. Did we avoid creating duplicate provider/session/sandbox resolution paths?
5. Did we update the authoritative specs in the same change?
6. Did we add trace fields and tests for the new behavior?
7. Did we remove temporary compatibility code once the new owner layer was proven?

If the answer to any of these is no, the uplift is probably creating debt rather than paying it down.

## Recommended Execution Order

1. Phase 0 first so ownership is explicit.
2. Phase 1 and Phase 2 next so the current routing bugs stop compounding.
3. Phase 4 before widening more provider/tool complexity.
4. Phase 5 before relying further on complex planning in production.
5. Phase 6 as the isolated-execution/workbench uplift track.
6. Phase 7 and Phase 8 continuously alongside the earlier phases, not only at the end.

## Acceptance Criteria For The Whole Program

This uplift is complete when:

- Guardian still has one authoritative gateway-first turn pipeline
- the gateway facade is small and orchestration-focused instead of monolithic
- route-specific entity resolution is explicit and testable
- capability resolution is a dedicated layer after routing
- planner execution is contract-validated before the broker tries to run it
- remote sandbox lifecycle is clearly separated from intent routing
- traces and docs explain the architecture without relying on tribal knowledge
- no major user-facing flow still depends on a hidden compatibility fork from the old monolith
