# Repository Guidelines

## Project Structure & Module Organization
`src/` holds the TypeScript app; `src/index.ts` bootstraps the runtime. Subsystems live in `src/runtime/`, `src/guardian/`, `src/tools/`, `src/channels/`, `src/llm/`, and `src/search/`. Keep tests beside the code they cover as `*.test.ts`. The web UI is in `web/public/`. Use `scripts/` for verification harnesses, `docs/` for architecture and specs, `policies/` for rule files, `skills/` for bundled skills, and `native/windows-helper/` for the Rust helper.

## Build, Test, and Development Commands
- `npm run dev`: start the app with `tsx src/index.ts`.
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type check with `tsc --noEmit`.
- `npm test`: run the Vitest suite.
- `npm run test:coverage`: run Vitest with coverage thresholds.
- `npx vitest run src/path/file.test.ts`: run one test file.
- `npm run helper:windows`: rebuild the Windows native helper when touching `native/windows-helper/`.

## Coding Style & Naming Conventions
This repo uses strict TypeScript with ESM output. Follow the existing style: 2-space indentation, semicolons, single quotes, and explicit `.js` extensions in relative imports from `.ts` files. Prefer kebab-case file names like `security-alerts.ts`, PascalCase for classes and types, camelCase for functions and variables, and UPPER_SNAKE_CASE for constants. Prefer pure helpers and isolate side effects. There is no checked-in ESLint or Prettier config, so match surrounding code and use `npm run check` as the baseline gate.

## Testing Guidelines
Vitest is configured for `src/**/*.test.ts`. Coverage thresholds are 70% for lines, functions, and statements, with 55% for branches. Add or update colocated tests for every behavior change. Agents should automatically run relevant Vitest coverage first, using a focused file run during iteration and `npm test` or `npm run test:coverage` before handoff. Do not wait for a user reminder to run the integration harnesses as well: after changes to web UI, coding assistant, approvals, prompts, routing, or security behavior, run the relevant `scripts/` harnesses automatically. The default path in WSL is the Node `.mjs` harnesses, especially `node scripts/test-coding-assistant.mjs`, `node scripts/test-code-ui-smoke.mjs`, and `node scripts/test-contextual-security-uplifts.mjs`. For AI-path smoke validation, use the real-Ollama lane with `HARNESS_USE_REAL_OLLAMA=1 ... --use-ollama`. In WSL, if the local Ollama server is not already responding, start it first with `ollama serve` before running the real-model harnesses. Real-Ollama harnesses also default `GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD=1`; set `HARNESS_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD=0` if you need to reproduce the friendly local-model guard path. For adversarial prompt testing, use `npm run test:llmmap`. See `docs/guides/INTEGRATION-TEST-HARNESS.md` for WSL and Windows-hosted Ollama details, including `HARNESS_OLLAMA_BASE_URL`.

## Commit & Pull Request Guidelines
Recent history mostly follows Conventional Commit style, for example `feat(memory): ...`, `fix(code-ui): ...`, and `chore: ...`. Keep subjects imperative and add a scope when useful. PRs should summarize the behavior change, list verification commands, link the issue when applicable, and include screenshots for `web/` changes. Call out security, policy, or config impacts when changing `src/guardian/`, `src/runtime/`, `policies/`, or auth/integration code.

## Documentation & Security Tips
Keep `src/reference-guide.ts` in sync with any user-facing behavior, workflow, navigation, or output change. Do not commit secrets, bearer tokens, or local config from `~/.guardianagent/`. Treat `tmp/` as scratch output unless you are intentionally updating a tracked fixture. Read `SECURITY.md` and `docs/architecture/OVERVIEW.md` before changing sandboxing, approvals, audit logging, or other trust-boundary behavior.
