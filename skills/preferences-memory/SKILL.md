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
