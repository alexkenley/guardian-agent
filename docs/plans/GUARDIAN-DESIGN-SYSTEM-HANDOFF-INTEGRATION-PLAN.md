# Guardian Design System Handoff Integration Plan

**Status:** In progress
**Date:** 2026-05-01
**Primary references:** [WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md), [GUARDIAN-WORKSTATION-PROPOSAL.md](../proposals/GUARDIAN-WORKSTATION-PROPOSAL.md), `C:\Users\kenle\Downloads\Guardian Agent Design System-handoff\guardian-agent-design-system\project`

## Context

The Guardian Agent design-system handoff is a Claude Design export containing:

- canonical voice and visual-language guidance in `README.md`
- agent-facing implementation guidance in `SKILL.md`
- token references in `colors_and_type.css` and `themes.css`
- focused component previews under `preview/`
- classic and workstation shell prototypes under `ui_kits/guardian-web/`
- a source snapshot under `source/` that is close to, but behind, the current `web/public/` implementation

This is not safe to import wholesale. The current repo has newer WebUI changes in `web/public/`, including files that differ from the handoff snapshot: `style.css`, `index.html`, `app.js`, `chat-panel.js`, `theme.js`, and several page modules.

## Architecture Note

### Current Shape

The production WebUI is still a vanilla HTML/CSS/JS shell:

- `web/public/index.html` owns the header, sidebar, content container, and persistent chat rail.
- `web/public/css/style.css` owns the bulk of visual styling and already contains several Guardian design-system tokens.
- `web/public/js/theme.js` owns theme, geometry, typography, and font-scale runtime behavior.
- Page modules under `web/public/js/pages/` still contain some page-specific layout and inline styling.
- [WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md) owns page structure, navigation, and WebUI behavior, while the handoff now provides a more precise visual-language contract.

### Root Design Risk

The handoff includes both design-system references and an older source snapshot. Treating the snapshot as production code would overwrite newer behavior and likely regress recent chat, code, approval, routing, and page work.

The correct target is to integrate the handoff as a design-system contract, not as a replacement app tree.

### Target Shape

Guardian should have a documented WebUI visual contract that is implemented through production tokens and shared CSS primitives:

- `WEBUI-DESIGN.md` remains the source of truth for route ownership, page structure, shell invariants, and behavioral rules.
- The design-system handoff governs visual language, voice, tokens, iconography, and shell-chrome direction.
- Classic shell remains the default production shell.
- Workstation shell remains an opt-in power-user mode implemented behind an explicit boundary, consistent with [GUARDIAN-WORKSTATION-PROPOSAL.md](../proposals/GUARDIAN-WORKSTATION-PROPOSAL.md).
- Production code ports design intent from `ui_kits/guardian-web/`, not prototype internals.

## Non-Negotiable Invariants

- Do not replace current `web/public/` files with the handoff `source/` snapshot.
- Keep the current branch; do not create or switch branches unless explicitly requested.
- Preserve the fixed classic shell shape until the workstation shell is implemented as an opt-in mode.
- Keep the persistent right-rail chat visible in classic mode.
- Replace Unicode/emoji navigation icons with token-driven Lucide icons only in a scoped phase.
- Keep page ownership, nav order, and route structure aligned with [WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md).
- Update WebUI design docs in the same change whenever implementation changes shell behavior, visual standards, iconography, appearance controls, or workstation semantics.

## Phase 0: Baseline Audit And Spec Alignment

### Goal

Lock down what the handoff changes before touching production UI.

### Deliver

- Record the handoff as the visual-language reference in [WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md).
- Compare handoff tokens against production `style.css` and `theme.js`.
- Inventory production differences from the handoff source snapshot.
- Identify which preview components should become production primitives.

### Likely Files

- [docs/design/WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md)
- [web/public/css/style.css](../../web/public/css/style.css)
- [web/public/js/theme.js](../../web/public/js/theme.js)
- [web/public/index.html](../../web/public/index.html)

### Exit Criteria

- The doc relationship is explicit.
- The team has a list of token, shell, icon, and component deltas.
- No production behavior has been overwritten by prototype code.

## Phase 1: Token And Theme Contract Hardening

### Goal

Align production tokens with the handoff without changing page structure.

### Deliver

- Reconcile `colors_and_type.css` values with production `:root` tokens.
- Reconcile the 19 built-in themes from `themes.css` with production `theme.js`.
- Ensure derived tokens for text, border, focus, hover, semantic state, geometry, and motion are consistently applied.
- Preserve current theme IDs and stored user preferences.

### Likely Files

- [web/public/css/style.css](../../web/public/css/style.css)
- [web/public/js/theme.js](../../web/public/js/theme.js)
- [web/public/js/monaco-themes.js](../../web/public/js/monaco-themes.js)

### Verification

- `npm run check`
- focused WebUI smoke where available
- browser visual pass across `guardian-angel`, `standard-light`, `cyberpunk`, `dracula`, `synthwave`, and `threat-vector`

## Phase 2: Classic Shell Visual Uplift

### Goal

Bring the production classic shell into line with the handoff `ui_kits/guardian-web/index.html` while preserving current behavior.

### Deliver

- Header, sidebar, content, and chat rail chrome aligned to handoff dimensions and token use.
- Guardian mark usage verified.
- Connection, trust, approval, and killswitch treatments aligned with the handoff.
- Sidebar active/hover states aligned without changing route order.
- Existing chat cancellation, pending-action, provider selector, and run-tracking behavior preserved.

### Likely Files

- [web/public/index.html](../../web/public/index.html)
- [web/public/css/style.css](../../web/public/css/style.css)
- [web/public/js/app.js](../../web/public/js/app.js)
- [web/public/js/chat-panel.js](../../web/public/js/chat-panel.js)

### Verification

- `npm run check`
- `node scripts/test-code-ui-smoke.mjs`
- relevant web approval/chat harnesses when chat or approval rendering changes
- in-browser desktop and narrow viewport pass

## Phase 3: Iconography Replacement

### Goal

Remove the known emoji/glyph icon wart from navigation and shell actions.

### Deliver

- Load or bundle Lucide icons in a way that works for offline/local app use.
- Replace sidebar and killswitch glyphs with stroke icons using `currentColor`.
- Keep accessible labels and tooltips intact.
- Ensure icons do not shift layout or reduce nav readability.

### Likely Files

- [web/public/index.html](../../web/public/index.html)
- [web/public/css/style.css](../../web/public/css/style.css)
- possibly [web/public/vendor/](../../web/public/vendor)

### Verification

- visual browser pass
- keyboard/focus pass
- route navigation smoke

## Phase 4: Component Primitive Migration

### Goal

Turn the handoff preview patterns into production-ready shared primitives.

### Deliver

- Tokenized button, badge, pill, input, card, panel-header, approval-row, and status-row styles.
- Remove duplicated one-off styling where shared primitives cover the same behavior.
- Preserve page-specific information architecture.

### Likely Files

- [web/public/css/style.css](../../web/public/css/style.css)
- [web/public/js/components/](../../web/public/js/components)
- [web/public/js/pages/](../../web/public/js/pages)

### Verification

- focused page smoke for changed surfaces
- visual pass on System, Security, Code, Configuration, and Second Brain

## Phase 5: Appearance Control Plane Alignment

### Goal

Make `Configuration > Appearance` accurately represent the handoff's theme, typography, geometry, and motion model.

### Deliver

- Appearance copy aligned with the handoff vocabulary.
- Preview cards or controls that expose token-driven theme/font/radius behavior.
- Reference guide updates for operator-facing appearance controls.

### Likely Files

- [web/public/js/pages/config.js](../../web/public/js/pages/config.js)
- [web/public/css/style.css](../../web/public/css/style.css)
- [src/reference-guide.ts](../../src/reference-guide.ts)
- [docs/design/WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md)

### Verification

- `npm run check`
- focused config page smoke
- reference-guide tests if touched

## Phase 6: Workstation Shell Foundation

### Goal

Implement the opt-in workstation shell from the handoff and existing proposal as a bounded module, not as a rewrite of classic mode.

### Deliver

- Workstation mode toggle behind an explicit experimental preference.
- New workstation module boundary for frame manager, dock, persistence, command palette, and live tiles.
- Classic mode remains default and keeps the same `460px` chat rail default.
- Workstation frames render existing pages without duplicating page modules.
- Persistent chat moves into a workstation companion frame while mode is active and returns to the classic shell on exit.
- Classic and workstation shells include responsive fallbacks; the classic chat rail is resizable with local persistence.

### Likely Files

- new `web/public/js/workstation/` modules
- new `web/public/css/workstation.css`
- [web/public/js/app.js](../../web/public/js/app.js)
- [web/public/index.html](../../web/public/index.html)
- [docs/proposals/GUARDIAN-WORKSTATION-PROPOSAL.md](../proposals/GUARDIAN-WORKSTATION-PROPOSAL.md)
- [docs/design/WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md)

### Verification

- classic-mode regression smoke
- workstation-mode browser smoke
- visual pass with multiple themes
- chat and approvals smoke with workstation mode active

## Phase 7: Workstation Polish And Graduation

### Goal

Move workstation mode from experimental foundation to usable power-user shell.

### Deliver

- Snap zones.
- Workspace persistence and switching.
- Floating chat companion.
- Command palette page/action search.
- Live tile overview.
- Keyboard handling and reduced-motion behavior.

### Verification

- full WebUI smoke loop
- browser visual QA across desktop and constrained viewports
- relevant approval, code, and chat harnesses
- documentation update that describes the user-facing workstation mode

## Initial Assessment

This is a large implementation. The safest first implementation slice is Phase 0 plus Phase 1: update the spec relationship, reconcile tokens/themes, and prove no production behavior regresses. The workstation shell should wait until the classic shell and token contract are stable.

## Implementation Log

### 2026-05-01

Initial production slice implemented:

- recorded the design-system handoff relationship in [WEBUI-DESIGN.md](../design/WEBUI-DESIGN.md)
- aligned default Guardian typography tracking with the handoff token contract
- aligned default Guardian shadow, halo, border, glow, and celestial gradient tokens in the theme runtime
- set classic chat rail tokens to the handoff `460px` width in CSS and the theme resolver
- replaced remaining Unicode shell action icons for the killswitch and sidebar collapse control with stroked SVG icons
- moved shell status and danger action states to semantic token-derived `color-mix()` styling
- migrated shared `badge` and `status-badge` primitives to token-derived pill styling
- migrated chat approval controls from inline styles to reusable approval-card classes
- aligned Code-session approval cards with the design-system approval prompt pattern: risk border, warning icon, tool/action preview, primary Approve and danger Deny actions
- updated `Configuration > Appearance` with a Shell Layer setting for switching between Classic Layer and Web Browser Layer
- updated the operator reference guide to describe Appearance as design-system bundles plus typography, text scale, editor alignment, and motion controls
- added an opt-in workstation shell with a top workstation titlebar, workspace tabs, floating page frame, floating assistant frame, bottom dock, command-palette entry point, and route rendering through the existing page modules
- revised the workstation shell to use persistent multi-window route frames: pages open in separate windows, already-open pages are focused/flashed, and geometry/open state is saved locally
- removed the top-left Overview/Code/Security/Cloud workspace buttons from the workstation shell
- expanded workstation resizing to left, right, bottom, bottom-left, and bottom-right handles
- expanded the workstation command palette to include page sections and sub-panels, including config section targets such as Appearance > Shell Layer
- added persistent classic chat rail resizing while preserving the `460px` default
- added responsive classic layout behavior that keeps chat available as a bottom pane on narrower widths
- added responsive workstation fallbacks for narrower viewports

Not yet implemented:

- full page-level inline-style cleanup
- full Appearance page redesign beyond copy/contract alignment
- workstation snap zones, multi-workspace persistence, live tiles, and full command execution
- broad page-level inline-style cleanup
