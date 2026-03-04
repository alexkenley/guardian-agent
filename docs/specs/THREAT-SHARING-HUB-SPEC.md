# Threat Intelligence Sharing Hub

> **Status:** Proposed
> **Date:** 2026-03-04
> **Author:** Design discussion

## Problem Statement

Individual GuardianAgent instances detect threats in isolation. An attacker blocked by one node can freely target others. There is no mechanism for collective defense — each installation starts from zero knowledge.

## Solution

A federated threat intelligence sharing network where GuardianAgent instances report, correlate, and consume threat indicators through a central hub. Verified intelligence flows back to nodes to trigger automated hardening, monitoring, and hunting.

## Design Goals

- **Early warning**: Nodes learn about threats before they arrive locally
- **Poison-resistant**: Malicious submissions cannot trigger false blocks or hide real threats
- **Privacy-preserving**: Nodes share indicators, never internal data or configs
- **Graduated response**: Intel trust level determines automation level
- **Zero inbound**: Nodes connect outbound only; no open ports required

---

## Architecture Overview

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ GuardianAgent │     │ GuardianAgent │     │ GuardianAgent │
│   Node A      │     │   Node B      │     │   Node C      │
│               │     │               │     │               │
│ ThreatShare   │     │ ThreatShare   │     │ ThreatShare   │
│   Agent       │     │   Agent       │     │   Agent       │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │ POST /submit       │ POST /submit       │ POST /submit
       │ GET  /feed         │ GET  /feed         │ GET  /feed
       │ WS   /stream       │ WS   /stream       │ WS   /stream
       ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│                    Sharing Hub                           │
│                                                         │
│  ┌─────────┐  ┌────────────┐  ┌──────────┐  ┌───────┐ │
│  │ Ingest  │→ │ Correlation│→ │Reputation│→ │  Feed │ │
│  │ & Dedup │  │  Engine    │  │  Scoring │  │ Store │ │
│  └─────────┘  └────────────┘  └──────────┘  └───────┘ │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Canary Traps │  │ Allowlist    │  │ Web Dashboard │ │
│  └──────────────┘  └──────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Trust & Verification Model

### Node Identity

Each GuardianAgent instance generates an ed25519 keypair on first connection. The public key becomes the node's permanent identity. All submissions are cryptographically signed.

```yaml
node_identity:
  algorithm: ed25519
  public_key: "base64-encoded"
  registered: "2026-03-04T00:00:00Z"
  reputation_score: 0.5  # starts neutral, range [0.0, 1.0]
```

### Trust Levels

Intel progresses through trust tiers based on independent corroboration:

| Level | Criteria | Local Action |
|-------|----------|--------------|
| `RAW` | Single report, unverified | Store locally, no action |
| `CORRELATED` | 3+ independent nodes report same IOC | Add to watchlist, passive monitoring |
| `CONFIRMED` | 5+ nodes OR 1 high-rep + 2 others | Active monitoring, alert on match |
| `ACTIONABLE` | Confirmed + remediation steps attached | Auto-harden (if enabled) or queue for approval |

### Reputation Scoring

Node reputation adjusts over time based on submission quality:

- **Corroborated submission**: +0.02 (others independently confirm)
- **Unique-but-valid submission**: +0.01 (later confirmed by others)
- **Unconfirmed after TTL**: -0.005 (noise, but not necessarily malicious)
- **Contradicts known-good allowlist**: -0.05 (reported Google DNS as threat, etc.)
- **Canary trap leak detected**: reputation → 0.0, node flagged

Score is clamped to `[0.0, 1.0]`. Nodes below 0.1 are silently ignored (shadow ban — they don't know their submissions are discarded).

### Anti-Poisoning Defenses

| Attack Vector | Defense |
|---------------|---------|
| Flood false IOCs | Rate limit per identity (10 submissions/min) + reputation gate |
| Report legitimate services as threats | Cross-reference against known-good allowlists (major CDNs, DNS providers, cloud ranges) |
| Sybil attack (many fake identities) | Proof-of-work challenge on registration + correlation requires diverse /24 subnets |
| Replay stale intel | TTL expiry on all IOCs + temporal freshness weighting |
| Targeted poisoning (block victim's IP) | Private/reserved ranges rejected; single-target IOCs require higher trust threshold |
| Man-in-the-middle | TLS + submission signatures verified against registered public key |
| Hub compromise | Nodes validate hub responses against signed submission chain; anomaly detection on feed |

### Canary Traps

The hub periodically injects unique synthetic IOCs targeted to specific nodes. These IOCs:
- Are plausible but fictional (non-routable IPs, fake hashes)
- Are unique per recipient — if they appear elsewhere, the source is identified
- Help detect compromised nodes or data exfiltration

---

## Indicator Schema

```yaml
indicator:
  id: "uuid-v4"
  type: ip | domain | hash | url | cve | pattern | behavior
  value: "203.0.113.45"
  context: "Scanning SSH port 22, rotating credentials every 30s"
  category: brute-force | malware | phishing | exfiltration | scanning | exploit
  severity: low | medium | high | critical
  tags: [ssh, credential-stuffing, automated]
  first_seen: "2026-03-04T12:00:00Z"
  last_seen: "2026-03-04T14:30:00Z"
  ttl: 86400            # seconds until expiry unless refreshed
  trust_level: raw      # promoted by hub as corroboration arrives
  reporter_count: 1     # how many independent nodes reported this
  source_signature: "<ed25519 signature over id+type+value+first_seen>"

  # Optional enrichment (added by hub or high-rep nodes)
  remediation:
    - action: firewall_block
      target: "203.0.113.45"
      confidence: 0.95
    - action: config_change
      description: "Disable password auth for SSH, require key-based only"
```

### Behavior Indicators

Beyond simple IOCs, nodes can share attack patterns:

```yaml
indicator:
  type: behavior
  value: "sequential-port-scan-then-ssh-brute"
  context: |
    1. SYN scan on ports 22, 80, 443, 8080, 3389 (in order, <1s interval)
    2. If port 22 open: SSH brute force with top-1000 passwords
    3. Rotates source IP every 50 attempts
  category: scanning
  severity: high
  tags: [multi-stage, automated, ssh]
```

Behavior patterns are more durable than IP-based IOCs since attackers rotate infrastructure but reuse tactics.

---

## Hub API

### Endpoints

```
POST   /api/v1/register          # Register node, submit public key, complete PoW challenge
POST   /api/v1/submit            # Submit signed indicator
GET    /api/v1/feed              # Poll for intel (supports ?since=<timestamp>&min_trust=correlated)
WS     /api/v1/stream            # Real-time push (WebSocket)
POST   /api/v1/feedback          # Report effectiveness ("blocked 14 attempts matching IOC X")
GET    /api/v1/stats             # Network-wide statistics
GET    /api/v1/health            # Hub health check
```

### Authentication

- All requests include `Authorization: Bearer <signed-timestamp>` (node signs current timestamp with private key)
- Hub verifies signature against registered public key
- Replay protection: timestamp must be within 60s of server time

### Feed Response

```json
{
  "indicators": [...],
  "since": "2026-03-04T14:00:00Z",
  "next_cursor": "abc123",
  "network_stats": {
    "active_nodes": 47,
    "indicators_24h": 312,
    "confirmed_24h": 28
  }
}
```

---

## Local Agent: ThreatShareAgent

### Agent Definition

```typescript
class ThreatShareAgent extends BaseAgent {
  id = 'threat-share';
  capabilities = ['network', 'read_files'];

  // Generate/load ed25519 keypair, register with hub
  async onStart(ctx) { ... }

  // Handle user queries: "what's the threat landscape?"
  async onMessage(ctx, message) { ... }

  // React to local detections and incoming intel
  async onEvent(ctx, event) { ... }

  // Periodic feed pull + hardening sweep
  async onSchedule(ctx, schedule) { ... }
}
```

### Event-Triggered Responses

```
Event: guardian:audit:blocked
  → Package blocked action as indicator
  → Sign with node key
  → POST to hub /submit
  → Log submission to local audit trail

Event: hub:intel:new (from feed pull or WebSocket)
  → Evaluate trust level
  → If trust >= CORRELATED:
    → Add to ThreatIntelService watchlist
    → Emit guardian:threat:watch
  → If trust >= CONFIRMED:
    → Emit guardian:threat:alert
    → Trigger retroactive hunt (scan local logs for indicator)
  → If trust >= ACTIONABLE && auto_harden enabled:
    → Emit guardian:threat:harden with remediation steps
    → Apply low-risk remediations automatically
    → Queue high-risk changes for human approval
```

### Cron Schedules

```
*/15 * * * *  → Pull hub feed, ingest new indicators
*/60 * * * *  → Hardening sweep: compare local config against actionable intel
0 */6 * * *   → Full retroactive hunt: scan 7-day log window against all confirmed IOCs
0 0 * * *     → Prune expired indicators, report daily summary
```

### Retroactive Hunting

When a new confirmed IOC arrives, the agent scans historical data:

1. Search connection logs for matching IPs/domains
2. Search file system for matching hashes (if applicable)
3. Search conversation history for matching URLs/patterns
4. Report findings back to hub (increases confidence score)
5. Alert locally if historical matches found ("this IP was in your logs 3 days ago")

---

## Hardening Pipeline

When actionable intel arrives, the agent generates hardening tasks:

```
Intel: SSH brute-force campaign from 203.0.113.0/24
  → Recommended actions:
    1. [AUTO] Add IP range to firewall deny list
    2. [AUTO] Add to ThreatIntelService watchlist
    3. [APPROVE] Disable SSH password auth, require keys only
    4. [APPROVE] Change SSH port from 22 to non-standard
    5. [INFORM] Check for successful logins from this range in auth.log
```

Actions are classified by risk:

| Risk Level | Behavior |
|------------|----------|
| **Low** (watchlist, monitoring) | Auto-apply if `auto_harden: true` |
| **Medium** (firewall rules, config tightening) | Queue for approval via CLI/Web/Telegram |
| **High** (service restart, port change, access revocation) | Require explicit human confirmation |

---

## Configuration

```yaml
assistant:
  threatSharing:
    enabled: false
    hub:
      url: "https://hub.guardianagent.net"
      # Or self-hosted:
      # url: "https://your-hub.internal:8443"
    identity:
      keyPath: "~/.guardianagent/threat-share.key"
    feed:
      pollInterval: 900          # seconds (15 min)
      minTrustLevel: correlated  # minimum trust to ingest
      useWebSocket: true         # real-time push when available
    submission:
      autoReport: true           # auto-submit local detections to hub
      includeContext: true        # include textual context with IOCs
      rateLimitPerMin: 10
    hardening:
      autoHarden: false          # auto-apply low-risk remediations
      approvalChannel: cli       # where to send approval requests
      retroactiveHuntDays: 7     # how far back to scan on new IOC
    privacy:
      anonymizeNodeId: false     # use derived ID instead of raw pubkey
      excludeCategories: []      # never share these indicator types
```

---

## Privacy Considerations

- Nodes share **indicators only**, never internal logs, configs, or user data
- Submissions include context text that the node controls — sensitive details can be omitted
- `anonymizeNodeId` derives a rotating pseudonym from the keypair (unlinkable across periods)
- `excludeCategories` lets nodes opt out of sharing certain indicator types
- Hub stores minimal metadata: indicator, signature, timestamp, node ID
- Hub does NOT log source IPs of connecting nodes (Tor/VPN friendly)
- Nodes can operate in **receive-only mode** (consume feed, never submit)

---

## Phased Implementation

### Phase 1: Minimal Viable Network
- ThreatShareAgent with keypair generation and hub registration
- Hub: Express/Fastify REST API with SQLite storage
- Simple submission and feed endpoints
- Trust = vote count (3+ reporters = correlated)
- Local action: update ThreatIntelService watchlist on feed pull
- No auto-hardening, no WebSocket, no reputation scoring

### Phase 2: Trust & Verification
- Ed25519 signature verification on all submissions
- Reputation scoring system
- Known-good allowlist cross-referencing
- Canary trap injection
- Sybil resistance via proof-of-work registration

### Phase 3: Real-Time & Automation
- WebSocket streaming for real-time intel push
- Retroactive hunting on new IOC arrival
- Graduated auto-hardening pipeline
- Effectiveness feedback loop (nodes report back on blocks)
- Behavior pattern sharing (not just atomic IOCs)

### Phase 4: Federation & Scale
- Hub-to-hub federation (organizations run private hubs that peer)
- Gossip protocol for hub redundancy
- Sector-specific feeds (healthcare, finance, infrastructure)
- Machine learning on submission patterns to detect coordinated poisoning
- Web dashboard for network-wide threat visualization

---

## Open Questions

1. **Hub hosting**: Central hosted service vs. self-hosted vs. federated from day one?
2. **Incentive model**: Should nodes that contribute more intel get earlier/richer feeds?
3. **Legal**: What are the liability implications of sharing threat intel that triggers automated blocking?
4. **Overlap with existing standards**: Should indicators use STIX/TAXII format for interop with existing threat intel platforms?
5. **Offline mode**: How should nodes behave when the hub is unreachable? Local cache with TTL?
6. **Indicator attribution**: Should the hub reveal which nodes reported an indicator, or keep reporters anonymous to other nodes?
