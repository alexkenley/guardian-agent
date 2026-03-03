# Orchestration Agents Specification

**Status:** Implemented
**File:** `src/agent/orchestration.ts`
**Tests:** `src/agent/orchestration.test.ts`
**Depends on:** SharedState (`src/runtime/shared-state.ts`), Runtime dispatch

---

## Overview

Structured orchestration agents enable declarative multi-agent composition within GuardianAgent's security model. Inspired by Google ADK's SequentialAgent/ParallelAgent/LoopAgent, but with a critical difference: **all sub-agent invocations pass through the full Guardian admission pipeline**.

These are not lightweight wrappers — each sub-agent call goes through input sanitization, rate limiting, capability checking, secret scanning, output scanning, and budget enforcement. Security is preserved by construction.

### Agents

| Agent | Pattern | Use Case |
|-------|---------|----------|
| `SequentialAgent` | A → B → C (pipeline) | Multi-step workflows: analyze → transform → validate |
| `ParallelAgent` | A ∥ B ∥ C (fan-out) | Independent tasks: multi-source research, parallel analysis |
| `LoopAgent` | A → A → A (iteration) | Refinement loops: draft → review → revise until satisfied |

---

## Architecture

```
User Message
    │
    ▼
┌──────────────────────┐
│  Orchestration Agent  │ (SequentialAgent / ParallelAgent / LoopAgent)
│  extends BaseAgent    │
│                       │
│  Receives:            │
│  • ctx.dispatch()     │──── Runtime.dispatchMessage() ────┐
│  • SharedState        │                                    │
└──────────┬───────────┘                                    │
           │                                                 │
           │  For each sub-agent:                            │
           ▼                                                 ▼
┌──────────────────────┐                    ┌──────────────────────┐
│  ctx.dispatch(agentId,│                    │  Guardian Pipeline   │
│     message)          │──────────────────→│  (full admission)    │
│                       │                    │                      │
│  Returns:             │                    │  InputSanitizer →    │
│  AgentResponse        │←───────────────── │  RateLimiter →       │
│                       │                    │  CapabilityCtrl →    │
└──────────────────────┘                    │  SecretScan →        │
                                            │  DeniedPath →        │
                                            │  ShellCmd            │
                                            │                      │
                                            │  + Output scanning   │
                                            └──────────────────────┘
```

### Key Invariant

Orchestration agents receive `ctx.dispatch()`, which is a **guarded wrapper** around `Runtime.dispatchMessage()`. They never receive a reference to the Runtime itself. This means:

1. Every sub-agent call passes through Layer 1 (Guardian admission)
2. Every sub-agent response passes through Layer 2 (Output scanning)
3. Sub-agent budget/token/concurrent limits are enforced per-call
4. The orchestrating agent's own limits apply to its outer invocation
5. Rate limiting applies per sub-agent independently

---

## SequentialAgent

### Purpose

Runs sub-agents in a defined order, passing the output of each step as input to the next. Returns the final step's response.

### Configuration

```typescript
const pipeline = new SequentialAgent('pipeline-1', 'Analysis Pipeline', {
  steps: [
    { agentId: 'researcher',  outputKey: 'research' },
    { agentId: 'analyzer',    inputKey: 'research', outputKey: 'analysis' },
    { agentId: 'summarizer',  inputKey: 'analysis', outputKey: 'summary' },
  ],
  stopOnError: true, // default: true
});
```

### Step Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Target sub-agent ID |
| `inputKey` | string | No | SharedState key to read as input content |
| `outputKey` | string | No | SharedState key to write response content. Defaults to `agentId` |

### Execution Flow

1. Create a `SharedState` instance for this invocation
2. Seed `state.set('input', message.content)` with the original user message
3. For each step:
   a. Read input from `step.inputKey` in state (or use original message)
   b. Call `ctx.dispatch(step.agentId, modifiedMessage)`
   c. Write response content to `step.outputKey` in state
4. On error (if `stopOnError`): return immediately with error details
5. On error (if `!stopOnError`): record error in state, continue to next step
6. After all steps: call `state.clearTemp()`, return last step's response

### Response Format

```typescript
{
  content: "Final step's response content",
  metadata: {
    orchestration: 'sequential',
    completedSteps: 3,
    totalSteps: 3,
    state: { research: '...', analysis: '...', summary: '...' }
  }
}
```

### Error Response (stopOnError)

```typescript
{
  content: "[Pipeline stopped at step 'analyzer': Connection timeout]",
  metadata: {
    orchestration: 'sequential',
    stoppedAt: 'analyzer',
    completedSteps: 1,
    totalSteps: 3,
    state: { research: '...', analyzer: '[Error: Connection timeout]' }
  }
}
```

---

## ParallelAgent

### Purpose

Runs sub-agents concurrently and combines their results. Useful for independent tasks that don't depend on each other.

### Configuration

```typescript
const fanout = new ParallelAgent('fanout-1', 'Multi-Source Research', {
  steps: [
    { agentId: 'web-searcher',   outputKey: 'web_results' },
    { agentId: 'doc-searcher',   outputKey: 'doc_results' },
    { agentId: 'code-searcher',  outputKey: 'code_results' },
  ],
  maxConcurrency: 2, // default: 0 (unlimited)
});
```

### Execution Flow

1. Create a `SharedState` instance for this invocation
2. Seed state with original message
3. Launch all steps concurrently (respecting `maxConcurrency` if set)
4. Each step: dispatch to sub-agent, write result to state
5. Collect all results (successes and failures)
6. Combine into a single response with per-agent sections

### Concurrency Pool

When `maxConcurrency > 0`, a worker pool pattern limits parallelism:

```
maxConcurrency: 2, steps: [A, B, C, D]

Time 0: [A running] [B running] [C waiting] [D waiting]
Time 1: [A done]    [B running] [C running] [D waiting]
Time 2: [A done]    [B done]    [C running] [D running]
Time 3: [A done]    [B done]    [C done]    [D done]
```

### Response Format

```typescript
{
  content: "[web-searcher]: Found 5 relevant articles...\n\n[doc-searcher]: Located 3 matching docs...\n\n[code-searcher]: Error — Agent not found",
  metadata: {
    orchestration: 'parallel',
    totalSteps: 3,
    succeeded: 2,
    failed: 1,
    state: { web_results: '...', doc_results: '...', code_results: '[Error: ...]' }
  }
}
```

---

## LoopAgent

### Purpose

Runs a single sub-agent repeatedly until a condition is met or the iteration cap is reached. Feeds each iteration's output as the next iteration's input by default.

### Configuration

```typescript
const refiner = new LoopAgent('refiner-1', 'Draft Refiner', {
  agentId: 'editor',
  outputKey: 'draft',
  maxIterations: 5, // default: 10 (mandatory cap)
  condition: (iteration, lastResponse, state) => {
    if (!lastResponse) return true; // first iteration always runs
    // Stop when the editor says "APPROVED"
    return !lastResponse.content.includes('APPROVED');
  },
});
```

### Loop Condition

| Parameter | Type | Description |
|-----------|------|-------------|
| `iteration` | number | Current iteration index (0-based) |
| `lastResponse` | AgentResponse \| undefined | Previous iteration's response (undefined for first) |
| `state` | SharedState | Current shared state (mutable) |

**Default condition:** Continue while:
- Iteration < maxIterations
- Last response content is non-empty
- Last response doesn't start with `[Error`

### Execution Flow

1. Create `SharedState`, seed with original message
2. While `iteration < maxIterations` AND `condition()` returns true:
   a. Determine input: `inputKey` from state, or previous response, or original message
   b. Dispatch to target agent
   c. Write response to `outputKey` in state
   d. Set `temp:iteration` in state
   e. Increment iteration counter
3. On error: return immediately with error details
4. After loop: `clearTemp()`, return last response

### Response Format

```typescript
{
  content: "Final refined draft content...",
  metadata: {
    orchestration: 'loop',
    iterations: 3,
    maxIterations: 5,
    state: { draft: '...' }
  }
}
```

---

## Security Analysis

### Threat: Dispatch Loops (Circular Invocation)

**Risk:** Agent A dispatches to Agent B, which dispatches back to Agent A, creating infinite recursion.

**Current mitigation:**
- `maxInvocationBudgetMs` timeout on the outer orchestrating agent kills the entire chain
- Per-agent concurrent invocation limits (`maxConcurrentTools`) prevent unbounded recursion depth
- Each dispatch call consumes rate limit tokens — the rate limiter will eventually block
- LoopAgent has a mandatory `maxIterations` cap

**Residual risk:** Two orchestrating agents dispatching to each other could create a deep call stack before timeouts trigger. The budget timeout on the outermost call is the final safety net.

**Recommendation:** Add a `maxDispatchDepth` counter threaded through the context to hard-cap recursion depth (future enhancement).

### Threat: Amplification Attacks

**Risk:** A single user message to a ParallelAgent with many steps generates N sub-agent invocations, each consuming rate limit budget and compute resources.

**Current mitigation:**
- Each sub-agent call passes through the rate limiter independently
- The rate limiter's per-minute and burst limits will throttle excessive parallel calls
- `maxConcurrency` option limits simultaneous active dispatches
- The orchestrating agent's own budget timeout caps total wall-clock time

**Residual risk:** An attacker could configure a ParallelAgent with many steps to amplify a single request into many. Configuration-time validation should limit step count.

**Recommendation:** Add a configurable `maxStepsPerOrchestration` limit (default: 20).

### Threat: State Poisoning

**Risk:** A malicious or compromised sub-agent writes crafted content to shared state via its response, influencing downstream steps.

**Current mitigation:**
- Sub-agents do NOT have write access to SharedState directly — only the orchestrating agent writes to state
- What gets written is the sub-agent's response content (which has already passed through OutputGuardian)
- The OutputGuardian scans for secrets, so credential injection into state is caught
- Each step's input passes through the Guardian pipeline again when dispatched

**Residual risk:** A sub-agent could craft response content that, when used as input for the next step, triggers unintended behavior (indirect prompt injection through state). The InputSanitizer on the next dispatch helps but may not catch all cases.

**Recommendation:** Consider adding an optional content sanitization pass when writing state values (future enhancement).

### Threat: Orchestrator Capability Escalation

**Risk:** An orchestrating agent could dispatch to sub-agents that have broader capabilities than the orchestrator itself.

**Current design:** This is **intentional** — the orchestrating agent delegates to sub-agents, and each sub-agent is validated against its own capability set. The orchestrator doesn't need the sub-agent's capabilities.

**Guard:** The sub-agent's capabilities were granted at registration time by the developer. The orchestrator cannot grant new capabilities. The Guardian validates each sub-agent's action against that sub-agent's frozen capability set.

### Threat: Resource Exhaustion via Nested Orchestration

**Risk:** Orchestrating agents can dispatch to other orchestrating agents, creating multi-level nesting.

**Current mitigation:**
- Budget timeout on the outermost agent caps total execution time
- Each nested level consumes its own rate limit tokens
- Event bus queue depth limit provides backpressure

**Recommendation:** Track and limit nesting depth in a future iteration.

---

## Integration with Runtime

### Context Wiring

The Runtime automatically provides `ctx.dispatch()` to all agents:

```typescript
// runtime.ts — createAgentContext()
dispatch: (targetAgentId: string, message: UserMessage) =>
  this.dispatchMessage(targetAgentId, message)
```

This means ANY agent can dispatch to other agents, not just orchestration agents. The orchestration agents simply provide structured patterns for doing so.

### Registration

Orchestration agents register like any other agent:

```typescript
const pipeline = new SequentialAgent('pipeline', 'Pipeline', {
  steps: [
    { agentId: 'step-1' },
    { agentId: 'step-2' },
  ],
});

runtime.registerAgent(createAgentDefinition({
  agent: pipeline,
  grantedCapabilities: ['read_files'], // orchestrator's own capabilities
  resourceLimits: {
    maxInvocationBudgetMs: 120_000, // enough for all steps combined
  },
}));
```

### Budget Considerations

The orchestrating agent's `maxInvocationBudgetMs` must be large enough to encompass all sub-agent invocations. Each sub-agent also has its own budget that runs independently.

Example for a 3-step sequential pipeline where each step takes ~10s:
- Orchestrator budget: 60_000ms (generous margin)
- Each sub-agent budget: 30_000ms (per-invocation)

---

## Testing

### Unit Tests (`orchestration.test.ts`)

| Test | Coverage |
|------|----------|
| Sequential: runs steps in order | Step ordering, state passing, output key |
| Sequential: stops on error | Error propagation, partial results |
| Sequential: continues on error | Fault tolerance mode |
| Sequential: no dispatch | Graceful degradation |
| Parallel: concurrent execution | All steps run, results combined |
| Parallel: mixed success/failure | Error isolation, partial success |
| Parallel: concurrency limit | Pool-based limiting verified |
| Parallel: no dispatch | Graceful degradation |
| Loop: condition-based termination | Custom condition function |
| Loop: maxIterations cap | Prevents infinite loops |
| Loop: error stops loop | Clean error reporting |
| Loop: feeds output as input | Iteration chaining |
| Loop: no dispatch | Graceful degradation |

### Integration Testing

Orchestration agents should be tested with a real Runtime to verify:
1. Guardian pipeline fires for each sub-agent dispatch
2. Rate limiting accumulates across orchestration steps
3. Budget timeouts propagate correctly through nested calls
4. Output scanning catches secrets in intermediate step outputs
5. Audit log records all sub-agent invocations

---

## Future Enhancements

1. **ConditionalAgent** — Route to different sub-agents based on LLM classification or content analysis
2. **MapReduceAgent** — Split input into chunks, process in parallel, merge results
3. **maxDispatchDepth** — Hard cap on recursion depth across nested orchestration
4. **maxStepsPerOrchestration** — Configuration-time limit on step count
5. **State sanitization** — Optional content cleaning when writing to shared state
6. **LLM-driven routing** — `transfer_to_agent()` pattern where the LLM decides which sub-agent to invoke
7. **AgentTool** — Wrap an agent as a callable tool for LLM function calling
