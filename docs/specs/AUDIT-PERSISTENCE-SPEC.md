# Audit Persistence Spec

## Goal
Persist audit events to disk with a SHA-256 hash chain for tamper detection. Events survive process restarts and can be verified for integrity.

## Problem
The AuditLog is an in-memory ring buffer. Events are lost on restart. There is no tamper detection — a compromised process could silently modify or delete security records.

## Scope
- Runtime module: `src/guardian/audit-persistence.ts`
- Integration: `src/guardian/audit-log.ts` (fire-and-forget persistence hook)
- Runtime wiring: `src/runtime/runtime.ts` (init + wire on startup)
- Dashboard API: `GET /api/audit/verify` (chain integrity check)
- Web Security page: "Verify Audit Chain" button
- Audit event families include brokered and delegated-worker lifecycle breadcrumbs such as `delegated_worker_started`, `delegated_worker_completed`, and `delegated_worker_failed`

## Design

### Hash Chain
Each persisted entry contains the event, the previous entry's hash, and the current entry's hash:

```
{ event: AuditEvent, previousHash: string, hash: string }
```

- Hash algorithm: SHA-256 via `node:crypto`
- Hash input: `JSON.stringify({ event, previousHash })`
- Genesis hash: `'0'.repeat(64)` (64 zero characters)
- Storage format: JSONL (one JSON object per line) at `~/.guardianagent/audit/audit.jsonl`

### Write Path
- `persist(event)` computes hash, appends a JSON line, updates `lastHash`
- Writes are serialized via chained Promises (no mutex library needed)
- Called fire-and-forget from `AuditLog.record()` so the hot path is not blocked

### Read Path
- `readTail(count)` returns the last N entries for rehydration on startup
- `verifyChain()` streams the file line by line, recomputes each hash, returns `{ valid, totalEntries, brokenAt? }`

### Init / Recovery
- `init()` ensures the audit directory exists
- Reads the last line of an existing file to recover `lastHash`
- Handles empty files and missing directories gracefully

## Configuration

```yaml
guardian:
  auditLog:
    maxEvents: 10000
    persistenceEnabled: true          # default: true
    auditDir: ~/.guardianagent/audit/ # default
```

## AuditLog Integration

New methods on `AuditLog`:
- `setPersistence(p: AuditPersistence)` — wire persistence after construction
- `verifyChain()` — delegate to persistence, returns `{ valid, totalEntries, brokenAt? }`
- `rehydrate(count)` — read persistence tail into ring buffer on startup

In `record()`, after creating the full event and before notifying listeners:
```typescript
this.persistence?.persist(full).catch(err => log.warn({ err }, 'Audit persist failed'));
```

## API

### `GET /api/audit/verify`
Returns:
```json
{
  "valid": true,
  "totalEntries": 1847,
  "brokenAt": null
}
```

If tampered:
```json
{
  "valid": false,
  "totalEntries": 1847,
  "brokenAt": 423
}
```

## Web UX
The Security page includes an "Audit Chain Integrity" section with a "Verify Audit Chain" button. Results display entry count and integrity status with pass/fail indicator.

## Factory Reset

`/factory-reset data` and `/factory-reset all` delete the entire `~/.guardianagent/audit/` directory, permanently destroying the tamper-evident chain. The genesis hash resets on next startup. This action requires typing `RESET` to confirm (CLI) or a privileged ticket (web API).

## Verification
1. Write events, restart process, verify events survive via `readTail()`
2. Tamper a line in the JSONL file, verify `verifyChain()` detects the correct index
3. Handle empty file, concurrent writes, and re-init recovery
4. Confirm brokered/delegated audit breadcrumbs persist with the same hash-chain guarantees as other audit events
