---
name: deep-research
description: Use when the task needs investigation first, especially to compare code paths, trace behavior, or synthesize findings before implementation.
---

# Deep Research

Use this skill when the task needs investigation before implementation.

Workflow:
1. Define the exact question being answered.
2. Inspect the smallest relevant file and symbol set first.
3. Compare competing code paths, old vs new behavior, or proposal vs implementation.
4. Produce a concise synthesis: what is true, what is inferred, what is still unknown.

Guardrails:
- Do not start editing until the research question is answered.
- Keep notes compact and decision-oriented.
- If the investigation branches, summarize each branch separately before merging conclusions.

## Gotchas

- Do not drift from investigation into implementation just because a likely fix becomes obvious.
- Do not mix confirmed observations and inferred conclusions into one bullet list.
- Do not read the whole repo when a narrow symbol/file comparison can answer the question.

## Template

- Use `templates/research-brief.md` when the findings need to be handed off or saved as a durable brief.
