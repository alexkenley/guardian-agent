# Policy as Code Spec

**Status:** Implemented foundation, not yet authoritative for all decision families
**Date:** 2026-03-20
**Proposal Origin:** [Policy as Code Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/POLICY-AS-CODE-PROPOSAL.md)
**Related Specs:** [Tools Control Plane Spec](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md), [Contextual Security Uplift Spec](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXTUAL-SECURITY-UPLIFT-SPEC.md), [Configuration Center Spec](/mnt/s/Development/GuardianAgent/docs/specs/CONFIG-CENTER-SPEC.md)

## Purpose

Document the policy engine that is actually shipped now.

This is an as-built/runtime-status spec. The proposal remains the architecture/rationale document for the broader migration to declarative policy. This spec captures the current engine, operator surfaces, and real runtime boundary.

## What Is Implemented

Guardian now ships a native policy engine foundation in `src/policy/`:

- rule types and schema versioning
- matcher primitives and path resolution
- rule compilation
- deterministic in-process evaluation
- rule-file loading from disk
- tool-request normalization helpers
- shadow-comparison support and mismatch accounting

Primary modules:

- `src/policy/types.ts`
- `src/policy/matcher.ts`
- `src/policy/compiler.ts`
- `src/policy/engine.ts`
- `src/policy/rules.ts`
- `src/policy/normalize-tool.ts`
- `src/policy/shadow.ts`

## Runtime Bootstrap

At startup, Guardian:

- creates a policy engine instance
- resolves `guardian.policy` config
- loads JSON rule files from `guardian.policy.rulesPath` (default `policies/`)
- records policy-engine startup in the audit log
- exposes runtime status, config update, and reload callbacks to the dashboard/web channel

Current config fields:

- `guardian.policy.enabled`
- `guardian.policy.mode`
- `guardian.policy.families`
- `guardian.policy.rulesPath`
- `guardian.policy.mismatchLogLimit`

Current family model:

- `tool`
- `admin`
- `guardian`
- `event`

Current mode model:

- `off`
- `shadow`
- `enforce`

## Operator Surfaces

Current web/API surfaces:

- `GET /api/policy/status`
- `POST /api/policy/config`
- `POST /api/policy/reload`

Current UI surface:

- Configuration > Settings tab policy-engine controls

Returned runtime status includes:

- enabled/mode
- per-family modes
- rules path
- loaded rule count
- mismatch log limit
- shadow stats when available

## Shipped Rule Bundles

Current shipped policy files include:

- [tools.json](/mnt/s/Development/GuardianAgent/policies/base/tools.json)
- [browser.json](/mnt/s/Development/GuardianAgent/policies/base/browser.json)

These define declarative rules for intended tool and browser behavior, including:

- read-only tool allow rules
- mutating/external-post approval rules
- shell operator handling
- browser high-risk tool handling

## Audit And Telemetry

Current audit events emitted by the policy subsystem include:

- `policy_engine_started`
- `policy_mode_changed`
- `policy_rules_reloaded`
- `policy_shadow_mismatch`

The shadow evaluator also maintains in-memory mismatch counters by class.

## Current Runtime Boundary

The important limitation is that the policy engine foundation is present, but it is **not yet the sole authoritative decision layer** for the main runtime.

Today, the shipped runtime still relies primarily on imperative decision paths such as:

- `ToolExecutor.decide()`
- contextual trust checks in `ToolExecutor`
- approval logic in the current tool/control-plane path
- browser containment logic in `BrowserSessionBroker`

That means:

- policy-engine config, rule loading, reload, and status are implemented
- the declarative engine exists and is test-covered
- the rule bundle is real and shipped
- but the main tool family is still not fully migrated to policy-engine-first enforcement

In practical terms, the current state is:

- **implemented foundation**
- **operator-visible**
- **reloadable**
- **audited**
- **not yet the universal enforcement source of truth**

Shadow-mode statistics are also only meaningful for families that are actually wired into compare paths. The engine is ready for that integration, but the migration is still incomplete.

## Relationship To Other Specs

Current authoritative behavior is split:

- [TOOLS-CONTROL-PLANE-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md) documents the shipped tool approval and policy behavior
- [CONTEXTUAL-SECURITY-UPLIFT-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CONTEXTUAL-SECURITY-UPLIFT-SPEC.md) documents current trust-aware enforcement
- this spec documents the declarative engine subsystem that now exists alongside them

## Files

Primary implementation files:

- `src/policy/*.ts`
- `src/index.ts`
- `src/channels/web.ts`
- `src/config/types.ts`
- `policies/base/tools.json`
- `policies/base/browser.json`
- `web/public/js/pages/config.js`

## Verification

Current automated coverage:

- `src/policy/compiler.test.ts`
- `src/policy/engine.test.ts`
- `src/policy/matcher.test.ts`
- `src/policy/normalize-tool.test.ts`
- `src/policy/rules.test.ts`
- `src/policy/shadow.test.ts`

This verifies the shipped policy engine foundation itself. Full end-to-end replacement of imperative enforcement remains future work documented in the proposal.
