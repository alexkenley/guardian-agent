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

Completion requires the real proof surface to be green, not just a convenient subset.

Use the phrase **full legitimate green** as the bar:

- the relevant focused check passes
- any stronger existing regression, integration, or scenario check that proves the claim also passes
- no known broader required check is being skipped or silently weakened

In the written response, explicitly use the phrase `proof surface` when describing the completion bar.

## Examples

- "Tests pass" requires the relevant test command output.
- "Build succeeds" requires the build command output.
- "Bug is fixed" requires the original reproduction or regression test to pass.
- "Requirements are met" requires checking the implemented result against the requested scope, not just passing tests.
- "Ready to hand off" requires the proof surface that actually matches the promised change, not a narrower substitute.

## Red Flags

Stop if you are about to say:

- should be fixed
- looks good now
- probably passes
- done

without fresh verification evidence in the current turn.

Also stop if:

- you are skipping a broader existing check without explaining why
- you are replacing a failing real-world check with a weaker new test
- you are claiming success from partial green when the legitimate completion bar is still red

## Repo-Specific Verification

When working in this GuardianAgent repository, prefer the existing harnesses before inventing ad hoc smoke checks:

- `scripts/run-code-ui-smoke.sh` -> runs `node scripts/test-code-ui-smoke.mjs`
- `scripts/test-coding-assistant.mjs` -> coding assistant and code-session workflow harness
- `scripts/run-skills-routing-harness.sh` -> runs `node scripts/test-skills-routing-harness.mjs`

Use these when the claim depends on the Code UI flow or skill routing behavior.

## Template

- Use `templates/verification-report.md` when you want a durable claim -> evidence -> outcome record.

## Related Skills

- Use `systematic-debugging` when you do not yet understand the issue.
- Use `test-driven-development` when the missing proof is a failing or passing test.
