---
name: systematic-debugging
description: Use when encountering a bug, failing test, broken integration, or unexpected behavior, before proposing fixes.
---

# Systematic Debugging

Do not guess. Find the root cause before changing code, config, or prompts.

## Core Rule

No fixes without investigation first.

If you have not reproduced the issue, read the errors, and traced where the bad state comes from, you are not ready to fix it.

## Workflow

1. Capture the exact failure.
   - Record the command, request, or user action that fails.
   - Read the full error output, stack trace, and relevant logs.
   - If the issue is intermittent, collect enough evidence to describe the pattern.
2. Reproduce the issue consistently.
   - Prefer the narrowest reliable reproduction.
   - If you cannot reproduce it, gather more evidence instead of guessing.
3. Check recent changes and working examples.
   - Look at the diff, config changes, dependency changes, and comparable working code paths.
4. Trace backward to the source of the bad value or state.
   - Start where the failure appears.
   - Keep moving backward until you find where the wrong input, assumption, or transition originated.
5. Form one hypothesis and test it with the smallest useful change.
   - Change one thing at a time.
   - If the hypothesis fails, return to investigation with the new evidence.
6. Add a regression test or equivalent reproducible check before the permanent fix.
7. Verify the fix with the original reproduction and the regression test.

## Stop Signs

Stop and return to investigation if you catch yourself:

- proposing multiple fixes at once
- saying "it is probably X"
- patching symptoms without tracing source state
- skipping a failing test because manual verification seems faster
- trying a fourth fix after three failed attempts

Three failed fix attempts usually means the architecture or assumption is wrong, not that you need more guessing.

## Supporting References

- Read [references/root-cause-tracing.md](./references/root-cause-tracing.md) when the error is deep in a call stack or event chain.
- Read [references/condition-based-waiting.md](./references/condition-based-waiting.md) when the issue looks timing-related or flaky.
- Read [references/defense-in-depth.md](./references/defense-in-depth.md) after finding the root cause and you need follow-up validation at multiple layers.

## Related Skills

- Use `test-driven-development` when you need the regression test and implementation loop.
- Use `verification-before-completion` before claiming the issue is fixed.
