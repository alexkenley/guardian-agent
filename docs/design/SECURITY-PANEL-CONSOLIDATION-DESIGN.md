# Security Panel Consolidation Design

**Status:** Implemented current architecture
**Date:** 2026-03-21
**Owner:** Security + Web UI
**Amends:** [WEBUI-DESIGN.md](./WEBUI-DESIGN.md) for the `Security` page only
**Related:** [AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md](./AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md)

## Purpose

Define the implemented simplification of the Security page so operators do not have to mentally split “actionable alerts” from “historical audit” when the current product already overlaps those surfaces.

The shipped page now uses a **single Security Log operator surface** instead of separate `Alerts` and `Audit` tabs. The implementation is in [security.js](../../web/public/js/pages/security.js), with server endpoints in [web-monitoring-routes.ts](../../src/channels/web-monitoring-routes.ts) and [web-runtime-routes.ts](../../src/channels/web-runtime-routes.ts).

## Current Problem

Earlier Security page versions had:

- `Alerts` for the active queue
- `Audit` for the full ledger

In practice the split is not clean:

- `Alerts` already includes non-alert rows derived from audit events such as cloud, tool/policy, and automation findings
- operators often need both current action state and historical evidence in the same investigation
- the distinction is implementation-driven rather than obvious from the UI

The result is extra navigation and duplicated filtering effort.

## Investigation Summary

There is still real value in keeping **alerting** and **audit** separate as backend concepts:

- **Alerts** are stateful, deduplicated, operator-facing, and lifecycle-managed (`acknowledge`, `resolve`, `suppress`)
- **Audit** is append-only, broader in scope, tamper-evident, and needed for forensic history and chain verification

There is much less value in forcing them to be separate **primary tabs**.

## Decision

Replace the separate `Alerts` and `Audit` tabs with a single `Security Log` tab. This is now the shipped WebUI behavior.

The backend model stays split:

- keep unified alert state in `src/runtime/security-alerts.ts`
- keep the audit ledger and chain verification in the existing audit pipeline

The operator experience becomes unified:

- one tab for “what needs action now” and “what happened over time”
- one filter bar
- one row model with clear provenance badges
- one place to pivot from active queue to full evidence

## Target Information Architecture

The current Security page tabs are:

1. `Overview`
2. `Assistant Security`
3. `Threat Intel`
4. `Security Log`

`Agentic Security Log` is no longer a top-level tab; Assistant Security activity is rendered inside the `Assistant Security` tab. Promoted Assistant Security findings flow into `Security Log` through the unified alert lifecycle.

## Security Log

`Security Log` is the canonical operator surface for current issues and historical evidence.

It owns:

- the active security queue
- promoted audit-derived security findings
- historical audit review
- audit chain verification
- denial and policy evidence relevant to investigations

It does **not** replace:

- `Agentic Security Log`, which remains the live/persisted workflow log of the triage agents
- `Threat Intel`, which remains its own investigation workspace

## Required UX

### Top summary strip

Show:

- active alerts
- critical/high count
- recent denials
- recent secrets/injection events
- last audit verification result

### Primary view switch

Within `Security Log`, the operator can switch between:

- `Action Queue`
- `Timeline`
- `Policy & Denials`

These are views of one surface, not separate tabs.

### Shared filters

One shared filter bar must support:

- source
- severity
- status
- time range
- agent
- free-text query
- `actionable only` toggle

### Row model

Every row should expose:

- timestamp
- normalized title
- source badge
- severity badge
- provenance badge:
  - `alert`
  - `audit`
  - `alert + audit`
- subject
- concise summary
- expandable evidence/details

If a row maps to a real lifecycle-managed alert, action buttons appear inline.
If it is audit-only, the UI must say so explicitly instead of pretending it is actionable.

### Chain verification

Audit chain verification moves into `Security Log` as a compact integrity section, not a standalone audit tab justification.

## API Direction

The current implementation reuses existing endpoints:

- `GET /api/security/alerts`
- `POST /api/security/alerts/ack`
- `POST /api/security/alerts/resolve`
- `POST /api/security/alerts/suppress`
- `GET /api/audit`
- `GET /api/audit/summary`
- `GET /api/audit/verify`

No dedicated normalized endpoint exists today. A future backend normalization pass may still add:

- `GET /api/security/log`

That endpoint should merge:

- live unified alerts
- selected audit events
- provenance metadata
- actionability flags

The implementation goal is to move normalization out of `web/public/js/pages/security.js` and make the merged operator model explicit on the server side.

## Why This Is Better

- matches the product’s current hybrid behavior instead of hiding it behind two tabs
- reduces navigation during investigations
- preserves the semantic difference between current queue state and durable evidence
- gives future `Assistant Security` findings one obvious landing zone
- keeps chain verification and forensic review available without making “Audit” a separate mental model for everyday operators

## Migration Plan

### Phase 1

- replaced `Alerts` and `Audit` tabs with `Security Log`
- kept current backend endpoints and lifecycle behavior
- moved existing alert and audit UI blocks into one consolidated tab

### Phase 2

- add `GET /api/security/log`
- normalize provenance and row actions server-side
- reduce frontend-specific row stitching

### Phase 3

- routed Assistant Security promoted findings into the same `Security Log`
- add saved views or presets for `Queue`, `Forensics`, and `Policy`

## Non-Goals

This spec does not:

- merge alert state into the audit ledger at the storage layer
- remove audit chain verification
- remove alert lifecycle actions
- fold `Threat Intel` into the general security queue
- turn `Agentic Security Log` into a generic evidence browser

## Recommendation

Treat `Alerts` and `Audit` as **different backend responsibilities but one operator workflow**.

The intended implementation should therefore simplify the UI to one `Security Log` tab while preserving:

- alert lifecycle state
- audit integrity and full history
- clear provenance between action queue rows and ledger-only rows
