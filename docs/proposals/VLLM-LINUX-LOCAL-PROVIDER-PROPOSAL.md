# vLLM Linux Local Provider Proposal

**Status:** Proposed
**Date:** 2026-04-14

**Informed by:**
- [Intelligence In Depth Specification](../design/INTELLIGENCE-IN-DEPTH-DESIGN.md)
- [Configuration Center Spec](../design/CONFIG-CENTER-DESIGN.md)
- [WebUI Design Spec](../design/WEBUI-DESIGN.md)
- [Integration Test Harness Guide](../guides/INTEGRATION-TEST-HARNESS.md)
- [Provider Registry](../../src/llm/provider-registry.ts)
- [Provider Metadata](../../src/llm/provider-metadata.ts)
- [OpenAI Provider](../../src/llm/openai.ts)
- [Config Loader](../../src/config/loader.ts)
- [Provider Dashboard Callbacks](../../src/runtime/control-plane/provider-dashboard-callbacks.ts)
- [Config Page](../../web/public/js/pages/config.js)
- <https://github.com/vllm-project/vllm>
- <https://docs.vllm.ai/en/latest/getting_started/installation/gpu/>
- <https://docs.vllm.ai/en/latest/serving/openai_compatible_server/>

---

## Executive Summary

GuardianAgent should add **Linux-only first-class `vllm` support** as a new built-in `local` provider family.

This should **not** be implemented as a bespoke transport client. `vLLM` already exposes an official OpenAI-compatible server surface, and Guardian already has a mature OpenAI-compatible provider path. The right architecture is:

- add `vllm` as a first-class provider type
- classify it as `local`
- default it to a local Linux endpoint such as `http://127.0.0.1:8000/v1`
- implement it by reusing `OpenAIProvider`
- add `vllm`-specific operator guidance, defaults, validation, and test coverage

This gives Guardian a real second local serving family alongside Ollama without pretending all local runtimes are interchangeable.

It also avoids the current UX gap where an operator could technically point `openai` at a self-hosted local `vLLM` endpoint, but Guardian would mislabel that profile as `frontier`, route it incorrectly, and hide the fact that it is actually a local runtime.

---

## Problem

Guardian currently has one first-class local general-assistant runtime family:

- `ollama`

Everything else is modeled as hosted or frontier-facing API access, even though the codebase already supports OpenAI-compatible HTTP endpoints.

That creates three practical problems for `vLLM`:

1. **Wrong locality if configured as `openai + baseUrl`**
   The transport works, but Guardian treats the profile as `frontier` instead of `local`.

2. **Wrong operator model**
   Config Center, runtime provider badges, and routing semantics communicate "hosted API" rather than "local inference server on Linux".

3. **Architecture drift risk**
   If we treat `vLLM` as just a hidden `openai` trick forever, we reinforce exactly the ambiguity the repo has already called out: Guardian should not assume all local OpenAI-compatible endpoints are interchangeable.

---

## Goals

1. Add first-class `vllm` provider support for **Linux-hosted local inference**.
2. Preserve Guardian's current provider-tier architecture: `local`, `managed_cloud`, `frontier`.
3. Reuse the existing OpenAI-compatible client path instead of building a second chat transport.
4. Make `vLLM` visible and understandable in Config Center, CLI, runtime provider reporting, and routing.
5. Support live model discovery through the existing provider dashboard flows.
6. Keep the first phase tightly scoped to chat, tool-calling, and structured-output workloads already represented by `LLMProvider`.

## Non-Goals

1. Do not add native Windows support in this proposal.
2. Do not add a Guardian-managed `vLLM` installer, service manager, or model downloader in v1.
3. Do not add a new generic "custom local OpenAI-compatible" provider family in this phase.
4. Do not expand the shared `LLMProvider` abstraction just to expose every `vLLM` feature.
5. Do not assume every model served by `vLLM` supports tool calling or JSON-schema constrained outputs.
6. Do not add embedding-generation support through `vLLM` in this first provider proposal.

---

## Upstream Reality

The implementation direction should be anchored in the current upstream product shape:

- official `vLLM` installation support is Linux-first; the docs explicitly say `vLLM` does not support Windows natively
- `vLLM` exposes an OpenAI-compatible server
- `vLLM` documents support for:
  - chat completions
  - tool calling
  - structured outputs
  - embeddings
  - model listing
- actual tool-calling and structured-output reliability remains **model dependent**

This matters because Guardian's provider abstraction already maps cleanly to the first half of that surface:

- `chat`
- `stream`
- `listModels`
- tool definitions
- response-format hints

So the implementation should treat `vLLM` as:

- **a distinct provider family**
- **with a shared OpenAI-compatible wire protocol**

That is different from both:

- pretending `vLLM` needs a fully separate SDK-backed client, and
- pretending it is just another generic hosted OpenAI-compatible SaaS.

---

## Recommendation

### Add `vllm` as a first-class built-in provider type

Recommended metadata:

- `name: 'vllm'`
- `displayName: 'vLLM'`
- `compatible: true`
- `locality: 'local'`
- `tier: 'local'`
- `requiresCredential: false`
- `defaultBaseUrl: 'http://127.0.0.1:8000/v1'`

### Implement `vllm` by reusing `OpenAIProvider`

Provider registry direction:

- register `vllm` in provider metadata
- register `vllm` in the provider registry
- instantiate it using `new OpenAIProvider(...)` with `providerName = 'vllm'`
- preserve `config.baseUrl` override behavior for non-default local deployments

This keeps the transport layer simple and stable:

- one OpenAI-compatible client path
- multiple provider families using that path
- provider-family-aware routing and UI above it

### Explicitly scope support to Linux-hosted local serving

Guardian should document and validate the first implementation around the deployment shape it can support honestly:

- local Linux host
- local container on Linux
- local WSL/Linux sidecar only as future or operator-managed discussion, not as an official supported path in this proposal

The provider family itself is still `local`, because the Guardian runtime should classify it by actual execution locality, not by whether the HTTP surface looks cloud-like.

---

## Why This Should Be First-Class Instead Of "Use OpenAI With A Custom Base URL"

Using `openai` with a custom `baseUrl` is a useful operator escape hatch, but it is not a good product model for `vLLM`.

If Guardian stops there:

- `vLLM` profiles appear as `frontier` instead of `local`
- auto-routing and preferred-provider selection are wrong
- provider badges are misleading
- Config Center copy pushes operators toward cloud-provider expectations
- future `vLLM`-specific UX or validation has nowhere clean to live

A first-class `vllm` family fixes that without requiring a new transport stack.

This is the same design principle already used elsewhere in the repo:

- provider family identity matters even when multiple providers share a compatible API surface

---

## Architectural Fit

### Provider tier model

`vLLM` should be placed in the existing provider model as:

- locality: `local`
- tier: `local`

This keeps the current execution-profile model intact:

- `ollama` and `vllm` are both local families
- `ollama_cloud` remains `managed_cloud`
- direct hosted vendors remain `frontier`

That means no routing-architecture rewrite is needed to land `vLLM`.

### Shared transport model

Guardian already has:

- an OpenAI-compatible provider implementation
- provider metadata for locality and tier
- registry-driven provider validation
- provider-type discovery for Config Center

`vLLM` therefore fits as a **provider-family uplift**, not a protocol rewrite.

### Architecture discipline

This proposal intentionally avoids two bad designs:

1. **Do not bypass the provider model**
   We should not leave `vLLM` as an undocumented custom `baseUrl` trick.

2. **Do not over-specialize the transport layer**
   We should not create `vllm.ts` with a near-copy of `openai.ts` unless `vLLM`-specific request semantics later make that necessary.

The owning layer for this change is the provider family / control-plane layer:

- provider metadata
- provider registry
- config validation
- provider UI/editor flows
- operator docs and harnesses

---

## Proposed Config Shape

Example:

```yaml
llm:
  vllm-local:
    provider: vllm
    model: meta-llama/Llama-3.1-8B-Instruct
    baseUrl: http://127.0.0.1:8000/v1
    enabled: true

assistant:
  tools:
    preferredProviders:
      local: vllm-local
```

Notes:

- `credentialRef` should be optional and normally omitted
- `baseUrl` should remain operator-overridable for non-default ports, reverse proxies, or containerized setups
- `model` should remain required, matching the rest of the provider model

### Default assumptions

For v1, Guardian should assume:

- `vLLM` is already running
- the operator knows which model the server is serving or has made that discoverable through `/v1/models`
- Guardian does not own the `vLLM serve` lifecycle

That keeps the first implementation bounded and honest.

---

## Operator Experience

### Config Center

Config Center should expose `vLLM` as a local provider family alongside Ollama.

Expected UX:

- `vLLM` appears in provider-type lists returned by `/api/providers/types`
- local-provider creation flows can choose `vllm`
- default model suggestions for `vllm` should be generic and non-prescriptive, for example `meta-llama/Llama-3.1-8B-Instruct` or a neutral placeholder
- base URL help text should explain that the default local endpoint is the `vLLM` OpenAI-compatible server, typically on port `8000`
- connection tests should use the existing model-listing flow

### CLI

The CLI currently hardcodes `/config add <name> <type> <model>` to `ollama`, `anthropic`, and `openai`.

That must be updated if `vllm` is added as a first-class provider. Otherwise Guardian will have a runtime-supported provider family that the CLI still rejects.

Recommended minimum change:

- add `vllm` to the CLI `validTypes`
- update help text in `src/channels/cli-command-guide.ts`

### Runtime reporting

Provider inventory, provider badges, and chat provider selectors should all report `vllm` as:

- provider type `vllm`
- locality `local`
- tier `local`

That is one of the main reasons to make this a first-class family.

---

## Model-Compatibility Reality

This proposal should be explicit about a major operational truth:

`vLLM` support is not the same thing as "every model on `vLLM` works for Guardian tool loops."

Guardian relies heavily on:

- tool calling
- stable chat templates
- structured-output hints for some flows

With `vLLM`, those behaviors depend on:

- the served model
- the chat template in use
- the model's tool-calling behavior
- the server configuration

So v1 should document a practical support stance:

- Guardian supports the `vLLM` runtime family
- Guardian does **not** guarantee that arbitrary served models will behave well for tool loops
- operators should prefer instruction-tuned chat models with known tool-calling compatibility

This is not unique to `vLLM`, but `vLLM` makes it especially easy for operators to self-host unusual models, so the proposal should say this plainly.

---

## Phased Rollout

## Phase 1: First-Class Provider Family

### Goal

Make `vLLM` a real local provider family in Guardian without changing the shared wire protocol.

### Deliver

- add `vllm` metadata in [src/llm/provider-metadata.ts](../../src/llm/provider-metadata.ts)
- register `vllm` in [src/llm/provider-registry.ts](../../src/llm/provider-registry.ts) via `OpenAIProvider`
- allow `vllm` in config validation through the registry-driven provider list
- add `vllm` provider defaults in control-plane helpers
- expose `vllm` in provider-type APIs and Config Center fallback lists
- update CLI config add/help text
- add tests for provider registry, config validation, and provider-type exposure

### Likely implementation areas

- [src/llm/provider-metadata.ts](../../src/llm/provider-metadata.ts)
- [src/llm/provider-registry.ts](../../src/llm/provider-registry.ts)
- [src/llm/provider-registry.test.ts](../../src/llm/provider-registry.test.ts)
- [src/runtime/control-plane/provider-config-helpers.ts](../../src/runtime/control-plane/provider-config-helpers.ts)
- [src/runtime/control-plane/provider-dashboard-callbacks.test.ts](../../src/runtime/control-plane/provider-dashboard-callbacks.test.ts)
- [src/channels/cli.ts](../../src/channels/cli.ts)
- [src/channels/cli-command-guide.ts](../../src/channels/cli-command-guide.ts)
- [web/public/js/pages/config.js](../../web/public/js/pages/config.js)

### Exit criteria

- operators can create a `vllm` provider profile from the web UI and CLI
- `vllm` profiles appear as `local`
- model discovery works through the existing provider test flow
- provider selectors and runtime reporting no longer misclassify `vLLM` as frontier

## Phase 2: Linux Support Guardrails And Documentation

### Goal

Make the support boundary explicit so Guardian does not imply Windows parity that upstream `vLLM` does not provide.

### Deliver

- document Linux-only support in operator-facing guidance
- add setup notes for a minimal `vLLM serve` example
- add error/help copy when a `vllm` profile is configured but unreachable
- update integration-harness guidance with a Linux `vLLM` smoke lane

### Recommended operator example

Illustrative only:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct --host 127.0.0.1 --port 8000
```

### Exit criteria

- Guardian docs describe `vLLM` as Linux-local support only
- operators have a clear default port and endpoint shape
- support boundaries are honest and testable

## Phase 3: Runtime-Compatibility Hardening

### Goal

Reduce confusion around models that technically load in `vLLM` but behave poorly for Guardian workflows.

### Deliver

- optional warning copy in provider UI that tool-calling quality is model dependent
- optional "known-good local chat models" guidance in docs
- targeted harness coverage for:
  - direct chat
  - tool calling
  - streaming
  - structured-output paths that Guardian already relies on

### Exit criteria

- Guardian can distinguish transport success from workflow-quality success
- regressions in `vLLM` tool-calling compatibility are caught by harnesses instead of operators first

---

## Testing Strategy

### Unit and integration coverage

The first implementation should include at least:

- provider metadata tests
- provider registry tests
- provider dashboard callback tests
- config UI/provider-type exposure tests
- CLI add-path tests if present for provider types

### Linux smoke harness

Add a Linux-only smoke path that points Guardian at a running local `vLLM` server and verifies:

1. provider connectivity
2. model listing
3. simple chat completion
4. streaming
5. one bounded tool-calling loop

This should be treated similarly to the current real-Ollama lanes:

- optional in local development
- expected in provider-specific validation before handoff

### What should not block v1

These should not block the first provider-family rollout:

- embeddings validation
- multimodal validation
- Windows support
- Guardian-managed `vLLM` startup/shutdown

---

## Risks

### 1. Model-level incompatibility disguised as provider failure

Risk:

- an operator picks a model that loads and answers simple chat, but fails tool calling or structured output

Mitigation:

- document this clearly
- add a tool-loop smoke harness
- avoid overselling arbitrary-model compatibility

### 2. Locality confusion if `vllm` stays under generic `openai`

Risk:

- routing, badging, and preferred-provider selection remain wrong

Mitigation:

- land `vllm` as a first-class provider family

### 3. Over-specializing too early

Risk:

- we build a dedicated `vllm.ts` client that drifts from the shared OpenAI-compatible path without enough justification

Mitigation:

- reuse `OpenAIProvider` in v1
- only split later if provider-specific request controls become necessary

### 4. Unsupported platform expectations

Risk:

- operators assume Windows-native support because Guardian lists `vllm` beside Ollama

Mitigation:

- state Linux-only support in docs and UI help copy

---

## Explicit Design Decisions

### Decision 1: `vLLM` should be `local`, not `frontier`

Reason:

- the runtime is operator-hosted local inference, even if the API surface is OpenAI-compatible HTTP

### Decision 2: `vLLM` should be first-class, not a hidden `openai` workaround

Reason:

- provider family identity affects routing, UI, validation, and operator understanding

### Decision 3: `vLLM` should reuse `OpenAIProvider` in v1

Reason:

- the protocol already matches the current shared client path closely enough

### Decision 4: Linux only in the first proposal

Reason:

- that matches upstream support reality and keeps the rollout honest

---

## Desired End State

After this proposal is implemented:

- Guardian supports `vllm` as a built-in local provider family on Linux
- operators can configure it through the same provider UX as other first-class providers
- routing and provider badging correctly treat `vLLM` as local
- Guardian reuses its existing OpenAI-compatible wire path rather than duplicating transport code
- the support boundary is clear: `vLLM` is a Linux-local provider family, not a Windows-native one

That is the smallest clean implementation that adds real product value without bending the architecture.
