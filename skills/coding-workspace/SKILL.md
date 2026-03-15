---
id: coding-workspace
name: Coding Workspace
version: 0.1.0
description: Workflow guidance for implementing code changes inside the Guardian coding workspace.
tags:
  - coding
  - code
  - refactor
  - bugfix
  - implementation
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
    - code workspace
    - workspaceRoot
    - selectedFile
    - coding
    - implement
    - fix
    - refactor
    - patch
    - bug
tools:
  - code_symbol_search
  - code_edit
  - code_patch
  - code_create
  - code_plan
  - code_git_diff
  - code_test
  - code_build
  - code_lint
risk: operational
---

# Coding Workspace

Use this workflow for coding-assistant sessions inside a project workspace.

Preferred loop:
1. Understand the request and inspect the relevant files or symbols first.
2. Create or update a concise plan before broad or multi-file edits.
3. Make the smallest safe change with `code_edit`, `code_patch`, or `code_create`.
4. Verify with `code_git_diff` and targeted `code_test`, `code_lint`, or `code_build` runs.

Guardrails:
- Re-read the file before retrying an edit that failed to match.
- Prefer patches for multi-hunk changes and targeted edits for isolated replacements.
- Keep changes within the active workspace root.
- If the session is getting noisy, summarize progress so it can be compacted without losing the plan.
