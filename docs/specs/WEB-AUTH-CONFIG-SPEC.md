# Web Auth Configuration Spec

## Goal
Provide explicit, operator-friendly control of dashboard/API authentication, including server-side session-cookie custody for browser clients.

## Scope
- Config model: `channels.web.auth`
- Runtime auth state on WebChannel
- Dashboard API endpoints:
  - `GET /api/auth/status`
  - `POST /api/auth/config`
  - `POST /api/auth/token/rotate`
  - `POST /api/auth/token/reveal`
  - `POST /api/auth/session`
  - `DELETE /api/auth/session`
- Web Config Center panel and CLI `/auth` commands

## Auth Modes
- `bearer_required`:
  - Non-health endpoints require a valid bearer token or a valid HttpOnly session cookie.
  - SSE accepts `?token=<bearer>` or cookie auth.

## Token Lifecycle
- Token sources:
  - Explicit config token
  - Environment token
  - Ephemeral runtime-generated token
- Operators can:
  - Set/update token
  - Rotate token
  - Reveal token for copy/paste

## Session Cookie Custody
- Browser can exchange a bearer token for a server-managed session:
  - `POST /api/auth/session` sets `guardianagent_sid` cookie.
  - `DELETE /api/auth/session` clears cookie and invalidates server session record.
- Cookie attributes:
  - `HttpOnly`
  - `SameSite=Strict`
  - `Path=/`
  - `Max-Age=sessionTtlMinutes * 60`
  - `Secure` when request is HTTPS
- Session records are in-memory and include `createdAt` + `expiresAt`.
- Expired sessions are pruned periodically.
- Bearer auth remains backward compatible; cookie auth is additive.

## Validation + Safety
- `sessionTtlMinutes` must be positive when set.
- Auth mode is fixed to `bearer_required`.
- Status payload always includes:
  - `mode`
  - `tokenConfigured`
  - `tokenSource`
  - masked `tokenPreview`
- Health endpoint remains unauthenticated for readiness probes.

## UX Requirements
- Config Center shows auth mode, token source, TTL, and token controls.
- Browser login flow should exchange bearer token to cookie session and remove browser token storage after successful exchange.
- CLI supports:
  - `/auth status`
  - `/auth rotate`
  - `/auth reveal`
