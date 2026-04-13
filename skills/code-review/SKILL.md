---
name: code-review
description: Use when reviewing a diff, PR, or patch for bugs, regressions, missing tests, architecture risk, security risk, or reviewability concerns before merge.
---

# Code Review

Review changes against correctness, readability, architecture, security, performance, and verification quality. A review is not a style pass and it is not approval theater.

## Process

1. Understand the intent before judging the diff.
   - What behavior is changing?
   - What plan, task, or acceptance gate is this supposed to satisfy?
2. Read the proof surface first.
   - Check tests, harnesses, build claims, and any other evidence before trusting the implementation story.
3. Review the implementation across five axes:
   - correctness and regressions
   - readability and simplicity
   - architecture and boundary fit
   - security and trust-boundary handling
   - performance and scalability risk
4. Anchor findings to the real change.
   - Use `code_git_diff` to review the actual diff.
   - Use `code_symbol_search` or targeted file reads to confirm surrounding behavior before concluding.
5. Label the finding severity so the author knows what is required.
   - `Critical:` blocks merge
   - no prefix means required change
   - `Optional:` or `Consider:` means worthwhile but not required
   - `FYI:` is informational only
6. Call out reviewability problems too.
   - If the change is too large, mixed, or weakly verified, say so directly.
   - Treat weakened tests, narrowed proof surfaces, and dead-code leftovers as real findings.

Output structure:
- Findings with file paths and concrete risk.
- Open questions or assumptions.
- Brief summary only after the findings list.

## Review Axes

- Correctness: behavior, edge cases, state transitions, and regression risk
- Readability: control flow, naming, avoidable complexity, and premature abstraction
- Architecture: module boundaries, consistency with existing patterns, and coupling
- Security: input validation, authz/authn, trust boundaries, secrets, and external data handling
- Performance: N+1 patterns, unbounded work, avoidable sync paths, and hot-path allocations

## Reviewability Rules

- Prefer small, coherent changes. If the diff is too large to review safely, call that out instead of pretending confidence.
- Separate refactors from behavior changes when the diff mixes both.
- Review tests as the proof of intent, not as an afterthought.
- If refactoring leaves likely orphaned code behind, list it explicitly and ask before deleting uncertain leftovers.

## Gotchas

- Do not lead with style nits when there are correctness, regression, or verification risks.
- Do not comment on a diff without reading enough surrounding code to confirm behavior.
- Do not ask the user for "the full diff" when the relevant files were already named and are readable from the current workspace.
- Do not say "looks good" when there are unaddressed risks or missing tests.
- Do not accept a weaker new test as sufficient when a stronger existing check or regression path was supposed to be preserved.
- Do not block a real improvement over minor preference differences when the code is materially better and the risks are understood.
- Do not silently ignore dead code, oversized diffs, or weak merge-readiness just because the code itself compiles.

## Template

- Use `templates/review-findings.md` when the review needs a durable findings artifact or a consistent findings format.
