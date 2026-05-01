# Multi-User Server + Client Agent Proposal

**Related:** [Browser Privacy Shield, Tor Routing, and Guarded Dark Web OSINT](BROWSER-PRIVACY-SHIELD-PROPOSAL.md)

## Goal

Extend Guardian from a single-user/small-team runtime into a centrally managed system with:
- one control-plane server
- multiple authenticated users
- optional client agents running on managed endpoints

## Why

Current Guardian has identity resolution and per-user session keys, but it is not a true multi-user or multi-tenant system. Auth, approvals, delivery, and policy are still shaped around a local single-user deployment.

This proposal also needs a clean forward path for later integration with:

- shared privacy and Tor transport capabilities
- guarded high-risk browsing on managed endpoints
- future Guardian Hub messaging between deployed Guardian instances

## Proposed Architecture

### 1. Control Plane Server

The central server owns:
- authentication and session management
- user, role, and tenant identity
- policy and approval decisions
- audit and analytics
- automation definitions and schedules
- conversation/session metadata
- routed LLM orchestration

### 2. Client Agent

A lightweight client agent runs on a workstation, server, or edge node and owns:
- local tool execution
- local secrets and OS access
- local telemetry collection
- signed job receipt and result return

The client agent should not make trust decisions on its own. It executes within server-issued policy boundaries.

The client agent is also the right future boundary for a **guarded browsing shell** on managed endpoints. That shell would provide a constrained investigative environment for high-risk browsing tasks such as suspicious-site review, Tor-routed browsing, and guarded onion/deep-web access.

That browsing role should be positioned as:

- Guardian-managed and policy-constrained
- read-only by default
- quarantine-first for downloads and artifacts
- warning-heavy for auth, forms, persistence, and uploads

It should not be positioned as a generic "safe dark web browser" or a substitute for Tor Browser.

### 3. Shared Privacy and Collection Substrate

The multi-user architecture should assume a shared substrate for:

- transport routing: `direct | tor | tor-preferred`
- source trust classification
- quarantine and artifact handling
- privacy logging and provenance
- onion/source validation
- watchlist and monitoring primitives

Threat intel should consume this substrate, not be merged into one giant privacy or client-agent module. That keeps the architecture clean:

- the substrate is shared
- threat intel remains its own capability
- guarded browsing remains its own capability
- privacy and Tor controls remain cross-cutting platform services

### 4. Identity Model

Every request should resolve to:
- `tenantId`
- `userId`
- `sessionId`
- optional `deviceId`

Caller-supplied `userId` values should not be trusted on multi-user deployments. Identity must come from the auth layer.

### 5. Approval Model

Approvals must be bound to:
- originating tenant
- requesting user
- originating session or conversation
- optional target device

Raw approval IDs alone are not enough for a multi-user deployment.

### 6. Job Model

Server-to-client work should use signed jobs with:
- target device / agent
- scope-limited capabilities
- expiry
- replay protection
- full audit correlation

### 7. Deferred Guardian Hub Messaging

The multi-user and client-agent architecture should leave room for a later **Guardian Hub messaging** capability between Guardian instances.

The right framing is not "completely anonymous messaging." The realistic target is:

- pseudonymous, location-hiding transport
- mutually authenticated Guardian endpoints
- policy-scoped message exchange
- optional onion-service-backed connectivity for selected deployments

Potential uses later:

- Guardian-to-Guardian job delivery across constrained networks
- private telemetry or threat-sharing channels
- tenant-approved relay of alerts, case artifacts, or watchlist updates
- location-hiding inbound control endpoints for Guardian Hub

Potential deployment model to consider:

- client agents remain outbound-only by default
- the first onion-backed endpoint would most likely be Guardian Hub or a small number of designated relay/control nodes
- selected client agents could later expose onion-service endpoints for specialized deployments that need inbound reachability or stronger location-hiding
- this should not become universal per-client onion hosting by default

This should remain a later integration point, not part of the first multi-user phase, because it depends on:

- a mature federation and trust model
- key lifecycle and peer identity design
- message durability and replay protections
- abuse controls, audit boundaries, and operator policy

It should also remain distinct from a peer-to-peer mesh. The primary architecture should stay server-authoritative even if later deployments add onion-backed transport between trusted Guardian nodes.

## Recommended Phasing

1. Harden identity and auth on the current server runtime.
2. Scope approvals, sessions, automations, and notifications by real principals.
3. Add a client-agent protocol for remote/local execution.
4. Move sensitive endpoint tools behind the client agent boundary.
5. Introduce the shared privacy/collection substrate so threat intel, guarded browsing, and Tor-aware collection reuse the same transport and trust model.
6. Add guarded browsing-shell capabilities on client agents for approved high-risk investigative workflows.
7. Evaluate Guardian Hub messaging as a later federation feature, optionally using onion-service transport for selected deployments.

## Non-Goals For First Phase

- general-purpose multi-tenant SaaS isolation
- peer-to-peer agent meshes
- arbitrary remote code/plugin installation
- anonymous messaging as a primary transport model
- dark web browsing as an unrestricted end-user feature

## Expected Outcome

Guardian remains policy-first and server-authoritative, while gaining a clean path to:
- real multi-user deployments
- endpoint-specific automations
- safer remote execution
- user- and device-scoped assistant reports
- shared privacy/Tor infrastructure reused across platform capabilities
- a guarded endpoint sandbox for high-risk browsing
- a later, optional Guardian Hub messaging layer built on stronger federation primitives
