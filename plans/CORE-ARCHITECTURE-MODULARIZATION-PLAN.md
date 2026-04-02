# Core Architecture Modularization Plan

**Date:** 2026-04-02  
**Status:** Active, checkpoint updated after config-state-helper extraction  
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

This track is materially advanced but not finished.

- `src/index.ts` is down to **13580 lines** from roughly **17.7k**.
- Extracted control-plane modules now live under `src/runtime/control-plane/`:
  - `auth-control-callbacks.ts`
  - `config-persistence-service.ts`
  - `config-state-helpers.ts`
  - `direct-config-update.ts`
  - `operations-dashboard-callbacks.ts`
  - `provider-integration-callbacks.ts`
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

### What is still left

The main remaining architecture work is now concentrated in `src/index.ts`.

#### Remaining `src/index.ts` work

- Extract the remaining callback-factory helper clusters so `main()` and the entrypoint factory stop owning provider/config shaping and residual dashboard glue directly.
- The remaining `src/bootstrap/` extraction work is limited; the main effort is now trimming residual helper glue out of `src/index.ts` around provider/config shaping, callback-factory assembly, and final orchestration.
- Move remaining helper clusters out of `src/index.ts` when they have clear homes, especially:
  - provider info/config shaping helpers
  - residual config-persist/apply glue still local to the entrypoint
  - callback-factory helpers that still do not belong in `src/index.ts`
- Reassess whether `buildDashboardCallbacks()` should become a thinner factory wrapper over already-extracted modules, or whether parts of dispatch/runtime coordination belong under `src/runtime/` instead.

#### Optional follow-up cleanup

These are lower priority than the remaining `index.ts` work:

- further split remaining auth/SSE/session internals out of `src/channels/web.ts` if churn resumes there
- extract additional shared helpers from executor-adjacent code only when duplication is proven by real follow-on work

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
- latest checkpoint extracts shared incoming-dispatch preparation into `src/runtime/incoming-dispatch.ts`
- current checkpoint extracts shared dashboard dispatch into `src/runtime/dashboard-dispatch.ts`
- current checkpoint extracts config-state helpers into `src/runtime/control-plane/config-state-helpers.ts`

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

The bootstrap path is now mostly split under `src/bootstrap/`: runtime creation, service wiring, channel startup, and shutdown sequencing are extracted. `src/runtime/incoming-dispatch.ts` now carries the shared channel pre-dispatch/routing-preparation path that used to sit inline in `main()`, and `src/runtime/dashboard-dispatch.ts` now carries the shared dashboard/runtime dispatch path that used to sit inline in the callback factory. The remaining `index.ts` work is helper cleanup and final orchestration thinning.

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

If this plan is resumed in a later session, start with `src/index.ts`.

Immediate next move:

1. inspect the remaining provider/config helper clusters in `src/index.ts`
2. decide the next clean ownership move under `src/runtime/` or `src/runtime/control-plane/`
3. add or tighten focused coverage for that slice if needed
4. extract mechanically, then run the mapped harness set

The `web.ts` and `executor.ts` tracks are no longer the critical path unless a regression or new feature exposes a gap there.
