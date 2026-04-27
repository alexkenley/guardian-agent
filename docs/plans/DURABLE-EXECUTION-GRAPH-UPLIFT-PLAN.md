# Durable Execution Graph Uplift Plan

**Status:** Architecture refinement and verification phase. Phases 1-4 are implemented for the read-only graph/artifact lane and the first graph-controlled search/write slice. Phase 5+ approval/continuation and delegated graph cleanup are partially implemented. The latest app-facing slice proved the current routing, continuity, approval, security, OpenRouter managed-cloud, web approval, skills-routing, and Code UI smoke paths against the actual app and browser/API surfaces. The current risk is no longer missing primitives; it is deleting the remaining overlapping owners as graph-owned replacements land and continuing delegated graph cleanup without weakening brokered-worker isolation.
**Date:** 2026-04-27
**Supersedes for future work:**
- `docs/plans/archive/DIRECT-REASONING-MODE-ARCHITECTURE-SPLIT.md`
- `docs/plans/archive/INTENT-GATEWAY-AND-DELEGATED-EXECUTION-REALIGNMENT-PLAN.md`

## Purpose

Guardian's direct-reasoning/delegated-orchestration split improved several symptoms, but the manual web tests show the split is still too binary. Direct reasoning can perform iterative read/search, and delegated orchestration can perform writes, approvals, and verification, but hybrid requests still depend on fragile prose handoffs and separate observability paths.

This plan replaces the binary split with a durable execution graph. Direct reasoning, synthesis, writes, approvals, delegation, verification, and recovery become typed graph nodes under one request id, one artifact flow, one run timeline, and one security boundary.

This is not a request to import LangGraph, Temporal, or another framework. The plan adopts the durable-workflow patterns that those systems use, while preserving Guardian's existing TypeScript runtime, Intent Gateway, brokered worker boundary, Guardian policy layer, and approval system.

## Current Implementation State

As of 2026-04-27:

- Phase 1 graph kernel and event projection are implemented: execution graph types, event types, bounded store, run-timeline adapter, and focused tests.
- Phase 2 direct reasoning as an `explore_readonly` graph node is implemented: direct reasoning emits graph events, read/search tool calls project into `RunTimelineStore`, and focused direct-reasoning/run-timeline tests pass.
- Phase 3 typed artifact store and grounded synthesis are implemented for the read-only lane: graph-owned artifact storage retains typed artifact contents and refs, direct reasoning emits `SearchResultSet`, `FileReadSet`, `EvidenceLedger`, and `SynthesisDraft` artifacts, and no-tools synthesis consumes bounded evidence artifacts.
- Phase 4 mutation nodes are implemented for the first structured search/write lane: required write steps now keep top-level requests out of read-only direct reasoning, route read-like coding plans with structured writes to workspace implementer orchestration, synthesize `WriteSpec`, execute `fs_write` through supervisor-owned tool execution, and verify the written contents.
- Phase 5 graph interrupts are implemented for the first approval/clarification slices and for brokered delegated-worker approval suspension/resume. A live OpenRouter API sweep proved pending-action creation, approval API decision, tool execution, and final continuation for a harmless policy-gated `fs_write`; several legacy producers have already been deleted, but live chat tool-loop resume and some delegated retry/recovery ownership still need graph-native replacement before their old owners can be removed.
- Continuity and code-session context are now gated before Intent Gateway classification and normal chat history is scoped to explicit surfaces. Fresh surfaces do not inherit stale owner continuity, unrelated surface chat history, or same-principal shared code sessions unless the surface was already linked, a pending action is active, an explicit/same-surface code session is present, or the gateway identifies a non-new follow-up.
- Automation authoring and automation control now have separate planned-step ownership rules: authoring can remain direct for generic read/search/write authoring work, while control defers mixed or answer-only plans instead of overlapping direct automation and worker orchestration.
- The read-only manual/API lane has proven the harder repo-inspection prompts on `ollama-cloud-coding` / `glm-5.1` without frontier escalation, including "files implementing run timeline rendering" and "which web pages consume `run-timeline-context.js`".
- Exact-file synthesis coverage for reverse dependency/consumer questions is handled in evidence selection, synthesis coverage, path canonicalization, and gateway recovery normalization, not by intent-routing keyword interception.
- Do not move to broader hybrid write behavior until the next slice preserves the proven app-facing API sweep for fresh-surface isolation, same-surface continuity, approval continuity, security refusal, and managed-cloud provider metadata.

### 2026-04-27 Handoff Status

The latest work focused on orchestration quality, evidence grounding, provider fallback, continuation, and approval-resume recovery. These changes are intentionally in shared routing/orchestration/verifier layers, not keyword intent-routing band-aids.

Implemented in this refinement slice:

- Structured task-plan category matching now lets evidence tools satisfy semantic planned-step categories such as `repo_inspect`, `web_search`, and answer/model-answer steps without adding pre-gateway keyword routing.
- Direct reasoning now refuses non-read-only planned evidence, retries when a repo-grounded answer appears before read/search evidence, treats weak/empty search evidence as insufficient, and defaults brokered `fs_search` calls to content search when the model omits a mode.
- Grounded answer synthesis fallback now runs as a no-tools LLM pass over collected evidence when tool execution succeeded but the delegated worker failed to produce a final answer.
- Approval-continuation recovery now carries approved tool results into the resumed tool loop and can synthesize a final answer from those approved tool receipts if the first resumed model turn is empty.
- Intent Gateway confirmation guidance now makes mixed web+repo requests produce concrete planned steps (`web_search`, `repo_inspect`, answer) so direct read-only reasoning does not accidentally absorb external research requests.
- Managed-cloud classifier fallback now tries other configured managed-cloud providers when the preferred classifier/profile is unavailable or rate limited.
- Fresh-surface routing now suppresses stale owner continuity and code-session context before Intent Gateway classification. Shared same-principal code sessions remain usable after a request is explicitly code-related, but the pre-gateway lookup is exact-surface or explicit-session only.
- ChatAgent prompt/history assembly now uses the same continuity eligibility rule as incoming dispatch. A fresh direct-assistant surface no longer receives old owner conversation history or stale code-session context by default.
- Automation authoring/control capability resolution now separates generic authoring reads/searches/writes from stricter automation-control execution, preventing mixed direct/worker ownership for answer or cross-domain plans.
- Non-stream `/api/message` explicit-agent dispatch now uses the same shared incoming-dispatch preparation as streaming dispatch, so request-scoped managed-cloud provider metadata, request ids, gateway decisions, and routing trace events are attached consistently.
- Default non-stream `/api/message` dispatch now preserves the supplied request id through the web route and bootstrap channel adapter, so CLI/API sweeps can correlate the request with `intent-routing.jsonl` by the operator-provided id.
- Normal chat conversation history now uses a surface-qualified channel key when an explicit surface id is present. This keeps same-surface continuity intact while preventing unrelated web surfaces from feeding fresh direct-assistant prompts or Intent Gateway history.
- `update_tool_policy add_path` now applies the critical filesystem path denial before creating an approval, so attempts to expand policy access to sensitive Guardian config paths are denied rather than approval-escalated.
- Code UI route-guard rendering now preserves unsaved editor drafts across same-page re-renders after a cancelled navigation, while sanitizing open-tab draft content out of persisted `localStorage`.
- The Code UI smoke harness now matches the blocked-workspace policy model: mutating code edits can pause for approval before applying, and harness cleanup retries transient Windows file locks before failing.
- Structured Intent Gateway recovery now rejects stale model-supplied `resolvedContent` for ordinary fresh/follow-up turns unless the turn is an explicit clarification/correction or pending-action continuation. Direct-assistant turns that require no repo grounding, tool synthesis, or non-answer planned steps are normalized back to the direct answer path, preventing stale security/refusal summaries from replacing unrelated exact-answer prompts.
- Intent Gateway now emits shared content-plan records for self-contained exact-answer and raw credential-disclosure requests. These records stay inside the gateway contract, skip unnecessary classifier model calls, and keep exact answers and security refusals out of delegated/tool paths when no tool authority is needed.
- The live tool loop now honors direct/no-tool gateway decisions by sending an empty tool set when the route needs no repo grounding, tool synthesis, or required tool-backed plan. This preserves request-scoped managed-cloud metadata while avoiding accidental tool exposure for simple answer/refusal turns.
- Continuity projection now uses the same eligibility rule in incoming dispatch, gateway traces, prompt context, and continuity updates. Fresh/new-request turns drop stale owner continuity and same-principal `code_session` refs, while same-surface transcript-reference turns repair to `follow_up` only when real continuity exists.
- Delegated provider/model verification now treats compact dated provider snapshots such as `moonshotai/kimi-k2.6-20260420` as equivalent to the selected OpenRouter alias `moonshotai/kimi-k2.6`, while still rejecting unrelated model drift.

Verified locally after these changes:

- Focused Vitest slices passed for direct reasoning, task-plan/verifier, worker-manager, worker-session, tool-loop resume, confirmation pass, intent gateway, and incoming dispatch fallback.
- Focused orchestration regression suite passed after the latest continuity/code-session scoping slice: `npx vitest run src/runtime/code-sessions.test.ts src/runtime/incoming-dispatch.test.ts src/chat-agent.test.ts src/runtime/intent/capability-resolver.test.ts src/runtime/direct-intent-routing.test.ts` reported 165 passing tests.
- Focused regression suite passed for the latest content-plan/no-tool/continuity/security changes: `src/runtime/intent-gateway.test.ts`, `src/runtime/chat-agent/live-tool-loop-controller.test.ts`, `src/runtime/chat-agent/orchestration-state.test.ts`, `src/runtime/code-session-request-scope.test.ts`, `src/runtime/incoming-dispatch.test.ts`, `src/runtime/orchestration-role-contracts.test.ts`, `src/runtime/execution-profiles.test.ts`, `src/runtime/routed-tool-execution.test.ts`, `src/runtime/intent/request-patterns.test.ts`, `src/runtime/intent/structured-recovery.test.ts`, `src/runtime/execution/verifier.test.ts`, and `src/runtime/continuity-threads.test.ts` reported 308 passing tests.
- `npm run check` passed.
- `npm run build` passed.
- `npm test` passed after the latest content-plan/continuity slice: 308 test files, 3290 tests.
- Live API replay passed the core read-only ladder for:
  - "Inspect this repo and tell me which files implement run timeline rendering. Do not edit anything."
  - "Inspect this repo and tell me which web pages consume run-timeline-context.js. Do not edit anything."
  - "Inspect this repo and tell me which files implement direct reasoning graph artifacts. Do not edit anything."
- Live API replay for web+repo comparison succeeded with a planned `web_search` + `repo_inspect` + answer contract and satisfied delegated verification.
- Live scratch-file write to `tmp/manual-web/approval-resume-smoke.txt` succeeded, but it did not request approval because the current policy allowed that path/action.
- The actual app was rebuilt, started with `scripts/start-dev-windows.ps1 -StartOnly`, and `GET http://localhost:3000/api/status` confirmed provider/routing state. The sweep used OpenRouter instead of spending time on NVIDIA provider issues.
- Exact-answer `/api/message` with request id `live-exact-fix-af151bda8ea74d7687625b081e815f91` returned the expected marker and request-scoped OpenRouter managed-cloud metadata (`providerProfileName: openrouter-direct`, `providerTier: managed_cloud`, `usedFallback: false`).
- Fresh-surface isolation was proven with request id `live-fresh-fix-80f723f1061c403e9e704554f400c938`: the brand-new surface returned the requested fresh marker, routing trace showed `codeSessionResolved=false`, and no stale same-principal code session biased the request into coding/direct-reasoning mode.
- Same-surface continuity was proven with request ids `live-cont-fix-1-1914af97dba84dfa95760198954ac993` and `live-cont-fix-2-4a9103cb5b48408ca8f1dc6ddeb72a12`: the second turn answered with the marker from the first turn on the same surface.
- Approval continuity was proven with request id `live-approval-fix-52f05d7a892a4bed8f1bc53dcc34e655`: `fs_write` was temporarily set to manual, the app created pending action `f291c3eb-985c-4271-8a8c-b74e971cc95b`, approval through the API produced a continuation response, and the target file content matched exactly. The policy was restored to `auto`.
- Security refusal was proven with request id `live-security-fix2-46f01eb5781a48ae95cd99090bca4f4c`: the prompt to read/print sensitive Guardian config credentials was refused/redacted, no pending action was created, and no raw secret pattern leaked in the response.
- Provider alias drift was reproduced on delegated managed-cloud security refusal as OpenRouter returned `moonshotai/kimi-k2.6-20260420` for selected alias `moonshotai/kimi-k2.6`. Focused verifier coverage now accepts compact dated snapshots for OpenRouter/OpenAI aliases and still rejects unrelated model drift.
- Focused regression coverage passed for the new fixes: dashboard runtime callbacks, incoming dispatch, ChatAgent surface continuity, and tool executor critical-path policy denial.
- `npm run check`, full `npm test` (308 files, 3290 tests), and `npm run build` passed after the code changes.
- Browser/web approval pass proved a real policy-gated write through the visible UI on a wide viewport: pending approval rendered, input locked/unlocked correctly, approval executed `fs_write`, final continuation rendered, and the written marker matched exactly. Screenshots were captured under `tmp/live-web-approval/`.
- `node scripts/test-web-approvals.mjs` passed for the shared web approval flow.
- `node --import tsx scripts/test-skills-routing-harness.mjs` passed with 16 passed and 1 expected skipped Outlook real-LLM selection case.
- `node scripts/test-code-ui-smoke.mjs` passed after updating the harness for blocked-workspace approval behavior and fixing the Code UI dirty-draft route-guard regression.
- Live `/api/message` request id preservation was proven after restart with request id `req-codexridfixe4306783`: OpenRouter answered the exact marker, response metadata showed `providerProfileName: openrouter-direct`, and `~/.guardianagent/routing/intent-routing.jsonl` recorded `incoming_dispatch`, profile selection, and `dispatch_response` under that same request id.
- Live regression replay for stale intent content proved the original web failure fixed: request id `req-orfix891579-exact` returned only `WEBFIX2-orfix891579` on a fresh OpenRouter surface after an unrelated credential-refusal prompt, and trace content previews stayed on the current exact-marker request.
- Live delegated security refusal replay with request id `req-orfix891579-security` completed through the Provider Explorer path using OpenRouter, refused/redacted raw credential exposure, and verifier stage `delegated_verification_decided` returned `satisfied` despite the provider reporting `moonshotai/kimi-k2.6-20260420`.
- Live same-surface continuity replay with request ids `req-orfix891579-cont1` and `req-orfix891579-cont2` recovered `CONTFIX-orfix891579` on the second turn of the same surface.
- Live approval continuity replay with request id `req-approveor662103-initial` created pending `fs_write` approval `612caf17-0b4e-42d4-8cf2-bbaf39511e60`, approval through `/api/tools/approvals/decision` resumed the graph, wrote `tmp/live-api-sweep/approval-continuity-openrouter-approveor662103.txt`, and returned exact final marker `APPROVAL-DONE-approveor662103`.
- Latest live OpenRouter API replay after rebuild/restart proved the content-plan exact-answer path with request id `codex-final-verify-fresh-f42c13a3-f066-43a4-b284-617f0a3f935d`, returning exactly `OR-FRESH-CLEAN-27491` with managed-cloud OpenRouter metadata, no fallback, no continuity context, no active execution refs, and no code-session resolution in the request trace.
- Latest live same-surface continuity replay used request ids `codex-final-verify-same-first-f6ad8ac3-b4cf-49a8-862a-a9185dff4a15` and `codex-final-verify-same-second-00a841a3-6b25-4b59-b1cf-cc2fb91b3293`; the second turn recovered `SAME-SURFACE-CLEAN-27491` from the first same-surface turn and carried only the current execution ref, not stale same-principal `code_session` refs.
- Latest live security refusal replay with request id `codex-final-verify-security-74452ddb-7261-4992-ac58-91423644dbb2` refused the request to read/print raw Guardian config credentials, leaked no raw secret patterns, used OpenRouter managed-cloud metadata, and avoided fallback.

Checkpoint after the delegated-worker and recovery graph ownership cleanup:

- `src/runtime/execution-graph/delegated-worker-node.ts` now owns delegated-worker graph creation input, running metadata, terminal verification artifacts, interruption/completion events, failure events, and status mapping. `WorkerManager` supplies request context, persists artifacts/events, and publishes timeline updates, but no longer hand-builds delegated-worker lifecycle metadata or terminal graph events.
- `src/runtime/execution-graph/node-recovery.ts` now owns the recovery-advisor graph shell, failed delegated-worker node, recovery node context, and recovery graph lifecycle event construction. `WorkerManager` still dispatches the recovery advisor worker and records routing traces, but no longer hand-builds the recovery graph nodes/events inline.
- Focused coverage for this cleanup passed: `npx vitest run src/runtime/execution-graph/delegated-worker-node.test.ts src/runtime/execution-graph/node-recovery.test.ts src/supervisor/worker-manager.test.ts src/runtime/execution-graph/graph-controller.test.ts` reported 60 passing tests.
- `npm run check` passed after the cleanup.
- Full `npm test` passed after the cleanup: 308 files, 3294 tests.
- `npm run build` passed after the cleanup.

Checkpoint after the chat-continuation approval-resume ownership cleanup:

- `src/runtime/chat-agent/chat-continuation-graph.ts` now owns graph approval-resume lifecycle projection for chat continuations: persisted resume lookup, pending-action completion timing, `interruption_resolved`, denied `graph_failed`, completion `graph_completed`, and execution-graph response metadata.
- `ChatAgent` still invokes the payload-specific continuation executors for filesystem save, automation authoring, and suspended tool-loop payloads, but it no longer hand-builds chat-continuation graph resume events or terminal graph metadata.
- `src/runtime/chat-agent/chat-continuation-runtime.ts` now owns chat-continuation payload dispatch. `ChatAgent` binds the concrete filesystem, automation, and suspended tool-loop executors, but no longer switches on continuation payload type.
- Focused coverage for this cleanup passed: `npx vitest run src/runtime/chat-agent/chat-continuation-graph.test.ts src/runtime/chat-agent/tool-loop-continuation.test.ts src/runtime/chat-agent/orchestration-state.test.ts src/chat-agent.test.ts src/runtime/pending-action-resume.test.ts` reported 105 passing tests.
- Focused coverage for the payload-dispatch extraction passed: `npx vitest run src/runtime/chat-agent/chat-continuation-runtime.test.ts src/runtime/chat-agent/chat-continuation-graph.test.ts src/runtime/chat-agent/tool-loop-continuation.test.ts src/runtime/chat-agent/tool-loop-runtime.test.ts src/chat-agent.test.ts` reported 98 passing tests.
- `npm run check` passed after the cleanup.
- Full `npm test` passed after the cleanup: 309 files, 3296 tests.
- `npm run build` passed after the cleanup.
- Full `npm test` passed after the payload-dispatch extraction: 310 files, 3299 tests.
- `npm run build` passed after the payload-dispatch extraction.

Checkpoint after the provider-provenance and delegated approval-scope cleanup:

- Response-source metadata assembly now has one shared builder used by direct reasoning, the live tool loop, and brokered worker sessions. Selected execution profile metadata is still preserved, but the final response metadata now reports the actual provider/model returned by the runtime, including provider fallback and resolved provider aliases.
- Direct reasoning now carries the successful provider response source out of the reasoning loop, so OpenRouter alias resolution such as selected `moonshotai/kimi-k2.6` returning `moonshotai/kimi-k2.6-20260420` is visible in response metadata instead of being overwritten by the configured alias.
- Shared structured tool-call recovery now handles provider-tokenized tool calls such as `<|tool_call_begin|> functions.fs_write:0 <|tool_call_argument_begin|> {...}`. This fixed the live approval case where Kimi emitted a tokenized tool call as assistant text and no approval was created.
- Delegated worker approval pending actions now scope to the origin channel/surface from delegation metadata instead of the internal surface-qualified conversation-history channel. The worker session key remains internal, but `/api/chat/pending-action?channel=web&surfaceId=...` now finds the blocked approval, and approval continuation resumes on the origin channel.
- Focused coverage passed for the provenance and recovery changes: `npx vitest run src/runtime/direct-reasoning-mode.test.ts`, `npx vitest run src/runtime/chat-agent/live-tool-loop-controller.test.ts`, `npx vitest run src/worker/worker-session.test.ts src/worker/worker-llm-loop.test.ts src/runtime/execution-graph/delegated-worker-node.test.ts`, and `npx vitest run src/util/structured-json.test.ts src/runtime/chat-agent/live-tool-loop-controller.test.ts src/runtime/chat-agent/tool-loop-runtime.test.ts src/worker/worker-llm-loop.test.ts`.
- Focused delegated approval-scope coverage passed: `npx vitest run src/supervisor/worker-manager.test.ts src/runtime/chat-agent/approval-orchestration.test.ts src/runtime/chat-agent/orchestration-state.test.ts src/util/structured-json.test.ts` reported 69 passing tests.
- `npm run check` passed after the cleanup.
- Full `npm test` passed after the cleanup: 310 files, 3301 tests.
- `npm run build` passed after the cleanup.
- The actual app was rebuilt, restarted with `scripts/start-dev-windows.ps1 -StartOnly`, and `GET http://localhost:3000/api/status` confirmed the live API was running.
- Live OpenRouter API sweep proved exact-answer provider metadata (`live-exact-prov-84e21390`), fresh-surface isolation (`live-fresh-84e21390`), same-surface continuity (`live-cont-store-84e21390` / `live-cont-recall-84e21390`), direct-reasoning resolved provider metadata (`live-direct-reason-84e21390`), and security refusal without secret leakage (`live-security-refusal-5e889a6d`).
- Live approval continuity replay with request id `live-approval-write-49686870` temporarily set `fs_write` to manual, created pending action `e38a39ca-8622-42f0-bb84-5286ef73c3ec` on origin `{ channel: "web", surfaceId: "codex-live-approval-49686870" }`, approved `599f9d17-ceac-419e-9b88-1cb20f60fd15` through `/api/tools/approvals/decision`, wrote the exact marker, cleared the pending action, and restored policy to `auto`.
- OpenRouter delegated tool prompts currently hit an account/provider limit in the live environment (`402 Prompt tokens limit exceeded: 9084 > 2147`) and correctly fall through the configured provider chain. This is not a Kimi response-quality or guardrail issue; it is provider/account capacity plus runtime fallback behavior.
- Ollama Cloud simple managed-cloud exact-answer replay passed with request id `live-ollama-exact-e64747a0` on `ollama-cloud-direct` / `minimax-m2.1` without fallback. The `ollama-cloud-tools` / `glm-4.7` approval replay did not enter the delegated tool loop because Intent Gateway fell back to `route=unknown` and the model returned pseudo-call text; treat that as provider/profile verification work, not a routing keyword workaround.

Checkpoint after the automation-control routing and direct-rendering cleanup:

- Automation control entity resolution now treats read-only list/count requests with safety negations such as "do not create, update, run, or delete" as read-only control, not automation authoring ambiguity.
- Answer-only `automation_control` read plans now remain on the direct `automation_control` candidate path. Mixed automation evidence plus answer-synthesis plans still defer to the worker/delegated path so direct control and delegated synthesis do not overlap.
- The Intent Gateway contract now carries `automationReadView` for automation-control read/inspect requests. The direct automation-control renderer uses `automationReadView=count` to return only the configured automation count and avoids creating paged-list continuation state for that count-only response.
- The automation entity resolver can infer `automationReadView=count` from the source request when a weaker classifier emits only a repaired route/operation and omits the structured entity. This is entity extraction after the gateway route is known, not pre-gateway route inference.
- Focused coverage passed for the cleanup: `npx vitest run src/runtime/automation-control-prerouter.test.ts src/runtime/intent/route-entity-resolution.test.ts src/runtime/intent/entity-resolvers/automation.test.ts src/runtime/intent/capability-resolver.test.ts src/runtime/direct-intent-routing.test.ts src/runtime/intent/intent-route-clarification.test.ts src/runtime/chat-agent/direct-automation.test.ts src/runtime/chat-agent/direct-route-orchestration.test.ts` reported 95 passing tests.
- `npm run check` passed after the cleanup.
- Full `npm test` passed after the cleanup: 310 files, 3309 tests.
- `npm run build` passed after the cleanup.
- The actual app was rebuilt and restarted, and `GET http://localhost:3000/api/status` confirmed the live API was running.
- Live OpenRouter API replay with request id `nl-automation-count-openrouter-a2c703cf` and request-scoped `openrouter-direct` metadata returned exactly `There are 38 automations currently configured.`, reported `responseSource.providerProfileName=openrouter-direct`, `providerTier=managed_cloud`, `usedFallback=false`, and the routing trace showed `automationReadView=count` with direct `automation_control`.
- Live Ollama Cloud provider override was recognized for `ollama-cloud-direct` / `minimax-m2.1`, but the provider lane was slow and produced route-only/weak structured output for this automation-control prompt. Treat that as provider/profile suitability and latency work; the app-side fallback entity resolver now covers the omitted count view once the route/operation are repaired.

> Checkpoint after the provider-fallback provenance and resumed approval-prompt cleanup:

- Live provider replay showed OpenRouter currently returning `402 Insufficient credits` in this environment; the runtime correctly fell through the provider chain. This is provider/account capacity, not Kimi response quality or a Guardian guardrail issue.
- Response-source metadata no longer grafts the requested profile onto an actual fallback provider. When `openrouter` / `openrouter-direct` fell back to `nvidia general`, the live response metadata reported `providerName: "nvidia general"`, `usedFallback: true`, and a notice naming the requested provider, without falsely showing `providerProfileName: "openrouter-direct"` as the executor.
- Ollama Cloud managed-cloud direct was used for the remaining live API sweep. `/api/message` exact-answer, same-surface continuity, fresh-surface isolation, credential-refusal security, and automation-count prompts all passed with `providerName: "ollama_cloud"`, `providerProfileName: "ollama-cloud-direct"`, model `minimax-m2.1`, and no fallback.
- Live control/tool API smoke passed for `llm_provider_list`, `find_tools`, `web_fetch` on `https://example.com`, DuckDuckGo `web_search`, Playwright-backed `browser_read` on `https://example.com`, `browser_capabilities`, `second_brain_overview`, and `second_brain_note_list`. `browser_read` correctly blocked `localhost` through SSRF protection when called as an app tool.
- Live approval continuity replay for a harmless temp-file write proved the two-stage graph interrupt chain: first approval added the temp directory to allowed paths, the continuation created a second `fs_write` approval, second approval wrote the exact file content, final continuation completed, the pending action cleared, and the temporary policy path was removed afterward.
- Resumed suspended tool-loop approvals now rebuild the next pending-action blocker prompt from the new approval summaries instead of reusing the previous blocker prompt. The live two-stage replay now shows both `continuedResponse.content` and `pendingAction.blocker.prompt` as the current `fs_write` approval.
- Focused coverage passed for these fixes: `npx vitest run src/runtime/chat-agent/tool-loop-runtime.test.ts src/runtime/dashboard-dispatch.test.ts`.
- Harness coverage passed after updating stale fake-provider expectations to the current filesystem tool-loop route contract: `node scripts/test-web-approvals.mjs`, `node --import tsx scripts/test-skills-routing-harness.mjs`, and `node scripts/test-contextual-security-uplifts.mjs`.

> Checkpoint after request-scoped classifier fallback and brokered policy-remediation cleanup:

- Request-scoped chat-provider selection no longer makes the selected provider the only Intent Gateway classifier. Incoming dispatch now tries the requested provider first and then continues through the normal classifier fallback order when that provider cannot produce an available structured gateway decision. The selected execution profile still stays request-scoped for the actual response/tool-loop execution.
- Structured fallback write plans that contain required write steps now derive a `filesystem_task` / `tool_orchestration` / `tool_loop` workload instead of leaving the turn as `unknown` direct-assistant work.
- Brokered worker policy-blocked filesystem samples now preserve structured tool args. When the worker hits a fixable brokered filesystem policy block and the model stops with prose instead of requesting `update_tool_policy`, `BrokeredWorkerSession` requests the policy-remediation approval through the brokered tool executor and resumes from the pending action after approval. The worker still has no direct `Runtime`, `ToolExecutor`, provider, channel, or filesystem authority.
- Live app approval replay passed on the rebuilt app using request-scoped Ollama Cloud managed-cloud profile `ollama-cloud` / `gpt-oss:120b`: request id `live-approval-562c0bf7-start` created an `update_tool_policy` pending approval for `C:\Users\kenle\AppData\Local\Temp\guardian-live-approval-562c0bf7`, approval through `/api/tools/approvals/decision` resumed the delegated graph, `fs_write` created `approved.txt`, the final response reported the file, and `/api/chat/pending-action` cleared. Trace stages showed `managed_cloud_tool`, delegated filesystem mutation, approval interruption, approval resolution, resumed `fs_write`, and no fallback.
- The earlier `ollama-cloud-tools` / `glm-4.7` replay exposed provider/profile suitability rather than a guardrail failure: the model returned pseudo-call text and weak classification. The architecture fix is classifier fallback plus brokered policy-remediation recovery, not keyword route interception. For live approval smoke, `ollama-cloud` / `gpt-oss:120b` is the better managed-cloud profile.
- Focused coverage passed for the new routing and worker recovery changes: `npx vitest run src/worker/worker-session.test.ts src/worker/worker-llm-loop.test.ts src/runtime/intent-gateway.test.ts src/runtime/incoming-dispatch.test.ts src/runtime/incoming-dispatch-mode-selection.test.ts` reported 209 passing tests.
- Harness coverage passed: `node scripts/test-brokered-approvals.mjs`, `node scripts/test-web-approvals.mjs`, `node --import tsx scripts/test-skills-routing-harness.mjs`, and `node scripts/test-contextual-security-uplifts.mjs`.
- Full gates passed after the cleanup: `npm run check`, full `npm test` (310 files, 3315 tests), and `npm run build`.

Known remaining problems and risks:

- The app API and web UI approval paths are now proven for a harmless policy-gated write. Remaining approval work is ownership cleanup, not first-proof validation.
- Approval/resume ownership is narrower after the latest cleanup, but payload-specific chat continuation executors and suspended tool-loop replay still need graph-native node equivalents before the remaining replay payload can be deleted.
- Delegated graph ownership is narrower after the latest cleanup, but delegated worker dispatch, task-contract verification policy, retry budgeting, and recovery-advisor invocation are still coordinated from `WorkerManager`. Continue moving those decisions into graph node/controller boundaries before deleting old side channels.
- Provider alias drift for compact dated OpenRouter snapshots is now covered in the delegated verifier. Remaining provider risk is broader fallback/profile ownership cleanup, not this known `moonshotai/kimi-k2.6` alias mismatch.
- Provider/profile suitability remains uneven across managed-cloud profiles: OpenRouter Kimi handled prior automation-control paths correctly but is currently blocked by account credits in this environment; Ollama Cloud `minimax-m2.1` proves request-scoped managed-cloud direct chat, Ollama Cloud `gpt-oss:120b` proves managed-cloud approval/tool-loop work, and weaker structured-output profiles should remain covered by classifier fallback and profile-verification tests rather than route keywords.
- The unstructured intent repair path has been retired. Prose-only classifier responses now remain unavailable gateway records so fallback passes, structured recovery, or clarification own recovery; there is no raw-text post-gateway route inference path.
- Startup in this operator environment still reports a local control-plane integrity warning for `scheduled-tasks.json`; that is host runtime state, not a code regression from this slice.

Recommended next slice:

1. Keep the OpenRouter API and browser sweeps as the regression baseline for any next routing/continuity/approval/web change: exact-answer provider metadata, fresh-surface isolation, same-surface continuity, approval continuity, security refusal, request-id trace correlation, web approval UI, skills routing, and Code UI smoke.
2. Establish graph-owned approval resume as the next hard deletion boundary. Move one remaining legacy approval/resume producer fully onto graph interrupts, then delete the replaced owner in the same slice.
3. Continue delegated graph cleanup by moving delegated retry decisions, task-contract verification policy, and recovery-advisor invocation behind graph node/controller boundaries, deleting overlapping `WorkerManager` side channels as each path is proven.
4. Continue provider fallback/profile cleanup by moving duplicate retry and fallback ownership into execution profile/runtime orchestration. Preserve the compact dated snapshot verifier coverage when changing provider metadata.

### 2026-04-26 Architecture Refinement And Debt-Burn Phase

The architecture audit found that Guardian now has most of the necessary primitives, but several partial systems still own the same lifecycle decisions. The next phase is a refactor and deletion phase, not a feature expansion phase.

Root ownership problems to resolve:

- `ChatAgent` still owns normal turn orchestration, direct-route dependency assembly, tool-loop resume, retry/continuation repair, and response shaping. Route-specific direct capability dispatch is being moved behind shared runtime modules slice by slice.
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

Checkpoint after the continuity/code-session scoping and automation ownership cleanup:

- Incoming dispatch and ChatAgent now share the same continuity eligibility helper. A continuity thread can influence a turn only when the surface was already linked before the turn, a pending action exists, a code session is explicitly/current-surface resolved, or the Intent Gateway classifies the turn as a non-new follow-up.
- Code-session resolution now has an explicit pre-gateway mode: `allowSharedAttachment: false`. This keeps stale same-principal shared code sessions out of fresh-surface intent classification while preserving explicit session ids and exact-surface attachments.
- Fresh-surface unit coverage now verifies that old owner history and stale code-session context do not enter direct-assistant prompts or Intent Gateway `recentHistory`.
- Automation authoring/control planned-step matching now avoids overlapping ownership. Generic read/search/write steps can stay direct for automation authoring, while automation control defers answer-only, uncategorized, or cross-domain plans to the worker path.
- Verification after this checkpoint: focused orchestration suite, `npm run check`, full `npm test`, and `npm run build` all passed.
- Remaining proof after this checkpoint: run the actual app API sweep against managed cloud providers to prove fresh-surface isolation, same-surface continuation, approval continuity, security refusal, and provider alias handling in the deployed runtime path.

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

Checkpoint after the direct-route ownership cleanup:

- `src/runtime/chat-agent/direct-route-handlers.ts` now owns direct-route dispatch for personal assistant/Second Brain, coding session control, and coding backend delegation instead of accepting route callbacks from `ChatAgent`.
- `src/runtime/chat-agent/direct-personal-assistant.ts` owns Second Brain read/write/routine dispatch and item-type focus resolution. `ChatAgent` now only binds Second Brain services, clarification creation, and mutation execution.
- Coding backend and coding session-control routes now share explicit dependency bundles and a single coding-task resumer, including the early `coding_session_control` path.
- The old `ChatAgent` private route wrappers for Second Brain, coding backend delegation, and gateway-driven code session control were deleted in the same slice. Remaining `ChatAgent` orchestration debt is top-level turn assembly, dependency binding, response shaping, and the non-direct tool-loop/continuation paths.
- Focused direct-route, coding-backend, and code-session-control tests passed, and `npm run check` passed for the slice.

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

Checkpoint after the direct-runtime dependency cleanup:

- Mailbox, automation, browser, and scheduled-email direct paths now share `src/runtime/chat-agent/direct-runtime-deps.ts` for their approval/tool dependency contracts.
- `src/chat-agent.ts` no longer carries private wrapper methods for direct Google Workspace read/write, automation authoring/control/output, browser automation, or scheduled email automation; the route handler calls those runtime helpers directly with composed runtime deps.
- Tests that previously reached into removed `ChatAgent` private wrappers now exercise the owning direct-runtime modules instead, so private wrapper compatibility is not preserved as test scaffolding.

Checkpoint after the direct-route handler factory extraction:

- Direct-route handler map construction now lives in `src/runtime/chat-agent/direct-route-handlers.ts` with focused coverage in `src/runtime/chat-agent/direct-route-handlers.test.ts`.
- `src/chat-agent.ts` no longer imports or wires provider-read, web-search, mailbox, automation, browser, scheduled-email, memory, or filesystem direct helper modules inline; it supplies scoped request context plus explicit callbacks only for the still-ChatAgent-owned Second Brain and coding paths.
- Memory approval continuity and filesystem stored-save continuation are covered at the route-handler boundary, preserving `ToolExecutor`/`checkAction`, shared pending actions, and stored filesystem-save orchestration while removing the private `ChatAgent` wrappers.
- Remaining direct-route debt: retire the Second Brain and coding callback-backed private wrappers with explicit runtime dependency groups, then collapse this direct-route runtime behind the broader graph controller boundary.

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

Live API checkpoint after the broad capability smoke pass:

- `scripts/start-dev-windows.ps1 -StartOnly` was running the real app at `http://localhost:3000`; `GET /api/status` returned `status=running`.
- `/api/message` exact-answer smoke passed with Ollama Cloud managed-cloud routing (`ollama_cloud`, `ollama-cloud-direct`, `minimax-m2.1`, no fallback) after OpenRouter delegated requests hit account/context limits rather than model-quality or guardrail failures.
- Direct tool API smoke passed after deferred discovery through `find_tools`: `web_fetch` on `https://example.com`, DuckDuckGo `web_search`, Playwright-backed `browser_navigate` and `browser_read`, `automation_list`, and `memory_save`.
- `memory_search` was proven with the correct split search contract (`scope=persistent`, `persistentScope=global`) and found the smoke marker written by `memory_save`.
- Second Brain mutating tools behaved as expected: `second_brain_note_upsert` and `second_brain_note_delete` returned pending approvals, approval decisions executed the tools, the note was visible after approve, and the cleanup delete removed it.
- Smoke artifacts were written under `tmp/live-api-sweep/` and intentionally not tracked. Remaining live-smoke expansion should cover natural-language automation authoring/control, web UI approval rendering, multi-domain delegated requests, and longer graph-timeline observability once the next cleanup slice lands.

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

## Fresh-Chat Continuation Prompt

Use this to continue verification and any remaining uplift work in a fresh chat:

```text
Continue the GuardianAgent durable execution graph uplift from docs/plans/DURABLE-EXECUTION-GRAPH-UPLIFT-PLAN.md.

First inspect AGENTS.md, SECURITY.md, docs/design/BROKERED-AGENT-ISOLATION-DESIGN.md, docs/architecture/FORWARD-ARCHITECTURE.md, docs/design/ORCHESTRATION-DESIGN.md, docs/design/PENDING-ACTION-ORCHESTRATION-DESIGN.md, docs/guides/INTEGRATION-TEST-HARNESS.md, and this plan.

Context: Phases 1-4 are implemented. Phase 5+ is partially implemented. The latest architecture-refinement and app-facing slices scoped stale continuity/code-session state out of fresh surfaces, split automation authoring/control planned-step ownership, fixed non-stream `/api/message` request metadata, surface-scoped normal chat history, blocked policy expansion to sensitive Guardian config paths, rejected stale model-supplied `resolvedContent` for ordinary turns, normalized simple direct-assistant workload recovery back to direct answers, and accepted compact dated OpenRouter/OpenAI snapshot model ids as aliases in delegated verification. Focused orchestration tests, npm run check, npm test, npm run build, and the OpenRouter app API sweep passed before this handoff. The remaining work is deletion of overlapping approval/delegated owners as graph-owned replacements land.

Do not start with broad refactoring. First preserve the proven actual-app API baseline from this plan, then run any changed approval/browser surface against a harmless policy-gated write. Do not use fake model harnesses for this pass. Prefer OpenRouter unless another provider is explicitly needed.

Suggested loop:
1. Confirm the worktree and current branch. Do not create or switch branches.
2. Run npm run build, start the real app with scripts/start-dev-windows.ps1 -StartOnly, then confirm GET http://localhost:3000/api/status and provider/routing state.
3. Re-run the compact OpenRouter API baseline only if your change touches routing, continuity, approval, providers, or security: exact-answer provider metadata, fresh-surface isolation, same-surface continuity, policy-gated approval continuity, and security refusal.
4. If web approval rendering or browser routing changed, run the manual browser/web UI approval pass for the same harmless policy-gated write shape. Verify pending action rendering, approval/deny controls, input locking/unlocking, final continuation display, and no duplicate replay turn.
5. Move one remaining approval/resume legacy owner onto graph interrupts and delete the replaced owner in the same slice.
6. Continue delegated graph cleanup by moving delegated retry/recovery terminal ownership into graph node runners and deleting overlapping WorkerManager side channels as each path is proven.
7. Keep provider alias verification focused in the provider/profile verifier. Compact dated snapshots such as moonshotai/kimi-k2.6-20260420 are already covered; preserve that coverage while moving broader provider fallback ownership into runtime orchestration.

If testing finds failures, fix the owning architecture layer only:
- intent/routing: Intent Gateway and shared dispatch
- stale context: continuity/context projection and code-session request scope
- approval/resume: PendingActionStore and graph interrupts
- provider fallback/aliasing: execution profiles and runtime provider orchestration
- delegated execution: graph node runner/delegated-worker node ownership

Do not add keyword/regex intent-routing band-aids, channel-specific exceptions, or compatibility shims. Keep brokered-worker isolation intact: no direct Runtime, ToolExecutor, provider, channel, or filesystem authority in the worker. After any fix, run focused Vitest, npm run check, npm test, npm run build, and the relevant app API/harness sweep. Update this plan with what was proven and what remains.
```
