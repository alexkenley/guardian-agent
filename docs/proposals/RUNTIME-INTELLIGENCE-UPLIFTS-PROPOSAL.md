# Runtime Intelligence Uplifts Proposal

**Status:** Draft
**Date:** 2026-03-29
**Primary Guardian files:** [src/llm/provider-registry.ts](../../src/llm/provider-registry.ts), [src/llm/types.ts](../../src/llm/types.ts), [src/llm/openai.ts](../../src/llm/openai.ts), [src/runtime/model-routing-ux.ts](../../src/runtime/model-routing-ux.ts), [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts), [src/index.ts](../../src/index.ts), [src/tools/registry.ts](../../src/tools/registry.ts), [src/tools/executor.ts](../../src/tools/executor.ts), [src/runtime/sentinel.ts](../../src/runtime/sentinel.ts), [src/runtime/security-triage-agent.ts](../../src/runtime/security-triage-agent.ts)
**Related docs:** [ORCHESTRATION-DESIGN.md](../design/ORCHESTRATION-DESIGN.md), [AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md](../design/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md), BitNet CPU decision-lane proposal direction

---

## Executive Summary

Guardian should strengthen its runtime intelligence layer in a way that improves:

- local-model usefulness
- structured decision reliability
- research-task discipline
- tool execution efficiency
- observability and quality measurement

The recommendation is to deliver this as a bounded uplift program, not as a platform rewrite.

The highest-value work is:

1. make provider routing capability-aware rather than provider-name-aware
2. add generalized structured-output and tool-call recovery for weaker local models
3. add a first-class research orchestration lane for browser/search/repo investigation
4. add semantic tool-call dedupe and batching on top of existing parallel execution
5. add proper metrics and regression harnesses for routing, tool use, and security judgment

These changes complement the current BitNet CPU decision-lane direction, but are broader than BitNet and should stand on their own even if BitNet is never adopted.

---

## Problem

Guardian already has strong foundations:

- an authoritative Intent Gateway
- tiered local vs external routing
- conflict-aware parallel tool execution
- inline security evaluation
- conservative LLM-backed security triage
- supervisor-owned approvals, taint, and capability controls

The current gaps are mostly in runtime intelligence quality and operating discipline.

### 1. Provider abstraction is too shallow for heterogeneous local endpoints

The current provider layer is curated and simple, but it does not encode enough about provider and model capabilities.

Important missing distinctions:

- tool calling vs JSON-schema-only structured output
- reasoning-friendly vs weak structured-output behavior
- vision support
- actual locality semantics for loopback or private OpenAI-compatible endpoints
- provider-specific quirks that matter for routing

That becomes a real limitation as Guardian tries to support:

- local CPU-specialized decision lanes
- OpenAI-compatible local servers
- capability-specific routing for security and intent decisions

### 2. Weak local models still fail too often on structured tool use

Guardian already contains local-model fallbacks and repair behavior, but too much of it is narrow or task-specific. The system still assumes structured output will usually arrive correctly.

That is not a stable assumption for:

- smaller local models
- CPU-oriented inference stacks
- providers with partial OpenAI compatibility

### 3. Research-style tasks rely on generic orchestration instead of a first-class recipe

Guardian has strong orchestration primitives and clear layer separation, but browser/search/repo investigation work still lacks a dedicated research loop with:

- clarification
- planning
- bounded search cycles
- restricted tools
- forced synthesis

That leads to avoidable drift and repeated search behavior.

### 4. Tool execution is parallel but not semantically deduped

Guardian already runs tool calls concurrently with conflict controls. That is good, but it does not yet aggressively collapse redundant read-heavy tool calls before execution.

That increases:

- latency
- duplicate search cost
- repetitive browser/open-url work
- noisy context fed back into the model

### 5. Quality is still under-instrumented

Guardian has test harnesses and strong runtime controls, but it still needs clearer measurement for:

- intent routing quality
- structured-output failure rates
- local vs external fallback behavior
- tool redundancy
- security-evaluation latency and precision

Without that, local-lane tuning becomes anecdotal.

---

## Goals

1. Make provider and model routing capability-aware.
2. Improve reliability of local and CPU-oriented structured-decision paths.
3. Add a first-class research orchestration lane without collapsing Guardian’s existing orchestration model.
4. Reduce redundant tool work and improve tool-result quality.
5. Make routing and security quality measurable.
6. Preserve Guardian’s current security-first runtime posture.

## Non-Goals

1. Do not rewrite Guardian into a large multi-tenant AI platform.
2. Do not replace the existing security model with a looser agent framework.
3. Do not add dynamic third-party tool loading without curation.
4. Do not collapse all orchestration layers into one generic “orchestrator.”
5. Do not assume every local OpenAI-compatible endpoint can substitute for every current provider use case.

---

## Workstream 1: Provider Capability Matrix And Locality Cleanup

### Objective

Make provider selection reflect what a provider can actually do, not just its name.

### Current pain

Today, Guardian’s provider registry is mostly a mapping from provider name to implementation, and some runtime paths still effectively treat `ollama` as synonymous with `local`.

That is too brittle for:

- local OpenAI-compatible servers
- JSON-only local decision lanes
- future routing that differentiates tool-calling and classification workloads

### Core changes

- Extend `ChatOptions` to support structured-response requirements such as JSON mode or JSON schema.
- Add provider/model capability metadata such as:
  - `supportsToolCalling`
  - `supportsJsonSchema`
  - `supportsVision`
  - `supportsReasoning`
  - `locality`
- Move locality detection away from hardcoded provider-name checks and toward endpoint/config-based classification.
- Allow local OpenAI-compatible endpoints to behave as first-class local providers without fake “external” semantics.
- Route high-structure workloads based on capabilities rather than provider name.

### Primary files

- [src/llm/types.ts](../../src/llm/types.ts)
- [src/llm/openai.ts](../../src/llm/openai.ts)
- [src/llm/provider-registry.ts](../../src/llm/provider-registry.ts)
- [src/runtime/model-routing-ux.ts](../../src/runtime/model-routing-ux.ts)
- [src/index.ts](../../src/index.ts)

### Why first

This is the foundation for every later uplift in this proposal, and it is also the main prerequisite for any future local decision-engine lane.

---

## Workstream 2: Structured-Output And Tool-Call Recovery For Weak Local Models

### Objective

Make Guardian more resilient when a local or weaker provider fails to emit valid structured output.

### Current pain

Guardian already has some fallback behavior, but much of it is narrow and special-cased. That is not enough for a runtime that wants to support:

- weaker local models
- CPU-specialized models
- partially compatible local HTTP inference servers

### Core changes

- Add a generalized recovery layer that can:
  - extract tool calls from plain text when the serving layer fails to format them
  - repair malformed JSON-only responses when the task requires a schema
  - re-prompt with a capability-aware repair message before escalating to full provider fallback
- Record structured-output degradation per provider/model so it becomes measurable.
- Reuse the same recovery layer across:
  - Intent Gateway classifications
  - tool-calling assistant loops
  - inline security evaluation
  - Sentinel analysis

### Primary files

- [src/index.ts](../../src/index.ts)
- [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts)
- [src/runtime/sentinel.ts](../../src/runtime/sentinel.ts)
- new runtime helper module for structured-output recovery

### Why second

Capability-aware routing is only half the problem. Guardian also needs to survive the real behavior of weaker local models once they are selected.

---

## Workstream 3: First-Class Research Orchestration Lane

### Objective

Introduce a dedicated research loop for browser/search/repo investigation tasks without disturbing the existing top-level orchestration boundaries.

### Current pain

Guardian already has:

- a strong Intent Gateway
- agent-composition primitives
- browser, search, and file tools

What it lacks is a dedicated research-shaped execution lane with explicit steps and stopping rules.

### Core changes

- Add a research recipe with:
  - optional clarification step
  - explicit research-plan generation
  - restricted research tool set
  - bounded search/open/read cycles
  - hard time and iteration caps
  - forced final synthesis step
- Keep this below the Intent Gateway. The gateway still owns top-level route selection.
- Keep supervisor-owned approvals, taint propagation, and capability enforcement intact.
- Start with browser/search/repo investigation flows rather than general chat.

### Primary files

- [docs/design/ORCHESTRATION-DESIGN.md](../design/ORCHESTRATION-DESIGN.md)
- [src/agent/orchestration.ts](../../src/agent/orchestration.ts)
- [src/agent/recipes.ts](../../src/agent/recipes.ts)
- [src/index.ts](../../src/index.ts)
- new research orchestration prompt/runtime files

### Why third

This is the highest-value behavioral uplift for search-heavy and browser-heavy investigation tasks, but it should be built on top of the provider-capability and structured-output work.

---

## Workstream 4: Semantic Tool Dedupe And Batch Semantics

### Objective

Reduce redundant read-heavy tool work without weakening Guardian’s current conflict and safety controls.

### Current pain

Guardian already has:

- parallel tool execution
- conflict-aware serialization for mutating calls
- chain budgets to prevent runaway tool loops

The missing piece is semantic consolidation before execution.

### Core changes

- Merge redundant read-heavy tool calls in the same round where safe, especially for:
  - search-like tools
  - repeated open/read calls
  - repeated browser-read style retrieval
- Preserve current conflict-key serialization for mutating tools.
- Track when tool calls were:
  - merged
  - dropped by batch policy
  - executed normally
- Keep per-tool provenance stable so the model still receives legible results.

### Primary files

- [src/index.ts](../../src/index.ts)
- [src/tools/executor.ts](../../src/tools/executor.ts)
- new tool-batching helper module

### Why fourth

Guardian already has the right execution skeleton here. This is an efficiency and quality uplift, not a new runtime.

---

## Workstream 5: Metrics And Regression Evaluation

### Objective

Make routing, local-model behavior, and security judgment measurable enough to improve intentionally.

### Current pain

Guardian has strong runtime controls, but some of the most important intelligence paths still lack first-class scoreboards.

### Core changes

- Add structured metrics for:
  - Intent Gateway latency
  - route distribution
  - gateway-unavailable fallback rate
  - structured-output repair rate
  - local-to-external fallback rate
  - tool dedupe rate
  - inline Guardian evaluation latency and allow/block distribution
  - Sentinel analysis latency and finding volume
- Add curated regression datasets and harnesses for:
  - intent routing
  - structured security decisions
  - research-task execution quality
  - local-model degraded-output cases
- Produce artifact outputs that are easy to compare across runs.

### Primary files

- [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts)
- [src/runtime/sentinel.ts](../../src/runtime/sentinel.ts)
- [src/runtime/security-triage-agent.ts](../../src/runtime/security-triage-agent.ts)
- [scripts/](../../scripts)
- new runtime metrics modules and evaluation assets

### Why fifth

These measurements should start early, but they become much more useful once the earlier routing and recovery changes land.

---

## Later Extension: Declarative Tool Provisioning

Guardian’s current tool registry is curated and code-centric, which is still the right default. The next uplift after the core runtime work should be a more declarative provisioning layer that makes it easier to express:

- which agents get which tools
- which tools are available on which surfaces
- which tools are unavailable because required backing services are missing
- which tool families can be exposed through a consistent MCP/OpenAPI-style model without becoming uncurated

This should remain:

- first-party
- curated
- runtime-checked

It should not become a plugin free-for-all.

### Primary files

- [src/tools/registry.ts](../../src/tools/registry.ts)
- [src/tools/executor.ts](../../src/tools/executor.ts)
- future tool-manifest and availability modules

---

## Later Extension: Specialized Runtime Lanes

If Guardian’s background load keeps growing, it may eventually benefit from more explicit separation of:

- security monitoring
- heavy browser automation
- research jobs
- indexing and sync work
- lightweight control-plane work

This should be treated as an operational scaling decision, not a near-term architecture objective.

The product should not absorb a heavyweight queue-and-worker topology unless real runtime pressure justifies it.

---

## Delivery Order

### Phase 1: Provider semantics first

- provider capability metadata
- structured-response options
- locality cleanup

### Phase 2: Make weak local models survivable

- generalized tool-call and JSON recovery
- degraded-output telemetry

### Phase 3: Improve task quality and efficiency

- research orchestration lane
- semantic tool batching

### Phase 4: Make improvements measurable and durable

- metrics
- regression harnesses
- scenario datasets

### Phase 5: Optional platformization

- declarative tool provisioning
- specialized runtime lanes if operationally necessary

---

## Risks

### 1. Capability metadata becomes too abstract

If the capability model is too coarse, Guardian will still make bad routing decisions. If it becomes too detailed, it will become unmaintainable.

Mitigation:

- keep the first capability set small
- add only fields that drive a real routing decision

### 2. Recovery logic can hide real provider failures

If recovery becomes too aggressive, it may mask upstream model regressions and make debugging harder.

Mitigation:

- log each repair path
- keep provider/model-level repair metrics
- escalate cleanly when recovery fails

### 3. Research orchestration can become a shadow orchestrator

If implemented carelessly, a research lane could blur the orchestration boundaries already defined in Guardian’s architecture.

Mitigation:

- keep top-level routing in the Intent Gateway
- keep the research lane as a recipe beneath that layer

### 4. Tool batching can change behavior subtly

Some repeated calls are genuinely distinct. Blind merging would be wrong.

Mitigation:

- start with clearly mergeable read-heavy tools only
- keep mutating tools out of batch merging

### 5. Metrics can create noise instead of signal

High-cardinality or poorly scoped metrics will make the system harder to operate, not easier.

Mitigation:

- prefer low-cardinality counters and histograms
- start with the core intelligence paths only

---

## Recommendation

Proceed with this uplift program as a runtime-quality roadmap, not as a platform rewrite.

The clearest near-term sequence is:

1. provider capability routing and locality cleanup
2. generalized weak-model structured-output recovery
3. research-lane orchestration
4. tool-call dedupe and batching
5. metrics and regression harnesses

This keeps Guardian aligned with its current strengths:

- local-first deployment options
- security-first runtime control
- explicit orchestration boundaries
- curated tools and providers

while making the system materially better at the class of tasks that depend on fast, structured, reliable runtime intelligence.
