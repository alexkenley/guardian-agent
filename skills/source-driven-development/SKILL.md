---
name: source-driven-development
description: Use when implementing or reviewing framework-specific code that should be verified against current official docs, versioned guidance, or source-cited examples rather than memory.
---

# Source-Driven Development

## Overview / When to Use

Ground framework-specific decisions in authoritative sources. Do not rely on model memory for APIs, recommended patterns, deprecations, or migration guidance when the code depends on a specific library or version.

Use this when:
- a request depends on the current best practice for a framework or library
- the user asks for official docs, current guidance, citations, or a documented pattern
- you are writing boilerplate or patterns likely to be copied elsewhere
- the repo version matters for the correctness of the implementation

Do not use this for pure logic, file moves, naming changes, or other work that is stable across versions.

## Process

1. Detect the stack and exact version from the repo before making framework-specific claims.
   - Read `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or the equivalent dependency source.
   - State the version you found when it affects the answer.
2. Fetch the narrow official source for the exact feature or API.
   - Prefer official docs, official migration guides, official changelogs, MDN, or runtime compatibility sources.
   - Fetch the specific page for the feature, not the whole documentation site.
3. Compare the docs with the current repo conventions before editing.
   - If the docs and the codebase disagree, surface the conflict instead of silently choosing one.
   - If the version is ambiguous, stop and clarify before writing the pattern.
4. Implement only what you can verify.
   - Follow the documented API shape and recommended pattern.
   - If the docs do not support the pattern, label it `UNVERIFIED` instead of guessing.
5. Cite the source for non-obvious framework decisions.
   - Include the exact URL in the response.
   - Prefer deep links or anchors when available.
6. Verify the real proof surface after the change.
   - Run the strongest relevant repo checks, not just the smallest local assertion.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I know this API already." | Framework memory goes stale. One signature or lifecycle change is enough to make the implementation wrong. |
| "Docs lookup is overkill for a small change." | Small framework mistakes become copy-paste templates. They are cheap to prevent and expensive to unwind later. |
| "I'll just hedge and say it might be outdated." | Hedging is not verification. Either cite the official source or mark the pattern unverified. |
| "The repo already does it this way, so I'll follow that." | Existing code can be outdated. Compare the repo pattern with the current official guidance before reinforcing it. |

## Red Flags

- Writing framework-specific code before reading the dependency version
- Citing blogs, tutorials, Stack Overflow, or memory as the primary source
- Using "I think" or "I believe" for an API that could be checked
- Fetching a whole docs site when only one page is needed
- Delivering a version-sensitive change without a source URL
- Silently ignoring a conflict between the docs and the existing codebase

## Verification

- [ ] The relevant framework or library version was identified from the repo or explicitly confirmed.
- [ ] The implementation was checked against a narrow official source for that feature.
- [ ] Non-trivial framework decisions are accompanied by a source URL in the response.
- [ ] Any unresolved or unsupported pattern is explicitly marked `UNVERIFIED`.
- [ ] The real proof surface for the repo change was run after the implementation.

## Supporting References

- Read [references/source-verification-checklist.md](./references/source-verification-checklist.md) when you need the source hierarchy, citation rules, or a compact version-detection checklist.

## Related Skills

- Use `coding-workspace` to stay anchored to the active repo while gathering sources.
- Use `web-research` when you need disciplined public-web lookup to fetch the authoritative source pages.
