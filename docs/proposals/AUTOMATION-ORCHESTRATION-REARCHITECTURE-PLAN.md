# Automation And Orchestration Re-Architecture Plan

**Date:** 2026-03-24  
**Status:** In Progress  
**Owner:** GuardianAgent runtime

## Goal

Complete Guardian’s move to an automation-first architecture built around:

- authoritative top-level intent routing
- one canonical automation control plane
- one Automations UI surface
- backend-owned catalog and run history shaping
- durable execution state for workflows and automations

## Current Architecture Baseline

The foundations are already in place:

### Completed Foundations

- `IntentGateway` owns the normal top-level direct-action route decision.
- Heuristic parsers are retained only as fail-safe behavior when the gateway is unavailable.
- Conversational automation authoring routes into a typed automation compiler instead of generic tool drift.
- Saved automation control routes through the canonical automation tools:
  - `automation_list`
  - `automation_save`
  - `automation_set_enabled`
  - `automation_run`
  - `automation_delete`
- The Automations page is the canonical operator surface.
- Catalog rows, save flows, run/toggle/delete actions, and run-history shaping are backend-owned.
- Built-in examples are treated as starter examples in the same catalog, not as a separate install system.
- Direct runtime and brokered worker paths share the same automation-routing model.

### What The Current Runtime Still Adapts

The current backend contract is unified at the product surface, but some lower-level execution adapters still bridge:
- deterministic workflow storage/runtime
- scheduled task storage/runtime

That adapter layer is acceptable for now, but it is still the main remaining cleanup area.

## Architecture End State

### 1. Intent Gateway

One authoritative route selector for direct-action requests.

Relevant routes:
- `automation_authoring`
- `automation_control`
- `ui_control`
- `browser_task`
- `workspace_task`
- `email_task`
- `search_task`
- `filesystem_task`
- `coding_task`
- `security_task`
- `general_assistant`

Requirements:
- structured output
- no tool execution during classification
- explicit unavailable/fail-safe handling

### 2. Canonical Automation Control Plane

One automation contract for model-facing and UI-facing operations:

- `automation_list`
- `automation_save`
- `automation_set_enabled`
- `automation_run`
- `automation_delete`

This contract is the product-facing truth even while the runtime still uses internal execution adapters underneath.

### 3. Typed Automation Authoring

Conversational authoring must continue to produce:
- typed drafts when details are missing
- validated compilations when definitions are ready
- saved `workflow`, `assistant_task`, or `standalone_task` automations through `automation_save`

Authoring must not fall through to competing browser or generic tool paths.

### 4. Backend-Owned Operator Surface

The web UI should remain a control-plane client rather than a reconstruction layer.

It should consume backend-owned:
- catalog entries
- starter-example entries
- run history
- timeline views
- mutation responses

### 5. Durable Run Model

Longer-term cleanup still targets one automation run model with explicit runtime states such as:
- `ready`
- `running`
- `awaiting_approval`
- `paused`
- `completed`
- `failed`
- `cancelled`

## Remaining Work

### Phase 1: Intent Gateway

**Status:** Complete for the current direct-action path

- gateway classification is live
- direct routes use gateway decisions first
- fail-safe heuristics remain only when the gateway is unavailable

### Phase 2: Canonical Automation Authoring And Control

**Status:** Complete for current product behavior

- automation authoring compiles into the canonical automation save contract
- saved automation control uses the canonical automation catalog and control tools
- draft clarification stays inside automation authoring

### Phase 3: Backend-Owned UI Contract

**Status:** Complete for the Automations page core flows

- catalog shaping is backend-owned
- run/toggle/delete are backend-owned
- save flows are backend-owned
- built-in starter examples are backend-owned
- run-history shaping is backend-owned

### Phase 4: Deeper Domain Unification

**Status:** In progress

Remaining work:
- reduce the internal workflow/task adapter split
- continue normalizing automation definition and run semantics behind the runtime service
- keep low-level workflow/task behavior from leaking back into public naming or control contracts

### Phase 5: Durable Approval / Takeover / Timeline State

**Status:** Partial foundation only

Remaining work:
- standardize approval and pause/resume state across all automation kinds
- expose richer takeover/resume semantics where needed
- keep replay safety for deterministic resume paths

### Phase 6: Browser Operator Integration

**Status:** Future work

Remaining work:
- promote browser automation evidence, sessions, and artifacts into the same durable run model
- align browser-task execution more tightly with automation-run artifacts and timeline views

## Verification Strategy

- focused Vitest coverage for routing, authoring, save, control, and UI contracts
- fake-provider harnesses for deterministic regression
- real-Ollama smoke lanes in WSL for live model validation
- targeted manual QA for:
  - create
  - inspect
  - run
  - enable/disable
  - delete
  - starter example copy flows

## Completion Criteria

This proposal is complete when:
- the intent gateway remains the normal authoritative route selector
- the public automation surface is fully expressed through canonical automation tools
- the Automations page is the only automation definition/control surface
- backend naming and docs no longer leak obsolete workflow/task product concepts
- remaining low-level workflow/task differences are internal implementation details rather than public architecture
