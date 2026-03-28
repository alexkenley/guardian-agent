---
name: test-driven-development
description: Use when implementing or changing code behavior, before writing production code.
---

# Test-Driven Development

Write the failing test first. Watch it fail for the right reason. Then write the smallest production change that makes it pass.

## Core Rule

No production code without a failing test first.

If code already exists for the behavior you are adding, discard or ignore it until the test exists and fails.

When multiple proof options exist, start with the strongest existing failing or high-fidelity check you can reasonably run.
Do not invent a narrower test just to avoid the real proof surface.

## Red-Green-Refactor

1. Red: write one small test for one behavior.
   - Name the behavior clearly.
   - Prefer real behavior over mock choreography.
2. Verify red.
   - Run the narrowest test command.
   - Confirm it fails for the expected reason, not because of typos or broken setup.
   - If an existing integration, scenario, or regression harness already covers the behavior, prefer that over a brand-new narrow unit test.
3. Green: write the smallest implementation that passes.
   - Do not add extra features or cleanup yet.
4. Verify green.
   - Re-run the focused test.
   - Run any broader existing check needed to prove the real behavior, not just the easiest local assertion.
5. Refactor while keeping tests green.

## Practical Rules

- One test, one behavior.
- Prefer narrow test runs while iterating.
- For bug fixes, the regression test comes before the fix.
- If a test is hard to write, examine the design. Difficult tests often reveal poor boundaries.
- If a broader existing check fails, do not replace it with a weaker new test and call the work done.

## Stop Signs

Stop and restart if:

- the test was written after the code
- the first run passed immediately
- you are testing mocks instead of behavior
- you are bundling multiple behaviors into one test
- you are narrowing the proof surface to avoid an existing failing harness

## Reference

Read [references/testing-anti-patterns.md](./references/testing-anti-patterns.md) before adding complex mocks, harness helpers, or test-only abstractions.
