---
name: skill-creator
description: Guide for creating new skills, improving existing skills, and evaluating skill quality. Use this whenever the user wants to turn a workflow into a skill, revise a skill, improve triggering behavior, or add evals and benchmarks for a skill.
---

# Skill Creator

Treat skill work as an eval-driven workflow: understand real usage, draft the skill, test trigger behavior, compare against baseline behavior, and refine it.

## Start With Intent

Extract as much as possible from the current conversation before asking for more:

- what the skill should help with
- when it should trigger
- what good output looks like
- whether the task needs deterministic evals or mostly qualitative review

When the workflow is still vague, capture 2-3 realistic user prompts before writing the skill.

## Drafting Rules

- Put trigger guidance in the frontmatter description, not only in the body.
- Make the description describe when to use the skill, not the full workflow inside the skill.
- Prefer trigger symptoms and task conditions over abstract labels.
- Keep the skill body procedural and easy to scan.
- Move large supporting material into `references/`, `templates/`, or `examples/`.
- Keep `SKILL.md` focused on the workflow. Put heavy reference content in `references/`.
- If the skill is imported or adapted from a third-party source, preserve provenance and license notices in `THIRD_PARTY_NOTICES.md`.

## Improvement Loop

1. Draft or revise the skill.
2. Write 2-3 realistic test prompts.
3. Compare with-skill behavior against a baseline when possible.
4. Check two things separately:
   - Did the skill trigger when it should?
   - Did the full skill body improve behavior after triggering?
5. Capture what improved, what regressed, and what still feels vague.
6. Tighten the description and instructions, then test again.

## Evaluation Guidance

- Use objective checks for transforms, extraction, formatting, and code generation.
- Prefer qualitative review for tone, design, or open-ended writing.
- Name evals by the behavior they test.
- Keep assertions specific enough that a weak answer cannot pass by accident.
- When the change affects runtime skill behavior, update `docs/specs/SKILLS-SPEC.md` in the same pass.

Read [references/eval-rubric.md](./references/eval-rubric.md) when you need a compact checklist for writing or reviewing skill evals.
