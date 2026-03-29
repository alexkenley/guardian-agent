# Notion Workspace Integration — Implementation Plan

**Status:** Draft  
**Date:** 2026-03-29  
**Primary context:** [docs/specs/CLOUD-HOSTING-INTEGRATION-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CLOUD-HOSTING-INTEGRATION-SPEC.md), [docs/specs/SKILLS-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/SKILLS-SPEC.md), [docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md), [skills/notion/skill.json](/mnt/s/Development/GuardianAgent/skills/notion/skill.json), [skills/notion/SKILL.md](/mnt/s/Development/GuardianAgent/skills/notion/SKILL.md)

## Objective

Add Notion as a first-class Guardian integration in a way that:

1. fits the existing native workspace-integration model
2. does not overload the current `cloud` and hosting stack
3. activates the existing Notion skill through managed-provider readiness
4. supports high-value page, markdown, block, and data-source workflows safely
5. extends the Intent Gateway and clarification flow without introducing a new top-level route

## Current Constraints

The current repo shape is clear but opinionated:

- `assistant.tools.cloud` means infrastructure and hosting providers, not general SaaS integrations
- native workspace integrations already exist for Google Workspace and Microsoft 365
- provider-gated skills rely on `enabledManagedProviders`
- the MCP managed-provider path is narrow and currently centered on `gws`
- the Intent Gateway only has provider-specific handling for email
- direct workspace preroutes are Google-centric today

Important practical implications:

- Notion should not be implemented under `assistant.tools.cloud`
- Notion should not be the first use of a broad generic MCP-managed-provider system
- Notion can reuse the existing skills gating model if the runtime exposes `notion` as an enabled managed provider

## Architectural Decision

### Treat Notion as a workspace/content integration, not a cloud integration

In Guardian terms, Notion belongs beside Google Workspace and Microsoft 365.

Recommended classification:

- routing class: `workspace_task`
- tool category: `workspace`
- provider readiness id: `notion`
- configuration area: `assistant.tools.notion`
- product placement: Integrations / Connections, not Cloud & Hosting

### Implement Notion natively in v1

Do **not** build the first version as `assistant.tools.mcp.managedProviders.notion`.

Reasons:

- the repo already prefers native service integrations for major workspace providers
- `buildManagedMCPServers(...)` is effectively empty today
- config validation and web types only understand the narrow current managed-provider surface
- Notion's REST API is straightforward enough for a direct client

Recommended module shape:

- `src/notion/index.ts`
- `src/notion/notion-service.ts`
- `src/notion/types.ts`
- optional `src/notion/notion-auth.ts` if auth modes expand later

### Use internal integration tokens first

The first release should target Notion internal integrations with bearer tokens stored through Guardian credential refs.

Why first:

- matches Guardian's current owner-operated deployment model
- avoids OAuth UI and callback complexity in the first slice
- is enough for single-workspace usage, which is the most likely initial Guardian scenario

Public OAuth support should be treated as Phase 2, not part of the initial rollout.

### Keep the top-level intent route unchanged

Notion does **not** need a new top-level Intent Gateway route.

It fits the existing:

- `workspace_task` for page, data-source, search, and content work
- `email_task` only for direct mailbox work, which Notion does not affect

The change needed is provider disambiguation inside the workspace route, not route proliferation.

## Recommended V1 Product Shape

### Config model

Add a native Notion config block under `assistant.tools`.

Recommended shape:

```yaml
assistant:
  tools:
    notion:
      enabled: true
      authMode: internal_integration
      credentialRef: notion.api_token
      notionVersion: 2026-03-11
      timeoutMs: 30000
```

Recommended TypeScript direction:

```ts
interface NotionConfig {
  enabled: boolean;
  authMode?: 'internal_integration' | 'public_oauth';
  credentialRef?: string;
  notionVersion?: string;
  timeoutMs?: number;
  apiBaseUrl?: string;
}
```

Notes:

- `credentialRef` should be the normal Guardian secret path
- `notionVersion` should be explicit and centrally pinned
- `apiBaseUrl` should default to `https://api.notion.com` and mainly exist for tests

### Native capability surface

The highest-value first slice is:

1. search pages and data sources
2. retrieve page metadata
3. retrieve page content as markdown
4. update page content as markdown
5. query data sources
6. create pages in a page or data source
7. update page properties

### Preferred tool surface

Use bounded, product-shaped tools rather than raw API passthrough.

Recommended v1 tools:

- `notion_search`
- `notion_page`
- `notion_markdown`
- `notion_data_source`

Optional later tool:

- `notion_blocks`

This is a better fit than exposing a giant raw REST tool because:

- the Notion surface is smaller than Google or Microsoft Graph
- markdown endpoints are a better primary content interface for LLMs than raw block trees
- product-shaped tools make approval copy and policy semantics easier to control

## Workstreams

### WS1 — Integration Foundation And Classification Cleanup

**Files**

- `src/config/types.ts`
- `src/config/loader.ts`
- `src/channels/web-types.ts`
- `src/index.ts`
- `src/tools/types.ts`

**Deliverables**

- add `NotionConfig` to `assistant.tools`
- validate `credentialRef`, `notionVersion`, timeout, and optional base URL
- add runtime readiness tracking for provider id `notion`
- generalize the workspace category label/description so it is no longer Google-specific
- update built-in workspace tool inventory so it reflects the real workspace surface, including Microsoft 365 and Notion

**Important cleanup**

This workstream should also fix current drift in the workspace category metadata while touching the same files.

### WS2 — Native Notion Client And Status Lifecycle

**Files**

- `src/notion/index.ts`
- `src/notion/notion-service.ts`
- `src/notion/types.ts`
- `src/index.ts`
- `src/channels/web.ts`
- `src/channels/web-types.ts`

**Deliverables**

- create a native Notion HTTP client
- send `Authorization: Bearer ...` and pinned `Notion-Version` headers centrally
- add a lightweight readiness probe, preferably against the integration's bot user endpoint
- expose dashboard/web callbacks for:
  - status
  - connect or save token-backed config
  - disconnect
- mark `enabledManagedProviders.add('notion')` when configured and healthy

**Notes**

- v1 should assume bearer-token auth through Guardian secrets
- keep the auth state simple; a full OAuth lifecycle can come later
- centralize pagination, error mapping, and version pinning in the service layer

### WS3 — Notion Tooling And Guardian Policy Integration

**Files**

- `src/tools/executor.ts`
- `src/tools/types.ts`
- `src/reference-guide.ts`
- optional new helper modules under `src/notion/`

**Deliverables**

- register the initial Notion tools:
  - `notion_search`
  - `notion_page`
  - `notion_markdown`
  - `notion_data_source`
- wire read-only vs mutating approval semantics clearly
- map page/content reads and writes through Guardian action checks with explicit policy coverage
- add operator-facing help text and examples

**Behavior goals**

- reads should stay low-friction
- mutating page/content/property writes should follow the normal Guardian approval boundary
- responses should summarize concrete object names, ids, and changed fields rather than dumping raw payloads by default

### WS4 — Intent Gateway And Workspace Provider Clarification

**Files**

- `src/runtime/intent-gateway.ts`
- `src/runtime/direct-intent-routing.ts`
- `src/runtime/pending-clarification-store.ts`
- `src/index.ts`
- `docs/specs/INTENT-GATEWAY-ROUTING-SPEC.md`

**Deliverables**

- add `workspaceProvider?: 'gws' | 'm365' | 'notion'` to gateway entities
- extend the gateway tool schema and prompt examples for Notion requests
- allow `missingFields` to include `workspace_provider`
- add pending clarification kind `workspace_provider`
- add clarification resolution for short follow-ups like:
  - `Use Notion`
  - `Notion`
  - `the Notion workspace`

**Decision**

Do **not** add a new top-level route for Notion.

The route stays `workspace_task`. The new behavior is provider-aware resolution inside that route.

**Direct preroute note**

The current deterministic workspace preroute is Google-centric. That should not block v1.

Recommended v1 behavior:

- rely on the normal tool loop for Notion work after gateway classification
- add direct Notion preroutes only later if the common request patterns justify them

### WS5 — Skills, Prompting, And Documentation Alignment

**Files**

- `skills/notion/skill.json`
- `skills/notion/SKILL.md`
- `docs/specs/SKILLS-SPEC.md`
- `src/prompts/guardian-core.ts`
- `src/reference-guide.ts`

**Deliverables**

- rewrite the Notion skill to be Guardian-native instead of curl-first
- replace manual local token-file instructions with Guardian integration guidance
- assign the new Notion tools in the skill manifest
- update the bundled-skills documentation so it reflects the current repo contents
- add prompt instructions telling Guardian when to prefer Notion tools over browser or filesystem fallbacks

**Content direction**

The Notion skill should teach:

- when to use Notion vs knowledge-search vs local files
- when to prefer markdown reads and writes
- how to work with pages vs data sources
- how to avoid guessing object ids and instead search first

### WS6 — Web UI Integration

**Files**

- `src/channels/web.ts`
- `src/channels/web-types.ts`
- relevant `web/public/js/*` config and integrations surfaces

**Deliverables**

- add Notion status/connect/disconnect API endpoints
- surface Notion in the Integrations / Connections UI beside Google Workspace and Microsoft 365
- show provider readiness in the skills UI
- expose enough operator context to explain whether:
  - Notion is configured
  - Notion is reachable
  - the Notion skill is ready to activate

### WS7 — Tests And Verification

**Files**

- `src/config/loader.test.ts`
- new `src/notion/*.test.ts`
- `src/runtime/intent-gateway.test.ts`
- `src/runtime/direct-intent-routing.test.ts`
- `src/runtime/pending-clarification-store.test.ts`
- `src/tools/executor.test.ts`
- web route tests where applicable

**Acceptance tests**

- Notion config validates correctly with normal credential-ref usage
- provider readiness adds `notion` to `enabledManagedProviders`
- the existing Notion skill becomes selectable only when the provider is ready
- explicit requests such as "search Notion for roadmap notes" classify as `workspace_task` with `workspaceProvider=notion`
- ambiguous workspace requests trigger `workspace_provider` clarification when appropriate
- short correction or clarification turns like `Use Notion` resolve against the pending request
- page markdown reads and writes execute with the expected approval semantics
- failed auth or missing capability responses produce clear operator-facing errors

## Out Of Scope For V1

- public OAuth integration flow
- comments support
- file upload support
- advanced block-tree editing beyond append/read basics
- database view configuration parity with the Notion UI
- full direct-intent deterministic shortcuts for Notion requests

## Delivery Sequence

1. WS1 foundation and workspace-category cleanup
2. WS2 native client and readiness lifecycle
3. WS3 Notion tools with policy integration
4. WS4 Intent Gateway and clarification support
5. WS5 skills and prompt alignment
6. WS6 web UI integration
7. WS7 tests, regression coverage, and docs polish

## Definition Of Done

- Guardian exposes Notion as a first-class native integration under workspace/integrations, not cloud hosting
- Notion readiness sets managed provider id `notion` and activates the bundled Notion skill path
- users can search Notion, read page content as markdown, update markdown content, and query data sources through native tools
- the Intent Gateway can identify explicit Notion workspace requests and clarify ambiguous workspace-provider choices cleanly
- operator UI shows Notion connection health and skill readiness
- docs, prompts, and tests all describe the same product shape

## Follow-On Phase

After v1 is stable, Phase 2 should evaluate:

- public OAuth support
- richer block editing
- comments and mentions
- file uploads
- direct workspace preroute helpers for common Notion commands
