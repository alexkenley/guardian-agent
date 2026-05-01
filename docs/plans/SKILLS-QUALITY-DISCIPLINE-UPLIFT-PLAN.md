# Skills Quality and Discipline Uplift Plan

**Status:** Draft
**Date:** 2026-04-04
**Origin:** Follow-on plan from `docs/archive/plans/SKILLS-PROGRESSIVE-DISCLOSURE-UPLIFT-PLAN.md`
**Primary specs impacted:** `docs/design/SKILLS-DESIGN.md`

---

## Goal

Uplift the quality, strictness, and structure of our agent skills based on the `addyosmani/agent-skills` repository. The goal is to move our skills from being generic "guidance" documents to highly structured, rigorous workflows that enforce production-grade software engineering discipline.

This uplift focuses on **content and strictness**, rather than the underlying technical loading mechanism (which was addressed in the Progressive Disclosure uplift).

---

## Core Problems to Solve

### 1. Weak Skill Anatomy
Our current `SKILL.md` format is too loose. It suggests having a "Gotchas" section but lacks structural mechanisms to prevent LLM rationalization or corner-cutting. We need to enforce a stricter anatomy that demands proof.

### 2. Lack of Core SDLC Discipline
While we have skills for personal productivity and security, our core coding skills (like `systematic-debugging`) are too generic. We are missing structured workflows for defining specs, planning tasks, implementing incrementally, simplifying code, and safely deprecating features.

### 3. Missing Workflow Triggers
We lack a streamlined way for the user to trigger these specific SDLC workflows quickly. We have Quick Actions, but they need to be mapped to these new, rigorous skills.

---

## Executive Recommendation

### What is justified now

1.  **Standardize the `SKILL.md` Anatomy:** Mandate explicit "Anti-Rationalization" tables, "Red Flags" lists, and hard "Verification" checklists in all process/domain skills.
2.  **Port Missing High-Value Skills:** Implement `incremental-implementation`, `code-simplification`, `deprecation-and-migration`, `spec-driven-development`, and `planning-and-task-breakdown`.
3.  **Integrate Specialist Personas:** Inject persona definitions (e.g., Senior Staff Engineer for reviews) directly into the `SKILL.md` files of relevant skills (like `receiving-code-review`) to set a higher standard of scrutiny.
4.  **Map SDLC to Quick Actions:** Create Quick Actions (e.g., `/spec`, `/plan`, `/build`, `/test`, `/review`) that explicitly activate the corresponding high-discipline skills.

### What is not justified now

*   Porting the entire `agent-skills` repository verbatim. We only need the skills that fit our agent's current capabilities and missing areas.
*   Creating separate "Agent Personas" as distinct routing targets. Personas should be context injected via the skill, not a separate agent in the orchestrator.

---

## Detailed Implementation Plan

### Phase 1: Skill Anatomy Standardization
**Goal:** Upgrade the structure of existing skills.

1.  Update `docs/design/SKILLS-DESIGN.md` to define the new mandatory anatomy for `SKILL.md` files:
    *   **Overview/When to Use:** Standard descriptive frontmatter.
    *   **Process:** Step-by-step workflow.
    *   **Common Rationalizations (Anti-Rationalization Table):** A markdown table mapping common LLM excuses (e.g., "I'll test it later") to reality ("Bugs compound. Test now.").
    *   **Red Flags:** Bulleted list of anti-patterns (e.g., "Wrote 100+ lines without testing").
    *   **Verification:** A mandatory checklist of evidence required before the skill is considered complete.
2.  Refactor `skills/coding-workspace/SKILL.md` and `skills/systematic-debugging/SKILL.md` to use this new anatomy.

### Phase 2: Port High-Value SDLC Skills
**Goal:** Introduce rigorous engineering workflows.

Create the following new skills in the `skills/` directory, adhering to the new anatomy:
1.  `spec-driven-development`: Writing a PRD before code.
2.  `planning-and-task-breakdown`: Decomposing specs into verifiable tasks.
3.  `incremental-implementation`: The core discipline of thin vertical slices (Implement -> Test -> Verify -> Commit).
4.  `code-simplification`: Rules for reducing complexity without changing behavior (Chesterton's Fence).
5.  `deprecation-and-migration`: Safe removal and migration of zombie code.

### Phase 3: Specialist Persona Injection
**Goal:** Elevate the standard of review and security tasks.

1.  Update `skills/receiving-code-review/SKILL.md` to adopt a "Senior Staff Engineer" persona perspective.
2.  Update `skills/security-triage/SKILL.md` to adopt a "Security Engineer / Auditor" persona perspective.
3.  Update `skills/test-driven-development/SKILL.md` to adopt a "QA Specialist" persona perspective.

### Phase 4: SDLC Quick Actions
**Goal:** Provide fast, triggerable workflows for the user.

Update `src/quick-actions.ts` to include the following SDLC commands, mapping them to the newly created skills:
*   `/spec` -> triggers `spec-driven-development`
*   `/plan` -> triggers `planning-and-task-breakdown`
*   `/build` -> triggers `incremental-implementation` + `test-driven-development`
*   `/review` -> triggers `receiving-code-review`
*   `/code-simplify` -> triggers `code-simplification`

---

## Verification Expectations

*   **Review Skill Anatomy:** Ensure the newly ported and refactored skills contain the Anti-Rationalization, Red Flags, and Verification sections.
*   **Quick Action Tests:** Verify that executing `/build` correctly resolves and loads the `incremental-implementation` skill context in the prompt via `src/skills/resolver.test.ts` or similar unit tests.
*   **Prompt Footprint:** Ensure that injecting these denser L2 instructions respects the token limits established in the Progressive Disclosure uplift.
