# Execution, Evidence, and Orchestration Re-Architecture Plan

## Summary
- Replace Guardian's current delegated-worker acceptance model with an execution-centric architecture: typed task contracts, typed evidence receipts, explicit verifier decisions, and one shared event stream projected into trace, timeline, approvals, and channel progress.
- Treat this as the new canonical plan. Supersede `docs/plans/INTENT-GATEWAY-EXECUTION-CONTINUATION-REMEDIATION-PLAN.md`, the unfinished delegated-handoff parts of `docs/design/EXECUTION-STATE-DESIGN.md`, and the delegated-progress portions of `docs/plans/WEB-CLI-LIVE-PROGRESS-IMPLEMENTATION-PLAN.md`.
- No backward compatibility. Use a flag-day internal cutover once the new stack is green under harnesses, then delete the old heuristic stack rather than dual-running it.
- **Update (April 2026):** Substantial progress has been made on the Verifier, Evidence Receipts, and Intent Gateway context recovery. See `docs/plans/REMEDIATION-INTENT-AND-VERIFIER.md` for a summary of exact-file-reference enforcement, mutation-evidence filtering, and history-context amnesia fixes that have been completed.

## Design Basis
- Adopt run-item and resumable-state patterns similar to OpenAI Agents `new_items`, `interruptions`, and `to_state()` from [Results](https://openai.github.io/openai-agents-python/results/) and trace/span observability from [Tracing](https://openai.github.io/openai-agents-python/tracing/).
- Adopt durable execution keyed by stable thread or execution IDs and resumable interrupts, similar to LangGraph [Durable Execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) and [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).
- Adopt explicit structured event logging similar to AutoGen's event and trace loggers from [Logging](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/logging.html).
- Keep worker isolation and supervisor-owned orchestration similar to Composio's [agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator): isolated work units, clear supervisor ownership, human escalation only when needed.
- Use local repo lessons from `S:\Development\open-agents`, `hermes-agent`, `SimpleAgents`, and `deepagents`: typed workflow events, resumable checkpoints, transparent tool-call/result streams, and no "node completed without output" ambiguity.

## Key Changes
### 1. Canonical execution model
- Replace the current request-level `ExecutionRecord` plus aggregate `workerExecution` metadata with an execution DAG under `src/runtime/execution/`.
- Introduce canonical types: `ExecutionRecordV2`, `ExecutionNode`, `ExecutionEvent`, `EvidenceReceipt`, `Claim`, `Interruption`, `VerificationDecision`, and `DelegatedResultEnvelope`.
- Every delegated child run must emit a structured result envelope containing `taskContract`, `finalUserAnswer`, `operatorSummary`, `claims`, `evidenceReceipts`, `interruptions`, `artifacts`, `verificationHints`, and `modelProvenance`.
- A request may complete with zero tool calls only when its task contract explicitly allows `answer_first`; this becomes a verifier rule, not a counter exception.

### 2. Verifier replaces heuristics
- Delete prose-based acceptance logic in `src/supervisor/worker-manager.ts`, including `INSUFFICIENT_RESULT_PATTERNS`, `contentSignalsInsufficientGroundedLookup(...)`, `contentHasConcreteFileReferences(...)`, `requestNeedsExactFileReferences(...)`, and `violatesDelegatedEvidenceContract(...)`.
- Replace them with verifier modules keyed by task class: `GeneralAnswerVerifier`, `RepoInspectionVerifier`, `FilesystemMutationVerifier`, `SecurityAnalysisVerifier`, and `ApprovalBlockedVerifier`.
- Verifier input must be the typed result envelope plus execution lineage, never free-text assistant output.
- Verifier output must be one of `satisfied`, `blocked`, `insufficient`, `contradicted`, or `policy_blocked`, with structured failure reasons and retry directives.
- "Exact file references" must be validated from typed file/path claims backed by receipts, not by checking whether the prose happens to contain something that looks like a path.

### 3. Intent Gateway cleanup
- Keep the Intent Gateway as the only semantic classifier for normal turns.
- Remove post-gateway route and operation semantic overrides from `clarification-resolver.ts`, `request-patterns.ts`, `history-context.ts`, and related helpers. After the gateway, only deterministic normalization is allowed: explicit execution IDs, pending-action IDs, surface/session IDs, provider IDs, and clarification-field fulfillment.
- Preserve the clarification step that was added earlier, but make it execution-backed: ambiguity creates a structured `ClarificationInterruption`, the stored execution owns the unresolved field, and the follow-up answer only fills that field and resumes the original request.
- An attached coding session may provide workspace context, but it must not silently promote a simple `general_assistant` request into `coding_task` or `repo_grounded`. Route and execution class stay gateway-owned.

### 4. Delegated worker protocol
- Extend the worker loop so every tool call emits a structured receipt with `toolName`, normalized arguments summary, result status, artifact refs, timestamps, and approval/blocker linkage.
- Record delegated per-tool events in the canonical routing trace and run timeline. Add new stages for `delegated_tool_call_started`, `delegated_tool_call_completed`, `delegated_interruption_requested`, `delegated_interruption_resolved`, `delegated_claim_emitted`, and `delegated_verification_decided`.
- Replace aggregate-only `WorkerExecutionMetadata` with a summary derived from the event stream. Keep aggregates as projections only.
- Record exact delegated worker tool names and receipt IDs in the routing trace so Windows trace inspection is sufficient to reconstruct what happened step by step.

### 5. Shared state and channel projection
- Make the execution event store the sole source for web, CLI, and Telegram progress, pending approvals, worker status, and replay/resume metadata.
- Keep `src/runtime/run-timeline.ts` as a projection layer, but feed it from the canonical execution event stream instead of ad hoc worker-manager callbacks.
- Web and CLI progress must render as rolling transient status frames backed by the same events; completed steps collapse into compact milestones. Telegram must project only bounded milestone and interruption items, not the full rolling feed.
- Preserve `web/public/js/chat-panel.js` and `web/public/js/chat-run-tracking.js` as consumers, but rework them to subscribe by `executionId` and `rootExecutionId` first and `runId` second.

### 6. Provider and model provenance
- Introduce `ProviderSelectionSnapshot` on the execution record and propagate it to delegated children.
- Record both requested and resolved provider, profile, model, and default-provider source as structured provenance so delegated worker selection can be audited without guessing from narration.
- Make provider/profile drift a verifier-visible failure when a child run claims a repo-grounded or local-default behavior that was not actually selected.

### 7. Deletions and cleanup
- Delete compatibility shims that reconstruct current intent from assistant prose when an execution record already exists.
- Delete the old delegated handoff model built around `result.content` plus bounded metadata; the coordinator must narrate from the structured result envelope instead.
- Delete transcript-heuristic continuation matching except for explicit approval/clarification resume detection and slash-command parsing, which remain the only allowed pre-gateway intercepts.
- Update the architecture docs so the current bounded delegated handoff is no longer described as an acceptable steady state.

## Public Interfaces and Types
- New runtime module family: `src/runtime/execution/`.
- New core types:
- `ExecutionRecordV2 { executionId, rootExecutionId, parentExecutionId?, scope, routedIntent, providerSelection, taskContract, state, activeNodeId, interruptionIds, createdAt, updatedAt }`
- `ExecutionNode { nodeId, executionId, parentNodeId?, kind, status, startedAt, endedAt?, summary }`
- `ExecutionEvent { eventId, executionId, nodeId?, type, timestamp, payload }`
- `EvidenceReceipt { receiptId, sourceType, toolName?, artifactType?, status, refs, summary, startedAt, endedAt }`
- `Claim { claimId, kind, subject, value, evidenceReceiptIds, confidence? }`
- `Interruption { interruptionId, kind, prompt, options?, approvalSummaries?, resumeToken }`
- `VerificationDecision { decision, reasons, retryable, requiredNextAction?, missingEvidenceKinds? }`
- `DelegatedResultEnvelope { taskContract, finalUserAnswer?, operatorSummary, claims, evidenceReceipts, interruptions, artifacts, verificationHints, modelProvenance }`
- Web/SSE contracts must add execution-event payloads for delegated per-tool events and verifier decisions.
- Routing trace schema must add delegated per-tool and verifier events instead of only lifecycle rows.
- `request-patterns.ts` survives only for bounded continuation and approval detection; it must no longer own route or operation inference.

## Implementation Program
1. Foundation
- Create the new execution, event, evidence, and interruption types and storage under `src/runtime/execution/`.
- Implement append-only event recording and projections for execution state, interruptions, provider selection, and verifier decisions.
- Keep one default focused coding session per surface, with explicit target overrides only.

2. Worker protocol and verifier
- Rework `src/worker/worker-llm-loop.ts` and `src/supervisor/worker-manager.ts` to emit structured tool receipts and `DelegatedResultEnvelope`.
- Build the verifier subsystem and route every delegated completion through it before user synthesis.
- Represent approval waits and clarification waits as structured interruptions, not failures.

3. Gateway and continuation cleanup
- Strip post-gateway semantic inference out of continuation and clarification helpers.
- Move ambiguity handling onto `ClarificationInterruption` and execution-backed resume.
- Remove any coding-session-based route promotion that changes semantic intent after classification.

4. Trace, timeline, and channel cutover
- Extend `src/runtime/intent-routing-trace.ts` and `src/runtime/run-timeline.ts` to ingest the new execution events.
- Update web, CLI, and Telegram projections to consume the shared event model.
- Replace channel-specific progress narration with compact, rolling event projection.

5. Cutover and deletion
- Flip the runtime to the new execution/verifier path for all delegated work.
- Remove the old aggregate metadata checks, regex insufficiency patterns, and old delegated handoff shaping.
- Update or replace the affected design docs and plans in the same change set.

6. Legacy cutover, heuristic deletion, and canonicalization
- Delete any remaining delegated-result fallback synthesis, including prose-derived envelope reconstruction, regex path scraping, and legacy interruption reconstruction when a typed envelope is missing or malformed.
- Remove post-gateway semantic route and operation overrides unless they are explicitly documented as `unknown`-only recovery. Clarification and correction turns must remain deterministic resumes of stored execution state, not fresh semantic reinterpretation.
- Make delegated verification envelope-only: no `workerExecution.completionReason` short-circuits, no legacy metadata acceptance path, and no verifier decisions derived from free-text output when typed claims and receipts are absent.
- Either wire `ExecutionEventStore` as the real append-only canonical execution log for delegated work across runtime, trace, timeline, web, CLI, and Telegram, or delete the unused scaffolding in the same cutover. Do not leave half-wired execution-store types or dead DAG records behind.
- Replace prompt-text inference for "exact file references required" with an explicit gateway-owned contract field so verifier requirements are derived from structured routing state rather than regex inspection of the request.
- Finish the missing regression and integration coverage for approval resume, external-path filesystem writes, clarification resume, exact-file repo inspection, and channel-projection parity before treating the architecture as cut over.

## Cutover Exit Criteria
- No legacy delegated envelope synthesis remains in the runtime path.
- No prose or regex scraping is used to invent file-reference claims, interruptions, or delegated evidence.
- No post-gateway semantic promotion silently converts `general_assistant` into `coding_task` or `repo_grounded`.
- The verifier accepts typed delegated envelopes plus execution lineage only.
- The canonical execution store is append-only and wired through runtime consumers, or it has been removed entirely in favor of the actual canonical store.
- Web, CLI, and Telegram projections are documented against the same shared execution-event model and covered by regression tests.
- The updated harnesses and delegated-worker tests assert the cutover behavior and pass green without relying on legacy fallback metadata.

## Test Plan
- Unit: each verifier class accepts valid envelopes and rejects false-positive completions.
- Unit: a `general_assistant` one-sentence project summary completes without tool receipts when the task contract is `answer_first`.
- Unit: a repo inspection asking for exact files fails unless the envelope contains typed file claims backed by receipts.
- Unit: a filesystem mutation fails unless a success receipt or an interruption exists.
- Unit: clarification resumes the stored request and only fills the missing field.
- Integration: external-path file creation without pre-approved path produces an approval interruption, not a delegated failure.
- Integration: once approved, the same execution resumes and records the actual `fs_write` receipt and final success.
- Integration: "Inspect the repo and name the client-side files that render live progress or timeline activity" returns exact file paths or a structured `insufficient` verifier result, never a confident false absence.
- Integration: routing trace tail for delegated runs includes exact delegated tool names, statuses, receipt IDs, and verifier decisions.
- Integration: web, CLI, and Telegram all show the same execution status transitions for the same run, with web/CLI using rolling transient progress and Telegram using compact milestones.
- Regression: no attached coding session may reclassify a simple general question into a repo-grounded delegated task.
- Harness: update `scripts/test-coding-assistant.mjs`, `scripts/test-code-ui-smoke.mjs`, `scripts/test-contextual-security-uplifts.mjs`, and any routing, pending-action, provider-selection, and delegated-worker smoke tests to assert the new execution-event schema and verifier behavior.

## Assumptions and Defaults
- Scope is `Execution + Gateway`: this plan intentionally covers delegated execution, evidence, tracing, continuation, and post-gateway heuristic cleanup in one replacement program.
- This is the new canonical plan document.
- No backward compatibility means no dual-write steady state, no legacy heuristic fallback path after cutover, and no requirement to preserve old trace or timeline schemas for external consumers.
- The existing "one primary coding session workspace with visibility to others" model remains in force; this plan does not reintroduce a separate non-coding web chat concept.
- Progress UX is included only as a projection consequence of the shared event model, not as a separate redesign track.
