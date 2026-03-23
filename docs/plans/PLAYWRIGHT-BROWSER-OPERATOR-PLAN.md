# Playwright Browser Operator Plan

## Context

Guardian's current browser mutation path is unreliable for click and type actions because it still depends on generic chat tool-calling plus free-form element targeting.

Current pain points:

- `browser_interact` mixes two different jobs: state discovery and mutation.
- Read discovery may come from Lightpanda while mutation runs through Playwright.
- Mutating actions still accept free-form `element` strings instead of stable page-local ids.
- A lot of recent work has gone into approval-copy recovery rather than making the browser action path deterministic.

The core lesson from the UI-TARS comparison is not "switch to Puppeteer". The useful part is the architecture:

- dedicated browser state
- constrained browser action schema
- stable element ids/indexes
- same-session execution against the state that produced those ids

## Goals

- Make click, type, and select deterministic on the Playwright lane.
- Stop relying on free-form element labels for mutating browser actions.
- Keep approvals tied to real tool execution, not fallback prose.
- Preserve Lightpanda for read-only extraction where it is useful.
- Add end-to-end coverage for the exact failure cases that keep regressing.

## Non-Goals

- Replacing Playwright with Puppeteer.
- Broad regex routing as the primary browser-control fix.
- Removing the approval model.
- Rewriting the whole browser stack in one pass.

## Cleanup

Completed immediately:

- Removed scratch file `parse-test9.mjs`.

Do not continue with these troubleshooting patterns:

- more free-form selector fallback experiments in repo-root scratch files
- more approval-copy workarounds for browser-click failures
- more Lightpanda-to-Playwright mutation bridging via loose text labels

## Implementation Direction

### Phase 1: Deterministic Playwright Mutation Lane

Introduce a dedicated state/action split for interactive browser work.

New wrapper tools:

- `browser_state`
  - read-only
  - optional `url`
  - always resolves through the Playwright interactive lane
  - captures the current page title, url, snapshot text, and interactive targets
  - returns a `stateId` plus normalized targets like `{ ref, type, text }`

- `browser_act`
  - mutating
  - requires `stateId`
  - accepts only constrained actions such as `click`, `type`, and `select`
  - requires stable target ids such as `ref`
  - executes against the same session/backend that produced the state

Rules:

- All mutating browser actions must use Playwright-derived state.
- Lightpanda remains read-only only.
- A `browser_act` call against stale state must fail with an explicit stale-state error and require a fresh `browser_state` call.

### Phase 2: Compatibility Layer

Keep current wrapper names temporarily, but narrow them:

- keep `browser_read`, `browser_links`, and `browser_extract` as-is
- keep `browser_navigate` for simple explicit navigation
- deprecate free-form mutation through `browser_interact`
- either:
  - restrict `browser_interact` to `action=list`, or
  - make mutating `browser_interact` internally require `ref` and translate to `browser_act`

This avoids breaking every existing caller at once while removing the unreliable path.

### Phase 3: Browser Operator Loop

If generic tool-calling is still not reliable enough with local models, add a dedicated browser operator loop for browser tasks.

That loop should:

- classify browser tasks before normal chat execution
- fetch `browser_state`
- ask the model for structured browser actions only
- execute one action batch at a time
- refresh state after page changes
- stop only on `done`, `pending_approval`, or hard failure

Structured action schema should look more like:

- `click_ref`
- `type_ref`
- `select_ref`
- `refresh_state`
- `done`

This is the UI-TARS-style architectural move that matters.

## Suggested File Changes

Phase 1 target files:

- `src/tools/browser-hybrid.ts`
  - split interactive state capture from mutation
  - persist Playwright-derived `stateId` and target refs

- `src/tools/executor.ts`
  - register `browser_state` and `browser_act`
  - approval-gate only mutating `browser_act`
  - update tool-context text to prefer state/action flow

- `src/prompts/guardian-core.ts`
  - update browser instructions to prefer `browser_state` then `browser_act`
  - stop encouraging free-form `browser_interact` mutation

- `src/runtime/automation-authoring.ts`
  - compile browser mutation steps to the new state/action pattern, or block unsupported free-form browser mutation until refs are explicit

- `src/runtime/automation-prerouter.ts`
  - same normalization as automation authoring

- `src/reference-guide.ts`
  - document the new browser workflow for users

Possible Phase 3 additions:

- `src/runtime/browser-operator.ts`
- `src/runtime/browser-operator.test.ts`
- `src/runtime/browser-operator-schema.ts`

## Test Plan

Unit tests:

- `src/tools/browser-hybrid.test.ts`
  - `browser_state` returns stable refs from Playwright snapshot
  - `browser_act click` uses `ref`, not free-form label matching
  - stale `stateId` returns explicit refresh-required error

- `src/tools/executor.test.ts`
  - `browser_state` is read-only and not approval-gated
  - `browser_act` is approval-gated outside autonomous mode
  - Lightpanda outputs are never used as mutation targets

- worker/runtime tests
  - browser approval metadata comes only from real tool execution
  - no phantom approval fallback text for failed browser parsing

Harness coverage:

- add a browser smoke case for:
  - `Go to https://example.com and click the "More information..." link.`
- add a form smoke case for:
  - `Open https://httpbin.org/forms/post and type "qa smoke test" into the customer name field.`

Run after implementation:

- focused Vitest files for changed modules
- `npm run check`
- `npm test`
- relevant browser/coding harnesses:
  - `node scripts/test-coding-assistant.mjs`
  - any browser-specific harness updated for the new tool flow

## Rollout Order

1. Add `browser_state` and `browser_act`.
2. Convert prompt guidance and executor policy to prefer the new flow.
3. Keep compatibility shim for old `browser_interact` callers.
4. Add end-to-end harness cases for example.com click and httpbin typing.
5. Remove mutating free-form `browser_interact` support after the new lane is proven.
6. Only then decide whether the full dedicated browser operator loop is still needed.

## Success Criteria

- Explicit browser click prompts create either:
  - a real pending approval for `browser_act`, or
  - a real successful click result
- no generic approval prose without real approval metadata
- no label-based Lightpanda-to-Playwright mutation bridging
- reproducible harness coverage for the two known regression prompts
