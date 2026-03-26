# Automation Authoring Compiler

**Status:** Implemented current architecture

## Purpose

Guardian treats conversational automation creation as a compiler problem, not a freeform tool-calling problem.

The canonical path is:

```text
user request
  -> IntentGateway
  -> automation authoring compiler
  -> AutomationIR
  -> repair + validation
  -> draft clarification or ready compilation
  -> automation_save
  -> approval + verification
```

This exists so requests for automations become native Guardian automation objects instead of drifting into scripts, ad hoc files, or unrelated direct-action routes.

## Contract

The compiler targets the canonical automation control plane, not low-level product concepts.

Primary persistence contract:
- `automation_save`

Related control contract:
- `automation_list`
- `automation_set_enabled`
- `automation_run`
- `automation_delete`

The compiler decides which saved automation kind should be persisted:
- `workflow`
- `assistant_task`
- `standalone_task`

## Route Ownership

Top-level route selection is owned by `IntentGateway`.

The compiler runs when the request is routed as `automation_authoring`.

If the gateway is unavailable, Guardian retains a narrow fail-safe heuristic path so automation creation does not silently break. That fail-safe is not the primary route selector.

## Compiler Responsibilities

### 1. Build A Typed Intermediate Representation

The compiler turns the request into `AutomationIR`.

That intermediate form carries:
- identity
- requested behavior
- schedule intent
- tool and artifact constraints
- shape hints for deterministic vs assistant-style execution

### 2. Produce Drafts When Details Are Missing

Incomplete requests do not return `null` and do not fall into browser or generic tool handling.

They produce a draft with missing fields such as:
- goal
- schedule
- workflow steps

### 3. Choose The Saved Automation Kind

Decision rules:
- explicit fixed built-in step graph -> `workflow`
- open-ended runtime-adaptive work -> `assistant_task`
- one fixed tool target -> `standalone_task`

### 4. Enforce Hard Constraints

Compiler-visible constraints include:
- built-in-tools-only
- manual-only
- schedule requirements
- no-code-artifact expectations

These are execution constraints, not style suggestions.

### 5. Validate Save-Time Readiness

Before save, Guardian validates:
- schedule shape
- required inputs
- bounded workspace outputs
- tool availability
- policy blockers likely to prevent a successful run

If a blocker is fixable through bounded supported policy changes, Guardian can stage remediation and retry the save in the same session.

## Saved Automation Shapes

### Workflow

Saved step-based automation with:
- `mode: sequential | parallel`
- `tool`, `instruction`, and `delay` step support
- graph-backed runtime execution

### Assistant Task

Saved assistant automation with:
- target agent
- runtime prompt
- channel and delivery settings
- optional provider override
- manual-only or scheduled trigger

### Standalone Task

Saved one-tool automation with:
- target tool
- fixed args
- manual-only or scheduled trigger

## Update Semantics

When a new authoring request matches an existing saved automation, Guardian updates that automation through the same canonical save path instead of creating a duplicate.

Matching is based on normalized saved automation identity from the automation catalog.

## Approval Model

The compiler does not bypass runtime controls.

Save still flows through the normal tool execution and approval system, which preserves:
- principal binding
- audit
- policy checks
- verification
- bounded schedule authority

## Runtime Sequence

```text
user request
  -> IntentGateway
  -> automation authoring compiler
  -> draft clarification or validated compilation
  -> automation_save
  -> approval if required
  -> saved automation appears in the canonical catalog
```

## Why This Matters

This architecture prevents three classes of failure:
- automation requests drifting into script/code generation
- authoring requests falling into browser or generic tool routing
- duplicated UI/chat semantics for what should be one saved automation model
