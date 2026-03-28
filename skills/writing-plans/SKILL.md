---
name: writing-plans
description: Use when the user asks for an implementation plan or when a coding task is large enough that it should be decomposed before editing.
---

# Writing Plans

Produce a plan that a zero-context engineer could execute without guessing.

Use this skill when the user asked for a plan, or when the work is large, risky, or multi-stage enough that implementation should be decomposed first. Do not force a plan for every trivial change.

## Planning Standard

The plan should include:

- the goal and scope
- explicit acceptance gates
- the existing checks to reuse before inventing new ones
- the files or subsystems likely to change
- ordered tasks with narrow outcomes
- verification for each major step, including broader proof where it matters
- docs, migration, or rollout follow-ups when relevant

For any non-trivial plan, include these section labels explicitly in the written output:

- `Acceptance Gates`
- `Existing Checks To Reuse`

If you do not yet know the exact repo checks, still include `Existing Checks To Reuse` and say what must be inspected or reused before inventing narrower coverage.
Do not block the first draft plan on repo inspection or tool use just to discover those checks.

## Task Granularity

Prefer tasks that are small enough to execute and verify independently.

Good task shape:

- add or update one focused test
- implement one bounded behavior
- run the relevant verification
- update the affected docs or configuration if needed

## Acceptance Gates

Every non-trivial plan should name the concrete conditions that must be true before the work can be called done.

Good acceptance gates are observable and specific:

- the archive view renders completed routines
- existing dashboard flows still work
- the persisted data shape stays backward-compatible

Bad acceptance gates are vague:

- works well
- code is cleaned up
- tests pass

## Existing Checks First

Prefer the strongest existing failing or high-fidelity check before inventing a narrower new test.

Examples:

- reuse the existing integration harness before adding a tiny unit test that proves less
- reuse the real regression or reproduction path before adding a mock-only assertion
- call out when a new narrow test is still needed, but do not let it replace the stronger proof surface

## Plan Format

Use a concise structure like:

```md
# <Feature> Implementation Plan

## Goal

## Constraints

## Acceptance Gates

## Existing Checks To Reuse

## Files / Areas Affected

## Tasks
### Task 1: ...
- files:
- change:
- acceptance gates:
- verification:

### Task 2: ...
```

Do not rename or omit `Acceptance Gates` or `Existing Checks To Reuse` for broad or multi-step work.

If repo-specific checks are still unknown, write something like:

- `Existing Checks To Reuse`
- inspect the current repo tests, harnesses, and reproduction paths before adding narrower new tests

Save the plan under `docs/plans/` with a dated filename when the user wants a durable artifact.

Use `templates/implementation-plan.md` when you want a durable starting structure instead of drafting the outline from scratch.

## Rules

- Prefer exact file paths when you know them.
- Prefer explicit verification commands over vague "test it" language.
- Prefer naming the real proof surface, not only the smallest convenient test.
- Keep tasks ordered so each one leaves the repo in a coherent state.
- Call out assumptions and open questions instead of hiding them in the task list.

## Gotchas

- Do not collapse multiple risky changes into one oversized task.
- Do not omit acceptance gates for broad, risky, or multi-file work.
- Do not omit the `Existing Checks To Reuse` section, even when you need to say that the checks must be identified first.
- Do not replace a stronger existing check with a weaker new one just because it is easier to run.
- Do not omit verification, rollout, or migration steps when they materially affect delivery.
- Do not write a generic plan when the files, subsystems, or constraints are already known.
