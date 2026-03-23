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
- Startup behavior:
  - If no token is configured, Guardian generates an ephemeral runtime token for that process.
  - If `channels.web.auth.rotateOnStartup` is `true`, Guardian generates a fresh ephemeral runtime token at startup even when a configured token exists.
  - When an ephemeral startup token is generated and Guardian is running in an interactive terminal, the full token is printed once to the terminal for browser sign-in.
- Persistence behavior:
  - Runtime-generated startup tokens and manually rotated tokens are not written back into config.
  - Configured or env-backed tokens remain stable until the operator changes them.
- Operators can:
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
- If a privileged dashboard mutation fails because the browser session expired, the login prompt should recover by exchanging the bearer token for a fresh session cookie and retrying the interrupted request once.
- Startup scripts should not silently pin a newly generated bearer token into config just to make first login work; the interactive-terminal path should surface the ephemeral token directly instead.
- Windows and Unix development startup scripts should inspect the saved web-auth settings and tell the operator whether the dashboard will reuse a pinned token or print a per-run ephemeral token.
- CLI supports:
  - `/auth status`
  - `/auth rotate`
  - `/auth reveal`
