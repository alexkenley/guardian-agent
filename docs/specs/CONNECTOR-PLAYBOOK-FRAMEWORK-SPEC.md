# Connector + Playbook Framework Spec (Option 2)

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

### Connector Pack
A connector pack is a bounded integration profile:
- `id`, `name`, `enabled`
- `allowedCapabilities` (domain-level permissions)
- `allowedHosts`, `allowedPaths`, `allowedCommands` (sandbox boundaries)
- `authMode` (`none`, `api_key`, `oauth2`, `certificate`)
- `requireHumanApprovalForWrites`

Connector packs are declarative policy units, not arbitrary code bundles.

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
3. Connector pack boundaries are explicit allowlists (hosts/paths/commands/capabilities).
4. Playbook step budgets enforce bounded execution and reduce runaway workflows.
5. Playbook metadata and results flow into existing audit + hash-chain persistence.

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
- Connectors enabled requires at least one enabled pack.
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
- Web Connectors control plane (`#/connectors`) for settings, pack/playbook CRUD, and playbook runs.
- Privileged-ticket gating for connector/playbook mutations when `assistant.connectors.studio.requirePrivilegedTicket` is enabled.
- Signed-definition and dry-run-first enforcement in playbook runtime.

## Out of Scope (Current Phase)
- Distributed multi-node workflow scheduler.
- Arbitrary user-supplied plugin code execution.
- Bypass paths outside Guardian Runtime chokepoints.
