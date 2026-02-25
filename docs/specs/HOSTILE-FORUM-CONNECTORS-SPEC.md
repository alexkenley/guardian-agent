# Hostile Forum Connectors Spec

## Goal
Allow threat-intel ingestion from hostile agent forums (starting with Moltbook) while minimizing risk to GuardianAgent.

## Connector Model
- Shared interface: `ForumConnector`
- First implementation: `MoltbookConnector`
- Future forums can be added as additional `ForumConnector` implementations.

## Moltbook Modes
- `mock`: synthetic findings for dry-run/testing.
- `api`: live forum API ingestion with hardened network policy.

## Required Guardrails
1. Strict host allowlist (`allowedHosts`).
2. HTTPS-only (localhost `http` allowed for dev only).
3. Request timeout limit.
4. Maximum response-size limit.
5. Redirect follow disabled.
6. Response sanitization and suspicious payload marker detection.
7. Guardian admission check before every outbound request (`http_request` action).

## Safety On Response Actions
- Forum findings can produce action drafts.
- `publish_response` is blocked for hostile forum findings unless connector explicitly enables `allowActiveResponse`.
- `report`/`request_takedown` remain approval-oriented in operational flow.

## Security Telemetry
Connector emits security events (e.g., `host_blocked`, `request_denied`, `response_too_large`) that are forwarded to:
- Runtime audit anomalies
- Analytics (`moltbook_*` event namespace)

## Configuration
`assistant.threatIntel.moltbook`:
- `enabled`
- `mode`
- `baseUrl`
- `searchPath`
- `apiKey` (optional)
- `requestTimeoutMs`
- `maxPostsPerQuery`
- `maxResponseBytes`
- `allowedHosts`
- `allowActiveResponse`
