---
name: skill-creator
description: Guide for creating new skills, improving existing skills, and evaluating skill quality. Use this whenever the user wants to turn a workflow into a skill, revise a skill, improve triggering behavior, or add evals and benchmarks for a skill.
---

# Skill Creator

Treat skill work as an iterative workflow: capture intent, draft the skill, test it, review the output, and refine it.

## Start With Intent

Extract as much as possible from the current conversation before asking for more:

- what the skill should help with
- when it should trigger
- what good output looks like
- whether the task needs deterministic evals or mostly qualitative review

## Drafting Rules

- Put trigger guidance in the frontmatter description, not only in the body.
- Make the description specific enough to activate reliably.
- Keep the skill body procedural and easy to scan.
- Move large supporting material into `references/`, `templates/`, or `examples/`.

## Improvement Loop

1. Draft or revise the skill.
2. Write 2-3 realistic test prompts.
3. Compare with-skill behavior against a baseline when possible.
4. Capture what improved, what regressed, and what still feels vague.
5. Tighten the description and instructions, then test again.

## Evaluation Guidance

- Use objective checks for transforms, extraction, formatting, and code generation.
- Prefer qualitative review for tone, design, or open-ended writing.
- Name evals by the behavior they test.
- Keep assertions specific enough that a weak answer cannot pass by accident.

Read [references/eval-rubric.md](./references/eval-rubric.md) when you need a compact checklist for writing or reviewing skill evals.
