# Guardian-Native Local Model Advisor & Guarded Bootstrap Proposal

**Status:** Proposed
**Date:** 2026-03-18
**Informed by:**
- [huggingface/hf-agents](https://github.com/huggingface/hf-agents)
- [llmfit](https://github.com/AlexsJones/llmfit)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [Configuration Center Spec](../specs/CONFIG-CENTER-SPEC.md)
- [Setup Status Runtime](../../src/runtime/setup.ts)
- [Provider Registry](../../src/llm/provider-registry.ts)

---

## Executive Summary

GuardianAgent should not integrate `huggingface/hf-agents` directly.

`hf-agents` is a useful proof of demand for a real operator problem: users do not know which local model they can run, which quant to pick, or how to wire a local inference backend into an agent workflow quickly. But the repo itself is the wrong integration shape for GuardianAgent:

- it is a Bash-first Hugging Face CLI extension
- it assumes an interactive TTY flow
- it auto-installs dependencies through Homebrew, npm, and `curl | sh`
- it rewrites Pi configuration under `~/.pi/agent`
- it launches an external coding agent runtime that would bypass Guardian's approvals, audit, trust, and tool governance

The correct move is to build a **Guardian-native Local Model Advisor** inside the existing Config Center and provider setup flows.

This proposal adds:

1. **Read-only local model recommendations** informed by hardware detection and existing local runtimes
2. **Optional `llama.cpp` provider support** as a first-class local provider family
3. **Guarded local runtime bootstrap** for already-installed local inference backends
4. **Approval-gated config mutation and downloads** instead of opaque shell bootstrap behavior

The result is a better version of the useful part of `hf-agents` without importing its runtime, trust, or packaging assumptions.

---

## Problem

GuardianAgent already supports local and external provider routing, but local model onboarding is still operator-heavy:

- operators must already know which local runtime they want
- operators must guess which model size or quant will fit their machine
- operators must map model choice to runtime-specific config themselves
- the Config Center can save provider settings, but it does not currently advise on *what* local model to run

This creates friction precisely where GuardianAgent should be strongest: safe local-first deployment.

The `hf-agents` repo demonstrates that there is real value in one workflow:

1. inspect hardware
2. recommend viable local models
3. let the operator choose
4. boot a local inference backend
5. attach the agent to that backend

GuardianAgent should offer that workflow natively, but in a way that preserves its runtime control plane.

---

## Why Not Integrate `hf-agents` Directly

### Architectural mismatch

GuardianAgent is a runtime-owned orchestration system. Approval, audit, trust classification, sandboxing, and tool execution are supervisor concerns. `hf-agents` is a thin bootstrap script that launches a separate agent runtime (`Pi`) after doing local setup work.

That means a direct dependency would move the most important part of the operator workflow outside Guardian's control.

### Security mismatch

`hf-agents` currently:

- installs prerequisites with Homebrew
- installs `llmfit` via `curl | sh`
- installs Pi globally via npm
- rewrites `~/.pi/agent/models.json`
- runs an external coding agent with its own config and lifecycle

Those are all in tension with GuardianAgent's model:

- config changes should go through backend-owned apply flows
- risky actions should be explicit and approval-gated
- global installs should not be hidden inside helper scripts
- coding work should stay inside Guardian's own Coding Assistant and tool policy

### UX mismatch

`hf-agents` assumes:

- a local interactive shell
- TTY prompts and keypress handling
- `fzf`
- a Hugging Face CLI extension entrypoint

GuardianAgent's primary setup surface is the Config Center, not an interactive shell wizard. The operator experience must work in the web UI and remain coherent with CLI commands and setup status endpoints.

### Maintenance mismatch

`hf-agents` is currently a very small project. That is fine for a narrow helper, but it is not a strong foundation for a core dependency in GuardianAgent.

---

## Goals

- reduce operator guesswork for local model selection
- preserve Guardian's approval, audit, and trust model end to end
- integrate with the existing Config Center and `POST /api/setup/apply` flow instead of introducing a parallel setup wizard
- support both existing Ollama flows and an optional `llama.cpp` path
- make local runtime state visible in setup status and provider health
- keep downloads, installs, and runtime starts explicit and reviewable

## Non-Goals

- do not import `hf-agents` as a dependency or subprocess-managed external agent runtime
- do not launch Pi or any non-Guardian coding agent
- do not auto-run Homebrew, npm global installs, or `curl | sh` in the background
- do not replace the Config Center with a new wizard model
- do not silently download models or start daemons without explicit operator action

---

## Product Shape

### Operator Experience

The feature lives inside **Config Center > AI Provider Configuration**, specifically the local provider panel.

Proposed flow:

1. Operator opens the local provider panel.
2. Operator clicks **Recommend Local Models**.
3. Guardian gathers a hardware and runtime snapshot:
   - local CPU/GPU/RAM summary
   - Ollama availability and installed tags
   - `llama-server` availability and health, if configured
   - optional `llmfit` availability
4. Guardian returns ranked local options with backend, model family, quant, expected fit, and whether the option requires a download.
5. Operator selects an option.
6. Guardian shows the exact mutation plan before any change happens:
   - create or update provider profile
   - set default provider or not
   - start local runtime or not
   - download model or not
7. If the plan includes mutating or networked actions, Guardian requests approval.
8. Guardian applies the provider profile through existing config flows and verifies runtime health.
9. Setup status and provider inventory update immediately.

This is not a separate setup wizard. It is a recommendation and guarded apply flow embedded in the current configuration model.

### `hf-agents` Concept Mapping

| `hf-agents` behavior | Guardian-native replacement |
|----------------------|-----------------------------|
| Hugging Face CLI extension entrypoint | Config Center action + backend API |
| Interactive `fzf` model picker | Structured recommendations in web UI and CLI |
| `llmfit recommend --json` | Optional advisor backend input |
| Launch `llama-server` ad hoc | Managed local runtime with approval and health checks |
| Rewrite Pi config | Write Guardian provider config via existing apply flow |
| Launch Pi coding agent | Reuse Guardian Coding Assistant |

---

## Proposed Architecture

### 1. Local Model Advisor Service

Add a new runtime service responsible for recommendation generation and normalization.

**Candidate file:**

`src/runtime/local-model-advisor.ts`

Responsibilities:

- detect available local runtimes and local provider profiles
- detect local hardware characteristics using approved read-only probes
- call `llmfit` when available and configured
- normalize external tool output into Guardian-owned recommendation objects
- fall back to Guardian heuristics when `llmfit` is unavailable

Suggested output shape:

```ts
export interface LocalModelRecommendation {
  id: string;
  backend: 'ollama' | 'llama-cpp';
  source: 'llmfit' | 'guardian-heuristic';
  displayName: string;
  modelRef: string;
  quant?: string;
  fit: 'excellent' | 'good' | 'fair' | 'unknown';
  estimatedRamGiB?: number;
  estimatedTokensPerSecond?: number;
  installed: boolean;
  requiresDownload: boolean;
  notes: string[];
}

export interface LocalModelAdvisorResult {
  detectedHardware: {
    cpu?: string;
    ramGiB?: number;
    gpu?: string;
  };
  runtimes: {
    ollama: { available: boolean; running: boolean; models: string[] };
    llamaCpp: { available: boolean; running: boolean; port?: number };
    llmfit: { available: boolean; version?: string };
  };
  recommendations: LocalModelRecommendation[];
}
```

### 2. Optional `llama-cpp` Provider Family

Guardian already treats loopback and private endpoints as local for routing. That means a local OpenAI-compatible endpoint fits naturally into the existing locality model. But overloading a generic `openai` provider with local `llama-server` semantics is confusing in the UI and config.

Add a first-class provider family:

- `provider: 'llama-cpp'`

This provider can internally reuse the existing `OpenAIProvider` transport, but it gives Guardian a clear operator-facing concept for local GGUF-backed inference.

**Candidate files:**

- `src/llm/llama-cpp.ts`
- `src/llm/provider-registry.ts`
- `src/config/types.ts`
- `web/public/js/pages/config.js`

This unlocks a direct path from `llmfit` recommendations to a usable Guardian provider profile.

### 3. Managed Local Runtime

Add an optional runtime manager for local `llama-server` processes.

**Candidate file:**

`src/runtime/local-inference-manager.ts`

Responsibilities:

- validate runtime configuration
- start `llama-server` only after explicit approval where required
- bind to loopback by default
- record logs to Guardian-owned paths
- health check `/health` and `/v1/models`
- expose process state to setup status and provider inventory
- stop or restart the managed server cleanly

This is intentionally narrower than `hf-agents`.

It does **not**:

- install Homebrew
- install npm packages globally
- rewrite third-party agent config
- launch another agent runtime

### 4. Reuse Existing Setup/Config Flows

The local advisor should extend the current Config Center and setup API surfaces, not compete with them.

Existing surfaces to reuse:

- `GET /api/setup/status`
- `POST /api/setup/apply`
- provider inventory and default-provider endpoints

New API surfaces:

- `GET /api/local-models/status`
- `POST /api/local-models/recommend`
- `POST /api/local-models/apply`

`POST /api/local-models/apply` should internally produce the same config mutation path as `POST /api/setup/apply`, with extra approval handling when the plan includes starting a runtime or downloading a model.

### 5. Config Additions

Add a small configuration surface for local-model setup behavior.

Possible shape:

```ts
interface LocalModelSetupConfig {
  enabled?: boolean;
  advisor?: {
    preferLlmfit?: boolean;
    llmfitPath?: string;
  };
  llamaCpp?: {
    enabled?: boolean;
    binaryPath?: string;
    port?: number;
    autostart?: boolean;
    modelsRoot?: string;
  };
}
```

This should sit under a runtime- or assistant-scoped config section rather than being scattered across unrelated fields.

---

## Recommendation Sources

### Mode A: Guardian heuristics

This is the baseline and should always exist.

Inputs:

- installed Ollama tags
- configured local providers
- machine RAM and CPU/GPU summary
- known safe default suggestions by use case

Advantages:

- no external dependency
- deterministic
- easy to test

Limitations:

- weaker fit scoring
- less precise quant guidance

### Mode B: Optional `llmfit`

If `llmfit` is available, Guardian can call it in read-only mode and normalize the result.

Advantages:

- much better hardware-fit ranking
- direct GGUF candidate data
- real value from the `hf-agents` ecosystem without importing its runtime

Limitations:

- extra external tool dependency
- output schema must be normalized and version-tolerant

### Decision

Guardian should support both modes:

- **default:** heuristic mode, always available
- **enhanced:** `llmfit` mode when installed and explicitly enabled

This avoids turning local setup into an all-or-nothing external dependency.

---

## Security and Trust Model

This feature only fits Guardian if it obeys Guardian's rules.

### Read-only stages

The following actions are low-risk and can be treated as read-only discovery:

- inspect system RAM / CPU / GPU facts
- check whether Ollama is reachable
- list installed Ollama models
- probe whether `llama-server` is running
- call `llmfit recommend --json` when installed

These should still be audited, but they do not need the same approval path as mutation.

### Mutating stages

The following actions must be explicit and approval-gated:

- start `llama-server`
- stop or restart a managed local runtime
- download a model
- write or update provider profiles
- change the default provider
- alter runtime-managed local model directories

### Guardrails

- no hidden package-manager bootstrapping
- no `curl | sh`
- no global npm installs from the advisor flow
- no writes outside Guardian-owned config/runtime paths unless separately approved
- loopback-only bind for managed local inference by default
- model metadata from remote catalogs remains low-trust until validated and approved
- every apply plan is rendered to the operator before execution

### Audit Events

Add explicit audit event types such as:

- `local_model_recommendation_requested`
- `local_model_recommendation_generated`
- `local_model_apply_requested`
- `local_model_runtime_started`
- `local_model_runtime_failed`
- `local_model_download_requested`
- `local_model_download_blocked`

---

## Phased Delivery Plan

### Phase 1: Recommendation + Config Integration

Deliver the useful core first:

- add `LocalModelAdvisorService`
- surface recommendations in Config Center
- support heuristic mode and optional `llmfit`
- let the operator apply a recommendation into existing provider config
- no managed downloads yet
- no managed `llama-server` lifecycle yet

This phase already solves the biggest onboarding problem: choosing a viable local setup.

### Phase 2: First-Class `llama-cpp` Provider + Managed Runtime

- add `provider: 'llama-cpp'`
- add managed local runtime lifecycle for preinstalled `llama-server`
- expose health and model inventory in provider status
- support guarded start/stop from Config Center

This phase makes `llmfit` recommendations operationally useful for GGUF users.

### Phase 3: Approved Download Plans

- add explicit download planning for model fetches
- require operator approval before any networked download
- store models in Guardian-managed local directories
- verify checksums where possible

This phase should only ship after the first two are stable.

---

## Implementation Targets

Likely files to touch:

- `src/runtime/local-model-advisor.ts` — new recommendation engine
- `src/runtime/local-inference-manager.ts` — managed `llama-server` lifecycle
- `src/llm/llama-cpp.ts` — OpenAI-compatible local provider wrapper
- `src/llm/provider-registry.ts` — register `llama-cpp`
- `src/config/types.ts` — local model setup config
- `src/runtime/setup.ts` — extend readiness visibility
- `src/index.ts` — wire APIs and runtime bootstrap
- `src/channels/web.ts` — expose endpoints
- `web/public/js/api.js` — new API methods
- `web/public/js/pages/config.js` — local recommendation UI

---

## Test Plan

### Unit tests

- recommendation normalization for `llmfit` JSON
- heuristic fallback ranking
- apply-plan generation
- config patch generation for local providers
- runtime status mapping into setup status

### Integration tests

- fake `llmfit` output fixture -> recommendation API
- fake `llama-server` health endpoint -> managed runtime status
- apply local provider recommendation -> config persists and runtime hot-reloads

### Smoke tests

- existing Ollama install, no `llmfit`
- existing Ollama install with `llmfit`
- preinstalled `llama-server` with loopback bind
- strict sandbox mode with no strong backend available

---

## Open Questions

1. Should `llmfit` be operator-installed only in v1, or should Guardian eventually offer an approval-gated helper to install it?
2. Should Phase 2 ship a first-class `llama-cpp` provider, or is a local OpenAI-compatible profile sufficient as an interim step?
3. Should model downloads be a Guardian runtime concern at all, or should v3 remain recommendation-only and defer actual downloads to operator-run commands?
4. Do we want recommendation modes per use case such as `chat`, `coding`, `automation`, and `guardian-evals`?

---

## Recommendation

Proceed with this work, but as a **Guardian-native phased feature**, not an `hf-agents` integration.

The core idea is strong:

- help operators pick local models that actually fit their machine
- make local inference setup easier
- keep everything inside Guardian's approval and audit boundaries

The implementation should deliberately reject the parts of `hf-agents` that do not match GuardianAgent's architecture:

- no Pi launch
- no third-party config rewriting
- no hidden installers
- no TTY-only UX

This gives GuardianAgent the practical upside of `hf-agents` while staying aligned with the project's security-first runtime model.
