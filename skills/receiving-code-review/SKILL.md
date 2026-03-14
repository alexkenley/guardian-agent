---
name: receiving-code-review
description: Use when addressing code review or QA feedback, especially when the feedback is unclear, broad, or technically questionable.
---

# Receiving Code Review

Evaluate feedback technically before implementing it. Do not perform agreement. Do not batch changes blindly.

## Workflow

1. Read all feedback without reacting to individual items.
2. Restate or clarify anything ambiguous before editing.
3. Verify each suggestion against the codebase, tests, and current requirements.
4. Implement one item or one coherent group at a time.
5. Re-test after each meaningful change.
6. Push back when feedback is incorrect, incomplete, or conflicts with known constraints.

## Rules

- If feedback is unclear, ask before changing code.
- If feedback seems wrong, explain why with concrete evidence.
- If feedback points to a real issue, fix it and state what changed.
- Avoid performative phrases. Technical acknowledgment is enough.

## Red Flags

- implementing comments you do not fully understand
- changing multiple unrelated things in one pass
- assuming an external reviewer has full context
- treating "seems more proper" as sufficient justification
