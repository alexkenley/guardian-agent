# Intelligence In Depth Specification

**Status:** Proposed target architecture  
**Date:** 2026-03-29  
**Proposal origin:** [Offline Survival And Decision Lane Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/OFFLINE-SURVIVAL-AND-DECISION-LANE-PROPOSAL.md)

## Purpose

Define GuardianAgent's layered intelligence architecture so the system remains:

- operable when the internet is unavailable
- useful when Ollama is unavailable
- safe when no LLM is healthy
- capable of routing bounded decision work to the right local runtime
- clear about which class of intelligence is responsible for which workload

This is a design-target spec. It defines the intended runtime model, layer boundaries, and routing rules for future implementation.

## Core Idea

Guardian should not have one undifferentiated "AI provider" concept.

It should have **intelligence in depth**:

- a deterministic floor that never depends on an LLM
- a tiny built-in survival LLM lane
- a stronger local decision lane for bounded structured work
- a broader local general-assistant lane
- external intelligence as the final outer ring

These are not five copies of the same thing. They are five different capability rings with different:

- failure domains
- trust assumptions
- packaging requirements
- routing responsibilities
- response-quality expectations

## Canonical Layers

### Layer 0: Deterministic Control, Enforcement, And Explicit Automation Runtime

This is the non-LLM floor.

It exists so Guardian can still do useful work when every LLM lane is unavailable or intentionally disabled.

Primary responsibilities:

- policy enforcement
- sandbox and approval enforcement
- hard allow/deny decisions from explicit policy
- health checks and recovery loops
- explicit automation execution when the requested work is already structured
- scheduled and event-driven control-plane work
- operator-directed quick actions

What Layer 0 **can** do:

- execute saved deterministic workflows
- run cron and event-triggered tasks
- resume paused deterministic runs from stored state
- run native host-security checks such as Defender / ClamAV / integrity checks
- stop agents, disable providers, pause automation execution, isolate features, and gather logs
- process exact-id or exact-action control-plane requests from structured UI or CLI actions
- fail closed for risky actions when there is no healthy higher layer

What Layer 0 **must not** do:

- parse arbitrary natural-language requests in the normal chat path
- replace the Intent Gateway in normal operation
- invent new automations
- perform nuanced freeform security judgment
- synthesize rich explanations from complex evidence

Operational model:

- event loop driven
- cron driven
- manual control-plane action driven
- deterministic resume state driven

Primary implementation domains:

- `src/runtime/connectors.ts`
- `src/runtime/graph-runner.ts`
- `src/runtime/scheduled-tasks.ts`
- `src/tools/executor.ts`
- `src/runtime/security-controls.ts`
- `src/runtime/automation-runtime-service.ts`

### Layer 1: Built-in Survival Intelligence

This is the smallest bundled local LLM lane.

Chosen runtime direction:

- **`llama.cpp` helper process**

Chosen model class:

- bundled tiny GGUF model
- default target: `SmolLM2-360M-Instruct`
- minimum footprint option: `SmolLM2-135M-Instruct`

Primary responsibilities:

- degraded Intent Gateway classification
- degraded Guardian Agent inline security judgment
- degraded Sentinel audit synthesis
- short operator guidance when stronger lanes are unavailable

Constraints:

- must not depend on Ollama
- must run on CPU-only machines
- may opportunistically use local GPU acceleration where available
- must prefer strict JSON / constrained output
- must not be treated as a general-purpose coding or orchestration model

Why `llama.cpp` is the chosen Layer 1 backend:

- best cross-platform baseline
- broad GGUF model ecosystem
- helper-process isolation is operationally clean
- does not force Node native-addon embedding into the main process
- works well for strict local bounded inference

Why `node-llama-cpp` is not the primary Layer 1 choice:

- it is attractive for TypeScript integration
- but the current preference is a helper-process boundary for stronger crash and compromise isolation
- it remains a viable implementation alternative later if Guardian wants a tighter local runtime integration

Why `ONNX Runtime GenAI` is not the primary Layer 1 choice:

- it has a strong Windows and DirectML story
- but it is not the best single default backend for one cross-platform built-in lane
- it should remain an optional future backend, especially for Windows integrated GPU acceleration

### Layer 2: Local Decision Intelligence

This is the stronger bounded local decision lane.

Chosen runtime direction:

- **BitNet**

Primary responsibilities:

- Intent Gateway classification when healthy
- Guardian Agent inline action evaluation
- Sentinel retrospective audit analysis
- compact JSON-only classifiers
- other short-context local security judgment

Constraints:

- not the main assistant tool-calling loop
- not coding
- not browser/email/workspace orchestration
- not the universal built-in fallback

Operational model:

- distinct process/runtime from Layer 1
- distinct bundled model asset
- distinct health checks
- routable only for workloads that fit its capability profile
- shipped with Guardian as a built-in managed component
- started and supervised by Guardian at startup

Recommended default use:

- prefer Layer 2 over Layer 1 for bounded structured decision work when healthy
- fall back from Layer 2 to Layer 1 when BitNet is unavailable or degraded
- fall back from Layer 1 to Layer 0 deterministic behavior when no LLM lane is healthy

### Layer 3: Local General Assistant Intelligence

This is the broader local assistant lane.

Chosen runtime direction:

- **Ollama**

Primary responsibilities:

- local general assistant chat
- local tool-calling loops
- local experimentation with larger models
- local coding and general synthesis if the operator wants a local-first setup

Constraints:

- not the built-in survival lane
- not the only definition of "local"
- not the sole routing destination for all structured decision work

Important boundary:

- Layer 3 may be unavailable without taking down Layers 1 and 2
- Guardian must not couple built-in survival behavior to Ollama model discovery, storage, or process health

### Layer 4: External Intelligence

This is the outermost lane.

Examples:

- OpenAI
- Anthropic
- Groq
- Mistral
- DeepSeek
- Together
- other configured external providers

Primary responsibilities:

- highest-capability general assistance
- strongest fallback for complex synthesis when allowed
- external coding and orchestration workloads
- cloud-dependent advanced reasoning

Constraints:

- network-dependent
- higher trust and privacy sensitivity
- not the only way Guardian should remain functional

## Layer Summary

| Layer | Name | Chosen stack | Primary purpose |
|------|------|--------------|-----------------|
| 0 | Deterministic runtime | Guardian code, tools, schedulers, policies | Explicit execution, enforcement, health, safe degradation |
| 1 | Built-in survival intelligence | `llama.cpp` helper + tiny bundled GGUF | Minimal offline reasoning when no stronger lane is available |
| 2 | Local decision intelligence | BitNet helper + bundled BitNet model | Fast bounded JSON-oriented local security and routing decisions |
| 3 | Local general assistant intelligence | Ollama | Broader local chat and tool-calling assistance |
| 4 | External intelligence | Cloud providers | Highest-capability remote reasoning and synthesis |

External is **Layer 4**, not Layer 5.

## Important Rule: Layers Are Capability Rings, Not A Linear Pipeline

Requests do **not** always flow 0 -> 1 -> 2 -> 3 -> 4.

Instead, Guardian selects the **minimum sufficient healthy layer** for the workload.

Examples:

- a saved deterministic automation run may execute entirely in Layer 0
- Intent Gateway classification should prefer Layer 2, then Layer 1, then deterministic Layer 0 fallback only in tightly bounded degraded cases
- a general local assistant request may go straight to Layer 3
- a high-capability external reasoning request may go straight to Layer 4

This prevents the architecture from becoming a slow serial chain and keeps the role of each layer clear.

## Routing Rules

### 1. Explicit Deterministic Work

Examples:

- saved workflow run
- scheduled task
- approval resolution
- exact control-plane operation from UI
- restart provider
- disable automation
- collect logs

Route:

- Layer 0

Notes:

- no LLM required
- Layer 0 remains useful even when all other layers are dead

### 2. Intent Gateway

Normal route preference:

1. Layer 2
2. Layer 1
3. Layer 0 only for narrow degraded fallback behavior

Layer 0 fallback is allowed only for:

- structured UI actions
- explicit quick actions
- already narrowed pending-action resumes
- previously structured state transitions

Layer 0 must not become an ad-hoc text classifier.

### 3. Guardian Agent Inline Security Evaluation

Normal route preference:

1. Layer 2
2. Layer 1
3. Layer 0 deterministic policy floor

Layer 0 behavior:

- apply hard denies from policy/sandbox/integrity rules
- allow clearly safe pre-authorized operations
- otherwise follow configured fail-open or fail-closed behavior

### 4. Sentinel Audit Analysis

Normal route preference:

1. Layer 2
2. Layer 1
3. Layer 0 heuristic-only analysis

Layer 0 behavior:

- anomaly thresholds
- IOC/rule matching
- event-volume spike detection
- deterministic summaries from structured findings where possible

### 5. General Assistant Tool Loop

Route preference:

1. Layer 3 or Layer 4 based on operator config and routing
2. optional fallback to the other if allowed by policy and availability

Layer 1 and Layer 2 should not be used for the main tool-calling assistant loop in the default design.

### 6. Instruction Steps In Deterministic Workflows

Route preference:

- configurable per workflow step
- default to Layer 2 for bounded JSON classifier steps when appropriate
- otherwise Layer 3 or Layer 4
- Layer 1 only for degraded survival-mode instruction steps

Deterministic tool and delay steps remain Layer 0.

## Chosen Backend Strategy

### Layer 1 Choice: `llama.cpp` Helper Process

Chosen because it provides the cleanest combination of:

- cross-platform support
- CPU-first execution
- optional GPU acceleration
- broad tiny-model availability
- helper-process isolation
- straightforward asset packaging

Expected product shape:

- Guardian-managed helper process
- Guardian-managed health checks
- Guardian-managed model assets
- Guardian-managed restart and recovery

### Layer 2 Choice: BitNet

Chosen because it is a better fit for:

- CPU-oriented structured decision work
- short bounded classification
- local security judgment

BitNet is not chosen as Layer 1 because:

- its runtime/model ecosystem is narrower than the `llama.cpp` GGUF ecosystem
- it is better treated as an optional stronger local decision engine than as the one mandatory survival runtime

### Shared-Model Clarification: Layer 1 And Layer 2

Layer 1 (`llama.cpp`) and Layer 2 (BitNet) **may** be able to use the same model weights file in a narrow technical sense:

- if the model is a supported **BitNet b1.58 GGUF** model
- if both runtimes support that exact model family and format

This does **not** mean Guardian should architect the system around one shared model by default.

Preferred design rule:

- Layer 1 should have its own tiny bundled survival model
- Layer 2 should have its own stronger decision-oriented model

Reasons:

1. Layer responsibilities are different.
   - Layer 1 is about minimum viable offline survival.
   - Layer 2 is about stronger bounded structured decision quality.

2. A shared model would tend to make Layer 1 heavier than it needs to be.

3. Separate models preserve clearer failure isolation and clearer operator expectations.

4. BitNet is not a generic runtime for arbitrary Ollama or `llama.cpp` models.

Therefore:

- **technical position:** shared model may be possible for supported BitNet GGUF models
- **architectural position:** separate Layer 1 and Layer 2 models remain the default recommendation

### Layer 3 Choice: Ollama

Chosen because it already fits the repo's broad local-assistant shape:

- general local experimentation
- larger local models
- tool-calling oriented use

But this spec explicitly rejects the old assumption that:

- `local == ollama`

### Future Optional Backend: `ONNX Runtime GenAI`

Status in this spec:

- not selected as the primary Layer 1 backend
- retained as an optional future backend for Windows-heavy and DirectML-focused deployments

Best fit:

- Windows
- integrated GPU acceleration
- DirectML-driven local packs
- curated ONNX model distribution

## Failure-Domain Rules

For this architecture to be meaningful, the layers must not collapse into the same failure domain.

### Layer 1 Must Be Independent Of Layer 3

Requirements:

- no dependency on Ollama binary
- no dependency on Ollama model storage
- no dependency on Ollama HTTP server
- separate runtime process
- separate health state

### Layer 2 Must Be Independent Of Layer 3

Requirements:

- BitNet runtime is not tunneled through Ollama
- separate model assets
- separate health state
- separate routing metadata

### Layer 0 Must Be Independent Of All LLM Layers

Requirements:

- scheduled execution still works without LLMs
- approvals and explicit control-plane actions still work without LLMs
- security enforcement still works without LLMs

## Capability Model

Guardian should represent intelligence layers and providers using capability metadata instead of provider-name assumptions.

Suggested shape:

```ts
interface LLMProviderCapabilities {
  locality: 'local' | 'external';
  isolation: 'in_process' | 'worker_process' | 'helper_process' | 'external_service';
  supportsTools: boolean;
  supportsJsonSchema: boolean;
  supportsStreaming: boolean;
  intendedUses: Array<
    | 'general_chat'
    | 'tool_calling'
    | 'intent_classification'
    | 'security_judgment'
    | 'audit_analysis'
    | 'degraded_fallback'
  >;
}
```

This is required so the runtime can stop doing things like:

- treating `providerName === 'ollama'` as the definition of local
- assuming all local OpenAI-compatible endpoints are interchangeable

## Required Chat Abstraction

The shared chat interface should support constrained structured outputs directly.

Suggested shape:

```ts
interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  responseFormat?: {
    type: 'json_object' | 'json_schema';
    schema?: Record<string, unknown>;
  };
  signal?: AbortSignal;
}
```

This is particularly important for:

- Layer 1 constrained survival responses
- Layer 2 BitNet decision tasks
- Intent Gateway classification
- Guardian Agent evaluation
- Sentinel audit analysis

## Safe Implementation Strategy

The implementation should be **deliberately layered but operationally compact**.

This spec does **not** recommend creating five independent orchestration systems or scattering layer-specific branching logic throughout the codebase.

The safe architecture is:

- keep one deterministic runtime floor
- add one bundled local runtime manager for Layer 1
- add one optional local decision provider for Layer 2
- keep Ollama and external providers in the ordinary provider system
- add one central selector that chooses the minimum sufficient healthy layer for a workload class

This keeps the architecture expressive without turning it into a maze.

### The Implementation Must Avoid

The following are explicitly discouraged:

- per-feature custom layer-selection logic
- freeform planner logic that "reasons" about layers in natural language
- separate routing frameworks per layer
- multiple incompatible local-runtime manager abstractions
- duplicating business logic across Layer 1, Layer 2, Layer 3, and Layer 4

The layered model should exist as **data and routing policy**, not as five separately reinvented subsystems.

## Recommended Runtime Architecture

### 1. One Workload Classifier For Routing Purposes

Guardian should route intelligence requests using a small explicit workload-class vocabulary.

Suggested initial classes:

```ts
type WorkloadClass =
  | 'deterministic'
  | 'decision_json'
  | 'general_tools'
  | 'general_chat';
```

Meaning:

- `deterministic`
  - explicit saved workflows
  - cron and event-triggered tasks
  - control-plane actions
  - policy enforcement
  - approvals and resumes
- `decision_json`
  - Intent Gateway
  - Guardian Agent inline evaluation
  - Sentinel audit analysis
  - short bounded JSON-only classifiers
- `general_tools`
  - tool-calling assistant loops
  - browser/email/workspace orchestration
  - coding orchestration
- `general_chat`
  - plain conversational or synthesis-heavy responses without tool dependence

This workload vocabulary should stay intentionally small unless the implementation proves it is insufficient.

### 2. One Shared Lane Selector

Guardian should introduce one central selector that chooses the minimum sufficient healthy lane for a workload class.

Suggested conceptual contract:

```ts
interface IntelligenceLaneSelector {
  selectLane(input: {
    workload: WorkloadClass;
    allowExternal: boolean;
    requireLocal: boolean;
    requireStructuredOutput: boolean;
  }): SelectedLane;
}
```

The selector should:

- consult capability metadata
- consult lane health
- consult operator policy
- choose the minimum sufficient healthy layer
- expose fallback metadata for logs and UI

It should **not**:

- synthesize natural-language reasoning about which lane to use
- duplicate business logic from individual subsystems

### 3. One Bundled Runtime Manager For Layer 1

Layer 1 should be implemented behind one runtime-management abstraction.

Suggested conceptual responsibilities:

- asset discovery or download
- checksumming
- helper-process lifecycle
- health checks
- restart behavior
- model metadata
- operator-visible degraded status

This manager should expose Layer 1 as a normal provider-like endpoint to the rest of the app.

That lets the rest of the runtime treat Layer 1 as:

- selectable
- health-checked
- observable
- replaceable later if the backend changes

without coupling the broader system to `llama.cpp` implementation details.

### 4. One Managed Built-in Provider Path For Layer 2

BitNet should be integrated as one built-in managed provider/lane with explicit capability metadata.

That means:

- it participates in the same health model as other providers
- it participates in the same selection model as other lanes
- it does not require a one-off routing system just for BitNet
- it is bundled and shipped with the app rather than requiring a separate operator install

The difference between Layer 1 and Layer 2 is not the existence of separate orchestration frameworks. The difference is:

- Layer 1 is bundled and survival-oriented
- Layer 2 is stronger for bounded structured decisions

### 5. Keep Existing General-Assistant Paths Intact

Layer 3 and Layer 4 should continue to use the ordinary provider stack and failover mechanisms where appropriate.

The selector should choose among them, but their core provider behavior should not be reinvented.

This means the main structural changes are:

- better capability metadata
- better locality handling
- better workload selection

not a complete rewrite of the general assistant architecture.

## Safety Constraints

To keep the implementation safe and understandable, the following boundaries are mandatory.

### Layer 0 Must Remain Independent

Layer 0 must continue to function when all LLM lanes are unavailable.

It must not depend on:

- Layer 1 helper availability
- BitNet availability
- Ollama availability
- internet access

### Layer 1 Must Be Isolated

Layer 1 should run behind a helper-process boundary.

Reasons:

- clearer failure handling
- better crash isolation
- simpler health checks
- cleaner operator diagnostics
- easier replacement of backend internals later

### Layer 2 Must Not Be Tunneled Through Ollama

BitNet must remain a distinct runtime/provider lane.

It must not be represented as:

- "just another Ollama model"
- "the same local lane but with a different label"

That would collapse failure domains and undermine the architecture.

### Layer 1 And Layer 2 Are Both Guardian-Managed Built-ins

Layer 1 and Layer 2 should both be:

- shipped with the application distribution
- versioned by Guardian
- checksummed by Guardian
- started and supervised by Guardian at startup
- surfaced in Guardian diagnostics as built-in local intelligence components

Operators should not need to install them separately.

### Selection Logic Must Be Centralized

If layer selection is reimplemented inside each subsystem, the architecture will become inconsistent and fragile.

Therefore:

- Intent Gateway
- Guardian Agent
- Sentinel
- workflow instruction steps
- general assistant loops

should all consume the same selector contract, even if they ask for different workload classes.

## Preferred Routing Policy

The initial routing policy should be:

| Workload | Preferred route | Fallback route | Final fallback |
|----------|------------------|----------------|----------------|
| `deterministic` | Layer 0 | none | none |
| `decision_json` | Layer 2 | Layer 1 | Layer 0 deterministic floor |
| `general_tools` | Layer 3 or Layer 4 | the other of Layer 3/4 if allowed | fail/degrade |
| `general_chat` | Layer 3 or Layer 4 | the other of Layer 3/4 if allowed | Layer 1 only for short degraded guidance |

Important guardrails:

- Layer 1 should not become a default tool-calling lane
- Layer 2 should not become a general chat lane
- Layer 0 should not become a fake natural-language classifier

## Why This Is Not Overcomplicated

This design stays manageable because it introduces only a small number of new core concepts:

1. one workload classification vocabulary
2. one lane capability model
3. one lane selector
4. one bundled runtime manager

Everything else builds on existing structures:

- current deterministic runtime
- current provider registry
- current failover model
- current Intent Gateway and Guardian/Sentinel integrations

The complexity is therefore **architectural separation**, not **subsystem multiplication**.

## Layer 0 Detailed Capability Contract

The question "what is Layer 0 actually good for?" has a concrete answer.

Layer 0 should be formally responsible for:

### Security enforcement

- sandbox enforcement
- domain/path/command policy enforcement
- approval requirements
- native security provider invocation
- trust and integrity checks

### Deterministic automation execution

- tool steps
- delay steps
- cron runs
- event-triggered runs
- deterministic resume from checkpoints

### Explicit control-plane actions

- enable / disable providers
- enable / disable automations
- stop active runs
- restart local helper runtimes
- export diagnostics
- rotate or validate credentials where the workflow is already structured

### Continuity, context, and bounded resume substrate

- continuity-thread bookkeeping across linked first-party surfaces
- pending-action transfer-policy enforcement
- shared context assembly for main chat, coding-session chat, and brokered workers
- incremental structured memory flush during compaction
- routing-trace and run-timeline correlation metadata

### Heuristic survival-mode analysis

- threshold-based anomaly detection
- rules over audit history
- predeclared incident signatures
- deterministic scoring and escalation

Layer 0 is not "useless without an LLM." It is the runtime floor that keeps Guardian:

- safe
- recoverable
- schedulable
- operable

## Observability And UI Semantics

Guardian should surface the active intelligence ring in metadata and operator UI.

Suggested labels:

- `layer0_deterministic`
- `layer1_survival`
- `layer2_decision`
- `layer3_local_general`
- `layer4_external`

Operators should be able to see:

- which layer handled a request
- whether fallback occurred
- whether the response was degraded
- whether the active lane was bundled, operator-provided, or remote

## Configuration Direction

Suggested conceptual config:

```yaml
assistant:
  intelligence:
    layer0:
      enabled: true

    layer1:
      enabled: true
      backend: llama_cpp_helper
      modelTier: small
      shippedWithApp: true
      allowIntegratedGpu: true

    layer2:
      enabled: true
      backend: bitnet_helper
      shippedWithApp: true

    layer3:
      enabled: true
      provider: ollama

    layer4:
      enabled: true
      providers:
        - openai_primary
        - anthropic_primary
```

This is not a final config schema. It defines the intended conceptual model.

## Packaging And Startup Model

Guardian should treat Layer 1 and Layer 2 as first-party shipped intelligence components.

### Application Distribution

The application distribution should include:

- Layer 1 runtime binary or helper assets
- Layer 1 bundled survival model
- Layer 2 BitNet runtime binary or helper assets
- Layer 2 bundled BitNet decision model
- startup wiring and health-check configuration for both

This applies to:

- standard packaged app distributions
- local packaged builds
- Windows portable distributions

### Startup Behavior

At startup, Guardian should:

1. initialize Layer 0 immediately
2. launch Layer 1 helper runtime
3. launch Layer 2 BitNet helper runtime
4. run health checks for both
5. mark each lane as `healthy`, `degraded`, or `unavailable`
6. expose that state to the selector and to operator diagnostics

Startup must not require:

- external downloads in the normal bundled path
- separate user-managed runtime installs
- Ollama to be present

### Windows Portable Packaging

The Windows portable packaging flow should stage and ship:

- the normal Guardian runtime payload
- `guardian-sandbox-win.exe`
- Layer 1 helper runtime and bundled model assets
- Layer 2 BitNet helper runtime and bundled model assets
- startup scripts and config that know how to launch and supervise both

The portable build should therefore remain a single extract-and-run distribution, with no separate BitNet or `llama.cpp` installation step.

## Implementation Consequences For The Current Repo

Primary changes required:

1. Stop conflating `ollama` with `local` in:
   - `src/index.ts`
   - `src/runtime/model-routing-ux.ts`
   - `src/config/loader.ts`
   - `src/runtime/credentials.ts`

2. Add explicit structured-output support to:
   - `src/llm/types.ts`
   - provider implementations

3. Add a Layer 1 managed runtime component for:
   - bundled `llama.cpp` helper lifecycle
   - model asset management
   - health checks
   - restart logic

4. Add a Layer 2 managed provider path for:
   - bundled BitNet runtime lifecycle
   - bundled BitNet model asset management
   - workload routing for bounded decision tasks

5. Expand Guardian / Sentinel provider modes from:
   - `local`
   - `external`
   - `auto`

   to a model that can distinguish:
   - `survival`
   - `local_decision`
   - `local_general`
   - `external`
   - `auto`

6. Preserve the Intent Gateway rule that top-level natural-language understanding remains LLM-routed in normal operation.

## Rollout Order

### Phase 1

- implement Layer 0 semantics explicitly
- add capability metadata
- remove `ollama == local` assumptions

### Phase 2

- add Layer 1 bundled `llama.cpp` survival runtime
- use tiny bundled model
- route degraded bounded tasks to it

### Phase 3

- add Layer 2 bundled BitNet decision lane
- route Intent Gateway, Guardian inline evaluation, continuity-sensitive blocker judgments, and Sentinel audit to it when healthy

### Phase 4

- refine Layer 3 and Layer 4 routing rules
- add optional `ONNX Runtime GenAI` backend if Windows acceleration becomes a priority

## Naming

This architecture is called **Intelligence In Depth** because it applies the same principle as defense in depth:

- do not rely on one mechanism
- do not put all trust in one runtime
- preserve useful operation across multiple failure modes
- keep stronger outer layers without sacrificing inner resilience

## Decision

Guardian's target layered intelligence architecture is:

1. **Layer 0:** deterministic runtime and enforcement
2. **Layer 1:** built-in `llama.cpp` survival lane
3. **Layer 2:** BitNet local decision lane
4. **Layer 3:** Ollama local general-assistant lane
5. **Layer 4:** external providers

That is the canonical model going forward.
