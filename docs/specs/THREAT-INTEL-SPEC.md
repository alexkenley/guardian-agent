# Threat Intel Spec

## Goal
Add a built-in personal protection layer that helps users detect and respond to:
- Impersonation and deepfake content
- Scam/fraud narratives targeting the user
- Malicious or coordinated misinformation about configured identities

## Scope
- Runtime service: `ThreatIntelService`
- Web: dedicated `#/intel` tab
- CLI: `/intel` command group
- Telegram: `/intel` quick commands
- API endpoints under `/api/threat-intel/*`

## Safety Model
- Collection and triage can be automated.
- External response actions are drafted first.
- High-risk actions (`report`, `request_takedown`, `publish_response`) are approval-gated by default.
- Every scan/action status update is tracked in analytics and audit channels.

## Configuration
`assistant.threatIntel`:
- `enabled: boolean`
- `allowDarkWeb: boolean`
- `responseMode: manual | assisted | autonomous`
- `watchlist: string[]`
- `autoScanIntervalMinutes: number` (0 disables background scan)
- `moltbook` connector settings:
  - `enabled`
  - `mode: mock | api`
  - `baseUrl`, `searchPath`, `apiKey`
  - `requestTimeoutMs`, `maxPostsPerQuery`, `maxResponseBytes`
  - `allowedHosts` (hard allowlist)
  - `allowActiveResponse` (default false)

## Runtime Behavior
1. Watchlist + on-demand queries define scan targets.
2. Scan output creates findings with:
   - severity
   - confidence
   - source type
   - status workflow (`new`, `triaged`, `actioned`, `dismissed`)
3. Hostile-site enforcement for Moltbook:
   - requests only to allowlisted hosts
   - HTTPS required (except localhost dev)
   - redirect following disabled
   - response size + timeout guardrails
   - payload sanitization + suspicious marker detection events
3. Findings can be converted into drafted response actions.
4. Auto-scan loop runs on interval when enabled and watchlist is non-empty.
5. High/critical findings are surfaced into audit anomalies.
6. `publish_response` actions are blocked for hostile forums unless connector explicitly allows active publishing.

## API Surface
- `GET /api/threat-intel/summary`
- `GET /api/threat-intel/plan`
- `GET /api/threat-intel/watchlist`
- `POST /api/threat-intel/watchlist` (`action=add|remove`, `target`)
- `POST /api/threat-intel/scan`
- `GET /api/threat-intel/findings`
- `POST /api/threat-intel/findings/status`
- `GET /api/threat-intel/actions`
- `POST /api/threat-intel/actions/draft`
- `POST /api/threat-intel/response-mode`

## CLI Surface
- `/intel [status]`
- `/intel plan`
- `/intel watch [list|add|remove] <target>`
- `/intel scan [query] [--darkweb] [--sources=web,news,social,forum,darkweb]`
- `/intel findings [limit] [status]`
- `/intel finding <id> status <new|triaged|actioned|dismissed>`
- `/intel actions [limit]`
- `/intel action draft <findingId> <report|request_takedown|draft_response|publish_response>`
- `/intel mode <manual|assisted|autonomous>`

## Telegram Surface
- `/intel status`
- `/intel scan <query> [--darkweb]`
- `/intel findings`

## Web UX
- Summary cards for coverage and risk posture
- Watchlist add/remove controls
- Scan controls (sources + darkweb toggle)
- Findings triage table with status updates
- Action-draft queue table
- Built-in phased operating plan panel

## Future Connectors
- Replace simulated source scans with provider connectors (search APIs, social/forum integrations, takedown/report APIs).
- Add provenance verification checks (C2PA manifest validation) for media findings.
- Add optional forum responders (for example Moltbook-like communities) behind per-platform policy adapters + human approval gates.
