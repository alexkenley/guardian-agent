# GEMINI.md - GuardianAgent Project Context

## Project Overview
GuardianAgent is an event-driven AI agent orchestration system with a four-layer security defense. Agents are async classes that respond to messages, events, and cron schedules.

- **Architecture:** Multi-channel (Web, CLI, Telegram) supported by a shared TypeScript runtime with a centralized **Intent Gateway**.
- **Security Model:** Four-layer defense system (Admission, Sandbox, Guardian Review, Output Scanning, Sentinel Audit).
- **Core Technologies:** Node.js, TypeScript, SQLite (for persistence), and multi-LLM support (Ollama, Anthropic, OpenAI, etc.).

## Critical Mandates
- **Branching:** DO NOT create or switch branches unless explicitly asked. Stay on the current branch (including `main`).
- **Structure:** Source code is in `src/`, web UI in `web/public/`, and tests reside next to the code they cover as `*.test.ts`.
- **Architectural Discipline:** Do not use tactical workarounds that bypass the intended architecture just to make a symptom disappear. Fix the defect in the layer that owns it (e.g., intent routing, shared pending-action state, control-plane callbacks).
- **Required Reading Before Major Changes:**
  - `docs/architecture/FORWARD-ARCHITECTURE.md` (for module boundaries and refactor convergence).
  - `docs/guides/CAPABILITY-AUTHORING-GUIDE.md` (the single source of truth for adding tools, skills, routes, and control planes).
  - `docs/specs/WEBUI-DESIGN-SPEC.md` (before changing the web surface).

## Debugging and Decision-Making Protocol
- **Data Before Conclusions:** Run diagnostics, read logs, and verify locally before changing direction. Never guess a root cause from reasoning alone.
- **Routing Trace (CRITICAL):** When debugging routing, approvals, pending actions, direct tool dispatch, or continuation issues, **ALWAYS inspect the routing trace** (`~/.guardianagent/routing/intent-routing.jsonl`) rather than guessing from transcripts alone.

## Building and Running
- **Install Dependencies:** `npm install`
- **Development Mode:** `npm run dev` (starts the app with `tsx`)
- **Build Project:** `npm run build` (compiles to `dist/`)
- **Type Checking:** `npm run check` (tsc no-emit)

## Testing and Integration Harnesses
- **Unit Tests:** `npm test` (Vitest, tests are co-located with source files).
- **Run Specific Unit Test:** `npx vitest run src/path/to.test.ts`
- **Integration Test Harness (CRITICAL):** Refer to `docs/guides/INTEGRATION-TEST-HARNESS.md`. After any implementation touching the web UI, coding assistant, tool execution, approval flow, or security pipeline, you MUST run the relevant integration harnesses. These are self-contained `.mjs` scripts (preferred) or PowerShell scripts that exercise the full stack via the REST API.
- **Startup/Test Script Maintenance (CRITICAL):** When a change materially affects startup behavior, orchestration, delegation, approvals, resume flow, provider/profile selection, routing, progress/timeline rendering, tool contracts, or scripted UX copy, inspect and update the startup scripts, smoke harnesses, test scripts, and brittle test expectations in the same change. Do not leave harness or startup-script drift behind after architectural work.
- **Required Post-Implementation Smoke Tests:**
    - `node scripts/test-coding-assistant.mjs`
    - `node scripts/test-code-ui-smoke.mjs`
- **Testing Environments & Ollama:**
    - **Cross-Platform:** The Node.js (`.mjs`) harnesses are the preferred method for automated testing as they reliably simulate frontend HTTP signatures and run consistently across Windows and Linux/Ubuntu (WSL).
    - **Ollama Configurations:** Harnesses default to an embedded fake provider for deterministic runs. To test with real local models:
        - **Local Ollama:** Set `HARNESS_USE_REAL_OLLAMA=1` and `HARNESS_OLLAMA_MODEL=<model_name>`. In WSL, if the endpoint is loopback, the harness can autostart `ollama serve`. For Windows-hosted Ollama accessed from WSL, override with `HARNESS_OLLAMA_BASE_URL=http://<windows-host-ip>:11434`.
        - **Managed Cloud Ollama:** To use Ollama Cloud (useful for stable remote testing without a local daemon), set `HARNESS_USE_REAL_OLLAMA=1`, `HARNESS_OLLAMA_BASE_URL=https://ollama.com/api`, export `OLLAMA_API_KEY`, and set `HARNESS_OLLAMA_MODEL` to a cloud-visible model (e.g., `qwen3-coder-next`).

## Development Conventions
- **Tooling:** Use `vitest` for testing.
- **Style:** Pure functions preferred. Explicit state machines for agent lifecycle. Structured logging via Pino.
- **Intent Gateway:** All user intent classification MUST go through the Intent Gateway (`src/runtime/intent-gateway.ts`). Never use regex or keyword matching for routing.
- **Security:** Never log or echo raw secrets. All tool actions must pass through the `Guardian` review layer.

## Key Files
- `src/index.ts`: Application entry point and runtime bootstrap.
- `src/runtime/intent-gateway.ts`: Central LLM-powered request router.
- `src/channels/`: Channel adapters (cli.ts, web.ts, telegram.ts).
- `web/public/js/chat-panel.js`: Main web chat implementation.
- `SOUL.md`: Behavioral constitution and security invariants.
- `SECURITY.md`: Detailed security architecture and threat model.
- `@CLAUDE.md` / `AGENTS.md`: Source of architectural mandates and repository rules.
- `docs/guides/INTEGRATION-TEST-HARNESS.md`: Guide to the critical full-stack integration testing suites.
