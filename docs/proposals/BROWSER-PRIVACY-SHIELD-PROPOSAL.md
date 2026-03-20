# Proposal: Browser Privacy Shield, Tor Routing, and Guarded Dark Web OSINT

**Date:** 2026-03-20
**Status:** Draft
**Merged scope:** Browser privacy, Tor-routed anonymous access, and guarded dark web OSINT
**Cross-references:** [Browser Automation Spec](/mnt/s/Development/GuardianAgent/docs/specs/BROWSER-AUTOMATION-SPEC.md), [Agentic Defensive Security Suite Spec](/mnt/s/Development/GuardianAgent/docs/specs/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT-SPEC.md), [Browser Session Defense Skill](/mnt/s/Development/GuardianAgent/skills/browser-session-defense/SKILL.md)

---

## Executive Summary

GuardianAgent should treat browser privacy and Tor anonymity as one design problem, not two separate initiatives.

The practical model is:

- **Layer 0: Transport privacy** through optional Tor routing
- **Layer 1: Browser privacy hardening** for Guardian-managed browser sessions
- **Layer 2: Privacy-specific observability** through a separate privacy log and API surface
- **Layer 3: Guarded dark web OSINT** using curated seeds, read-only collection, and quarantine-first handling

This proposal consolidates the earlier privacy shield work and separate Tor research into a single implementation plan that is aligned with the current GuardianAgent runtime.

The proposal deliberately narrows v1 to what is realistic today:

- shared HTTP routing with `direct | tor | tor-preferred`
- Tor support for `web_fetch`, DuckDuckGo-style `web_search`, and threat-intel collection
- explicit anonymous Playwright browsing sessions
- a separate privacy activity log
- low-breakage browser privacy controls
- guarded onion discovery and monitoring for defensive OSINT

It explicitly defers features that the current runtime cannot implement safely or accurately:

- autonomous privacy countermeasures that mutate browser state through approval-gated tools
- request blocking based on auto-installed `browser_route`
- first-load fingerprint defenses that depend on an init-script primitive we do not currently expose
- claims of complete storage isolation across all browser persistence layers
- a generic dark web search or deep-crawl capability

---

## Why These Should Be One Proposal

The original two documents were directionally compatible, but their separation obscured the real architecture:

- Tor improves **network anonymity**
- browser privacy hardening reduces **browser-side tracking and fingerprinting**
- dark web access is a **transport and policy** problem first, not a browser-only feature

Tor is easier to ship first for network-level privacy, but it is not a substitute for browser privacy. Routing Chromium through Tor hides the source IP, but it does not provide Tor Browser's fingerprinting protections, first-party isolation, or storage hygiene. Conversely, browser privacy hardening without transport privacy still exposes the user's network identity to the destination.

The correct design is additive:

`Tor transport + browser privacy hardening + privacy observability + dark web guardrails`

---

## Problem Statement

Today, Guardian-managed browsing has three privacy gaps.

### 1. Network attribution

Without Tor or another anonymity layer, destinations can observe:

- the user's source IP or egress IP
- regional location and provider metadata
- correlations across unrelated browsing tasks

This affects normal web access, search, OSINT collection, and visits to suspicious or adversarial sites.

### 2. Browser-side tracking

Guardian-managed browser sessions can still expose:

- tracking cookies
- storage reuse across tasks
- referrer leakage
- WebRTC/IP leakage
- fingerprintable browser properties
- unnecessary browser permissions

### 3. Unsafe onion discovery assumptions

There is no complete, trustworthy, authoritative search index for onion services. Discovery is fragmented and noisy:

- many onion services are intentionally unlisted
- directories and indexes are incomplete
- some indexes are malicious, stale, or misleading
- some pages host illegal or dangerous content

If GuardianAgent adds dark web functionality, it must do so as a narrowly-scoped defensive OSINT capability with strict intake controls and operator guardrails.

---

## Design Principles

### 1. Privacy is a first-class defensive capability

GuardianAgent already protects endpoints, networks, and workflows. Privacy protection for Guardian-managed browsing is a natural extension of that mission.

### 2. Transport privacy and browser privacy are separate layers

Tor should be treated as an optional transport beneath tools and browser sessions. Browser privacy controls should remain valuable even when Tor is off.

### 3. Read-only by default

Dark web and anonymous browsing features should default to read-only behavior. Posting, purchases, messaging, uploads, authentication, and file execution are explicitly out of scope by default.

### 4. Observability without overloading the security model

Routine privacy findings should go to a separate privacy log, not the existing security alert/activity flows. Security escalation should happen only when a privacy finding also represents a security condition.

### 5. Match the current runtime boundary

The proposal must align with Guardian's current MCP browser surface, approval gates, event bus, and browser startup model instead of assuming primitives that do not yet exist.

---

## Current Runtime Constraints

The merged design is shaped by the current implementation:

- Playwright is started through configurable `playwrightArgs`, which makes proxy-based Tor routing realistic.
- Lightpanda is currently launched with fixed arguments and does not yet expose the same routing flexibility.
- The runtime emits a generic `tool.executed` event containing `toolName`, `args`, `result`, and `requestId`.
- There is no first-class `browser.navigate` event.
- There is no authoritative `browser.task_complete` event or browser-task lifecycle model.
- High-risk browser mutations such as evaluation, uploads, storage-state operations, and route interception are approval-sensitive and should not be assumed to run autonomously.

These constraints mean v1 should favor:

- transport-layer routing
- low-breakage browser flags and browser config
- warnings and policy checks
- privacy logging derived from existing tool execution telemetry

They also mean v1 should avoid:

- autonomous route injection
- autonomous page-script mutation
- claims of full storage sanitization
- task-boundary logic that depends on runtime events we do not have

---

## Proposed Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     GuardianAgent Privacy Stack              │
├───────────────────────────────────────────────────────────────┤
│ Layer 3: Guarded Dark Web OSINT                              │
│ Curated seeds, onion verification, quarantine-first fetch,   │
│ leak monitoring, ransomware leak watchlists, brand abuse     │
├───────────────────────────────────────────────────────────────┤
│ Layer 2: Privacy Observability                               │
│ Separate privacy log, privacy findings API, Tor-aware events │
│ derived from existing tool execution telemetry               │
├───────────────────────────────────────────────────────────────┤
│ Layer 1: Browser Privacy Hardening                           │
│ Low-breakage flags, WebRTC controls, permission denial,      │
│ referrer tightening, storage-state warnings, auth warnings   │
├───────────────────────────────────────────────────────────────┤
│ Layer 0: Transport Privacy                                   │
│ Shared HTTP routing: direct | tor | tor-preferred            │
│ Explicit Tor-routed Playwright sessions                      │
├───────────────────────────────────────────────────────────────┤
│ Underlay                                                      │
│ tor daemon (SOCKS5 + control), direct network, existing MCP  │
└───────────────────────────────────────────────────────────────┘
```

---

## Layer 0: Transport Privacy Through Tor

### Routing modes

All network-aware tools should support one of three routing decisions:

- `direct`
- `tor`
- `tor-preferred`

Definitions:

- `direct`: do not use Tor
- `tor`: fail closed unless Tor routing is available
- `tor-preferred`: use Tor when healthy; otherwise fall back to direct only if policy allows it

### Initial routing matrix

| Surface | V1 routing | Notes |
|--------|------------|-------|
| `web_fetch` | `tor-preferred` | Strong win for anonymous fetches and suspicious-site access |
| DuckDuckGo-style `web_search` | `tor-preferred` | Good fit because it is normal HTTP retrieval |
| Brave API search | `direct` | Provider still sees authenticated API key and query |
| Perplexity/OpenRouter search | `direct` | Same account-binding issue; Tor adds little privacy value |
| Threat intel clearnet OSINT | `tor-preferred` | Useful for suspicious targets and reputation protection |
| Onion sources | `tor` | Required |
| Playwright anonymous browsing | `tor` | Explicit operator-selected mode only |
| Lightpanda browsing | `direct` in v1 | Tor plumbing gap today |

### Circuit model

Tor circuit isolation should be handled conservatively.

V1:

- maintain separate logical circuit pools by purpose:
  - anonymous browsing
  - threat-intel / OSINT
  - onion monitoring
- use coarse boundaries such as `requestId` for privacy attribution
- do not assume a per-tool or per-turn `NEWNYM` is always desirable

Deferred:

- automatic circuit rotation on a first-class browser-session lifecycle
- strong guarantees tied to a `browser.task_complete` event

Rationale:

- Guardian does not yet have an authoritative browser task lifecycle
- Tor control operations such as `SIGNAL NEWNYM` are rate-limited and operationally expensive

### Implementation note

The first integration target should be a **shared HTTP transport abstraction** rather than one-off Tor logic in every tool. `ThreatIntelService` is already closer to this model because it accepts an injectable `fetchImpl`, while current `web_search` code still uses raw `fetch`.

---

## Layer 1: Browser Privacy Hardening

### Scope for v1

V1 browser privacy hardening should stay low-breakage and aligned with existing browser controls.

Recommended v1 controls:

- WebRTC leak prevention when Tor mode is enabled
- reduced background networking
- stricter referrer behavior
- `DNT` and `GPC` support where feasible
- deny-by-default for geolocation, microphone, camera, notifications, and similar permissions
- warnings before saving browser storage state
- warnings before form submission or authentication while Tor mode is active
- browser artifact sanitization review for stored screenshots, snapshots, traces, and state files

### What not to claim in v1

The earlier privacy shield proposal overreached in several places. V1 should **not** claim:

- complete storage isolation across cookies, IndexedDB, Cache Storage, service workers, and every other browser persistence layer
- first-request fingerprint resistance through `browser_evaluate`
- transparent tracker blocking through autonomous `browser_route` installation

Those claims depend on primitives or guarantees that are not currently present.

### Tor-specific browser warnings

When Tor mode is active, Guardian should surface explicit warnings before:

- logging into personal or organization accounts
- submitting forms with identifying content
- persisting cookies or storage state
- downloading files from untrusted onion or suspicious clearnet sources

These warnings matter because Tor transport alone does not prevent deanonymization through browser fingerprinting, account login, or operator behavior.

---

## Layer 2: Privacy Observability

### Separate privacy log

Routine privacy findings should live in a **dedicated privacy log**, not in the existing security alert/activity model.

Examples of privacy log events:

- Tor route used
- Tor route unavailable and fallback taken
- onion source accessed
- `Onion-Location` discovered
- privacy-sensitive form submission warning shown
- storage-state save attempted
- privacy policy blocked an action
- suspicious onion seed quarantined
- dark web source marked untrusted

### Relationship to security alerts

Privacy findings should only be promoted into security alerts when they represent a separate security issue, for example:

- malicious download attempt
- credential capture suspicion
- known ransomware leak site match
- file execution attempt from an untrusted onion source

### Event model

Do not add a first-class `browser.navigate` event in v1.

Instead, derive privacy observations from existing `tool.executed` telemetry for relevant browser tools such as:

- Playwright navigation tools
- Lightpanda navigation tools
- fetch/search tools

Do not add `browser.task_complete` in v1.

Instead:

- use `requestId` as the coarse privacy attribution boundary
- add an explicit `privacySessionId` later if and when Guardian gains a real privacy-session lifecycle

---

## Layer 3: Guarded Dark Web OSINT

### Position

Guardian should not implement "dark web search" as a broad user-facing search engine over onion content.

It **can** implement a constrained defensive OSINT capability built around:

- curated discovery seeds
- onion verification
- metadata-first inspection
- read-only collection
- quarantine-first handling

### Allowed seed sources

1. **Operator-supplied onion seeds**
   - manually curated onion addresses for monitoring

2. **Clearnet-to-onion associations**
   - `Onion-Location`
   - operator-published official onion mirrors
   - trusted organization-maintained onion directories

3. **Curated external indexes/directories**
   - used only as untrusted seed sources
   - never treated as authoritative truth
   - subject to allowlisting and quarantine

4. **References extracted from already-allowlisted pages**
   - onion links found in previously approved sources

### Discovery pipeline

```
seed source
  -> normalize onion address
  -> validate v3 format
  -> classify source trust
  -> fetch metadata only if allowed
  -> quarantine raw result
  -> produce summarized finding
  -> operator promotion to monitored source if approved
```

### Capabilities this enables

The practical defensive capabilities are:

- credential leak monitoring for known organization identifiers
- brand impersonation and phishing presence checks
- ransomware leak-site watchlists
- onion availability checks and change monitoring
- dark web IOC enrichment
- verification of official onion mirrors for known services
- correlation between known clearnet services and their onion counterparts
- passive watchlists for actor or infrastructure mentions relevant to a case

### Capabilities this does not justify

The existence of indexing sites does **not** justify:

- generic dark web search for arbitrary use
- autonomous deep crawling
- high-volume scraping of unknown onion services
- logging into onion services
- posting, messaging, purchasing, or payment workflows
- downloads that are not explicitly quarantined and policy-approved

---

## Dark Web Indexes and Directory Support

### Recommendation

Support dark web indexes only as **seed connectors**, not as trusted search providers.

That means Guardian may ingest candidate onion addresses or metadata from approved indexes, but it should:

- treat the index as untrusted
- keep all results quarantined until normalized and reviewed
- avoid presenting the index as a complete or authoritative view of the onion ecosystem

### Why this matters

Indexing sites are useful because they can:

- accelerate discovery of candidate onion services
- provide rough categorization or tags
- expose service metadata and uptime hints
- reduce operator effort for known monitoring cases

But they are risky because they are often:

- incomplete
- stale
- spoofed
- malicious
- contaminated with illegal or dangerous content references

So the product stance should be:

`directory-backed discovery, not directory-trusting search`

---

## Additional Tor Functionality Worth Considering

These are reasonable future additions, but they should remain behind explicit policy and operator controls.

### 1. Official onion mirror verification

Guardian can detect and monitor official onion mirrors for known services by using:

- operator-supplied official onion mappings
- `Onion-Location` hints observed on clearnet sites
- pinned clearnet-to-onion associations for approved targets

This enables:

- safer access to official services over Tor
- detection of spoofed or inconsistent mirror claims
- change monitoring when a known service rotates or republishes an onion address

Clarification:

- an "official onion mirror" usually means a service owner's own published onion endpoint, not a Guardian-hosted copy of that service
- Guardian's role is primarily discovery, verification, routing, and monitoring of trusted clearnet-to-onion associations
- Guardian clients should not be assumed to become onion mirrors for third-party services

### 2. Tor bridge and pluggable transport support

For censored or filtered networks, Guardian can support bridge-aware Tor operation instead of assuming a standard public-entry connection.

This enables:

- privacy features in regions or environments where Tor is blocked
- resilience testing for censorship and filtering conditions
- operator-selected bridge profiles for specialized deployments

### 3. Exit-node and relay awareness

Guardian can ingest Tor relay and exit-node intelligence into its existing monitoring surfaces.

This enables:

- identifying inbound or outbound Tor-related traffic that Guardian did not initiate
- explaining why a destination is seeing traffic from a known Tor exit
- correlating threat-intel observations with current Tor routing posture

### 4. Onion service uptime and change monitoring

Guardian can treat monitored onion services as watchlist targets with basic availability and content-drift checks.

This enables:

- notification when a leak site or impersonation site appears, disappears, or materially changes
- low-touch monitoring of high-value onion sources without interactive browsing
- evidence collection for investigations where persistence and timing matter

### 5. Future onion-service hosting for Guardian federation

This is a long-term option, not a near-term recommendation. If Guardian later gains a multi-node or federation model, onion services could provide a private inbound control or sharing channel.

This enables:

- location-hiding for inbound federation endpoints
- NAT/firewall-friendly peer connectivity
- self-authenticating service identities without normal DNS exposure

Potential deployment model to consider:

- default clients remain outbound-only
- the first onion-backed endpoint would more likely be Guardian Hub or a small number of designated relay/control nodes
- selected client agents could optionally host onion-service endpoints later where inbound reachability or location-hiding is required
- per-client onion hosting should not be the default because it increases operational complexity, key management burden, and exposed attack surface

This should stay deferred until Guardian has a clear federation architecture and a stronger operational model for long-lived remote trust.

---

## Risks

### 1. Illegal and harmful content exposure

Some onion indexes and linked services can expose:

- CSAM
- violent extremist content
- drug marketplaces
- stolen credentials
- malware
- fraud infrastructure

Guardian must never treat discovery as harmless browsing.

### 2. Malware and payload handling

Unknown onion services can host:

- weaponized documents
- exploit kits
- droppers
- booby-trapped archives
- fake index or phishing pages

Any download path must route into quarantine-first handling and never into automatic execution.

### 3. Prompt injection and content poisoning

Dark web pages are highly adversarial content sources. They can intentionally:

- manipulate the model
- induce unsafe navigation
- request credentials or uploads
- try to trigger policy-violating behavior

Any agentic summarization path must preserve strong tool-policy separation and favor low-trust parsing.

### 4. Deanonymization and OPSEC failure

Tor transport is not enough on its own. Operators can still deanonymize themselves or their organization through:

- account login
- submitted forms
- distinctive browser fingerprints
- downloading and opening files outside the guarded environment
- mixing Tor and non-Tor identities in the same workflow

### 5. Legal, policy, and reputational exposure

Automated access to dark web sources can create legal or policy problems depending on jurisdiction, content category, and operator role. The product must support policy-based restrictions and make read-only operation the default.

### 6. False confidence from incomplete coverage

Dark web indexes are partial. A monitored set built from indexes alone will miss unlisted, private, short-lived, or invitation-based services. The system must not imply comprehensive discovery.

---

## Guardrails

### Default operating posture

- read-only by default
- no authentication by default
- no posting, messaging, or purchases
- no uploads
- no automatic file execution
- no autonomous navigation fan-out from unknown onion pages

### Intake guardrails

- allowlist approved index and directory sources
- classify each seed source by trust level
- quarantine raw results before surfacing summaries
- validate onion addresses before any fetch
- reject invalid, non-v3, malformed, or obviously suspicious inputs

### Browsing guardrails

- explicit user/operator opt-in for Tor browser sessions
- warnings before auth or form submission on Tor
- dedicated circuit separation between anonymous browsing and threat-intel monitoring
- HTTPS-only policy for Tor-routed clearnet requests where applicable

### Artifact guardrails

- store downloads in quarantine only
- sanitize and label browser artifacts
- treat screenshots, traces, and state files as privacy-sensitive artifacts

---

## Configuration Model

Illustrative configuration:

```yaml
assistant:
  tools:
    tor:
      enabled: true
      socksProxy: socks5://127.0.0.1:9050
      controlPort: 9051
      controlAuth: cookie
      routes:
        webFetch: tor-preferred
        webSearchDuckDuckGo: tor-preferred
        webSearchBrave: direct
        webSearchPerplexity: direct
        threatIntel: tor-preferred
        onionSources: tor
        playwrightAnonymousBrowsing: tor
        lightpanda: direct
    browser:
      privacy:
        enabled: true
        level: standard
        globalPrivacyControl: true
        doNotTrack: true
        strictReferrerPolicy: true
        denyPermissions:
          - geolocation
          - microphone
          - camera
          - notifications
        warnOnStorageStateSave: true
        warnOnTorAuth: true
        warnOnTorFormSubmit: true
        enforceWebRtcLeakProtectionOnTor: true
    privacy:
      logging:
        enabled: true
        separateLog: true
      darkweb:
        enabled: true
        mode: guarded
        allowIndexSeeds: true
        allowlistedSeedSources:
          - official-onion-mirrors
          - approved-darkweb-directory
        quarantineDownloads: true
        readOnly: true
        allowAuthentication: false
        allowPosting: false
        allowPayments: false
```

---

## Implementation Plan

### Phase 1: Foundation

- create merged privacy/Tor config model
- introduce separate privacy log and API surface
- add shared HTTP transport abstraction with `direct | tor | tor-preferred`
- route `web_fetch` and DuckDuckGo-style `web_search` through the shared transport
- expose privacy findings for Tor use, Tor fallback, and policy blocks

### Phase 2: Anonymous Fetch and OSINT

- route threat-intel HTTP collection through the shared transport
- add onion URL validation and quarantine-first fetch handling
- add guarded seed-source ingestion for onion discovery
- support monitored onion watchlists and change detection

### Phase 3: Explicit Playwright Tor Sessions

- add explicit anonymous Playwright mode using proxy-based startup
- add Tor-mode warnings for auth, forms, downloads, and storage-state saves
- keep Lightpanda direct-only until routing support exists

### Phase 4: Low-Breakage Browser Privacy Hardening

- WebRTC leak prevention in Tor mode
- permission denial defaults
- referrer tightening
- DNT/GPC support where feasible
- browser artifact labeling and sanitization review

### Phase 5: Privacy Session Model

Only after the above ships and stabilizes:

- introduce `privacySessionId`
- add stronger session-boundary semantics
- improve circuit-pool assignment and privacy attribution

### Explicitly Deferred

The following items are intentionally deferred unless the runtime changes:

- autonomous `browser_route` tracker blocking
- `browser_evaluate`-based init-script fingerprint resistance
- complete storage isolation claims
- autonomous privacy agents that mutate browser state without operator approval
- generic dark web search and deep crawl

---

## Decisions Captured From Review

- Privacy findings should use a **separate privacy log**, not the existing security alert/activity model.
- Do **not** add `browser.navigate` in v1; derive observations from `tool.executed`.
- Do **not** add `browser.task_complete` in v1; use `requestId` as the coarse attribution boundary until a real privacy session model exists.
- Tor is the fastest privacy win for network-level anonymity, but it does not replace browser privacy hardening.
- Dark web functionality should be framed as guarded OSINT, not search.

---

## Recommendation

Adopt this merged proposal as the canonical plan.

Implementation should start with the smallest high-value slice:

1. shared Tor-aware HTTP transport
2. separate privacy log
3. guarded onion seed ingestion and watchlists
4. explicit Playwright Tor sessions
5. low-breakage browser privacy controls

This sequence delivers meaningful privacy improvements quickly without overcommitting Guardian to browser primitives or autonomy that the current runtime does not yet support.
