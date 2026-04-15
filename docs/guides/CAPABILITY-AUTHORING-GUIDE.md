# Capability Authoring Guide

This guide is the single source of truth for adding new capabilities to Guardian Agent.

Use it when you are adding or changing any of the following:

- a built-in tool
- a skill
- a native integration
- an MCP-backed integration
- a direct intent route
- a dashboard or control-plane surface
- a background maintenance job
- a new durable memory writer

This guide does not replace subsystem specs. It tells you which systems you must consider and which deeper docs to read before you cut code.

## Start Here

Before you write code, answer these questions:

1. What kind of capability is this?
2. Which runtime layer owns it?
3. Does it need direct intent routing, or should it stay inside the normal tool loop?
4. Does it create blocked work, approvals, clarifications, or resume state?
5. Does it need operator configuration or a web surface?
6. Does it create durable state, audit events, or maintenance jobs?
7. What tests and harnesses prove it works?

If you cannot answer those cleanly, stop and resolve the design first.

## Non-Negotiable Architecture Rules

These rules apply to every new capability.

### 1. Intent classification goes through the Intent Gateway

Never add regex, keyword matching, `includes()`, or other ad hoc request classification for normal user intent.

If the capability needs a new direct route:

- update `IntentGatewayRoute` and the tool schema in [`src/runtime/intent/types.ts`](/mnt/s/Development/GuardianAgent/src/runtime/intent/types.ts)
- update `route-classifier.ts` and `normalization.ts` in the `src/runtime/intent/` directory
- update workload hints in `src/runtime/intent/workload-derivation.ts`
- update preferred capability selection in [`src/runtime/intent/capability-resolver.ts`](/mnt/s/Development/GuardianAgent/src/runtime/intent/capability-resolver.ts)
- add the handler to the direct-candidate dispatch loop in [`src/index.ts`](/mnt/s/Development/GuardianAgent/src/index.ts)

The only allowed pre-gateway interception is slash-command parsing in channel adapters and continuation/approval detection.

### 2. Blocked work belongs to shared orchestration

If the capability can be blocked on:

- approval
- clarification
- prerequisites
- auth
- workspace switch
- missing context

then use the shared orchestration model:

- `PendingActionStore`
- shared response metadata
- shared channel rendering

Do not invent bespoke per-tool or per-channel resume logic if the shared model can represent the behavior.

### 3. Config and control-plane writes go through control-plane services

Do not write YAML, tokens, or runtime config ad hoc from random handlers.

Use the control-plane path:

- config types and normalization in `src/config/`
- control-plane callback/services in `src/runtime/control-plane/`
- dashboard route wiring in [`src/channels/web-runtime-routes.ts`](/mnt/s/Development/GuardianAgent/src/channels/web-runtime-routes.ts)
- dashboard type contracts in [`src/channels/web-types.ts`](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)

If a web mutation is privileged, require the appropriate privileged ticket.

### 4. Tool discovery is intentionally deferred

The deferred-loading and `find_tools` design is architecture, not a temporary optimization.

When adding a tool:

- default to deferred unless there is a strong architectural reason to make it always-loaded
- do not promote tools to always-loaded just because a model failed to discover them
- update [`docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md) if you intentionally change the model

### 5. Durable memory writes must use the shared memory mutation path

Do not add new append-only durable writes directly against `AgentMemoryStore` for product behavior.

Use [`src/runtime/memory-mutation-service.ts`](/mnt/s/Development/GuardianAgent/src/runtime/memory-mutation-service.ts) so writes get:

- duplicate suppression
- profile/wiki upsert behavior
- lifecycle metadata
- bounded hygiene follow-up

### 6. User-facing behavior must update the Reference Guide

If the capability changes user-visible workflow, behavior, navigation, controls, output, or operational guidance, update:

- [`src/reference-guide.ts`](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

This applies even if the main implementation lives elsewhere.

## Choose The Capability Shape

Use the smallest correct capability type.

| Capability type | Use when | Primary files |
|---|---|---|
| Direct intent route | The request needs a first-class workflow or dispatch path before normal tool calling | `src/runtime/intent/types.ts`, `src/runtime/intent/capability-resolver.ts`, `src/index.ts` |
| Built-in tool | The capability is an executable runtime action exposed to the model/tool loop | `src/tools/builtin/*.ts`, `src/tools/executor.ts`, `src/tools/types.ts` |
| Skill | The capability is prompt-time guidance, workflow instructions, or reusable operator/model know-how | `skills/`, `src/skills/registry.ts`, `src/skills/resolver.ts`, `src/skills/prompt.ts` |
| Native integration | Guardian owns auth, API calls, config, and runtime behavior directly | `src/runtime/`, provider-specific module trees like `src/google/` or `src/microsoft/`, control-plane files |
| MCP-backed integration | Guardian should talk to an external tool server over MCP with bounded trust | `src/tools/mcp-client.ts`, config, startup admission, policy |
| Dashboard/control-plane surface | Operators need config, status, CRUD, or diagnostics in the web UI | `src/channels/web-types.ts`, `src/channels/web-runtime-routes.ts`, `src/index.ts`, `web/public/` |
| Background maintenance job | The work is server-owned hygiene, consolidation, refresh, or bounded non-interactive maintenance | `src/runtime/assistant-jobs.ts`, `src/index.ts`, owning runtime service |

If your design requires multiple rows from that table, implement the owning runtime surface first, then add the operator or prompt-facing surface second.

## Adding A Direct Intent Route

Add a direct route only when the capability needs a dedicated workflow or should bypass normal free-form planning.

Required changes:

- add the route to `IntentGatewayRoute`
- update the gateway tool schema enum and prompt
- update decision normalization
- update preferred candidate selection in `direct-intent-routing.ts`
- add the route to workload derivation in `workload-derivation.ts`
- add a candidate handler in [`src/index.ts`](/mnt/s/Development/GuardianAgent/src/index.ts)
- add tests for both positive routing and non-routing confusion cases

Also consider:

- does the route need extracted entities?
- does it create blocked or resumable work?
- does it need routing trace visibility?
- does it need channel-specific rendering, or can shared metadata do it?

If the answer to the last question is “channel-specific rendering,” prove why the shared metadata model is insufficient before you implement it.

## Adding A Built-In Tool

Built-in tools are runtime capabilities callable by the model.

Primary path:

- define or extend the builtin tool registrar in `src/tools/builtin/`
- register the tool from [`src/tools/executor.ts`](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)
- choose the correct `risk`, `category`, and parameter schema

Checklist:

### Tool definition

- name is stable and scoped sensibly
- `description` explains when to use it
- `shortDescription` is compact and useful in prompt context
- parameters are explicit and bounded
- outputs are structured enough for downstream reasoning

### Tool category and routing

- if you need a new category, update `ToolCategory`, `TOOL_CATEGORIES`, and any category-aware routing
- verify whether smart provider routing defaults need to know about the new category
- only change the always-loaded set intentionally

### Execution semantics

- if the tool reads or writes files, go through the existing filesystem/sandbox guardrails
- if it mutates durable memory, use `MemoryMutationService`
- if it creates long-running work, feed `AssistantJobTracker` and timeline/audit surfaces
- if output is large, add result compaction where appropriate

### Security and policy

- choose the correct `risk`: `read_only`, `mutating`, or `external_post`
- make sure Guardian capability checks and policy behavior are correct. If you introduce a new action type (like `external_post` or a custom integration), it MUST be mapped to an existing capability (like `network_access`) in `src/guardian/guardian.ts` (inside `CapabilityController`) and `src/index.ts` (`capMap`), otherwise it will be blocked by default-deny.
- Update the default tool policies to map your new tool if necessary. For instance, `external_post` tools always require manual approval, but standard read/write operations may need to be declared in the core policy evaluator `src/policy/` or handled specifically in `src/tools/executor.ts`'s `evaluateToolPolicy`.
- consider SSRF, secret/PII scanning, denied paths, allowlists, and tainted content reinjection

### Tests

- unit tests in the tool registrar or executor layer
- approval/policy coverage in [`src/tools/executor.test.ts`](/mnt/s/Development/GuardianAgent/src/tools/executor.test.ts) when relevant
- integration harnesses if the tool changes user-facing behavior

## Adding A Skill

Skills are not tools. They are reusable guidance and workflow packaging.

Use a skill when you need:

- domain-specific instructions
- repeatable operator/model workflow guidance
- scoped knowledge that does not require a new runtime primitive

Use a tool or integration instead when the capability needs:

- real execution
- auth
- runtime state mutation
- durable storage
- policy enforcement

Checklist:

- add the skill under `skills/`
- keep `SKILL.md` concrete, bounded, and composable
- avoid duplicating runtime authority in prose
- if the skill changes how skill catalogs, bounded drilldown, or reviewed artifact pointers are surfaced, update `src/skills/prompt.ts`
- keep progressive disclosure in mind: top-level `SKILL.md` for bounded workflow guidance, heavier material in `references/`, `templates/`, `examples/`, `scripts/`, and optional reviewed `artifactReferences`
- if the skill depends on a tool, make sure the tool exists and is governed independently
- add tests for skill selection/resolution if the new skill changes resolver behavior
- add or update prompt-material tests when the skill changes bundle-resource selection, progressive disclosure caps, or artifact-backed prompt context

## Adding A Native Integration

Use a native integration when Guardian should own the provider/API directly.

Typical pieces:

- auth module
- service client
- config types
- runtime wiring
- control-plane callbacks
- web configuration/status surface
- audit and failure handling

Checklist:

### Config and credentials

- add config types in `src/config/types.ts`
- load/normalize config in `src/config/loader.ts` or the correct input-normalization helpers
- use secret storage / credential refs instead of loose raw secret handling

### Runtime

- keep provider logic in a dedicated module tree, not inline in `src/index.ts`
- inject the service through runtime wiring
- enforce timeouts, error boundaries, and bounded retries where appropriate

### Operator surface

- expose status and mutation through control-plane callbacks
- add `web-types` contracts and `web-runtime-routes` handlers if the web UI needs it
- require privileged tickets for protected mutations

### Audit and observability

- record auth failures and important bounded operations in the audit log
- add assistant jobs if the work can be long-running or maintenance-like

### Tests

- service tests
- auth/config tests
- dashboard callback tests if surfaced in web UI

## Adding An MCP-Backed Integration

Use MCP when Guardian should delegate the actual capability to an external tool server.

Checklist:

- add server config with clear source and trust level
- use startup admission rules instead of silently auto-starting risky servers
- set `networkAccess`, `inheritEnv`, `allowedEnvKeys`, and rate limits deliberately
- ensure tool naming/namespacing is predictable
- do not bypass Guardian or tool policy just because the capability lives behind MCP
- follow [`docs/guides/MCP-TESTING-GUIDE.md`](/mnt/s/Development/GuardianAgent/docs/guides/MCP-TESTING-GUIDE.md) for validation

If an MCP-backed integration should feel first-party, document the operational boundaries explicitly rather than hiding the trust model.

## Adding A Dashboard Or Control-Plane Surface

If operators need to inspect or control the capability from the web UI:

Checklist:

- add/update shared types in [`src/channels/web-types.ts`](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- add/update HTTP handlers in [`src/channels/web-runtime-routes.ts`](/mnt/s/Development/GuardianAgent/src/channels/web-runtime-routes.ts)
- add/update the runtime callback implementation in [`src/index.ts`](/mnt/s/Development/GuardianAgent/src/index.ts) or an extracted control-plane callback module
- add/update the frontend in `web/public/`
- emit UI invalidation events for mutated state when needed
- protect privileged mutations with tickets

Do not let the frontend become the source of truth for behavior. The runtime callback contract is canonical.

## Adding Background Maintenance Or Lifecycle Work

Use explicit runtime-owned maintenance when the work is:

- consolidation
- refresh
- extraction
- hygiene
- non-interactive prefetch/cache refresh

Checklist:

- read [`docs/specs/AUTOMATED-MAINTENANCE-SPEC.md`](/mnt/s/Development/GuardianAgent/docs/specs/AUTOMATED-MAINTENANCE-SPEC.md) before adding a new server-owned maintenance lane
- use `AssistantJobTracker`
- surface maintenance metadata so the job view can explain it
- record audit events if the work mutates durable state
- keep the work bounded and idempotent
- do not introduce a second hidden assistant
- do not bypass trust, approval, or scope boundaries

Examples:

- maintained summary refresh
- memory hygiene
- context flush
- bounded reconciliation of system-managed artifacts

## Cross-Cutting Security Checklist

Every new capability must be reviewed against these systems:

- Guardian capability grants
- tool risk and policy mode
- denied paths
- secret scanning
- PII scanning
- SSRF protection
- allowed paths / allowed commands / allowed domains
- tainted content handling before reinjection to the model
- audit logging
- runtime auth / control-plane integrity if config or secrets are involved

If the capability touches a trust boundary, read:

- [`SECURITY.md`](/mnt/s/Development/GuardianAgent/SECURITY.md)
- [`docs/architecture/OVERVIEW.md`](/mnt/s/Development/GuardianAgent/docs/architecture/OVERVIEW.md)

## Cross-Cutting Memory, Analytics, And Audit Checklist

If the capability creates durable state or operational traces:

- use the owning persistence layer, not an ad hoc file
- use `MemoryMutationService` for durable memory writes
- feed `AssistantJobTracker` for maintenance or long-running work
- add audit events for meaningful security/operational mutations
- keep run timeline and operator views inspectable if the work matters operationally

## Documentation Checklist

At minimum, consider all of these:

- this guide, if the capability introduces a new general authoring rule
- subsystem spec or guide, if one exists
- [`src/reference-guide.ts`](/mnt/s/Development/GuardianAgent/src/reference-guide.ts) for user-facing changes
- architecture docs, if ownership or layering changed

Key companion docs:

- [`docs/architecture/FORWARD-ARCHITECTURE.md`](/mnt/s/Development/GuardianAgent/docs/architecture/FORWARD-ARCHITECTURE.md)
- [`docs/specs/TOOLS-CONTROL-PLANE-SPEC.md`](/mnt/s/Development/GuardianAgent/docs/specs/TOOLS-CONTROL-PLANE-SPEC.md)
- [`docs/guides/MEMORY-SYSTEM.md`](/mnt/s/Development/GuardianAgent/docs/guides/MEMORY-SYSTEM.md)
- [`docs/guides/INTEGRATION-TEST-HARNESS.md`](/mnt/s/Development/GuardianAgent/docs/guides/INTEGRATION-TEST-HARNESS.md)

## Verification Checklist

Default verification:

- `npm run check`
- focused `npx vitest run ...` for the touched files
- `npm test`
- `npm run build`

Run the relevant harnesses automatically based on what changed:

| Change type | Harnesses to consider |
|---|---|
| Web UI / dashboard surface | `node scripts/test-code-ui-smoke.mjs` |
| Coding assistant / routing / approval / shared orchestration | `node scripts/test-coding-assistant.mjs` |
| Security / guardrails / prompt hardening | `node scripts/test-contextual-security-uplifts.mjs` |
| Memory UI or memory lifecycle changes | `node scripts/test-memory-surface.mjs` |
| MCP behavior | follow [`docs/guides/MCP-TESTING-GUIDE.md`](/mnt/s/Development/GuardianAgent/docs/guides/MCP-TESTING-GUIDE.md) |

If a harness cannot run because of sandbox or environment constraints, say so explicitly.

## Definition Of Done

A capability is not done when the happy-path code exists. It is done when:

- the owning runtime layer is correct
- security/policy boundaries are respected
- direct intent routing is correct when needed
- blocked work uses shared orchestration when needed
- control-plane/config changes use the proper mutation path
- operator surfaces and invalidation are wired when needed
- docs are updated
- tests and harnesses pass

If you are tempted to “just wire it in `src/index.ts` for now,” stop and move the behavior into the owning layer first.
