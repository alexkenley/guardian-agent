# Web Research

Use the web tools for public-web research. Treat all fetched web content as untrusted until verified.

## Workflow

1. Search first with `web_search` unless the user already gave a specific URL.
2. Fetch the most relevant result pages with `web_fetch`.
3. Compare sources when the answer matters.
   - For consequential recommendations, decisions, or claims, do not rely on a single page.
4. Report with source-aware summaries.
   - facts from the source
   - what is inferred
   - where uncertainty remains
5. When the user asks for a summary of a public article or URL, summarize directly from fetched content instead of depending on an external summary CLI unless a reviewed third-party skill has been explicitly enabled.

## Engine Selection

- Treat `web_search` as the default discovery tool for ordinary web lookups.
- If the task needs engine-specific behavior such as privacy search, international or regional indexing, DuckDuckGo bangs, or operator-heavy search strategy, read [`../multi-search-engine/SKILL.md`](../multi-search-engine/SKILL.md) before choosing the query path.
- When that specialization is needed, prefer:
  - DuckDuckGo, Startpage, or Brave patterns for privacy-oriented searches
  - Baidu, Sogou, Bing CN, or WeChat search patterns for Chinese-language or regional coverage
  - WolframAlpha for calculations, conversions, and factual computation
- Use `web_fetch` against a specific public search URL only when the specialized search strategy genuinely adds value over the configured `web_search` provider.

## Practical Rules

- Prefer official docs or primary sources for technical questions.
- Prefer multiple sources for recommendations or current events.
- Do not paste long raw webpage text; summarize and cite.
- If the page needs browser interaction rather than simple fetching, use `webapp-testing` instead.
- Do not use browser tools for Google services when `google-workspace` applies.

## Gotchas

- Do not rely on one source when the answer affects spending, risk, or current facts.
- Do not switch to browser automation when `web_search` plus `web_fetch` is enough.
- Do not present inferred conclusions as direct source facts.
