# Preferences Memory

Use memory tools only when the user explicitly wants a stable fact or preference remembered beyond the current conversation.

## Workflow

1. Confirm the thing is worth remembering.
   - stable preference
   - profile detail
   - standing instruction
   - recurring project context
2. Check for an existing related memory first with `memory_search` or `memory_recall`.
3. Save a concise normalized memory with `memory_save`.
4. Tell the user what was remembered in plain language.

## Recurring Learnings

- If the user explicitly wants a lesson from this task retained for future conversations, normalize it into a short stable rule or project fact before saving it.
- Prefer one durable memory over a long incident log.
- Save only the part that will still matter later.

## Do Not Turn This Into

- ad-hoc `.learnings/` files
- automatic hook installation
- autonomous self-improvement loops
- silent edits to `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md`

## Do Save

- preferred writing style or output format
- stable names, roles, or relationships the user wants reused
- recurring workflow preferences
- durable project context the user explicitly wants retained

## Do Not Save

- one-off operational notes
- temporary status output
- approval bookkeeping
- transient paths, errors, or command results unless the user specifically asks to remember them

## Gotchas

- Do not save memories implicitly from ordinary conversation; the user needs to want persistence.
- Do not store volatile logs, diagnostics, or ephemeral paths as durable memory.
- Do not turn memory into self-modifying prompts, local hook setup, or hidden configuration drift.
