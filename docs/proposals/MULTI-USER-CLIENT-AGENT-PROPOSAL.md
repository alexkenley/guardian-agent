# Multi-User Server + Client Agent Proposal

## Goal

Extend Guardian from a single-user/small-team runtime into a centrally managed system with:
- one control-plane server
- multiple authenticated users
- optional client agents running on managed endpoints

## Why

Current Guardian has identity resolution and per-user session keys, but it is not a true multi-user or multi-tenant system. Auth, approvals, delivery, and policy are still shaped around a local single-user deployment.

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

### 3. Identity Model

Every request should resolve to:
- `tenantId`
- `userId`
- `sessionId`
- optional `deviceId`

Caller-supplied `userId` values should not be trusted on multi-user deployments. Identity must come from the auth layer.

### 4. Approval Model

Approvals must be bound to:
- originating tenant
- requesting user
- originating session or conversation
- optional target device

Raw approval IDs alone are not enough for a multi-user deployment.

### 5. Job Model

Server-to-client work should use signed jobs with:
- target device / agent
- scope-limited capabilities
- expiry
- replay protection
- full audit correlation

## Recommended Phasing

1. Harden identity and auth on the current server runtime.
2. Scope approvals, sessions, automations, and notifications by real principals.
3. Add a client-agent protocol for remote/local execution.
4. Move sensitive endpoint tools behind the client agent boundary.

## Non-Goals For First Phase

- general-purpose multi-tenant SaaS isolation
- peer-to-peer agent meshes
- arbitrary remote code/plugin installation

## Expected Outcome

Guardian remains policy-first and server-authoritative, while gaining a clean path to:
- real multi-user deployments
- endpoint-specific automations
- safer remote execution
- user- and device-scoped assistant reports
