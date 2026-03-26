# Automation Framework Spec

**Status:** Implemented current architecture

## Goal

Guardian ships a native automation framework with one product surface, one control-plane contract, and one operator-facing catalog. Users create, edit, schedule, run, and inspect automations through the same system whether the automation is a deterministic step graph, an assistant automation, or a single-tool task.

## Product Model

### Automation Definition

Every saved automation has:
- `id`
- `name`
- `description`
- `enabled`
- `kind`
- optional trigger metadata
- optional output-routing metadata

The product surface does not split definitions into separate workflow and task pages. The Automations page is the canonical surface.

### Automation Kinds

Guardian supports three saved automation kinds:

1. `workflow`
- Step-based automation with explicit execution order.
- Supports `sequential` and `parallel` modes.
- Step types:
  - `tool`
  - `instruction`
  - `delay`

2. `assistant_task`
- An assistant automation that dispatches a real assistant turn.
- Stores the target agent, runtime prompt, delivery channel, and optional provider override.
- Can be manual-only or scheduled.

3. `standalone_task`
- A saved one-tool automation.
- Stores the tool target plus fixed arguments.
- Can be manual-only or scheduled.

### Trigger Modes

Triggering is part of the automation definition, not a separate product type.

- Manual-only automations are represented with an automation-scoped event trigger such as `automation:manual:<id>`.
- Scheduled automations use cron.
- Scheduled automations can also be marked `runOnce: true`.

### Built-In Starter Examples

Built-in examples appear in the same Automations catalog as saved automations.

- They are first-class catalog entries.
- They are not directly mutated or run as if they were already saved definitions.
- Using one creates a saved copy that the operator can edit, schedule, enable, run, or delete.

## Canonical Control Plane

Guardian’s public automation contract is:

- `automation_list`
- `automation_output_search`
- `automation_output_read`
- `automation_save`
- `automation_set_enabled`
- `automation_run`
- `automation_delete`

These are the model-facing and UI-facing primitives for automation definition and control.

Saved automation runs can also participate in historical analysis:

- step-based, assistant, and standalone saved automations default to storing historical output references unless the operator turns that off
- Guardian keeps a compact searchable memory reference plus a private full-output record for the run
- later deep analysis uses `automation_output_search` and `automation_output_read`
- ad hoc one-off tool calls are excluded from this historical automation-output path

Current limitation:
- the persistence and dereference path is implemented, but richer synthesis over large stored runs is still future work. Today the assistant can find and read prior saved automation output reliably; deeper multi-step summarization and higher-quality result analysis should continue to improve without changing the storage contract.

Low-level workflow and scheduled-task services still exist as internal runtime adapters, but they are not the intended product contract.

## Authoring Path

### Intent Gateway

Top-level route selection is owned by `IntentGateway`.

Relevant automation routes:
- `automation_authoring`
- `automation_control`
- `ui_control` for Automations-page actions

The gateway is authoritative in the normal path. Heuristic parsing is only retained as a fail-safe when the gateway is unavailable.

### Authoring Compiler

Automation authoring uses a typed intermediate representation before persistence.

Flow:

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

The compiler chooses the saved automation kind:

- fixed built-in step graph -> `workflow`
- open-ended assistant work -> `assistant_task`
- one fixed tool target -> `standalone_task`

Incomplete requests return a draft with missing fields instead of falling through to browser or generic tool routing.

### Save-Time Validation

Before persistence, Guardian validates:
- schedule shape
- workflow/body consistency
- required inputs
- supported tool usage
- bounded workspace output handling
- predicted policy blockers

Fixable blockers can become approval-backed remediation actions and then retry the save in the same session.

## Runtime Model

### Deterministic Workflows

Step-based automations are compiled into graph-backed runs with:
- stable `runId`
- node-level orchestration events
- checkpointed state transitions
- persisted bounded resume context
- approval-safe deterministic resume

### Assistant And Standalone Task Automations

Task-backed automations run through the scheduled-task runtime.

- Manual-only runs use the automation-scoped event trigger.
- Scheduled runs use cron.
- Execution enforces bounded authority, run budgeting, and overlap protection.

### History And Timeline

The runtime exposes:
- unified automation catalog entries
- unified automation run history
- execution timeline data

The Automations page consumes backend-owned views instead of reconstructing workflow/task state client-side.

## Security And Approval Model

Automation creation and mutation remain approval-gated.

Save-time approval covers:
- the saved automation definition
- bounded expected in-scope actions
- bounded workspace-local outputs when those outputs are part of the saved definition

Later runs are allowed only while:
- saved scope still matches
- approval authority has not expired
- budgets remain in bounds
- the automation does not attempt higher-risk behavior outside the approved definition

Guardian continues to enforce existing sandbox, SSRF, policy, audit, and output-routing controls at execution time.

## Web UI Contract

The web UI is a control-plane client.

The Automations page is responsible for:
- catalog browsing
- create/edit
- starter example copy flows
- enable/disable
- run now
- delete
- raw definition editing for saved step-based automations
- run history and timeline visibility

There is no separate workflow page in the intended product architecture.

## Guidance

- Use `workflow` when the automation should execute a fixed sequence of built-in steps.
- Use `assistant_task` when the automation must decide what to inspect or produce at runtime.
- Use `standalone_task` when one saved tool invocation is enough.
- Use starter examples as templates for user-owned saved automations, not as immutable runtime objects.
