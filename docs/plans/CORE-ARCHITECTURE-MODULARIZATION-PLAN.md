# Core Architecture Modularization Plan

**Date:** 2026-04-02  
**Status:** Active, checkpoint updated after chat-agent separation  
**Origin:** Large-file architecture review of the composition root, web channel, and tool runtime  
**Key files:** `src/index.ts`, `src/tools/executor.ts`, `src/channels/web.ts`  
**Related docs:** `docs/architecture/FORWARD-ARCHITECTURE.md`, `docs/architecture/OVERVIEW.md`, `docs/guides/INTEGRATION-TEST-HARNESS.md`

---

## Goal

Restructure GuardianAgent so new capabilities can be added without repeatedly editing the same monolithic files.

The target architecture remains:

- thin composition/bootstrap entrypoints
- thin transport/channel adapters
- explicit control-plane services
- modular tool registrars by capability family
- centralized policy, approval, audit, sandbox, and routing boundaries

This is a behavior-preserving modularization program, not a rewrite.

---

## Non-Negotiable Migration Rules

### 1. No delete-and-recreate rewrite

Do not delete `src/index.ts`, `src/tools/executor.ts`, or `src/channels/web.ts` and rebuild them from model context.

Every extraction must work by:

- copying existing code into focused modules
- rewiring imports and call sites mechanically
- preserving current behavior first
- proving parity with tests and harnesses

### 2. Preserve runtime behavior first

Do not mix architectural extraction with unrelated feature work, policy rewrites, or speculative cleanup.

### 3. Keep central boundaries centralized

The following remain kernel boundaries and must not get fragmented:

- Intent Gateway routing ownership
- Guardian admission and security checks
- tool approval and policy enforcement
- audit logging
- sandbox enforcement
- shared orchestration and pending-action handling

### 4. Validate each phase

For each extraction slice:

- run focused tests for the touched surface
- run `npm run check`
- run the mapped integration harnesses from `docs/guides/INTEGRATION-TEST-HARNESS.md`
- run `npm test` before closing the slice

### 5. Commit only shippable slices

Every phase should remain independently mergeable and revertable.

---

## Status Snapshot

### What is complete

#### Architecture documentation

- `docs/architecture/FORWARD-ARCHITECTURE.md` was added in `a28f18b`.
- `AGENTS.md` and `CLAUDE.md` both reference the forward architecture document.

#### `src/channels/web.ts` modularization

This track is substantially complete.

- `src/channels/web.ts` is down to **1262 lines** from roughly **5.8k** at the start of the program.
- JSON parsing/body handling was centralized in `src/channels/web-json.ts`.
- Route groups were extracted into:
  - `src/channels/web-control-routes.ts`
  - `src/channels/web-monitoring-routes.ts`
  - `src/channels/web-runtime-routes.ts`
  - `src/channels/web-chat-routes.ts`
  - `src/channels/web-automation-routes.ts`
  - `src/channels/web-provider-admin-routes.ts`
  - `src/channels/web-code-session-routes.ts`
  - `src/channels/web-code-workspace-routes.ts`
  - `src/channels/web-terminal-routes.ts`
- Shell launch logic was split into `src/channels/web-shell-launch.ts`.

#### `src/tools/executor.ts` modularization

This track is complete for the original registrar-extraction goal.

- `src/tools/executor.ts` is down to **6301 lines** from roughly **17.9k**.
- Builtin tool families were moved into `src/tools/builtin/` modules:
  - `automation-tools.ts`
  - `browser-tools.ts`
  - `cloud-tools.ts`
  - `coding-tools.ts`
  - `contacts-email-tools.ts`
  - `filesystem-tools.ts`
  - `memory-tools.ts`
  - `network-system-tools.ts`
  - `policy-tools.ts`
  - `search-tools.ts`
  - `security-intel-tools.ts`
  - `web-tools.ts`
  - `workspace-tools.ts`
- `ToolExecutor` is now much closer to the intended kernel role: orchestration, approval, policy, lookup, and execution lifecycle.

#### `src/index.ts` control-plane extraction

This track is materially advanced and the largest remaining structural extraction is now complete.

- `src/index.ts` is down to **4871 lines** from roughly **17.7k**.
- `src/chat-agent.ts` now owns the extracted conversational agent runtime at **6922 lines**.
- `src/chat-agent-helpers.ts` now owns the extracted support/helper surface that was previously shared inline between the chat-turn loop and control-plane shaping.
- `src/index.ts` and `src/chat-agent.ts` now share the same `IntentGateway` instance so pre-dispatch routing and in-agent fallback classification stay aligned with the routing spec's "classify once and reuse" contract.
- Extracted control-plane modules now live under `src/runtime/control-plane/`:
  - `agent-dashboard-callbacks.ts`
  - `assistant-dashboard-callbacks.ts`
  - `auth-control-callbacks.ts`
  - `config-persistence-service.ts`
  - `config-state-helpers.ts`
  - `dashboard-runtime-callbacks.ts`
  - `direct-config-update.ts`
  - `governance-dashboard-callbacks.ts`
  - `operations-dashboard-callbacks.ts`
  - `provider-config-helpers.ts`
  - `provider-dashboard-callbacks.ts`
  - `provider-integration-callbacks.ts`
  - `provider-runtime-adapters.ts`
  - `security-dashboard-callbacks.ts`
  - `setup-config-dashboard-callbacks.ts`
  - `tools-dashboard-callbacks.ts`
  - `workspace-dashboard-callbacks.ts`
- The highest-risk dashboard and config-update blocks are no longer fully embedded inline in `src/index.ts`.
- Bootstrap extraction is now active under `src/bootstrap/`:
  - `runtime-factory.ts` owns default-config bootstrap, secure config load, runtime credential resolution, denied-path injection, and initial `Runtime` construction.
  - `service-wiring.ts` owns scheduled-task executor wiring, runtime notification service construction, runtime support startup, playbook schedule migration, and CLI post-start setup.
  - `channel-startup.ts` owns CLI, Telegram, and Web channel construction, startup logging, channel registration, Telegram reload wiring, and coding-backend bootstrap for the web surface.
  - `shutdown.ts` owns graceful shutdown sequencing for channels, managed intervals, MCP cleanup, executor disposal, runtime stop, store shutdown, and terminal exit settlement.
- Runtime orchestration extraction is now active under `src/runtime/`:
  - `incoming-dispatch.ts` owns shared pre-dispatch preparation for channel messages: request-id assignment, code-session-aware route resolution, pinned-session agent handling, pre-routed intent metadata attachment, and early routing trace recording.
  - `dashboard-dispatch.ts` owns shared post-routing dashboard/runtime dispatch: code-session-aware message shaping, orchestrator handoff, response-source enrichment, fallback-tier retries, and dispatch-response trace recording.
  - `channel-startup.ts` now depends on the shared `PrepareIncomingDispatch` contract from `src/runtime/incoming-dispatch.ts` instead of shadowing that type and shape locally.
- Control-plane helper extraction is also active:
  - `config-state-helpers.ts` owns credential-ref normalization, local-secret lifecycle helpers, and persistence helpers for tools, skills, and connectors.
  - `provider-config-helpers.ts` owns provider snapshot/status shaping, provider credential resolution for ad hoc model discovery, and existing-profile lookup helpers reused by direct config updates.
  - `provider-dashboard-callbacks.ts` owns the provider listing/type/model callbacks that used to sit inline in the callback factory.
  - `agent-dashboard-callbacks.ts` owns dashboard agent listing/detail shaping, including internal-agent classification and routing-role exposure.
  - `assistant-dashboard-callbacks.ts` owns assistant-state summaries, delegated-worker follow-up actions, run-history callbacks, and routing-trace decoration used by the dashboard surface.
  - `dashboard-runtime-callbacks.ts` now owns dashboard SSE subscription fan-out, direct dashboard dispatch delegation, stream dispatch, and quick-action orchestration callbacks that used to sit inline in the callback factory.
  - `governance-dashboard-callbacks.ts` now owns Guardian Agent status/update callbacks, Policy-as-Code dashboard controls, and Sentinel audit execution callbacks that used to sit inline in the callback factory.
  - `provider-runtime-adapters.ts` now owns the GWS CLI probe and cloud connection test adapter construction that used to sit inline next to provider integration callback wiring.
  - `chat-agent.ts` now owns the main chat-turn orchestration loop that used to sit inline in `src/index.ts`: LLM/tool rounds, direct-intent handling, approval continuation flow, code-session interaction, and shared pending-action coordination.
  - `chat-agent-helpers.ts` now owns the extracted helper surface for tool result shaping, code-session prompt context, provider-routing defaults, Gmail/M365 summaries, and config redaction.

### What is still left

The main remaining architecture work is now concentrated in the final `src/index.ts` composition-root cleanup and any follow-on trimming that becomes obvious after the chat-agent split.

#### Remaining `src/index.ts` work

- Finish thinning the callback factory so `main()` and the entrypoint stop owning residual dashboard glue directly.
- Reassess the remaining provider/config shaping helpers that still sit inline and move them only where there is a clear stable home.
- Do a final composition-root pass so `src/index.ts` stays focused on bootstrap, service assembly, channel startup, and registration rather than helper ownership.
- Reassess whether any of the remaining entrypoint-local helpers are better left in place to avoid over-fragmenting low-churn code now that the major runtime path is extracted.

#### Optional follow-up cleanup

These are lower priority than the remaining `index.ts` work:

- further split remaining auth/SSE/session internals out of `src/channels/web.ts` if churn resumes there
- extract additional shared helpers from executor-adjacent code only when duplication is proven by real follow-on work
- monitor `src/chat-agent.ts` as the next likely monolith: if capability churn continues there, split it by concern instead of letting new work accumulate in the extracted runtime class
- likely future `src/chat-agent.ts` split points are:
  - direct deterministic route handlers
  - approval and pending-action continuation logic
  - code-session prompt/context assembly
  - provider fallback and response-quality recovery

---

## Milestone Ledger

### Completed milestone commits

#### Architecture contract

- `a28f18b` `docs(architecture): add forward architecture contract`

#### Web modularization

- `f91727d` `refactor(web): centralize json body parsing helpers`
- `3697e5e` `refactor(web): extract control-plane route group`
- `5314b1f` `refactor(web): split monitoring and runtime routes`
- `de84ce6` `refactor(web): split chat and conversation routes`
- `ac869f7` `refactor(web): split automation and provider-admin routes`
- `417a8ad` `refactor(web): split code session routes`
- `eb4ddb0` `refactor(web): split workspace and terminal routes`

#### Control-plane / `index.ts`

- `f52b71c` `refactor(control-plane): extract config persistence service`
- `f3e2de9` `refactor(index): extract provider integration callbacks`
- `d7e04da` `refactor(index): extract dashboard control-plane modules`
- `661c97c` `refactor(bootstrap): extract runtime factory`
- `f63a240` `refactor(bootstrap): extract service wiring and shutdown`
- `d01cbbd` `refactor(bootstrap): extract channel startup`
- `1c6caa2` `refactor(control-plane): extract cloud test callback`
- `d671755` `refactor(runtime): extract incoming dispatch preparation`
- `370053f` `refactor(runtime): extract dashboard dispatch`
- `d5755ba` `refactor(control-plane): extract config state helpers`
- `5c7203a` `refactor(control-plane): extract agent and provider callbacks`
- `3bcb02a` `refactor(control-plane): extract assistant dashboard callbacks`
- `4a99f40` `refactor(control-plane): extract dashboard runtime callbacks`
- `741a31e` `refactor(control-plane): extract governance dashboard callbacks`
- current checkpoint extracts provider runtime adapters and validates the provider/control-plane path with focused tests, `test-cloud-config`, and full Vitest

#### Tool executor modularization

- `56ad754` `refactor(tools): extract web builtin registrar`
- `898480a` `refactor(tools): extract browser builtin registrar`
- `d6cc7e7` `refactor(tools): extract search and workspace registrars`
- `d8bdfce` `refactor(tools): extract automation builtin registrar`
- `2516b1d` `refactor(tools): extract contacts and email registrars`
- `fa88d59` `refactor(tools): extract security and monitoring registrars`
- `4cca13d` `refactor(tools): extract cloud builtin registrar`
- `f165b4b` `refactor(tools): extract filesystem builtin registrar`
- `b4a3137` `refactor(tools): complete executor modularization`

---

## Current Architectural State

### What the repo now looks like

#### Composition root

`src/index.ts` still acts as the composition root, but several control-plane domains are now delegated to focused modules instead of living inline.

The bootstrap path is now mostly split under `src/bootstrap/`: runtime creation, service wiring, channel startup, and shutdown sequencing are extracted. `src/runtime/incoming-dispatch.ts` now carries the shared channel pre-dispatch/routing-preparation path that used to sit inline in `main()`, `src/runtime/dashboard-dispatch.ts` now carries the shared dashboard/runtime dispatch path that used to sit inline in the callback factory, `src/runtime/control-plane/dashboard-runtime-callbacks.ts` now carries the dashboard SSE/stream/quick-action runtime callback cluster that used to live inline in `buildDashboardCallbacks()`, `src/runtime/control-plane/governance-dashboard-callbacks.ts` now carries the governance/admin callback cluster for Guardian Agent, Policy-as-Code, and Sentinel audit controls, `src/runtime/control-plane/provider-runtime-adapters.ts` now carries provider-specific runtime probe/test adapter wiring, and `src/chat-agent.ts` now carries the primary conversational runtime path that used to dominate the entrypoint. The remaining `index.ts` work is final provider/config helper cleanup and composition-root thinning.

#### Web channel

`src/channels/web.ts` is now primarily a delegating adapter over specialized route modules and shared request helpers. This track achieved the original route-level modularization goal.

#### Tool runtime

`src/tools/executor.ts` now uses builtin registrars instead of acting as the implementation host for nearly every tool family.

### Architecture deliverables already in place

- Forward architecture target document exists: `docs/architecture/FORWARD-ARCHITECTURE.md`
- Repository guidance points engineers at that document before major refactors:
  - `AGENTS.md`
  - `CLAUDE.md`

---

## Remaining Execution Plan

## Phase 4: Finish `src/index.ts`

### Goal

Reduce `src/index.ts` to a true bootstrap/composition root.

### 4A. Extract bootstrap and startup wiring

Continue the `src/bootstrap/` rollout. The following are already extracted:

- runtime construction
- service construction and dependency assembly
- channel startup
- shutdown hooks and process lifecycle handling

Suggested modules:

- `src/bootstrap/runtime-factory.ts`
- `src/bootstrap/service-wiring.ts`
- `src/bootstrap/channel-startup.ts`
- `src/bootstrap/shutdown.ts`

### 4B. Thin the remaining entrypoint helpers

Move remaining `index.ts` helpers into clearer homes based on responsibility:

- control-plane helpers stay under `src/runtime/control-plane/`
- bootstrap and startup helpers move under `src/bootstrap/`
- config-mutation helpers move beside `config-persistence-service.ts` or `direct-config-update.ts` if they are part of those flows
- chat-turn/runtime helpers should now default to `src/chat-agent.ts` or `src/chat-agent-helpers.ts`, not back into `src/index.ts`

### 4C. Make `main()` orchestration-only

Exit target for this phase:

- `main()` loads config, builds dependencies, starts channels, and registers shutdown
- operational control-plane logic is no longer defined inline in the entrypoint

### Exit criteria

- `src/index.ts` is materially smaller and primarily orchestration
- bootstrap/service wiring becomes testable without traversing unrelated dashboard behavior
- no new capability work needs to land in `src/index.ts` by default

## Phase 5: Post-extraction consolidation

### Goal

Close the refactor cleanly after `index.ts` is reduced.

### Work

- remove any obsolete compatibility glue left behind by staged extractions
- tighten module dependency directions to match `docs/architecture/FORWARD-ARCHITECTURE.md`
- update the architecture docs if final code layout differs from the original target sketch
- do one final review of `src/channels/web.ts`, `src/tools/executor.ts`, and `src/index.ts` for leftover dead helpers or obvious follow-on extraction candidates

### Exit criteria

- `src/index.ts`, `src/channels/web.ts`, and `src/tools/executor.ts` all match their intended architectural roles
- the modularization plan can be closed and superseded by the forward architecture document

---

## Validation Strategy Going Forward

Each remaining phase should run:

- focused Vitest for the touched surfaces
- `npm run check`
- `npm test`

### Harness mapping

#### `src/index.ts` / control-plane / bootstrap work

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`
- `node scripts/test-cloud-config.mjs`
- `node scripts/test-code-ui-smoke.mjs` when channel/control-plane surfaces are touched

#### `src/channels/web.ts` follow-on work, if any

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`

#### `src/tools/executor.ts` follow-on work, if any

- `node scripts/test-coding-assistant.mjs`
- `node scripts/test-contextual-security-uplifts.mjs`
- `node scripts/test-cloud-config.mjs` when cloud/provider tooling is touched
- `node scripts/test-automation-authoring-compiler.mjs` when automation/coding tool surfaces are touched

### Known note from the latest validation run

One earlier `node scripts/test-code-ui-smoke.mjs` run hit a transient UI timing assertion during the `d7e04da` validation pass, but the immediate rerun passed with no code changes. Treat that as harness flakiness to watch, not as a known deterministic regression.

For the chat-agent separation checkpoint:

- `npm run check` passed
- `npm test` passed with **190 files / 2080 tests**
- `node scripts/test-contextual-security-uplifts.mjs` passed
- `node scripts/test-code-ui-smoke.mjs` passed
- `node scripts/test-cloud-config.mjs` passed
- `node scripts/test-coding-assistant.mjs` failed once on initial server-health startup timing, then passed on the immediate rerun with no code changes

---

## Definition Of Done

This modularization program is complete only when all of the following are true:

- `src/index.ts` is primarily bootstrap/composition code
- `src/channels/web.ts` is primarily channel wiring and delegation
- `src/tools/executor.ts` is primarily executor kernel logic and registrar dispatch
- architecture guidance remains published in `docs/architecture/FORWARD-ARCHITECTURE.md`
- adding a new capability no longer requires editing all three monolith files by default

---

## Next Session Restart Point

If this plan is resumed in a later session, start with the remaining `src/index.ts` cleanup around the callback factory and provider/config glue.

Immediate next move:

1. inspect the remaining callback-factory and provider/config helper clusters in `src/index.ts`
2. decide whether each remaining helper should move under `src/runtime/control-plane/`, `src/bootstrap/`, or simply stay in the composition root
3. add or tighten focused coverage for that slice if needed
4. extract mechanically, then run the mapped harness set

The `web.ts` and `executor.ts` tracks are no longer the critical path unless a regression or new feature exposes a gap there.
