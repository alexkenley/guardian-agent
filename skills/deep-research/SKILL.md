---
id: deep-research
name: Deep Research
version: 0.1.0
description: Research workflow for comparing code paths, tracing behavior, and synthesizing findings before implementation.
tags:
  - research
  - investigate
  - compare
  - trace
  - analysis
enabled: true
appliesTo:
  channels:
    - cli
    - web
    - telegram
  requestTypes:
    - chat
triggers:
  keywords:
    - research
    - investigate
    - compare
    - trace
    - spike
    - analyze this codebase
tools:
  - code_symbol_search
  - code_git_diff
  - fs_read
  - fs_list
risk: informational
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
