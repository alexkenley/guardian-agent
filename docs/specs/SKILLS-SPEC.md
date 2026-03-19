# Native Skills Specification

**Status:** Implemented foundation with trigger-aware routing and skill telemetry
**Current Files:** `src/skills/registry.ts`, `src/skills/resolver.ts`, `src/skills/prompt.ts`, `src/skills/types.ts`
**Depends on:** ToolExecutor, MCP Client, Guardian prompt composition, channel config surfaces

---

## Overview

GuardianAgent includes a native **skills layer** for reusable procedural knowledge, curated references, templates, small helper scripts, and tool-usage guidance.

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
    SKILL.md
    skill.json
    references/
      escalation-matrix.md
    templates/
      triage-summary.md
    scripts/
      verify-incident.sh
    assets/
      incident-diagram.png
    examples/
      example-input.md
```

### Required Files

- `SKILL.md` - human/model-readable primary instructions

### Supported Metadata Formats

- Guardian native: `skill.json` + `SKILL.md`
- Anthropic-compatible import path: YAML frontmatter in `SKILL.md` when `skill.json` is absent

Guardian-native manifests remain the richer format. Frontmatter-only skills are intended for reviewed third-party imports and use synthesized defaults for fields that are not present in frontmatter.

### Optional Files

- `references/` - reference material for selective loading
- `templates/` - reusable output/input templates
- `scripts/` - helper entrypoints the model can run instead of reconstructing boilerplate
- `assets/` - non-markdown artifacts such as diagrams, fixtures, or sample outputs
- `examples/` - example inputs and outputs

Bundle contents are treated as reviewed static artifacts. Persistent runtime data should live in app-managed storage, not inside the skill bundle directory.

---

## Manifest Schema

```json
{
  "id": "incident-triage",
  "name": "Incident Triage",
  "version": "0.1.0",
  "description": "Guide for triaging and summarizing security incidents.",
  "role": "domain",
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

- `role` indicates whether the skill is primarily a `process` skill or a `domain` skill.
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
- prompt composition in `src/index.ts` - injects an active-skill catalog into the system prompt

### Dispatch Flow

1. Runtime receives a user message or a scheduled task (tool, playbook, or assistant turn).
2. `SkillResolver` ranks candidate skills using explicit enablement, trigger matches, trigger-oriented descriptions, explicit skill mentions, agent, channel, and request type.
3. Selected skills are exposed to the model as a compact catalog: skill name, description, role, and `SKILL.md` path.
4. The prompt builder instructs the model to read relevant `SKILL.md` files with `fs_read` before acting.
5. If the model decides to act, it still must call built-in tools or MCP tools through `ToolExecutor`.

### Prompt Discipline

- Default to metadata catalog injection, not full `SKILL.md` body injection.
- Descriptions should be written for triggerability, not marketing copy; the resolver and prompt both rely on them.
- The model should read relevant skills before replying, asking clarifying questions, or calling tools.
- The model should read at most two `SKILL.md` files up front: one `process` skill and one `domain` skill.
- If both a process skill and a domain skill are relevant, the process skill should be read first.
- Prefer first-party skills over reviewed imports when both cover the same area, unless the user explicitly names the imported product or skill.
- Referenced files should be loaded only when needed.
- Record active skill IDs in response metadata for debuggability.

### Authoring Guidance

- Write the manifest description as a trigger sentence that says when to use the skill.
- Keep a `Gotchas` section in `SKILL.md` for repeated failure modes and update it over time.
- Use progressive disclosure: put dense references, templates, scripts, and assets in subfolders instead of overloading the top-level instructions.
- Add templates when the output shape matters, and scripts when deterministic verification or setup is better expressed as code.

---

## Security Model

Skills are treated as **untrusted advisory content** until reviewed.

### Hard Rules

- A skill cannot bypass Guardian or ToolExecutor.
- A skill cannot directly expand an agent's capabilities.
- A skill cannot create new tools at runtime.
- A skill cannot silently install software or mutate configuration.
- A skill should not rely on mutable state inside its own bundle directory.

### Review Model

- Skills are loaded only from configured local roots by default.
- Third-party skills must be imported into a reviewed local directory before activation.
- Imported or adapted third-party skills must preserve upstream license and notice text in `THIRD_PARTY_NOTICES.md`.
- Any future `installSteps` or mutating setup flow must require explicit human approval.

### Audit

Current implementation records active skill IDs in chat response metadata when skills were selected and emits analytics events for:

- skill resolution
- prompt injection of resolved skills
- direct reads of skill bundle files via `fs_read`
- tool execution while one or more skills are active

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
- Both Guardian-native manifests and reviewed frontmatter-only imports are supported.
- Manifest-disabled reviewed imports still load into the registry for inspection and explicit enablement later.
- Chat requests can auto-activate matching skills using keywords, explicit skill mentions, and trigger-oriented description terms.
- Resolver ranking prefers more specific matches and uses normalized phrase boundaries to avoid obvious substring false positives.
- Reviewed imports are available but intentionally harder to trigger than first-party skills unless the user explicitly names them or the request has multiple strong matching signals.
- Active skills are injected as a catalog with descriptions, optional roles, and `SKILL.md` locations.
- Chat responses include `metadata.activeSkills` when one or more skills were applied.
- First-party skill bundles can include reusable `references/`, `templates/`, `scripts/`, and `assets/`.
- Analytics events are emitted for skill resolution, prompt injection, direct bundle reads, and tool execution while skills are active.
- Skills can be inspected and toggled through CLI and web API surfaces.

### Bundled Skills

The repository currently includes bundled local skills under `skills/`, including:

- `automation-builder`
- `cloud-operations`
- `file-workflows`
- `google-workspace`
- `knowledge-search`
- `preferences-memory`
- `receiving-code-review`
- `network-recon`
- `outreach-campaigns`
- `security-triage`
- `system-operations`
- `systematic-debugging`
- `test-driven-development`
- `threat-intel`
- `mcp-builder`
- `skill-creator`
- `verification-before-completion`
- `webapp-testing`
- `web-research`
- `writing-plans`
- `host-firewall-defense`
- `native-av-management`
- `security-mode-escalation`
- `security-alert-hygiene`
- `security-response-automation`
- `browser-session-defense`

This bundled suite is intentionally mixed:

- personal assistant skills for email, calendar, files, web research, memory, and document search
- IT operations skills for cloud, host, network, and automation work
- security skills for triage, threat intel, monitoring interpretation, and disciplined investigation

### Chat Behavior

Internally, the prompt context receives an active-skill catalog. Response metadata can include:

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
- Guardian-native manifest loading plus reviewed frontmatter-compatible import support
- Read-only bundle loading
- Prompt catalog injection with process/domain role hints and read-before-action guidance
- Trigger-aware resolution and ranking with explicit mention handling, description fallback, and specificity tie-breaking
- Bundle-aware telemetry for resolved skills, prompt injection, direct skill reads, and tool use while skills are active
- CLI and web API management surfaces for skill inspection and runtime toggling

### Next

- richer dashboards and reporting on skill usage/under-triggering
- reviewed import workflow
- optional install metadata with approval gating

---

## Open Questions

- Whether skills should be selectable explicitly in chat, for example `use skill incident-triage`.
- Whether a skill can declare preferred output schemas for reuse in quick actions.
- How much skill context to persist in conversation history versus recompute per request.
