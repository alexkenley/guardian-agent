# Trust Presets Spec

## Goal
Provide predefined security postures that configure capabilities, rate limits, resource limits, and tool policies in a single setting — so operators don't need to tune each field individually.

## Problem
Security configuration requires manual field-by-field setup across guardian rate limits, agent capabilities, resource limits, and tool approval modes. New users don't know sensible defaults for their use case.

## Scope
- Runtime module: `src/guardian/trust-presets.ts`
- Config integration: `src/config/loader.ts` (apply preset during config load)
- Config types: `src/config/types.ts` (`trustPreset` field on `GuardianConfig`)
- Web Config page: Trust Preset selector panel

## Presets

| Preset | Capabilities | Rate Limit | Tool Policy | Use Case |
|--------|-------------|------------|-------------|----------|
| **locked** | `read_files` | 10/min, 100/hr | `approve_each` | Read-only audit, maximum restriction |
| **safe** | `read_files`, `read_email` | 20/min, 300/hr | `approve_by_policy` | Read-only with email access |
| **balanced** | read/write/exec/git/email | 30/min, 500/hr | `approve_by_policy` | General assistant use |
| **power** | All capabilities | 60/min, 2000/hr | `autonomous` | Full autonomous operation |

### Detailed Preset Values

Each preset specifies:
- **capabilities** — Capability grants applied to agents without explicit capabilities
- **guardian.rateLimit** — Rate limiter configuration (maxPerMinute, maxPerHour, burstAllowed)
- **resourceLimits** — Per-agent resource limits (invocation budget, token rate, concurrency, queue depth)
- **toolPolicyMode** — Tool approval strategy

### Resource Limits by Preset

| Preset | Invocation Budget | Tokens/Min | Concurrent Tools | Queue Depth |
|--------|------------------|------------|-------------------|-------------|
| locked | 15s | 5,000 | 1 | 5 |
| safe | 30s | 10,000 | 2 | 10 |
| balanced | 60s | 20,000 | 3 | 20 |
| power | 120s | 50,000 | 5 | 50 |

## Configuration

```yaml
guardian:
  trustPreset: balanced   # locked | safe | balanced | power
  rateLimit:
    maxPerMinute: 50      # explicit value overrides preset
```

## Priority Order
Values are applied with this priority (highest wins):

1. **User's explicit config** — values set in `config.yaml`
2. **Trust preset** — values from the selected preset
3. **DEFAULT_CONFIG** — built-in defaults

This means: selecting `locked` sets maxPerMinute to 10, but if the user also sets `rateLimit.maxPerMinute: 50`, their explicit value wins.

## Implementation

### `applyTrustPreset(presetName, config)`
- Applies preset values over the config (preset wins over config)
- Sets tool policy mode from preset
- Assigns preset capabilities to agents that don't have explicit ones
- Agents with explicit capabilities keep them

### Config Loader Integration
In `loadConfigFromFile()`:
1. Merge DEFAULT_CONFIG with user YAML
2. If `trustPreset` is set, apply preset (preset overrides merged config)
3. Re-apply user's explicit YAML overrides (user wins over preset)

### Auto-Registered Agent Integration
The bootstrap (`src/index.ts`) resolves agent capabilities dynamically from the configured trust preset. All auto-registered agents (local, external, default) receive capabilities from the preset rather than hardcoded lists:

```typescript
const presetName = config.guardian?.trustPreset as TrustPresetName | undefined;
const agentCapabilities: Capability[] = presetName && TRUST_PRESETS[presetName]
  ? [...TRUST_PRESETS[presetName].capabilities]
  : DEFAULT_AGENT_CAPABILITIES;
```

This means the user's trust preset selection directly controls what auto-registered agents can do. For example, selecting `locked` restricts all agents to `read_files` only, while `power` grants all capabilities including `network_access`. When no preset is configured, a sensible default set is used (`read_files`, `write_files`, `execute_commands`, `network_access`, `read_email`, `draft_email`, `send_email`).

## Web UX
The Config page includes a "Trust Preset" panel with a selector for locked/safe/balanced/power. Each option shows a brief description of the security posture. Selecting a preset applies it to the runtime config.

## Verification
1. Set `trustPreset: locked` with no explicit rateLimit — verify maxPerMinute is 10
2. Set `trustPreset: locked` with explicit `maxPerMinute: 50` — verify 50 wins
3. Verify agents without capabilities get preset capabilities
4. Verify agents with explicit capabilities keep them
5. Verify progressive escalation: locked < safe < balanced < power in capabilities and rate limits
