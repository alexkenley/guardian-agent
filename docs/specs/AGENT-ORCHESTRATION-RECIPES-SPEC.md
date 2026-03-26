# Agent Orchestration Recipes Spec

**Status:** Implemented baseline  
**Primary files:** `src/agent/recipes.ts`, `src/agent/recipes.test.ts`, `src/agent/orchestration.ts`, `src/agent/conditional.ts`

## Goal

Provide first-class reusable multi-agent compositions without creating a second automation runtime or bypassing Guardian’s runtime controls.

Recipes are a developer-facing orchestration layer. They sit beside the automation framework, not in place of it.

## Implemented Recipes

- `planner -> executor -> validator`
- `researcher -> writer -> reviewer`
- `research -> draft -> verify`

Each recipe returns an `OrchestrationRecipe` that includes:
- `entryAgent`
- `supportingAgents`
- descriptive metadata for runtime use and documentation

## Design Rules

- Recipes are thin wrappers over existing orchestration primitives.
- Recipe execution still flows through `ctx.dispatch()` and normal runtime dispatch.
- Capability checks, handoff validation, taint handling, approvals, and audit remain runtime-owned.
- Recipes do not create new authority.
- Recipes do not create persisted automation definitions on their own.

## Relationship To The Automation System

Recipes and saved automations solve different problems.

- Saved automations are persisted control-plane objects managed through the Automations page and automation tools.
- Recipes are in-process composition templates for agent developers.

A saved assistant automation may internally rely on agent composition, but that does not change the automation contract:
- top-level routing is still owned by `IntentGateway`
- automation persistence still goes through `automation_save`
- runtime admission and approvals still remain outside the recipe

## Benefits

- Stable role-separated flow templates
- Lower developer overhead for common review/planning/verification chains
- Better testability because workflow shape is explicit
- Cleaner future eval coverage for multi-agent request handling

## Non-Goals

- Peer-to-peer swarm coordination
- Cross-run shared mutable memory
- A separate end-user workflow builder for agent recipes
- Bypassing Guardian runtime controls

## Current Boundaries

- Recipes are not a standalone end-user authoring surface.
- Safety still depends on the agents selected and the handoff contracts declared.
- Recipes do not automatically narrow capabilities beyond what the caller configures.

## Verification

- `src/agent/recipes.test.ts`
