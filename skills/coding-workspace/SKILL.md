---
name: coding-workspace
description: Use when the request is about a repo, codebase, implementation, bugfix, or backend-owned coding session that should stay anchored to the active workspace.
---

# Coding Workspace

Use this workflow for backend-owned coding sessions inside a project workspace.

The coding session is the authoritative project context:
- use the backend session’s workspace root, workspace profile, indexed repo map, working-set files, focus summary, selected file, and recent work as your default context
- keep repo-local actions inside that workspace
- do not preload host-application context when reasoning inside the coding session
- use the coding session’s own long-term memory as the default memory scope; do not assume global memory is available unless explicitly bridged
- you may still use broader tools and capabilities, including non-coding tasks, but do not let that replace the session’s repo anchor unless the user explicitly changes sessions or retargets the work

Preferred loop:
1. If the user wants to continue existing coding work, inspect the current attachment with `code_session_current` or list sessions with `code_session_list`.
2. If no suitable session exists, create one with `code_session_create`, then treat that backend session as the shared source of truth across web, CLI, and Telegram. Shared session state does not mean those surfaces have the same UI or transport.
3. Understand the request and inspect the relevant files or symbols first.
4. Create or update a concise plan with explicit acceptance gates before broad or multi-file edits.
5. Make the smallest safe change with `code_edit`, `code_patch`, or `code_create`.
6. Verify with `code_git_diff` and the strongest existing relevant checks before falling back to narrower ad hoc tests.

Guardrails:
- Prefer attaching to the right backend coding session over guessing the active workspace from the current chat alone.
- If an explicitly targeted backend coding session cannot be resolved, recover or reattach that session first instead of downgrading into generic chat context.
- Treat the workspace profile, indexed repo map, and current working set as the default project context, but re-read files before making concrete claims or edits.
- If the user asks what the repo/workspace/app is, start from the retrieved working-set files and repo map, then deepen with tool reads if needed. Cite the files you checked.
- Re-read the file before retrying an edit that failed to match.
- Prefer patches for multi-hunk changes and targeted edits for isolated replacements.
- Keep changes within the attached coding session workspace root.
- It is valid to create automations or use non-coding tools from within the coding session, but do not lose the session’s repo context while doing so.
- If you need to inspect global memory from a coding session, do it explicitly through the read-only memory bridge instead of treating it as default context.
- If the session is getting noisy, summarize progress so it can be compacted without losing the plan.
- Before calling work complete, make sure the real proof surface is fully green, not just the smallest local check.

## Gotchas

- Do not treat a plain web or CLI turn as a coding-session turn unless the backend session is actually attached or explicitly targeted.
- Do not rely on workspace summaries alone when making code claims; re-read the concrete files before editing or asserting behavior.
- Do not let broader research, memory, or automation work sever the active repo/session anchor.
