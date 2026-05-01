# Coding Workflow Uplifts Implementation Plan

**Date:** 2026-04-12  
**Status:** Draft  
**Primary references:** [Coding Workspace Spec](../design/CODING-WORKSPACE-DESIGN.md), [Coding Assistant Curated Uplifts Implementation Plan](./CODING-ASSISTANT-CURATED-UPLIFTS-IMPLEMENTATION-PLAN.md), [Agent Orchestration Recipes Spec](../archive/design/AGENT-ORCHESTRATION-RECIPES-DESIGN.md)

---

## Goal

Strengthen Guardian’s coding product as a **coding workflow** layer built on the existing backend-owned coding-session architecture.

This plan deliberately does **not** propose a new coding runtime. The substrate is already correct:

- Intent Gateway routing
- backend-owned coding sessions
- shared approvals and continuity
- repo-grounded context assembly

The uplift is about workflow intelligence, not about replacing the current session model.

---

## Core Decisions

### 1. Product framing should be coding workflow, not a new workspace architecture

`docs/design/CODING-WORKSPACE-DESIGN.md` remains the architectural substrate, but the user-facing uplift should emphasize:

- guided coding workflows
- clearer step progression
- stronger repo-grounded planning and review
- curated recipe-driven execution

### 2. Recipes are the right next abstraction

The existing recipes baseline is the correct expansion point for managed-cloud coding quality.

Use recipes to improve:

- planning
- implementation
- review
- verification
- bug-fix loops

Do **not** jump to:

- a generic subagent platform
- unconstrained workflow trees
- separate per-workflow persistence models

### 3. Keep one primary mutable coding session

Multi-workspace reasoning is useful, but implicit writes must still target one primary coding session per lane.

This plan should build on that rule, not weaken it.

### 4. Isolation is an explicit lane, not the default

If a coding operation needs stronger sandboxing or remote execution, that should be a clearly selected workflow step or delegated lane.

It should not silently replace the normal local coding path.

---

## Product Direction

Guardian should feel like:

- a repo-grounded coding operator
- a workflow-aware reviewer and implementer
- a system that can choose the right coding recipe and verification sequence

Guardian should not feel like:

- a thin terminal wrapper
- a vague generic chat bot inside a repo
- a sprawling autonomous coding swarm

---

## Scope

### In scope

- recipe-driven coding workflow packs
- stronger managed-cloud coding intelligence
- workflow progress surfaces in chat and Code
- verification-first completion discipline
- optional isolated execution hooks for explicit high-risk steps

### Out of scope

- replacing backend-owned coding sessions
- redesigning the Code page from scratch
- generic multi-agent trees
- silent multi-repo mutation
- unbounded background coding work

---

## Recommended Workflow Model

Each major coding workflow should compile into a bounded recipe with explicit stages:

1. inspect
2. plan
3. implement
4. verify
5. summarize

Recommended first-party workflow types:

- `Implementation`
- `Bug Fix`
- `Code Review`
- `Refactor`
- `Test Repair`
- `Dependency / Upgrade Review`
- `Specification To Plan`

Each workflow should expose:

- current stage
- evidence read so far
- files changed
- verification status
- blocked reason when applicable

---

## Recipe Direction

### A. Curated recipe registry

Add a coding-focused recipe registry on top of the current recipes baseline.

Recommended examples:

- `inspect -> plan -> implement -> verify`
- `inspect -> review -> validate`
- `inspect -> patch -> run tests -> summarize`
- `inspect -> compare -> migrate -> verify`

### B. Managed-cloud recipe bias

When Guardian leaves the local tier for coding, it should prefer recipe-aware managed-cloud roles rather than generic open-ended prompting.

This is where the “recipes increase the intelligence of the managed cloud coding model” work belongs.

### C. No second orchestration runtime

Recipes remain:

- thin wrappers over existing orchestration primitives
- runtime-owned for approvals, audit, and handoff control
- attached to the active coding session

---

## UX Recommendations

### Code page

Add lightweight workflow affordances, not a second dashboard.

Recommended additions:

- workflow selector
- active stage indicator
- verification state
- recipe-specific notices such as `repo evidence missing`, `tests still failing`, or `verification incomplete`

### General chat and CLI

Show the same workflow state in a thinner form:

- selected workflow
- current stage
- next expected action
- completion blocked until verification when applicable

### Naming

Prefer `workflow` in product copy where it helps explain the experience.

Keep `Coding Workspace` as the architectural/session concept underneath.

---

## Runtime Changes

### Phase 1: Recipe Pack Foundation

Deliver:

- coding workflow recipe registry
- recipe metadata attached to coding-session runs
- managed-cloud role selection guidance for recipe-backed turns

Exit criteria:

- major coding requests can be mapped to a bounded first-party workflow
- workflow identity is visible in run metadata

### Phase 2: Workflow UX And Progress

Deliver:

- Code page workflow indicator
- chat and CLI structural workflow progress updates
- blocked-state rendering for missing repo evidence or incomplete verification

Exit criteria:

- the operator can tell where a coding run is in the workflow without reading raw tool logs

### Phase 3: Verification And Completion Discipline

Deliver:

- workflow-aware verification requirements
- recipe-specific completion gates
- clearer failure modes for partial implementation without proof

Exit criteria:

- Guardian does not report coding work complete when the selected workflow still lacks its required proof

### Phase 4: Optional Isolation Hooks

Deliver:

- ability for selected workflow steps to request isolated execution explicitly
- integration point for remote sandbox execution

Exit criteria:

- isolation can be applied when required without changing the normal local coding path

---

## Recommended Initial Workflow Types

### Implementation

- inspect repo evidence
- produce bounded plan
- edit targeted files
- run relevant verification
- summarize files changed and proof

### Bug Fix

- inspect failure evidence
- identify likely owner files
- patch narrowly
- rerun the relevant failing check first
- expand verification only after the local failure is green

### Code Review

- inspect diff or files
- identify findings first
- cite repo evidence
- preserve a review-first answer structure

### Specification To Plan

- inspect referenced specs and local code
- identify existing implementation anchors
- output an evidence-backed implementation plan

---

## File-Level Impact

Primary areas:

- `src/agent/recipes.ts`
- `src/agent/orchestration.ts`
- `src/runtime/code-sessions.ts`
- `src/runtime/message-router.ts`
- `src/index.ts`
- `src/worker/worker-llm-loop.ts`
- `web/public/js/pages/code.js`
- `web/public/js/chat-panel.js`
- `src/channels/cli.ts`
- `scripts/test-coding-assistant.mjs`

---

## Acceptance Gates

- coding uplift work reuses backend-owned coding sessions instead of bypassing them
- major coding requests can run through a named bounded workflow
- workflow progress is visible across Code, chat, and CLI
- verification remains structural, not optional
- isolation remains an explicit lane rather than a hidden fallback
