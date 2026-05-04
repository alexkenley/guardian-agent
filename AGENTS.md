# Repository Guidelines

## Branching (CRITICAL)
Do not create or switch to a new branch unless the user explicitly asks for it. Default to staying on the current branch, including `main`, unless the user directs otherwise.

## Project Structure & Module Organization
`src/` holds the TypeScript app; `src/index.ts` bootstraps the runtime. Subsystems live in `src/runtime/`, `src/guardian/`, `src/tools/`, `src/channels/`, `src/llm/`, and `src/search/`. Keep tests beside the code they cover as `*.test.ts`. The web UI is in `web/public/`. Use `scripts/` for verification harnesses, `docs/` for architecture and specs, `policies/` for rule files, `skills/` for bundled skills, and `native/windows-helper/` for the Rust helper.

## Build, Test, and Development Commands
- `npm run dev`: start the app with `tsx src/index.ts`.
- `.\scripts\start-dev-windows.ps1 -StartOnly`: start the Windows dev server without rebuilding for browser/API regression loops.
- `bash scripts/start-dev-unix.sh --start-only`: start the Unix/WSL dev server without rebuilding.
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type check with `tsc --noEmit`.
- `npm test`: run the Vitest suite.
- `npm run test:coverage`: run Vitest with coverage thresholds.
- `npx vitest run src/path/file.test.ts`: run one test file.
- `npm run validate:dependency-contract`: validate pinned dependency and lockfile contract after dependency or override changes.
- `npm run validate:windows-package`: validate staged Windows package manifests after Windows packaging work.
- `npm run helper:windows`: rebuild the Windows native helper when touching `native/windows-helper/`.
- **Integration Testing (CRITICAL):** Review `docs/guides/INTEGRATION-TEST-HARNESS.md` for full-stack API regression testing, including guidance for cross-platform (Windows/WSL) and Ollama configurations.

## Intent Gateway (CRITICAL)
All user intent classification must go through the Intent Gateway (`src/runtime/intent-gateway.ts`). **Never use regex, keyword matching, string includes, or any ad-hoc pattern matching to determine what the user is asking for.** The Intent Gateway is an LLM classifier that routes requests via structured tool calls. New routes must be added to `IntentGatewayRoute`, the tool schema, the system prompt, `normalizeRoute`, `preferredCandidatesForDecision` in `direct-intent-routing.ts`, and the candidate dispatch loop in `src/index.ts`. Pre-gateway interception is only permitted for slash-command parsing in channel adapters and continuation/approval flow detection.

## Shared Orchestration (CRITICAL)
When a bug is about blocked execution, prerequisites, approvals, clarifications, cross-turn resume, workspace switching, or channel-specific drift, fix it by extending the shared orchestration/state system first. In the current architecture that means the Intent Gateway contract, `PendingActionStore`, shared response metadata, and shared channel rendering. Do not add bespoke per-tool or per-capability resume flows unless the shared model cannot represent the behavior.

## Architecture Discipline (CRITICAL)
Do not ship tactical workarounds that bypass the intended architecture just to make a failing path appear to work. Fix the root cause in the layer that owns the behavior:
- intent/routing bugs: `IntentGateway` and shared routing/orchestration
- blocked-work / approval drift: shared pending-action and channel metadata flow
- config/provider mutation: control-plane services and transactional config update paths
- tool visibility/discovery: the deferred-loading / `find_tools` design, unless there is an intentional architecture change

If a proposed fix would bypass the documented design, stop and reconsider. Examples of fixes that are not acceptable by default:
- promoting deferred tools to always-loaded just because a model failed to call `find_tools`
- adding one-off channel behavior that duplicates shared orchestration
- bypassing control-plane callbacks with ad hoc config writes
- adding special-case routing logic before the Intent Gateway

If the right fix is to change the architecture, make that an explicit architectural change and update the relevant docs/specs in the same change rather than sneaking in a workaround. For tool-loading changes, read `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md`. For module boundaries and ownership, read `docs/architecture/FORWARD-ARCHITECTURE.md`.

## Strategic Architecture Pause (CRITICAL)
When a fix starts adding layers of adapters, compatibility shims, prompt rules, duplicated state, or per-channel/per-tool exceptions, pause before continuing. Re-read the owning design docs and current implementation, then decide whether the better move is an architecture uplift instead of another local patch.

Use this pause when the same symptom appears across multiple channels or subsystems, when two or more fixes compensate for each other, when the true owner of state or policy is unclear, or when a regression suggests the current module boundary is wrong. The expected output is a concise architecture note before implementation: the current shape, the root design flaw, the proposed target shape, migration steps, tests/harnesses to update, and any obsolete layers to remove. Prefer a small coherent redesign over accumulating defensive code.

## Routing Trace (CRITICAL)
When troubleshooting intent classification, smart routing, pending actions, approvals, direct tool dispatch, or cross-channel continuation behavior, inspect the intent routing trace before guessing from transcripts alone. The canonical log is `~/.guardianagent/routing/intent-routing.jsonl` on the host running Guardian (for Windows installs this is typically `C:\Users\<user>\.guardianagent\routing\intent-routing.jsonl`). Use it to confirm gateway classification, tier selection, direct-candidate evaluation, tool start/completion, pending-action creation, and approval propagation. For web-specific failures, combine the trace with server/channel inspection and `web/public/js/chat-panel.js`, because the routing trace will not show frontend rendering or input-lock bugs by itself.

## Coding Style & Naming Conventions
This repo uses strict TypeScript with ESM output. Follow the existing style: 2-space indentation, semicolons, single quotes, and explicit `.js` extensions in relative imports from `.ts` files. Prefer kebab-case file names like `security-alerts.ts`, PascalCase for classes and types, camelCase for functions and variables, and UPPER_SNAKE_CASE for constants. Prefer pure helpers and isolate side effects. There is no checked-in ESLint or Prettier config, so match surrounding code and use `npm run check` as the baseline gate.

## Testing Guidelines
Vitest is configured for `src/**/*.test.ts`. Coverage thresholds are 70% for lines, functions, and statements, with 55% for branches. Add or update colocated tests for every behavior change. Agents should automatically run relevant Vitest coverage first, using a focused file run during iteration and `npm test` or `npm run test:coverage` before handoff. Do not wait for a user reminder to run the integration harnesses as well: after changes to web UI, coding assistant, approvals, prompts, routing, or security behavior, run the relevant `scripts/` harnesses automatically. The default path in WSL is the Node `.mjs` harnesses, especially `node scripts/test-coding-assistant.mjs`, `node scripts/test-code-ui-smoke.mjs`, and `node scripts/test-contextual-security-uplifts.mjs`. For AI-path smoke validation, use the real-Ollama lane with `HARNESS_USE_REAL_OLLAMA=1 ... --use-ollama`. In WSL, if the local Ollama server is not already responding, start it first with `ollama serve` before running the real-model harnesses. Real-Ollama harnesses also default `GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD=1`; set `HARNESS_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD=0` if you need to reproduce the friendly local-model guard path. For adversarial prompt testing, use `npm run test:llmmap`. See `docs/guides/INTEGRATION-TEST-HARNESS.md` for WSL and Windows-hosted Ollama details, including `HARNESS_OLLAMA_BASE_URL`.
For UI-facing chat regressions in Codex Desktop, use the documented web preview loop: start with `.\scripts\start-dev-windows.ps1 -StartOnly`, exercise `http://localhost:3000/`, replay with `POST /api/message/stream` if needed, then inspect `~/.guardianagent/routing/intent-routing.jsonl` by `requestId`.
Use focused harnesses for their owned surfaces: `node --import tsx scripts/test-skills-routing-harness.mjs` for skill/tool routing, `node scripts/test-web-gmail-approvals.mjs` for Gmail approval UX, `node scripts/test-security-verification.mjs` for security verification paths, `node scripts/test-tool-contracts.mjs` for direct tool contract, policy, sandbox, and job-history regressions, and `node scripts/inspect-latest-coding-harness.mjs --list 3` when inspecting recent coding-harness artifacts.
For approval-continuity or resume-flow regressions, pair focused Vitest coverage such as `npx vitest run src/runtime/continuity-threads.test.ts src/runtime/incoming-dispatch.test.ts src/runtime/direct-reasoning-mode.test.ts` with the channel harness `node scripts/test-web-approvals.mjs`.
For orchestration, delegation, or multi-domain execution-graph changes, include `node scripts/test-cross-domain-orchestration-stress.mjs` in the relevant harness loop.
When a change materially affects startup behavior, orchestration, delegation, approvals, resume flow, provider/profile selection, routing, progress/timeline rendering, tool contracts, or scripted UX copy, inspect and update the startup scripts, smoke harnesses, test scripts, and brittle test expectations in the same change. Do not leave harness or startup-script drift behind after architectural work.

## Commit & Pull Request Guidelines
Recent history mostly follows Conventional Commit style, for example `feat(memory): ...`, `fix(code-ui): ...`, and `chore: ...`. Keep subjects imperative and add a scope when useful. PRs should summarize the behavior change, list verification commands, link the issue when applicable, and include screenshots for `web/` changes. Call out security, policy, or config impacts when changing `src/guardian/`, `src/runtime/`, `policies/`, or auth/integration code.

## Documentation & Security Tips
Keep `src/reference-guide.ts` in sync with any user-facing behavior, workflow, navigation, or output change. `src/reference-guide.ts` is a user/operator guide only: keep it focused on how to use the product and what the operator can do in the UI, CLI, or Telegram. Do not put backend implementation details, code-path notes, trace-file internals, config-file internals, tests, or architecture commentary into the Reference Guide unless an operator explicitly needs that information to use the product. Treat `docs/guides/CAPABILITY-AUTHORING-GUIDE.md` as the single source of truth before adding any new capability such as a tool, skill, integration, route, maintenance job, or control-plane surface. Do not commit secrets, bearer tokens, or local config from `~/.guardianagent/`. Treat `tmp/` as scratch output unless you are intentionally updating a tracked fixture. Read `SECURITY.md` and `docs/architecture/OVERVIEW.md` before changing sandboxing, approvals, audit logging, or other trust-boundary behavior. Read `docs/architecture/FORWARD-ARCHITECTURE.md` before large refactors or when adding new capabilities, control-plane surfaces, or channel routes so new code follows the target module boundaries instead of extending the existing monoliths. Read `docs/design/TOOLS-CONTROL-PLANE-DESIGN.md` before changing tool discovery, always-loaded vs deferred tool sets, approval UX, or tool control-plane behavior.
Read `docs/design/WEBUI-DESIGN.md` before changing `web/public/`, web navigation, page ownership, guidance copy patterns, or dashboard/control-plane surface layout. Treat it as the source of truth for WebUI information architecture and visual/interaction standards. If a new web surface or nav item conflicts with that spec, update the spec in the same change rather than silently diverging in implementation.
