# Failover & Circuit Breaker Design

**Status:** Implemented current architecture  

## Goal
Provide automatic LLM provider failover with circuit breaker protection so that transient provider failures don't take down the entire system.

## Problem
No failover when an LLM provider fails. A single provider outage makes the entire agent system unresponsive. No circuit breaker to prevent cascading failures from repeated retries against a dead endpoint.

## Scope
- Runtime modules:
  - `src/llm/circuit-breaker.ts` — circuit breaker state machine
  - `src/llm/failover-provider.ts` — multi-provider wrapper with failover logic
- Provider creation: `src/llm/provider.ts` — `createFailoverProvider()`
- Runtime wiring: `src/runtime/runtime.ts` — failover initialization
- Dashboard: Circuit state column in LLM Providers table

## Circuit Breaker

### States
```
closed ──(failures >= threshold)──▶ open
  ▲                                   │
  │                            (resetTimeout elapsed)
  │                                   ▼
  └───(success count met)─── half_open
```

- **Closed**: Normal operation. Requests pass through. Failures are counted.
- **Open**: Requests are rejected immediately. No calls to the provider. After `resetTimeoutMs`, transitions to half_open.
- **Half-open**: A limited number of requests are allowed. If they succeed, transitions back to closed. If they fail, transitions back to open.

### Configuration
```yaml
failover:
  enabled: true
  failureThreshold: 3     # failures before opening circuit
  resetTimeoutMs: 30000   # ms before attempting half_open
```

### Error Classification
Errors are classified to determine failover behavior:

| Class | Examples | Failover? | Circuit Impact |
|-------|----------|-----------|----------------|
| `auth` | 401, 403, "unauthorized" | No | Opens immediately |
| `quota` | 429, "rate limit", "quota" | Yes | Counts toward threshold |
| `transient` | 5xx, ECONNREFUSED, timeout | Yes | Counts toward threshold |
| `timeout` | AbortError, request timeout | Yes | Counts toward threshold |
| `permanent` | 4xx (not auth/quota), unknown | No | Counts toward threshold |

Auth and permanent errors don't trigger failover — they indicate provider-specific issues that won't resolve by trying another provider.

## Failover Provider

### Priority-Based Ordering
Providers are sorted by `priority` field (lower = higher priority). The first available provider with a closed or half-open circuit is tried first.

```yaml
llm:
  ollama:
    provider: ollama
    model: gpt-oss:120b
    priority: 1          # primary
  claude:
    provider: anthropic
    model: claude-sonnet-4-20250514
    priority: 2          # secondary fallback
```

### Chat / Stream Failover
1. Try each provider in priority order
2. Skip providers with open circuits
3. On transient/quota/timeout errors, try the next provider
4. On auth/permanent errors, stop (provider-specific issue)
5. If all providers exhausted, throw the last error

### Model Listing
`listModels()` aggregates models from all available (non-open-circuit) providers.

### Monitoring
`getCircuitStates()` returns the state of all breakers for dashboard visibility:

```typescript
interface ProviderCircuitState {
  name: string;
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  lastFailureTime: number;
}
```

## Dashboard UX
The LLM Providers table on the Dashboard page includes a "Circuit" column with color-coded badges:
- `closed` — green
- `open` — red
- `half_open` — amber

## Verification
1. Mock primary provider failure, confirm secondary receives the call
2. Verify circuit breaker opens after threshold failures
3. Verify recovery: after resetTimeout, half_open allows a test request
4. Verify auth errors don't trigger failover (provider-specific)
5. Verify all-exhausted scenario throws the last error
