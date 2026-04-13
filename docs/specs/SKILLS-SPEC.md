# Native Skills Specification

**Status:** Implemented progressive disclosure with trigger-aware routing, runtime-owned drilldown, and prompt diagnostics
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
  "artifactReferences": [
    { "slug": "incident-runbook-style", "scope": "global" }
  ],
  "requiredCapabilities": ["network_access"],
  "risk": "informational"
}
```

### Key Fields

- `role` indicates whether the skill is primarily a `process` skill or a `domain` skill.
- `appliesTo` controls where the skill may be considered.
- `triggers` controls automatic selection.
- `tools` declares tool dependencies for planning and validation.
- `artifactReferences` declares reviewed memory/wiki pages that may be surfaced as provenance-aware supporting context for that skill.
- `requiredCapabilities` documents minimum permission expectations.
- `risk` is `informational` or `operational`.

---

## Runtime Architecture

### Components

- `SkillRegistry` - loads manifests and bundle metadata from configured roots
- `SkillResolver` - selects relevant skills for a request
- `src/skills/prompt.ts` - builds compact catalogs plus bounded runtime-owned L2/L3 drilldown material
- prompt composition in `src/chat-agent.ts` / `src/worker/worker-session.ts` - injects the compact catalog plus bounded drilldown sections into the assembled system prompt

### Dispatch Flow

1. Runtime receives a user message or a scheduled task (tool, playbook, or assistant turn).
2. `SkillResolver` ranks candidate skills using explicit enablement, trigger matches, trigger-oriented descriptions, explicit skill mentions, agent, channel, request type, and structured runtime signals from the Intent Gateway, pending-action state, and continuity summaries.
3. Selected skills are exposed to the model as one compact canonical catalog: skill name, description, role, and `SKILL.md` path.
4. The runtime may then inject bounded L2 `SKILL.md` excerpts for at most a small number of winning skills, preferring one `process` skill and one `domain` skill when both are relevant.
5. The runtime may inject bounded L3 bundle resources only when the request or route justifies them. Request-local cache reuse keeps repeated reads stable inside the same request.
6. If the skill declares reviewed `artifactReferences`, the runtime may inject bounded operator-curated or canonical wiki content for those pages, while preserving provenance and excluding inactive/stale pages.
7. If the model decides to act, it still must call built-in tools or MCP tools through `ToolExecutor`.

### Prompt Discipline

Shared prompt/context contract:
- `docs/specs/CONTEXT-ASSEMBLY-SPEC.md`

- Default to metadata catalog injection, not full `SKILL.md` body injection.
- Descriptions should be written for triggerability, not marketing copy; the resolver and prompt both rely on them.
- The runtime owns ordinary progressive disclosure for active skills. The model still sees the compact catalog, but ordinary L2/L3 loading no longer depends primarily on raw bundle-path `fs_read`.
- Default bounded caps are small: up to two L2 instruction loads, up to two L3 resource loads, and char caps per loaded artifact.
- If both a process skill and a domain skill are relevant, the process skill should normally be loaded first.
- Prefer first-party skills over reviewed imports when both cover the same area, unless the user explicitly names the imported product or skill.
- Referenced files should be loaded only when needed and should stay bounded to registered bundle contents.
- Reviewed `artifactReferences` are optional supporting context only. They do not turn memory/wiki pages into executable skill bodies.
- Record active skill IDs in response metadata for debuggability.

### Mandatory SKILL.md Anatomy

Every process or domain `SKILL.md` file must adhere to this rigorous structure to enforce production-grade discipline and prevent LLM corner-cutting:

1. **Overview / When to Use**: Standard descriptive frontmatter.
2. **Process**: Step-by-step workflow the agent must follow.
3. **Common Rationalizations**: A markdown table mapping common LLM excuses (e.g., "I'll add the tests later") to reality ("Bugs compound. Test each slice.").
4. **Red Flags**: A bulleted list of anti-patterns (e.g., "Wrote 100+ lines without running tests").
5. **Verification**: A mandatory checklist of concrete evidence required before the skill is considered complete (e.g., tests passing, build succeeding). "Seems right" is never sufficient.

### Authoring Guidance

- Write the manifest description as a trigger sentence that says when to use the skill.
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
- runtime-owned skill prompt material loading
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
- Resolver ranking also consumes structured runtime signals from the Intent Gateway, pending-action state, and continuity summaries.
- Reviewed imports are available but intentionally harder to trigger than first-party skills unless the user explicitly names them or the request has multiple strong matching signals.
- Active skills are injected as a catalog with descriptions, optional roles, and `SKILL.md` locations.
- The runtime also injects bounded L2 skill instructions and bounded L3 bundle resources for the most relevant active skills instead of relying primarily on raw bundle-path reads.
- Request-local skill prompt cache reuse avoids redundant skill bundle rereads during one request.
- Reviewed `artifactReferences` can surface operator-curated or canonical wiki pages as provenance-aware supporting context when explicitly declared by the skill and still current.
- Chat responses include `metadata.activeSkills` when one or more skills were applied.
- First-party skill bundles can include reusable `references/`, `templates/`, `scripts/`, and `assets/`.
- Prompt assembly diagnostics and the run timeline expose which skill instructions, resources, cache hits, and artifact-backed references influenced a request.
- Analytics events are emitted for skill resolution, prompt injection, runtime-owned prompt material loading, direct bundle reads, and tool execution while skills are active.
- Skills can be inspected and toggled through CLI and web API surfaces.

### Bundled Skills

The repository currently includes bundled local skills under `skills/`, including:

- `automation-builder`
- `cloud-operations`
- `code-review`
- `context-engineering`
- `coding-workspace`
- `file-workflows`
- `google-workspace`
- `incremental-implementation`
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
- `source-driven-development`
- `browser-session-defense`

This bundled suite is intentionally mixed:

- personal assistant skills for email, calendar, files, web research, memory, and document search
- coding discipline skills for repo grounding, context shaping, documentation-grounded implementation, review, debugging, and verification
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

### Skills vs Agent Roles

Skills and agent roles are intentionally separate:

- orchestration or routing decides *which* agent runs, for example planner, researcher, writer, reviewer, or validator
- skills shape *how* that agent plans, what references it reads, and what procedural guidance it follows
- a skill does not create a researcher/reviewer agent, add new tool authority, or bypass Guardian controls

In practice, a researcher agent may activate a research-oriented skill for one request, but execution authority still comes from the runtime, tool registry, approvals, and sandboxing.

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
