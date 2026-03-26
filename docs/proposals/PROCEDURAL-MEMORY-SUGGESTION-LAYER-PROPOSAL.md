# Procedural Memory Suggestion Layer

**Date:** 2026-03-26
**Status:** Future uplift (not scheduled)
**Origin:** Production agent architecture comparison — identified as the primary architectural gap vs. industry expectations

## Problem

Users who repeatedly execute the same multi-tool workflows must re-explain them every time. The system has no mechanism to recognize recurring patterns and reduce repetition. Industry frameworks cite "procedural memory" (learned tool sequences) as a production agent requirement.

However, autonomous procedural learning — where the system silently learns and replays tool sequences — would compromise GuardianAgent's security model. The architecture explicitly prevents agent self-modification via DeniedPathController, HMAC-signed control plane integrity, and tainted content isolation. Autonomous learning is a form of self-modification.

## Design Constraints

Any solution must preserve:

1. **No silent behavior change.** The system never executes a learned sequence without explicit human review and approval.
2. **Control plane integrity.** Learned patterns are stored as standard playbooks, subject to the same Guardian pipeline as any authored automation.
3. **Trust provenance.** Patterns derived from untrusted tool results cannot be proposed as automations without flagging the trust lineage.
4. **Full audit trail.** Every suggested and accepted pattern is logged with its derivation history.

## Proposed Architecture

### Phase 1 — Pattern Detection

Mine `RunStateStore` execution history for recurring successful tool sequences.

**Detection criteria:**
- Same ordered tool sequence executed >= 3 times across different sessions
- All executions succeeded (no Guardian denials, no errors)
- Sequence length 2-8 steps (too short = trivial, too long = likely unique)
- Tool arguments share structural similarity (same parameter keys, similar value shapes)

**Implementation:**
- New `PatternMiner` service in `src/runtime/`
- Runs on a low-frequency cron (e.g., daily) or on-demand via API
- Reads from existing `RunStateStore` history (max 200 recent runs already stored)
- Outputs `SuggestedPattern[]` with: tool sequence, argument templates (with placeholders for variable values), frequency count, confidence score, trust lineage

### Phase 2 — Suggestion Surface

Surface detected patterns to the user as automation proposals, not autonomous replays.

**UX flow:**
1. Pattern detected by miner
2. System surfaces suggestion: "I've noticed you run [fs_read -> shell_safe -> memory_save] frequently for log analysis. Would you like to save this as an automation?"
3. User reviews the proposed playbook (steps, argument templates, schedule)
4. User approves, modifies, or dismisses
5. If approved, stored as a standard playbook via `ConnectorPlaybookService`

**Channels:**
- Web: notification badge on Automations page + suggestion card in automation list
- CLI: `/suggestions` command to list pending pattern suggestions
- Chat: assistant mentions suggestions when contextually relevant (e.g., user starts a sequence that matches a known pattern)

### Phase 3 — Guardian-Gated Execution

Accepted patterns become standard playbooks. No special execution path.

- Full Guardian admission pipeline on every execution
- Human approval gates for mutating steps (same as any playbook)
- Audit logging with `origin: 'learned_pattern'` for traceability
- Trust lineage preserved: if the original pattern involved untrusted tool results, the playbook is flagged accordingly

## What This Does NOT Include

- **Autonomous replay.** The system never executes a pattern without the user having explicitly approved it as a playbook.
- **Silent learning.** No background model tuning, no prompt weight adjustment, no tool selection bias.
- **Reflection loops.** Eval results and anomaly findings remain reporting-only; they do not autonomously adjust system behavior.
- **Skill libraries.** Patterns are per-user, not shared across users or agents, unless explicitly promoted.

## Security Analysis

| Risk | Mitigation |
|---|---|
| Poisoned learning (attacker influences tool results to plant patterns) | Trust lineage tracks source of every tool result in the pattern; untrusted sources flagged on suggestion |
| Approval fatigue (users rubber-stamp suggestions) | Suggestions are infrequent (daily mining at most); UI shows full step detail, not just a name |
| Privilege escalation (learned pattern includes elevated actions) | Pattern executes through standard Guardian pipeline; no approval bypass for "known" patterns |
| Audit trail confusion | `origin: 'learned_pattern'` tag + derivation history (which runs the pattern was derived from) |

## Scope Estimate

- **Files:** ~3 new (pattern-miner.ts, pattern-miner.test.ts, suggestion API routes), ~4 modified (run-state-store, automations.js, cli.ts, index.ts bootstrap)
- **Dependencies:** None new — uses existing RunStateStore, ConnectorPlaybookService, Guardian pipeline
- **Risk:** Low — purely additive; no changes to existing execution paths

## Decision

Deliberately deferred. The absence of autonomous procedural learning is a security feature, not a gap. This proposal provides a path to close the UX gap if/when the benefit justifies the complexity, without compromising the trust model.
