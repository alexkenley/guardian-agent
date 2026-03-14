# File Workflows

Use Guardian's filesystem and document tools for local file work inside allowed paths.

## Workflow

1. Inspect the target location first when context is missing.
   - `fs_list` to see the folder
   - `fs_search` to find likely files
   - `fs_read` to understand the existing document before editing
2. Use the narrowest write tool for the job.
   - `doc_create` for new documents and reports
   - `fs_write` for writing or replacing file contents
   - `fs_mkdir` for new folders
   - `fs_move`, `fs_copy`, `fs_delete` only when the requested change is explicit
3. Ask only for missing critical details.
   - file name
   - target path
   - document format or structure when it materially changes the output
4. Summarize what changed after each mutation.

## Practical Rules

- Prefer editing existing files over creating duplicates when the intent is an update.
- For destructive operations, confirm scope if the request is ambiguous.
- If the path is outside current policy roots, let Guardian handle the approval flow rather than telling the user to do it manually.
- When the user wants a durable plan or report, write it to the repo or target folder instead of only describing it in chat.
