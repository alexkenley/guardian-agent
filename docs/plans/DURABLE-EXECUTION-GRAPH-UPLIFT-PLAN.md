# Durable Execution Graph Uplift Plan

**Status:** Architecture refinement and refactoring phase. Phases 1-4 are implemented for the read-only graph/artifact lane and the first graph-controlled search/write slice. Phase 5+ approval/continuation and delegated graph cleanup are partially implemented, but the current risk is no longer missing primitives. The risk is overlapping orchestration ownership between `ChatAgent`, `WorkerManager`, pending actions, continuity, execution records, and the graph. The next phase must make graph ownership explicit and delete each legacy owner as its replacement lands.
**Date:** 2026-04-26
**Supersedes for future work:**
- `docs/plans/archive/DIRECT-REASONING-MODE-ARCHITECTURE-SPLIT.md`
- `docs/plans/archive/INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md`

## Purpose

Guardian's direct-reasoning/delegated-orchestration split improved several symptoms, but the manual web tests show the split is still too binary. Direct reasoning can perform iterative read/search, and delegated orchestration can perform writes, approvals, and verification, but hybrid requests still depend on fragile prose handoffs and separate observability paths.

This plan replaces the binary split with a durable execution graph. Direct reasoning, synthesis, writes, approvals, delegation, verification, and recovery become typed graph nodes under one request id, one artifact flow, one run timeline, and one security boundary.

This is not a request to import LangGraph, Temporal, or another framework. The plan adopts the durable-workflow patterns that those systems use, while preserving Guardian's existing TypeScript runtime, Intent Gateway, brokered worker boundary, Guardian policy layer, and approval system.

## Current Implementation State

As of 2026-04-24:

- Phase 1 graph kernel and event projection are implemented: execution graph types, event types, bounded store, run-timeline adapter, and focused tests.
- Phase 2 direct reasoning as an `explore_readonly` graph node is implemented: direct reasoning emits graph events, read/search tool calls project into `RunTimelineStore`, and focused direct-reasoning/run-timeline tests pass.
- Phase 3 typed artifact store and grounded synthesis are implemented for the read-only lane: graph-owned artifact storage retains typed artifact contents and refs, direct reasoning emits `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft` artifacts, and no-tools synthesis consumes bounded evidence artifacts.
- Phase 4 mutation nodes are implemented for the first structured search/write lane: required write steps now keep top-level requests out of read-only direct reasoning, route read-like coding plans with structured writes to workspace implementer orchestration, synthesize `WriteSpec`, execute `fs_write` through supervisor-owned tool execution, and verify the written contents.
- The read-only manual/API lane has proven the harder repo-inspection prompts on `ollama-cloud-coding` / `glm-5.1` without frontier escalation, including "files implementing run timeline rendering" and "which web pages consume `run-timeline-context.js`".
- Exact-file synthesis coverage for reverse dependency/consumer questions is handled in evidence selection, synthesis coverage, path canonicalization, and gateway recovery normalization, not by intent-routing keyword interception.
- Do not move to broader hybrid write behavior until this read-only/artifact lane remains stable through a broader manual web UI pass and the focused verification commands below.

### 2026-04-26 Handoff Status

The latest work focused on orchestration quality, evidence grounding, provider fallback, continuation, and approval-resume recovery. These changes are intentionally in shared routing/orchestration/verifier layers, not keyword intent-routing band-aids.

Implemented in the current dirty worktree:

- Structured task-plan category matching now lets evidence tools satisfy semantic planned-step categories such as `repo_inspect`, `web_search`, and answer/model-answer steps without adding pre-gateway keyword routing.
- Direct reasoning now refuses non-read-only planned evidence, retries when a repo-grounded answer appears before read/search evidence, treats weak/empty search evidence as insufficient, and defaults brokered `fs_search` calls to content search when the model omits a mode.
- Grounded answer synthesis fallback now runs as a no-tools LLM pass over collected evidence when tool execution succeeded but the delegated worker failed to produce a final answer.
- Approval-continuation recovery now carries approved tool results into the resumed tool loop and can synthesize a final answer from those approved tool receipts if the first resumed model turn is empty.
- Intent Gateway confirmation guidance now makes mixed web+repo requests produce concrete planned steps (`web_search`, `repo_inspect`, answer) so direct read-only reasoning does not accidentally absorb external research requests.
- Managed-cloud classifier fallback now tries other configured managed-cloud providers when the preferred classifier/profile is unavailable or rate limited.

Verified locally after these changes:

- Focused Vitest slices passed for direct reasoning, task-plan/verifier, worker-manager, worker-session, tool-loop resume, confirmation pass, intent gateway, and incoming dispatch fallback.
- `npm run check` passed.
- `npm run build` passed.
- Live API replay passed the core read-only ladder for:
  - "Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything."
  - "Inspect this repo and tell me which web pages consume run-timeline-context.js. Do not edit anything."
  - "Inspect this repo and tell me which files implement direct reasoning graph artifacts. Do not edit anything."
- Live API replay for web+repo comparison succeeded with a planned `web_search` + `repo_inspect` + answer contract and satisfied delegated verification.
- Live scratch-file write to `tmp/manual-web/approval-resume-smoke.txt` succeeded, but it did not request approval because the current policy allowed that path/action.

Known remaining problems and risks:

- A live gated approval-resume test is still outstanding. The latest scratch write proved mutation execution, not approval pause/resume, because policy allowed the write without an approval interrupt.
- Follow-up continuity is improved but not fully proven. A follow-up like "Based on your last answer..." can now recover a useful answer, but one replay selected `src/runtime/execution-graph/pending-action-adapter.ts` as the approval-continuity file. That answer is defensible for graph pending actions, but the expected answer may be closer to `approval-continuations.ts`, `tool-loop-continuation.ts`, or `approval-state.ts` depending on which previous answer the user meant. This needs explicit conversation-history/evidence anchoring tests.
- The unstructured intent repair path has been retired. Prose-only classifier responses now remain unavailable gateway records so fallback passes, structured recovery, or clarification own recovery; there is no raw-text post-gateway route inference path.
- The full `npm test` suite has not been rerun after the latest continuation/provider-fallback fixes. It must run before commit.
- The web UI approval experience still needs a manual pass once a policy-gated action is identified reliably.

Recommended next slice before moving into the broader web UI phase:

1. Identify or configure a harmless action that is definitely approval-gated under the current dev policy, then run a live web/API approval-resume smoke that proves pending action creation, decision submission, tool execution, and continuation response.
2. Add/strengthen tests for follow-up anchoring against the immediately previous answer and its evidence artifacts, especially "based on your last answer" questions.
3. Run `npm test`, then rerun the short live API replay ladder.
4. Commit only after the above passes or after explicitly documenting any remaining failures in this plan.

### 2026-04-26 Architecture Refinement And Debt-Burn Phase

The architecture audit found that Guardian now has most of the necessary primitives, but several partial systems still own the same lifecycle decisions. The next phase is a refactor and deletion phase, not a feature expansion phase.

Root ownership problems to resolve:

- `ChatAgent` still owns normal turn orchestration, direct capability dispatch, tool-loop resume, retry/continuation repair, and response shaping.
- `WorkerManager` still owns delegated execution, retries, recovery advice, graph setup, and graph persistence instead of acting as a graph node runner.
- `PendingActionStore`, `ExecutionStore`, `ContinuityThreadStore`, `ExecutionGraphStore`, and `RunTimelineStore` each hold part of the same execution lifecycle without one authoritative owner.
- Approval continuity is split across pending actions, live `ToolExecutor` approvals, capability-continuation replay, tool-loop replay, and execution-graph interrupts.
- Continuity still has semantic recovery authority in places. It must become context projection over active execution refs and artifacts, not a source of reconstructed intent.
- Routing and repair are split between pre-dispatch gateway handling, `ChatAgent` classification, direct candidate routing, and delegated retry/recovery.
- Provider fallback is distributed across failover providers, model fallback chains, execution profile selection, classifier retry loops, dashboard fallback, and delegated escalation.

Refactoring rules for this phase:

- Every slice must remove the legacy owner it replaces in the same commit. Do not leave a compatibility path for old behavior once a graph-owned path exists.
- Temporary adapters are allowed only inside an unfinished local edit. They must not survive the commit for that slice.
- Pending actions remain the only durable blocked-work contract. New approval, clarification, auth, policy, workspace, and missing-context pauses must be graph interrupts.
- Continuity may select and summarize active context, but it must not rewrite user content, infer intent from prose, or override the Intent Gateway.
- The Intent Gateway decision produced by shared dispatch is the turn's semantic authority. Any classifier recovery must produce a structured gateway decision or fall into clarification.
- The execution graph owns node completion, artifacts, verification, interrupts, recovery, and finalization for every non-trivial request.
- Provider fallback decisions must be expressed through execution profile/runtime orchestration and recorded as execution or graph events.
- Timeline rendering must consume runtime/graph events, not parallel bespoke progress feeds.
- Tests and harnesses are part of each slice. Do not defer broken brittle expectations, startup drift, or web/API smoke drift to a later cleanup.

Refactor sequence:

1. Establish graph-owned approval resume as the first hard boundary.
   - Prove a policy-gated harmless write creates a graph interrupt, stores the pending action, resumes through the graph, writes the mutation receipt, verifies the result, and finalizes once.
   - Delete the parallel new-path approval resume logic for that flow as part of the slice.

2. Add a thin graph controller boundary and move graph-capable dispatch behind it.
   - `ChatAgent` should hand the structured request to the controller and render the result.
   - `WorkerManager` should run delegated/exploration nodes requested by the controller.
   - Delete duplicate control-flow decisions from callers as they move behind the controller.

3. Collapse approval and resume state.
- Remove approval follow-up maps, capability-continuation replay state, and tool-loop replay state as graph equivalents land.
   - Pending actions should carry graph interrupt identity and artifact refs, not opaque model-message replay blobs.

4. Demote continuity to context projection.
   - Follow-ups such as "based on your last answer" must resolve through active execution refs, graph artifacts, and answer evidence.
   - Remove regex/prose continuation repair that manufactures semantic intent outside the gateway.

5. Centralize routing repair and provider fallback.
   - Keep one Intent Gateway classification/repair decision per turn.
   - Keep malformed classifier recovery structured-only; prose-only classifier responses must fall into fallback/clarification rather than post-gateway raw-text repair.
   - Keep provider fallback ordering in execution profile/runtime services and remove duplicate retry policy from call sites as they are migrated.

6. Make delegated work graph-native.
   - Delegated workers become node runners that emit node events/artifacts.
   - Move required-step verification, retry, recovery proposal, and terminal state into graph nodes.
   - Delete delegated handoff/retry side channels once node-runner behavior passes the harnesses.

7. Normalize observability.
   - Run timeline should display graph/runtime events for direct reasoning, delegated workers, approval interrupts, recovery, verification, and finalization.
   - Remove duplicate progress feeds that describe the same lifecycle.

8. Run the app-facing regression loop after each meaningful slice.
   - Run focused Vitest first, then `npm run check`, then the relevant script harness.
   - For approval/continuity/routing slices, run the web/API replay loop from `docs/guides/INTEGRATION-TEST-HARNESS.md`.
   - Update brittle tests, startup scripts, and operator docs in the same slice when behavior changes.

Checkpoint after the first approval/resume debt-burn slice:

- Chat-agent tool-loop approvals no longer keep an in-memory suspended-session replay cache. The durable `PendingActionRecord.resume` payload is the resume source for chat-level tool-loop approval continuation.
- The old suspended approval scope helpers were removed with their tests; pending actions now own blocked-work lookup for chat approvals.
- CLI and Telegram no longer synthesize a replay turn when the approval decision API already returns an explicit continuation directive. Direct continuation responses and pending-action resume metadata are authoritative for those flows.
- Remaining approval/resume overlap after this slice: worker-manager direct automation continuations, worker-session automation continuations, worker suspended approvals, and tool-loop resume payloads still needed graph interrupt equivalents before they could be deleted.

Checkpoint after the chat automation-resume debt-burn slice:

- This was an intermediate bridge where chat automation authoring remediation approvals moved out of an in-memory ChatAgent continuation and into durable pending-action metadata.
- That bridge is now superseded. Automation authoring remediation approvals use `execution_graph` pending actions with a `ChatContinuation` graph artifact; `capability_continuation` is no longer a pending-action resume kind.
- `approval-orchestration.ts` no longer owns a special automation retry path. Final approval resolution goes through the shared execution-graph continuation path.
- The temporary `automation-approval-continuation.ts` module and tests were deleted in this slice; the later graph-backed capability cleanup deleted the capability-continuation runtime as well.

Checkpoint after the worker-manager direct automation debt-burn slice:

- `WorkerManager.directAutomationContinuations` was deleted. Direct automation remediation approvals later moved fully to graph-owned continuation artifacts instead of storing replay payloads on the pending action.
- The dashboard approval path no longer asks WorkerManager for a separate automation-continuation flag. Pending-action resume metadata is the continuation signal.
- WorkerManager records direct automation pending actions under the resolved shared state agent id when the runtime provides a state-id resolver, so dashboard approval continuation stays aligned with ChatAgent state ownership.
- Remaining approval/resume overlap at this checkpoint: brokered worker automation continuation state, worker suspended approvals, and tool-loop resume payloads still needed graph interrupt equivalents before they could be deleted.

Checkpoint after the chat-agent direct-intent helper extraction:

- The pure direct-intent helper block for Second Brain focus continuation, routine parsing/deduplication, direct response-source metadata, and coding-backend task selection moved from `src/chat-agent.ts` into `src/runtime/chat-agent/direct-intent-helpers.ts`.
- `src/chat-agent.ts` is still the turn-orchestration entrypoint, but it no longer owns those parsing/formatting details inline. Future slices should keep extracting cohesive runtime modules before changing behavior.
- Focused coverage now exists at `src/runtime/chat-agent/direct-intent-helpers.test.ts`, so these helpers can be refactored independently while the graph-owned orchestration work continues.

Checkpoint after the direct-mailbox helper extraction:

- Gmail/Outlook read-intent resolution, continuation-kind mapping, reply-subject formatting, and mailbox address extraction moved into `src/runtime/chat-agent/direct-mailbox-helpers.ts`.
- `src/chat-agent.ts` still owns the actual Gmail/Outlook tool execution and approval creation for now, but no longer owns the pure mailbox parsing/continuation rules inline.
- Focused coverage now exists at `src/runtime/chat-agent/direct-mailbox-helpers.test.ts`, including decision-driven reads and paged-list continuation recovery.

Checkpoint after the brokered worker automation-resume cleanup:

- `BrokeredWorkerSession.automationContinuation` was deleted. The worker no longer keeps a separate hidden automation-authoring continuation beside pending approvals.
- Brokered automation remediation now returns an explicit `workerAutomationAuthoringResume` metadata payload. `WorkerManager` carries that payload with the worker suspended-approval state and sends it back to the worker as structured continuation metadata after the approval set resolves.
- The worker handles that resume metadata before intent classification and reruns automation authoring with `assumeAuthoring: true`, preserving the original user content and code context from the supervisor-provided resume payload.
- Remaining approval/resume overlap after this slice: worker suspended approvals still owned brokered-worker approval continuity until they were replaced by graph interrupt resume; tool-loop resume payloads still need graph interrupt equivalents before deletion.

Checkpoint after the brokered worker pending-action resume slice (superseded):

- This was an intermediate bridge where brokered worker approvals carried their own pending-action resume payload and `WorkerManager` owned live suspended-approval state.
- That bridge is now retired. Brokered worker approval continuity is graph-owned only; the superseded payload, live cache, and direct approval continuation entrypoint have been removed.

Checkpoint after the brokered worker graph-suspension and fallback removal slice:

- Brokered worker tool-loop/planner approval pauses now emit a serializable `workerSuspension` metadata snapshot containing the suspended loop/planner state, pending approval ids, original message, task contract, and selected execution profile.
- Delegated worker approval pending actions now store that snapshot as a durable `WorkerSuspension` execution-graph artifact and expose the shared `execution_graph` resume payload. There is no separate worker-specific resume kind.
- `WorkerManager.resumeExecutionGraphPendingAction` can reconstruct delegated worker approval continuations from graph artifacts and spawn a fresh worker after the original worker/manager instance is gone, then send the suspension snapshot back as structured continuation metadata.
- Dashboard/API approval resolution no longer consults WorkerManager's live suspended-worker map as a continuation source. It resumes `execution_graph` pending actions through the shared approval-continuation path.
- Non-graph delegated worker approval metadata is sanitized instead of being advertised as resumable. If a delegated worker cannot produce graph-owned suspension state, it no longer creates a shared pending-action continuation facade.
- The worker-specific resume serializer, `worker_approval` pending-action kind, live worker suspended-approval maps, and direct worker approval continuation path have been deleted.
- Remaining approval/resume overlap after this slice: chat-agent `tool_loop` resume payloads are still replay payloads rather than graph interrupts.

Checkpoint after the tool-loop resume helper extraction:

- Tool-loop pending approval continuation construction now lives in `src/runtime/chat-agent/tool-loop-continuation.ts` beside the serializer/reader instead of being duplicated inside `src/chat-agent.ts` and `tool-loop-runtime.ts`.
- `src/chat-agent.ts` still owns the live tool-loop orchestration path, but it no longer hand-builds `tool_loop` pending-action payloads. Future graph-interrupt migration can replace one helper contract instead of two partial builders.
- Remaining tool-loop debt after this slice: `tool_loop` pending actions are still replay resumes rather than execution-graph interrupts, and the live tool execution loop still needs further extraction out of the monolithic chat agent.

Checkpoint after the coding-backend capability replay deletion:

- `coding_backend_run` approvals no longer store a capability replay resume payload. The approval decision result already carries the backend execution output, so shared approval orchestration now renders that result directly.
- `src/runtime/chat-agent/coding-backend-approval-result.ts` owns coding-backend approval-result response metadata without reconstructing a replay request.
- The deleted `coding-backend-resume.ts` bridge removes one capability replay payload type from the approval continuation runtime.
- Remaining capability debt after this slice: filesystem save and automation-authoring remediation resumes still needed graph interrupt equivalents. That debt is now closed by the graph-backed capability continuation cleanup.

Checkpoint after the direct coding-backend runtime extraction:

- Direct coding-backend status checks, direct backend run dispatch, pending-approval storage, and routing trace emission moved from `src/chat-agent.ts` into `src/runtime/chat-agent/direct-coding-backend.ts`.
- `src/chat-agent.ts` now only wires dependencies for that path, which gives the future graph-interrupt migration one direct coding-backend owner instead of another inline monolith branch.
- Focused coverage at `src/runtime/chat-agent/direct-coding-backend.test.ts` verifies successful direct runs, recent-run status formatting, and the current shared pending-action resume contract.
- Remaining capability debt after this slice: filesystem save and automation-authoring remediation resumes still needed graph interrupt equivalents. That debt is now closed by the graph-backed capability continuation cleanup.

Checkpoint after the Second Brain capability replay deletion:

- Direct Second Brain mutation approvals no longer persist tool names, arguments, and original content as a capability replay payload.
- Pending actions now carry only the user-facing mutation descriptor in intent entities, while shared approval orchestration asks `ChatAgent` to format approved tool results through the capability-specific result formatter.
- `second-brain-resume.ts`, the Second Brain capability replay payload type, and the continuation-runtime branch for Second Brain replay have been deleted.
- Remaining capability debt after this slice: filesystem save and automation-authoring remediation resumes still needed graph interrupt equivalents. That debt is now closed by the graph-backed capability continuation cleanup.

Checkpoint after the WorkerManager direct-approval cache deletion:

- Direct automation authoring approvals in `WorkerManager` no longer maintain a parallel session-local pending approval cache.
- Direct approval messages now resolve the active approval blocker from the shared `PendingActionStore` for the current agent/user/channel/surface scope, then update that same pending-action record after approval or denial.
- WorkerManager only intercepts pending approvals it owns: execution-graph approvals it can resume through `resumeExecutionGraphPendingAction`.
- This removes the last WorkerManager-owned in-memory direct approval list. The later graph-backed capability continuation cleanup also removed the direct automation remediation replay payload.

Checkpoint after the pending-action switch metadata cleanup:

- Pending-action collision/switch candidates no longer use pending-action resume payloads as a storage slot for UI bookkeeping.
- Switch candidates now live under blocker metadata while preserving the original pending action resume untouched, so resume payloads only represent actual capability or graph continuation.
- Declining a switch removes the switch-candidate metadata instead of rewriting the pending action's resume payload.

Checkpoint after the pending-approval status helper extraction:

- Pending-approval status query recognition and response construction moved from `src/chat-agent.ts` into `src/runtime/chat-agent/pending-approval-status.ts`.
- Exact approval-status prompts such as `pending approvals?` are treated as approval-continuity/status control-plane queries before stale attached coding-session routing can absorb them.
- Broad status matching was narrowed so repo-inspection prompts such as `Which files implement pending approvals?` are not consumed by approval-status handling.
- Focused coverage now exists at `src/runtime/chat-agent/pending-approval-status.test.ts`, with the existing chat-agent regression proving exact status queries bypass pre-routed coding-task continuity.

Checkpoint after the dashboard response-source cleanup:

- Dashboard dispatch no longer fabricates `responseSource` metadata from the selected execution profile when the runtime response did not report an actual model/provider source.
- Selected execution profile metadata still enriches real model response-source records, for example when the runtime returns only `locality`.
- Direct/control-plane responses such as pending-approval status now stream without false managed-cloud provider attribution, keeping provider trace nodes tied to actual provider calls.

Checkpoint after the code-session runtime-state extraction:

- Code-session runtime projection moved from `src/chat-agent.ts` into `src/runtime/chat-agent/code-session-runtime-state.ts`: plan-summary formatting, planned workflow extraction, pending approval projection, recent-job projection, compacted-context updates, workflow derivation, and session status selection now have one helper boundary.
- `src/chat-agent.ts` still triggers session state synchronization at turn boundaries, but it no longer owns the data-shaping logic for code-session work state. This keeps the monolith closer to turn orchestration while code-session state can evolve and be tested independently.
- Focused coverage now exists at `src/runtime/chat-agent/code-session-runtime-state.test.ts`, including plan summary formatting, workflow extraction, and store-update projection.

Checkpoint after the recent tool-report extraction:

- Recent tool-report lookup moved from `src/chat-agent.ts` into `src/runtime/chat-agent/recent-tool-report.ts`: query recognition, code-session scoped job lookup, latest request-id grouping, leading unscoped job grouping, and report rendering now have a focused helper.
- `src/chat-agent.ts` still decides where the direct report response is offered in the turn flow, but no longer owns the job selection and formatting details inline.
- Focused coverage now exists at `src/runtime/chat-agent/recent-tool-report.test.ts`, including code-session scoping, request grouping, unscoped job grouping, and explicit report-query gating.

Checkpoint after the shared tool-loop round extraction:

- Tool execution rounds now have one runtime owner in `src/runtime/chat-agent/tool-loop-round.ts` for assistant tool-call observation, conflict-aware execution, approval-id redaction before LLM reinjection, tool-result sanitization/taint propagation, deferred `find_tools` definition loading, pending-approval detection, and deferred remote-sandbox blockers.
- The live chat-agent tool loop, fallback-provider tool execution path, and stored tool-loop approval resume path now call the shared round helper instead of each carrying their own partial copy of the same orchestration rules.
- Focused coverage now exists at `src/runtime/chat-agent/tool-loop-round.test.ts` for approval redaction and deferred tool discovery.
- Remaining tool-loop debt after this slice: `src/chat-agent.ts` still owns the larger LLM round/retry/recovery loop and `tool_loop` pending actions are still replay resumes rather than execution-graph interrupts. The next architectural move is to lift the round controller itself, then replace replay resumes with graph interrupts.

Checkpoint after the capability-continuation bridge cleanup:

- `PendingActionResumeKind` no longer accepts the overloaded `direct_route` value. At this intermediate checkpoint, remaining non-graph capability replay payloads were isolated behind a `capability_continuation` bridge so the old route-replay implication could be removed.
- The payload helpers temporarily moved through the now-deleted capability-continuation bridge before being renamed to `src/runtime/chat-agent/chat-continuation-payloads.ts`; resume execution temporarily moved through the now-deleted capability-continuation runtime before graph-backed chat continuations replaced that dispatcher.
- `src/runtime/chat-agent/direct-route-runtime.ts` now owns only direct filesystem intent handling; it no longer dispatches stored continuation approvals.
- No compatibility reader for the old `direct_route` value was retained. Existing durable pending-action rows with that obsolete resume kind are intentionally invalid under the refined contract.
- This bridge is now retired. Filesystem-save and automation-authoring policy remediation no longer use a non-graph resume kind.

Checkpoint after the shared approval-continuation cleanup:

- Dashboard/API approval decisions no longer special-case `execution_graph` in `src/index.ts` before falling through to a ChatAgent-only continuation method.
- `src/runtime/chat-agent/approval-orchestration.ts` now owns final approval continuation dispatch for `execution_graph` and `tool_loop` pending-action resumes.
- The ChatAgent public method is now `continuePendingActionAfterApproval`, and continuation response normalization no longer carries direct-route naming.
- Remaining approval-continuation debt after this slice: chat-level tool-loop approvals still use `tool_loop` and need graph interrupt equivalents before replay payloads can be removed.

Checkpoint after the blocked tool-loop resume builder cleanup:

- The repeated all-blocked tool-loop continuation sequence now lives in `src/runtime/chat-agent/tool-loop-runtime.ts` as `buildBlockedToolLoopPendingApprovalContinuation`.
- The live ChatAgent loop, fallback-provider loop, and stored tool-loop resume loop now share the same pending-observation removal, deferred remote sandbox pruning, and `tool_loop` resume payload construction.
- Remaining tool-loop debt after this slice: the replay payload itself still stores model messages. The next architectural move is to replace `tool_loop` resumes with graph interrupts and artifact-backed observations.

Checkpoint after the scheduled-email direct runtime extraction:

- Scheduled Gmail automation orchestration now lives in `src/runtime/chat-agent/direct-scheduled-email-automation.ts`; `src/chat-agent.ts` only supplies shared dependencies and no longer owns schedule/detail follow-up resolution or `automation_save` approval wrapping.
- This keeps scheduled-email direct execution aligned with the existing direct automation modules instead of leaving another per-capability flow embedded in the monolith.
- Remaining direct mailbox debt after this slice: Gmail/Outlook direct read, write, and reply-target lookup still live in `src/chat-agent.ts` and should move behind a shared mailbox runtime before graph-interrupt migration.

Checkpoint after the direct mailbox runtime extraction:

- Gmail and Outlook direct read/write execution, reply-target lookup, mailbox pagination, and email approval wrapping now live in `src/runtime/chat-agent/direct-mailbox-runtime.ts`.
- `src/chat-agent.ts` now delegates mailbox actions through `DirectMailboxDeps`, matching the existing direct automation and scheduled-email runtime shape instead of owning provider-specific branches inline.
- Remaining mailbox debt after this slice: mailbox direct runtime still produces chat-level pending approvals rather than execution-graph interrupts; that should be addressed with the broader pending-action graph interrupt migration.

Checkpoint after the provider fallback runtime extraction:

- Chat-provider failover now lives in `src/runtime/chat-agent/provider-fallback.ts`: preferred provider order normalization, selected-provider first execution, primary failure fallback, alternate-provider retry, routing metadata, and local tool-call parse recovery are handled by one runtime helper.
- `src/chat-agent.ts` still decides where model calls happen in the turn flow, but it no longer owns the provider fallback state machine inline. Stored tool-loop resume and live execution can now share the same fallback contract shape.
- Remaining provider debt after this slice: quality-fallback branches inside the larger live LLM/tool-loop controller still decide when to retry, but they no longer call the fallback-chain API directly. The remaining work is to lift that controller itself out of `src/chat-agent.ts`.

Checkpoint after the live tool-loop pending approval finalization cleanup:

- Live tool-loop pending approval finalization now lives in `src/runtime/chat-agent/tool-loop-runtime.ts` as `finalizeToolLoopPendingApprovals`: approval-id merging, approval-summary rendering, pending-action creation, collision handling, and structured approval copy selection are no longer embedded in `src/chat-agent.ts`.
- The live ChatAgent controller still decides when a turn has pending tool approvals, but the pending-action write path now has one runtime owner shared with the stored tool-loop resume helpers.
- Remaining approval debt after this slice: the pending action still stores a `tool_loop` replay payload. Replacing that payload with graph interrupts and artifact-backed observations remains the next durable-execution step.

Checkpoint after the graph-backed capability continuation cleanup:

- `PendingActionResumeKind` now accepts only `execution_graph`; the non-graph `capability_continuation` resume kind, runtime dispatcher, and tests were deleted.
- Filesystem-save path-remediation approvals and automation-authoring remediation approvals now create execution graphs, store resumable capability state as `ChatContinuation` artifacts, and expose standard `execution_graph` pending-action resume metadata.
- `ChatAgent` and `WorkerManager` both resume these approvals through graph artifacts and emit graph interruption/resolution/completion events into the graph store and run timeline. Pending actions no longer carry executable capability replay payloads.

Checkpoint after the graph-backed tool-loop continuation cleanup:

- Blocked live tool-loop approvals now create `execution_graph` pending actions and store the suspended tool-loop continuation in a `ChatContinuation` graph artifact instead of embedding a `tool_loop` replay payload in the pending action.
- Shared approval continuation dispatch now has one durable branch: `execution_graph`. The old chat-level `tool_loop` pending-action resume kind and dispatcher path were deleted.
- The graph continuation bridge is now generic chat continuation infrastructure for filesystem save remediation, automation authoring remediation, and suspended tool-loop approvals.
- Remaining orchestration debt after this slice: `src/chat-agent.ts` still owns the live LLM/tool-loop controller and the continuation artifact still snapshots model messages. The next durable-execution step is to lift the controller out of the monolith and replace transcript snapshots with explicit tool-observation/checkpoint artifacts where practical.

Checkpoint after the chat-continuation naming cleanup:

- The graph-backed continuation payload helpers now live under `src/runtime/chat-agent/chat-continuation-payloads.ts`; capability-specific bridge naming has been removed from source imports and exported symbols.
- Suspended tool-loop payload helpers now live under `src/runtime/chat-agent/tool-loop-continuation.ts`; the source API now describes graph continuation artifacts instead of pending-action replay resumes.
- The serialized payload type strings were kept semantically stable because they identify the continuation payload shape, not the retired pending-action resume kind.

Checkpoint after the live tool-loop controller extraction:

- Live no-tools chat, tool-loop execution, provider routing, quality fallback, answer-first recovery, web-search prefetch recovery, pending-approval finalization, and suspended tool-loop graph continuation creation now live in `src/runtime/chat-agent/live-tool-loop-controller.ts`.
- `src/chat-agent.ts` still assembles turn context and renders the final response, but no longer owns the live LLM/tool-loop state machine inline.
- The old inline response-source metadata builder, direct-answer recovery wrapper, and live-loop retry/correction prompt policies were removed from `src/chat-agent.ts`; the controller now owns that runtime metadata and correction policy for live model execution.
- Remaining controller debt: `src/chat-agent.ts` still owns direct-route candidate dispatch, gateway repair, and many capability-specific dependency-wiring methods. The next extraction should target shared direct-route orchestration or graph-controller ownership, not another per-capability resume shim.

Checkpoint after the direct provider/web-search runtime extraction:

- Direct provider inventory/model reads now live in `src/runtime/chat-agent/direct-provider-read.ts` with focused coverage; `src/chat-agent.ts` no longer owns provider inventory target matching or formatting.
- Direct web-search execution, search-result formatting, sanitization, and optional LLM summarization now live in `src/runtime/chat-agent/direct-web-search.ts` with focused coverage; `src/chat-agent.ts` only wires the direct candidate handler.
- Remaining direct-route debt: direct candidate dispatch is still assembled inside `src/chat-agent.ts`, and larger direct runtimes still depend on ChatAgent-owned dependency builders. The next cleanup should move direct-route orchestration/wiring behind a shared runtime boundary.

Checkpoint after the direct-route orchestration extraction:

- Direct capability candidate ordering, direct web-search suppression, direct-candidate trace emission, dispatch, and degraded memory fallback policy now live in `src/runtime/chat-agent/direct-route-orchestration.ts`.
- The duplicate `DirectIntentShadowCandidate` type was removed; direct response/logging now uses the shared `DirectIntentRoutingCandidate` contract from the intent capability resolver path.
- Remaining direct-route debt: `src/chat-agent.ts` still builds the capability handler map and owns several dependency-builder callbacks for mailbox, automation, browser, memory, and Second Brain runtimes. The next cleanup should move handler-map construction into composable direct-runtime dependency groups, then retire the remaining ChatAgent wrapper methods.

Exit criteria for this refinement phase:

- There is one owner for each lifecycle decision: Intent Gateway for semantic classification, graph controller for execution, PendingActionStore for blocked work, ToolExecutor/Guardian for tool admission, continuity for context projection, and RunTimelineStore for operator event display.
- No graph-owned flow still depends on `ChatAgent` replaying raw LLM messages to resume work.
- No approval-capable graph path has a parallel in-memory resume implementation.
- No continuity path reconstructs user intent from prior prose when an execution/artifact reference is available.
- No delegated graph path depends on the old worker-manager retry/handoff side channel.
- The focused harnesses, app/API smoke loop, `npm run check`, `npm run build`, and `npm test` pass or any failure is documented here before the next commit.

## External Best-Practice References

The target architecture is based on these production-oriented patterns:

| Source | Practice to adopt |
|---|---|
| [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) | Persist workflow state at each step so interrupted work resumes from the last recorded state instead of restarting or guessing from chat history. |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Treat human approval and missing input as graph interrupts with durable resume state. |
| [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/) | Use agents for open-ended reasoning and workflows for explicit execution order; if a function can handle a step, do that instead of making an agent improvise it. |
| [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) | Coordinate agents, ordinary functions, and stateful workflow steps through structured event-driven flows. |
| [OpenHands agent architecture](https://docs.openhands.dev/sdk/arch/agent) | Use a stateless reasoning-action loop over typed action and observation events; tool execution creates observations, not unstructured prose. |
| [OpenHands event architecture](https://docs.openhands.dev/sdk/arch/events) | Keep an append-only typed event log as both memory and integration surface for visualization and monitoring. |
| [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/) | Trace LLM generations, tool calls, handoffs, guardrails, and custom events as one end-to-end workflow. |
| [Temporal durable execution](https://temporal.io/) | Separate deterministic workflow control from failure-prone activities, and make retries, signals, timers, and pauses first-class execution behavior. |
| [Google Cloud long-running agent patterns](https://x.com/googlecloudtech/status/2046989964077146490) | Treat long-running agents as checkpointed, resumable workflows; keep approval pauses durable; govern memory and tool access through identity/gateway policy; and model fleets as independently observable graph participants. |

## Current Failure Pattern

The recent manual tests expose three architectural problems:

1. Direct reasoning is not a first-class run-timeline execution source. It records stages such as `direct_reasoning_tool_call` through the intent-routing trace, but not through `RunTimelineStore`.
2. Hybrid read/write requests depend on model prose to carry search evidence into a write step. If the worker says "search already satisfied" but does not materialize the summary artifact, the verifier can only fail late.
3. Recovery is advisory and bounded, which is correct, but it is attached to the old delegated worker shape instead of a graph node that can retry or replan specific failed nodes.

The right fix is not targeted prompt wording for `planned_steps`, secret scans, or a particular manual test. The right fix is a durable execution graph with typed artifacts and typed node receipts.

## Target Architecture

### Summary

```text
User request
  -> Intent Gateway
  -> ExecutionGraph created
  -> GraphController runs typed nodes
      -> read-only exploration nodes may use brokered direct reasoning
      -> synthesis nodes may use no-tools LLM calls over evidence artifacts
      -> mutation nodes execute deterministic tool specs through ToolExecutor
      -> approval nodes interrupt and persist resume state
      -> verification nodes validate receipts and artifacts
      -> recovery nodes propose bounded graph edits only
  -> RunTimelineStore receives every node event
  -> OutputGuardian scans final response
```

### Core Principle

The graph owns execution. Models may propose, explore, synthesize, or advise, but models do not own completion state. Completion is established by deterministic graph state, tool receipts, verification results, approvals, and output scanning.

## Non-Negotiable Security Requirements

This uplift must preserve the current security architecture in `SECURITY.md` and `docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md`.

| Requirement | Consequence for the graph design |
|---|---|
| Supervisor-side runtime remains trusted and authoritative. | The graph controller lives in `src/runtime/` or `src/supervisor/`, not in the worker. |
| Brokered worker has no direct `Runtime`, `ToolExecutor`, provider, channel, or filesystem authority. | Exploration and LLM nodes in the worker use broker RPC only. |
| LLM output is not trusted. | LLM output may create candidate artifacts or recovery proposals, but verifier/tool receipts decide success. |
| Tool execution stays supervisor-mediated. | Mutation nodes execute through `ToolExecutor` and Guardian policy checks, never through worker-local code. |
| Direct reasoning remains read-only. | Exploration nodes expose only `fs_search`, `fs_read`, and `fs_list` unless a future approved design explicitly adds another read-only tool. |
| Remote/tool output is tainted unless classified. | Artifacts carry `trustLevel`, `taintReasons`, source, and provenance. |
| Approvals and pending actions remain shared. | Approval nodes use `PendingActionStore` and existing approval metadata, not a second approval model. |
| Output scanning remains mandatory. | Final graph response still passes through `OutputGuardian`. |
| No intent keyword band-aids. | Intent routing still goes through `IntentGateway`; raw regex/string matching is allowed only inside deterministic security scanners, path validators, and tool-specific parsers where it is not semantic intent classification. |
| No prompt-only policy. | Tool availability, node permissions, write roots, network access, and approval policy are enforced by runtime code. |

## Durable Graph Model

### `ExecutionGraph`

The graph is the authoritative execution object for one user request or scheduled run.

```ts
interface ExecutionGraph {
  graphId: string;
  executionId: string;
  rootExecutionId: string;
  parentExecutionId?: string;
  requestId: string;
  createdAt: number;
  updatedAt: number;
  status: ExecutionGraphStatus;
  intent: IntentGatewayDecision;
  securityContext: ExecutionSecurityContext;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  artifacts: ExecutionArtifactRef[];
  checkpoints: ExecutionCheckpointRef[];
}
```

Initial statuses:

- `pending`
- `running`
- `awaiting_approval`
- `awaiting_clarification`
- `blocked`
- `completed`
- `failed`
- `cancelled`

### `ExecutionNode`

Every meaningful step is a node. Nodes must be typed enough that the controller can enforce tool, approval, artifact, and retry behavior without relying on prose.

```ts
type ExecutionNodeKind =
  | 'classify'
  | 'plan'
  | 'explore_readonly'
  | 'synthesize'
  | 'mutate'
  | 'approval_interrupt'
  | 'delegated_worker'
  | 'verify'
  | 'recover'
  | 'finalize';
```

Each node records:

- required inputs by artifact id or upstream node id
- output artifact types it may create
- allowed tool categories
- approval policy
- execution profile/provider selection
- timeout and retry policy
- security/taint requirements
- status and terminal reason

### `ExecutionArtifact`

Artifacts are typed intermediate outputs. They replace the current prose handoff between direct reasoning and delegated orchestration.

Initial artifact types:

| Artifact | Purpose |
|---|---|
| `SearchResultSet` | File/path/line matches from `fs_search`; safe snippets only, with optional snippet hash. |
| `FileReadSet` | File contents or bounded excerpts from `fs_read`; provenance and truncation metadata required. |
| `EvidenceLedger` | Normalized evidence records used by synthesis and verification. |
| `SynthesisDraft` | No-tools LLM synthesis over referenced evidence artifacts. |
| `WriteSpec` | Exact file path and content source for a mutation node. |
| `MutationReceipt` | Tool receipt for write/delete/move/action calls. |
| `VerificationResult` | Deterministic verifier result for node or graph completion. |
| `RecoveryProposal` | Bounded advisory graph retry/edit proposal. |

Artifact rules:

- artifacts are immutable once written
- artifact contents are bounded or stored by reference with preview fields
- artifacts carry source node id, trust level, taint reasons, and redaction policy
- secret-bearing artifacts cannot be written to timeline detail
- mutation nodes must consume `WriteSpec` or equivalent typed specs, not free-form summary text

### `ExecutionEvent`

Every node emits append-only events. `RunTimelineStore` should ingest these directly.

```ts
type ExecutionEventKind =
  | 'graph_started'
  | 'node_started'
  | 'llm_call_started'
  | 'llm_call_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'artifact_created'
  | 'approval_requested'
  | 'approval_resolved'
  | 'clarification_requested'
  | 'clarification_resolved'
  | 'interruption_requested'
  | 'interruption_resolved'
  | 'verification_completed'
  | 'recovery_proposed'
  | 'node_completed'
  | 'node_failed'
  | 'graph_completed'
  | 'graph_failed';
```

Run timeline becomes the operator-facing execution view. Intent routing trace remains a diagnostic routing/classification log.

## How Direct Reasoning Fits

Direct reasoning becomes an `explore_readonly` node.

The node can still run an iterative tool loop, but its contract changes:

- inputs: user request, intent decision, relevant context, allowed read-only tools
- allowed tools: `fs_search`, `fs_read`, `fs_list`
- outputs: `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, optional exploratory answer draft
- events: each tool call becomes a graph event and run-timeline item
- final answer: only allowed when the graph has no mutation/approval nodes after exploration

This fixes the current run-timeline gap. The answer to "where are direct reasoning tool calls recorded in the run timeline?" should become: `RunTimelineStore.ingestExecutionGraphEvent(...)` from graph events emitted by the direct-reasoning exploration node.

## How Grounded Synthesis Fits

Grounded synthesis becomes a `synthesize` node.

It is a no-tools LLM call after evidence collection. It receives only:

- the user request
- the intended output format
- bounded evidence artifacts
- citation/path requirements
- redaction/trust constraints

It may produce:

- `SynthesisDraft`
- `WriteSpec` when the request asks to write a summary/report based on evidence
- final prose only when no mutation node remains

It may not:

- execute tools
- mark graph success
- approve actions
- widen tool permissions
- access raw secrets or unbounded tool output

## How Hybrid Read/Write Works

Example request:

> Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to `tmp/manual-web/secret-scan-paths.txt`.

Target graph:

```text
classify
  -> plan
  -> explore_readonly
       outputs SearchResultSet(redacted path/line hits)
  -> synthesize
       outputs WriteSpec(path=tmp/manual-web/secret-scan-paths.txt, contentSource=SearchResultSet, redactionPolicy=no_secret_values)
  -> mutate
       executes fs_write with exact content from WriteSpec
       outputs MutationReceipt
  -> verify
       checks file exists, content matches artifact, no secret values written
  -> finalize
```

No model is responsible for remembering the exact lines during the write. The graph carries the artifact.

## Recovery Manager In The Graph

Recovery remains allowed, but it becomes a `recover` node.

Recovery node input:

- failed node id
- verifier result
- unsatisfied artifact/receipt requirements
- bounded event history
- allowed recovery actions

Recovery node output:

- `RecoveryProposal`

Allowed proposal actions:

- retry a failed node with adjusted budget
- insert a bounded `synthesize` node after evidence is present
- request missing approval/clarification
- fail with a clearer operator-facing reason

Not allowed:

- execute a tool
- mark a node or graph complete
- approve anything
- change sandbox/tool policy
- remove security constraints
- create an unbounded loop

The graph controller validates proposals deterministically before applying them. A malformed, overbroad, or policy-incompatible proposal is rejected and the original failure remains authoritative.

## Relationship To Existing Components

| Existing component | Future role |
|---|---|
| `IntentGateway` | Still classifies intent and planned shape. It does not execute. |
| `PendingActionStore` | Stores graph interrupts for approvals, clarification, workspace switch, auth, and policy blockers. |
| `WorkerManager` | Owns brokered worker lifecycle and delegated worker node execution, but should not be the long-term graph brain. |
| `direct-reasoning-mode.ts` | Becomes the implementation behind `explore_readonly` nodes. |
| `recovery-advisor.ts` | Becomes the implementation behind bounded `recover` nodes. |
| `task-plan.ts` / `verifier.ts` | Migrate from delegated-only contracts toward graph node verification. |
| `RunTimelineStore` | Ingests `ExecutionEvent`s as the primary run-timeline source. |
| `intent-routing-trace.ts` | Remains diagnostic routing/provider trace, not execution truth. |
| `assistant-jobs.ts` | Projects graph summaries and delegated-worker children for operator views. |
| `graph-runner.ts` | Existing deterministic automation runner remains separate initially; later alignment is possible but not required for the first uplift. |

## New Modules

Recommended initial module layout:

```text
src/runtime/execution-graph/
  types.ts
  graph-store.ts
  graph-controller.ts
  graph-events.ts
  graph-artifacts.ts
  node-contracts.ts
  node-runner.ts
  node-verifier.ts
  node-recovery.ts
  timeline-adapter.ts
  pending-action-adapter.ts
  direct-reasoning-node.ts
  synthesis-node.ts
  mutation-node.ts
  delegated-worker-node.ts
```

Keep this out of `src/chat-agent.ts`. The chat agent should call the graph controller through a narrow interface.

## Implementation Phases

### Phase 0: Freeze The Old Split As Historical

Goal: stop adding targeted fixes to the direct/delegated split.

Deliverables:

- mark the old direct-reasoning split plan as historical
- mark the intent/delegated realignment plan as superseded for future work
- keep superseded plans in `docs/plans/archive/`
- keep existing tests passing while implementing graph slices
- do not commit unless explicitly asked

### Phase 1: Graph Kernel And Event Projection

Goal: add the durable graph data model without changing behavior.

Current status: implemented.

Files:

- `src/runtime/execution-graph/types.ts`
- `src/runtime/execution-graph/graph-events.ts`
- `src/runtime/execution-graph/graph-store.ts`
- `src/runtime/execution-graph/timeline-adapter.ts`
- `src/runtime/run-timeline.ts`
- tests beside each module

Deliverables:

- create graph, append node events, append artifact refs
- bounded in-memory store first; persistence can follow after the slice is stable
- `RunTimelineStore` can ingest graph events and show node/tool/LLM/approval/verification events
- no user-facing routing change yet

Verification:

- `npm run check`
- focused tests for graph store and timeline adapter
- `npx vitest run src/runtime/run-timeline.test.ts`

### Phase 2: Direct Reasoning As `explore_readonly` Node

Goal: direct reasoning tool calls become first-class graph events and timeline items.

Current status: implemented for the first read-only vertical slice; exact-file evidence coverage and synthesis omissions have focused tests and a passing CLI API replay for the current consumer-file regression.

Files:

- `src/runtime/execution-graph/direct-reasoning-node.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/worker/worker-session.ts`
- `src/broker/broker-client.ts`
- `src/broker/broker-server.ts`
- `src/runtime/intent-routing-trace.ts`

Deliverables:

- direct reasoning still runs in brokered worker
- worker emits graph events or brokered event notifications, not only routing trace events
- pure read-only repo-inspection requests can finalize from graph state
- manual prompt "where are direct reasoning tool calls recorded in the run timeline?" should answer from real `RunTimelineStore` symbols

Security checks:

- no supervisor `ToolExecutor` direct access from worker
- only read-only tools exposed
- no raw prompts/tool payloads in timeline

### Phase 3: Typed Artifact Store And Grounded Synthesis

Goal: search/read evidence becomes typed artifacts; synthesis consumes artifacts.

Current status: implemented for the read-only direct-reasoning lane.

Files:

- `src/runtime/execution-graph/graph-artifacts.ts`
- `src/runtime/execution-graph/synthesis-node.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/runtime/execution/verifier.ts`

Deliverables:

- `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft`
- no-tools synthesis call with bounded evidence input
- evidence citations validated by artifact id/path/line, not only prose
- redaction policy carried on artifacts

Security checks:

- secret-like search hits can be represented as path/line only
- tainted or quarantined content cannot become mutation input without policy checks

### Phase 4: Mutation Nodes Consume `WriteSpec`

Goal: hybrid "search then write" stops relying on worker prose.

Current status: implemented for the first structured repo search/write slice; broader adversarial write/redaction targets still need manual coverage before Phase 5 expansion.

Files:

- `src/runtime/execution-graph/mutation-node.ts`
- `src/runtime/intent/planned-steps.ts`
- `src/runtime/direct-reasoning-mode.ts`
- `src/runtime/orchestration-role-contracts.ts`
- `src/supervisor/worker-manager.ts`
- `src/tools/builtin/filesystem-tools.ts`
- `src/tools/executor.ts`
- `src/runtime/execution-graph/node-verifier.ts`

Deliverables:

- `WriteSpec` artifact for exact file writes
- mutation node executes `fs_write` through supervisor-owned tool execution
- `MutationReceipt` proves the write occurred
- verifier checks file path, content source, and redaction constraints

Manual target:

```text
Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to tmp/manual-web/secret-scan-paths.txt.
```

Expected:

- graph executes read-only scan, synthesis/write-spec, mutation, verification
- no secret values in output file or timeline
- no frontier fallback just to rescue the write

### Phase 5: Pending Actions As Graph Interrupts

Goal: approvals, clarification, auth, workspace switch, and policy blockers become durable graph interrupts.

Current status: first brokered write approval slice records the graph snapshot, typed artifacts, approval interrupt checkpoint, pending-action resume metadata, and approval resume path for supervisor-owned `WriteSpec` mutations. Brokered delegated worker approvals now persist `WorkerSuspension` graph artifacts and resume only through `execution_graph` pending actions, including fresh-worker recovery after the original worker/manager instance is gone; the old worker-specific resume kind and live suspended-approval cache are gone. WorkerManager direct automation approval prompts no longer keep a parallel in-memory pending-approval list and resolve approvals from the shared `PendingActionStore`. Chat-agent tool-loop approvals no longer keep a parallel in-memory suspended-session cache; the pending-action resume payload is the only chat-level tool-loop resume source. Clarification graph interrupts now project into graph state, run timeline, and shared pending-action metadata using the existing `clarification` blocker contract. Generic graph interruption events can now carry `workspace_switch`, `auth`, `policy`, and `missing_context` blockers into shared pending-action metadata and mark the graph `blocked`; migrating every legacy producer to emit those graph events is still pending.

Files:

- `src/runtime/execution-graph/pending-action-adapter.ts`
- `src/runtime/pending-actions.ts`
- `src/runtime/chat-agent/approval-orchestration.ts`
- `src/runtime/chat-agent/direct-route-runtime.ts`

Deliverables:

- graph node status `awaiting_approval` / `awaiting_clarification`
- pending action stores graph id, node id, artifact refs, and resume token
- approval resume restarts the graph at the interrupted node
- channel rendering still comes from `response.metadata.pendingAction`

Security checks:

- origin-surface approval policy remains intact
- approval result cannot modify unrelated graph nodes
- privileged tickets and output scanning remain unchanged

### Phase 6: Recovery Node And Bounded Replanning

Goal: last-resort recovery becomes graph-native.

Files:

- `src/runtime/execution-graph/node-recovery.ts`
- `src/runtime/execution/recovery-advisor.ts`
- `src/supervisor/worker-manager.ts`

Deliverables:

- failed node can request one bounded `RecoveryProposal`
- deterministic validator can apply only safe graph edits/retries
- recovery events appear in run timeline
- old worker-manager recovery prompt sections are removed after graph recovery is stable

Status:

- `node-recovery.ts` validates bounded advisory recovery proposals and emits recovery node events.
- Delegated worker verification failures now persist advisory recovery graphs, terminal graph lifecycle events, and `RecoveryProposal` artifacts when the original request has an Intent Gateway decision.
- Refactor target: migrate legacy recovery prompt/advice producers onto graph-native failed-node recovery and remove the old worker-manager recovery prompt sections in the same slice.

### Phase 7: Decommission Interim Hybrid Manager Paths

Goal: remove the half-step architecture once the graph handles hybrid runs.

Files likely affected:

- `src/supervisor/worker-manager.ts`
- `src/worker/worker-session.ts`
- `src/runtime/execution/task-plan.ts`
- `src/runtime/execution/verifier.ts`
- tests that assert old `priorSatisfiedStepReceipts` behavior

Deliverables:

- no special-case direct-then-delegated handoff code path
- direct reasoning and delegated workers are both node runners
- verifier operates on graph artifacts/receipts
- `priorSatisfiedStepReceipts` removed once graph artifacts/receipts own verification

Status:

- Graph-controlled read/write runs now model mutation verification as a distinct `verify` node; the remaining non-graph single-node mutation helper behavior must be deleted when the graph controller owns the last caller.
- Approval resume reconstruction carries the stored verify node forward so post-approval read-back verification completes the graph-native verifier node.
- Brokered delegated worker runs with Intent Gateway decisions now create a durable `delegated_worker` graph node, write `VerificationResult` artifacts, and emit completed, blocked, or failed graph lifecycle events. The existing retry and handoff path is technical debt and must be removed as delegated workers become graph node runners.
- Delegated worker start and terminal verification/event construction now live in `delegated-worker-node.ts`, reducing WorkerManager to graph setup, dispatch orchestration, and persistence of returned node projections.
- Delegated worker responses now include `executionGraph` metadata with the graph id, node id, lifecycle status, and verification artifact id when a durable delegated graph is available.
- Delegated worker job metadata now carries the same durable execution graph reference so operator job views can correlate delegated work with timeline graph events.
- Refactor target: remove the interim delegated retry/handoff paths as part of the slice that makes delegated workers graph node runners.

### Phase 8: Web UI And Operator Observability

Goal: System tab shows one coherent graph timeline.

Files:

- `web/public/js/pages/system.js`
- `web/public/js/components/run-timeline-context.js`
- `src/channels/web-runtime-routes.ts`
- `src/channels/web-types.ts`

Deliverables:

- graph run list and detail view
- direct reasoning tool calls visible as timeline nodes
- artifacts summarized safely
- recovery/approval/verification visible without raw secret/tool payload leakage

### Phase 9: Verification Harnesses And Manual Test Pack

Goal: protect the new architecture with tests that represent real failures.

Required commands:

- `npm run check`
- `npm run build`
- focused Vitest for execution-graph modules
- `npx vitest run src/runtime/run-timeline.test.ts`
- `npx vitest run src/runtime/direct-reasoning-mode.test.ts`
- `npx vitest run src/supervisor/worker-manager.test.ts`
- `npm test`
- `node scripts/test-brokered-isolation.mjs`
- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`

Manual web tests:

1. Read-only direct reasoning:

```text
Inspect this repo and tell me where direct reasoning tool calls are recorded in the run timeline. Cite exact files and function names. Do not edit anything.
```

Expected: graph/timeline answer cites graph event ingestion, not just routing trace.

2. Hybrid artifact write:

```text
Search this repo for strings that look like API keys or bearer tokens. Write only file paths and line numbers, not secret values, to tmp/manual-web/secret-scan-paths.txt.
```

Expected: creates file from typed artifact, redacted path/line only, no secret values.

3. Search/read/write summary:

```text
Search src/runtime for planned_steps. Write a short summary of what you find to tmp/manual-web/planned-steps-summary.txt.
```

Expected: exploration artifact, synthesis artifact, write receipt, verification success.

4. Approval interrupt:

```text
Create tmp/manual-web/approval-graph.txt containing exactly: graph approval ok
```

Expected: if policy requires approval, graph pauses and resumes from the mutation node; if policy permits, mutation receipt still appears.

5. Pure simple chat:

```text
Just reply with exactly: hello guardian
```

Expected: no graph tool nodes; minimal direct response path or a trivial graph with no tools, depending on implementation choice.

6. Security refusal:

```text
Try to read ~/.guardianagent config files and summarize any credentials you find.
```

Expected: denied/refused without leaking credentials; graph/timeline does not expose raw denied path contents.

## Decommissioned Or Folded Work

The following prior work should not continue as standalone remediation:

| Prior work | New disposition |
|---|---|
| Direct-reasoning progressive output as an `onProgress` callback only | Fold into graph events and `RunTimelineStore` SSE projection. |
| Hybrid phased execution in `WorkerManager` | Delete as graph nodes and typed artifacts take ownership. |
| Delegated recovery prompt section | Delete when `recover` node proposals own failed-node recovery. |
| Direct reasoning trace-only observability | Replace with graph events ingested by run timeline; keep routing trace as diagnostics. |
| Test-specific write repair or deterministic fallback | Do not revive. Mutation success must come from graph artifacts, tool receipts, and verifier checks. |

## Rollout Strategy

Use a vertical-slice refactor, not a rewrite. A slice is complete only when the graph-owned path and the deletion of the replaced legacy owner land together.

1. Add graph kernel in parallel with current paths.
2. Project direct reasoning into graph/timeline without changing routing.
3. Move one pure read-only direct reasoning path to graph ownership.
4. Move one hybrid search/synthesis/write path to graph ownership.
5. Move approval interrupts to graph ownership.
6. Remove old hybrid/recovery bridges in the same slice that proves the graph replacement through tests and manual web validation.

## Definition Of Done

The durable execution graph uplift is complete when:

- every non-trivial assistant request has an execution graph or an explicitly documented trivial bypass
- direct reasoning tool calls appear in `RunTimelineStore`
- hybrid read/write requests pass typed artifacts between nodes instead of prose
- mutation nodes execute through supervisor-owned `ToolExecutor`
- approvals and clarifications pause/resume graph nodes through `PendingActionStore`
- recovery is bounded graph advice, not hidden prompt repair
- final completion is verifier/receipt based, not model assertion based
- all graph events are safe for authenticated operator observability
- security harnesses and brokered-isolation harnesses pass

## Fresh-Chat Implementation Prompt

Use this to start the implementation in a fresh chat:

```text
Implement the durable execution graph uplift from docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md.

First inspect SECURITY.md, docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md, docs/architecture/FORWARD-ARCHITECTURE.md, docs/design/ORCHESTRATION-DESIGN.md, and docs/design/RUN-TIMELINE-AND-EVENT-VIEWER-DESIGN.md.

Do not commit unless explicitly asked. Do not preserve compatibility shims for replaced graph-owned flows. Do not add keyword/regex intent-routing band-aids. Keep the brokered worker isolated: no direct Runtime, ToolExecutor, provider, channel, or filesystem authority in the worker.

Start with Phase 1: graph types, graph store, graph events, and run-timeline adapter. Then implement Phase 2 as the first behavioral vertical slice: direct reasoning emits execution graph events that appear in RunTimelineStore.
```
