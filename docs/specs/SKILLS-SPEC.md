# Native Skills Specification

**Status:** Implemented foundation
**Current Files:** `src/skills/registry.ts`, `src/skills/resolver.ts`, `src/skills/types.ts`
**Depends on:** ToolExecutor, MCP Client, Guardian prompt composition, channel config surfaces

---

## Overview

GuardianAgent includes a native **skills layer** for reusable procedural knowledge, curated references, templates, and tool-usage guidance.

Skills are **not** a new execution plane. They are a structured knowledge and workflow layer that helps the model decide what to do. Any side effect still flows through the existing ToolExecutor, Guardian admission checks, approvals, audit trail, and OS sandbox.

This design intentionally keeps:

- **Skills** = guidance, templates, and procedural context
- **Tools / MCP** = executable capabilities
- **Guardian** = policy and approval enforcement
- **Sandbox** = hard execution boundary for risky subprocesses

---

## Goals

- Add first-class local skills without depending on third-party registries.
- Allow skills to improve planning, consistency, and domain-specific workflows.
- Keep skills outside the trusted execution boundary.
- Support contextual skill activation per request.
- Surface active skills in response metadata and prompt context.

## Non-Goals

- Skills directly executing shell commands or mutating files.
- Treating skills as a substitute for MCP or built-in tools.
- Auto-running arbitrary install scripts from skill bundles.
- Pulling unreviewed remote skills into production by default.

---

## Skill Model

Each skill is a versioned bundle stored locally under a managed directory such as `skills/<skill-id>/`.

### Bundle Layout

```text
skills/
  incident-triage/
    skill.json
    SKILL.md
    references/
      escalation-matrix.md
    templates/
      triage-summary.md
    examples/
      example-input.md
```

### Required Files

- `skill.json` - machine-readable manifest
- `SKILL.md` - human/model-readable primary instructions

### Optional Files

- `references/` - reference material for selective loading
- `templates/` - reusable output/input templates
- `examples/` - example inputs and outputs

---

## Manifest Schema

```json
{
  "id": "incident-triage",
  "name": "Incident Triage",
  "version": "0.1.0",
  "description": "Guide for triaging and summarizing security incidents.",
  "tags": ["security", "triage"],
  "enabled": true,
  "appliesTo": {
    "agents": ["sentinel", "chat"],
    "channels": ["cli", "web", "telegram"],
    "requestTypes": ["chat", "quick_action"]
  },
  "triggers": {
    "keywords": ["incident", "triage", "alert"],
    "toolCategories": ["intel"],
    "intents": ["security_triage"]
  },
  "tools": ["intel_summary", "intel_findings"],
  "requiredCapabilities": ["network_access"],
  "risk": "informational"
}
```

### Key Fields

- `appliesTo` controls where the skill may be considered.
- `triggers` controls automatic selection.
- `tools` declares tool dependencies for planning and validation.
- `requiredCapabilities` documents minimum permission expectations.
- `risk` is `informational` or `operational`.

---

## Runtime Architecture

### Components

- `SkillRegistry` - loads manifests and bundle metadata from configured roots
- `SkillResolver` - selects relevant skills for a request
- prompt composition in `src/index.ts` - injects compact active-skill summaries into the system prompt

### Dispatch Flow

1. Runtime receives a user message or scheduled task.
2. `SkillResolver` ranks candidate skills using explicit enablement, trigger matches, agent, channel, and request type.
3. Selected skills are reduced to compact summaries by default.
4. The prompt builder injects the active skill summaries into the system/planning context.
5. If the model decides to act, it still must call built-in tools or MCP tools through `ToolExecutor`.

### Prompt Discipline

- Default to summaries, not full `SKILL.md` bodies.
- Only load full references/templates when the task clearly requires them.
- Record active skill IDs in response metadata for debuggability.

---

## Security Model

Skills are treated as **untrusted advisory content** until reviewed.

### Hard Rules

- A skill cannot bypass Guardian or ToolExecutor.
- A skill cannot directly expand an agent's capabilities.
- A skill cannot create new tools at runtime.
- A skill cannot silently install software or mutate configuration.

### Review Model

- Skills are loaded only from configured local roots by default.
- Third-party skills must be imported into a reviewed local directory before activation.
- Any future `installSteps` or mutating setup flow must require explicit human approval.

### Audit

Current implementation records active skill IDs in chat response metadata when skills were selected.

Follow-up work can extend this to richer audit context.

---

## Configuration

Current configuration under `assistant`:

```yaml
assistant:
  skills:
    enabled: true
    roots:
      - ./skills
    autoSelect: true
    maxActivePerRequest: 3
    disabledSkills: []
```

---

## Current Behavior

- Local skill bundles are loaded from configured roots.
- Chat requests can auto-activate matching skills.
- Active skill summaries are injected into the system prompt.
- Chat responses include `metadata.activeSkills` when one or more skills were applied.
- Skills can be inspected and toggled through CLI and web API surfaces.

### Bundled Skills

The repository currently includes bundled local skills under `skills/`, including:

- `google-gmail-assistant`
- `google-calendar-assistant`
- `google-drive-assistant`
- `google-docs-sheets-assistant`
- `security-triage`

### Chat Behavior

Internally, the prompt context receives active-skill summaries. Response metadata can include:

```text
Using skills: incident-triage, gmail-draft-review
```

This metadata is intended for diagnostics and UI surfaces rather than mandatory user-visible prose on every reply.

### Runtime Management Surfaces

- CLI: `/skills`, `/skills show <skillId>`, `/skills enable <skillId>`, `/skills disable <skillId>`
- Web API: `GET /api/skills`, `POST /api/skills`

Skill enable/disable persists back to `assistant.skills.disabledSkills` in `config.yaml`.

---

## Relationship to MCP

Skills complement MCP rather than replacing it.

- Skills explain how and when to use tools.
- MCP exposes tool schemas and executes external actions.
- GuardianAgent should support both simultaneously.

This is especially important for managed providers such as Google Workspace, where the agent benefits from both:

- curated procedural guidance in skills
- strongly typed execution via MCP

---

## Rollout Plan

### Implemented

- Local skill roots
- Read-only bundle loading
- Prompt summary injection
- Basic trigger resolution and ranking
- CLI and web API management surfaces for skill inspection and runtime toggling

### Next

- richer template/reference loading
- reviewed import workflow
- skill provenance audit events
- optional install metadata with approval gating

---

## Open Questions

- Whether skills should be selectable explicitly in chat, for example `use skill incident-triage`.
- Whether a skill can declare preferred output schemas for reuse in quick actions.
- How much skill context to persist in conversation history versus recompute per request.
