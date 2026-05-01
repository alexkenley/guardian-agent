# Memory System Uplift Plan

> Superseded as the primary implementation sequence by [Context, Memory, and Orchestration Uplift Plan](CONTEXT-MEMORY-ORCHESTRATION-UPLIFT-PLAN.md). This document remains as narrower historical planning context.

**Date:** 2026-03-20
**Status:** Draft (revised after implementation review)
**Origin:** Analysis of [Clawmark](https://github.com/jackccrawford/clawmark) memory system against GuardianAgent's existing memory architecture
**Key files:** `src/runtime/agent-memory-store.ts`, `src/runtime/conversation.ts`, `src/tools/executor.ts`, `src/index.ts`, `src/worker/worker-llm-loop.ts`, `src/broker/broker-server.ts`, `src/worker/worker-session.ts`, `src/prompts/guardian-core.ts`, `src/prompts/code-session-core.ts`, `src/search/embedding-provider.ts`

---

## Goal

Uplift the memory system with higher-quality retrieval, better structure, lower prompt overhead, and stronger operator visibility while preserving GuardianAgent's current strengths:

- trust-aware metadata and quarantine semantics
- Guardian-gated memory tools
- FTS5 conversation search
- global vs Code-session scope isolation
- automatic memory flush

This is a greenfield system in active development. Intentional behavior changes are acceptable if the docs, tests, and prompts are updated in the same workstream.

## Planning Constraints

- Both global agent memory and Code-session memory use `AgentMemoryStore`. Store-level uplifts must apply cleanly to both scopes.
- Memory mutation safeguards must apply to **all** mutating memory tools, not just `memory_save`.
- Trust, taint, and quarantine state must propagate through import, summarization, threading, and retrieval.
- Memory **content writes** are not the same as memory **control-plane changes**. Ordinary durable content writes can be auto-authorized when bounded and trusted; security-sensitive memory configuration/integrity changes must stay in the hardened control plane.
- Prompt-surface changes must cover the main runtime prompt assembly, delegated worker prompt assembly, and Code-session prompt variants.
- Reuse existing embedding/search abstractions where possible. Do not build an unrelated second embedding stack if the existing search layer can be extended.
- Storage and budget enforcement should land before bulk import and embedding caches expand the footprint.

---

## Current State

| Capability | Status |
|-----------|--------|
| Persistent KB (markdown + sidecar JSON index) | Implemented |
| Trust levels, provenance, quarantine | Implemented |
| Memory flush (dropped context -> KB previews) | Implemented |
| FTS5 conversation search (BM25) | Implemented |
| KB search (substring matching) | Implemented — but weak |
| Unified memory mutation policy across tools | **Not implemented** |
| Entry-aware KB context packing | **Not implemented** |
| Store budget enforcement (`maxFileChars` etc.) | Config exists, enforcement is weak |
| Ranked cross-source search output | **Not implemented** |
| Semantic/vector search on KB entries | **Not implemented** |
| Shared embedding provider reuse for memory | **Not implemented** |
| Summary/gist on KB entries | **Not implemented** |
| Memory threading (parent-child) | **Not implemented** |
| Bulk KB import | **Not implemented** |
| On-demand KB mode across all prompt surfaces | **Not implemented** |
| Memory / embedding operator status visibility | **Not implemented** |
| Trust-aware LLM flush | **Not implemented** |

---

## Uplift 0: Memory Store Hardening and Mutation Policy

### Problem

The current store is lightweight, but future features will increase write amplification and state size:

- `AgentMemoryStore` rewrites sidecar JSON and markdown synchronously
- `maxFileChars` exists in config but is not meaningfully enforced on append/import/flush
- embedding caches and bulk import will increase per-scope storage
- the explicit "remember/save" safeguard is tied to the tool name `memory_save`, not to memory mutation as a capability

### Solution

Land a hardening pass before semantic search and import:

1. Generalize the explicit-user-intent/approval policy to all mutating memory tools.
2. Enforce storage budgets at the store layer.
3. Keep expensive embedding work off the synchronous write path.

### Design

**Shared mutation policy**

- Introduce a shared concept such as `memory_mutation` capability or `isMemoryMutationTool(toolName)` helper.
- Apply it in:
  - `src/index.ts`
  - `src/worker/worker-llm-loop.ts`
  - `src/broker/broker-server.ts`
  - tool policy / approval handling
- Scope:
  - `memory_save`
  - `memory_import`
  - future memory review/promote tools if added later

**Memory write classes**

- **Class A: direct remembered facts**. `memory_save` from an explicit trusted user request should generally be auto-allowed once the runtime intent gate passes. It should not require a second human approval by default.
- **Class B: system-authored memory writes**. Built-in flows such as auto-flush, bounded deterministic summarization, or other runtime-owned memory maintenance should be auto-allowed, auditable, and trust-aware.
- **Class C: elevated memory mutations**. Bulk import, promote/unquarantine, cross-scope copy/promote, or future review actions should require approval.
- **Class D: memory control-plane changes**. `readOnly`, storage location, embedding provider/network destination, and similar security-sensitive config changes belong to the hardened control plane and should require privileged-ticket style protection rather than ordinary tool approval.

**Default runtime behavior**

- `memory_save` should not inherit the same approval posture as arbitrary mutating tools once explicit remember intent is established.
- The simplest implementation path is to keep the explicit intent gate, keep taint-based quarantine/approval behavior, and default `memory_save` to auto once those gates pass.
- `memory_import` and future review/promote tools remain approval-gated.
- `readOnly` must block both Class A and Class B writes, not just tool-originated `memory_save`.

**Store budget enforcement**

Extend KB config with explicit store limits:

```yaml
assistant:
  memory:
    knowledgeBase:
      maxContextChars: 4000
      maxFileChars: 20000
      maxEntryChars: 2000
      maxEntriesPerScope: 500
      maxEmbeddingCacheBytes: 50000000
```

Behavior:

- reject or truncate over-large single entries with explicit errors
- reject or partially import when a batch would exceed store limits
- prefer dropping expired/rejected entries from context calculations first
- keep embedding backfill asynchronous/best-effort so `memory_save` is not blocked by vector generation

**Versioning**

- Bump sidecar format from `version: 1` to `version: 2` once summary/threading metadata lands.
- Keep lazy read-backfill for missing optional fields.

### Files to modify

- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`
- `src/index.ts`
- `src/worker/worker-llm-loop.ts`
- `src/broker/broker-server.ts`
- `src/config/types.ts`

### Tests

- `src/runtime/agent-memory-store.test.ts` — size enforcement, entry caps, partial import handling
- `src/tools/executor.test.ts` — all mutating memory tools follow the same intent/approval policy
- worker/broker tests — shared gating for memory mutation tools

---

## Uplift 1: Summary Field and Entry-Aware Context Packing

### Problem

Memory entries are flat content strings, and `loadForContext()` currently truncates the rendered markdown by raw character slice. That is token-inefficient and can cut entries mid-thought.

### Solution

Add a `summary` field to `MemoryEntry` and change prompt injection to pack entries deliberately instead of slicing a pre-rendered blob.

### Design

**Extend `MemoryEntry`**

```typescript
export interface MemoryEntry {
  content: string;
  summary?: string;        // short gist, max ~200 chars
  createdAt: string;
  category?: string;
  // ... existing fields
}
```

**Summary generation**

- if the caller provides `summary`, persist it
- if absent and `content` is long, derive a deterministic summary from the first sentence / leading text
- no LLM dependency in the first iteration

**Context packing**

Replace naive `full.slice(...)` behavior with entry-aware packing:

- render entries category-by-category
- prefer `summary` when full content would exceed the remaining budget
- include full content for short/high-value entries when it still fits
- avoid cutting an entry in the middle

**Tool changes**

`memory_save` gains:

```text
memory_save:
  content: string (required)
  summary: string (optional)
  category: string (optional)
```

`memory_recall` and search results should expose both `summary` and full `content` where appropriate.

### Files to modify

- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`
- `src/runtime/agent-memory-store.test.ts`

### Tests

- summary generation
- summary-first context rendering
- no mid-entry truncation in packed context
- full content remains available through recall

---

## Uplift 2: Ranked Unified Memory Search

### Problem

Today:

- `memory_search` only searches conversation history
- KB search exists separately and weakly
- scores are surfaced for conversation search but are not normalized for cross-source use
- raw BM25 and cosine similarity are not directly comparable

### Solution

Make `memory_search` the unified search tool for conversation history and KB retrieval, with source-aware ranking metadata and explicit merge logic.

This is an intentional behavior change and acceptable for a greenfield system.

### Design

**Updated tool shape**

```text
memory_search:
  query: string (required)
  scope: 'conversation' | 'knowledge_base' | 'both' (default: 'both')
  limit: number (default: 10, max: 50)
```

**Result schema**

Each result should include:

- `source`: `conversation` or `knowledge_base`
- `rank`
- `rawScore`
- `normalizedScore`
- `matchStrategy`: `fts`, `substring`, or `semantic`
- source-specific identifiers (`sessionId`, `entryId`, etc.)

**Merge strategy**

- Do **not** compare raw BM25 and cosine similarity directly.
- Merge sources with Reciprocal Rank Fusion (RRF) or a similarly rank-based strategy.
- Preserve source labels in the output so the model can distinguish recalled conversation from durable memory.

**Conversation branch**

- keep FTS5 search
- surface raw BM25 score plus rank order
- normalize for display/search output only, not for direct numeric comparison against other sources

**Knowledge-base branch**

- use substring ranking initially
- switch to semantic ranking once Uplift 3 lands
- return summary-first display text with full content available on demand

**Bridge search**

- `memory_bridge_search` stays read-only and cross-scope
- it continues to search persistent KB entries only, not conversation history

### Files to modify

- `src/runtime/conversation.ts`
- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`

### Tests

- merged result ordering via RRF
- source labeling
- score metadata presence
- conversation-only / KB-only / both modes

---

## Uplift 3: Semantic Search on Memory Entries (Shared Embedding Infrastructure)

### Problem

Substring matching misses semantically related memories. A query like "authentication bug" should be able to find "token refresh race condition in auth middleware".

### Solution

Add semantic retrieval for KB entries by extending the **existing** embedding-provider/search infrastructure rather than creating a separate isolated memory embedding stack.

### Design

**Provider strategy**

Phase 2a:

- reuse the current embedding provider abstraction in `src/search/embedding-provider.ts`
- support memory embeddings via configured `ollama` or `openai` providers

Phase 2b:

- add optional ONNX local embeddings
- no silent background model download
- ONNX must use explicit bootstrap/provisioning; if assets are missing, semantic search degrades gracefully to non-semantic search

**New file**

- `src/runtime/memory-vector-index.ts` (or equivalent) to manage memory-entry embeddings and similarity search

**Embedding cache**

Use a per-scope cache file, not just per agent, because global memory and Code-session memory both share the same store implementation:

```json
{
  "provider": "ollama",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "entries": {
    "entry-uuid-1": {
      "contentHash": "sha256...",
      "embedding": [0.023, -0.041]
    }
  }
}
```

Storage behavior:

- one cache file per scope id (`agentId` or `codeSessionId`)
- invalidated by `contentHash` changes
- bounded by `maxEmbeddingCacheBytes`

**Write path**

- `append()` and import enqueue embedding generation best-effort
- writes should succeed even if embedding generation fails
- backfill runs in bounded batches

**Config**

```yaml
assistant:
  memory:
    knowledgeBase:
      semanticSearch:
        provider: 'ollama'      # 'ollama' | 'openai' | 'onnx' | 'off'
        model: 'nomic-embed-text'
        baseUrl: 'http://localhost:11434'
        apiKey: ''
        modelsPath: '~/.guardianagent/models'
        autoEmbed: true
        backfillBatchSize: 32
        maxCacheBytes: 50000000
```

**Status hooks**

- expose provider/model/cache coverage through Uplift 7

### Files to modify

- `src/runtime/agent-memory-store.ts`
- `src/runtime/memory-vector-index.ts` (new)
- `src/search/embedding-provider.ts`
- `src/config/types.ts`
- `src/index.ts`

### Tests

- `src/runtime/agent-memory-store.test.ts` — semantic ranking, fallback behavior, cache invalidation
- `src/runtime/memory-vector-index.test.ts` — cosine similarity, cache read/write, bounded backfill
- provider tests for any ONNX-specific bootstrap path

### Dependencies

- Phase 2a: no new provider families required beyond existing search providers
- Phase 2b: `onnxruntime-node` only if ONNX support is explicitly added

---

## Uplift 4: Memory Threading

### Problem

Related memories are flat and disconnected. The system cannot easily represent "decision -> implementation -> follow-up outcome" as a linked chain.

### Solution

Add optional `parentId` links so entries can form threads.

### Design

**Extend `MemoryEntry`**

```typescript
export interface MemoryEntry {
  content: string;
  summary?: string;
  parentId?: string;
  createdAt: string;
  // ... existing fields
}
```

**Traversal**

- `getThread(scopeId, entryId)` returns the containing thread in chronological order
- search results expose thread metadata such as:
  - `threadSize`
  - `threadRootId`
  - `threadRootSummary`

**Tool changes**

`memory_save` gains:

```text
memory_save:
  content: string (required)
  summary: string (optional)
  category: string (optional)
  parentId: string (optional)
```

`memory_recall` gains:

```text
memory_recall:
  agentId: string (optional)
  entryId: string (optional)
```

When `entryId` is provided, return the thread containing that entry.

### Files to modify

- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`
- `src/runtime/agent-memory-store.test.ts`

### Tests

- parent-child linking
- thread traversal
- orphan handling
- search result thread metadata

---

## Uplift 5: Bulk KB Import

### Problem

There is no structured bootstrap path for seeding memory from existing project docs or notes.

### Solution

Add a `memory_import` tool and `/memory import` CLI command for **local file and directory** import in the current memory scope.

Remote URL import is deferred out of scope for the first iteration.

### Design

**Scope behavior**

- outside Code: import into the current global memory scope
- inside Code: import into the active Code-session memory scope

**Import logic**

1. Read local markdown file(s)
2. Split by headers when `splitHeaders` is enabled
3. Create a synthetic root/file entry
4. Use section heading as `category`
5. Use first line or derived gist as `summary`
6. Persist full section as `content`
7. Thread sections under the file/root entry
8. Dedup by exact content hash against:
   - the current import batch
   - existing entries in the current scope

**Trust**

- local file imports default to trusted/active
- imported content still passes through the shared memory mutation policy from Uplift 0

**Tool**

```text
memory_import:
  source: string (required) — file path or directory path
  splitHeaders: boolean (default: true)
  category: string (optional)
  dryRun: boolean (default: false)
```

Risk: `mutating`. Category: `memory`.

**CLI**

```text
/memory import <path> [--dry-run]
```

### Files to modify

- `src/runtime/agent-memory-store.ts`
- `src/tools/executor.ts`
- `src/channels/cli.ts`

### Tests

- header splitting
- dry-run preview
- exact-hash dedup during import
- file-root threading
- current-scope routing in and out of Code sessions

---

## Uplift 6: On-Demand KB Mode Across All Prompt Surfaces

### Problem

Always injecting KB content into the prompt adds fixed token cost even when the memory is irrelevant.

### Solution

Add an `injection` mode for the KB and make sure it is honored everywhere the runtime currently assembles prompts.

### Design

**Config**

```yaml
assistant:
  memory:
    knowledgeBase:
      injection: 'always'     # 'always' | 'on-demand'
```

**Behavior**

- `always`: current behavior
- `on-demand`: do not inject KB content by default; instruct the model to use tools for retrieval

**Prompt surfaces that must honor this**

- main runtime prompt assembly in `src/index.ts`
- delegated worker prompt assembly in `src/worker/worker-session.ts`
- normal assistant system prompt in `src/prompts/guardian-core.ts`
- Code-session system prompt in `src/prompts/code-session-core.ts`

**Tool availability**

- `memory_search` already remains available
- `memory_recall` should be added to the always-loaded tool set when on-demand mode is in use, or promoted to always-loaded globally

**Prompt notes**

Normal chat note:

```text
You have a persistent knowledge base with saved facts, preferences, and prior context.
Use memory_search or memory_recall when relevant instead of assuming memory is already loaded.
```

Code-session note:

```text
You have session-local durable memory for this coding session.
Use memory_search or memory_recall when you need prior session context.
Use memory_bridge_search only for read-only reference from the other scope.
```

### Files to modify

- `src/config/types.ts`
- `src/index.ts`
- `src/prompts/guardian-core.ts`
- `src/prompts/code-session-core.ts`
- `src/worker/worker-session.ts`

### Tests

- KB omitted from prompt in on-demand mode
- prompt note present in normal and Code-session variants
- worker prompt assembly honors on-demand mode
- `memory_recall` availability is preserved

---

## Uplift 7: Memory / Embedding Status Visibility

### Problem

Operators currently have no clear visibility into:

- entry counts by scope
- active vs quarantined memory
- embedding cache coverage
- whether semantic search is actually ready
- whether backfill is stuck or degraded

### Solution

Add runtime-visible status surfaces for memory and embedding health.

### Design

**API endpoint**

```json
{
  "globalScopes": [
    {
      "scopeId": "assistant",
      "entries": 47,
      "activeEntries": 42,
      "quarantinedEntries": 5,
      "sizeChars": 12847,
      "semanticSearchConfigured": true,
      "semanticSearchReady": true,
      "embeddingCache": {
        "cached": 42,
        "total": 42,
        "provider": "ollama",
        "model": "nomic-embed-text"
      }
    }
  ],
  "codeSessionScopes": [],
  "provider": "ollama",
  "lastError": null
}
```

**CLI**

```text
/memory status
```

**Web**

- `GET /api/memory/status`
- wire through dashboard callbacks and `src/channels/web-types.ts`

### Files to modify

- `src/runtime/agent-memory-store.ts`
- `src/channels/web.ts`
- `src/channels/web-types.ts`
- `src/channels/cli.ts`
- `src/index.ts`

### Tests

- accurate counts and scope separation
- provider/model reporting
- degraded-mode reporting when semantic search is configured but unavailable

---

## Uplift 8: Trust-Aware LLM-Powered Memory Flush

### Problem

Current flush behavior stores raw previews. They are noisy, and the flush pipeline does not currently carry trust metadata strongly enough to summarize safely.

### Solution

Add an optional summarized flush mode, but only after the flush path can preserve taint/trust state end-to-end.

### Design

**Config**

```yaml
assistant:
  memory:
    knowledgeBase:
      autoFlush: true
      flushMode: 'preview'    # 'preview' | 'summarize'
```

**Conversation metadata changes**

The current conversation model only stores `role`, `content`, and `timestamp`. To make trust-aware summarization real rather than aspirational:

- extend conversation entry metadata to carry trust/taint information needed by flush
- update `recordTurn()` and the flush callback path accordingly
- persist enough metadata in conversation storage for flush behavior to remain correct after restarts

Candidate fields:

- `contentTrustLevel`
- `derivedFromTaintedContent`
- `taintReasons`

**Summarize mode**

- summarize dropped context into concise factual statements
- local/cheap provider preferred
- timeout-bounded with fallback to preview mode
- if `knowledgeBase.readOnly` is enabled, do not persist preview or summarized flush output

**Trust propagation**

- if all dropped content is trusted and untainted, the summary may become active
- if any dropped content is low-trust or tainted, the summary defaults to quarantined/untrusted
- taint reasons are unioned into the summary provenance
- preview fallback inherits the same trust/status decision

**Prompting**

Use a small summarization prompt focused on:

- decisions made
- facts learned
- preferences expressed
- no conversational filler

### Files to modify

- `src/runtime/conversation.ts`
- `src/index.ts`
- `src/config/types.ts`
- related tests in `src/runtime/conversation.test.ts`

### Tests

- summarize mode happy path
- timeout fallback to preview
- trusted content stays active
- tainted content yields quarantined summaries
- trust metadata survives restart/reload behavior

---

## Implementation Order

### Phase 0: Hardening

1. **Uplift 0: Memory store hardening and mutation policy**
2. **Uplift 1: Summary field and entry-aware context packing**
3. **Uplift 2: Ranked unified memory search (substring + FTS only)**

### Phase 1: Visibility and semantic foundation

4. **Uplift 7: Memory status visibility (counts + degraded mode scaffolding)**
5. **Uplift 3 Phase 2a: Semantic search using existing providers**
6. **Uplift 3 Phase 2b: Optional ONNX provider with explicit bootstrap**

### Phase 2: Structure and ingest

7. **Uplift 4: Memory threading**
8. **Uplift 5: Bulk KB import**

### Phase 3: Prompt-cost optimization

9. **Uplift 6: On-demand KB mode across all prompt surfaces**

### Phase 4: Flush quality

10. **Uplift 8: Trust-aware LLM-powered memory flush**

---

## Scope Boundaries

### In scope

- global agent memory
- Code-session memory
- memory tools (`memory_search`, `memory_save`, `memory_recall`, `memory_bridge_search`, `memory_import`)
- prompt assembly surfaces that currently inject KB content
- store budget enforcement and sidecar evolution
- shared embedding provider reuse for memory retrieval
- minimal conversation metadata/schema extensions needed for trust-aware flush

### Out of scope

- remote URL import in the first iteration
- automatic cross-agent/shared-station memory
- automatic cross-scope promotion/sync
- general fuzzy dedup beyond exact-hash import guardrails
- document search feature redesign outside the shared embedding/provider abstractions already in repo

---

## Testing Strategy

Each uplift lands with targeted unit/integration coverage:

| Uplift | Test files | Key assertions |
|--------|-----------|----------------|
| 0 (Hardening) | `agent-memory-store.test.ts`, `executor.test.ts`, worker/broker tests | size enforcement, shared mutation gating, partial import rejection |
| 1 (Summary + packing) | `agent-memory-store.test.ts` | summary generation, entry-aware packing, no mid-entry truncation |
| 2 (Unified search) | `conversation.test.ts`, `executor.test.ts`, `agent-memory-store.test.ts` | source-aware search output, RRF merge, score metadata |
| 3 (Semantic search) | `agent-memory-store.test.ts`, `memory-vector-index.test.ts` | semantic ranking, cache invalidation, graceful fallback |
| 4 (Threading) | `agent-memory-store.test.ts` | parent-child linking, thread traversal, thread metadata |
| 5 (Import) | `agent-memory-store.test.ts`, CLI tests | header splitting, dry-run, exact-hash dedup, scope routing |
| 6 (On-demand mode) | prompt tests, worker tests, executor tests | KB omitted from prompt, tool availability preserved, Code-session prompt note present |
| 7 (Status) | `agent-memory-store.test.ts`, channel/API tests | accurate counts, provider/model visibility, degraded-mode visibility |
| 8 (Flush) | `conversation.test.ts`, runtime tests | summarization path, timeout fallback, trust/quarantine propagation |

Integration harness:

- extend `scripts/test-coding-assistant.mjs` with memory retrieval and on-demand mode assertions
- add a memory-import + semantic-search integration path once Uplifts 3 and 5 land

---

## Migration / Dev Data Strategy

This plan does **not** optimize for strict backward compatibility.

Expected posture:

- behavior changes are allowed where they improve the design
- `memory_search` intentionally becomes a unified search tool by default
- sidecar JSON may bump versions as needed
- embedding caches are rebuilt lazily
- local dev data migration can be best-effort; reset/rebuild is acceptable when simpler than preserving obsolete draft formats

Operator note:

- if ONNX support is added, model assets must be provisioned explicitly
- no silent background model download should be required for runtime startup or first query
