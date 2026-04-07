# WebUI Theme System And React Islands Implementation Plan

**Status:** Draft  
**Date:** 2026-04-07  
**Primary references:** [WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md), [FORWARD-ARCHITECTURE.md](/mnt/s/Development/GuardianAgent/docs/architecture/FORWARD-ARCHITECTURE.md), [CONTEXT-CYPHER-INTEGRATION-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/CONTEXT-CYPHER-INTEGRATION-PROPOSAL.md), `/mnt/s/Development/awesome-design-md`

## Objective

Deliver a richer WebUI appearance system that can vary presentation deeply without changing the shell layout, page ownership, or route structure, while also laying the foundation for future React and React Flow pages mounted inside the existing Guardian web shell.

This plan intentionally sequences the work as:

1. shared theme and styling infrastructure first
2. migration of current vanilla WebUI onto that infrastructure
3. React island capability later
4. React Flow or other graph-heavy pages after the island capability exists

## Current Decision

The first implementation focus should be the theme and styling uplift, not the first React page.

Why:

- the current theme system is too narrow to support richer visual profiles
- the current styling surface still contains heavy hardcoded CSS values and inline page-level styling
- React pages should consume the same appearance contract as the vanilla pages
- if React lands before the shared theme contract, the project risks creating two independent styling systems

## Product Boundary

### In scope for the early phases

- richer appearance tokens for:
  - colors
  - semantic states
  - typography
  - border/ring styling
  - shadows
  - component chrome
  - motion
  - editor styling
- conversion of current built-in themes into the new token model
- addition of new inspired theme bundles based on `awesome-design-md`
- narrow WebUI spec updates so typography and geometry are no longer hardcoded as absolute product laws
- shared appearance runtime used by:
  - vanilla JS pages
  - future React pages
  - Monaco/editor surfaces
  - popup or detached surfaces
- React island capability in the shell:
  - route-level bundle loading
  - mount and unmount lifecycle
  - shared API/auth/SSE/theme integration

### Explicitly out of scope for the early phases

- changing page ownership
- changing nav order
- changing shell column layout
- moving the chat panel
- rewriting the whole WebUI into React
- introducing a second React-only theme source of truth
- implementing the first large React Flow feature before the shared appearance system is in place

## Non-Negotiable Invariants

- The shell layout remains structurally the same in the initial implementation phases.
- `Configuration > Appearance` remains the owner of appearance and display settings.
- Page ownership, route ownership, and shared orchestration behavior remain unchanged.
- The source of truth for visual styling is shared tokenized appearance state, not per-page ad hoc CSS or framework-local theme objects.
- React pages, when introduced, must read the same appearance contract as vanilla pages.
- Monaco and detached code-inspector surfaces must stay visually aligned with the chosen appearance profile.

## Target End State

By the end of the main theme-system work:

- Guardian has a multi-layer appearance system rather than a single flat theme array
- colors, fonts, borders, rings, shadows, badges, buttons, inputs, and other component chrome are tokenized
- current themes are preserved as compatibility bundles mapped onto the new system
- new inspired appearance bundles can be added without large CSS rewrites
- the Appearance tab can manage richer presentation choices without exposing shell-layout controls
- the WebUI can host future React islands without inventing a second styling architecture

By the end of the later React-enablement work:

- the shell can mount a route-specific React bundle inside `#content`
- the React bundle shares auth, API access, SSE subscriptions, and CSS-variable theming with the rest of the app
- React Flow becomes feasible for future graph-heavy pages without committing the rest of the shell to React

## Architectural Shape

### 1. Shared appearance contract

The appearance system should be split into layers rather than a single "theme" bucket.

Recommended layers:

- `palette`: background, surface, text, accent, semantic colors
- `typography`: font families, size scale, display styles, label styles
- `geometry`: border radius, border weights, ring shapes, shadow strength
- `component`: buttons, inputs, cards, badges, tabs, tables, callouts, overlays
- `motion`: transition speed, hover intensity, reduced-motion behavior
- `editor`: Monaco colors, code surfaces, code diff styling

### 2. Bundle presets

A user-facing "theme" should become a bundle preset composed from the layers above.

Examples:

- `guardian-default`
- `guardian-light`
- `linear-ops`
- `vercel-light`
- `voltagent-signal`

### 3. One visual source of truth

The final computed appearance should be applied as CSS custom properties on `:root`.

That same token surface should drive:

- vanilla page CSS
- page-level components
- Monaco theme generation
- popups and detached surfaces
- future React pages

### 4. React as route-scoped islands

React is not the new global shell requirement.

Instead:

- the existing shell and router remain in place
- a route-level page module creates a mount container
- a React bundle is loaded only for that route
- the bundle mounts and unmounts on route transitions
- the React page consumes the same shared appearance tokens and runtime APIs

## Required Spec Changes

The current WebUI design spec should be updated narrowly, not replaced broadly.

Changes needed:

- move "strict 0 border radius" from absolute product law to the default Guardian appearance profile
- move hardcoded font expectations from absolute product law to the default Guardian typography profile
- clarify that shell structure is fixed while visual appearance profiles may vary within governed limits
- clarify that Appearance may own richer presentation settings beyond just a flat theme picker
- document the allowed "React island inside the existing shell" model for graph-heavy or highly interactive future pages

Primary spec targets:

- [WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md)
- any derived appearance copy in [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

## Delivery Phases

## Phase 0: Audit, Spec Update, And Token Contract

### Goal

Define the governed appearance surface before implementation starts.

### Deliver

- audit of:
  - hardcoded color literals
  - inline style strings
  - non-tokenized font declarations
  - non-tokenized border/shadow/radius values
  - Monaco theme duplication
- narrow spec update for appearance flexibility without shell-layout changes
- new appearance token schema documented in code and in the WebUI design spec
- migration rules for:
  - old theme IDs
  - editor theme linkage
  - detached code popup theme synchronization

### Likely implementation areas

- [docs/specs/WEBUI-DESIGN-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/WEBUI-DESIGN-SPEC.md)
- [web/public/js/theme.js](/mnt/s/Development/GuardianAgent/web/public/js/theme.js)
- [web/public/js/monaco-themes.js](/mnt/s/Development/GuardianAgent/web/public/js/monaco-themes.js)
- [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)

### Exit criteria

- the supported appearance layers are explicit
- the spec permits richer styling without opening shell-layout drift
- the migration target is documented well enough to implement mechanically

## Phase 1: Shared Appearance Runtime

### Goal

Replace the flat theme manager with a layered appearance registry and resolver.

### Deliver

- new appearance registry structure
- compatibility adapter for current theme IDs
- persisted appearance state for:
  - bundle preset
  - font preset or typography profile
  - motion preference
  - editor linkage mode
- appearance application runtime that computes final CSS variables on `:root`
- stable serialization format for detached surfaces and popup windows

### Likely implementation areas

- [web/public/js/theme.js](/mnt/s/Development/GuardianAgent/web/public/js/theme.js)
- new appearance registry modules under `web/public/js/`
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)

### Exit criteria

- current themes still work through compatibility mapping
- appearance state is composed from layers rather than a flat one-record theme array
- future React pages can consume the same runtime-applied tokens

## Phase 2: Shared CSS Primitive Migration

### Goal

Move the core component chrome from hardcoded values to token-driven styling.

### Deliver

- tokenized shared primitives for:
  - buttons
  - inputs
  - selects
  - cards
  - panels
  - badges
  - tabs
  - tables
  - inline code
  - callouts
  - overlays and modals
- replacement of hardcoded radius, border, shadow, and typography declarations in shared CSS
- a smaller number of canonical utility classes for frequent patterns currently expressed as inline strings

### Likely implementation areas

- [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- shared components under [web/public/js/components/](/mnt/s/Development/GuardianAgent/web/public/js/components)

### Exit criteria

- shared components read tokens instead of hardcoded values
- common component chrome is reusable across pages
- the codebase stops growing new inline styling for standard UI treatments

## Phase 3: Page Migration And Inline Style Debt Reduction

### Goal

Tokenize the page-level styling surface without changing the shell layout.

### Deliver

- remove or sharply reduce inline `style=""` strings and ad hoc `.style` assignments from:
  - [web/public/js/pages/config.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/config.js)
  - [web/public/js/pages/automations.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/automations.js)
  - [web/public/js/pages/cloud.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/cloud.js)
  - [web/public/js/pages/network.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/network.js)
  - [web/public/js/pages/system.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/system.js)
  - [web/public/js/pages/second-brain.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/second-brain.js)
- replace hardcoded visual literals with shared component classes or CSS variables
- keep structural page rendering logic intact while reducing presentation duplication

### Migration rule

This phase changes presentation only. It does not redesign the shell or move page responsibilities.

### Exit criteria

- major pages no longer depend on large amounts of inline visual styling
- most visual change can be achieved by token changes instead of editing page render strings
- theme variation becomes broad enough to justify richer bundle presets

## Phase 4: Editor And Detached Surface Alignment

### Goal

Make the code surfaces part of the same appearance system instead of a parallel theme island.

### Deliver

- Monaco themes generated from shared appearance tokens or bundle definitions
- linked and unlinked editor-theme modes
- synchronized popup/inspector theme transport using the new appearance contract
- conversion of current Monaco theme registry into the new model with compatibility mapping

### Likely implementation areas

- [web/public/js/monaco-themes.js](/mnt/s/Development/GuardianAgent/web/public/js/monaco-themes.js)
- [web/public/js/pages/code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)

### Exit criteria

- the editor and the shell can stay visually aligned without duplicate theme definitions
- current editor themes still exist or map cleanly to the new registry
- detached code surfaces follow the same appearance state

## Phase 5: Appearance UX Uplift

### Goal

Turn the Appearance tab into a real control plane for the richer appearance system.

### Deliver

- redesigned `Configuration > Appearance` experience for:
  - bundle preset selection
  - typography profile selection
  - motion preference
  - editor linkage
  - optional advanced token-profile controls if needed
- better preview cards that communicate more than palette alone
- curated starter bundles based on:
  - current Guardian themes
  - a small number of inspired `awesome-design-md` variants suitable for an operator UI

### Likely implementation areas

- [web/public/js/pages/config.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/config.js)
- [web/public/css/style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

### Exit criteria

- the Appearance tab reflects the real breadth of the new system
- users can switch between curated presentation bundles without touching layout
- the help copy and reference guide describe the new appearance model accurately

## Phase 6: React Island Capability

### Goal

Enable route-scoped React pages inside the existing shell without yet requiring a whole-shell migration.

### Deliver

- frontend build capability for route-scoped React bundles
- route-level loader pattern for:
  - bundle loading
  - mount
  - unmount
  - cleanup on route leave
- shared bridge utilities so React pages can consume:
  - Guardian auth/session state
  - existing API surface
  - SSE subscriptions where needed
  - shared appearance tokens from `:root`
- documentation for the React-island contract

### Likely implementation areas

- [web/public/js/app.js](/mnt/s/Development/GuardianAgent/web/public/js/app.js)
- [web/public/index.html](/mnt/s/Development/GuardianAgent/web/public/index.html)
- root [package.json](/mnt/s/Development/GuardianAgent/package.json)
- new React app directory under `web/`
- [docs/architecture/FORWARD-ARCHITECTURE.md](/mnt/s/Development/GuardianAgent/docs/architecture/FORWARD-ARCHITECTURE.md)

### Exit criteria

- the shell can host a React route without changing the rest of the app architecture
- the React route reads the same appearance contract as the vanilla pages
- mount and unmount behavior is deterministic and testable

## Phase 7: First React Flow Surface

### Goal

Deliver the first graph-heavy page only after the appearance and React-island foundations are stable.

### Candidate surfaces

- `Architecture`
- visual automation builder
- other graph-backed investigative or topology surfaces

### Deliver

- first production React page mounted in the shell
- React Flow integration
- shared appearance bridge so the graph page visually belongs to Guardian
- route-specific docs, tests, and reference-guide updates

### Primary rule

Do not start this phase until Phases 1 through 6 are functionally sound. The first React Flow page should validate the island model, not discover the appearance architecture for the first time.

## Theme Bundle Recommendations

The first inspired bundles should stay close to Guardian's operator posture.

Recommended early bundles:

- `guardian-default`
- `guardian-light`
- `linear-ops`
- `voltagent-signal`
- `vercel-light`
- `hashicorp-slate`

Avoid direct early ports of marketing-heavy systems that depend on photography, layout theater, or strong brand mimicry.

## Verification Strategy

### During implementation

- focused `vitest` runs for any touched frontend logic
- `npm run check`
- `npm test`
- targeted page-level manual verification in the WebUI

### Broad verification before major completion points

- `node scripts/test-code-ui-smoke.mjs`
- `node scripts/test-coding-assistant.mjs`
- any additional harnesses relevant to route loading, approvals, or web shell behavior

### Specific regression checks

- appearance changes do not alter page ownership or route behavior
- chat panel, code page, and popup windows remain synchronized
- existing themes still resolve cleanly through compatibility mapping
- no React route can bypass the shell's auth, SSE, or appearance runtime

## Suggested PR Sequence

1. spec update plus appearance token contract
2. shared appearance runtime and compatibility layer
3. shared CSS primitive migration
4. page-by-page inline style debt reduction
5. editor and popup theme integration
6. Appearance tab uplift and curated bundles
7. React island capability
8. first React Flow page

## Definition Of Success

This uplift is successful when:

- Guardian can support rich visual themes without touching layout
- current and new themes are easy to add as governed bundles
- the app has one shared appearance system rather than multiple parallel ones
- the shell can host future React or React Flow pages without committing the whole WebUI to a rewrite
- the first future React page will be able to focus on product behavior instead of inventing styling and integration infrastructure from scratch
