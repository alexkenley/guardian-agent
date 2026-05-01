# Henchmen-Inspired Coding And Orchestration Uplifts Proposal

**Status:** Draft
**Date:** 2026-04-11
**Basis:** Comparative review of GuardianAgent against the cloned `henchmen` repository. This proposal is inspired by that repo's strongest execution and verification patterns, not a recommendation to copy its product shape or runtime split.
**Primary Guardian files:** [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts), [src/runtime/code-workspace-map.ts](../../src/runtime/code-workspace-map.ts), [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts), [src/runtime/incoming-dispatch.ts](../../src/runtime/incoming-dispatch.ts), [src/runtime/orchestrator.ts](../../src/runtime/orchestrator.ts), [src/tools/executor.ts](../../src/tools/executor.ts), [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts), [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts), [web/public/js/pages/code.js](../../web/public/js/pages/code.js)
**Related docs:** [docs/design/CODING-WORKSPACE-DESIGN.md](../design/CODING-WORKSPACE-DESIGN.md), [docs/architecture/FORWARD-ARCHITECTURE.md](../architecture/FORWARD-ARCHITECTURE.md), [docs/architecture/OVERVIEW.md](../architecture/OVERVIEW.md), [docs/design/TOOLS-CONTROL-PLANE-DESIGN.md](../design/TOOLS-CONTROL-PLANE-DESIGN.md), [docs/proposals/ORCHESTRATION-AND-DELEGATION-CAPABILITY-UPLIFTS-PROPOSAL.md](ORCHESTRATION-AND-DELEGATION-CAPABILITY-UPLIFTS-PROPOSAL.md), [docs/proposals/MULTI-WORKSPACE-CODING-AND-GOVERNED-DYNAMIC-CAPABILITIES-PROPOSAL.md](MULTI-WORKSPACE-CODING-AND-GOVERNED-DYNAMIC-CAPABILITIES-PROPOSAL.md)

## Goal

Identify the parts of Henchmen that are genuinely useful for Guardian's coding assistant, coding workspace, delegated orchestration, and verification model, then translate those ideas into Guardian-native changes that respect current architectural constraints.

The target is not "be more like Henchmen."

The target is:

- keep Guardian's stronger security and shared orchestration model
- keep backend-owned coding sessions as the canonical workspace object
- keep the Intent Gateway authoritative for user intent classification
- borrow Henchmen's best ideas where they make coding work more explicit, more resumable, and more honest

## Executive Summary

Guardian is already stronger than Henchmen in the areas that matter most to Guardian's identity:

- gateway-first intent routing instead of keyword matching
- shared pending-action orchestration across surfaces
- backend-owned `CodeSession` state across web, CLI, and Telegram
- centralized security, trust, approval, and sandbox enforcement
- a broader runtime that already unifies coding with search, browser, automation, memory, and security work

Henchmen is stronger in a different class of problems:

- live feeling execution because the coding runtime has clearer phase boundaries
- explicit work-package structure for coding runs
- fail-closed verification and repair loops
- durable checkpoint/resume state for long-running execution
- bounded context dossiers assembled before the coding loop begins
- diff-quality and silent-failure detection before calling work "done"
- small, repeatable fixture-based evaluation for coding behavior

Guardian should therefore not borrow Henchmen's cloud-service topology, queue-first runtime split, or keyword routing. It should borrow the discipline of explicit execution contracts, explicit verification contracts, explicit checkpoints, and explicit coding benchmarks.

There is also one important refinement to the problem statement:

- Guardian does **not** primarily lack "multiple agents"
- Guardian primarily lacks a strong **live execution log contract** for external coding backends such as Codex and Claude Code

Today Guardian already has:

- multiple agents and orchestration primitives
- backend-owned code sessions
- a run timeline model
- SSE delivery to the web UI
- CLI live-progress handling for `run.timeline`

The practical gap is that external coding backends are still too terminal-job-shaped. Their activity is visible mainly as terminal output or a final buffered result, rather than as a first-class stream of structured "what the backend is doing now" events that can appear in web chat, Code, and CLI.

## Comparative Assessment

| Area | Guardian today | Henchmen strength | Recommendation |
|---|---|---|---|
| Top-level request routing | Strong. `IntentGateway` is structured and authoritative. | Weak relative to Guardian. Scheme selection and task analysis rely on keyword/regex classification. | Keep Guardian's gateway-first architecture. Do not copy Henchmen's routing approach. |
| Workspace ownership | Strong. `CodeSession` is backend-owned, cross-surface, and tied to trust, map, working set, approvals, and verification. | Narrower. Operative containers own an ephemeral repo copy for one task. | Keep Guardian's model. Borrow execution discipline beneath `CodeSession`, not instead of it. |
| Coding work-package shape | Partial. Session state is durable, but many coding turns still enter the tool loop as freeform chat plus ambient context. | Strong. `SchemeNode`, `ArsenalRequirement`, and `DossierRequirement` make each run explicit. | Add typed execution briefs and lane recipes inside the coding runtime. |
| Verification discipline | Partial. Guardian records verification and job history, but "done" is not yet consistently a fail-closed contract. | Strong. Lint/test repair loops, explicit fail edges, and "green before PR" discipline are central. | Add explicit verification contracts and repair loops to coding runs. |
| Runtime resumability | Partial. Guardian has shared pending actions and recent jobs, but long coding execution lacks a first-class checkpoint artifact. | Strong. Current node, retry counts, node results, and heartbeats are persisted for resume. | Add persisted lane checkpoints for coding and delegated work. |
| Live execution visibility | Partial. `run.timeline`, web SSE, and CLI progress rendering exist, but coding backend sessions still behave mostly like buffered terminal jobs. | Better phase visibility because execution is modeled more explicitly. | Make coding backends emit structured lane-log events continuously, not only final output. |
| Context assembly for execution | Good repo profile/map/working set foundation. | Stronger pre-execution packaging through Dossier rules, related PRs/issues, CI errors, and code-search context. | Add a Guardian-native context-pack layer that builds on `workspaceMap` and `workingSet`. |
| Diff-quality review | Partial. Guardian tracks changed files and verification, but lacks a dedicated diff-legitimacy pass. | Strong. `SilentFailureDetector` catches no-op changes, swallowed errors, and hardcoded secrets. | Add diff-risk review before success claims and delegated completion. |
| Coding evaluation | Good integration harnesses, but not a compact repo-fixture benchmark for coding changes. | Strong. Offline fixture harness scores actual diffs and test outcomes. | Add a repo-fixture coding eval lane for regressions in grounding and verification honesty. |
| Runtime decomposition | Broad integrated runtime with shared orchestration and security. | Cleaner narrow services for intake/orchestrator/operative/forge, but with product assumptions Guardian should not inherit. | Borrow explicit contracts, not the cloud-service topology. |

## What Guardian Should Not Copy

These are explicit non-adoptions.

### 1. No keyword or regex intent routing

Henchmen's `TaskAnalyzer` and scheme selection are acceptable in its narrower product. Guardian's repo instructions explicitly forbid ad hoc routing before the Intent Gateway. That stays a hard rule.

### 2. No separate coding runtime that bypasses shared orchestration

Guardian should not introduce a Dispatch/Mastermind/Forge side-runtime that bypasses:

- `IntentGateway`
- shared pending actions
- shared response metadata
- code-session ownership
- Guardian policy and trust enforcement

### 3. No "submit task, always open a PR" product posture

Henchmen is a PR factory. Guardian is a broader operator runtime. Coding work may end in a plan, an explanation, a local patch, a verification result, a delegated child lane, or a PR, depending on user intent.

### 4. No container-per-step default

Ephemeral clean-room execution is useful in some cases, but Guardian should not require a fresh container for every coding step or every deterministic node. That would fight the current session model and degrade operator continuity.

### 5. No weakening of trust or approvals in the name of speed

Henchmen's guardrails are useful, but Guardian's trust model is broader and must remain centralized. Any uplift has to flow through `CodeSession`, `PendingActionStore`, `ToolExecutor`, and shared timeline/status rendering.

## Where Henchmen Is Most Useful

The most valuable ideas in Henchmen come from these areas:

- `Mastermind` and `SchemeExecutor`: explicit node-based execution with retry, checkpoint, and fail-closed transitions
- `DossierBuilder`: bounded pre-execution context packaging with clear fetch categories
- `OperativeGuardrails` and `OperativeAgent`: lane-specific tool allowlists, cost ceilings, context windowing, and prompt-injection treatment of repo content as untrusted data
- `Forge`: verification as a product surface rather than an afterthought
- `SilentFailureDetector`: checking whether a patch is meaningfully good, not merely present
- `evals/harness.py`: a small benchmark harness that scores actual repo outcomes

Guardian can adopt all of those patterns without becoming queue-first or cloud-first.

## Proposed Uplifts

## 1. Add Live Lane Logs For External Coding Backends

### Problem

This is the most immediate gap for Codex, Claude Code, Gemini CLI, and similar backend adapters.

Guardian already has the rendering side of the system:

- [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts) defines structured run items
- [src/channels/web.ts](../../src/channels/web.ts) streams SSE events
- [web/public/js/pages/code.js](../../web/public/js/pages/code.js) subscribes to `run.timeline`
- [src/channels/cli.ts](../../src/channels/cli.ts) already renders live progress from `run.timeline`

But [src/runtime/coding-backend-service.ts](../../src/runtime/coding-backend-service.ts) still mostly:

- opens a PTY
- buffers terminal output
- waits for exit
- returns a final summarized result

That means the operator mostly sees either:

- terminal output
- a completion/failure summary

What is missing is the middle:

- planning
- inspecting files
- editing
- running checks
- waiting on approval
- retrying after failure
- handing back artifacts

### Henchmen lesson

The part worth borrowing is not "more agents." It is that the runtime shape makes execution stages legible. A useful coding system feels live because it has named phases and durable state transitions, not because it simply streams raw stdout.

### Guardian-native proposal

Add a first-class `CodingLaneEvent` stream for external coding backends and map it into the existing `run.timeline` contract.

Suggested event families:

- `backend_session_started`
- `backend_phase_changed`
- `backend_note`
- `backend_tool_intent`
- `backend_artifact_detected`
- `backend_waiting`
- `backend_output_excerpt`
- `backend_verification_started`
- `backend_verification_finished`
- `backend_session_completed`
- `backend_session_failed`

Suggested normalized phases:

- `booting`
- `reading_context`
- `planning`
- `editing`
- `running_checks`
- `awaiting_approval`
- `awaiting_input`
- `summarizing`
- `completed`
- `failed`

The key design rule is:

- render **structured lane logs** in web UI and CLI
- keep raw terminal output as an optional drill-down, not the only visibility surface

### Why this matters

This directly addresses the operator experience users compare against in Codex and Claude Code:

- you can see what the system is doing right now
- the chat and CLI do not go blank during long execution
- approval waits and retries are obvious
- a backend session feels like part of Guardian, not a detached subprocess

### Guardian fit

This should extend existing shared runtime surfaces, not invent a parallel one:

- `coding-backend-service.ts` should emit structured backend session events
- `run-timeline.ts` should ingest and summarize them
- web chat / Code / CLI should render the same stream with different density
- Telegram can stay summary-only if needed

### Primary files

- [src/runtime/coding-backend-service.ts](../../src/runtime/coding-backend-service.ts)
- [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts)
- [src/channels/web.ts](../../src/channels/web.ts)
- [src/channels/cli.ts](../../src/channels/cli.ts)
- [web/public/js/pages/code.js](../../web/public/js/pages/code.js)

## 2. Add Typed Execution Briefs For Coding Lanes

### Problem

Guardian's coding workspace stores strong durable state:

- `workspaceProfile`
- `workspaceMap`
- `workingSet`
- `focusSummary`
- `planSummary`
- `pendingApprovals`
- `recentJobs`
- `verification`

But the actual execution handoff for a coding turn is still comparatively implicit. A lot of meaning lives in prompt wording, recent chat context, and tool-loop convention instead of one explicit runtime artifact.

### Henchmen lesson

Henchmen's strongest design move is not its queue topology. It is that each meaningful coding step has an explicit shape:

- what kind of node it is
- which tool families it may use
- which context classes it requires
- how many steps it gets
- what "pass" and "fail" mean next

### Guardian-native proposal

Introduce a typed `CodingExecutionBrief` created beneath the Intent Gateway and attached to the active `CodeSession` lane.

Suggested fields:

- `objective`
- `laneKind`
- `primarySessionId`
- `referencedSessionIds`
- `workspaceScope`
- `mutationIntent`
- `contextRequirements`
- `requestedToolCategories`
- `acceptanceGates`
- `verificationPlan`
- `retryPolicy`
- `escalationPolicy`
- `riskPosture`
- `originatingIntent`
- `requestId`

Add a small set of Guardian-owned `CodingLaneRecipe` templates rather than an open-ended workflow authoring surface. Example recipes:

- `inspect_and_plan`
- `implement_then_verify`
- `repair_failing_checks`
- `compare_workspaces`
- `delegated_verification_lane`

### Guardian fit

This fits the current architecture because it does not replace routing or tools. It clarifies the handoff between:

`IntentGateway` -> coding-session grounding -> execution loop -> verification -> timeline

### Primary files

- [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- [src/runtime/incoming-dispatch.ts](../../src/runtime/incoming-dispatch.ts)
- [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts)
- [src/tools/executor.ts](../../src/tools/executor.ts)
- [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts)

## 3. Add Guardian-Native Context Packs Above `workspaceMap` And `workingSet`

### Problem

Guardian already does bounded repo indexing and per-turn working-set retrieval well. What it does not yet do as explicitly is package that evidence into a reusable run-scoped artifact with source classes, fetch reasons, and omission reasons.

### Henchmen lesson

Henchmen's `DossierBuilder` is useful because it makes pre-execution context assembly a first-class thing. The exact sources are not all transferable, but the pattern is:

- fetch by declared need
- package once
- pass the coding lane a bounded context pack
- degrade explicitly when some sources are unavailable

### Guardian-native proposal

Add a `CodeSessionContextPack` artifact for coding and delegated coding lanes.

Suggested sections:

- workspace instructions: `AGENTS.md`, repo-local instruction files, trust-gated README summary
- repo structure: current `workspaceProfile` and `workspaceMap`
- focused evidence: current `workingSet`
- operator state: focus summary, plan summary, selected file, changed files, pending approvals
- verification state: latest failing tests, lint/build output, pending verification items
- external evidence where configured: related PRs, related issues, CI failure summaries, connector-backed notes
- provenance and omissions: why each source was loaded, skipped, truncated, or suppressed by trust policy

This should remain compatible with [docs/design/CODING-WORKSPACE-DESIGN.md](../design/CODING-WORKSPACE-DESIGN.md): `workspaceProfile`, `workspaceMap`, and `workingSet` remain canonical; the context pack is a run-scoped projection, not a second indexing system.

### Quick borrowings worth copying almost directly

- explicit degraded-mode language when external code search or issue/PR fetches are unavailable
- source-class budgeting before the model call
- artifact-style persistence so delegated or resumed lanes can reuse the same pack

### Primary files

- [src/runtime/code-workspace-map.ts](../../src/runtime/code-workspace-map.ts)
- [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- `src/runtime/context-assembly.ts`
- [web/public/js/pages/code.js](../../web/public/js/pages/code.js)

## 4. Add Fail-Closed Verification Contracts And Repair Loops

### Problem

Guardian already records verification entries and recent coding jobs, but the runtime still needs a stronger contract for when it may truthfully say:

- the fix is complete
- the implementation is verified
- the lane is ready for review or PR

### Henchmen lesson

Henchmen treats verification as a first-class control loop:

- implement
- verify
- run lint
- repair lint if needed
- run tests
- repair tests if needed
- only then promote

It also treats failures as explicit branch outcomes, not vague narrative text.

### Guardian-native proposal

Introduce a `VerificationContract` attached to each coding lane.

Suggested fields:

- `requiredChecks`
- `preferredOrder`
- `status`
- `lastCompletedCheck`
- `blockingFailures`
- `repairAttempts`
- `waiverReason`
- `honestyWarnings`

Add a lightweight Guardian-owned repair loop for common lane types:

- `implement_then_verify`
- `repair_failing_checks`
- `review_then_repair`

These should use shared `PendingActionStore`, `recentJobs`, and `verification` instead of inventing a separate lane runtime.

### Additional borrowing: diff legitimacy review

Henchmen's `SilentFailureDetector` is exactly the kind of small, sharp subsystem Guardian should adopt.

Guardian should add a diff-risk pass that flags:

- no-op or whitespace-only changes
- swallowed exceptions / empty catches
- hardcoded secrets
- TODO-only "fixes"
- suspicious test deletions or test weakening
- completion claims without meaningful changed files

This should feed:

- `recentJobs`
- `verification`
- run timeline annotations
- completion copy shown in chat and Code UI

### Primary files

- [src/tools/executor.ts](../../src/tools/executor.ts)
- [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts)
- [web/public/js/pages/code.js](../../web/public/js/pages/code.js)
- [scripts/test-coding-assistant.mjs](../../scripts/test-coding-assistant.mjs)

## 5. Add Durable Lane Checkpoints For Long Coding And Delegated Work

### Problem

Guardian's current state model is strong for blocked work and surface continuity, but long-running coding work still lacks a single checkpoint artifact that answers:

- what phase is this lane in right now
- what has already completed
- what can be retried safely
- what is waiting on approval, verification, or a provider/backend restart

### Henchmen lesson

Henchmen's persisted checkpoint model is one of its best ideas:

- current node
- node results
- retry counts
- heartbeat
- resumed execution after interruption

### Guardian-native proposal

Add a `CodeLaneCheckpoint` record persisted with the code session and projected into assistant jobs and run timeline views.

Suggested fields:

- `laneId`
- `requestId`
- `recipe`
- `phase`
- `completedSteps`
- `stepResults`
- `retryCounts`
- `awaiting`
- `lastHeartbeatAt`
- `resumeHint`
- `artifactRefs`

This is especially important for:

- delegated child lanes from the multi-workspace proposal
- optional external coding backend sessions
- long-running build/test/repair sequences
- continuation after browser refresh, CLI reconnect, or provider failover

### Architectural constraint

This must extend shared orchestration and `CodeSession` state. It must not become a bespoke per-tool resume path.

### Primary files

- [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts)
- [src/runtime/orchestrator.ts](../../src/runtime/orchestrator.ts)
- [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts)

## 6. Add A Repo-Fixture Coding Eval Harness

### Problem

Guardian has strong integration harnesses, but it still needs a smaller, faster benchmark for "does the coding runtime make grounded, honest, useful repo changes?"

### Henchmen lesson

The best part of `evals/harness.py` is not the implementation language. It is the scoring model:

- use a tiny real repo fixture
- run the agent against it
- score the actual diff
- optionally run the fixture tests
- do not grade success by the model's self-description

### Guardian-native proposal

Add a coding-workspace fixture harness with:

- `task.json`
- `repo/`
- expected changed files
- expected diff substrings
- forbidden diff patterns
- optional verification command
- optional trust-state expectation

Use it to benchmark:

- working-set retrieval quality
- plan grounding
- implementation quality
- verification honesty
- completion honesty
- delegated lane recovery

This should sit beside the current `scripts/` harnesses, not replace them.

### Primary files

- `scripts/`
- `evals/` or `tmp/fixtures/` depending on repo preference
- [scripts/test-coding-assistant.mjs](../../scripts/test-coding-assistant.mjs)

## 7. Add An Optional Clean-Room Verification Lane

### Problem

Some coding tasks benefit from a clean execution context:

- reproducing CI failures
- validating suspicious dependency changes
- verifying a caution-trust workspace
- testing a delegated child lane without contaminating the main operator session

### Henchmen lesson

Henchmen's ephemeral operative containers are effective because they make "fresh environment verification" a normal part of the system.

### Guardian-native proposal

Do not copy container-per-task as the default UX. Do add an optional clean-room verification lane that can be spawned as a child lane beneath a `CodeSession`.

Potential uses:

- run a clean lint/test/build verification
- review a diff with stricter mutation disabled
- reproduce failing checks from a separate workspace or branch
- execute in a stronger sandbox posture than the foreground session

This aligns with Guardian's existing direction around child lanes and brokered isolation better than a separate PR-factory service would.

### Primary files

- `src/supervisor/worker-manager.ts`
- [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- [src/runtime/run-timeline.ts](../../src/runtime/run-timeline.ts)
- [src/tools/executor.ts](../../src/tools/executor.ts)

## Small Borrowings Worth Doing Early

These are lower-cost improvements that do not require a major runtime refactor.

- Add per-lane tool-family allowlists and surface them in operator-visible lane metadata.
- Add phase-aware "you have only read files so far" nudges for long coding turns.
- Add task-level cost and wall-clock ceilings for long coding lanes, not just per-tool protection.
- Add explicit degraded copy when a coding lane lacks external repo evidence, CI evidence, or connector-backed issue/PR context.
- Add branch-freshness and changed-file-scoped verification guidance to final coding summaries.

## Recommended Delivery Order

### Phase 1: Live visibility first

- add structured backend session events
- map them into `run.timeline`
- render them in Code, web chat, and CLI
- keep Telegram summary-only if transport constraints make full streaming impractical

### Phase 2: Execution truthfulness

- add `CodingExecutionBrief`
- add `CodeSessionContextPack`
- wire provenance and omission reasons into coding prompt assembly

### Phase 3: Verification honesty

- add `VerificationContract`
- add diff-risk review / silent-failure scanning
- tighten completion copy so "done" means something specific

### Phase 4: Resume and delegation depth

- add `CodeLaneCheckpoint`
- project checkpoints into run timeline, assistant jobs, and Code UI
- align child lanes and delegated coding backends with the same checkpoint contract

### Phase 5: Benchmark and clean-room leverage

- add repo-fixture coding eval harness
- add optional clean-room verification lane

## Final Recommendation

Guardian should not chase Henchmen's service topology. It should copy Henchmen's execution discipline.

The most valuable near-term uplift is to make external coding backends feel natively visible inside Guardian.

That means:

- a live structured run log in web UI and CLI
- explicit phase changes instead of opaque subprocess waiting
- approval and verification states rendered as first-class timeline events

Then, beneath that visibility layer, Guardian should make every meaningful coding lane more explicit:

- explicit objective
- explicit context pack
- explicit tool scope
- explicit verification contract
- explicit checkpoint state
- explicit diff-quality review

That is the part of Henchmen that translates cleanly into Guardian and would materially improve both architecture and usefulness for the coding assistant, delegated orchestration, and other repo-grounded runtime flows.
