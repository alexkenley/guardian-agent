# Implementation Plan: Dify-Inspired Improvements

> **Note:** This proposal has been promoted to a spec. See [`docs/specs/DIFY-INSPIRED-IMPROVEMENTS-SPEC.md`](../specs/DIFY-INSPIRED-IMPROVEMENTS-SPEC.md) for the authoritative version with implementation status.

> Based on analysis of [Dify](https://github.com/langgenius/dify) against GuardianAgent (2026-03-11)

## Overview

Six improvements inspired by Dify's architecture, prioritized by value and effort:

| # | Feature | Effort | Files Changed |
|---|---------|--------|---------------|
| 1 | Replace QMD with native TypeScript search | Medium | ~15 new, ~8 modified |
| 2 | Per-step retry + fail-branch in orchestration | Small | ~3 modified |
| 3 | ConditionalAgent / RouterAgent | Small | ~2 new, ~2 modified |
| 4 | Array iteration mode for LoopAgent | Small | ~1 modified, ~1 test |
| 5 | SSRF protection for outbound HTTP | Small | ~2 new, ~3 modified |
| 6 | Model provider plugin interface | Medium | ~4 new, ~6 modified |

---

## 1. Replace QMD with Native TypeScript Search Pipeline

### Problem
QMD is a Go CLI binary invoked via subprocess. It's unreliable because:
- External binary may not be available on all platforms
- Source CRUD is in-memory only (lost on restart)
- Per-query subprocess overhead (50-200ms)
- Shell quoting edge cases on Windows
- 5MB buffer hardcoded, JSON format brittleness

### Solution
Native TypeScript search pipeline using SQLite FTS5 (BM25) + sqlite-vec (vector) with parent-child chunking.

### New Module: `src/search/`

```
src/search/
  types.ts              — SearchResult, SearchOptions, ChunkRecord, CollectionInfo
  document-store.ts     — SQLite schema, document/chunk CRUD, source persistence
  document-parser.ts    — Parse PDF, HTML, markdown, plain text, DOCX → plain text
  chunker.ts            — Parent-child chunking (index sentences, return paragraphs)
  embedding-provider.ts — EmbeddingProvider interface + Ollama/OpenAI implementations
  vector-store.ts       — sqlite-vec virtual table, KNN similarity search
  fts-store.ts          — FTS5 BM25 index (mirrors conversation.ts pattern)
  hybrid-search.ts      — BM25 + vector search, Reciprocal Rank Fusion merge
  search-service.ts     — Top-level service (replaces QMDSearchService)
  reranker.ts           — Optional Cohere API / LLM-based re-ranking
  index.ts              — Barrel export
  *.test.ts             — Co-located tests for each module
```

### Key Types (`src/search/types.ts`)

```typescript
export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchOptions {
  query: string;
  mode?: SearchMode;         // default: 'hybrid'
  collection?: string;       // source ID filter
  limit?: number;            // default: 20, max 100
  includeBody?: boolean;
  rerank?: boolean;
}

export interface SearchResult {
  score: number;
  filepath: string;
  title: string;
  context: string;           // parent chunk text (surrounding context)
  snippet: string;           // matched child chunk text
  documentId: string;
  collectionName: string;
  chunkId: string;
  body?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  mode: SearchMode;
  collection?: string;
  totalResults: number;
  durationMs: number;
}
```

### SQLite Schema (`document-store.ts`)

```sql
-- Persisted source configuration (fixes QMD in-memory bug)
CREATE TABLE IF NOT EXISTS search_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'directory' | 'git' | 'url' | 'file'
  path TEXT NOT NULL,
  globs TEXT,                  -- JSON array
  branch TEXT,
  enabled INTEGER DEFAULT 1,
  description TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- Indexed documents
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES search_sources(id),
  filepath TEXT NOT NULL,
  title TEXT,
  content_hash TEXT NOT NULL,  -- SHA-256 for change detection
  mime_type TEXT,
  size_bytes INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

-- Parent and child chunks
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_chunk_id TEXT REFERENCES chunks(id),  -- NULL for parent chunks
  content TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  token_count INTEGER,
  chunk_type TEXT NOT NULL     -- 'parent' | 'child'
);

-- FTS5 index for BM25 keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Sync triggers (same pattern as conversation.ts)
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

-- Vector embeddings via sqlite-vec (loaded as extension)
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[768]        -- dimensions configurable per model
);
```

### Parent-Child Chunking (`chunker.ts`)

Implements Dify's dual-layer strategy:
- **Parent chunks**: 512-1024 tokens, split on paragraph/section boundaries (double newline, heading markers)
- **Child chunks**: 128-256 tokens, split within parent chunks on sentence boundaries
- Each child stores `parent_chunk_id` foreign key
- On search match: child provides precision, parent provides context
- Configurable via `SearchConfig.chunking` (parentTokens, childTokens, overlapTokens)

### Embedding Provider (`embedding-provider.ts`)

```typescript
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

Two implementations:
- `OllamaEmbeddingProvider`: `POST ${baseUrl}/api/embed` with `{ model, input }`. Default: `nomic-embed-text` (768d)
- `OpenAIEmbeddingProvider`: `client.embeddings.create()`. Default: `text-embedding-3-small` (1536d)

Batch support: up to 32 texts per call. Provider auto-selected from existing LLM config (prefer local Ollama for speed).

### Hybrid Search Pipeline (`hybrid-search.ts`)

1. Run BM25 query via FTS5 → ranked results with BM25 scores
2. Embed query via EmbeddingProvider → query vector
3. Run KNN search via sqlite-vec → ranked results with cosine similarity
4. Merge via Reciprocal Rank Fusion: `score(d) = Σ 1/(k + rank_i(d))` where k=60
5. Deduplicate by chunk ID
6. Resolve parent chunks: for each matched child, fetch parent chunk content
7. Optionally re-rank top-N via Cohere API or LLM scoring

### Graceful Degradation

- If sqlite-vec extension fails to load → vector search disabled, keyword-only mode works
- If no embedding provider available → semantic/hybrid modes return clear error
- If Cohere API key not configured → re-ranking disabled, results returned without it

### Config Changes (`src/config/types.ts`)

Replace `QMDConfig` with `SearchConfig`:

```typescript
export interface SearchConfig {
  enabled: boolean;
  sqlitePath?: string;          // default: ~/.guardianagent/search-index.sqlite
  defaultMode?: SearchMode;     // default: 'hybrid'
  maxResults?: number;          // default: 20
  sources: SearchSourceConfig[];
  embedding?: {
    provider?: 'ollama' | 'openai';
    model?: string;
    batchSize?: number;         // default: 32
    dimensions?: number;        // auto-detected if not set
  };
  chunking?: {
    parentTokens?: number;      // default: 768
    childTokens?: number;       // default: 192
    overlapTokens?: number;     // default: 48
  };
  reranker?: {
    enabled: boolean;
    provider?: 'cohere' | 'llm';
    model?: string;
    topN?: number;              // default: 10
  };
}
```

Keep `assistant.tools.qmd` as deprecated alias; config loader merges into `assistant.tools.search`.

### Tool Changes (`src/tools/executor.ts`)

Replace QMD tools with:
- `doc_search` (replaces `qmd_search`) — mode enum: `keyword | semantic | hybrid`
- `doc_search_status` (replaces `qmd_status`)
- `doc_search_reindex` (replaces `qmd_reindex`)

Register old names as aliases for backward compatibility with existing automations.

### Web API Changes (`src/channels/web.ts`)

Add `/api/search/*` endpoints alongside deprecated `/api/qmd/*`:
- `GET /api/search/status`
- `GET /api/search/sources`
- `POST /api/search/sources`
- `DELETE /api/search/sources/:id`
- `PATCH /api/search/sources/:id`
- `POST /api/search/reindex`

### Dependencies

```
Add:    sqlite-vec (vector extension for SQLite)
Add:    pdf-parse (optional, for PDF parsing)
Add:    mammoth (optional, for DOCX parsing)
Remove: @tobilu/qmd
```

### Implementation Phases

| Phase | Scope | Files |
|-------|-------|-------|
| 1 | Types, SQLite schema, document parser, chunker | types.ts, document-store.ts, document-parser.ts, chunker.ts |
| 2 | FTS5 keyword search + search service skeleton | fts-store.ts, search-service.ts (keyword mode only) |
| 3 | Embedding infrastructure | embedding-provider.ts, src/llm/types.ts |
| 4 | Vector search + sqlite-vec | vector-store.ts, package.json |
| 5 | Hybrid search + re-ranking | hybrid-search.ts, reranker.ts |
| 6 | Integration (tools, bootstrap, web, config) | executor.ts, index.ts, web.ts, config/types.ts |
| 7 | Web UI + docs | config.js, api.js, reference-guide.ts |
| 8 | Cleanup (remove QMD) | Delete qmd-search.ts, qmd-search.test.ts, @tobilu/qmd |

---

## 2. Per-Step Retry + Fail-Branch in Orchestration Agents

### Problem
SequentialAgent only has a binary `stopOnError` flag. If a step fails, the pipeline either stops completely or ignores the error. There's no retry, no fallback value, and no alternative execution path.

### Solution
Add per-step error handling configuration inspired by Dify's four strategies: Abort, Default Value, Fail Branch, Retry.

### Prerequisite: Extract Shared Utilities

Before implementing, refactor shared code from the orchestration agents to avoid duplication:

1. **`runWithConcurrencyLimit()`** — move from `ParallelAgent` private method to module-level function (reused by LoopAgent array mode)
2. **`executeWithRetry()`** — new module-level function wrapping `ctx.dispatch()` with retry logic
3. **`runStepsSequentially()`** — extract the sequential step execution loop (~40 lines in SequentialAgent.onMessage) into a module-level function (reused by ConditionalAgent)
4. **`prepareStepInput()`** — extract input resolution logic (read from SharedState, validate input contract)
5. **`recordStepOutput()`** — extract output contract validation + state.set() logic

### Type Changes (`src/agent/orchestration.ts`)

Add to `OrchestrationStep` interface:

```typescript
export interface StepRetryPolicy {
  maxRetries: number;              // 0 = no retries
  initialDelayMs?: number;         // default: 1000
  backoffMultiplier?: number;      // default: 2.0 (exponential)
  maxDelayMs?: number;             // default: 30000
  retryableError?: (error: Error) => boolean;  // default: all errors retryable
}

export interface StepFailBranch {
  agentId: string;
  inputKey?: string;
  outputKey?: string;
  inputContract?: OrchestrationStepContract;
  outputContract?: OrchestrationStepContract;
}

export interface OrchestrationStep {
  // ... existing fields (agentId, inputKey, outputKey, contract, etc.)
  retry?: StepRetryPolicy;
  onError?: StepFailBranch;  // fail-branch: agent invoked when step fails all retries
}
```

### Helper: `executeWithRetry()`

```typescript
async function executeWithRetry(
  dispatch: (agentId: string, message: UserMessage) => Promise<AgentResponse>,
  agentId: string,
  message: UserMessage,
  policy: StepRetryPolicy | undefined,
  log: Logger,
): Promise<AgentResponse> {
  const maxRetries = policy?.maxRetries ?? 0;
  const initialDelay = policy?.initialDelayMs ?? 1000;
  const multiplier = policy?.backoffMultiplier ?? 2;
  const maxDelay = policy?.maxDelayMs ?? 30_000;
  const isRetryable = policy?.retryableError ?? (() => true);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await dispatch(agentId, message);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries && isRetryable(lastError)) {
        const delay = Math.min(initialDelay * Math.pow(multiplier, attempt), maxDelay);
        log.warn({ agentId, attempt, delay, error: lastError.message }, 'Step failed, retrying');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}
```

### SequentialAgent Changes

In `onMessage()`, replace the try/catch block (lines ~221-259) with:

1. Call `executeWithRetry(ctx.dispatch, step.agentId, stepMessage, step.retry, log)`
2. If that throws and `step.onError` is defined, dispatch to the fail-branch agent. Store original error in SharedState at `{outputKey}:error` so the fail-branch can access it.
3. If fail-branch also throws (or none defined), fall through to existing `stopOnError` logic

```typescript
for (const step of this.steps) {
  const stepMessage = prepareStepInput(step, state, message);

  try {
    const response = await executeWithRetry(ctx.dispatch, step.agentId, stepMessage, step.retry, log);
    recordStepOutput(step, state, response);
  } catch (err) {
    if (step.onError) {
      // Store error context for fail-branch
      state.set(`${step.outputKey ?? step.agentId}:error`, err.message);
      try {
        const fbInput = prepareStepInput(step.onError, state, message);
        const fbResponse = await ctx.dispatch(step.onError.agentId, fbInput);
        recordStepOutput({ ...step, outputKey: step.onError.outputKey ?? step.outputKey }, state, fbResponse);
        continue; // fail-branch succeeded, pipeline continues
      } catch (fbErr) {
        // fail-branch also failed, fall through to stopOnError
      }
    }
    if (this.stopOnError) throw err;
    state.set(`${step.outputKey ?? step.agentId}:error`, err.message);
  }
}
```

### ParallelAgent Changes

Same pattern per-step within `Promise.allSettled()`. Retries happen within each step's promise, so the concurrency slot remains occupied during retries (correct behavior — a retrying step should not release its slot).

### Backward Compatibility

- If `step.retry` is not set → no retries (existing behavior)
- If `step.onError` is not set → error propagates to `stopOnError` logic (existing behavior)
- `stopOnError` remains as the pipeline-level fallback; `step.onError` takes precedence per-step
- No changes to existing automation/playbook JSON format unless new fields are used
- Response metadata gains `retriedSteps: Array<{ agentId, attempts, usedFailBranch }>` for observability

### Files Modified
- `src/agent/orchestration.ts` — extract utilities, add types, modify SequentialAgent.onMessage(), ParallelAgent.onMessage()
- `src/agent/orchestration.test.ts` — add test cases for retry, default value, fail branch
- `src/tools/executor.ts` — update automation tool descriptions/examples to mention retry/onError

### Test Cases (11 tests)
1. Step with `retry: { maxRetries: 2 }` succeeds on first try — dispatched once, no delay
2. Step fails once, succeeds on retry — dispatched twice, first delay applied
3. Step fails all retries — error propagates, `stopOnError` applies
4. Step fails all retries with `onError` branch — fail-branch agent invoked, pipeline continues
5. Step fails, `retryableError` returns false — no retries attempted
6. Fail-branch also fails — original error surfaces, `stopOnError` applies
7. Metadata includes `retriedSteps` array
8. Backoff delay calculation: verify exponential growth capped at `maxDelayMs` (use `vi.useFakeTimers()`)
9. ParallelAgent: one step retries and succeeds — final result shows success
10. ParallelAgent: one step fails all retries with `onError` — fail-branch used
11. Backward compat: existing `stopOnError: true` still aborts on error, no retry/onError fields

---

## 3. ConditionalAgent

### Problem
GuardianAgent has no first-class conditional branching primitive. Routing logic must be implemented inside agent code or via the Runtime's `MessageRouter`. Dify has IF/ELSE and Question Classifier nodes.

> **Note**: Named `ConditionalAgent` (not `RouterAgent`) to avoid confusion with the existing `RouterAgent` interface in `src/runtime/message-router.ts` line 35.

### Solution
A new orchestration agent that evaluates ordered branch conditions against SharedState and dispatches to the first matching branch's steps.

### Types

```typescript
export interface ConditionalBranch {
  /** Human-readable name (for logging/debugging). */
  name: string;
  /** Condition predicate. First match wins. */
  condition: (state: SharedStateView, message: UserMessage) => boolean;
  /** Steps to execute when this branch is selected (run sequentially). */
  steps: OrchestrationStep[];
}

export interface ConditionalAgentOptions {
  /** Ordered list of branches. First matching branch wins. */
  branches: ConditionalBranch[];
  /** Default steps if no branch matches. If omitted, returns error response. */
  defaultSteps?: OrchestrationStep[];
  /** Validation mode for step contracts. */
  validationMode?: ValidationMode;
  /** Keys to copy from parent orchestration's SharedState. */
  inheritStateKeys?: string[];
}
```

### Implementation

```typescript
export class ConditionalAgent extends BaseAgent {
  constructor(id: string, name: string, private options: ConditionalAgentOptions) {
    super(id, name, { handleMessages: true, handleEvents: false, handleSchedule: false });
  }

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    if (!ctx.dispatch) {
      return { content: '[ConditionalAgent requires dispatch capability]' };
    }

    const state = new SharedState();
    state.set('input', message.content);

    // Inherit state from parent orchestration
    if (ctx.sharedState) {
      for (const key of this.options.inheritStateKeys ?? []) {
        if (ctx.sharedState.has(key)) state.set(key, ctx.sharedState.get(key));
      }
    }

    // Evaluate branches — first match wins
    let selectedSteps: OrchestrationStep[] | undefined;
    let selectedBranch = 'default';

    for (const branch of this.options.branches) {
      if (branch.condition(state.asReadOnly(), message)) {
        selectedSteps = branch.steps;
        selectedBranch = branch.name;
        break;
      }
    }

    selectedSteps ??= this.options.defaultSteps;
    if (!selectedSteps) {
      return { content: '[ConditionalAgent: no branch matched]', metadata: { branchSelected: null } };
    }

    // Execute branch steps using extracted runStepsSequentially() utility
    const result = await runStepsSequentially(selectedSteps, message, state, ctx.dispatch, this.options.validationMode ?? 'warn', true);

    state.clearTemp();
    return {
      content: result.lastContent ?? '[No steps completed]',
      metadata: { orchestration: 'conditional', branchSelected: selectedBranch, state: state.snapshot() },
    };
  }
}
```

### Multi-Way Routing

For multi-way routing (Dify's Question Classifier equivalent), use ConditionalAgent with multiple branches:
```typescript
new ConditionalAgent('router', 'Intent Router', {
  branches: [
    { name: 'billing', condition: (s) => s.get('intent') === 'billing', steps: billingSteps },
    { name: 'technical', condition: (s) => s.get('intent') === 'technical', steps: techSteps },
    { name: 'general', condition: () => true, steps: generalSteps },  // catch-all
  ],
});
```

### Automation Integration

For automations created via tools/UI, conditions expressed as declarative specs:
- `stateEquals: { key: 'status', value: 'approved' }` — simple state comparison
- `inputContains: 'urgent'` — input text check
- `llmClassify: { prompt: '...', routes: ['billing', 'technical', 'general'] }` — LLM-based (Phase 2)

### Future: LLM-Based Routing (Phase 2, not initial implementation)

Add optional `llmDescription` field to `ConditionalBranch` alongside the predicate `condition`. When provided, the ConditionalAgent uses `ctx.llm` to classify the input against branch descriptions. Document the extension point but leave unimplemented initially.

### Files Created
- `src/agent/conditional.ts` — ConditionalAgent class
- `src/agent/conditional.test.ts` — test cases

### Files Modified
- `src/agent/index.ts` — export new agent
- `src/tools/executor.ts` — update `workflow_upsert` to accept conditional step types
- `src/index.ts` — register ConditionalAgent as available orchestration type

### Test Cases (10 tests)
1. Single branch matches — dispatches to branch steps, returns result
2. Multiple branches — first matching wins, later branches not evaluated
3. No branch matches, default defined — default steps execute
4. No branch matches, no default — error response returned
5. Branch steps use input/output contracts — validation works
6. Branch condition reads inherited SharedState — `inheritStateKeys` works
7. Multi-step branch — steps run sequentially within branch
8. Branch step with `retry` and `onError` — retry/fail-branch works within conditional
9. Dispatch not available — appropriate error message
10. Metadata includes `branchSelected` name and state snapshot

---

## 4. Array Iteration Mode for LoopAgent

### Problem
LoopAgent only loops a single agent with a condition function. There's no way to map over an array of items with configurable concurrency, which Dify supports with its Iteration node.

### Solution
Add an `items` mode to LoopAgent alongside the existing `condition` mode.

### Type Changes (`src/agent/orchestration.ts`)

```typescript
export interface LoopAgentConfig {
  // Existing fields
  agentId: string;
  condition?: LoopCondition;
  maxIterations?: number;

  // New: array iteration mode
  items?: {
    key: string;                    // SharedState key containing the array
    concurrency?: number;           // default: 1 (sequential), max: 10
    collectKey?: string;            // SharedState key to write results array (default: 'results')
    itemKey?: string;               // SharedState key for current item (default: 'item')
    indexKey?: string;              // SharedState key for current index (default: 'index')
  };
}
```

### LoopAgent Changes

Add array iteration path in `onMessage()`:

```typescript
async onMessage(message: string, ctx: AgentContext): Promise<AgentResponse> {
  const state = ctx.sharedState ?? new SharedState();

  if (this.config.items) {
    return this.iterateArray(message, ctx, state);
  }
  // Existing condition-based loop logic...
}

private async iterateArray(message: string, ctx: AgentContext, state: SharedState): Promise<AgentResponse> {
  const { key, concurrency = 1, collectKey = 'results', itemKey = 'item', indexKey = 'index' } = this.config.items!;

  const items = JSON.parse(state.get(key) ?? '[]');
  if (!Array.isArray(items)) throw new Error(`SharedState key '${key}' is not an array`);

  const results: string[] = [];

  if (concurrency <= 1) {
    // Sequential
    for (let i = 0; i < items.length; i++) {
      state.set(`temp:${itemKey}`, JSON.stringify(items[i]));
      state.set(`temp:${indexKey}`, String(i));
      const response = await ctx.dispatch(this.config.agentId, message);
      results.push(response.content);
    }
  } else {
    // Parallel with concurrency limit
    const batches = chunk(items, concurrency);
    for (const batch of batches) {
      const promises = batch.map(async (item, batchIdx) => {
        const globalIdx = batches.indexOf(batch) * concurrency + batchIdx;
        // Each parallel execution gets its own temp state
        state.set(`temp:${itemKey}:${globalIdx}`, JSON.stringify(item));
        state.set(`temp:${indexKey}:${globalIdx}`, String(globalIdx));
        return ctx.dispatch(this.config.agentId, message);
      });
      const batchResults = await Promise.allSettled(promises);
      for (const r of batchResults) {
        results.push(r.status === 'fulfilled' ? r.value.content : `Error: ${r.reason}`);
      }
    }
  }

  state.set(collectKey, JSON.stringify(results));
  return {
    content: `Processed ${items.length} items`,
    metadata: { itemCount: items.length, mode: 'array_iteration' }
  };
}
```

### Backward Compatibility
- If `items` is not set, existing `condition`-based loop behavior is unchanged
- If both `items` and `condition` are set, `items` takes precedence (with a warning log)
- `maxIterations` still applies as a safety cap (defaults to items.length in array mode)

### Files Modified
- `src/agent/orchestration.ts` — add items config, implement iterateArray()
- `src/agent/orchestration.test.ts` — add array iteration tests

### Test Cases
- Sequential iteration over 5 items
- Parallel iteration (concurrency=3) over 10 items
- Empty array produces empty results
- Non-array SharedState value throws error
- Results written to collectKey
- maxIterations cap honored
- Individual item errors don't stop iteration (collected as error strings)

---

## 5. SSRF Protection for Outbound HTTP Tool Calls

### Problem
Tools like `web_fetch`, `net_http_request`, and custom HTTP tools can make outbound requests to arbitrary URLs. There's no centralized SSRF protection — a tool could be tricked into fetching internal network resources (cloud metadata endpoints, localhost services, private IPs).

### Current State (Fragmented)

The codebase already has **partial, fragmented** SSRF protection:

**Two duplicate `isPrivateHost` functions exist:**
- `src/tools/executor.ts` line ~10811 (local function)
- `src/tools/browser-session.ts` line ~311 (exported, imported as `isBrowserPrivateHost`)

Both are nearly identical regex-based checks covering 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.x, ::1, fc/fd/fe80 IPv6.

**Tools WITH SSRF blocking** (3 tools):
- `web_fetch` — uses `isPrivateHost()`
- `browser_open` — uses `isBrowserPrivateHost()`
- `browser_task` — uses `isBrowserPrivateHost()`

**Tools WITHOUT SSRF blocking** (gaps):
- `chrome_job` — only checks `isHostAllowed()` (domain allowlist), no private IP check
- `contacts_discover_browser` — only `isHostAllowed()`, no SSRF
- `forum_post` — only `isHostAllowed()`, no SSRF
- Cloud provider tools (Vercel, Cloudflare, AWS, GCP, Azure, cPanel) — only `isHostAllowed()` against configured base URLs
- MCP tools — delegated to external servers without URL validation

**Missing protections:**
- No cloud metadata endpoint blocking (169.254.169.254, metadata.google.internal)
- No DNS rebinding protection
- No redirect-following validation
- No IPv4-mapped IPv6 detection (::ffff:127.0.0.1)
- No decimal/octal IP obfuscation detection (0x7f000001, 2130706433)

### Solution
Centralized SSRF protection module replacing the duplicated functions, plus a Guardian admission controller for systematic enforcement.

### New File: `src/guardian/ssrf-protection.ts`

```typescript
export interface SsrfConfig {
  enabled: boolean;                      // default: true
  allowPrivateNetworks?: boolean;        // default: false (for home lab use cases)
  blockCloudMetadata?: boolean;          // default: true
  allowlist?: string[];                  // explicit hostnames/IPs always allowed
  resolveBeforeFetch?: boolean;          // default: false (DNS pre-resolution)
}

export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;      // 'private_ip' | 'loopback' | 'cloud_metadata' | 'link_local' | 'ipv4_mapped'
  resolvedIp?: string;
}

/** Comprehensive private address check (replaces both isPrivateHost copies). */
export function isPrivateAddress(hostname: string): boolean;

/** Full URL validation including metadata, obfuscation, and optional DNS resolution. */
export async function validateUrlForSsrf(url: string | URL, config: SsrfConfig): Promise<SsrfCheckResult>;

/** Guardian admission controller for HTTP tools. */
export class SsrfController implements AdmissionController {
  readonly name = 'SsrfController';
  readonly phase = 'validating';
  // ...
}
```

IP ranges to block:
- Loopback: 127.0.0.0/8, ::1, localhost, *.localhost
- RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- Link-local: 169.254.0.0/16, fe80::/10
- Cloud metadata: 169.254.169.254, fd00:ec2::254, metadata.google.internal
- Unique local IPv6: fc00::/7
- Current-network: 0.0.0.0/8
- IPv4-mapped IPv6: ::ffff:0:0/96 mapped to private ranges
- Decimal/octal/hex obfuscation: parse before checking

### Integration: Dual Enforcement

1. **Guardian admission pipeline** — `SsrfController` added after `DeniedPathController`, checks all tools with HTTP parameters before execution
2. **Tool-level consolidation** — replace inline `isPrivateHost()` calls in executor.ts and browser-session.ts with the centralized `isPrivateAddress()` import

### Redirect Validation

For `web_fetch` and tools using `fetch()` with `redirect: 'follow'`:
- Switch to `redirect: 'manual'`
- Follow redirects manually (up to 10 hops)
- Validate each redirect location against `isPrivateAddress()` before following

### Config (`src/config/types.ts`)

Add to `GuardianConfig`:
```typescript
ssrf?: SsrfConfig;
```
Default: `{ enabled: true, allowPrivateNetworks: false, blockCloudMetadata: true, resolveBeforeFetch: false }`

For home lab / local network use cases: `allowPrivateNetworks: true`.

### Files Created
- `src/guardian/ssrf-protection.ts` — centralized SSRF validation + SsrfController
- `src/guardian/ssrf-protection.test.ts` — test cases

### Files Modified
- `src/guardian/index.ts` — export SsrfController
- `src/guardian/guardian.ts` — add SsrfController to admission pipeline
- `src/config/types.ts` — add SsrfConfig to GuardianConfig
- `src/tools/executor.ts` — remove local `isPrivateHost` (line ~10811), import centralized version, add checks to `chrome_job`, `contacts_discover_browser`, `forum_post`
- `src/tools/browser-session.ts` — remove exported `isPrivateHost` (line ~311), import centralized version

### Test Cases (12 tests)
1. Block 10.x.x.x, 172.16.x.x, 192.168.x.x private IPs
2. Block 127.0.0.1 / localhost / *.localhost
3. Block 169.254.169.254 (cloud metadata)
4. Block metadata.google.internal hostname
5. Block IPv6 loopback (::1) and link-local (fe80::)
6. Block IPv4-mapped IPv6 (::ffff:10.0.0.1)
7. Block decimal IP obfuscation (2130706433 = 127.0.0.1)
8. Allow public IPs (8.8.8.8, 1.1.1.1)
9. DNS resolution: hostname resolving to private IP is blocked
10. Allowlist override: allowlisted private URL is permitted
11. `allowPrivateNetworks: true` permits all private ranges
12. Disabled config skips all checks

---

## 6. Model Provider Plugin Interface

### Problem
LLM providers (Ollama, Anthropic, OpenAI) are hardcoded in `src/llm/`. The `LLMConfig.provider` field is a string literal union `'ollama' | 'anthropic' | 'openai'`, and `createProvider()` in `src/llm/provider.ts` is a switch statement mapping names to concrete classes. Adding a new provider (Groq, Mistral, Gemini, local llama.cpp, etc.) requires modifying core code.

### Current State

- **`LLMProvider` interface** (`src/llm/types.ts` line ~100): Clean contract with `chat()`, `stream()`, `listModels()`, plus `name` property. Already a good plugin contract.
- **`createProvider()` factory** (`src/llm/provider.ts` line ~15): Switch statement — `'ollama'` → `OllamaProvider`, `'anthropic'` → `AnthropicProvider`, `'openai'` → `OpenAIProvider`
- **Bootstrap** (`src/index.ts` line ~5097): Calls `createProviders()` which iterates config map and calls `createProvider()` per entry
- **Wrapping layers**: `GuardedLLMProvider`, `FailoverProvider`, `ModelFallbackChain` all wrap `LLMProvider` transparently — work with plugins unmodified
- **No dynamic loading pattern** exists in the codebase currently

### Solution
A provider registry with a standardized plugin interface. Built-in providers stay in `src/llm/`, external providers loaded via dynamic `import()` of ES modules.

### Plugin Interface (`src/llm/plugin.ts`)

```typescript
export interface LLMProviderPlugin {
  /** Plugin name (used as provider type in config). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Plugin version. */
  version: string;
  /** Create a provider instance from configuration. */
  createProvider(config: LLMPluginConfig): LLMProvider;
  /** Optional: create an EmbeddingProvider. */
  createEmbeddingProvider?(config: LLMPluginConfig): EmbeddingProvider;
  /** Validate config before creating provider. */
  validateConfig?(config: LLMPluginConfig): { valid: boolean; errors?: string[] };
  /** List available models (for UI discovery). */
  listModels?(config: LLMPluginConfig): Promise<Array<{ id: string; name: string }>>;
}

export interface LLMPluginConfig extends Omit<LLMConfig, 'provider'> {
  provider: string;                           // any string, not restricted to built-in union
  pluginOptions?: Record<string, unknown>;    // plugin-specific settings
}
```

### Provider Registry (`src/llm/provider-registry.ts`)

```typescript
export class ProviderRegistry {
  private builtins = new Map<string, (config: LLMConfig) => LLMProvider>();
  private plugins = new Map<string, LLMProviderPlugin>();

  registerBuiltin(name: string, factory: (config: LLMConfig) => LLMProvider): void;
  registerPlugin(plugin: LLMProviderPlugin): void;
  async loadPlugin(source: string): Promise<LLMProviderPlugin>;
  createProvider(config: LLMConfig | LLMPluginConfig): LLMProvider;
  listProviderTypes(): Array<{ name: string; displayName: string; source: 'builtin' | 'plugin' }>;
  hasProvider(name: string): boolean;
}
```

Initialize with built-in providers:
```typescript
registry.registerBuiltin('ollama', (config) => new OllamaProvider(config));
registry.registerBuiltin('anthropic', (config) => new AnthropicProvider(config));
registry.registerBuiltin('openai', (config) => new OpenAIProvider(config));
```

### Plugin Discovery & Loading

Discovery paths (checked in order):
1. `~/.guardianagent/plugins/` — user plugins directory
2. Config-specified paths via `llm.plugins` config key
3. npm packages (e.g., `guardianagent-provider-groq`)

Loading via dynamic `import()`:
```typescript
async loadPlugin(source: string): Promise<LLMProviderPlugin> {
  const mod = await import(source);
  const plugin = mod.default as LLMProviderPlugin;
  if (!plugin.name || !plugin.createProvider) {
    throw new Error(`Invalid plugin at ${source}: missing name or createProvider`);
  }
  this.plugins.set(plugin.name, plugin);
  return plugin;
}
```

Validation: required fields, name collision detection, optional `validateConfig()` called before use.

### Config Changes (`src/config/types.ts`)

```typescript
export interface LLMConfig {
  provider: string;  // widened from 'ollama' | 'anthropic' | 'openai' to string
  // ... rest unchanged
  pluginOptions?: Record<string, unknown>;
}

// Top-level config
export interface GuardianAgentConfig {
  // ... existing
  plugins?: {
    pluginDirs?: string[];   // directories to scan
    modules?: string[];      // explicit paths or npm packages
  };
}
```

Widening `provider` from a union to `string` is a non-breaking change — existing literal values still satisfy `string`.

### Bootstrap Changes (`src/index.ts`)

Replace the hardcoded `createProviders()` call (~line 5097):
```typescript
const providerRegistry = new ProviderRegistry();
// Built-ins registered automatically in constructor

// Load configured plugins
for (const source of config.plugins?.modules ?? []) {
  try {
    const plugin = await providerRegistry.loadPlugin(source);
    log.info({ pluginId: plugin.name }, 'Loaded provider plugin');
  } catch (err) {
    log.warn({ source, err }, 'Failed to load provider plugin');
  }
}

// Create providers through registry (replaces switch statement)
const providers = new Map<string, LLMProvider>();
for (const [name, providerConfig] of Object.entries(config.llm.providers ?? {})) {
  providers.set(name, providerRegistry.createProvider(providerConfig));
}
```

### Existing Factory Refactoring (`src/llm/provider.ts`)

The `createProvider()` function becomes a thin wrapper:
```typescript
export function createProvider(config: LLMConfig): LLMProvider {
  return providerRegistry.createProvider(config);
}
```

### Example External Plugin

```typescript
// guardianagent-provider-groq/index.ts
import type { LLMProviderPlugin } from '@guardianagent/types';

const plugin: LLMProviderPlugin = {
  name: 'groq',
  displayName: 'Groq Cloud',
  version: '1.0.0',
  createProvider(config) {
    // Groq uses OpenAI-compatible API — extend OpenAI provider
    return new GroqProvider(config);
  },
  validateConfig(config) {
    if (!config.apiKey) return { valid: false, errors: ['apiKey required'] };
    return { valid: true };
  },
};
export default plugin;
```

### Files Created
- `src/llm/plugin.ts` — LLMProviderPlugin interface
- `src/llm/provider-registry.ts` — ProviderRegistry class
- `src/llm/provider-registry.test.ts` — tests
- `examples/example-provider-plugin.ts` — reference plugin implementation

### Files Modified
- `src/llm/types.ts` — add EmbeddingProvider interface
- `src/llm/provider.ts` — refactor factory to use registry
- `src/llm/index.ts` — export new types and registry
- `src/config/types.ts` — widen `provider` field, add `plugins` config
- `src/index.ts` — replace hardcoded provider creation with registry-based creation
- `web/public/js/pages/config.js` — show plugin providers in Providers tab

### Test Cases (8 tests)
1. Built-in registration and creation (ollama, anthropic, openai)
2. Plugin registration and creation
3. Name collision detection (plugin can't override built-in)
4. Config validation delegation to plugin
5. Unknown provider type → clear error
6. Plugin loading from filesystem (mock dynamic import)
7. Invalid plugin shape rejected (missing name or createProvider)
8. `listProviderTypes()` returns both built-in and plugin providers

### Backward Compatibility
- Existing `config.llm.providers` format unchanged
- Built-in providers work exactly as before
- Plugin system is additive; no existing behavior changes
- `GuardedLLMProvider`, `FailoverProvider`, `ModelFallbackChain` all work transparently

---

## Implementation Order

Recommended sequence considering dependencies:

```
Phase A: Orchestration (items 2, 3, 4) — ~2-3 days
  ├─ A.0: Extract shared utilities (runStepsSequentially, executeWithRetry, etc.)
  ├─ A.1: Per-step retry (StepRetryPolicy + executeWithRetry)
  ├─ A.2: Fail-branch (StepFailBranch + onError wiring)
  ├─ A.3: ConditionalAgent (new class, uses runStepsSequentially)
  └─ A.4: LoopAgent array iteration (new runArrayIteration method)

Phase B: Security (item 5) — ~1 day
  └─ B.1: SSRF protection (centralize + extend + admission controller)

Phase C: Provider plugins (item 6) — ~2-3 days
  ├─ C.1: LLMProviderPlugin interface + ProviderRegistry
  ├─ C.2: Wrap built-ins, refactor factory
  └─ C.3: Bootstrap wiring + plugin loading

Phase D: Search replacement (item 1) — ~7-9 days, 8 sub-phases
  ├─ D.1: Types, SQLite schema, document parser, chunker
  ├─ D.2: FTS5 keyword search + search service skeleton
  ├─ D.3: Embedding infrastructure (uses ProviderRegistry from Phase C)
  ├─ D.4: Vector search (sqlite-vec)
  ├─ D.5: Hybrid search + re-ranking
  ├─ D.6: Integration (tools, bootstrap, web, config)
  ├─ D.7: Web UI + documentation
  └─ D.8: Cleanup (remove QMD)
```

**Dependencies:**
- A.0 must complete before A.1-A.4 (shared utilities)
- A.1 before A.2 (retry before fail-branch)
- A.3 depends on A.0 (uses runStepsSequentially)
- B is fully independent
- C is fully independent of A and B
- D.3 benefits from C (EmbeddingProvider from ProviderRegistry) but can be done standalone
- D.1-D.2 can start in parallel with any other phase

**Recommended parallel execution:**
- Phase A + Phase B concurrently (orchestration + SSRF)
- Phase C after or concurrent with A/B
- Phase D after C.1 (needs EmbeddingProvider interface)

### Total Estimated Effort

| Phase | Days | Test Count |
|-------|------|------------|
| A: Orchestration improvements | 2-3 | ~37 tests |
| B: SSRF protection | 1 | ~12 tests |
| C: Provider plugins | 2-3 | ~8 tests |
| D: Search replacement | 7-9 | ~30 tests |
| **Total** | **12-16** | **~87 tests** |

---

## Testing Strategy

All changes follow existing conventions:
- Co-located test files (`*.test.ts` alongside `*.ts`)
- Vitest with forks pool, 30s timeout
- `vi.useFakeTimers()` for time-dependent tests (retry backoff)
- Mock `ctx.dispatch()` for orchestration tests
- Mock HTTP/SDK for embedding provider tests
- Tmpdir + cleanup for SQLite tests
- Coverage thresholds: 70% lines/functions/statements, 55% branches

### Integration/Composition Tests
- SequentialAgent with ConditionalAgent as a step — pipeline branches mid-sequence
- ConditionalAgent inside a ParallelAgent — conditional evaluation per parallel branch
- SequentialAgent producing array, followed by LoopAgent in array mode consuming it
- LoopAgent (array mode) nested inside SequentialAgent with retry on the LoopAgent step
