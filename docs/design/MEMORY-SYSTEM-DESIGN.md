# Memory System Design

**Status:** Implemented current architecture
**Purpose:** Current as-built reference for Guardian's memory scopes, storage model, search/history interaction, and operator-facing memory surfacing.

The system has two durable long-term memory scopes plus searchable conversation history:

- global Guardian memory outside attached coding sessions
- Code-session memory for Guardian while it is attached to a coding session
- SQLite-backed conversation history with FTS5 search
- runtime-authored automation result references for saved automation runs that opt into historical analysis

This design document covers the current architecture, configuration, and usage model.

For tier-routed chat, the built-in `local` and `external` agents still share one logical Guardian memory/session identity. Switching between `auto`, `local-only`, and `external-only` changes the execution backend, not Guardian's conversation history or global memory.

## Memory Surfacing Model

Guardian now treats durable memory as something that should be **surfaced centrally**, not hidden behind raw files or narrow tool output.

The current direction is:

- all durable memory should be surfaced through a unified Memory/Wiki experience
- this includes global memory, Code-session memory, operator-authored durable entries, system-extracted/flush material, and linked durable output references
- surfaced does **not** mean uniformly editable
- canonical sidecar/index-backed memory remains the source of truth
- editable operator curation must still happen through guarded product/control-plane paths, not direct filesystem edits under `.guardianagent/`
- quarantined, rejected, or otherwise inactive memory can be surfaced for review, but it must remain out of ordinary prompt context unless explicitly inspected through the appropriate path

In other words: Guardian is moving toward a **unified memory surface** while preserving the existing trust, scope, and approval boundaries.

The web UI `#/memory` page is the first operator-facing step in that direction. It surfaces global and Code-session durable memory in one place, while still distinguishing canonical entries, derived material, and review-only inactive records.

## Memory Scopes

### Global agent memory

Global agent memory is Guardian's long-term knowledge base outside attached coding sessions.

- keyed by assistant/agent identity
- persisted as a readable markdown view plus a canonical signed sidecar index
- remains Guardian's primary persistent memory scope, including during attached coding sessions
- loaded into Guardian prompt context outside Code, and also loaded first for Code-session turns
- written by `memory_save` by default unless the caller explicitly targets Code-session memory
- surfaced in the Memory/Wiki experience as the primary durable scope for the current logical assistant identity
- receives automatic memory flush only from non-Code Guardian chat

### Code-session memory

Code-session memory is a separate long-term store for Guardian while it is operating inside an attached coding session.

- keyed by `codeSessionId`
- isolated from global memory by default
- loaded only for turns running inside that Code session, as a bounded session-local augment to global memory rather than a replacement for it
- written by `memory_save` only when the caller explicitly targets `scope=code_session`, or by automatic memory flush from that Code session's transcript
- surfaced in the Memory/Wiki experience as separate durable session scopes rather than merged into global memory
- not automatically preloaded into main chat, CLI, or Telegram unless they explicitly attach to that same backend Code session

### Conversation history

Conversation history is separate from long-term memory.

- stored in SQLite
- searched by `memory_search`
- trimmed to fit prompt context
- incrementally flushed into the matching long-term memory scope when new messages fall out of prompt context
- flush records preserve objective/focus/blocker context in a structured summary rather than duplicating raw transcript prefixes on every prompt build
- conversation history itself is not the canonical Memory/Wiki durable store, but it can produce durable memory artifacts through flush and related maintenance flows

### Automation output references

Saved automations can also write a historical analysis record when their output persistence mode is `run_history_plus_memory`.

- applies only to saved automation runs
- does not include ad hoc one-off tool calls
- writes a compact memory reference entry plus a private full-output record
- lets the assistant find a prior automation run quickly through memory and then dereference the full stored output later
- keeps raw large payloads out of normal prompt memory
- is intended to surface in the Memory/Wiki experience as a linked durable artifact rather than a raw prompt dump

### Explicit cross-memory bridge

Cross-scope lookup is explicit and read-only.

- `memory_bridge_search` can search global memory from Code
- `memory_bridge_search` can search a Code-session memory from outside that session when the caller can reach that session
- bridge results are reference material only; they do not change the current scope, identity, or objective
- surfacing multiple scopes in one UI does not relax these runtime isolation rules

## Architecture

The memory system has six layers:

```text
Layer 1: Persistent Memory Stores (AgentMemoryStore)
  Global agent memory:
    ~/.guardianagent/memory/{agentId}.md + .index.json by default
  Code-session memory:
    ~/.guardianagent/code-session-memory/{codeSessionId}.md + .index.json by default
    or <knowledgeBase.basePath>/code-sessions/ when basePath is configured
  Managed memory files are written with restrictive filesystem permissions on supported hosts
  The `.index.json` file is the canonical state and is HMAC-verified through the control-plane integrity manifest
  The `.md` file is a derived readable view rebuilt from the index
  Only active/reviewed content from a verified index is loaded into prompt context
  Durable writes now pass through a shared mutation path instead of blind append-only writes
  Exact duplicate writes are suppressed, operator-curated wiki pages upsert by stable page key/slug, and profile-like memories can refresh an existing matching record
  Prompt-time packing is entry-aware and query-biased rather than blindly taking the newest entries
  Current request, continuity summary, blocker state, and Code-session focus/plan now feed a structured signal-aware query, not just one flat text string
  Prompt-time ranking can now match on text, focus phrases, tags, category hints, and identifiers such as continuity or execution refs
  The runtime now records bounded selection diagnostics with compact match reasons so traces can show which memory entries won context selection and why
  Written via memory_save or automatic memory flush with trust/provenance metadata

Layer 2: FTS5 Search Index (ConversationService)
  SQLite FTS5 virtual table with BM25 ranking
  Synced via triggers on INSERT/DELETE
  Queried via memory_search

Layer 3: Conversation History (ConversationService)
  SQLite-backed session storage with sliding window context
  Automatic trimming to maxContextChars
  Session rotation, listing, and restore
  Bounded response-source metadata is retained with assistant turns
  Code-session prompt compaction can persist a session-local compacted summary plus trace-safe diagnostics without widening memory scope

Layer 4: Memory Flush (automatic)
  Detects when messages are dropped from the context window
  Persists incremental structured context-flush entries into the matching long-term memory scope
  Normal chat flushes to global memory
  Code-session chat flushes to that code session's memory
  Flush summaries preserve current objective/focus/blocker state when available
  Flush writes are duplicate-aware and also trigger bounded hygiene that can archive stale or redundant system-managed artifacts

Layer 5: Cross-Memory Bridge
  Explicit read-only bridge search across global/code-session boundaries
  Returns reference-only results
  Never preloads the foreign scope into prompt context

Layer 6: Automation Output Store + Reference Memory
  Saved automation runs can persist full per-run output into ~/.guardianagent/automation-output
  A compact runtime-authored memory reference points to that stored output
  Full output is retrieved through automation_output_search / automation_output_read, not filesystem tools
  Only saved automation runs participate; ad hoc tool executions do not
```

### Data Flow

```text
Normal chat turn
  User message
    -> global memory excerpt loaded into system prompt with entry-aware, signal-aware packing
    -> recent conversation history trimmed to maxContextChars
    -> LLM receives: prompt + global memory + recent history + user message
    -> newly dropped history (if any) flushed into global memory as a structured context-flush record

Code-session turn
  User message
    -> dedicated Code-session prompt
    -> workspace profile + indexed repo map + current working set injected as repo-local evidence
    -> global memory excerpt loaded first as Guardian's primary durable memory
    -> bounded Code-session memory excerpt loaded for that codeSessionId as session-local augment context
    -> recent Code-session conversation history trimmed to maxContextChars
    -> if the prompt is compacted for budget, Guardian keeps a bounded session-local compacted summary and exposes compaction diagnostics in the run timeline
    -> LLM receives: code prompt + repo evidence + global memory + bounded Code-session memory + recent history + user message
    -> newly dropped history (if any) flushed into Code-session memory as a structured context-flush record
    -> optional memory_bridge_search may return reference-only results from the other scope

Automation run with historical analysis enabled
  Automation finishes
    -> full run output stored in the private automation output store
    -> compact memory reference appended to the target agent's memory scope
    -> later user request can find the run via memory_search / automation_output_search
    -> assistant can dereference the stored output with automation_output_read for deeper analysis
```

## Configuration

All settings live under `assistant.memory` in `~/.guardianagent/config.yaml`:

```yaml
assistant:
  memory:
    enabled: true
    maxTurns: 12
    maxMessageChars: 4000
    maxContextChars: 12000
    retentionDays: 30

    knowledgeBase:
      enabled: true
      basePath: ~/.guardianagent/memory
      readOnly: false
      maxContextChars: 4000
      maxFileChars: 20000
      maxEntryChars: 2000
      maxEntriesPerScope: 500
      maxEmbeddingCacheBytes: 50000000
      autoFlush: true
  maintenance:
    enabled: true
    sweepIntervalMs: 300000
    idleAfterMs: 600000
    jobs:
      memoryHygiene:
        enabled: true
        includeGlobalScope: true
        includeCodeSessions: true
        maxScopesPerSweep: 4
        minIntervalMs: 21600000
      learningReview:
        enabled: true
        includeGlobalScope: true
        includeCodeSessions: true
        maxCandidatesPerSweep: 5
        minIntervalMs: 21600000
        minContextFlushEntries: 3
        maxEvidenceEntries: 5
        candidateExpiresAfterDays: 30
      capabilityCandidateHygiene:
        enabled: true
        minIntervalMs: 21600000
        expireAfterDays: 30
        maxCandidatesPerSweep: 50
```

Notes:

- `assistant.memory.knowledgeBase` config governs both persistent memory stores.
- `assistant.maintenance` governs runtime-owned idle hygiene, not prompt-authored assistant behavior.
- `assistant.maintenance.jobs.learningReview` performs deterministic signal review and writes quarantined capability candidates for operator review; it does not call an LLM or promote skills/tools by itself.
- `assistant.maintenance.jobs.capabilityCandidateHygiene` expires stale candidate proposals from the review queue.
- Global memory defaults to `~/.guardianagent/memory`.
- Code-session memory defaults to `~/.guardianagent/code-session-memory`.
- If `knowledgeBase.basePath` is set, Code-session memory is stored under `<basePath>/code-sessions`.
- If `knowledgeBase.readOnly` is `true`, normal durable writes are frozen for both global and Code-session memory.
- Idle maintenance never rewrites operator-curated wiki pages; it only runs bounded system-owned hygiene against durable memory scopes that are writable.
- Code sessions do not preload global memory by default.

Tier-routing note:

- the built-in dual-agent `local` / `external` assistant shares one conversation/session state key and one global memory scope
- explicitly distinct user-defined agents still keep separate global memory unless you intentionally design them otherwise

## Memory Tools

Four tools are registered in the `memory` category.

### memory_search

Search conversation history, persistent memory, or both.

```text
Tool: memory_search
Risk: read_only
Category: memory
Parameters:
  query (required): Search query — words, phrases, FTS5 syntax
  scope (optional): "conversation", "persistent", or "both" (default)
  persistentScope (optional): "global", "code_session", or "both"
  sessionId (optional): Required when `persistentScope` includes `code_session` outside an attached coding session
  limit (optional): Max results (default 10, max 50)
```

Important behavior:

- `scope: "conversation"` searches conversation history only
- `scope: "persistent"` searches persistent memory only
- `scope: "both"` merges both sources into one ranked list
- outside Code, persistent search targets global memory unless `persistentScope` requests Code-session memory
- inside Code, persistent search defaults to both global memory and the attached Code-session memory unless `persistentScope` narrows it
- conversation results use FTS5 BM25 ordering when available, with substring fallback otherwise
- persistent results use deterministic field-aware ranking across content, summary, category, and tags
- merged results are fused source-by-source rather than comparing raw BM25 and substring scores directly

`memory_search` results are treated as untrusted tool output when they are fed back into the model. Before reinjection, Guardian strips invisible Unicode, checks for prompt-injection signals, and redacts detected secrets and configured PII entities.

### memory_recall

 Retrieve persistent long-term memory, with global memory as the default scope.

```text
Tool: memory_recall
Risk: read_only
Category: memory
Parameters:
  agentId (optional): Agent ID to retrieve global memory for outside Code
  scope (optional): "global", "code_session", or "both" (default: global)
  sessionId (optional): Required when `scope` includes `code_session` outside an attached coding session
```

Scope rules:

- default behavior: reads the current agent's global memory
- inside Code, `scope: "code_session"` reads the attached Code-session memory
- inside Code, `scope: "both"` returns both the global memory view and the attached Code-session memory view
- when an index file fails integrity verification, the scope is treated as empty instead of falling back to the markdown cache
- output includes per-entry metadata, including stored `summary` when available, alongside rendered markdown content

### memory_save

Save a fact, preference, decision, or summary to persistent long-term memory.

```text
Tool: memory_save
Risk: mutating
Category: memory
Parameters:
  content (required): The fact, preference, or summary to remember
  summary (optional): Short gist used for prompt-time memory packing
  category (optional): Heading for organization (for example "Preferences", "Decisions", "Facts", "Project Notes")
  scope (optional): "global" or "code_session" (default: global)
  sessionId (optional): Required when `scope=code_session` outside an attached coding session
```

Scope rules:

- default behavior: writes to global agent memory, including inside Code
- `scope: "code_session"` writes to the attached Code session's long-term memory
- if `knowledgeBase.readOnly` is enabled, `memory_save` fails before approval/execution instead of creating a pending write
- trusted direct `memory_save` requests auto-run without approval; assistant-origin writes still require explicit remember intent
- long entries get a deterministic derived summary when no summary is supplied
- writes are search-first and duplicate-aware: exact active duplicates are skipped, matching curated/profile records may be updated instead of duplicated, and bounded hygiene can archive stale system-managed artifacts after writes

Example usage by the agent:

- User says "remember that I prefer dark mode" -> `memory_save({ content: "User prefers dark mode", category: "Preferences" })`
- User says "remember that this repo uses PostgreSQL" inside Code -> `memory_save({ content: "This repo uses PostgreSQL", category: "Project Notes", scope: "code_session" })`

### memory_bridge_search

Search the other persistent memory scope without changing the current context.

```text
Tool: memory_bridge_search
Risk: read_only
Category: memory
Parameters:
  targetScope (required): "global" or "code_session"
  query (required): Text to search for
  sessionId (optional): Required when searching a specific Code-session memory from outside that session
  limit (optional): Max results (default 10, max 20)
```

Bridge rules:

- returns `referenceOnly: true`
- never changes the current scope or objective
- does not preload foreign memory into future prompts
- if the model wants to carry a bridged fact into the current scope, it must do so explicitly with `memory_save`

## Historical Automation Output Analysis

Historical deep analysis of prior run output is available for saved automations only.

- it is enabled by the automation output persistence mode `run_history_plus_memory`
- it writes a safe memory reference, not the raw full output
- the full output is kept in Guardian's private automation output store
- ad hoc one-off tool calls are not written into this store

Two read-only automation tools provide the dereference path:

### automation_output_search

Search stored output from saved automation runs.

```text
Tool: automation_output_search
Risk: read_only
Category: automation
Parameters:
  query (optional): text query across stored previews and step output
  automationId (optional): filter to one automation
  runId (optional): filter to one run
  status (optional): filter by run status
  limit (optional): max results (default 10, max 50)
```

### automation_output_read

Read the stored full output for a saved automation run or one step inside that run.

```text
Tool: automation_output_read
Risk: read_only
Category: automation
Parameters:
  runId (required): saved automation run id
  stepId (optional): read one step instead of the combined run view
  offset (optional): chunk offset for large output
  maxChars (optional): chunk size limit
```

Important rules:

- these tools are only for saved automation runs
- they do not expose raw `.guardianagent/` filesystem access
- returned data is treated as retrieved/untrusted tool output before reinjection to the model
- operators can disable this persistence per automation by switching output handling back to run-history-only

### Trust and quarantine semantics

- trusted/user-local memory writes can become `active`
- low-trust or tainted remote-derived writes default to `quarantined`
- quarantined entries are persisted in sidecar metadata but excluded from normal prompt context
- assistant-origin memory mutations are denied unless the user explicitly asked to remember something
- trusted direct/operator memory writes can proceed without a separate approval prompt
- verification distinguishes active writes from quarantined/unreviewed writes
- inactive/quarantined material is only surfaced through explicit search paths
- `knowledgeBase.readOnly` freezes normal Guardian/runtime durable writes in both global and Code-session memory, including `memory_save` and automatic flush writes
- suspicious memory content is stripped from prompt/context loads even when the stored entry is otherwise active

## Persistent Memory File Format

Each global agent memory file and each Code-session memory file has:

- a canonical `*.index.json` sidecar containing trust/status/provenance metadata
- a derived markdown view organized by category for auditability

The markdown view looks like:

```markdown
## Preferences
- User prefers dark mode _(2025-01-15)_
- Use TypeScript for all new code _(2025-01-17)_

## Facts
- User name is Alex _(2025-01-16)_
- Primary workspace is /home/alex/projects _(2025-01-18)_

## Context from 2025-01-20
- [user] What's the deployment process?
- [assistant] The deployment uses GitHub Actions with staging -> production flow...
```

The `## Context from YYYY-MM-DD` sections are auto-generated by memory flush.

Structured trust metadata is stored alongside the markdown in a sidecar index. Quarantined, expired, or rejected entries stay out of the markdown view so poisoned remote content cannot silently re-enter planner context as durable memory.

Keying rules:

- global memory files are keyed by agent id
- Code-session memory files are keyed by `codeSessionId`
- for the built-in tier-routed assistant, the `local` and `external` execution agents share the same logical global memory so mode switches do not fork remembered context

## FTS5 Full-Text Search

The conversation database includes an FTS5 virtual table (`conversation_messages_fts`) that provides:

- **BM25 ranking**: results scored by relevance, not just recency
- **Porter stemming**: "running" matches "run", "runs", etc.
- **Unicode support**: handles international characters correctly
- **Content-sync**: no data duplication; the FTS index references `conversation_messages` by rowid
- **Auto-sync triggers**: INSERT/DELETE on `conversation_messages` automatically updates the FTS index
- **Schema upgrade**: existing databases get FTS rebuilt on first access

### Graceful degradation

If FTS5 is not compiled into the SQLite build, the system falls back to:

- in-memory case-insensitive substring matching
- SQLite without FTS5: substring search via `LIKE` (not currently implemented, returns empty)

Check availability: `conversationService.hasFTS` returns `true` when FTS5 is active.

## Memory Flush

When `buildMessages()` trims conversation history to fit `maxContextChars`, messages that do not fit are flushed to the matching long-term memory scope:

1. The sliding window walks backwards from the most recent message.
2. When the character budget is exhausted, earlier messages are identified as dropped.
3. If substantive content is being dropped, the `onMemoryFlush` callback fires.
4. The callback builds a bounded structured memory entry from only the newly dropped content.
5. The structured entry preserves available focus, blocker, and Code-session state, then writes to either global memory or Code-session memory depending on the conversation scope.

### Flush behavior

- non-Code Guardian chat flushes to global agent memory
- Code-session chat flushes to that session's long-term memory
- only fires when substantive content is being dropped
- flush writes are incremental; already-flushed dropped prefixes are not re-written on every prompt build
- flush writes carry `sourceType: system`, a short derived summary, and the `context_flush` tag
- prompt packing de-prioritizes `context_flush` records behind explicit durable memories unless the active request matches them well
- flush failures are silently caught and never break message building
- controlled by `knowledgeBase.autoFlush` config (default: `true`)
- skipped entirely when `knowledgeBase.readOnly` is `true`

## Cross-Scope Behavior

Code and global memory are intentionally separated.

- Code-session turns load Guardian's global memory first as the primary durable memory and then add the attached Code-session memory as a bounded session-local augment
- global chat does not preload Code-session memory
- `memory_bridge_search` is the only built-in cross-scope lookup path
- bridge results are reference material, not a context switch
- broader tool access does not change the active memory scope
- repo-awareness state such as `workspaceProfile`, `workspaceMap`, and `workingSet` is separate from both long-term memory scopes

This keeps Guardian grounded in its attached session and repo without removing access to the wider tool inventory.

## Near-Term Uplift Direction

The next memory wave is about lower prompt weight, better retrieval timing, and stronger background hygiene without weakening the existing trust and scope boundaries.

### 1. Maintained session summary artifacts

The current Code-session `compactedSummary` should evolve from a pressure-triggered by-product into a maintained bounded summary artifact.

Target behavior:
- refresh incrementally instead of rebuilding from raw history every time
- preserve current objective, blockers, and active execution refs
- become the first source used when the runtime needs to compact older history

### 2. Metadata-first candidate selection

Prompt-time retrieval should bias toward cheap metadata and summary inspection before loading full entry content.

Target behavior:
- rank candidates from sidecar metadata, summaries, tags, categories, and identifiers first
- load full entry bodies only for the smaller winning subset
- keep trust, provenance, and quarantine semantics unchanged

### 3. Non-blocking prompt-time retrieval

Memory retrieval should be able to help without always becoming a latency tax.

Target behavior:
- start relevant retrieval work opportunistically
- consume those results if they are ready in time
- proceed with bounded fallback context if they are not
- record selection diagnostics either way

### 4. Background extraction and consolidation

Memory hygiene should move toward explicit system-owned maintenance jobs instead of trying to do every expensive operation inline with the user turn.

Current behavior:
- runtime-owned idle maintenance can sweep global memory and idle Code-session memory with explicit budgets and per-scope cooldowns
- the shared hygiene path archives exact duplicates, near-duplicate system-managed collection entries, and stale derived/context-flush material
- runs only when the assistant runtime is quiet enough and the target store is writable
- records jobs and audit events instead of silently mutating durable memory

Target behavior:
- thresholded extraction of durable facts from richer recent context
- coalescing of overlapping short-term summaries
- broader periodic consolidation of stale or redundant entries
- locking and idempotency so maintenance work does not race transcript writes

### 5. Compaction invariant preservation

Conversation compaction must preserve protocol-critical structure before feeding any summaries back into memory.

Target behavior:
- keep assistant tool-call and tool-result relationships intact
- preserve user corrections, blockers, and active execution references
- treat aggressive trim as a correctness boundary, not just a token-saving helper

### 6. Shared orchestration boundary

Background memory work should live under the same job/orchestration visibility model as other system-owned runtime work.

Target behavior:
- no hidden new authority
- bounded budgets and timeouts
- audit visibility
- skip-safe behavior when retrieval or consolidation cannot complete

## Future Enhancement Opportunities

1. **Selective sync policies**: promote approved facts between Code-session and global memory without automatic context sharing.
2. **Temporal decay**: add timestamp-based scoring to memory retrieval.
3. **Daily logs**: add automatic daily logs alongside curated markdown memory.
4. **Richer operator review surfaces**: add first-class review/promote/quarantine inspection for remote-derived or system-extracted memories.

## Factory Reset

`/factory-reset data` (or `all`) deletes the conversation SQLite databases and the configured global memory directory.

Operator note:

- if `assistant.memory.knowledgeBase.basePath` is configured, Code-session memory lives under `<basePath>/code-sessions`
- with the default split paths, Code-session memory is stored under `~/.guardianagent/code-session-memory/`
- if you want a full manual reset of both global and Code-session long-term memory, clear both memory directories

## Key Files

| File | Purpose |
|------|---------|
| `src/runtime/conversation.ts` | ConversationService with FTS5 search and memory flush |
| `src/runtime/agent-memory-store.ts` | Persistent markdown + sidecar store used for both global and Code-session memory |
| `src/runtime/automated-maintenance-service.ts` | Idle-aware runtime sweeper for bounded memory hygiene |
| `src/runtime/code-sessions.ts` | Backend Code-session records and session resolution |
| `src/tools/executor.ts` | `memory_search`, `memory_recall`, `memory_save`, `memory_bridge_search` tool registration and scope binding |
| `src/tools/types.ts` | `memory` tool category definitions |
| `src/index.ts` | Service wiring, scoped memory flush routing, prompt-time memory injection, search bootstrap |
| `src/prompts/code-session-core.ts` | Dedicated Code-session prompt assembly |
| `src/runtime/conversation.test.ts` | FTS5 search and memory-flush tests |
| `src/tools/executor.test.ts` | Memory tool scope and bridge-search tests |
