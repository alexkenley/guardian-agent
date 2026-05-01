# Offline Survival And Decision Lane Proposal

**Status:** Proposed
**Date:** 2026-03-29
**Detailed design target:** [Intelligence In Depth Specification](../design/INTELLIGENCE-IN-DEPTH-DESIGN.md)
**Supersedes:**
- `BitNet CPU Decision Lane Proposal` (removed)
- `Built-in BitNet Model Proposal` (removed)

**Informed by:**
- [Agentic Defensive Security Suite - As-Built Spec](../design/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md)
- [Orchestration Specification](../design/ORCHESTRATION-DESIGN.md)
- [Intent Gateway](../../src/runtime/intent-gateway.ts)
- [Provider Registry](../../src/llm/provider-registry.ts)
- [LLM Types](../../src/llm/types.ts)
- [Ollama Provider](../../src/llm/ollama.ts)
- [OpenAI Provider](../../src/llm/openai.ts)
- [Runtime Model Routing UX](../../src/runtime/model-routing-ux.ts)
- [Sentinel / Guardian Agent](../../src/runtime/sentinel.ts)
- <https://github.com/ggml-org/llama.cpp>
- <https://github.com/withcatai/node-llama-cpp>
- <https://github.com/microsoft/onnxruntime-genai>
- <https://github.com/microsoft/BitNet>
- <https://github.com/microsoft/T-MAC>
- <https://github.com/mlc-ai/mlc-llm>
- <https://github.com/nomic-ai/gpt4all>
- <https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct>
- <https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct>
- <https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF>
- <https://huggingface.co/microsoft/bitnet-b1.58-2B-4T>

---

## Executive Summary

GuardianAgent should separate two related but different needs:

1. an **absolute offline survival lane** that keeps the product minimally functional when:
   - the network is unavailable
   - all external APIs are unavailable
   - Ollama is unavailable
   - the operator wants zero extra runtime dependencies
2. a **stronger optional local decision lane** for bounded structured tasks such as:
   - Intent Gateway classification
   - Guardian Agent inline security evaluations
   - Sentinel retrospective audit analysis
   - other JSON-only classifiers

Those two needs should not be collapsed into one BitNet-only design.

The recommended product shape is:

- **Layer 0:** deterministic no-LLM safe mode
- **Layer 1:** bundled tiny offline local model, shipped with GuardianAgent
- **Layer 2:** optional stronger local decision provider such as BitNet
- **Layer 3:** existing general-purpose assistant providers such as Ollama and external APIs

The key recommendation is:

- use a **cross-platform llama.cpp-family runtime** for the built-in survival lane
- keep **ONNX Runtime GenAI** as a strong optional backend, especially for Windows + DirectML / integrated GPU acceleration
- keep **BitNet** as an optional specialized decision lane rather than the mandatory built-in fallback

If Guardian bundles a local model at all, it should bundle a very small model that is:

- license-friendly to redistribute
- reliable enough for short structured JSON tasks
- small enough to ship or download once without creating a major packaging burden

That points first to a tiny `SmolLM2`-class or similar bundled fallback, not a mandatory BitNet runtime as the only offline story.

---

## Problem

GuardianAgent currently assumes that "intelligence" comes from one of:

- Ollama
- another local provider managed outside the app
- a cloud provider

That leaves a resilience gap in exactly the paths Guardian cares about most:

- intent routing
- inline security judgment
- audit analysis
- degraded operator guidance

The current architecture also has a second problem: it still treats `ollama` as effectively synonymous with `local` in several runtime paths.

That creates three risks:

1. **Availability risk**
   If the network is down and Ollama is unavailable, Guardian loses LLM-dependent behavior.

2. **Independence risk**
   If the backup lane depends on the same Ollama process, model store, or HTTP path as the main local lane, it is not a real backup.

3. **Routing risk**
   Guardian does not yet model provider capabilities precisely enough to distinguish:
   - tool-calling assistant providers
   - structured-output local classifiers
   - emergency degraded fallback models

---

## Goals

1. Allow GuardianAgent to run in a limited but useful state with no internet access.
2. Avoid requiring Ollama for the built-in emergency lane.
3. Keep the built-in lane small enough to run on CPU-only machines.
4. Opportunistically support integrated GPU acceleration where the runtime makes that practical.
5. Preserve stronger local or cloud providers for the main assistant loop.
6. Add a clean optional path for BitNet or similar specialized CPU decision runtimes.
7. Improve local provider routing so it is capability-aware rather than provider-name-aware.

## Non-Goals

1. Do not replace the main assistant model with a tiny bundled model.
2. Do not force BitNet to be the one true built-in local runtime.
3. Do not make the emergency lane depend on Ollama-managed models.
4. Do not route complex tool orchestration or coding work to the survival lane.
5. Do not treat all OpenAI-compatible local endpoints as interchangeable.

---

## Core Recommendation

Guardian should implement **three local resilience layers**, not one:

### Layer 0: Deterministic Safe Mode

This is the final safety floor when no model is available or the built-in model fails health checks.

Allowed behavior:

- fixed safe failure messages
- strict deny-by-default for risky actions
- limited rule-based fallback routing only where that does not violate the Intent Gateway architecture
- operator guidance such as "external providers unavailable; local survival lane offline"

Important constraint:

- this layer must **not** become an excuse to bypass the Intent Gateway design for normal operation
- it exists only as the last-resort degraded path

### Layer 1: Built-in Offline Survival Model

This is the first actual bundled LLM lane.

Responsibilities:

- intent classification when stronger providers are unavailable
- Guardian Agent inline allow/deny classification
- Sentinel audit summarization in a degraded bounded mode
- compact operator guidance

Constraints:

- no dependency on Ollama
- no dependency on internet access
- short context only
- strict JSON or constrained-output only
- no general-purpose tool-calling expectations

### Layer 2: Optional Stronger Local Decision Lane

This is where BitNet belongs.

Responsibilities:

- faster or more capable CPU-oriented structured decision work
- bounded JSON-only tasks
- optional operator-installed or Guardian-managed advanced local lane

Candidate runtimes:

- BitNet
- T-MAC-backed low-bit local stacks
- stronger llama.cpp-served models
- ONNX Runtime GenAI model packs

### Layer 3: Main Assistant Providers

This remains the current general-purpose lane:

- Ollama
- Anthropic
- OpenAI
- other configured providers

Responsibilities:

- tool calling
- general chat
- coding work
- browser / workspace / email orchestration

---

## Why The Built-in Survival Lane Must Not Reuse Ollama

It is tempting to say "just use whatever model Ollama already has." That is the wrong shape for the absolute backup lane.

Reasons:

1. **Shared failure domain**
   If Ollama is down, misconfigured, corrupted, blocked, or attacked, the backup lane goes down too.

2. **Shared trust boundary**
   A true fallback should not depend on the same process, store, or API surface as the primary local assistant runtime.

3. **Runtime mismatch**
   BitNet is not a generic acceleration layer for arbitrary Ollama models. It is a specialized runtime for specific model families and low-bit workflows.

4. **Operator clarity**
   The product should expose three distinct concepts:
   - bundled survival model
   - optional local decision engine
   - primary assistant provider

For users who rely only on external APIs today, the optional decision lane should work exactly as an ordinary local provider configuration:

- the user downloads the runtime and model
- the user points Guardian at it through provider configuration
- Guardian routes the right workloads to it if healthy

---

## Runtime Comparison

## Primary Options

| Option | What it is | Best fit | Strengths | Weaknesses | Recommendation |
|--------|------------|----------|-----------|------------|----------------|
| Vendored `llama.cpp` helper | Ship `llama.cpp` binaries with Guardian and run a managed helper process | Default built-in cross-platform fallback | MIT, broad hardware support, huge GGUF ecosystem, simple HTTP/process boundary, grammar-based JSON constraints, strong isolation story | Need to ship binaries per platform, separate process lifecycle, helper protocol and health logic required | **Recommended default architecture** |
| `node-llama-cpp` | Node.js bindings around `llama.cpp` | Tight TypeScript integration for local inference | MIT, prebuilt bindings, direct Node integration, JSON/schema support, tool/function features, broad hardware support | In-process native addon risk unless wrapped in worker/helper process, Node ABI/runtime packaging complexity | **Strong alternative if tighter TS integration is preferred** |
| `ONNX Runtime GenAI` | Generative inference layer on top of ONNX Runtime | Windows-heavy installs, DirectML / integrated GPU acceleration, model packs already published in ONNX | MIT, strong Windows story, constrained decoding, CPU + DirectML + OpenVINO + QNN support, excellent fit for iGPU/NPU acceleration | Cross-platform packaging is less uniform, model availability is narrower than GGUF, more backend/model specific | **Recommended as optional backend, not sole default** |

## Detailed Comparison: `llama.cpp` / `node-llama-cpp` vs `ONNX Runtime GenAI`

### 1. Cross-Platform Coverage

`llama.cpp` wins for broad, consistent cross-platform support today.

Why:

- the project is explicitly designed for wide local deployment
- it supports CPU-first inference across common desktop/server targets
- it supports Metal, Vulkan, CUDA, HIP, SYCL and hybrid CPU+GPU execution
- the GGUF ecosystem is now the default local-model interchange format in practice

`node-llama-cpp` inherits this advantage and makes it easier to consume from a TypeScript codebase.

`ONNX Runtime GenAI` is strong, but not equally frictionless across the same matrix:

- it is excellent on Windows
- it can take advantage of DirectML and other platform accelerators
- but the packaging story is more backend-specific and model-pack-specific
- its strongest story is not "one portable local model format everywhere"

Conclusion:

- if Guardian wants one default built-in backend across Windows, macOS, and Linux, prefer the `llama.cpp` family first

### 2. Packaging And Distribution

For Guardian, "built into the app" really means one of two things:

1. ship a managed helper binary with the product
2. ship native bindings and load them from Node

The managed-helper `llama.cpp` route is operationally cleaner:

- crash isolation is better
- restarts are easier
- health checks are explicit
- the trust boundary is clearer
- the app can supervise the helper like any other hardened local service

`node-llama-cpp` is still attractive because:

- this repo is already Node/TypeScript
- it avoids inventing a bespoke HTTP integration layer
- it exposes structured-output controls directly

But the in-process story is weaker from a resilience standpoint. If used, it should ideally still run inside a dedicated worker or helper boundary.

`ONNX Runtime GenAI` is viable, but the packaging tradeoff is different:

- the runtime is solid
- the model packs are more curated and backend-specific
- selecting and bundling the right ONNX assets per target is more opinionated

Conclusion:

- if the main criterion is **cleanest built-in product distribution**, prefer a vendored `llama.cpp` helper
- if the main criterion is **fastest TypeScript implementation path**, prefer `node-llama-cpp`
- if the main criterion is **Windows-specific hardware acceleration**, add `ONNX Runtime GenAI`

### 3. CPU And Integrated GPU Story

For CPU-only fallback, all three options are viable.

For integrated graphics:

- `llama.cpp` supports Apple Metal and multiple GPU backends, and can do CPU+GPU hybrid inference
- `node-llama-cpp` inherits those backend capabilities from `llama.cpp`
- `ONNX Runtime GenAI` has the strongest Windows-specific acceleration path because it can ride ONNX Runtime execution providers such as DirectML and OpenVINO

Conclusion:

- for a general cross-platform fallback, `llama.cpp` is still the safer base
- for Windows machines where integrated GPU acceleration matters, `ONNX Runtime GenAI` is the strongest optional backend

### 4. Structured Output And Guardian Fit

Guardian's survival and decision lanes care less about prose quality and more about:

- short prompts
- strict JSON
- low latency
- bounded classifications

All three options can support this shape, but they do so differently.

`llama.cpp`:

- grammar-constrained output is mature
- `llama-server` exposes an OpenAI-compatible route
- this maps well to Guardian's current provider abstraction

`node-llama-cpp`:

- gives the cleanest direct Node integration for structured output
- can enforce JSON and JSON-schema-like generation constraints
- is likely the fastest route for a native TS provider implementation

`ONNX Runtime GenAI`:

- supports constrained decoding
- is technically a strong fit for bounded JSON tasks
- but the runtime/model pairing is more curated and less generic than GGUF

Conclusion:

- for the repo as it exists today, the `llama.cpp` family is the easiest architectural fit

### 5. Model Ecosystem

`llama.cpp` / GGUF has the broadest practical local-model ecosystem.

That matters because Guardian wants multiple tiers:

- tiny bundled fallback
- optional better-quality local pack
- optional BitNet or low-bit decision engine

`ONNX Runtime GenAI` is stronger when you deliberately choose curated ONNX packs, especially Microsoft-published ones, but it is not the broadest local-model marketplace.

Conclusion:

- if model optionality matters, prefer `llama.cpp`
- if curated Windows-optimized packs matter, add `ONNX Runtime GenAI`

### 6. Security And Failure Isolation

For a survival lane, crash and compromise isolation matter more than raw convenience.

Best to worst, from a Guardian product perspective:

1. vendored `llama.cpp` helper process
2. `node-llama-cpp` in a dedicated worker/helper boundary
3. `node-llama-cpp` directly in the main app process

`ONNX Runtime GenAI` can also be wrapped in a helper boundary and should be treated the same way.

Conclusion:

- regardless of backend, the built-in lane should be supervised as a dedicated local runtime component

## Secondary Options

| Option | Role | Why it is not the primary bundled fallback |
|--------|------|---------------------------------------------|
| BitNet | Optional stronger CPU decision lane | Great for specialized low-bit structured decision work, but narrower runtime/model ecosystem than `llama.cpp` and not the simplest universal fallback |
| T-MAC | Optional performance accelerator / research direction | Promising for low-bit CPU/NPU inference and broader model classes, but not the simplest first shipping story |
| MLC LLM | Optional future multi-platform compiled backend | Powerful, but more ambitious operationally than needed for the first built-in survival lane |
| GPT4All | Operator-facing local runtime option | Good local ecosystem and OpenAI-like local server, but not the cleanest embedded product runtime story for Guardian itself |

---

## Model Recommendations

Guardian should not bundle a large model by default. The built-in model should optimize for:

- low distribution cost
- low RAM footprint
- fast CPU startup
- acceptable short structured classification quality
- simple redistribution terms

### Recommended Bundled Model Tier

Primary recommendations:

1. `HuggingFaceTB/SmolLM2-360M-Instruct`
2. `HuggingFaceTB/SmolLM2-135M-Instruct`

Why:

- Apache-2.0 licensing is straightforward
- they are explicitly presented as lightweight on-device models
- they are small enough to make a built-in survival lane realistic

Proposed positioning:

- `135M` for ultra-small installs and hard minimum survival mode
- `360M` as the preferred bundled default if packaging budget allows it

### Recommended Optional Better-Quality Local Pack

Primary recommendation:

1. `Qwen/Qwen2.5-0.5B-Instruct-GGUF`

Why:

- Apache-2.0 licensing
- official GGUF availability
- explicitly stronger structured output / JSON behavior than many tiny peers
- good fit for the `llama.cpp` ecosystem

### Recommended Optional CPU Decision Pack

Primary recommendation:

1. `microsoft/bitnet-b1.58-2B-4T`

Why:

- MIT licensing
- purpose-built BitNet runtime support
- strong fit for bounded CPU decision tasks

Important caveat:

- the model card warns against assuming real-world production suitability without additional testing
- that makes BitNet an optional advanced lane, not the mandatory sole built-in fallback

### Windows-Oriented Optional ONNX Packs

Reasonable candidates:

- `microsoft/Phi-3-mini-4k-instruct-onnx`
- `microsoft/Phi-4-mini-instruct-onnx`

These are better suited as optional Windows acceleration packs than as the smallest mandatory bundled fallback because they are heavier than the smallest `SmolLM2`-class options.

---

## Proposed Product Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ GuardianAgent                                               │
│                                                             │
│  Layer 0: Deterministic Safe Mode                           │
│    - deny risky actions when no trusted model is healthy    │
│    - emit degraded operator guidance                        │
│                                                             │
│  Layer 1: Built-in Survival Runtime                         │
│    - tiny bundled local model                               │
│    - helper-managed runtime                                 │
│    - strict JSON only                                       │
│                                                             │
│  Layer 2: Optional Local Decision Runtime                   │
│    - BitNet / stronger local JSON classifier                │
│                                                             │
│  Layer 3: Main Assistant Providers                          │
│    - Ollama / OpenAI / Anthropic / others                   │
└─────────────────────────────────────────────────────────────┘
```

### Recommended Runtime Shape

Guardian should introduce a built-in runtime abstraction that is separate from the ordinary provider registry.

Suggested components:

- `BuiltinSurvivalRuntimeManager`
- `BuiltinSurvivalProvider`
- `BuiltinDecisionProviderSelector`

The built-in survival runtime should support pluggable backends:

- `llama_cpp_helper`
- `node_llama_cpp`
- `onnx_genai`

The optional decision lane should support:

- `bitnet`
- `local_openai_compatible`
- stronger `llama.cpp` packs
- future low-bit runtimes

### Required Capability Metadata

Guardian should extend provider/runtime metadata to describe:

- locality
- supports tools
- supports constrained JSON output
- intended uses
- isolation level
- degraded-use suitability

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

### Required Chat Abstraction Change

Guardian should add explicit structured-output support to `ChatOptions`.

Suggested direction:

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

This is necessary whether the backend is:

- `llama.cpp`
- `node-llama-cpp`
- `ONNX Runtime GenAI`
- BitNet

because Guardian's key built-in workloads are JSON-oriented.

---

## Repo-Level Implications

### 1. Locality Detection Must Stop Treating `ollama` As The Only Local Provider

Current code still has locality assumptions keyed directly to `ollama`, including:

- `src/index.ts`
- `src/runtime/model-routing-ux.ts`
- `src/config/loader.ts`
- `src/runtime/credentials.ts`
- parts of Guardian/Sentinel provider selection

That must be fixed before any non-Ollama local survival or decision lane can behave correctly.

### 2. Guardian / Sentinel Provider Selection Needs A Third Mode

Today the inline Guardian path is effectively:

- `local`
- `external`
- `auto`

It should become something closer to:

- `survival`
- `local_decision`
- `local_general`
- `external`
- `auto`

That allows:

- bundled fallback for emergencies
- BitNet for stronger structured local decisions
- Ollama or similar for broader local assistant work

### 3. Intent Gateway Should Prefer Constrained JSON Over Tool Calls Where Possible

The Intent Gateway already has structured-content fallback parsing. The built-in survival lane should lean into that:

- prefer JSON-schema or grammar-constrained output
- use tool calls only with providers that actually support them well

### 4. The Built-in Lane Should Be Operationally Separate From The Main Assistant Lane

Requirements:

- separate model directory
- separate process or worker boundary
- separate health checks
- no dependency on Ollama model discovery
- checksummed assets
- explicit runtime mode in diagnostics and UI

---

## Configuration Direction

Suggested high-level config:

```yaml
assistant:
  localSurvival:
    enabled: true
    backend: llama_cpp_helper   # or node_llama_cpp / onnx_genai
    modelTier: small            # tiny / small / custom
    modelPath: null
    autoDownload: true
    allowIntegratedGpu: true
    uses:
      - intent_gateway
      - guardian_inline
      - degraded_operator_guidance

  localDecision:
    enabled: false
    provider: bitnet_local
    uses:
      - intent_gateway
      - guardian_inline
      - sentinel_audit
```

The `localDecision` provider can be a standard configured provider entry if Guardian later prefers not to special-case BitNet.

---

## Rollout Plan

### Phase 0: Capability And Routing Prep

1. Add provider capability metadata.
2. Add structured JSON response-format support.
3. Remove remaining `ollama == local` assumptions.
4. Add accurate locality and response-source reporting for non-Ollama local providers.

### Phase 1: Deterministic Safe Mode

1. Add explicit no-LLM survival behavior for:
   - Guardian inline action evaluation
   - degraded operator guidance
   - limited routing failure handling
2. Make this mode visible in logs and UI.

### Phase 2: Built-in Cross-Platform Survival Runtime

Preferred first implementation:

1. Ship a vendored `llama.cpp` helper runtime.
2. Bundle or auto-download a `SmolLM2`-class model.
3. Use it only for:
   - Intent Gateway
   - Guardian inline evaluation
   - degraded operator assistance
4. Keep tool-calling assistant work on ordinary providers.

Alternative first implementation:

1. Use `node-llama-cpp` in a dedicated worker/helper boundary.
2. Expose the same provider interface so the choice remains swappable.

### Phase 3: Optional Windows Acceleration Backend

1. Add `ONNX Runtime GenAI` backend support.
2. Prefer it on Windows when:
   - DirectML is available
   - the operator opts in
   - compatible ONNX packs are present

### Phase 4: Optional Stronger Local Decision Lane

1. Add BitNet or equivalent local decision provider support.
2. Route JSON-only workloads to it when healthy.
3. Keep the main assistant loop on stronger tool-calling providers.

---

## Decision

Guardian should adopt the following direction:

1. **Do create one merged local-resilience proposal.**
2. **Do ship a tiny built-in offline fallback lane.**
3. **Do not make BitNet the mandatory sole built-in runtime.**
4. **Do treat BitNet as an optional stronger local decision lane.**
5. **Do use the `llama.cpp` family as the primary cross-platform baseline.**
6. **Do treat `ONNX Runtime GenAI` as the strongest optional Windows acceleration backend.**

If one primary path must be chosen now, it should be:

- **bundled `llama.cpp` helper + tiny `SmolLM2`-class fallback model**

If one secondary path must be chosen after that, it should be:

- **optional BitNet local decision lane**

If one Windows-specific acceleration path must be added after that, it should be:

- **optional `ONNX Runtime GenAI` backend**

---

## References

- `llama.cpp` repository: <https://github.com/ggml-org/llama.cpp>
- `node-llama-cpp` repository: <https://github.com/withcatai/node-llama-cpp>
- `ONNX Runtime GenAI` repository: <https://github.com/microsoft/onnxruntime-genai>
- Windows ML + ONNX Runtime GenAI documentation: <https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/run-genai-onnx-models>
- `BitNet` repository: <https://github.com/microsoft/BitNet>
- `T-MAC` repository: <https://github.com/microsoft/T-MAC>
- `MLC LLM` repository: <https://github.com/mlc-ai/mlc-llm>
- `GPT4All` repository: <https://github.com/nomic-ai/gpt4all>
- GPT4All local API server: <https://github.com/nomic-ai/gpt4all/wiki/Local-API-Server>
- `SmolLM2-135M-Instruct`: <https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct>
- `SmolLM2-360M-Instruct`: <https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct>
- `Qwen2.5-0.5B-Instruct-GGUF`: <https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF>
- `bitnet-b1.58-2B-4T`: <https://huggingface.co/microsoft/bitnet-b1.58-2B-4T>
- `Phi-3-mini-4k-instruct-onnx`: <https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-onnx>
- `Phi-4-mini-instruct-onnx`: <https://huggingface.co/microsoft/Phi-4-mini-instruct-onnx>
