# Knowledge Search

Use indexed search when the user wants answers from local docs, notes, wikis, or repository content that has already been ingested into Guardian's search service.

## Workflow

1. Use `doc_search` for discovery across indexed collections.
2. Read only the specific files or passages you need after the search narrows the scope.
   - Use `fs_read` for exact follow-up reads.
3. Use `doc_search_status` when the user asks about indexing health or when search results look unexpectedly empty.
4. Use `doc_search_reindex` only when stale or missing search state is actually blocking the task.

## Practical Rules

- Prefer indexed search for broad discovery.
- Prefer `fs_read` or `fs_search` only after you know the file or exact target.
- Tell the user when the answer is coming from indexed content versus a direct file read.
