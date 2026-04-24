# Intent Gateway And Delegated Execution Realignment Plan

**Status:** Archived historical remediation record. Future orchestration work is superseded by `../DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md`.
**Date:** 2026-04-22
**Superseded by:** `../DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md`

> Cleanup note (2026-04-24): This plan documents the gateway/delegated-execution realignment that led to the direct-reasoning split. It should no longer be treated as the active remediation plan for hybrid read/write, recovery, or timeline failures. Those failures should be addressed through the durable execution graph, typed artifacts, graph events, and graph-native recovery.

**Replaces:**
- `docs/plans/EXECUTION-EVIDENCE-AND-ORCHESTRATION-REARCHITECTURE-PLAN.md`
- `docs/plans/SUB-AGENT-COMPLETION-CONTRACT-REMEDIATION-PLAN.md`
- `docs/plans/INTENT-GATEWAY-EXECUTION-CONTINUATION-REMEDIATION-PLAN.md`
- `docs/plans/REMEDIATION-INTENT-AND-VERIFIER.md`
- `docs/plans/WEB-CLI-LIVE-PROGRESS-IMPLEMENTATION-PLAN.md`

## Purpose

Reset Guardian's routing and delegated-execution architecture around the parts that already exist in the repo, remove the contradictory fallback behavior that accumulated during remediation, and restore one coherent story for:

- gateway-owned semantic routing
- request-scoped execution-profile selection
- code-session context attachment
- delegated worker completion contracts
- verifier authority
- trace and progress projection

This is not a blank-slate rewrite plan. The repo already contains a partial landing of the contract work. The problem is that the implementation and the plan stack diverged.

## Status Snapshot (2026-04-22)

### Completed and committed

- **Workstream 1: Gateway Signal Canonicalization** is complete and committed in `f61112a`.
- **Workstream 2: Code-Session And Delegation Boundary Cleanup** is complete and committed in `5fe01c5`.

### In progress and not ready to commit

- **Workstream 3: Planned-Step Discipline** is still open.
- The contract layer now preserves real request summaries better on degraded routes, carries grounded retry refs forward, and enforces step/tool compatibility more strictly.
- **Phase 3A changes (2026-04-23):**
  - Added `implementation_file` and `symbol_reference` claim kinds to distinguish search-hit files from implementation files
  - Added `AnswerConstraints` to the contract with `requiresImplementationFiles`, `requiresSymbolNames`, `readonly`, and `requestedSymbols`
  - Added `verifyRepoInspectionRequirements` to check implementation-file claims and symbol references beyond basic file-reference existence
  - Fixed modifier-clause handling: "Do not edit anything" and "Cite exact file names" are now answer constraints, not separate steps
  - Added `deriveAnswerConstraints` in request-patterns.ts for extracting answer constraints from request text
  - Enriched answer-step summaries for repo-inspection contracts with constraint-specific quality guidance
  - Worker session now classifies `fs_read` claims as `implementation_file` for repo-inspection contracts
  - Worker session extracts `symbol_reference` claims from final answers when the contract requires symbol names

### Current manual web baseline

- `Just reply hello back`
  - **Pass**
  - Direct/simple behavior is stable again.
- `Write the current date and time to tmp/manual-web/current-time.txt. Search src/runtime for planned_steps. Write a short summary to tmp/manual-web/planned-steps-summary.txt.`
  - **Pass**
  - Multi-step delegated write/search/write behavior is currently good enough to keep protected as a regression.
- `Inspect this repo and tell me which files and functions or types now define the delegated worker completion contract. Cite exact file names and symbol names.`
  - **Previously soft fail, now has infrastructure for catching semantically wrong answers**
  - The verifier can now distinguish `implementation_file` claims from `file_reference` search-hit claims and require `symbol_reference` claims when the prompt asks for symbol names. However, the LLM model quality still determines whether the *right* implementation files are cited — the verifier can reject answers that cite only search-hit files with no implementation grounding.
- `Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.`
  - **Previously hard fail, now has infrastructure for fix**
  - "Do not edit anything" is now an answer constraint (`readonly: true`) rather than a separate required step, so the modifier-clause step-coverage failure should be resolved. The `readonly` constraint also means `filesystem_mutation` claims will be flagged as violations.

### What this means

- The routing boundary work is materially better than it was at the start of remediation.
- The remaining blocker was that the shared contract/verifier path could not reliably enforce the difference between a grounded but semantically wrong repo-inspection answer and a grounded and semantically correct implementation answer.
- Phase 3A changes add the verification infrastructure to make this distinction: `implementation_file` vs `file_reference` claims, `symbol_reference` claims, `AnswerConstraints` with `requiresImplementationFiles` and `requiresSymbolNames`, and `verifyRepoInspectionRequirements`.
- The modifier-as-step bug is fixed: "Do not edit anything" and "Cite exact file names" are now answer constraints, not separate required steps.

Do not treat Workstream 3 as complete until both repo-inspection prompts above are clean in manual web validation.

## Current Implementation Baseline

The following pieces are already real and should be treated as the starting point, not future aspirations:

### 1. Gateway-first routing still exists

- `src/runtime/incoming-dispatch.ts` still classifies normal turns through the Intent Gateway before agent dispatch.
- `src/runtime/intent-gateway.ts` still owns the structured classifier facade, fallback chain, and metadata serialization.
- `src/runtime/intent/structured-recovery.ts` and `src/runtime/intent/unstructured-recovery.ts` already produce structured route and workload metadata, including `plannedSteps` in some cases.

### 2. Typed delegated completion already exists

- `src/runtime/execution/types.ts` defines `DelegatedTaskContract.plan`, `StepReceipt`, `WorkerRunStatus`, `WorkerStopReason`, `ExecutionEvent`, and `DelegatedResultEnvelope`.
- `src/runtime/execution/task-plan.ts` already builds planned tasks, matches tool activity to steps, computes step receipts, and derives worker run status.
- `src/runtime/execution/verifier.ts` already verifies delegated results from typed envelope state and planned-step coverage.
- `src/worker/worker-session.ts` already emits typed delegated envelopes with `runStatus`, `stopReason`, `stepReceipts`, `evidenceReceipts`, `interruptions`, and `events`.
- `src/supervisor/worker-manager.ts` already consumes typed envelopes, preserves satisfied steps across retry, and can synthesize degraded failure envelopes from job snapshots when a worker fails before returning a typed envelope.

### 3. Request-scoped provider selection already exists

- `src/runtime/execution-profiles.ts` already attaches request-scoped execution-profile metadata and preserves request overrides through delegated profile selection.
- `src/chat-agent.ts` already has provider-order handling for direct inline chat and can start on the selected external provider instead of always starting on `ctx.llm`.

### 4. Shared projections already exist

- `src/runtime/intent-routing-trace.ts` and `src/runtime/run-timeline.ts` already ingest delegated-worker lifecycle and related metadata.
- Web and CLI already consume those projections through existing runtime and UI plumbing.

The reset plan must converge these pieces. It must not pretend they are absent and start a second architecture beside them.

## What Drifted

### 1. Structured gateway reuse is inconsistent

Some layers treat a degraded but structured gateway result as authoritative enough to keep, while others discard it because `available === false`.

Current mismatch:

- `src/runtime/intent-gateway.ts` only treats pre-routed gateway metadata as reusable when `available !== false`.
- `src/runtime/incoming-dispatch.ts` falls back to raw `routeWithTier(...)` routing when `gateway?.available` is false, even if a structured decision exists.
- `src/runtime/direct-intent-routing.ts` drops all direct-intent candidates when `gateway.available === false`.
- `src/worker/worker-session.ts` already special-cases degraded pre-routed gateway records and reuses them anyway.

Result:

- the stack disagrees with itself about whether a structured recovered decision is real
- tier routing, direct-intent routing, chat-agent behavior, and delegated worker behavior can all diverge for the same request

### 2. Code-session context is still mutating orchestration

Code-session attachment is supposed to add workspace context. It is still influencing semantic execution choices.

Current drift:

- `src/runtime/code-session-request-scope.ts` defaults to attaching the current coding session when the gateway decision is missing.
- `src/runtime/orchestration-role-contracts.ts` returns `Guardian Coordinator` for `general_assistant` and also as a generic fallback when `hasCodeSession` is true.
- `src/chat-agent.ts` still defaults to the worker-manager path whenever a worker manager exists unless an explicit inline bypass fires.

Result:

- simple chat turns can still get swept into delegated orchestration because a coding session is attached
- the gateway no longer feels authoritative even when it classified the turn correctly

### 3. Planned-step synthesis is too eager

`src/runtime/intent/structured-recovery.ts` still synthesizes `plannedSteps` by splitting raw prose into clauses when the classifier does not emit an explicit plan.

This causes modifier phrases such as:

- `Cite exact file names and symbol names`
- `Do not edit anything`

to be treated as required steps instead of answer constraints or route metadata.

Result:

- the verifier ends up enforcing invented work
- retry directives become misleading
- weak-model failures look like step-coverage problems when the real issue is bad plan synthesis

### 3b. Answer-step semantics are still too weak for exact-file repo inspections

The contract and verifier currently do a better job of checking step coverage than they do of checking semantic answer quality.

Current failure shape:

- a delegated repo-inspection run can complete with grounded file references and still answer the wrong question
- a run can satisfy the `answer` step because a final answer exists, even when the answer does not identify the actual implementation files or requested symbols
- exact-file verification currently proves "the final answer cited some grounded file references" more reliably than it proves "the final answer cited the correct implementation files and symbols for the request"

Result:

- semantically wrong implementation answers can still pass
- the remaining failing prompt can still collapse into step-coverage failure instead of converging on the right implementation answer
- Workstream 3 is no longer just about plan-shape synthesis; it is also about tightening shared answer-step semantics

### 4. The envelope cutover is incomplete

The repo now has a typed envelope, but the old worker metadata still participates in control flow and diagnostics.

Examples:

- `src/runtime/worker-execution-metadata.ts` still carries `completionReason`, `responseQuality`, and `terminationReason`.
- `src/worker/worker-session.ts` still emits `workerExecution` metadata alongside the typed envelope.
- `src/supervisor/worker-manager.ts` still reads `workerExecution` metadata for degraded-envelope and missing-envelope handling.

Result:

- there are still two stories about what "completion" means
- traces and fallback paths can still lean on the old metadata model instead of the envelope as the sole truth

### 5. The execution/event story is half-committed

The repo has `ExecutionEvent` types and timeline projections, but it does not yet have one singular append-only execution/event store that owns delegated tool events, verifier decisions, approvals, and replay.

Result:

- the docs alternate between "full execution DAG/store cutover" and "bounded delegated metadata plus projections"
- the implementation is somewhere in between

### 6. The docs became a stack of overlapping canon

The deleted plan set was confusing because it mixed:

- speculative rearchitecture
- mid-flight remediation
- historical status notes
- supersession chains

More than one document claimed to be the canonical plan for the same surface area.

## Architectural Decisions

### 1. A structured gateway decision remains authoritative even when produced by degraded recovery

`available` describes classifier transport quality. It does not erase a valid structured route/workload decision.

Consequence:

- introduce one shared predicate for "structured gateway decision is reusable"
- use it consistently across incoming dispatch, chat agent, direct-intent routing, worker manager, and worker session

### 2. Code-session attachment is context only

Attaching a code session may:

- add workspace/tool context
- scope file and repo operations
- enable coding-session control operations

It must not:

- silently promote `general_assistant` into coding or repo-grounded work
- cause delegation by itself
- override the gateway's route or execution class

### 3. Delegation is driven by structured workload, not by `hasCodeSession`

The delegation decision must come from routed intent, selected execution profile, and explicit orchestration rules.

`hasCodeSession` may influence context assembly. It must not be a semantic fallback that turns normal chat into `Guardian Coordinator`.

### 4. The current typed delegated envelope is the canonical completion contract

The canonical completion contract is the existing typed envelope built around:

- `taskContract.plan`
- `stepReceipts`
- `evidenceReceipts`
- `interruptions`
- `runStatus`
- `stopReason`
- `modelProvenance`

The verifier and retry logic must converge on this contract instead of using prose or legacy worker metadata as an alternate truth source.

### 5. `workerExecution` metadata is transitional observability only

Keep `workerExecution` metadata only while it still serves trace compatibility or diagnostics.

It must not:

- drive acceptance
- imply satisfaction
- contradict the typed envelope

Once the envelope-first cutover is complete, `workerExecution` metadata should either be reduced to a thin projection or removed.

### 6. Do not start a second execution-store rewrite before routing and delegated completion agree on one contract

The immediate problem is contract inconsistency, not lack of a fresh type tree.

After the routing and envelope boundaries are stable, pick exactly one next step:

- wire a real canonical execution/event store, or
- delete unused execution-store scaffolding and explicitly standardize on the current envelope-plus-projection model

Do not keep both narratives alive.

### 7. This file is the only canonical plan for this surface area

Future changes to gateway/delegation/verifier realignment must update this file instead of creating sibling remediation plans.

## Workstreams

### Workstream 1: Gateway Signal Canonicalization

**Status:** Complete and committed

Goals:

- treat structured fallback decisions consistently
- stop dropping route/workload metadata when `available === false`
- keep request-scoped provider overrides sticky across direct and delegated paths

Required changes:

- introduce one shared reusable-decision predicate
- use it in `incoming-dispatch.ts`, `chat-agent.ts`, `direct-intent-routing.ts`, `worker-manager.ts`, and `worker-session.ts`
- when a structured decision exists, prefer `routeWithTierFromIntent(...)` over raw-text `routeWithTier(...)`
- keep degraded routing visible in trace metadata without discarding the decision

### Workstream 2: Code-Session And Delegation Boundary Cleanup

**Status:** Complete and committed

Goals:

- stop code-session context from mutating normal chat into delegated coding work
- preserve explicit coding/filesystem/repo-grounded behavior

Required changes:

- change `shouldAttachCodeSessionForRequest()` so missing gateway state does not auto-attach by default
- remove the generic `hasCodeSession => Guardian Coordinator` fallback
- keep `general_assistant` and `direct_assistant` turns inline unless the structured workload explicitly requires tool execution or delegated orchestration
- keep attached coding-session context available for explicit coding, filesystem, repo-grounded, and session-control turns

### Workstream 3: Planned-Step Discipline

**Status:** In progress

Current landing:

- degraded/placeholder gateway summaries are no longer allowed to flow straight through as the delegated contract summary
- generic generated answer steps can now be rewritten from the delegated contract summary instead of always staying at `Answer the request directly.`
- step/tool matching, dependency-aware retry carry-forward, and grounded retry hints are stricter than they were at the start of this phase

Remaining gap:

- exact-file repo inspections still do not have strong enough shared answer-step semantics
- one exact-file repo-inspection prompt still fails outright
- another exact-file repo-inspection prompt now completes but still produces a semantically wrong/incomplete answer

Goals:

- stop fabricating verifier requirements from modifiers
- make multi-step plans come from either explicit classifier output or clearly sequential action structure
- make answer steps carry the real user ask when the gateway summary is degraded or generic
- stop accepting semantically wrong exact-file repo-inspection answers just because they cite grounded files

Required changes:

- trust classifier-emitted `planned_steps` as the primary multi-step source
- restrict deterministic synthesis to clear sequential action lists
- stop turning answer modifiers such as `cite exact file names`, `do not edit anything`, or similar constraints into separate required steps
- preserve the real delegated ask in the contract and answer-step criteria even when the gateway summary is degraded
- if needed, add explicit step-level constraint fields or contract flags rather than inventing more steps
- add shared answer constraints for exact-file repo inspections instead of relying only on generic `answer` step completion
- tighten exact-file verification so it can distinguish implementation files from merely grounded but irrelevant search hits or helper files
- tighten symbol/file citation verification so prompts asking for symbol names do not pass without the requested symbols
- keep the multi-step write/search/write prompt and simple direct greeting as explicit regression gates while tightening repo-inspection quality

### Workstream 4: Envelope-First Verifier Cutover

Goals:

- make typed envelope state the only completion authority
- demote legacy worker metadata to diagnostics

Required changes:

- keep verifier decisions envelope-first
- ensure retry directives come from step coverage and interruption state
- define missing-envelope behavior as an explicit degraded failure path
- if job-snapshot synthesis remains temporarily, mark it as diagnostic/degraded only and never let it impersonate a normal success path
- delete or demote remaining acceptance branches that rely on `completionReason`, `responseQuality`, or other legacy worker metadata

### Workstream 5: Execution/Event Steady-State Decision

Goals:

- stop carrying two incompatible architecture stories

Required decision after Workstreams 1-4 are green:

- either wire a real append-only execution/event store that owns delegated tool events, verifier decisions, approvals, and timeline projection
- or declare the current envelope-plus-projection model canonical and delete unused `ExecutionRecordV2` / `ExecutionNode` scaffolding

The key requirement is a single story, not a specific favorite implementation.

### Workstream 6: Documentation And Governance

Goals:

- keep one canonical plan
- keep design docs aligned with the current convergence path

Required changes:

- retarget design-doc and plan-doc references to this file
- do not recreate the deleted remediation stack under new filenames
- require future status updates to append here instead of spawning overlapping plan docs

## Sequencing

1. Canonicalize degraded structured gateway reuse.  
   Status: done.
2. Remove code-session-driven orchestration fallback.  
   Status: done.
3. Finish Workstream 3 by tightening answer-step semantics and exact-file repo-inspection quality.  
   Do not advance until both repo-inspection manual prompts are clean.
4. Finish envelope-first verification and retry behavior.
5. Decide the long-term execution/event spine.
6. Update design docs, harnesses, and brittle expectations in the same change sets.

## Next Phase Checklist

### Phase 3A: Finish planned-step discipline

- make exact-file repo-inspection answer constraints first-class in the shared contract
- tighten verifier checks for implementation-file relevance and requested symbol coverage
- ensure the delegated worker completion-contract prompt returns the actual contract files and symbols, not just any grounded files
- ensure the delegated worker progress/timeline prompt completes without step-coverage failure
- fix modifier-clause handling so "Do not edit anything" and "Cite exact file names" become answer constraints instead of separate required steps
- add `implementation_file` and `symbol_reference` claim kinds to distinguish search hits from implementation grounding
- add `AnswerConstraints` to `DelegatedTaskContract` with `requiresImplementationFiles`, `requiresSymbolNames`, `readonly`, and `requestedSymbols`
- add `deriveAnswerConstraints` to extract constraints from request text patterns
- add `verifyRepoInspectionRequirements` to check implementation-file claims, symbol references, and readonly compliance
- enrich answer-step summaries for repo-inspection contracts with constraint-specific quality guidance
- classify worker `fs_read` claims as `implementation_file` for repo-inspection contracts
- extract `symbol_reference` claims from final answers when contract requires symbol names
- add retry hints for `implementation_file_claim`, `symbol_reference_claim`, and `readonly_violation` missing evidence kinds

### Phase 3A manual gates

- `Inspect this repo and tell me which files and functions or types now define the delegated worker completion contract. Cite exact file names and symbol names.`
  - must complete
  - must name the real contract-defining and contract-consuming files
  - must include the requested symbol names
- `Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.`
  - must complete
  - must cite the actual implementation files, not just arbitrary grounded files
- `Write the current date and time to tmp/manual-web/current-time.txt. Search src/runtime for planned_steps. Write a short summary to tmp/manual-web/planned-steps-summary.txt.`
  - must keep passing
- `Just reply hello back`
  - must keep passing

### Phase 4

- after Workstream 3 is clean, move to envelope-first verifier cutover
- demote legacy `workerExecution` metadata to diagnostics only
- remove any remaining acceptance/control-flow dependence on legacy completion metadata

## Exit Criteria

- degraded structured gateway decisions are reused consistently across routing, direct-intent, and worker handoff layers
- a simple `general_assistant` or `direct_assistant` turn does not delegate just because a coding session is attached
- planned-step synthesis no longer invents verifier requirements from modifiers
- answer-step summaries reflect the real delegated ask rather than placeholder gateway summaries
- exact-file repo-inspection verification can reject semantically wrong implementation answers even when they cite grounded files
- delegated acceptance is driven by the typed envelope, not prose or legacy `completionReason` fields
- the repo tells one coherent story about execution/event canonical state
- the overlapping plan stack listed above is gone

## Verification

### Unit and integration

- degraded-but-structured gateway records still drive tier routing and direct-intent candidate selection
- attached coding-session greeting and normal-chat turns stay inline on the selected provider
- modifier prompts remain one inspection step plus constraints instead of splitting into fake steps
- placeholder gateway summaries do not become the delegated contract summary when `resolvedContent` is available
- generic answer steps are rewritten from the real delegated ask when the gateway emits only placeholder summary text
- verifier decisions change only with envelope state, not `workerExecution` prose labels
- multi-step delegated filesystem/coding prompts preserve satisfied steps across retry without plan drift
- exact-file repo-inspection prompts do not pass on semantically wrong grounded answers
- `implementation_file` claims satisfy repo-inspection requirements while `file_reference` claims alone are insufficient
- `symbol_reference` claims are required when `requiresSymbolNames` is set
- modifier phrases become answer constraints instead of separate required steps
- readonly constraint (`answerConstraints.readonly`) blocks satisfaction on mutation claims

### Manual web validation baseline (2026-04-22)

- `Just reply hello back`
  - current status: passing
- `Write the current date and time to tmp/manual-web/current-time.txt. Search src/runtime for planned_steps. Write a short summary to tmp/manual-web/planned-steps-summary.txt.`
  - current status: passing
- `Inspect this repo and tell me which files and functions or types now define the delegated worker completion contract. Cite exact file names and symbol names.`
  - current status: completes but still wrong/incomplete
- `Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.`
  - current status: still failing verification

### Harness

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- routing/delegation smoke coverage for degraded gateway reuse, plan synthesis, and attached coding-session direct chat

Current harness caveats:

- `test-code-ui-smoke.mjs` can still require a rerun because of an existing Web UI flake around `example.ts` selection plus the usual `401 /api/status` and Monaco cancellation noise.
- `test-coding-assistant.mjs` can still require a rerun on Windows when the native AV readiness checks lag before the harness settles.
- Treat those as harness flake/readiness issues, not as automatic evidence that the routing/delegation architecture regressed.

## Operating Rule

Do not create a new remediation-plan sibling for gateway/delegation/verifier architecture.

Update this file instead.
