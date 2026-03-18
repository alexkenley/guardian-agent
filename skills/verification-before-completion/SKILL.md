---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, or before committing or handing off results.
---

# Verification Before Completion

Evidence before claims.

Do not say work is done, fixed, or passing until you have run the command or check that proves it.

## Gate

Before making a completion claim:

1. Identify the command or check that proves the claim.
2. Run it fresh.
3. Read the full result, including failures and exit status.
4. State the actual outcome.

## Examples

- "Tests pass" requires the relevant test command output.
- "Build succeeds" requires the build command output.
- "Bug is fixed" requires the original reproduction or regression test to pass.
- "Requirements are met" requires checking the implemented result against the requested scope, not just passing tests.

## Red Flags

Stop if you are about to say:

- should be fixed
- looks good now
- probably passes
- done

without fresh verification evidence in the current turn.

## Repo-Specific Verification

When working in this GuardianAgent repository, prefer the existing harnesses before inventing ad hoc smoke checks:

- `scripts/run-code-ui-smoke.sh` -> runs `node scripts/test-code-ui-smoke.mjs`
- `scripts/run-skills-routing-harness.sh` -> runs `node scripts/test-skills-routing-harness.mjs`

Use these when the claim depends on the Code UI flow or skill routing behavior.

## Template

- Use `templates/verification-report.md` when you want a durable claim -> evidence -> outcome record.

## Related Skills

- Use `systematic-debugging` when you do not yet understand the issue.
- Use `test-driven-development` when the missing proof is a failing or passing test.
