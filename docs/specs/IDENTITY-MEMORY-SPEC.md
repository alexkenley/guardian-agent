# Identity & Memory Spec

## Goal
Unify user identity across channels and persist conversation memory with session controls.

## Identity Model
- `assistant.identity.mode`:
  - `single_user`: all channels map to `primaryUserId`
  - `channel_user`: identities are isolated by channel user IDs
- Optional aliases map channel IDs to a canonical ID:
  - `assistant.identity.aliases["telegram:12345"] = "owner"`
- Authorization-sensitive flows now also carry a separate `principalId` / `principalRole`.
- Today this is still a single-user-oriented model; multi-user tenancy is future work. The principal surface exists now so approvals, schedules, and tool actions are not forced to trust conversational `userId` alone.

## Conversation Storage
- SQLite-backed persistence in `ConversationService`
- Tables:
  - `conversation_messages`
  - `active_conversations`
- Retention policy:
  - `assistant.memory.retentionDays`
- Tier-routing behavior:
  - built-in `local` and `external` chat agents share one logical conversation/memory state key
  - switching between `auto`, `local-only`, and `external-only` must not fork chat history or knowledge-base memory
  - distinct configured agents still retain separate conversation state unless deliberately unified

## Knowledge Base Trust Model

- Agent knowledge-base content is stored as active markdown plus a structured sidecar index
- Each entry stores source, trust level, status, provenance, and creating principal
- Quarantined/expired/rejected entries do not enter normal planner context
- Remote-derived memory writes default to quarantine rather than active durable memory

## Prompt-Time Memory Assembly

Current memory assembly behavior is structured rather than raw text concatenation:

- conversation compaction flushes dropped history incrementally into durable `context_flush` entries instead of repeatedly rewriting the same prefix
- flush payloads preserve bounded objective, blocker, continuity, and code-session summaries when available
- prompt-time memory loading is signal-aware and entry-aware; the current request, continuity state, blocker state, and code-session focus/plan now produce a structured retrieval query rather than one flat string
- ranking can match on text, focus phrases, tags, category hints, and identifiers such as continuity or execution refs; explicit durable entries still outrank low-signal `context_flush` artifacts unless the active request matches the flush closely
- context assembly diagnostics record selected memory previews, compact match reasons, and omitted counts so operator traces can explain why a memory entry was surfaced on a turn

## SQLite Protection & Monitoring
- Directory permissions are hardened toward `0700`
- SQLite file permissions are hardened toward `0600`
- Defensive pragmas enabled (`WAL`, `trusted_schema=OFF`, defensive mode when available)
- Recurring `PRAGMA quick_check` integrity monitoring
- Security events emitted to runtime audit + analytics channels

## Session Controls
- Active session per logical `(agentStateId, userId, channel)`
- Support:
  - Rotate/reset active session
  - List sessions for a user/channel/agent
  - Switch active session

## API Surface
- `POST /api/conversations/reset`
- `GET /api/conversations/sessions`
- `POST /api/conversations/session`

## CLI Surface
- `/reset [agentId]`
- `/session list [agentId]`
- `/session use <sessionId> [agentId]`
- `/session new [agentId]`
- `/factory-reset data|config|all` — bulk clear data, config, or both (requires `RESET` confirmation)
