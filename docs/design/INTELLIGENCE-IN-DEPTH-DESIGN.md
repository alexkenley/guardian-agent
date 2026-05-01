# Intelligence In Depth Design

**Status:** Current target architecture; Layer 3/4/5 provider uplift implemented, Layer 1/2 unimplemented
**Date:** 2026-04-06
**Proposal origin:** [Offline Survival And Decision Lane Proposal](../proposals/OFFLINE-SURVIVAL-AND-DECISION-LANE-PROPOSAL.md)

## Purpose

Define GuardianAgent's layered intelligence architecture so the system remains:

- operable when the internet is unavailable
- useful when Ollama is unavailable
- safe when no LLM lane is healthy
- capable of routing bounded work to the minimum sufficient healthy lane
- clear about which class of intelligence is responsible for which workload

This is a design-target spec. It now also records:

- what is already implemented in the current repo
- what the next implementation phase should add
- what remains future work

## Current Repo Baseline

Guardian does **not** implement the full target architecture yet.

Current practical state:

- Layer 0 already exists in substantial form through the deterministic runtime, approvals, policy, schedulers, pending-action orchestration, and control-plane actions.
- Layer 3 already exists as the Ollama Local general-assistant lane and is now implemented through the native Ollama SDK path rather than the previous mixed compatibility path.
- Layer 4 now exists in initial form as a first-class **Ollama Cloud** managed-cloud lane with its own provider type, credentials, config defaults, and advanced Ollama request settings.
- Layer 5 now exists as the explicit frontier external lane for the current hosted provider families.
- The provider/control-plane model is now split explicitly across:
  - local
  - managed-cloud
  - frontier
- The config UI now exposes separate operator-facing sections for:
  - local Ollama
  - Ollama Cloud
  - frontier providers
- Provider defaults are now split explicitly across:
  - derived primary provider
  - local routed default
  - managed-cloud routed default
  - frontier routed default
- The managed-cloud tier can now route to different named Ollama Cloud profiles for:
  - general fallback
  - direct answers
  - tool loops / provider CRUD
  - managed-cloud coding
- Chat controls now expose:
  - persistent tier routing such as `auto`, `local`, `managed cloud`, and `frontier`
  - request-scoped web chat provider-profile selection from enabled provider profiles
- Layer 1 and Layer 2 do **not** exist yet as shipped built-in runtimes.

What this implementation phase added:

- explicit provider metadata for locality and tier
- first-class `ollama_cloud` provider support
- tier-aware routing and provider badging
- auto fallback ordering that prefers managed-cloud before frontier when escalating beyond local
- advanced native Ollama request settings for both local Ollama and Ollama Cloud
- managed-cloud role routing so multiple named Ollama Cloud profiles can serve different workload classes inside Layer 4

What remains future work:

- Layer 1 survival lane
- Layer 2 local decision lane
- deeper routing refinement beyond the current Layer 3/4/5 split

## As-Built Update: Ollama Cloud

The earlier Ollama Cloud gap described in this spec is now substantially closed in the current repo baseline.

What is now implemented:

- direct **Ollama Cloud** support as its own provider type
- Ollama-native local and cloud execution through the official Ollama SDK
- managed-cloud credential storage and env-backed credential-ref support in the provider config flow
- dedicated config UI/editor separation between local Ollama and Ollama Cloud
- tier-aware routing, fallback, and response-source badging for local vs managed-cloud vs frontier
- tier-specific routed defaults for local, managed-cloud, and frontier provider selection
- explicit tier forcing for local, managed-cloud, and frontier paths plus request-scoped web provider-profile forcing
- multiple named managed-cloud provider profiles under the Ollama Cloud provider family
- deterministic managed-cloud role routing for direct answers, tool loops, managed-cloud coding, and general fallback

Remaining limitations worth recording honestly:

- Layer 4 currently starts and ends with Ollama Cloud; the wider managed-cloud family listed later in this spec is still future work
- Layer 1 and Layer 2 are still not implemented
- higher-order routing refinement across all future layers remains unfinished
- Guardian does not hardcode vendor concurrency-plan limits for Ollama Cloud; upstream concurrency and queueing remain owned by Ollama Cloud itself
- Guardian does not yet expose a true multimodal request path through the shared LLM abstraction, so Layer 4 role routing is currently text-first even when a managed-cloud model supports image input

## As-Built Gap: Multimodal Managed-Cloud Routing

The codebase still has a text-first shared LLM message contract. Any future multimodal managed-cloud lane must verify the current provider APIs and model catalogs at implementation time rather than relying on a static design-doc model list.

What this means for Guardian:

- multimodal-aware provider selection is a real future Layer 4 requirement
- the current four managed-cloud roles (`general`, `direct`, `toolLoop`, `coding`) are not enough once the app can send screenshots, photos, or other image-bearing prompts through the shared chat path
- provider/model selection for a multimodal lane should remain config-driven and catalog-verified, not hardcoded into this architecture doc

Current architectural blocker:

- Guardian's shared `ChatMessage` abstraction is still text-only in the shipped repo baseline, so modality-aware routing would be premature until the shared message schema, channel ingestion, and provider adapters can carry images end to end

## Core Idea

Guardian should not have one undifferentiated "AI provider" concept.

It should have **intelligence in depth**:

- a deterministic floor that never depends on an LLM
- a tiny built-in survival LLM lane
- a stronger local decision lane for bounded structured work
- a broader local general-assistant lane
- a managed-cloud general-assistant lane
- frontier external intelligence as the final outer ring

These are not six copies of the same thing. They are six different capability rings with different:

- failure domains
- trust assumptions
- packaging requirements
- routing responsibilities
- response-quality expectations

## Canonical Layers

### Layer 0: Deterministic Runtime And Enforcement

This is the non-LLM floor.

Primary responsibilities:

- policy enforcement
- sandbox and approval enforcement
- hard allow/deny decisions from explicit policy
- health checks and recovery loops
- explicit automation execution when the requested work is already structured
- scheduled and event-driven control-plane work
- operator-directed quick actions

Status:

- **partially implemented now**

### Layer 1: Built-in Survival Intelligence

This is the smallest bundled local LLM lane.

Chosen runtime direction:

- `llama.cpp` helper process

Primary responsibilities:

- degraded Intent Gateway classification
- degraded Guardian inline judgment
- degraded Sentinel synthesis
- short operator guidance when stronger lanes are unavailable

Status:

- **planned, not implemented**

### Layer 2: Local Decision Intelligence

This is the stronger bounded local decision lane.

Chosen runtime direction:

- BitNet

Primary responsibilities:

- Intent Gateway classification when healthy
- Guardian inline action evaluation
- Sentinel retrospective audit analysis
- compact JSON-only classifiers
- other short-context local judgment

Status:

- **planned, not implemented**

### Layer 3: Local General Assistant Intelligence

This is the broader local assistant lane.

Chosen runtime direction:

- **Ollama Local**

Primary responsibilities:

- local general assistant chat
- local tool-calling loops
- local experimentation with larger models
- local coding and general synthesis when the operator wants a local-first setup

Important boundary:

- Layer 3 must not be treated as the only definition of "local"

Status:

- **implemented now**

### Layer 4: Managed-Cloud General Assistant Intelligence

This is the mid-tier managed-cloud lane.

Immediate target:

- **Ollama Cloud**

Likely later candidates in the same general lane:

- Hugging Face Inference Providers
- Together AI
- Groq
- Fireworks
- Cerebras
- other lower-cost or subscription-style managed-cloud model services

Primary responsibilities:

- stronger general assistant chat than weaker local models without jumping straight to frontier cost
- stronger tool-calling reliability than weaker local models
- mid-tier synthesis and coding/operator help
- subscription or lower-cost managed-cloud execution when configured

Important boundary:

- Layer 4 is distinct from both local Ollama and premium frontier APIs

Status:

- **implemented now as the first managed-cloud lane**

### Layer 5: Frontier External Intelligence

This is the outermost premium lane.

Examples:

- Anthropic
- OpenAI
- premium high-capability external providers

Primary responsibilities:

- highest-capability general assistance
- strongest fallback for complex synthesis when allowed
- premium coding and orchestration workloads
- highest-cost reasoning escalation path

Status:

- **implemented now as the explicit frontier external lane**

## Layer Summary

| Layer | Name | Chosen stack | Primary purpose | Current status |
|------|------|--------------|-----------------|----------------|
| 0 | Deterministic runtime | Guardian code, tools, schedulers, policies | Explicit execution, enforcement, safe degradation | partially implemented |
| 1 | Built-in survival intelligence | `llama.cpp` helper + tiny bundled GGUF | Minimal offline reasoning when no stronger lane is available | planned |
| 2 | Local decision intelligence | BitNet helper + bundled model | Fast bounded JSON-oriented local routing and judgment | planned |
| 3 | Local general assistant intelligence | Ollama Local | Broader local chat and tool-calling assistance | implemented |
| 4 | Managed-cloud general assistant intelligence | Ollama Cloud first | Stronger managed-cloud chat and tool-calling without forcing premium frontier usage | implemented |
| 5 | Frontier external intelligence | Premium external providers | Highest-capability remote reasoning and synthesis | implemented |

Frontier external is **Layer 5**, not Layer 4.

## Important Rule: Layers Are Capability Rings, Not A Linear Pipeline

Requests do **not** always flow `0 -> 1 -> 2 -> 3 -> 4 -> 5`.

Instead, Guardian should select the **minimum sufficient healthy layer** for the workload.

Examples:

- a saved deterministic automation run may execute entirely in Layer 0
- a degraded bounded classifier may use Layer 1
- a bounded structured judgment may use Layer 2
- a normal local assistant turn may use Layer 3
- a stronger managed-cloud turn may use Layer 4
- a premium high-capability reasoning turn may use Layer 5

This prevents the architecture from becoming a slow serial chain and keeps the role of each layer clear.

## Workload Classes

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
  - Guardian inline evaluation
  - Sentinel audit analysis
  - short bounded JSON-only classifiers
- `general_tools`
  - tool-calling assistant loops
  - browser/email/workspace orchestration
  - coding orchestration
- `general_chat`
  - plain conversational or synthesis-heavy responses without tool dependence

## Current Routing Reality

The current shipped model is still fundamentally two-bucket:

- `local`
- `external`

That model is still reflected in:

- tool provider routing
- provider badges
- fallback chains
- several routing helpers
- parts of the config UI and CLI

The next implementation step must therefore be a **tier-aware re-architecture** of the current provider system before Layer 1 and Layer 2 are added.

## Next Routing Model

The general-assistant side should move to these lanes:

- Layer 3: local general
- Layer 4: managed cloud
- Layer 5: frontier

The intended progression is:

- prefer Layer 3 for cheap local work when it is sufficient
- prefer Layer 4 for stronger managed-cloud work when local is not sufficient
- escalate to Layer 5 for the hardest or most fragile premium work

Fallback principles:

- same-tier fallback is preferred before cross-tier fallback
- local failure may escalate to managed cloud
- managed-cloud failure may escalate to frontier
- frontier should remain the strongest explicit lane, not the default answer to every cloud-model problem

## Preferred Routing Policy

### Current implemented baseline

| Workload | Current practical route |
|----------|--------------------------|
| `deterministic` | Layer 0 |
| `decision_json` | current local/external model selection, pending future Layer 1/2 split |
| `general_tools` | Layer 3 or the current broad external bucket |
| `general_chat` | Layer 3 or the current broad external bucket |

### Target near-term routing after the next uplift

| Workload | Preferred route | Fallback route | Final fallback |
|----------|------------------|----------------|----------------|
| `deterministic` | Layer 0 | none | none |
| `decision_json` | current best bounded lane until Layer 2 exists | weaker bounded lane if available | Layer 0 deterministic floor |
| `general_tools` | Layer 3, 4, or 5 based on workload and policy | next sufficient stronger lane if allowed | fail/degrade |
| `general_chat` | Layer 3, 4, or 5 based on workload and policy | next sufficient stronger lane if allowed | short degraded guidance only |

### Target future routing after Layer 1 and Layer 2 land

| Workload | Preferred route | Fallback route | Final fallback |
|----------|------------------|----------------|----------------|
| `deterministic` | Layer 0 | none | none |
| `decision_json` | Layer 2 | Layer 1 | Layer 0 deterministic floor |
| `general_tools` | Layer 3, 4, or 5 based on workload and policy | next sufficient stronger lane if allowed | fail/degrade |
| `general_chat` | Layer 3, 4, or 5 based on workload and policy | next sufficient stronger lane if allowed | Layer 1 only for short degraded guidance |

Important guardrails:

- Layer 1 should not become a default tool-calling lane
- Layer 2 should not become a general chat lane
- Layer 4 should not be collapsed into a generic `external` bucket forever
- Layer 5 should not silently become the default for all cloud work

## Capability Model

Guardian should represent intelligence layers and providers using capability metadata instead of provider-name assumptions.

Suggested shape:

```ts
interface LLMProviderCapabilities {
  locality: 'local' | 'external';
  tier: 'survival' | 'local_decision' | 'local_general' | 'managed_cloud' | 'frontier';
  isolation: 'in_process' | 'worker_process' | 'helper_process' | 'external_service';
  supportsTools: boolean;
  supportsJsonSchema: boolean;
  supportsStreaming: boolean;
  inputModalities: Array<'text' | 'image'>;
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
- treating all cloud providers as one undifferentiated `external` bucket
- assuming all local OpenAI-compatible endpoints are interchangeable
- assuming every provider that can answer text is equally suitable once screenshots or image-bearing prompts enter the system

## Safe Implementation Strategy

The implementation should be deliberately layered but operationally compact.

The safe architecture is:

- keep one deterministic runtime floor
- add one bundled local runtime manager for Layer 1
- add one optional local decision provider for Layer 2
- keep Layer 3, Layer 4, and Layer 5 inside the ordinary provider system
- add one central selector that chooses the minimum sufficient healthy layer for a workload class

The implementation must avoid:

- per-feature custom layer-selection logic
- freeform planner logic that "reasons" about layers in natural language
- separate routing frameworks per layer
- multiple incompatible local-runtime manager abstractions
- duplicating business logic across layers

## Failure-Domain Rules

### Layer 0 Must Remain Independent

Layer 0 must continue to function when all LLM lanes are unavailable.

### Layer 1 Must Be Independent Of Layer 3

Requirements:

- no dependency on Ollama
- separate runtime process
- separate health state

### Layer 2 Must Be Independent Of Layer 3

Requirements:

- BitNet must not be tunneled through Ollama
- separate assets
- separate health state

### Layer 4 Must Be Independent Of Layer 3

Requirements:

- Ollama Cloud must not be represented as "just local Ollama with a different model tag"
- direct managed-cloud profiles must be allowed to carry their own credentials, endpoint, and capability metadata
- routing and badges must distinguish Layer 3 local Ollama from Layer 4 managed-cloud Ollama

### Layer 5 Must Be Independent Of Layer 4

Requirements:

- managed-cloud and frontier must remain separate routing targets
- same-tier failover is preferred before silent cross-tier escalation

## Observability And UI Semantics

Guardian should surface the active intelligence ring in metadata and operator UI.

Suggested labels:

- `layer0_deterministic`
- `layer1_survival`
- `layer2_decision`
- `layer3_local_general`
- `layer4_managed_cloud`
- `layer5_frontier`

Operators should be able to see:

- which layer handled a request
- whether fallback occurred
- whether the response was degraded
- whether the active lane was bundled, operator-provided, or remote

## Conceptual Configuration Direction

```yaml
assistant:
  intelligence:
    layer0:
      enabled: true

    layer1:
      enabled: true
      backend: llama_cpp_helper

    layer2:
      enabled: true
      backend: bitnet_helper

    layer3:
      enabled: true
      provider: ollama_local

    layer4:
      enabled: true
      provider: ollama_cloud

    layer5:
      enabled: true
      providers:
        - anthropic_primary
        - openai_primary
```

This is not a final config schema. It defines the intended conceptual model.

## Implementation Consequences For The Current Repo

Primary changes required:

1. Stop conflating `ollama` with `local` in:
   - `src/index.ts`
   - `src/runtime/model-routing-ux.ts`
   - other provider-locality helpers and adjacent control-plane code

2. Add explicit provider capability metadata for:
   - locality
   - tier
   - structured-output support
   - tool-calling suitability

3. Add first-class Layer 3 vs Layer 4 vs Layer 5 handling to:
   - provider registry
   - config UI
   - CLI provider commands
   - provider badges and response metadata
   - fallback policy
   - tool-routing defaults
   - Intent Gateway adjacent selectors that currently assume `local` vs `external`

4. Add first-class Ollama Cloud provider/config support.

5. Preserve the Intent Gateway rule that top-level natural-language understanding remains LLM-routed in normal operation.

6. Add Layer 1 and Layer 2 later as bundled first-party runtimes rather than forcing them into the current provider stack as fake Ollama variants.

## Rollout Order

### Phase 0: Current baseline

- Layer 0 exists in substantial form
- Layer 3 exists as Ollama local
- Layer 4 exists as Ollama Cloud managed-cloud
- Layer 5 exists as the explicit frontier external tier

### Phase 1: Completed current uplift

- formalize the current implementation baseline in code and routing metadata
- add locality and tier capability metadata
- remove `ollama == local` assumptions from the active provider stack
- split the current general-assistant provider system into:
  - Layer 3 local general
  - Layer 4 managed cloud
  - Layer 5 frontier
- add first-class Ollama Cloud provider/config support
- rework adjacent systems such as:
  - fallback chains
  - provider badges and response metadata
  - provider config UI
  - control-plane/provider discovery paths

### Phase 2: Survival lane

- add Layer 1 bundled `llama.cpp` survival runtime
- use a tiny bundled model
- route degraded bounded tasks to it

### Phase 3: Local decision lane

- add Layer 2 bundled BitNet decision lane
- route Intent Gateway, Guardian inline evaluation, continuity-sensitive blocker judgments, and Sentinel audit to it when healthy

### Phase 4: Routing refinement

- refine Layer 3, Layer 4, and Layer 5 routing rules
- add optional `ONNX Runtime GenAI` backend later if Windows acceleration becomes a priority

### Phase 5: Modality-aware managed-cloud routing

- extend the shared LLM abstraction so chat requests can carry multimodal inputs rather than only text
- add provider capability metadata for input modality support, not just tier and locality
- add an optional Layer 4 managed-cloud multimodal role that is selected only when the request actually contains image-bearing input
- keep the current text-first role-routing model as the fallback for ordinary turns
- initial practical candidate for the first managed-cloud multimodal profile is `gemma4:31b` on Ollama Cloud, because current Ollama documentation and catalog data expose it as a text-and-image cloud model with long context
- fallback order for future multimodal turns should be:
  - explicit multimodal managed-cloud role
  - managed-cloud `general`
  - managed-cloud routed default
  - frontier multimodal-capable provider if policy allows

Important guardrail:

- do not expose a multimodal role in the operator UI until the shared chat/message path, provider adapters, and channel surfaces can actually submit multimodal prompts end to end

## Decision

Guardian's target layered intelligence architecture is:

1. **Layer 0:** deterministic runtime and enforcement
2. **Layer 1:** built-in `llama.cpp` survival lane
3. **Layer 2:** BitNet local decision lane
4. **Layer 3:** Ollama local general-assistant lane
5. **Layer 4:** managed-cloud general-assistant lane, starting with Ollama Cloud
6. **Layer 5:** frontier external providers

That is the canonical model going forward.
