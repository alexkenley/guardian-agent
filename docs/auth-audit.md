# GuardianAgent Auth & JWT Audit

This document summarizes the current state of authentication and JWT usage within the `src/runtime/` and broader `src/` directory, as requested.

## JWT Validation & Creation

| File | Line(s) | Role | Notes |
|---|---|---|---|
| `src/tools/cloud/gcp-client.ts` | 560-590 | **Creation** | Implements `createJwtAssertion` using `RS256` for Google Cloud OAuth2 token exchange. Manually constructs header and claims. |
| `src/tools/cloud/gcp-client.ts` | 364 | **Usage** | Calls `createJwtAssertion` to generate the assertion for `urn:ietf:params:oauth:grant-type:jwt-bearer` flow. |
| `src/guardian/secret-scanner.ts` | 67 | **Detection** | Regex pattern for detecting JWT tokens in content (`/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g`). |
| `src/runtime/complexity-scorer.ts`| 48 | **Reference** | Includes `jwt` in `TECHNICAL_TERMS` regex for scoring user request complexity. |

## General Authentication Logic

| File | Context |
|---|---|
| `src/bootstrap/channel-startup.ts` | Manages web dashboard authentication (`bearer_required` mode). Handles ephemeral token generation and validation for channel sessions. |
| `src/channels/web.ts` | (Implicitly referenced) Implements the `WebChannel` which utilizes the auth config for request verification. |
| `src/runtime/control-plane/auth-control-callbacks.ts` | Handles callbacks related to authentication lifecycle events in the control plane. |
| `src/runtime/security-triage-agent.ts` | Logic for evaluating security-sensitive intents, including auth-related drift or alerts. |

## Observations

1. **No Runtime JWT Middleware:** There is currently no generic JWT validation middleware (e.g., `passport-jwt` or `express-jwt`) implemented in `src/runtime/`. The system appears to rely on session-based or bearer-token checks managed by the `WebChannel` and `channel-startup.ts` for internal API access.
2. **GCP Integration:** The most explicit JWT implementation is for outbound Google Cloud Platform authentication.
3. **Secret Scanning:** The system proactively scans for leaked JWTs in its own output and tool results via `src/guardian/secret-scanner.ts`.
