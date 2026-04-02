# GuardianAgent Forward Architecture

## Purpose

This document defines the target application structure for GuardianAgent as the codebase is modularized. It is the architecture contract for future refactors and new capabilities.

Use it when:
- extracting logic out of `src/index.ts`, `src/channels/web.ts`, or `src/tools/executor.ts`
- adding a new agent capability, control-plane surface, or channel feature
- deciding where new code should live and what it may depend on

This is a migration target, not a rewrite license. Existing behavior must be preserved by mechanically extracting code into better boundaries, with characterization coverage and harness validation after each phase.

## Goals

- Keep the security and orchestration invariants supervisor-owned and explicit.
- Make new capabilities additive instead of requiring edits across the same large files.
- Separate transport, application logic, runtime orchestration, and infrastructure adapters.
- Keep configuration updates transactional and auditable.
- Keep blocked-work, approvals, and continuation behavior shared across channels.
- Make test scope map cleanly to architectural boundaries.

## Non-Goals

- Rewriting stable behavior from scratch.
- Collapsing shared orchestration into per-channel logic.
- Introducing plugin-style dynamic loading for first-party core behavior.
- Moving trust-boundary enforcement away from the Runtime and Guardian layers.

## Architectural Principles

1. Composition roots compose. They do not own feature logic.
2. Channel adapters translate protocols. They do not invent business rules.
3. Control-plane services own configuration, mutation, persistence, and runtime application.
4. Runtime orchestration owns intent routing, pending actions, approvals, and cross-turn state.
5. Tool execution owns registration, policy enforcement, approval flow, execution lifecycle, and result shaping.
6. Capability modules own domain-specific implementations behind stable contracts.
7. Security decisions stay centralized in Guardian, policy, sandbox, and shared orchestration layers.
8. New features should normally require edits in one layer plus wiring, not edits across every central file.

## Target Layering

### 1. Bootstrap / Composition Root

Primary responsibility:
- construct services
- assemble the Runtime
- start channels
- register shutdown behavior

Allowed locations:
- `src/index.ts`
- `src/bootstrap/`

Rules:
- `src/index.ts` should become a thin entrypoint.
- Bootstrap code may wire dependencies together, but it should not contain long feature handlers, config transactions, route bodies, or tool implementations.
- If a function in bootstrap starts owning domain decisions, extract it.

Current checkpoint:
- `src/bootstrap/runtime-factory.ts` now owns the earliest startup phase: default-config bootstrap, secure config load, runtime credential resolution, denied-path injection, and initial `Runtime` construction.
- `src/bootstrap/service-wiring.ts` now owns scheduled-task executor wiring, runtime notification service construction, runtime support startup, playbook schedule migration, and CLI post-start setup.
- `src/bootstrap/channel-startup.ts` now owns CLI, Telegram, and Web channel construction, startup logging, channel registration, Telegram reload wiring, and coding-backend bootstrap for the web surface.
- `src/bootstrap/shutdown.ts` now owns graceful shutdown sequencing for channels, managed intervals, MCP cleanup, executor disposal, runtime stop, and terminal exit settlement.
- `src/runtime/incoming-dispatch.ts` now owns shared pre-dispatch preparation for channel messages: request-id assignment, code-session attachment/pinning, gateway-first tier routing, pre-routed metadata attachment, and the early routing trace stages before the Runtime handles the turn.
- `src/runtime/dashboard-dispatch.ts` now owns the shared dashboard/runtime dispatch path: code-session-aware message shaping, pre-routed metadata attachment at dispatch time, orchestrator handoff, response-source enrichment, fallback-tier dispatch, and dispatch-response trace recording.
- `src/runtime/control-plane/config-state-helpers.ts` now owns shared config-state helper logic used by dashboard/control-plane flows: credential-ref normalization, local-secret upserts/deletes, and persistence helpers for tool, skill, and connector state.
- The remaining `src/index.ts` work is now mostly residual helper glue around provider/config shaping, callback-factory assembly, and final orchestration trimming so `main()` becomes composition-only.

Suggested structure:

```text
src/bootstrap/
  runtime-factory.ts
  service-wiring.ts
  channel-startup.ts
  shutdown.ts
```

### 2. Channel / Transport Layer

Primary responsibility:
- accept input from CLI, Web, Telegram, and future transports
- authenticate the request
- parse and validate transport payloads
- translate Runtime responses into channel-specific rendering

Allowed locations:
- `src/channels/`
- `web/public/` for browser presentation

Rules:
- Channel code must not duplicate orchestration rules, approval logic, or continuation semantics.
- Shared blocked-work behavior must stay driven by shared response metadata.
- Request parsing, auth helpers, SSE, terminal lifecycle, and route groups should be split into focused modules.

Suggested structure:

```text
src/channels/
  cli.ts
  telegram.ts
  web.ts
  web-auth.ts
  web-json.ts
  web-sse.ts
  web-shell-launch.ts
  web-terminals.ts
  routes/
    web-auth-routes.ts
    web-tool-routes.ts
    web-agent-routes.ts
    web-config-routes.ts
    web-automation-routes.ts
```

### 3. Control Plane / Application Services

Primary responsibility:
- own dashboard callbacks and admin operations
- validate and persist config changes
- apply live runtime changes
- coordinate multi-service state transitions
- expose stable contracts to channels and UI

Allowed locations:
- `src/runtime/control-plane/`
- `src/runtime/dashboard/`

Rules:
- Configuration mutation must flow through dedicated services, not ad hoc code paths.
- Control-plane services should have explicit phases: validate, persist, reload, apply, audit, rollback/report.
- Web routes and UI callbacks should call services, not directly mutate shared refs or infrastructure objects.

Suggested structure:

```text
src/runtime/control-plane/
  config-persistence-service.ts
  config-state-helpers.ts
  config-apply-service.ts
  config-validation-service.ts
  provider-routing-service.ts
  tool-policy-service.ts
  web-auth-config-service.ts
  dashboard-callbacks.ts
```

### 4. Runtime Orchestration Layer

Primary responsibility:
- execute the authoritative user-turn pipeline
- own intent classification through the Intent Gateway
- manage pending actions, approvals, continuation, and shared response metadata
- coordinate conversations, analytics, identities, budgets, watchdogs, and scheduled execution

Primary locations:
- `src/runtime/`
- `src/agent/`
- `src/guardian/`
- `src/policy/`

Rules:
- Intent classification must stay gateway-first.
- Approval flow and blocked-work state must remain shared abstractions, not feature-specific forks.
- Runtime services should depend on interfaces and helpers, not channel-specific details.

Current checkpoint:
- `src/runtime/incoming-dispatch.ts` is now the shared boundary between channel adapters/bootstrap startup and the Runtime dispatch pipeline.
- `src/runtime/incoming-dispatch.ts` exists to keep request normalization, code-session-aware routing, and pre-routed intent metadata out of `src/index.ts` and out of per-channel adapters.
- `src/runtime/dashboard-dispatch.ts` now owns the shared dispatch path used by dashboard callbacks and the web chat flow after route selection has been made.
- `src/runtime/control-plane/config-state-helpers.ts` now owns the shared config-state helper surface that used to live inline in the callback factory.
- The remaining `src/index.ts` work is now centered on callback-factory cleanup, provider/config shaping helpers, and final orchestration trimming rather than the core message dispatch path.

### 5. Tool Execution Core

Primary responsibility:
- own tool registry lifecycle
- own approval and policy checks
- own execution context assembly
- dispatch tool implementations
- compact and normalize tool outputs

Primary locations:
- `src/tools/executor.ts`
- `src/tools/approvals/`
- `src/tools/builtin/`

Rules:
- `ToolExecutor` should become an orchestration core, not a giant host for every builtin implementation.
- Builtin tools should be registered by category registrars.
- Capability logic should move into category modules and helper services with narrow write scopes.

Suggested structure:

```text
src/tools/
  executor.ts
  approvals/
  builtin/
    web-tools.ts
    browser-tools.ts
    coding-tools.ts
    filesystem-tools.ts
    network-tools.ts
    automation-tools.ts
    workspace-tools.ts
    contacts-tools.ts
  helpers/
    tool-context.ts
    tool-http.ts
    tool-browser.ts
    tool-shell.ts
    tool-output.ts
    tool-policy.ts
```

### 6. Capability Modules

Primary responsibility:
- implement domain-specific behavior behind stable service or tool contracts

Examples:
- `src/google/`
- `src/microsoft/`
- `src/search/`
- `src/runtime/threat-intel.ts`
- `src/runtime/automation-*`

Rules:
- Capability modules should not reach back up into channel adapters or bootstrap code.
- New capabilities should provide a service or registrar entrypoint that the composition root can wire once.

### 7. Infrastructure Adapters

Primary responsibility:
- talk to external systems, SDKs, processes, storage, or OS services

Examples:
- LLM providers in `src/llm/`
- MCP client in `src/tools/mcp-client.ts`
- native OAuth integrations in `src/google/` and `src/microsoft/`
- sandbox and broker infrastructure in `src/sandbox/`, `src/broker/`, and `src/supervisor/`

Rules:
- Infrastructure code should not absorb application decision logic.
- It should expose explicit methods and typed failure states that higher layers can orchestrate.

## Dependency Direction

Allowed dependency flow:

```text
Bootstrap
  -> Channels
  -> Control Plane
  -> Runtime Orchestration
  -> Tool Execution
  -> Capability Modules
  -> Infrastructure Adapters
  -> Shared Utilities
```

Constraints:
- Channels may depend on control-plane contracts and shared render helpers, but not on low-level infrastructure internals.
- Control-plane services may coordinate runtime and tool services, but should not depend on web-specific request objects.
- Capability modules must not import channel adapters.
- Shared utilities in `src/util/` must stay generic and side-effect-light.
- Avoid circular imports between `runtime`, `tools`, and `channels`.

## Canonical Request Flows

### User Turn

1. Channel adapter authenticates and normalizes the request.
2. Shared incoming-dispatch preparation resolves request id, code-session attachment, pinned-agent behavior, and pre-routed intent metadata.
3. Shared dashboard/runtime dispatch shapes the runtime message, attaches code-session context, and enters the orchestrator queue.
4. Runtime receives the prepared message.
5. Intent Gateway classifies the turn if it was not already pre-routed.
6. Shared orchestration decides direct route vs normal assistant path.
7. Pending-action and approval state are resolved through shared contracts.
8. Tool execution, if needed, runs through ToolExecutor and Guardian enforcement.
9. Response metadata is rendered by the channel without inventing channel-specific semantics.

### Config Update

1. Channel or dashboard route validates transport payload.
2. Control-plane service validates semantic config changes.
3. Config is persisted and signed.
4. Canonical config is reloaded.
5. Apply services update runtime/provider/tool/channel state.
6. Audit and result metadata are recorded.
7. The channel returns the service result.

### Tool Registration and Execution

1. Bootstrap creates ToolExecutor with shared services and policy dependencies.
2. ToolExecutor invokes builtin registrars by category.
3. Each registrar registers tool definitions and delegates implementation to focused helpers.
4. At runtime, ToolExecutor performs policy, approval, and context checks.
5. Tool output is normalized and compacted through shared helpers before reinjection.

## Module Placement Rules

When adding new code:

- Put request parsing and HTTP response shaping in `src/channels/`.
- Put config mutation and dashboard action logic in `src/runtime/control-plane/`.
- Put shared orchestration or pending-action behavior in `src/runtime/`.
- Put tool definitions and execution helpers in `src/tools/`.
- Put external-provider integrations in their domain directories, not inside channel or bootstrap files.
- Put pure, reusable helpers in `src/util/` only if they are not domain-owned.

If a change requires edits to `src/index.ts`, `src/channels/web.ts`, and `src/tools/executor.ts` at the same time, stop and identify the missing abstraction first.

## Refactor Rules

These rules are mandatory for the modularization effort:

1. Do not delete a large file and recreate it from model context.
2. Move code mechanically in small slices.
3. Preserve behavior first, improve shape second.
4. Add characterization tests before moving high-risk logic when coverage is weak.
5. Run focused tests during iteration.
6. Run the relevant integration harnesses after each phase.
7. Land one boundary improvement per phase when possible.
8. Keep unrelated dirty-worktree changes untouched.

## Testing Strategy By Layer

- Bootstrap changes: `npm run check`, targeted bootstrap/runtime tests, affected harnesses, then `npm test`.
- Channel/web changes: focused Vitest for extracted helpers and route behavior, `node scripts/test-code-ui-smoke.mjs`, `node scripts/test-coding-assistant.mjs`, `node scripts/test-contextual-security-uplifts.mjs`.
- Control-plane changes: focused runtime/control-plane tests, `node scripts/test-coding-assistant.mjs`, `node scripts/test-contextual-security-uplifts.mjs`.
- Incoming-dispatch and routing-preparation changes: focused `src/runtime/incoming-dispatch.test.ts`, bootstrap/channel-startup tests that exercise the preparer boundary, `npm run check`, `node scripts/test-code-ui-smoke.mjs`, and the routing/security harnesses affected by the touched path.
- Tool execution changes: focused executor tests, relevant capability harnesses such as `node scripts/test-automation-authoring-compiler.mjs`, then full suite.
- Security or routing changes: always include the relevant security/routing harnesses and inspect the routing trace when applicable.

See `docs/guides/INTEGRATION-TEST-HARNESS.md` for harness details and lane selection.

## Definition of Clean Structure

GuardianAgent is considered structurally healthy when:

- `src/index.ts` is primarily composition and startup logic.
- channel adapters are transport-focused and route groups are modular.
- config updates flow through dedicated control-plane services.
- ToolExecutor is mostly execution orchestration plus registrar wiring.
- builtin tool implementations are grouped by domain and tested in isolation.
- pending actions, approvals, and continuation semantics remain shared.
- adding a new capability usually means adding one registrar or service module plus a single wiring step.

## Architectural Guardrails

Use these as review heuristics:

- No new 1k+ line callback factories.
- No route modules that duplicate body parsing and error handling for every endpoint.
- No tool category growth that requires pasting new implementations into `registerBuiltinTools()`.
- No channel-specific approval or continuation state machines.
- No direct config mutation from UI handlers without a control-plane service.

## Documentation Responsibilities

- Keep this document aligned with the actual target structure as refactors land.
- Keep `docs/architecture/OVERVIEW.md` aligned with the current shipped architecture.
- Keep `src/reference-guide.ts` aligned with user-facing behavior.
- Update `AGENTS.md` and `CLAUDE.md` when the architectural contract for contributors changes.
