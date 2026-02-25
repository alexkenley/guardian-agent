# Setup And Config Center Spec

## Goal
Provide a first-run onboarding flow and ongoing configuration surface that gets a personal assistant usable in one pass:
- Configure local Ollama or external API provider
- Apply default provider immediately (no restart for LLM changes)
- Optionally configure Telegram bot token + allowed chat IDs
- Mark setup completion state and expose diagnostics

## Scope
- Web: `#/config` Configuration Center with readiness panel and unified apply form
- CLI: `/setup` command with interactive prompts
- Backend API:
  - `GET /api/setup/status`
  - `POST /api/setup/apply`

## Data Model
- `assistant.setup.completed: boolean`
- Provider settings in `llm.<provider>`
- Optional Telegram updates in `channels.telegram`

## Runtime Behavior
- Setup apply writes `config.yaml`
- Runtime applies LLM/default provider changes live via `runtime.applyLLMConfiguration()`
- Telegram channel structural changes (enable/disable/token updates) require restart

## Validation Rules
- `model` required
- `apiKey` required for external providers unless an existing key is already configured
- Config is validated through `validateConfig()` before persistence

## UX Requirements
- Config Center includes step-by-step readiness state
- CLI setup supports defaults for fast local onboarding
- Web config supports both fresh values and quick-fill from detected providers
