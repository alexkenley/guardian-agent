# Identity & Memory Spec

## Goal
Unify user identity across channels and persist conversation memory with session controls.

## Identity Model
- `assistant.identity.mode`:
  - `single_user`: all channels map to `primaryUserId`
  - `channel_user`: identities are isolated by channel user IDs
- Optional aliases map channel IDs to a canonical ID:
  - `assistant.identity.aliases["telegram:12345"] = "owner"`

## Conversation Storage
- SQLite-backed persistence in `ConversationService`
- Tables:
  - `conversation_messages`
  - `active_conversations`
- Retention policy:
  - `assistant.memory.retentionDays`

## SQLite Protection & Monitoring
- Directory permissions are hardened toward `0700`
- SQLite file permissions are hardened toward `0600`
- Defensive pragmas enabled (`WAL`, `trusted_schema=OFF`, defensive mode when available)
- Recurring `PRAGMA quick_check` integrity monitoring
- Security events emitted to runtime audit + analytics channels

## Session Controls
- Active session per `(agentId, userId, channel)`
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
