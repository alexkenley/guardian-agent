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

## Related Skills

- Use `systematic-debugging` when you do not yet understand the issue.
- Use `test-driven-development` when the missing proof is a failing or passing test.
