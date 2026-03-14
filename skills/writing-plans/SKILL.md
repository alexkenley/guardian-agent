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
- the files or subsystems likely to change
- ordered tasks with narrow outcomes
- verification for each major step
- docs, migration, or rollout follow-ups when relevant

## Task Granularity

Prefer tasks that are small enough to execute and verify independently.

Good task shape:

- add or update one focused test
- implement one bounded behavior
- run the relevant verification
- update the affected docs or configuration if needed

## Plan Format

Use a concise structure like:

```md
# <Feature> Implementation Plan

## Goal

## Constraints

## Files / Areas Affected

## Tasks
### Task 1: ...
- files:
- change:
- verification:

### Task 2: ...
```

Save the plan under `docs/plans/` with a dated filename when the user wants a durable artifact.

## Rules

- Prefer exact file paths when you know them.
- Prefer explicit verification commands over vague "test it" language.
- Keep tasks ordered so each one leaves the repo in a coherent state.
- Call out assumptions and open questions instead of hiding them in the task list.
