# Knowledge Search

Use indexed search when the user wants answers from local docs, notes, wikis, or repository content that has already been ingested into the search service.

## Workflow

1. Use `doc_search` for discovery across indexed collections.
2. Read only the specific files or passages you need after the search narrows the scope.
   - Use `fs_read` for exact follow-up reads.
3. Use `doc_search_status` when the user asks about indexing health or when search results look unexpectedly empty.
4. Use `doc_search_reindex` only when stale or missing search state is actually blocking the task.
5. When the user wants a summary of local docs or indexed material, summarize from the retrieved passages directly instead of depending on an external summary CLI unless that reviewed third-party skill has been explicitly approved and enabled.

## Practical Rules

- Prefer indexed search for broad discovery.
- Prefer `fs_read` or `fs_search` only after you know the file or exact target.
- Tell the user when the answer is coming from indexed content versus a direct file read.

## Gotchas

- Do not reindex first; confirm that stale or missing index state is actually the blocker.
- Do not present indexed-search results as if they cover files that were never ingested.
- Do not read large numbers of files after search if a few targeted passages answer the question.
