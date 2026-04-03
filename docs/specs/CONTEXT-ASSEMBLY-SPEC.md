# Context Assembly Spec

**Status:** Implemented shared foundation, optimization program in progress

This spec is the authoritative contract for how Guardian assembles bounded LLM context across normal chat, brokered workers, coding-session chat, and the Intent Gateway classifier.

It defines:
- which prompt/context sections exist
- which sections must stay explicit
- which sections should use compact inventories
- which details must stay behind explicit drilldown or retrieval
- how local and external model paths must stay semantically aligned
- how context compaction and diagnostics are surfaced

This spec is cross-cutting. Route-specific, tool-specific, memory-specific, skill-specific, and coding-session-specific docs should reference this document for shared prompt-footprint rules instead of restating their own partial context model.

## Primary Files

- `src/runtime/context-assembly.ts`
- `src/chat-agent.ts`
- `src/worker/worker-session.ts`
- `src/runtime/intent-gateway.ts`
- `src/tools/executor.ts`
- `src/skills/prompt.ts`
- `src/runtime/conversation.ts`
- `src/util/context-budget.ts`

## Goals

- Keep routing and execution context bounded and explainable.
- Preserve safety-critical state even when prompt budgets are tight.
- Reduce default prompt weight for both local and external providers.
- Prefer compact availability inventories plus explicit drilldown over large default catalogs.
- Keep context semantics shared across chat, brokered workers, and coding-session flows.
- Make compaction and retrieval decisions visible in diagnostics and traces.

## Non-Goals

- Replacing the Intent Gateway with heuristic routing.
- Collapsing all context producers into one generic plugin framework.
- Hiding blocked-work, trust, or approval state for token savings.
- Sending every available detail to every model turn.

## Context Consumers

Guardian currently has two main context consumers:

1. Intent classification context
   Used by `IntentGateway` to classify the turn, repair short corrections, and decide whether clarification is needed.

2. Execution context
   Used by the main chat agent and brokered worker after routing, including coding-session turns and post-tool rounds.

These consumers share the same philosophy but not the same payload:
- the gateway gets only route-relevant bounded state
- the execution path gets the shared system prompt plus bounded operational context

## Context Classes

Every context input should fall into one of these classes.

### 1. Explicit Bounded State

This state must remain directly visible in prompt context because it affects safety, continuity, or routing correctness.

Examples:
- pending action blocker summary
- continuity summary
- approval notices
- coding-session identity
- workspace trust state
- focus summary
- route-relevant provider/backend availability

Rules:
- keep these sections structured and bounded
- summarize rather than expand
- do not hide them behind drilldown

### 2. Compact Availability Inventories

These sections tell the model that something exists and give just enough identity to request more detail later.

Examples:
- deferred tool inventory
- active skill catalog
- enabled provider list
- available coding backend list
- cloud profile inventory
- browser capability summary
- provider/model role summary
- large allowlist summaries

Rules:
- include identity, category, and small routing-relevant hints
- do not include full schemas or large examples
- require an explicit follow-on tool call, file read, or retrieval step for detail

### 3. Retrieval-Backed Evidence

This is content that should be loaded because the current task actually needs it, not because it might be useful later.

Examples:
- selected memory entries
- code-session working-set files
- `SKILL.md` bodies
- tool schemas returned from `find_tools`
- provider model catalogs returned from `llm_provider_models`
- deeper repo/file reads

Rules:
- load only when the current request justifies it
- prefer small selected subsets over broad dumps
- record enough diagnostics to explain why the content was loaded

### 4. Omitted By Default

This content should not be injected into ordinary prompts.

Examples:
- full tool catalogs
- full skill bodies for every candidate skill
- large model lists
- full cloud connection/config detail
- unbounded allowlists
- stale or low-signal transcript history
- duplicated summaries of the same state in multiple sections

## Shared Principles

### Safety-Critical State Must Stay Explicit

Guardian must not trade away blocker state, trust state, or route-critical continuity just to save tokens.

### Compact Inventory Plus Explicit Drilldown

If the model only needs to know that a capability exists, send a compact inventory and require an explicit later step for detail.

### Retrieval First, Not Prompt Hoarding

Use retrieval-backed working context, not broad prompt stuffing, for code, memory, skills, and tool discovery.

### Semantic Parity Across Local And External

Local and external paths may differ in description length or formatting, but they must receive the same availability semantics. A tool, provider, or backend must not "exist" for one tier and be silently undiscoverable for the other.

### One Owner Per Section

Each context section should have one subsystem that owns its content and compaction rules:
- routing state: `IntentGateway`
- shared prompt structure: `context-assembly.ts`
- tool inventories and operational context: `ToolExecutor`
- memory selection: conversation + memory services
- skill catalog: skill resolver/prompt layer
- coding-session context: code-session runtime

### Diagnostics Are Part Of The Contract

Compaction, selection, and omission decisions must remain observable through prompt assembly diagnostics, routing traces, or run timeline metadata.

## Current Shared Prompt Shape

Execution-context prompt assembly currently follows this order:

1. base system prompt
2. persistent knowledge base
3. coding-session memory
4. active skills summary
5. pending action context
6. continuity context
7. tool context
8. runtime notices
9. pending approval notice
10. additional targeted sections

This order is intentional:
- identity and safety instructions first
- durable memory before ephemeral operational context
- blocked-work and continuity before tool/action context
- targeted extensions last

The shared builder for this is `buildSystemPromptWithContext(...)` in `src/runtime/context-assembly.ts`.

## Current Implemented Compact Patterns

### Intent Gateway

The gateway already uses bounded context:
- current user message
- recent bounded history
- summarized pending action
- summarized continuity thread
- compact provider/backend availability

### Deferred Tool Discovery

The main chat prompt now exposes a compact deferred-tool inventory. Full schemas remain deferred until the model explicitly calls `find_tools`.

### Skill Loading

Selected skills are injected as compact metadata. The model is expected to read `SKILL.md` only for clearly relevant skills.

### Memory Selection

Prompt-time memory loading is selected and ranked rather than appended wholesale. Compaction flushes dropped history into durable `context_flush` entries instead of repeatedly rewriting the same prefix.

### Coding Workspace

Code-session prompts already prefer workspace identity, trust, profile, repo map, and working-set evidence over generic host-app context.

## Target Implementation Shape

The optimization work should stay incremental and aligned with the current architecture.

### Shared Builder Stays Central

`buildSystemPromptWithContext(...)` remains the shared formatter for execution-context prompts. We should optimize what upstream producers feed into it rather than replacing it with a new generic framework.

### Producers Stay In Their Owning Layers

Each subsystem should keep owning its own compact summary and drilldown path:
- `IntentGateway` owns classifier-only bounded state
- `ToolExecutor` owns `<tool-context>` inventories and operational hints
- memory services own selected durable-memory evidence
- skill resolution owns compact skill catalogs and `SKILL.md` drilldown
- code-session runtime owns workspace identity, trust, profile, map, and working-set evidence

### Compact Section First, Drilldown Second

For every candidate optimization, the implementation question should be:

1. What is the smallest default summary the model needs?
2. What explicit action loads the full detail?
3. How do we keep that drilldown path identical in meaning across local and external tiers?

### Prefer Narrow Helpers Over New Global Abstractions

The likely extraction path is helper-focused, not framework-heavy:
- tool-context summarization can move toward `src/tools/helpers/tool-context.ts`
- provider/model summary shaping can live with provider control-plane helpers
- skill-catalog normalization can stay in the skill prompt layer
- section-level diagnostics can extend existing context assembly metadata instead of introducing a separate tracing system

### Diagnostics Must Follow The Optimization

Every payload reduction should preserve enough metadata to answer:
- what was included
- what was compacted
- what was omitted
- what explicit drilldown path remained available

## Optimization Program

The following items are the intended implementation program, in priority order.

### Phase 1: Unify Skill Catalog Injection

Problem:
- execution prompts currently carry both `<active-skills>` summary data and a separate `<available_skills>` block with overlapping catalog content

Target:
- keep one canonical compact skill catalog
- keep the explicit "read `SKILL.md` before acting when relevant" instruction
- keep skill-specific output contracts only when they materially change response shape

Likely touchpoints:
- `src/runtime/context-assembly.ts`
- `src/chat-agent.ts`
- `src/skills/prompt.ts`
- `src/worker/worker-session.ts`

### Phase 2: Compact Cloud Profile Inventory

Problem:
- tool context currently injects rich per-profile lines with endpoint, username, readiness, allowlist state, and provider-specific details

Target:
- default prompt should carry only:
  - profile id
  - provider family
  - label
  - credential readiness
  - allowlist readiness
  - narrow read-only probe hint
- richer profile detail should be loaded only when the current turn is clearly about that provider or profile

Likely touchpoints:
- `src/tools/executor.ts`
- future `src/tools/helpers/tool-context.ts`

### Phase 3: Add Provider/Model Summary Context

Problem:
- provider switching tools exist, but default prompt context does not yet carry a compact provider/model summary for ordinary disambiguation

Target:
- inject a compact provider summary:
  - provider id
  - default / preferred-local / preferred-external role
  - current configured model
- keep full model lists behind `llm_provider_models`

Likely touchpoints:
- `src/tools/executor.ts`
- provider dashboard/control-plane helpers

### Phase 4: Compact Large Allowlists

Problem:
- allowed paths, commands, and domains can grow until they dominate `<tool-context>`

Target:
- default prompt should use a capped summary with counts and a small number of representative entries
- if a path/domain/command likely matters to the current request, include the matching item
- full inventories should be available through explicit lookup or control-plane drilldown, not injected into every turn

Likely touchpoints:
- `src/tools/executor.ts`
- policy/control-plane read surface

### Phase 5: Browser Capability Summary Tightening

Problem:
- browser wrapper guidance is useful, but it can drift into too much default detail

Target:
- keep wrapper availability, backend readiness, and allowed-domain summary in default prompt context
- push detailed capability explanation behind `browser_capabilities`

Likely touchpoints:
- `src/tools/executor.ts`
- browser wrapper docs/prompts

### Phase 6: Coding Evidence Budgeting

Problem:
- code-session prompts can still become expensive when working-set evidence grows

Target:
- keep identity, trust, workspace profile, repo-map summary, and compact file evidence in prompt
- prefer file paths, symbol hints, manifests, and focused excerpts over larger raw snippets
- keep deeper file detail retrieval-backed

Likely touchpoints:
- `src/chat-agent.ts`
- code-session working-set builders
- `src/util/context-budget.ts`

### Phase 7: Section Budgets And Section Diagnostics

Problem:
- current diagnostics report overall compaction, but not per-section footprint

Target:
- record section-level contribution and which compact inventory or retrieval path supplied each section
- make it clear when context growth comes from tools, memory, code evidence, or inventories

Likely touchpoints:
- `src/runtime/context-assembly.ts`
- `src/chat-agent.ts`
- run timeline / routing trace surfaces

## Implementation Rules

When implementing the optimization phases:

- do not promote deferred content into always-loaded context just to paper over a discovery bug
- fix discovery or drilldown paths at the owning layer
- do not create channel-specific prompt shapes for the same runtime semantics
- do not duplicate the same catalog in multiple prompt sections
- keep brokered worker prompt assembly aligned with the main chat path
- preserve current safety and continuity semantics while shrinking payload size

## Related Specs

- `docs/specs/ORCHESTRATION-SPEC.md`
- `docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md`
- `docs/specs/IDENTITY-MEMORY-SPEC.md`
- `docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`
- `docs/specs/SKILLS-SPEC.md`
- `docs/specs/CODING-WORKSPACE-SPEC.md`
- `docs/specs/BROKERED-AGENT-ISOLATION-SPEC.md`

## Verification

Primary verification surfaces:
- `src/runtime/context-assembly.test.ts`
- `src/tools/executor.test.ts`
- `src/skills/prompt.test.ts`
- `src/runtime/intent-gateway.test.ts`
- `src/worker/worker-session.test.ts`
- prompt-footprint regression coverage in relevant chat/runtime tests

Operator-facing verification should continue to rely on:
- routing trace metadata
- run timeline context assembly diagnostics
- coding-session compaction diagnostics
