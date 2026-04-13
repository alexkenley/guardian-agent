# Source Verification Checklist

## Version Detection

- Read the repo dependency source before making framework-specific claims.
- Typical files:
  - `package.json`
  - `pyproject.toml`
  - `requirements.txt`
  - `Cargo.toml`
  - `go.mod`
  - `Gemfile`

## Source Hierarchy

Prefer sources in this order:
1. Official docs or API reference
2. Official migration guide or changelog
3. MDN or a standards/runtime compatibility source
4. Existing repo code, only after comparing it with the current official guidance

Do not use tutorials, blog posts, Stack Overflow, or model memory as the primary source when the version matters.

## Citation Rules

- Cite the exact page you relied on, not just the docs home page.
- Prefer deep links or anchors when available.
- Quote only the small passage needed to justify a non-obvious decision.
- If you cannot verify a pattern, say `UNVERIFIED` and explain what was missing.

## Conflict Rule

If the official docs and the existing codebase disagree:
- surface the conflict explicitly
- explain the tradeoff
- ask which direction should win when the choice is architectural rather than mechanical
