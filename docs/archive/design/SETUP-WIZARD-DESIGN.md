# Setup Wizard Design (Deprecated)

**Status:** Deprecated historical note  

## Status
Deprecated. The interactive CLI `/setup` wizard is no longer part of the primary UX.

## Replacement
- Use `docs/design/CONFIG-CENTER-DESIGN.md` for current behavior.
- Configure providers/channels via:
  - Web: `#/config`
  - CLI: `/config ...`
- Runtime/orchestration visibility via:
  - Web: Dashboard assistant state section (`#/`)
  - CLI: `/assistant`

## Legacy Endpoint Note
The backend still exposes:
- `GET /api/setup/status`
- `POST /api/setup/apply` — LLM provider configuration (requires explicit `providerType`)
- `POST /api/config/search` — Dedicated web search config endpoint (decoupled from provider config)

These endpoints are retained for Config Center readiness/apply flows, not for an interactive wizard. The `/api/config/search` endpoint was added to prevent web search saves from corrupting LLM provider configuration.

