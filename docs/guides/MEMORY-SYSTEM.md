# Memory System Guide

The system has two durable long-term memory scopes plus searchable conversation history:

- global agent memory for the normal assistant
- Code-session memory for the Coding Assistant
- SQLite-backed conversation history with FTS5 search

This guide covers architecture, configuration, and usage.

For tier-routed chat, the built-in `local` and `external` agents still share one logical global memory/session identity. Switching between `auto`, `local-only`, and `external-only` changes the execution backend, not the assistant's conversation history or global memory.

## Memory Scopes

### Global agent memory

Global agent memory is the normal long-term knowledge base for the assistant outside Code sessions.

- keyed by assistant/agent identity
- persisted as markdown plus sidecar metadata
- loaded into normal chat prompt context
- written by `memory_save` outside Code or by automatic memory flush from normal chat

### Code-session memory

Code-session memory is a separate long-term store for the Coding Assistant.

- keyed by `codeSessionId`
- isolated from global memory by default
- loaded only for turns running inside that Code session
- written by `memory_save` inside Code or by automatic memory flush from that Code session's transcript
- not automatically preloaded into main chat, CLI, or Telegram unless they explicitly attach to that same backend Code session

### Conversation history

Conversation history is separate from long-term memory.

- stored in SQLite
- searched by `memory_search`
- trimmed to fit prompt context
- flushed into the matching long-term memory scope when old messages are dropped

### Explicit cross-memory bridge

Cross-scope lookup is explicit and read-only.

- `memory_bridge_search` can search global memory from Code
- `memory_bridge_search` can search a Code-session memory from outside that session when the caller can reach that session
- bridge results are reference material only; they do not change the current scope, identity, or objective

## Architecture

The memory system has five layers:

```text
Layer 1: Persistent Memory Stores (AgentMemoryStore)
  Global agent memory:
    ~/.guardianagent/memory/{agentId}.md + .index.json by default
  Code-session memory:
    ~/.guardianagent/code-session-memory/{codeSessionId}.md + .index.json by default
    or <knowledgeBase.basePath>/code-sessions/ when basePath is configured
  Only active/reviewed content is loaded into prompt context
  Written via memory_save or automatic memory flush with trust/provenance metadata

Layer 2: FTS5 Search Index (ConversationService)
  SQLite FTS5 virtual table with BM25 ranking
  Synced via triggers on INSERT/DELETE
  Queried via memory_search

Layer 3: Conversation History (ConversationService)
  SQLite-backed session storage with sliding window context
  Automatic trimming to maxContextChars
  Session rotation, listing, and restore

Layer 4: Memory Flush (automatic)
  Detects when messages are dropped from the context window
  Persists dated context blocks into the matching long-term memory scope
  Normal chat flushes to global memory
  Code-session chat flushes to that code session's memory

Layer 5: Cross-Memory Bridge
  Explicit read-only bridge search across global/code-session boundaries
  Returns reference-only results
  Never preloads the foreign scope into prompt context
```

### Data Flow

```text
Normal chat turn
  User message
    -> global memory excerpt loaded into system prompt
    -> recent conversation history trimmed to maxContextChars
    -> LLM receives: prompt + global memory + recent history + user message
    -> dropped history (if any) flushed into global memory

Code-session turn
  User message
    -> dedicated Code-session prompt
    -> workspace profile + indexed repo map + current working set injected as repo-local evidence
    -> Code-session memory excerpt loaded for that codeSessionId only
    -> recent Code-session conversation history trimmed to maxContextChars
    -> LLM receives: code prompt + repo evidence + code-session memory + recent history + user message
    -> dropped history (if any) flushed into Code-session memory
    -> optional memory_bridge_search may return reference-only results from the other scope
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
      maxContextChars: 4000
      maxFileChars: 20000
      autoFlush: true
```

Notes:

- `assistant.memory.knowledgeBase` config governs both persistent memory stores.
- Global memory defaults to `~/.guardianagent/memory`.
- Code-session memory defaults to `~/.guardianagent/code-session-memory`.
- If `knowledgeBase.basePath` is set, Code-session memory is stored under `<basePath>/code-sessions`.
- Code sessions do not preload global memory by default.

Tier-routing note:

- the built-in dual-agent `local` / `external` assistant shares one conversation/session state key and one global memory scope
- explicitly distinct user-defined agents still keep separate global memory unless you intentionally design them otherwise

## Memory Tools

Four tools are registered in the `memory` category.

### memory_search

Search conversation history using FTS5 full-text search with BM25 ranking.

```text
Tool: memory_search
Risk: read_only
Category: memory
Parameters:
  query (required): Search query — words, phrases, FTS5 syntax
  limit (optional): Max results (default 10, max 50)
```

Important behavior:

- searches conversation history, not the persistent markdown memory store
- in Code, the active conversation is already Code-session-scoped
- falls back to substring search if FTS5 is unavailable

`memory_search` results are treated as untrusted tool output when they are fed back into the model. Before reinjection, Guardian strips invisible Unicode, checks for prompt-injection signals, and redacts detected secrets and configured PII entities.

### memory_recall

Retrieve persistent long-term memory for the current scope.

```text
Tool: memory_recall
Risk: read_only
Category: memory
Parameters:
  agentId (optional): Agent ID to retrieve global memory for outside Code
```

Scope rules:

- outside Code: reads the current agent's global memory
- inside Code: reads the current Code session's long-term memory

### memory_save

Save a fact, preference, decision, or summary to persistent long-term memory for the current scope.

```text
Tool: memory_save
Risk: mutating
Category: memory
Parameters:
  content (required): The fact, preference, or summary to remember
  category (optional): Heading for organization (for example "Preferences", "Decisions", "Facts", "Project Notes")
```

Scope rules:

- outside Code: writes to global agent memory
- inside Code: writes to the current Code session's long-term memory

Example usage by the agent:

- User says "remember that I prefer dark mode" -> `memory_save({ content: "User prefers dark mode", category: "Preferences" })`
- User says "remember that this repo uses PostgreSQL" inside Code -> writes to that Code session's memory, not to global memory

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

### Trust and quarantine semantics

- trusted/user-local memory writes can become `active`
- low-trust or tainted remote-derived writes default to `quarantined`
- quarantined entries are persisted in sidecar metadata but excluded from normal prompt context
- verification distinguishes active writes from quarantined/unreviewed writes
- inactive/quarantined material is only surfaced through explicit search paths

## Persistent Memory File Format

Each global agent memory file and each Code-session memory file is a markdown view organized by category:

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
4. The callback extracts preview lines.
5. Those lines are appended to either global memory or Code-session memory, depending on the conversation scope.

### Flush behavior

- normal chat flushes to global agent memory
- Code-session chat flushes to that session's long-term memory
- only fires when substantive content is being dropped
- each message preview is capped at 200 characters
- max 10 messages per flush event
- flush failures are silently caught and never break message building
- controlled by `knowledgeBase.autoFlush` config (default: `true`)

## Cross-Scope Behavior

Code and global memory are intentionally separated.

- Code does not preload global memory
- global chat does not preload Code-session memory
- `memory_bridge_search` is the only built-in cross-scope lookup path
- bridge results are reference material, not a context switch
- broader tool access does not change the active memory scope
- repo-awareness state such as `workspaceProfile`, `workspaceMap`, and `workingSet` is separate from both long-term memory scopes

This keeps the Coding Assistant grounded in its session and repo without removing access to the wider tool inventory.

## Comparison with OpenClaw

| Feature | GuardianAgent | OpenClaw |
|---------|--------------|----------|
| **Storage backend** | SQLite with FTS5 + native hybrid search | SQLite FTS5 + optional QMD sidecar |
| **Search** | FTS5 BM25 + native hybrid (BM25 + vector similarity + RRF) | Hybrid BM25 + vector similarity |
| **Persistent memory** | Global agent markdown memory plus per-Code-session markdown memory | `MEMORY.md` + daily logs |
| **Memory flush** | Auto-persist dropped context into the matching scope | LLM-prompted flush before compaction |
| **Temporal decay** | No | Configurable half-life scoring |
| **MMR diversity** | No | Maximal Marginal Relevance |
| **Embedding providers** | Ollama, OpenAI (in-process, optional) | OpenAI, Gemini, Voyage, Ollama, local |
| **Cross-channel identity** | IdentityService with aliases | Not documented |
| **Session management** | Rotate, restore, list, Code-session attach/resume | Implicit via daily log files |
| **Security** | Guardian admission on all memory and search tools | Not documented |

### Key differences

GuardianAgent advantages:

- all memory tools pass through Guardian security controls
- `memory_search`, `memory_recall`, and bridge results are scanned before reinjection into model context
- persistent memory is trust-aware, with quarantine/expiry states instead of flat append-only storage
- Code-session memory is isolated from global memory by default
- explicit cross-channel identity unification
- explicit session management with rotate/restore and backend-owned Code sessions

OpenClaw advantages:

- vector similarity search emphasis in the memory layer
- LLM-powered memory flush
- temporal decay scoring
- MMR for result diversity
- broader embedding-provider surface

## Future Enhancement Opportunities

1. **Selective sync policies**: promote approved facts between Code-session and global memory without automatic context sharing.
2. **LLM-powered flush**: generate actual summaries instead of raw preview blocks.
3. **Temporal decay**: add timestamp-based scoring to memory retrieval.
4. **Daily logs**: add automatic daily logs alongside curated markdown memory.

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
| `src/runtime/code-sessions.ts` | Backend Code-session records and session resolution |
| `src/tools/executor.ts` | `memory_search`, `memory_recall`, `memory_save`, `memory_bridge_search` tool registration and scope binding |
| `src/tools/types.ts` | `memory` tool category definitions |
| `src/index.ts` | Service wiring, scoped memory flush routing, prompt-time memory injection, search bootstrap |
| `src/prompts/code-session-core.ts` | Dedicated Code-session prompt assembly |
| `src/runtime/conversation.test.ts` | FTS5 search and memory-flush tests |
| `src/tools/executor.test.ts` | Memory tool scope and bridge-search tests |
