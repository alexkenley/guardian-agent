# Proposal: Secure Operator Communications Network for Guardian

**Date:** 2026-04-01
**Status:** Draft
**Related:** [Threat Intelligence Sharing Hub](THREAT-SHARING-HUB-PROPOSAL.md), [Multi-User Server + Client Agent Proposal](MULTI-USER-CLIENT-AGENT-PROPOSAL.md), [Browser Privacy Shield, Tor Routing, and Guarded Dark Web OSINT](BROWSER-PRIVACY-SHIELD-PROPOSAL.md), [Control Plane Hardening](CONTROL-PLANE-HARDENING-PROPOSAL.md)

This proposal is a companion to Threat Sharing Hub, not a replacement for it.

- Threat Sharing Hub is a structured, evidence-backed intelligence exchange.
- This document covers a secure operator-to-operator communications channel between Guardian instances.

## Executive Summary

Guardian can support secure inter-instance operator communications without making a centralized server the only option, but a fully serverless peer-to-peer mesh is the wrong default architecture for v1.

The practical recommendation is a **hybrid model**:

- direct peer connections when available
- small shared infrastructure for enrollment, discovery, revocation, and relay/mailbox fallback
- rotating operator-managed contact codes instead of globally searchable public identifiers
- end-to-end encrypted application-layer messages
- post-quantum-hybrid session establishment where the stack is mature enough
- strict message typing and approval boundaries so received messages cannot become an implicit remote-execution bus

The research result is:

- **Best off-the-shelf stopgap:** self-hosted Matrix if we need operator chat quickly and can accept current non-post-quantum messaging crypto plus homeserver metadata exposure
- **Best strategic fit:** a Guardian-native secure channel built from open-source components such as `libp2p`, `WireGuard`/`Headscale`, `OpenMLS`, and post-quantum libraries, rather than adopting a general-purpose messenger wholesale
- **Best pure post-quantum reference design:** Signal's PQXDH work, but Signal's server model is centralized and not a clean fit for Guardian federation or embedded control-plane workflows

## Problem Statement

Threat Sharing Hub was framed as a bulletin board for structured threat intelligence and agent-facing exchange. That does not fully solve the operator communications problem.

Guardian also needs a secure channel for:

- operator-to-operator coordination across Guardian deployments
- case discussion and escalation
- approvals and out-of-band confirmation
- incident handoff
- selected machine-generated alerts routed into human conversation

This channel needs different properties from a threat-intel feed:

- conversational and low-latency
- strongly authenticated
- encrypted end-to-end
- resistant to replay, impersonation, and message forgery
- compatible with outbound-only and NAT-constrained deployments
- safe against compromised or malicious autonomous agents using the channel as an attack path

## Requirements

### Functional

- 1:1 conversations between Guardian operators
- small group/room support
- offline delivery or delayed delivery
- self-hosted deployment option
- API-friendly envelope format so Guardian can integrate natively
- outbound-only connectivity for most nodes

### Security

- mutual authentication between Guardian instances
- end-to-end encryption independent of relay infrastructure
- forward secrecy
- harvest-now-decrypt-later mitigation through hybrid post-quantum key establishment where feasible
- key rotation and revocation
- attachment quarantine and safe rendering
- replay protection, flood control, and tamper-evident auditability

### Governance / Safety

- tenant or organization scoped enrollment
- explicit allowlists for trusted peers
- operator-visible provenance for every message
- no remote action execution directly from inbound chat content
- policy evaluation for machine-originated messages

## What "Agentic Attack Resistant" Means Here

Transport encryption is necessary but not sufficient.

For Guardian, resistance to agentic misuse means the communications layer must assume that one participating endpoint may be partially compromised, autonomous, or malicious. The channel therefore needs these invariants:

- inbound messages are **data**, not instructions
- no received message can directly trigger tool execution
- machine-originated messages use a separate typed lane from human chat
- attachments and pasted artifacts are treated as untrusted content
- room membership changes are signed, logged, and operator-visible
- peer enrollment and revocation are controlled by Guardian policy, not ad hoc trust-on-first-use by default
- abusive peers can be rate-limited, suspended, or revoked without breaking the rest of the network

This is the main reason not to treat "use an encrypted messenger" as the full answer.

## Centralized vs Decentralized

### Option A: Centralized service

One server or small cluster handles identity, mailbox, and relay.

**Pros**

- simplest enrollment and revocation
- straightforward audit and retention controls
- easiest to implement operator UX quickly
- easiest abuse handling

**Cons**

- single metadata concentration point
- single operational choke point
- not resilient to central outage or takedown

### Option B: Federated service

Each organization runs its own homeserver/control node and federates with others.

**Pros**

- avoids a single global operator
- strong organizational control boundaries
- good fit for inter-org trust relationships

**Cons**

- more protocol complexity
- more metadata still lives on homeservers
- harder cross-server safety and moderation policy

### Option C: Fully decentralized / pure P2P

No fixed server role; peers discover and connect directly, with optional DHTs or ad hoc relays.

**Pros**

- lowest central dependency
- potentially best censorship resistance
- good for location-hiding and direct peer exchange

**Cons**

- hardest NAT traversal and offline delivery story
- identity recovery and revocation become much harder
- abuse handling and Sybil resistance are harder
- operator-grade audit and policy enforcement are harder
- many "decentralized" systems still need mailbox, rendezvous, or relay components in practice

### Recommendation

Guardian should use a **hybrid architecture**:

- centralized or federated identity and revocation
- direct peer data paths where possible
- relay/mailbox fallback when direct paths fail
- optional onion/relay transport for selected high-risk deployments

This gives us most of the practical value of decentralization without inheriting the full cost of a pure mesh.

## Open Source Options Reviewed

| Option | Topology | Strengths | Gaps for Guardian | Assessment |
|--------|----------|-----------|-------------------|------------|
| Matrix (`Synapse`/Element ecosystem) | Client/server with federation | Mature rooms, self-hosting, E2EE, federation | Current Matrix crypto is Olm/Megolm; Matrix-over-MLS is still an ongoing effort; homeservers still see metadata; heavy stack | Best off-the-shelf stopgap if we need operator chat soon |
| Signal Protocol + `signal-server` | Centralized service | Strongest reviewed post-quantum story via PQXDH; mature E2EE model | Centralized server model; not designed as Guardian-native federation substrate | Best security reference, weak product fit |
| Briar | P2P over Tor/Bluetooth/Wi-Fi with mailbox fallback | Strong censorship resistance; no central server required; offline/local transport story | Android-centric; not a clean fit for desktop/server Guardian workflows; no reviewed production PQ story | Good inspiration for high-risk or blackout scenarios, not primary base |
| Jami | P2P over DHT | No central authority; cross-platform; built for direct communication | Not Guardian-native; control-plane integration is weak; no reviewed production PQ story | Possible but not preferred |
| SimpleX / SimpleXMQ | Relay-based decentralized messaging | Strong metadata minimization; self-hostable relays; no persistent user identifiers in the reviewed design note | Still needs relay infrastructure; not Guardian-native; no reviewed production PQ story | Good watchlist candidate, not first choice |
| Tox | Fully distributed messenger | Pure P2P design | Official docs still describe it as incomplete and clients as not stable/finished | Reject for production Guardian use |
| Headscale + WireGuard | Central control plane, encrypted mesh transport | Strong private-network substrate, direct encrypted tunnels, good for outbound-first node meshes | Not a messaging protocol; WireGuard PQ posture is only defense-in-depth via optional PSK, not a complete app-layer answer | Strong transport substrate, not a full solution |
| `libp2p` + `OpenMLS` + PQ libraries | Custom hybrid | Guardian owns envelope semantics, direct P2P + relay fallback, strong integration potential | Highest engineering cost; PQ group messaging stack is still uneven | Best strategic fit |

## Research Notes By Option

### Matrix

Matrix remains the most mature open-source ecosystem for self-hosted secure team chat with federation. It is the easiest way to get rooms, memberships, message history, and cross-organization connectivity.

However, Matrix's current deployed cryptography is still rooted in Olm/Megolm. Matrix has been working toward MLS, and the Matrix team explicitly described decentralized MLS support as an ongoing effort. That makes Matrix a reasonable **near-term operational stopgap**, but not the clearest answer if post-quantum readiness is a hard requirement from day one.

### Signal

Signal has the strongest reviewed public post-quantum story. Signal announced PQXDH in September 2023 and described it as combining X25519 with CRYSTALS-Kyber to protect against future quantum attacks. That is directly relevant to the Guardian requirement for harvest-now-decrypt-later risk reduction.

The problem is architectural fit. Signal's open-source server is still a centralized server product supporting Signal clients. It is not a clean drop-in foundation for Guardian-native federation, structured policy envelopes, or server-optional relay topologies.

**Conclusion:** borrow from Signal's protocol direction, not necessarily from Signal's product topology.

### Briar

Briar is one of the strongest examples of genuinely decentralized secure messaging. Its model is useful because it proves that direct encrypted messaging, Tor transport, and non-Internet fallback can work in practice.

For Guardian, the fit is still limited:

- the product is oriented around human mobile messaging
- desktop/server integration is not the primary use case
- it does not solve Guardian-native typed workflows, policy hooks, or operator audit by itself

### Jami

Jami is a real peer-to-peer, cross-platform communication system with no central authority and a DHT-based model. That makes it more relevant than Briar for desktop environments.

But it still has the same core issue: it is a general-purpose communications product, not a Guardian-native trust, policy, and workflow substrate.

### SimpleX

SimpleX is interesting because its published design emphasizes metadata minimization and avoiding persistent user identifiers visible to the network and servers. That is a meaningful property for a Guardian communications system.

The fit is still incomplete for Guardian:

- it still relies on relay infrastructure rather than eliminating shared infrastructure entirely
- it is not designed around Guardian-native typed workflows, policy gates, or audit
- I did not find a reviewed production post-quantum story in the material used here

### Tox

Tox is attractive on paper because it is fully distributed, but its own documentation still warns that Tox is not complete and that clients are not finished, feature-complete, or stable. That is disqualifying for a security-sensitive Guardian operator network.

### Headscale + WireGuard

This is not a messaging stack, but it is a useful transport option. A Headscale-managed WireGuard mesh can give Guardian instances a private encrypted network with direct tunnels between nodes when routing allows it.

This matters because a secure overlay can dramatically simplify the higher-level messaging problem:

- discovery is easier
- authenticated addressing is easier
- inbound exposure can remain tightly controlled
- transport confidentiality is strong even before application-layer encryption

WireGuard also supports an optional pre-shared key mixed into the handshake for additional protection, which its documentation explicitly notes can be useful for post-quantum resistance. That is not the same thing as a complete post-quantum messaging design, but it is a useful defense-in-depth layer.

### `libp2p`, `OpenMLS`, and post-quantum libraries

This is the cleanest path if Guardian wants to own the protocol and UI rather than embed a third-party messenger.

`libp2p` gives us:

- direct P2P transport
- support for encrypted channels via TLS or Noise
- NAT traversal and relay support
- a modular, application-owned networking model

`OpenMLS` gives us an open-source implementation of MLS for group messaging semantics. However, the current `OpenMLS` book lists classical ciphersuites such as X25519 and P-256, so a fully production-ready post-quantum group story is not "done" just by choosing MLS today.

For post-quantum work, the Open Quantum Safe project and its `oqs-provider` are relevant, but their own documentation still frames `oqs-provider` as primarily a vehicle for testing and experimental PQ crypto, not a turnkey production-quality answer. That means Guardian should treat PQ enablement as an explicit architecture decision with staged rollout and crypto review, not as a library checkbox.

## Key Finding On Post-Quantum Readiness

The reviewed open-source ecosystem does **not** currently offer a single obvious package that simultaneously gives us:

- Guardian-native operator workflows
- self-hosted hybrid direct/relay topology
- strong abuse and policy controls
- mature, production-ready post-quantum group messaging

The strongest concrete production evidence for post-quantum messaging in the reviewed set is Signal's PQXDH work for session establishment.

**Inference from the reviewed sources:** mature open-source decentralized messaging is ahead on transport and metadata resistance, while mature post-quantum messaging is ahead in protocol research and selective deployment, but the two are not yet cleanly unified in one Guardian-ready stack.

## Proposed Guardian Architecture

### Design Principle

Guardian should treat secure operator communications as a **native subsystem** with three separable layers:

1. identity and trust
2. transport and relay
3. end-to-end encrypted message envelopes

This lets us replace or upgrade one layer without rewriting the rest.

### Recommended v1 Topology

```text
┌──────────────────────┐
│ Guardian Directory   │
│ / Relay / Mailbox    │
│ / Revocation Service │
└──────────┬───────────┘
           │
   discovery / relay fallback / revocation
           │
 ┌─────────┴─────────┐
 │                   │
▼▼▼                 ▼▼▼
Guardian A  ←────→ Guardian B
   │  direct P2P when possible │
   └──────────────→ Guardian C
           direct or relayed
```

### Layer 1: Identity and trust

- each Guardian instance gets a long-lived device identity
- identities are enrolled by an organization or tenant authority
- keys are rotated and revocable
- operators can mint revocable contact codes that expose reachability without exposing the long-lived identity directly
- membership changes are logged
- high-risk deployments can require dual control for new peer enrollment

Default trust model:

- no anonymous public peers
- no open federation by default
- no trust-on-first-use by default for production organizations
- no global searchable directory by default

### Operator-visible contact codes

The relay/discovery layer should not require publishing a permanent public handle that anyone can probe forever.

Instead, Guardian should support **operator-issued contact codes**, with **one-time codes as the default**:

- each code is a revocable alias or invitation handle
- each code can have a short TTL
- the code resolves to current delivery metadata without exposing the underlying long-lived identity directly
- operators can rotate or delete codes if they suspect compromise
- codes can be single-use, pairwise, or organization-scoped
- codes are distributed out-of-band to trusted parties

Important constraint:

- a contact code should allow a trusted party to initiate contact
- a contact code should **not** by itself allow impersonation, message decryption, or silent peer replacement

Recommended model:

- the real root of trust remains the Guardian instance key material and enrollment record
- the contact code is only a reachability token bound to that identity
- first contact still requires signed identity exchange and policy checks

This is materially better than a public username directory because compromise of a code only leaks a contact path, not the core identity or conversation history.

### Recommended default: one-time invitation codes

For Guardian's expected use case, the default user experience should be:

- operator clicks `Generate contact code`
- Guardian creates a high-entropy, single-use code with a short expiry
- operator shares that code out-of-band with a trusted party
- the remote party redeems the code to start a signed key exchange
- after successful introduction, the code is burned and cannot be reused

This is a good fit for Guardian because:

- communications are likely to be deliberate and relatively infrequent
- operators already expect higher-friction trust workflows than consumer chat users
- compromise of one code does not create a long-lived public attack surface
- it reduces scraping, enumeration, and unwanted probing of relay infrastructure

Recommended fallback options:

- `one-time` code for normal first contact
- `pairwise reusable` code for an established trusted counterparty
- `organization-scoped rotating` code for controlled helpdesk or SOC-style intake

### UX tradeoff

This is somewhat worse UX than a permanent username, but likely acceptable for Guardian.

The trade is:

- worse convenience for ad hoc contact initiation
- much better control over exposure, compromise response, and directory privacy

For a high-trust operator network, that is the right trade by default.

### Layer 2: Transport

Preferred order:

1. direct peer connection
2. authenticated relay/mailbox fallback
3. optional onion/relay transport for high-risk or location-hiding deployments

Implementation candidates:

- `libp2p` over QUIC/TLS or Noise for a Guardian-native transport
- `Headscale` + `WireGuard` as an optional secure overlay beneath the application channel

### Layer 3: End-to-end encrypted envelope

The relay infrastructure must not be trusted with plaintext.

Recommended message model:

- signed sender identity
- encrypted body
- message type
- room or conversation identifier
- creation time and expiry
- replay nonce
- optional attachment reference

Suggested message types:

- `operator-chat`
- `incident-note`
- `approval-request`
- `approval-response`
- `alert`
- `presence`
- `membership-change`

These are important because Guardian should only permit specific message classes to cross instance boundaries. A remote message should never arrive as "arbitrary text to hand to an agent and let it decide what to do."

### Discovery and relay privacy guidance

To minimize relay and discovery risk:

- do not expose a browsable public directory by default
- prefer one-time or pairwise contact codes over stable public handles
- allow operators to issue separate codes to different counterparties
- support immediate code revocation and replacement
- treat relay metadata as sensitive even when payloads are encrypted

## Post-Quantum Strategy

### Short version

If post-quantum resistance is a hard requirement, Guardian should plan for a **hybrid** design, not a pure "wait for perfect PQ stack" design.

### Recommended approach

- use classical, well-audited encrypted transport and message protection today
- add hybrid post-quantum session establishment for new conversations as the implementation base stabilizes
- keep the PQ mechanism isolated behind a crypto provider boundary so we can swap algorithm suites later

Practical guidance:

- use Signal's PQXDH direction as the reference model for pairwise session bootstrap
- do not assume current MLS tooling alone solves PQ requirements
- do not treat `oqs-provider` as the production answer by itself; use it for prototyping and interoperability investigation
- watch native OpenSSL PQ support and standards progress rather than hard-binding Guardian to experimental provider internals

### Why hybrid is the right posture

Hybrid designs avoid forcing Guardian to bet entirely on either:

- existing classical ECC-only systems, which leave harvest-now-decrypt-later exposure, or
- experimental PQ-only implementations, which may still have interoperability and standards risks

## Guardian Safety Controls Required Regardless of Transport

No matter which transport we choose, the following controls are mandatory:

- inbound content classification before any automation path can see it
- no direct tool execution from cross-instance messages
- separate human-authored and machine-authored message lanes
- attachment quarantine and explicit operator open/approve steps
- signed append-only local audit log
- org-scoped revocation list
- rate limiting and abuse controls at relay ingress
- policy-controlled export, retention, and transcript deletion

This is the main architectural difference between "secure chat" and "secure Guardian communications."

## Recommendation

### Primary recommendation

Build a **Guardian-native hybrid secure communications layer** using open-source building blocks, not a third-party messenger as the long-term substrate.

Recommended shape:

- Guardian-owned identity, enrollment, and revocation
- Guardian-owned one-time and revocable contact-code system for trusted introductions
- Guardian-owned typed message envelopes
- direct peer transport first
- shared relay/mailbox service for fallback
- optional WireGuard/Headscale overlay in managed deployments
- hybrid PQ session establishment as a planned upgrade path, informed by Signal's PQXDH and the state of OpenSSL PQ support

### Tactical stopgap

If the immediate need is "operators need secure chat soon," deploy **self-hosted Matrix** as a temporary operational channel while Guardian-native transport is built.

That stopgap should be treated as temporary because:

- the metadata and homeserver model is different from the Guardian target
- it is not the cleanest path to post-quantum requirements
- it does not natively solve Guardian's agentic-attack and workflow constraints

## Proposed Phasing

### Phase 1: Narrow pilot

- 1:1 messaging only
- organization-scoped enrollment only
- one-time invitation codes only
- no attachments
- relay/mailbox plus local audit log
- direct connection where possible, relay fallback where needed
- no machine-triggered actions from inbound messages

### Phase 2: Operational hardening

- group rooms
- membership change controls
- revocation and key rotation
- rate limits and abuse handling
- attachment quarantine
- safe transcript retention/export controls

### Phase 3: Post-quantum and high-risk transport

- hybrid PQ bootstrap for new sessions
- crypto-agility layer and algorithm migration plan
- optional onion-backed transport or hardened relay mode for high-risk deployments
- federation between organization-owned relay/control nodes

## Decision

Guardian should **not** start with a pure decentralized peer mesh.

Guardian should start with a **hybrid secure operator channel** that:

- can work peer-to-peer
- still has a controlled identity and relay layer
- keeps Threat Sharing Hub separate as the structured intel plane
- explicitly hardens against malicious or compromised agent participants

That is the best balance of security, deployability, and product fit.

## Legal And Regulatory Considerations

This section is a product-shaping summary, not legal advice.

The main legal question is not simply "is encryption allowed?" The bigger question is what Guardian is **operating**:

- open-source software that others self-host
- a private hosted relay/mailbox service for known customers
- or a public communications platform with public discovery, public groups, bots, and large-scale hosted content

Those three models have very different legal exposure.

### 1. Lawful process and compelled disclosure

Every communications service should assume subpoenas, warrants, court orders, and regulator requests.

Signal's model shows the value of data minimization. On its government-requests page dated **March 6, 2026**, Signal says it does not have access to messages, calls, profile information, group information, contacts, stories, call logs, and many other categories of content and metadata. Its older **October 4, 2016** disclosure says the main information it could produce was registration time and last connection date.

Design implication for Guardian:

- do not store plaintext messages server-side
- minimize retained metadata
- keep relay logs short-lived and purpose-limited
- separate delivery metadata from message content

The less Guardian stores, the less it can be forced to disclose.

### 2. Abuse-reporting and mandatory reporting duties

If Guardian operates relay or mailbox infrastructure, it may fall into legal regimes that create reporting or preservation duties once it has actual knowledge of certain unlawful content or conduct.

For example, in the United States, **18 U.S.C. § 2258A** imposes reporting obligations on covered providers after obtaining actual knowledge of certain child sexual exploitation facts. The same statute also says it does **not** require general monitoring of users or communications.

Design implication for Guardian:

- do not promise "zero legal obligations"
- maintain a narrow abuse-report and escalation process
- define exactly what the hosted service does and does not inspect
- ensure that any required preservation path is tightly controlled and audited

### 3. Public-platform moderation obligations

Telegram's public materials are a useful warning about what happens when a communications system also becomes a large public platform.

Telegram's FAQ says it processes legitimate requests to remove illegal **public** content. Its moderation page states that it blocks large volumes of groups and channels daily and uses proactive moderation for public abuse categories including violence, CSAM, and illegal goods. Telegram also publishes EU Digital Services Act contact points and authority-request channels.

Design implication for Guardian:

- do not launch with public groups, public channels, public bot ecosystems, or public user discovery
- keep the service private, invite-only, and operator-scoped
- avoid becoming a general public publishing or broadcast platform

The moment Guardian behaves like a public social or messaging platform, moderation, notice-and-action, and transparency obligations expand sharply.

### 4. Pressure to weaken encryption

Signal's **March 9, 2023** statement on the UK Online Safety Bill is the clearest recent example of the legal pressure secure messengers face. Signal argued that measures framed as online-safety obligations could in practice require weakening encryption or enabling broad surveillance, and it explicitly rejected the idea of a "safe backdoor."

Design implication for Guardian:

- design so the hosted layer does not depend on server-side plaintext access
- avoid architectural commitments that only work if future policy forces client-side scanning or server-side decryption
- assume that some jurisdictions may pressure operators to add exceptional-access features

If Guardian is built around end-to-end encryption plus minimal metadata, legal pressure may still come, but the architecture will be more defensible and less brittle.

### 5. Privacy and data-protection law

If Guardian operates a hosted service in or touching the EU, UK, or similar jurisdictions, it will likely face obligations around:

- privacy notices
- data minimization
- retention limits
- lawful basis for processing
- security controls
- response channels for authorities and users

Telegram's privacy policy and DSA guidance show how these obligations become more visible when a provider stores cloud-chat content, public usernames, contact data, and moderation/reporting interfaces.

Design implication for Guardian:

- minimize personal data at the product layer
- make contact codes optional, revocable, and short-lived
- avoid public profile systems by default
- keep retention and deletion controls explicit

### 6. Export controls and sanctions

Strong cryptographic software can trigger export-control analysis. U.S. BIS guidance states that encryption items can fall within Category 5, Part 2 of the EAR, including software classifications such as **5D002**, with License Exception ENC often being relevant.

Design implication for Guardian:

- document cryptographic features clearly
- treat international distribution of binaries and hosted access as a compliance topic, not an afterthought
- review sanctions, export destinations, and enterprise sales flows before commercial rollout

### What Signal and Telegram teach us

Signal's recurring issue set is:

- legal process requests
- political/regulatory pressure to weaken encryption
- censorship and blocking pressure

Telegram's recurring issue set is:

- moderation and illegal-content handling at scale
- public-content takedown demands
- privacy and platform-governance obligations
- heightened scrutiny because the service includes public and cloud-hosted components rather than default end-to-end encrypted minimal-data messaging

### Recommendation for Guardian's legal posture

Guardian should aim for the lowest-exposure product shape that still meets the product need:

- private, invite-only, operator-to-operator service
- one-time or pairwise contact codes instead of public usernames
- no public rooms or public discovery by default
- no server-side plaintext message storage
- short-lived relay metadata
- documented lawful-process and abuse-report intake path

Inference from the reviewed sources:

- a private, metadata-minimized operator network is legally easier to defend than a public messaging platform
- once Guardian adds public discovery, public broadcast features, bots, or server-stored plaintext, it moves toward the heavier legal and moderation burdens seen by services like Telegram
- once Guardian promises strong end-to-end confidentiality, it should expect the same kind of anti-encryption pressure that Signal has publicly resisted

### Required follow-up before launch

Before any hosted rollout, Guardian should get jurisdiction-specific legal review on:

- U.S. provider status and reporting obligations
- EU/UK privacy and online-platform obligations
- retention, deletion, and lawful-process response policy
- export controls and sanctions
- contract language for enterprise/self-hosted vs hosted offerings

## Sources Reviewed

Reviewed on 2026-04-01.

- Matrix Megolm specification: https://spec.matrix.org/unstable/olm-megolm/megolm/
- Matrix MLS blog post: https://matrix.org/blog/2023/07/a-giant-leap-with-mls/
- Signal PQXDH announcement: https://signal.org/blog/pqxdh/
- Signal government requests: https://signal.org/bigbrother/
- Signal statement on the UK Online Safety Bill: https://signal.org/blog/uk-online-safety-bill/
- Signal server repository: https://github.com/signalapp/Signal-Server
- Briar "How it works": https://briarproject.org/how-it-works/
- Jami introduction: https://docs.jami.net/en_US/user/introduction.html
- Tox wiki start page: https://wiki.tox.chat/start
- libp2p secure channels overview: https://docs.libp2p.io/concepts/secure-comm/overview/
- libp2p overview: https://docs.libp2p.io/
- WireGuard protocol and cryptography: https://www.wireguard.com/protocol/
- Headscale docs: https://headscale.net/0.24.2/
- OpenMLS book: https://book.openmls.tech/
- Open Quantum Safe liboqs: https://openquantumsafe.org/liboqs/
- OQS provider repository: https://github.com/open-quantum-safe/oqs-provider
- SimpleX metadata/privacy design note: https://simplex.chat/blog/20220711-simplex-chat-v3-released-ios-notifications-audio-video-calls-database-export-import-protocol-improvements.html
- Telegram FAQ: https://telegram.org/faq
- Telegram privacy policy: https://telegram.org/privacy
- Telegram moderation overview: https://telegram.org/moderation
- Telegram EU DSA guidance: https://telegram.org/tos/eu-dsa
- 18 U.S.C. § 2258A: https://www.law.cornell.edu/uscode/text/18/2258A
- U.S. BIS encryption guidance: https://www.bis.doc.gov/index.php/policy-guidance/encryption
