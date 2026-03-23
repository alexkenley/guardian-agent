# Browser Tool Selection

Prefer the Guardian wrapper tools first:

- `browser_read` for page text and snapshot-driven reads
- `browser_links` for link maps
- `browser_extract` for structured metadata and semantic outline
- `browser_state` plus `browser_act` for deterministic interaction

Drop to raw Playwright tools when you need:

- clicks, typing, or form submission
- file uploads
- screenshots
- auth flows
- multi-step interaction in SPAs
- console or network debugging tied to a rendered browser session
