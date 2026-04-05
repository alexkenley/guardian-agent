# Orchestration And Delegation Capability Uplifts Proposal

**Status:** Draft
**Date:** 2026-04-06
**Basis:** Comparative review of GuardianAgent against an inspected external reference coding/runtime implementation
**Primary Guardian files:**
- `src/runtime/intent-gateway.ts`
- `src/runtime/pending-actions.ts`
- `src/agent/orchestration.ts`
- `src/supervisor/worker-manager.ts`
- `src/runtime/code-sessions.ts`
- `src/tools/registry.ts`
- `src/tools/executor.ts`
- `src/skills/registry.ts`
- `src/runtime/scheduled-tasks.ts`
**Related docs:**
- `docs/specs/ORCHESTRATION-SPEC.md`
- `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`
- `docs/architecture/FORWARD-ARCHITECTURE.md`
- `docs/proposals/REFERENCE-CODING-RUNTIME-UPLIFT-PROPOSAL.md`
- `docs/implemented/AGENTIC-ORCHESTRATION-UPLIFT-PROPOSAL.md`

## Executive Summary

Guardian is already ahead of the reference benchmark in several areas that matter more than surface parity:

- gateway-first top-level intent routing
- shared pending-action orchestration across channels
- approval-gated tool execution with stronger trust and taint controls
- backend-owned coding sessions instead of terminal-owned state
- compiler-first automation authoring and scheduled task control
- operator-held delegated-result follow-up instead of raw worker output replay

The reference benchmark is stronger in a different class of capability:

- transport-neutral worker lifecycle control
- typed background task packets
- explicit task and team registries
- canonical lane events and failure taxonomies
- structured recovery recipes
- branch freshness and verification contracts
- lifecycle-aware degraded reporting for plugin and MCP startup
- machine-readable inventory and status surfaces
- built-in repo-native code intelligence

The right outcome is not to copy the benchmark runtime. The right outcome is to keep Guardian's existing security and orchestration model, then selectively adopt the benchmark's strongest runtime-control patterns.

## Comparative Assessment

| Capability area | Guardian today | External benchmark strength | Recommendation |
|---|---|---|---|
| Intent routing | Strong. `IntentGateway` is explicit, structured, and authoritative. | Weaker. No comparable gateway-first contract. | Keep Guardian's current architecture. Do not regress here. |
| Blocked-work resume | Strong. Shared pending actions already unify approval, clarification, auth, and workspace-switch blockers. | Narrower. More focused on worker/runtime state than shared cross-surface continuation. | Keep Guardian's model and extend it downward into delegated runtime control. |
| Multi-agent composition | Good in-invocation composition via `SequentialAgent`, `ParallelAgent`, `LoopAgent`, and `ConditionalAgent`. | Stronger for durable sub-task handling through registry-backed tasks and teams. | Add durable delegation/task primitives without replacing current composition agents. |
| Delegated worker control | Partial. Brokered workers exist, but lifecycle is still more session-owned than state-machine-owned. | Stronger. Worker boot is explicit and machine-readable. | Add typed worker/session control for delegated and coding backends. |
| Tooling and discovery | Strong curated registry with deferred loading and policy integration. | Stronger in machine-readable runtime inventory and simpler direct task/agent/skill control surfaces. | Keep Guardian's registry model, but enrich runtime metadata and inventory/status contracts. |
| Skills | Strong registry and prompt-material loading. | Stronger in direct role-bound delegation patterns and very explicit sub-agent tool allowlists. | Add delegation profiles that combine skills, tool budgets, and output contracts. |
| MCP and plugin lifecycle | Partial. Guardian has MCP transport and control-plane surfaces, but degraded capability reporting is still thinner than ideal. | Stronger in phase-based lifecycle and missing-capability reporting. | Add typed lifecycle health snapshots and degraded-mode diagnostics. |
| Verification and recovery | Partial. Guardian records verification and timelines, but coding-runtime recovery policy is not yet a first-class contract. | Stronger in freshness checks, recovery recipes, and green-level contracts. | Add verification/freshness/recovery contracts for coding and delegated work. |
| Runtime introspection | Good UI breadth, but some state is still reported as summaries rather than stable runtime contracts. | Stronger in JSON-oriented status surfaces for automation and operators. | Add machine-readable runtime snapshots across workers, sessions, MCP, and skills. |
| Code intelligence | Planned but not implemented as a first-class repo service. | Stronger. Has direct LSP-backed code intelligence primitives. | Implement repo-scoped LSP/code-intelligence service for code sessions. |

## Architectural Position

Guardian should keep these layers authoritative:

- `IntentGateway`
- shared pending-action orchestration
- `ToolExecutor` policy and approval enforcement
- code-session ownership and workspace trust boundaries
- brokered worker isolation
- control-plane mutation paths

Guardian should selectively adopt the benchmark's strongest ideas only where they strengthen runtime truthfulness:

- typed execution packets
- durable task and team state
- explicit worker lifecycle state
- event-first runtime reporting
- structured recovery and verification policy
- degraded lifecycle reporting for tooling backends

This must remain a Guardian-native uplift. The benchmark should inform structure, not product direction.

## Where Guardian Already Leads

These are not uplift targets. They are constraints.

### 1. Intent Gateway remains the top-level authority

The benchmark does not have a stronger replacement for Guardian's gateway-first routing model. Guardian should not reintroduce regex-heavy or transport-specific intent interception just to imitate a simpler runtime.

### 2. Shared pending-action orchestration remains canonical

The benchmark's runtime state is useful, but it is not a substitute for Guardian's shared blocker model. Approval, clarification, auth, and workspace-switch behavior must stay in the shared pending-action system and remain portable across supported surfaces where policy allows.

### 3. Security and trust boundaries remain Guardian-owned

The uplift must not weaken:

- taint-aware mutation controls
- approval gating
- principal binding
- control-plane integrity
- sandbox posture enforcement
- backend-owned coding-session boundaries

## Proposed Uplifts

## 1. Typed Execution Briefs For Delegated And Coding Work

### Problem

Guardian can delegate work and schedule work, but a large share of delegated execution still begins from natural-language prompts plus ambient metadata. That is flexible, but it makes durable inspection, resume, retry, and policy reasoning harder than it should be.

### Proposal

Introduce a typed `ExecutionBrief` contract for delegated coding and background work.

Suggested fields:

- `objective`
- `scope`
- `workspaceRoot`
- `branchPolicy`
- `acceptanceCriteria`
- `verificationPlan`
- `reportingContract`
- `escalationPolicy`
- `riskPosture`
- `requestedSkills`
- `requestedTools`
- `originatingIntent`
- `originatingPendingActionId`

### Guardian fit

This should not replace user chat or the `IntentGateway`. It should sit below them:

`IntentGateway` / code-session context / automation runtime
-> `ExecutionBrief`
-> worker manager / scheduled task / delegation runtime

### Primary files

- new `src/runtime/execution-brief.ts`
- `src/supervisor/worker-manager.ts`
- `src/runtime/scheduled-tasks.ts`
- `src/runtime/code-sessions.ts`
- `src/agent/orchestration.ts`

### Outcome

Delegated work becomes easier to inspect, retry, stop, resume, and verify without reconstructing intent from freeform prose.

## 2. Durable Delegation Task Registry And Team Model

### Problem

Guardian has:

- in-invocation orchestration agents
- assistant job tracking
- scheduled tasks

What it does not yet have is a single durable runtime model for delegated sub-tasks that can be created, listed, updated, stopped, grouped, and inspected independently of one specific invocation.

### Proposal

Add a supervisor-owned delegation registry with:

- task create/get/list/update/stop/output operations
- optional team grouping for parallel sub-task bundles
- timeline projection into the existing operator surfaces
- linkage to pending actions, code sessions, and shared continuity

This should complement, not replace:

- `AssistantJobTracker`
- orchestration agents in `src/agent/orchestration.ts`
- `ScheduledTasks`

### Guardian fit

Current orchestration agents are good for one invocation. The uplift is for durable delegated work that spans:

- long-running coding assistance
- background analysis
- multi-step verification lanes
- operator-reviewed delegated outcomes

### Primary files

- new `src/runtime/delegated-task-store.ts`
- new `src/runtime/delegated-team-store.ts`
- `src/supervisor/worker-manager.ts`
- `src/runtime/assistant-jobs.ts`
- `src/runtime/control-plane/assistant-dashboard-callbacks.ts`

### Outcome

Guardian gains first-class durable delegated work management instead of treating every delegated run as an ephemeral worker outcome.

## 3. Worker Boot And Session Control State Machine

### Problem

Guardian already spawns isolated workers and owns code sessions, but there is still a gap between:

- "a worker/session exists"
- "the worker/session is ready for the next task"

That gap matters most for delegated coding backends and other transport-backed execution surfaces.

### Proposal

Add a typed worker/session control plane with explicit states such as:

- `spawning`
- `trust_required`
- `ready_for_prompt`
- `running`
- `blocked`
- `awaiting_approval`
- `finished`
- `failed`

And explicit commands such as:

- create worker
- await ready
- send task
- fetch state
- restart
- terminate

### Guardian fit

This belongs under shared orchestration and code-session ownership, not in a per-backend adapter. The transport is not the source of truth; the runtime state machine is.

### Primary files

- new `src/runtime/worker-lifecycle.ts`
- `src/supervisor/worker-manager.ts`
- `src/runtime/code-sessions.ts`
- `src/runtime/coding-backend-session-target.ts`
- `src/channels/web-code-session-routes.ts`

### Outcome

Guardian can answer "what exactly is this coding lane waiting on?" without relying on raw backend output or one-off status strings.

## 4. Canonical Lane Event Schema And Failure Taxonomy

### Problem

Guardian has run timelines and assistant job records, but coding/delegated execution still mixes:

- job summaries
- pending-action metadata
- code-session snapshots
- backend-specific status strings

This is useful, but not yet one canonical event vocabulary.

### Proposal

Define a shared event schema for delegated and coding lanes, with event names such as:

- `lane.started`
- `lane.ready`
- `lane.blocked`
- `lane.verification.started`
- `lane.verification.passed`
- `lane.verification.failed`
- `lane.approval.required`
- `lane.recovered`
- `lane.finished`
- `lane.failed`

Add a bounded failure taxonomy such as:

- `trust_gate`
- `approval_block`
- `workspace_state`
- `branch_divergence`
- `verification`
- `tool_runtime`
- `backend_startup`
- `mcp_startup`
- `mcp_handshake`
- `runtime_infra`

### Guardian fit

Do not create a second event system. Extend the existing run/timeline architecture so delegated workers, code sessions, and automation-owned coding lanes all project into the same event layer.

### Primary files

- new `src/runtime/lane-events.ts`
- `src/runtime/run-events.ts`
- `src/runtime/assistant-jobs.ts`
- `src/supervisor/worker-manager.ts`
- `src/runtime/code-sessions.ts`

### Outcome

Operator surfaces become event-derived instead of summary-derived, and recovery logic gains a stable branching contract.

## 5. Verification Contracts, Branch Freshness, And Recovery Recipes

### Problem

Guardian already records verification artifacts in code sessions, but it does not yet have one explicit coding-runtime contract for:

- what verification level is required
- whether the workspace is stale relative to its base branch
- what automatic recovery is allowed before escalation

### Proposal

Add three linked runtime contracts:

1. `VerificationContract`
2. `WorkspaceFreshnessPolicy`
3. `RecoveryRecipe`

The verification contract should support explicit levels such as:

- targeted checks
- package checks
- workspace checks
- merge-ready verification

The freshness policy should detect when the current branch is materially behind its base and differentiate stale-state noise from real regressions.

The recovery recipe layer should permit one bounded automatic recovery for known failures before escalation.

### Guardian fit

This should extend code-session work state, not live as one-off verification copy in prompts. It should also feed into delegated coding follow-up policy and operator summaries.

### Primary files

- new `src/runtime/verification-contract.ts`
- new `src/runtime/workspace-freshness.ts`
- new `src/runtime/recovery-recipes.ts`
- `src/runtime/code-sessions.ts`
- `src/supervisor/worker-manager.ts`

### Outcome

Guardian stops treating "verification happened" as enough. It can instead tell the operator what level was required, what was observed, what was recovered automatically, and why the lane is or is not truly complete.

## 6. Lifecycle-Aware MCP, Backend, And Tooling Health

### Problem

Guardian has MCP transport support and strong sandbox posture logic, but runtime availability is still more difficult to reason about than it should be when a backend is:

- partially up
- degraded
- missing specific tools
- blocked on auth or handshake

### Proposal

Add a typed lifecycle snapshot model for managed integrations.

Suggested fields:

- `requestedMode`
- `supportedMode`
- `activeMode`
- `lifecyclePhase`
- `status`
- `recoverable`
- `lastError`
- `availableCapabilities`
- `missingCapabilities`
- `recoveryRecommendations`
- `configSource`

Use it for:

- MCP servers
- delegated coding backends
- browser runtimes where applicable
- other managed execution backends

### Guardian fit

This belongs in the runtime/control-plane boundary. It should improve truthful status reporting and degrade handling without changing tool policy or approval semantics.

### Primary files

- new `src/runtime/integration-lifecycle.ts`
- `src/tools/mcp-client.ts`
- `src/runtime/control-plane/provider-runtime-adapters.ts`
- `src/runtime/control-plane/tools-dashboard-callbacks.ts`
- `src/tools/registry.ts`

### Outcome

Guardian can explain not just that a backend failed, but which phase failed, what capability was lost, whether the failure is recoverable, and what still works.

## 7. Delegation Profiles That Bind Skills, Tool Budgets, And Output Contracts

### Problem

Guardian has skills and structured orchestration agents, but delegated execution still lacks a single typed concept for role-bounded worker behavior.

### Proposal

Add `DelegationProfile` definitions that can be attached to delegated workers or durable delegated tasks.

Suggested fields:

- `role`
- `defaultModelTier`
- `allowedToolCategories`
- `requiredSkills`
- `maxIterations`
- `outputContract`
- `reportingMode`
- `verificationExpectation`
- `approvalExpectation`

Example profile families:

- explorer
- planner
- verifier
- implementation worker
- research worker

### Guardian fit

This should be built from Guardian's existing curated primitives:

- `src/skills/registry.ts`
- `src/agent/orchestration.ts`
- `src/supervisor/worker-manager.ts`

It should not become a plugin-driven free-for-all.

### Outcome

Delegation becomes more predictable, easier to audit, and easier to review in operator-facing runtime surfaces.

## 8. Repo-Native Code Intelligence Service

### Problem

Guardian's coding workspace spec already points toward richer code intelligence, but there is no first-class repo-scoped service for:

- symbol lookup
- definition/reference navigation
- diagnostics
- hover/introspection

### Proposal

Implement an LSP-backed code-intelligence service available only inside trusted coding contexts.

Initial operations:

- diagnostics
- definition
- references
- symbols
- hover

### Guardian fit

This should live behind tool execution and code-session context, not as an unaudited side channel. The service should honor workspace trust and code-session boundaries.

### Primary files

- new `src/runtime/code-intelligence.ts`
- new `src/tools/builtin/code-intelligence-tools.ts`
- `src/runtime/code-sessions.ts`
- `docs/specs/CODING-WORKSPACE-SPEC.md`

### Outcome

Guardian's coding lane becomes materially better at bounded repo reasoning without having to overuse shell-based search for every navigation task.

## 9. Machine-Readable Runtime Snapshots For Operators And Harnesses

### Problem

Guardian exposes broad operator surfaces, but some runtime state is still easier to consume as UI summaries than as stable machine-readable contracts.

### Proposal

Add a consistent snapshot layer for:

- workers
- delegated tasks
- code sessions
- MCP/integration lifecycle
- skills and delegation profiles
- runtime blockers and follow-up state

These snapshots should be available through:

- web control-plane APIs
- CLI commands
- internal test harnesses

### Guardian fit

This should extend existing dashboards and CLI surfaces, not invent a parallel operator plane.

### Primary files

- `src/runtime/control-plane/assistant-dashboard-callbacks.ts`
- `src/runtime/control-plane/tools-dashboard-callbacks.ts`
- `src/channels/cli.ts`
- new `src/runtime/runtime-snapshots.ts`

### Outcome

Automation, testing, and operator workflows can reason about runtime state without screen-scraping or transcript inference.

## 10. Comparative Capability Harness

### Problem

Guardian already has harnesses for important paths, but benchmark comparisons are still too manual.

### Proposal

Add a read-only comparative harness that can record and diff:

- runtime inventory
- session lifecycle surfaces
- tool/integration health surfaces
- machine-readable status outputs

This harness should compare capabilities, not copy implementation.

### Guardian fit

Use it to guide future uplift decisions for coding runtime, delegation, and optional backend adapters.

### Outcome

Guardian can make benchmark-informed roadmap decisions without drifting into parity-chasing.

## Delivery Order

### Phase 1: Runtime truth

- typed `ExecutionBrief`
- worker/session lifecycle state machine
- canonical lane events and failure taxonomy

### Phase 2: Durable delegation

- delegated task registry
- team model
- delegation profiles
- machine-readable runtime snapshots

### Phase 3: Coding-runtime hardening

- verification contracts
- workspace freshness policy
- recovery recipes
- repo-native code intelligence

### Phase 4: Backend truthfulness

- lifecycle-aware MCP/backend health snapshots
- comparative capability harness

## Explicit Non-Adoptions

Guardian should not adopt the following:

- terminal or TUI state as the source of truth for coding-runtime orchestration
- product-specific command or tool parity as a goal by itself
- plugin-style dynamic loading for first-party core orchestration
- a second orchestration runtime that bypasses the `IntentGateway`, shared pending actions, or `ToolExecutor`
- weaker approval or sandbox policy in exchange for simpler runtime control
- benchmark-specific terminology leaking into Guardian operator surfaces

## Success Criteria

This uplift is successful when all of the following are true:

1. Any delegated coding or background task can be fetched by ID with stable status, blocker, last event, output summary, and next action.
2. Any coding worker or backend can report whether it is merely present or truly ready for prompt delivery.
3. The run timeline can render delegated and coding execution from one canonical event schema rather than stitched summaries.
4. Verification state can distinguish targeted success from package, workspace, and merge-ready success.
5. MCP/backend degradation can name the missing capability, failed phase, and recommended recovery action.
6. Delegated work can be grouped, stopped, resumed, and inspected without reconstructing intent from raw conversation text.
7. Skills and role-bound worker profiles are explicit enough that delegated execution policy is understandable before the run starts.

## Recommendation

Proceed with Phases 1 and 2 first.

Those phases produce the highest leverage because they improve runtime truthfulness without weakening Guardian's existing routing, approvals, or control-plane architecture. Phases 3 and 4 then become much easier to implement cleanly because they can build on typed task, worker, and event foundations instead of adding more special cases to the current runtime.
