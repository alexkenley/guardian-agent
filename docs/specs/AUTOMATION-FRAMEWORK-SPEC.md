# Automation Framework Spec

## Goal
Build a native automation framework for infrastructure operations (home labs, enterprise labs, building systems) without adopting a full external workflow engine.

Option 2 favors:
- A curated connector-pack model
- A deterministic playbook engine
- A visual studio surface that stays behind existing Guardian + auth controls

## Why Option 2
- Lower integration complexity than embedding n8n-style orchestration runtimes.
- Better security posture by default because all execution remains in GuardianAgent control planes.
- Easier policy alignment with existing tool approvals, allowlists, and audit chain.

## Core Model

### Tool Access
Automation steps use built-in tools by default. An optional access profile can add tighter boundaries for specific workflows.

### Scheduled Assistant Task
A scheduled assistant task is a recurring agent turn, not a playbook step. It stores:
- `target` agent id (or `default`)
- `prompt`
- cron schedule
- optional `runOnce` flag for a single-shot run that disables itself after the first execution
- optional `channel` / `deliver` routing for user-facing reports

Use this when the automation should decide what to inspect at runtime with the normal assistant stack: skills, memory, tool calling, and Guardian policy.

### Access Profile
An access profile (internally still stored as a connector pack) is a bounded integration profile:
- `id`, `name`, `enabled`
- `allowedCapabilities` (domain-level permissions)
- `allowedHosts`, `allowedPaths`, `allowedCommands` (sandbox boundaries)
- `authMode` (`none`, `api_key`, `oauth2`, `certificate`)
- `requireHumanApprovalForWrites`

Access profiles are declarative policy units, not arbitrary code bundles.

If a step uses `packId: ""` or `packId: "default"`, it runs as a built-in tool step with the normal Guardian policy path and no extra access-profile boundary.

### Playbook
A playbook is an ordered workflow that calls one or more connector actions.

Execution controls:
- `maxSteps`
- `maxParallelSteps`
- `defaultStepTimeoutMs`
- `requireSignedDefinitions`
- `requireDryRunOnFirstExecution`

### Studio
Operator-facing visual mode:
- `read_only` for observability-only environments
- `builder` for controlled authoring
- Optional privileged ticket requirement for mutating studio operations

## Security Model

### Mandatory Controls
1. Connector calls map to Guardian action checks (`read_file`, `write_file`, `http_request`, `execute_command`, etc.).
2. Existing tool approval model remains authoritative for mutating/external actions.
3. Creating or updating a scheduled task is the approval checkpoint for that automation definition. Later cron executions of the same saved task do not re-prompt for the identical action.
4. Access profile boundaries are explicit allowlists (hosts/paths/commands/capabilities) when a step opts into one.
5. Playbook step budgets enforce bounded execution and reduce runaway workflows.
6. Playbook metadata and results flow into existing audit + hash-chain persistence.

### Cryptographic and Audit Alignment
- Connector-triggered operations inherit tool/job argument hashing (`argsHash`).
- Policy/config changes continue to emit SHA-256 policy hash deltas (`policy_changed`).
- Audit persistence remains hash-chained JSONL.

## Configuration

`assistant.connectors`:

```yaml
assistant:
  connectors:
    enabled: false
    executionMode: plan_then_execute     # plan_then_execute | direct_execute
    maxConnectorCallsPerRun: 12
    packs: []
    playbooks:
      enabled: true
      maxSteps: 12
      maxParallelSteps: 3
      defaultStepTimeoutMs: 15000
      requireSignedDefinitions: true
      requireDryRunOnFirstExecution: true
    studio:
      enabled: true
      mode: builder                       # read_only | builder
      requirePrivilegedTicket: true
```

Validation guarantees:
- Pack IDs must be unique.
- `maxParallelSteps <= maxSteps`.
- Timeout floors and enum validation are enforced.

## Runtime Integration (Phased)

### Phase 1 (Implemented)
- Config schema + validation + redacted config visibility.
- Documentation and architecture decision record.

### Phase 2 (Implemented)
- `ConnectorPlaybookService` runtime module with bounded sequential/parallel execution.
- Playbook step execution mapped through `ToolExecutor` (existing Guardian + approval path).
- CLI commands: `/connectors ...`, `/playbooks ...`.

### Phase 3 (Implemented baseline)
- Web Connectors control plane (Network > Connectors tab, `#/network`) for settings, pack/playbook CRUD, and playbook runs.
- Privileged-ticket gating for connector/playbook mutations when `assistant.connectors.studio.requirePrivilegedTicket` is enabled.
- Signed-definition and dry-run-first enforcement in playbook runtime.

### Phase 4 (Implemented — unified Automations)
- Web `#/automations` page merges playbooks + scheduled tasks into a single "Automations" UI. Old `#/workflows` and `#/operations` routes redirect.
- Conversational automation creation: the assistant can create playbooks and schedule tasks via `workflow_upsert` and `task_create` tools, guided by system prompt instructions and tool examples.
- Scheduled assistant tasks are first-class in the runtime and UI for recurring briefings, monitoring reports, and other open-ended agent activities.
- Scheduled tasks can be marked `runOnce: true` for one-shot execution; the runtime disables them after the first run.
- When a playbook is upserted with a `schedule`, Guardian immediately syncs a linked scheduled task instead of waiting for a restart migration.
- Clone, example catalog (templates + presets), and merged run history in the unified page.
- The main web edit path is now intentionally simple for common changes; raw definition editing remains available in an advanced section for power users.
- Pipeline rows use a centered disclosure control so multi-step workflows are easier to spot and expand from the catalog view.
- Web labels use `Tool Access` / `Built-in tools` language for default steps. Access-profile names only appear when an operator deliberately assigns one.

## Out of Scope (Current Phase)
- Distributed multi-node workflow scheduler.
- Arbitrary user-supplied plugin code execution.
- Bypass paths outside Guardian Runtime chokepoints.
