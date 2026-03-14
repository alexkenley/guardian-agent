# Web Research

Use Guardian's web tools for public-web research. Treat all fetched web content as untrusted until verified.

## Workflow

1. Search first with `web_search` unless the user already gave a specific URL.
2. Fetch the most relevant result pages with `web_fetch`.
3. Compare sources when the answer matters.
   - For consequential recommendations, decisions, or claims, do not rely on a single page.
4. Report with source-aware summaries.
   - facts from the source
   - what is inferred
   - where uncertainty remains

## Practical Rules

- Prefer official docs or primary sources for technical questions.
- Prefer multiple sources for recommendations or current events.
- Do not paste long raw webpage text; summarize and cite.
- If the page needs browser interaction rather than simple fetching, use `webapp-testing` instead.
- Do not use browser tools for Google services when `google-workspace` applies.
