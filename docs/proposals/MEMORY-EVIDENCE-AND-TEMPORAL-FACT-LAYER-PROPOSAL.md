# Proposal: Memory Evidence And Temporal Fact Layer

**Date:** 2026-04-07
**Status:** Draft
**Inspired by:** MemPalace (conceptually, not as a direct implementation dependency)
**Cross-references:** [Memory System Guide](/mnt/s/Development/GuardianAgent/docs/guides/MEMORY-SYSTEM.md), [Second Brain Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/SECOND-BRAIN-PROPOSAL.md), [Backend-Owned Coding Sessions Proposal](/mnt/s/Development/GuardianAgent/docs/proposals/BACKEND-OWNED-CODING-SESSIONS-PROPOSAL.md), [src/runtime/agent-memory-store.ts](/mnt/s/Development/GuardianAgent/src/runtime/agent-memory-store.ts), [src/search/search-service.ts](/mnt/s/Development/GuardianAgent/src/search/search-service.ts)

---

## Executive Summary

Guardian already has a strong memory foundation:

- scoped durable memory for global and code-session use
- shared mutation and hygiene paths
- conversation history with FTS5 search
- prompt-time memory packing with trust-aware filtering
- a unified Memory/Wiki direction for operator surfacing

The main gap is not "memory from zero". The gap is **large-scale evidence recall**:

- verbatim rationale is harder to retrieve than compact durable memory
- cross-topic navigation is weak compared with topic-first knowledge systems
- there is no dedicated reviewed temporal fact layer for facts that change over time

This proposal recommends a Guardian-native uplift with three additions:

1. a **verbatim evidence corpus** separate from canonical durable memory
2. a **derived topic/tunnel graph** for navigation and retrieval narrowing
3. a **reviewed temporal fact layer** for facts that need validity windows

The correct direction is to **borrow the retrieval ideas** from MemPalace, not to replace Guardian's current memory architecture or import the MemPalace Python/Chroma runtime directly.

---

## Why This Change Is Needed

Guardian's current memory model is intentionally optimized for:

- trusted durable recall
- bounded prompt context
- scope isolation
- operator auditability
- shared orchestration and review boundaries

That is the right base architecture.

However, some important user questions are still better answered from a verbatim evidence lane than from canonical memory entries alone:

- "Why did we decide to do this?"
- "What exact tradeoff discussion led to this choice?"
- "Where did we talk about this same topic across projects?"
- "Who was assigned to this in January versus now?"

Today, Guardian can often answer those by combining conversation search, durable memory, and document search, but the system does not yet have a first-class architecture for:

- storing large volumes of verbatim conversational evidence as a retrieval substrate
- deriving topic structure from that evidence for narrowing and navigation
- promoting reviewed time-bounded facts into a queryable temporal store

MemPalace demonstrates that these ideas can materially improve retrieval quality. The useful lesson is not "replace Guardian with MemPalace". The useful lesson is:

- keep everything important findable
- separate compressed prompt memory from deep evidence recall
- use topic structure to narrow retrieval
- treat changing facts as temporal objects rather than flat notes

---

## Current Position To Preserve

The current Guardian architecture should remain authoritative for durable memory:

- global and code-session memory scopes remain distinct
- canonical durable memory stays sidecar-backed and integrity-aware
- prompt injection defenses, trust levels, provenance, and quarantine remain mandatory
- `memory_save`, `memory_search`, `memory_recall`, and `memory_bridge_search` remain shared runtime tools
- context flush remains a structured summarization path, not a raw transcript dump

This proposal therefore does **not** replace:

- `AgentMemoryStore`
- `MemoryMutationService`
- existing conversation history
- existing document `SearchService`
- Memory/Wiki as the operator-facing canonical surface

Instead, it extends the retrieval model around them.

---

## Design Goals

- Preserve Guardian's current canonical memory model and trust boundaries.
- Add a dedicated evidence-retrieval layer for verbatim recall.
- Improve "why" and "what exactly happened" retrieval without polluting prompt memory.
- Add topic-aware narrowing and cross-topic navigation.
- Add a reviewed temporal fact layer for mutable real-world facts.
- Reuse Guardian's native TypeScript search substrate where possible.
- Keep scope isolation across global, code-session, and future workspace/session lanes.
- Surface the new layers in the unified Memory/Wiki experience rather than as separate hidden subsystems.

## Non-Goals

- Do not replace Guardian memory with MemPalace.
- Do not introduce a second canonical write path for durable memory.
- Do not dump full raw transcripts directly into ordinary prompt context.
- Do not rely on heuristic regex classification as the authoritative memory-routing layer.
- Do not introduce an ad hoc Python sidecar service as the primary memory runtime.
- Do not auto-promote unreviewed raw evidence into high-authority temporal facts.

---

## External Inspiration

MemPalace contributes four ideas worth reusing conceptually:

1. **Layered recall**
   - small always-loaded identity/core context
   - topic-scoped recall on demand
   - deep search only when needed

2. **Topic structure**
   - topic grouping improves retrieval narrowing
   - repeated topics across domains create useful graph edges

3. **Verbatim evidence preservation**
   - retrieval quality often improves when the original discussion remains searchable
   - summaries alone lose rationale, tradeoffs, and quoted wording

4. **Temporal fact handling**
   - some facts should be represented as time-bounded truth, not flat memory notes

The parts Guardian should **not** copy directly are equally important:

- Python runtime ownership
- direct Chroma dependency as the primary memory substrate
- simplistic heuristic routing as the authoritative extraction model
- write paths that bypass Guardian trust, integrity, and approval boundaries

---

## Proposed Model

Guardian should evolve to a five-layer memory stack:

```text
Layer 1: Canonical Durable Memory
  Existing global and code-session memory
  Compact, trusted, prompt-packable, operator-auditable

Layer 2: Conversation History
  Existing SQLite-backed channel/session history with FTS5

Layer 3: Verbatim Evidence Corpus
  Search-oriented corpus of reference material
  Large, chunked, provenance-rich, reference-only by default

Layer 4: Topic / Tunnel Graph
  Derived navigation graph linking related evidence and memory by topic

Layer 5: Reviewed Temporal Fact Layer
  Explicit facts with valid_from / valid_to windows
  Built from reviewed promotions, not raw ingestion
```

### Core principle

Canonical memory remains the place where Guardian stores durable, prompt-worthy knowledge.

The new evidence corpus becomes the place where Guardian finds:

- exact prior discussion
- rationale
- quotes
- historical context
- topic neighbors

The temporal fact layer becomes the place where Guardian answers:

- what was true
- when it became true
- when it stopped being true

---

## Proposed Services

### 1. `MemoryEvidenceService`

Purpose:

- store and retrieve verbatim evidence chunks
- maintain scope-aware provenance
- support hybrid retrieval over evidence
- return references, not high-authority prompt memory, by default

Suggested storage posture:

- implement on top of Guardian's native search substrate where possible
- reuse SQLite-backed indexing and embedding abstractions from `src/search/`
- treat evidence as a specialized collection class, not a separate unrelated engine

Suggested evidence sources:

- conversation excerpts
- code-session transcript excerpts
- saved automation outputs already persisted privately
- operator-imported notes or transcripts
- selected links back to document-search results where useful

Suggested evidence metadata:

```ts
interface MemoryEvidenceChunk {
  id: string;
  scope: 'global' | 'code_session';
  scopeId: string;
  sourceKind: 'conversation' | 'code_session' | 'automation_output' | 'operator_note' | 'document_ref';
  sourceRef: string;
  trustLevel: 'trusted' | 'untrusted' | 'reviewed';
  status: 'active' | 'quarantined' | 'archived';
  content: string;
  summary?: string;
  topicKeys: string[];
  entityKeys: string[];
  createdAt: string;
  validAt?: string;
  provenance: Record<string, unknown>;
}
```

This is deliberately **not** the same as `MemoryEntry`.

### 2. `MemoryTopicGraphService`

Purpose:

- derive topics from canonical memory, evidence chunks, and reviewed facts
- build graph edges between repeated topics across scopes and sources
- support navigation and retrieval narrowing

Guardian should not literally adopt `wing/hall/room`.

Guardian-native equivalents are more likely:

- `principal` or `assistant`
- `scope` (`global`, `code_session`)
- `workspace` or `project`
- `topic`
- `artifact kind`

This preserves Guardian's existing identity and scope model instead of introducing an external taxonomy vocabulary as the source of truth.

### 3. `TemporalFactStore`

Purpose:

- store reviewed facts that change over time
- support point-in-time and current-state queries
- link facts back to evidence and canonical memory

Suggested model:

```ts
interface TemporalFact {
  id: string;
  scope: 'global' | 'code_session';
  scopeId: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  validTo?: string;
  confidence: number;
  status: 'active' | 'invalidated' | 'superseded';
  reviewed: boolean;
  evidenceRefs: string[];
  createdByPrincipal?: string;
  createdAt: string;
}
```

Only reviewed promotions should create or update these facts.

---

## Retrieval Flow

### Default conversational flow

1. continue using canonical durable memory for prompt packing
2. continue using conversation history for recent context
3. when the question looks like deep recall, query the evidence corpus
4. when the question is about truth over time, query the temporal fact layer
5. optionally use topic graph narrowing to improve evidence retrieval

### Important boundary

Evidence corpus results are **reference material** by default.

They should be surfaced similarly to:

- `memory_bridge_search`
- document search evidence
- automation output references

That means:

- not every evidence hit is automatically injected into the system prompt
- not every evidence hit becomes durable memory
- not every evidence hit becomes a fact

### Prompt-context policy

Guardian should retain the current rule:

- canonical memory is optimized for prompt-time inclusion
- evidence is optimized for recall

This preserves bounded prompt size and reduces memory poisoning risk.

---

## Ingestion Model

### Canonical durable memory

No change to the canonical write rules:

- `memory_save` remains the primary durable assistant write path
- context flush remains structured and duplicate-aware
- operator curation remains a guarded product path

### Evidence ingestion

Evidence ingestion should happen through explicit runtime-owned flows:

- eligible conversation excerpts can be mirrored into evidence collections
- code-session transcript excerpts can be mirrored into code-session evidence
- saved automation outputs can expose evidence excerpts alongside their existing reference model
- operator imports can be ingested through reviewed control-plane paths

### Fact promotion

Fact promotion should be explicit:

1. retrieve evidence
2. review or confirm the fact
3. write/update temporal fact
4. optionally write a canonical memory summary that links to the fact

This mirrors Guardian's broader trust model and avoids turning raw transcripts into planner truth.

---

## Scope Model

The new layers must follow Guardian's existing scope semantics:

- global evidence is visible to the same logical global assistant identity
- code-session evidence is attached to a specific `codeSessionId`
- cross-scope evidence lookup remains explicit and read-only
- surfacing multiple scopes in one UI does not relax runtime scope boundaries

The temporal fact layer should follow the same rule:

- facts belong to a scope
- cross-scope access is explicit
- no implicit merging of all facts into all sessions

---

## Security And Trust Model

This is where Guardian must stay stricter than MemPalace-inspired systems.

### Hard requirements

- evidence chunks carry provenance and trust metadata
- untrusted evidence can be searchable without becoming prompt-authority material
- prompt-time evidence inclusion is bounded and sanitized
- fact promotion requires review or equivalent trust checks
- canonical memory continues to be integrity-aware and mutation-controlled

### Why this matters

MemPalace's direct value is recall quality. Guardian's harder problem is recall quality **plus** security posture.

A memory architecture that treats all stored text as equally eligible for prompt authority is not acceptable for Guardian.

---

## Operator Experience

The Memory/Wiki page should evolve into three linked views rather than one flat memory list:

1. **Canonical Memory**
   - current trusted durable memory and wiki content

2. **Evidence**
   - searchable excerpts, transcripts, rationale, and linked references

3. **Facts**
   - reviewed temporal facts and timelines

The topic graph should appear as navigation support, not as a mandatory mental model.

Examples:

- "show everything about auth migration"
- "show related topics"
- "show current facts"
- "show what was true on 2026-01-20"
- "show evidence behind this fact"

---

## Tooling Impact

Likely tool additions or extensions:

- `memory_evidence_search`
- `memory_topic_explore`
- `memory_fact_query`
- `memory_fact_promote`
- `memory_fact_invalidate`

These should integrate into the shared memory/runtime layer rather than becoming a separate product silo.

Existing tools should remain:

- `memory_search`
- `memory_recall`
- `memory_save`
- `memory_bridge_search`

The new tools should complement them, not replace them.

---

## Why We Should Not Just Implement MemPalace Directly

### 1. It conflicts with Guardian's ownership model

Guardian already has:

- a native TypeScript search stack
- a trust-aware durable memory stack
- scoped mutation services
- approval and provenance flows

Dropping in a second Python/Chroma-first memory runtime would create split ownership and unclear authority.

### 2. Its write model is too permissive for Guardian

MemPalace is optimized for local recall. Guardian must additionally protect against:

- prompt injection through stored content
- untrusted memory promotion
- cross-scope contamination
- uncontrolled high-authority writes

### 3. Its heuristic taxonomy should be an optimization, not the source of truth

Room/topic heuristics are useful for retrieval narrowing.

They are not a safe primary truth model for Guardian memory routing or fact mutation.

### 4. Guardian already has better architectural primitives

Guardian already possesses the key substrate needed to build this correctly:

- search indexing
- vector search
- BM25
- RRF fusion
- scoped memory
- mutation hygiene
- UI surfacing

The right move is to extend Guardian's native architecture, not bypass it.

---

## Suggested Implementation Phases

### Phase 1: Evidence corpus on Guardian-native search

- add a `MemoryEvidenceService`
- define evidence chunk schema and storage
- mirror selected conversation/code-session/automation evidence
- add `memory_evidence_search`

### Phase 2: Topic derivation and graph navigation

- derive topic keys from canonical memory and evidence
- build graph edges for repeated topics
- surface topic navigation in Memory/Wiki

### Phase 3: Reviewed temporal fact layer

- add fact store schema and APIs
- add promote/invalidate/query flows
- link facts back to evidence and canonical memory

### Phase 4: Retrieval orchestration

- teach the runtime when to use canonical memory vs evidence vs facts
- add trace diagnostics for evidence/fact selection
- keep prompt-time inclusion bounded and explainable

### Phase 5: Evaluation

- benchmark Guardian's retrieval on representative memory tasks
- compare baseline canonical-memory-only retrieval against:
  - canonical + evidence
  - canonical + evidence + topic narrowing
  - canonical + evidence + facts

This should be done on Guardian-relevant workloads, not only imported public benchmarks.

---

## File And Module Direction

Likely new modules:

- `src/runtime/memory-evidence-service.ts`
- `src/runtime/memory-topic-graph.ts`
- `src/runtime/temporal-fact-store.ts`
- `src/runtime/temporal-fact-service.ts`

Likely touched modules:

- `src/tools/builtin/memory-tools.ts`
- `src/runtime/dashboard-dispatch.ts`
- `src/runtime/run-timeline.ts`
- `web/public/js/pages/memory.js`
- `docs/guides/MEMORY-SYSTEM.md`

Likely search reuse points:

- `src/search/search-service.ts`
- `src/search/hybrid-search.ts`
- `src/search/document-store.ts`

---

## Main Recommendation

Guardian should adopt a **Guardian-native memory evidence architecture inspired by MemPalace**:

- keep canonical memory exactly where it belongs
- add a separate evidence-retrieval layer for verbatim recall
- add topic-graph navigation as a derived retrieval aid
- add a reviewed temporal fact layer for changing truths

This is a targeted re-architecture of retrieval and evidence handling, not a replacement of Guardian's memory core.

That is the right trade:

- better recall
- better rationale retrieval
- better historical truth handling
- no loss of Guardian's trust, scope, and integrity guarantees

---

## Open Questions

1. Should evidence storage reuse `src/search/` directly, or should it have a dedicated but compatible store abstraction?
2. What classes of evidence are allowed for automatic ingestion in v1?
3. Which fact promotions can be user-confirmed versus operator-reviewed only?
4. How much of the topic graph should be runtime-only versus persisted?
5. Should code-session evidence ever be promoted upward into global facts, or only through explicit bridge-and-promote flows?
