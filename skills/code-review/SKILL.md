---
name: code-review
description: Use when reviewing a diff, PR, or patch for bugs, regressions, missing tests, or operational risk.
---

# Code Review

When reviewing code changes:
- Start with findings, not compliments or summaries.
- Prioritize correctness issues, behavior regressions, security risk, and missing verification.
- Use `code_git_diff` to anchor comments to actual changes.
- Use `code_symbol_search` or file reads to confirm surrounding behavior before concluding.
- Call out missing or weak tests when the change affects branching logic, persistence, external side effects, or approvals.

Output structure:
- Findings with file paths and concrete risk.
- Open questions or assumptions.
- Brief summary only after the findings list.

## Gotchas

- Do not lead with style nits when there are correctness, regression, or verification risks.
- Do not comment on a diff without reading enough surrounding code to confirm behavior.
- Do not say "looks good" when there are unaddressed risks or missing tests.

## Template

- Use `templates/review-findings.md` when the review needs a durable findings artifact or a consistent findings format.
