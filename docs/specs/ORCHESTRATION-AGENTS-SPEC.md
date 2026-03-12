# Orchestration Agents Specification

**Status:** Implemented
**Files:** `src/agent/orchestration.ts`, `src/agent/conditional.ts`
**Tests:** `src/agent/orchestration.test.ts`, `src/agent/conditional.test.ts`
**Depends on:** SharedState (`src/runtime/shared-state.ts`), Runtime dispatch

---

## Overview

Structured orchestration agents enable declarative multi-agent composition within GuardianAgent's security model. Inspired by Google ADK's SequentialAgent/ParallelAgent/LoopAgent, but with a critical difference: **all sub-agent invocations pass through the full Guardian admission pipeline**.

These are not lightweight wrappers — each sub-agent call goes through input sanitization, rate limiting, capability checking, secret scanning, output scanning, and budget enforcement. When the target is a built-in chat agent, the dispatched call also goes through the brokered worker execution path. Security is preserved by construction.

### Agents

| Agent | Pattern | Use Case |
|-------|---------|----------|
| `SequentialAgent` | A → B → C (pipeline) | Multi-step workflows: analyze → transform → validate |
| `ParallelAgent` | A ∥ B ∥ C (fan-out) | Independent tasks: multi-source research, parallel analysis |
| `LoopAgent` | A → A → A (iteration) | Refinement loops: draft → review → revise until satisfied |
| `ConditionalAgent` | if/else branching | Route to different sub-agents based on state or input conditions |

### Cross-Cutting Features

| Feature | Scope | Description |
|---------|-------|-------------|
| Per-step retry | Sequential, Parallel | `StepRetryPolicy` with exponential backoff, retryable error filter |
| Fail-branch | Sequential, Parallel | `StepFailBranch` — alternative agent when step fails all retries |
| Array iteration | LoopAgent | `LoopArrayConfig` — map over array items with configurable concurrency |
| Shared utilities | All | Extracted module-level functions: `executeWithRetry()`, `runStepsSequentially()`, `runWithConcurrencyLimit()`, `prepareStepInput()`, `recordStepOutput()` |

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
                                            └──────────┬───────────┘
                                                       │
                                                       ▼
                                            ┌──────────────────────┐
                                            │  Target execution    │
                                            │  chat agent ->       │
                                            │  brokered worker     │
                                            │  other agent ->      │
                                            │  supervisor handler  │
                                            └──────────────────────┘
```

### Key Invariant

Orchestration agents receive `ctx.dispatch()`, which is a **guarded wrapper** around `Runtime.dispatchMessage()`. They never receive a reference to the Runtime itself. This means:

1. Every sub-agent call passes through Layer 1 (Guardian admission)
2. Built-in chat-agent targets are routed into the brokered worker path by default
3. Every sub-agent response passes through Layer 2 (Output scanning)
4. Sub-agent budget/token/concurrent limits are enforced per-call
5. The orchestrating agent's own limits apply to its outer invocation
6. Rate limiting applies per sub-agent independently

### Scope Note

Orchestration agents themselves remain trusted framework code running in the supervisor process. The brokered boundary applies when orchestration dispatches into the built-in chat/planner execution path.

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

## Orchestration Architecture: LLM-Driven vs Code-Driven

Modern agent systems use a two-layer orchestration model. GuardianAgent follows this pattern, with clear separation between what the LLM decides and what code determines.

### Layer 1: LLM-Driven (Within an Agent)

The LLM controls the **reasoning loop** inside each agent invocation. This is the "agentic" part — the model decides what to do next:

- **Tool selection**: The LLM picks which tools to call via function calling (e.g., "I need to read this file, then search the web, then write a report")
- **Iteration control**: The LLM decides when it's done (stop calling tools) or needs another round
- **Task decomposition**: The LLM breaks complex requests into steps within a single invocation

This follows the **ReAct pattern** (Reasoning + Acting):

```
Thought → Action (tool call) → Observation (result) → Thought → ...
```

GuardianAgent implements this in the `ChatAgent.onMessage` tool loop: the LLM receives tool definitions, calls tools, receives results, and iterates until it produces a final response. The system never hard-codes "for this query, call tool X then tool Y" — that's entirely the LLM's decision.

### Layer 2: Code-Driven (Infrastructure)

Code controls **infrastructure decisions** without consulting the LLM:

| Decision | Mechanism | Why Code, Not LLM |
|---|---|---|
| Channel → agent routing | Config bindings, default agent | Deterministic, instant, no latency |
| Model selection | `defaultProvider` config | Cost/latency predictability |
| Model for tool result synthesis | `providerRouting` config + smart category defaults | Per-category optimization without per-request LLM overhead |
| Failover on provider error | `ModelFallbackChain`, `CircuitBreaker` | Must be reliable even when LLMs are down |
| Quality-based fallback | `isResponseDegraded()` heuristic | Pattern matching is cheaper than asking another LLM |
| Security gating | Guardian admission pipeline | Must not be bypassable by LLM reasoning |
| Rate limiting | Sliding window counters | Deterministic enforcement |
| Session serialization | `AssistantOrchestrator` queue | Infrastructure concern |

### Smart LLM Provider Routing

When both local (Ollama) and external (Anthropic/OpenAI) providers are configured, the system automatically routes tool result synthesis to the appropriate model based on task type:

| Routes to **Local** model | Routes to **External** model |
|---|---|
| filesystem, shell, network, system, memory, automation | web, browser, workspace, email, contacts, forum, intel, search |

This is a **code-driven, config-overridable** decision. The LLM is never asked "which model should synthesize this?" — that would add latency and cost to every tool call. Users can override per-tool or per-category via the web UI (Configuration > Tools tab), and disable smart routing entirely via the `providerRoutingEnabled` toggle.

See [TOOLS-CONTROL-PLANE-SPEC.md](TOOLS-CONTROL-PLANE-SPEC.md) for the full routing algorithm, API, and configuration reference.

### Where Orchestration Agents Fit

The `SequentialAgent`, `ParallelAgent`, and `LoopAgent` defined in this spec are **code-driven composition primitives**. They define the _structure_ of multi-agent workflows (ordering, parallelism, iteration) while the LLM controls _what happens_ within each sub-agent invocation.

```
Code decides:                    LLM decides:
├── Run agent A, then B, then C  ├── Which tools to call in agent A
├── Run D and E in parallel      ├── How to interpret tool results
├── Loop F up to 5 times         ├── When to stop iterating (within F)
└── Route to local/external      └── What to say to the user
```

### Industry Comparison

GuardianAgent's orchestration model aligns with the production consensus across the industry:

| System | Tool Selection | Multi-Agent Routing | Model Selection | Orchestration Style |
|---|---|---|---|---|
| **GuardianAgent** | LLM-driven (function calling) | Code-driven (Sequential/Parallel/Loop agents) | Code-driven (config + smart category defaults) | Structured primitives + ReAct loop |
| **OpenAI Agents SDK** | LLM-driven (function calling) | Code-driven (Agents + Handoffs) | Code-driven (per-agent config) | Minimal: agents + handoff transfers |
| **OpenClaw** | LLM-driven (function calling) | LLM-driven (spawns subagents via tool calls) | Code-driven (config + fallback chain) | Single ReAct loop + on-demand subagent spawn |
| **LangGraph** | LLM-driven | Code-driven (state machine graphs) | Code-driven | Graph-based node orchestration |
| **CrewAI** | LLM-driven | Code-driven (role-based agent teams) | Code-driven | Role assignment + task delegation |
| **Google ADK** | LLM-driven | Code-driven (SequentialAgent/ParallelAgent/LoopAgent) | Code-driven | Structured primitives (GuardianAgent's inspiration) |

Key observations from industry analysis:

- **No production system uses an LLM to select which model handles a request.** Model routing is always code/config-driven because it must be fast, deterministic, and cost-predictable.
- **Tool selection is universally LLM-driven** via function calling. This is the core "agentic" capability.
- **Multi-agent coordination splits between two patterns**: structured primitives (GuardianAgent, Google ADK, OpenAI Agents SDK) where code defines agent flow, and on-demand spawning (OpenClaw) where the LLM decides when to delegate.
- **LLM gateways** (Bifrost, Portkey, Agentgateway) handle multi-provider routing as middleware — code-driven load balancing, failover, and cost optimization with no LLM involvement in provider selection.

### ReAct Pattern

The ReAct (Reasoning + Acting) pattern, introduced by [Yao et al. 2022](https://arxiv.org/abs/2210.03629), is the foundation of tool-using agents. It interleaves reasoning traces with actions:

1. **Thought**: The LLM reasons about what to do next
2. **Action**: The LLM calls a tool (function call)
3. **Observation**: The tool result is fed back to the LLM
4. **Repeat** until the LLM produces a final answer

GuardianAgent's `ChatAgent.onMessage` implements this loop with additions:
- **Guardian admission** on every tool call (security gate between Action and Observation)
- **Parallel tool execution** when the LLM returns multiple tool calls in one response
- **Provider routing** that can swap the LLM between rounds based on which tools executed
- **Context budget management** that compacts old tool results when context grows too large
- **Quality-based fallback** that retries through the fallback chain on degraded responses

### References

- [OpenAI Agents SDK — Agent Orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [AI Agent Orchestration Patterns for Reliable Products](https://productschool.com/blog/artificial-intelligence/ai-agent-orchestration-patterns)
- [Navigating Modern LLM Agent Architectures](https://www.wollenlabs.com/blog-posts/navigating-modern-llm-agent-architectures-multi-agents-plan-and-execute-rewoo-tree-of-thoughts-and-react)
- [ReAct Prompting Guide](https://www.promptingguide.ai/techniques/react)
- [Multi-provider LLM Orchestration in Production: A 2026 Guide](https://dev.to/ash_dubai/multi-provider-llm-orchestration-in-production-a-2026-guide-1g10)
- [LLM Orchestration in 2026: Top 22 Frameworks and Gateways](https://research.aimultiple.com/llm-orchestration/)
- [AI Agent Routing: Tutorial & Best Practices](https://www.patronus.ai/ai-agent-development/ai-agent-routing)
- [From Workflows to Agents: The Evolution of LLM Orchestration](https://medium.com/@20011002nimeth/from-workflows-to-agents-the-evolution-of-llm-orchestration-7c7b8eb2eea5)
- [Difficulty-Aware Agent Orchestration in LLM-Powered Workflows](https://arxiv.org/html/2509.11079v1)
- [Agentic AI Frameworks: Complete Enterprise Guide for 2026](https://www.spaceo.ai/blog/agentic-ai-frameworks/)

---

## Future Enhancements

1. ~~**ConditionalAgent**~~ — **Implemented** in `src/agent/conditional.ts`. Routes to different sub-agents based on ordered branch conditions evaluated against SharedState and input. Supports `inheritStateKeys`, retry/fail-branch within branches, and default steps.
2. **LLM-based routing** — Extend ConditionalAgent with optional `llmDescription` on branches for LLM-classified routing (Question Classifier pattern)
3. **MapReduceAgent** — Split input into chunks, process in parallel, merge results
3. **maxDispatchDepth** — Hard cap on recursion depth across nested orchestration
4. **maxStepsPerOrchestration** — Configuration-time limit on step count
5. **State sanitization** — Optional content cleaning when writing to shared state
6. **LLM-driven routing** — `transfer_to_agent()` pattern where the LLM decides which sub-agent to invoke (following OpenAI Agents SDK handoff pattern)
7. **AgentTool** — Wrap an agent as a callable tool for LLM function calling
8. **On-demand subagent spawning** — LLM-triggered agent creation via tool call (following OpenClaw pattern), with depth/count limits enforced by code
