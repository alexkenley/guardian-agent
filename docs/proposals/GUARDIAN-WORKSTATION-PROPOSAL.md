# Guardian Workstation Proposal

**Status:** Design Proposal  
**Date:** 2026-04-23  
**Owner:** WebUI Uplift  
**Supersedes:** none — additive to WEBUI-DESIGN.md  

## Vision

Evolve the GuardianAgent WebUI from a traditional dashboard-with-sidebar into a **spatial workstation**: a web-based operating environment where pages are windows, context is workspace-scoped, and the user orchestrates multiple operational domains simultaneously. The existing theme engine, page ownership rules, and chat panel stay intact; this proposal adds a new *shell layer* over them.

## Guiding Principles

1. **The shell is optional.** A user can stay in classic sidebar mode forever. The workstation is an opt-in power-user shell that unlocks when desired.
2. **Pages stay pages.** Every page defined in WEBUI-DESIGN.md remains a self-contained surface. We do not fragment pages into smaller units.
3. **Themes rule everything.** The workstation shell must derive its chrome colors, typography, geometry, and motion from the existing CSS variable system. No hardcoded workstation chrome.
4. **Chat is ambient.** The persistent chat panel graduates from a fixed sidebar column into a floating, collapsible, always-available companion.
5. **Context, not clutter.** Workstation features exist to reduce context-switching, not to add decoration.

## Core Concepts

### 1. Workspaces

A workspace is a named, persisted layout of open windows. By default there is one workspace. Power users can create additional workspaces.

| Workspace Type | Default Hotkey | Typical Contents |
|---|---|---|
| `Overview` | none (default) | System + Security Overview tiles |
| `Code` | `Ctrl+2` | Code page + floating chat |
| `Security` | `Ctrl+3` | Security > Security Log + Network > Overview |
| `Cloud` | `Ctrl+4` | Cloud > Connections + Automations |
| `Custom` | user-defined | any saved layout |

Rules:
- Workspace state restores on reload.
- Switching workspaces swaps the window layout instantly.
- The active workspace name appears in the global header.
- Workspaces do not duplicate tab state inside pages; they only remember which pages are open, their size, and their position.

### 2. Floating Frames (Windows)

Pages render inside **frames**: draggable, resizable, minimizable, and closeable containers.

Frame chrome derives from CSS variables:
- Frame border: `var(--border-strong)`
- Frame header bg: `var(--panel-header-bg)`
- Active frame accent: 2px bottom border in `var(--accent)`
- Frame radius: `var(--radius-lg)`
- Frame shadow: `var(--panel-shadow)`

Frame behaviors:
- **Drag** by the header. Snap to edges and other frames.
- **Resize** from any corner or edge.
- **Minimize** to the taskbar/dock without losing scroll position.
- **Maximize** fills the viewport minus top bar and dock.
- **Close** destroys the frame; navigating to the same page from the dock reopens it.
- **Backdrop blur** on inactive frames at `2px` using `var(--bg-primary)` at 60% opacity.

The existing page JS modules need no changes to render inside a frame; the frame is a layout wrapper that sets the content `div` to `document.getElementById('content')` scoped to the frame.

### 3. Taskbar / Dock

A bottom bar (40-48px) anchored to the viewport base.

Left cluster:
- **Workspace switcher** (icon + name)
- **Open frame icons** (page favicons/icons with active-state dot)
- **Unsaved indicator** on frames with dirty state

Right cluster:
- **Chat toggle** (opens/closes the floating chat companion)
- **Command palette trigger** (magnifying glass)
- **Theme preview dot** (current accent color)
- **Clock & connection indicator** (moved from header)

The dock uses the current sidebar item styling: high-contrast text, accent-left markers for active frames, and hover transforms. It respects `var(--font-nav-tracking)` and `var(--font-nav-transform)`.

### 4. Global Command Palette

A universal overlay (`Cmd+K` / `Ctrl+K`) for jumping to any page, tab, or action.

Sources:
1. **Pages** — every route in the left-nav order
2. **Tabs** — every tab within the current page (if a frame is focused)
3. **Actions** — "New automation", "Run security scan", "Clear pending approvals", etc.
4. **Theme switcher** — quick-preview theme via palette (ephemeral until confirmed)
5. **Workspace switcher** — jump to workspace by name

Palette styling:
- Background: `var(--bg-elevated)` at 95% opacity with backdrop blur
- Border: `var(--border-strong)`
- Search input: `var(--bg-input)` with `var(--focus-ring)` on focus
- Selected row: `var(--nav-active-bg)` with left accent marker
- Fuzzy matching on name, description, and search terms

### 5. Live Dashboard (Overview Workspace)

When no frames are open, the desktop shows a grid of **live tiles** — compact, auto-updating summary cards for each major domain.

Each tile:
- Shows 1-3 key metrics (counts, status, last-seen)
- Is a deep-link into its owning page
- Refreshes on the same SSE/WebSocket channels that feed the full pages
- Uses existing `StatusCard` component pattern
- Hover: subtle lift + destination tooltip

Tile layout adapts to viewport: 2 columns on small, 3 on medium, 4+ on large. Tiles respect the current theme radius and shadow.

### 6. Floating Chat Companion

The current 480-560px fixed chat panel becomes a **floating companion window**.

- **Detached mode**: free-floating frame, movable, resizable. Useful when a Code window and Chat are both needed.
- **Docked mode**: snaps to right edge, collapses to a thin strip showing only the conversation title + unread badge.
- **Always-on-top option**: floats above other frames.
- **Minimized state**: reduced to a circular avatar/button in the dock.

Chat chrome uses the same frame styling as pages. The chat toolbar (Provider, Stop, Reset) stays in the header bar of the chat frame.

### 7. Split-Screen & Side-by-Side

Two frames can be snapped together:
- **Vertical split**: left frame 50%, right frame 50%
- **Horizontal split**: top/bottom
- **Tabbed stack**: multiple pages in one frame with internal tabs (uses existing `tabs.js`)

A "Snap Zones" overlay appears during drag: faint translucent rectangles showing drop targets, colored with `var(--accent)` at 15% opacity.

## Visual States

### Default (Classic Mode)
- Sidebar visible (220px)
- Content area full-width
- Chat panel docked right
- This is today's UI, preserved exactly

### Workstation Mode
- Sidebar hidden (toggle in header or `Ctrl+\`)
- Desktop canvas visible
- Frames float freely
- Dock at bottom
- Chat as floating companion

Toggle between modes instantly; no reload required. Preference persisted to `localStorage`.

## Architecture

### New Files

| File | Purpose |
|---|---|
| `web/public/js/workstation/workstation-shell.js` | Workspace state, mode toggle, layout engine |
| `web/public/js/workstation/frame-manager.js` | Frame creation, drag, resize, z-index, snap |
| `web/public/js/workstation/dock.js` | Taskbar rendering, workspace switcher, frame icons |
| `web/public/js/workstation/command-palette.js` | Overlay, fuzzy search, action dispatch |
| `web/public/js/workstation/live-tiles.js` | Overview desktop tile grid |
| `web/public/js/workstation/chat-companion.js` | Floating chat wrapper (reuses existing chat-panel.js) |
| `web/public/js/workstation/snap-zones.js` | Snap overlay during drag |
| `web/public/js/workstation/persistence.js` | Save/restore layout and workspace state |
| `web/public/css/workstation.css` | Shell chrome, frame borders, dock, palette, snap zones |

### No-Changes List

The following do **not** need changes:
- Every file in `web/public/js/pages/*.js`
- Every file in `web/public/js/components/*.js`
- `web/public/js/chat-*.js` (chat UI logic)
- `web/public/js/theme.js`
- `web/public/js/curated-theme-seeds.js`
- `web/public/css/style.css` (existing styles remain valid)
- `index.html` (adds one script bundle)

### Integration Point

`app.js` currently renders pages into `#content`. The workstation shell intercepts this: in workstation mode, page routes render into frame containers on the desktop canvas instead of the fixed `#content` div. In classic mode, behavior is unchanged.

```js
// Pseudocode in app.js router
function navigate(pageId) {
  if (workstationShell.isActive()) {
    workstationShell.openFrame(pageId);
  } else {
    classicRender(pageId);
  }
}
```

## Theme Compatibility

The workstation must look good across every theme in the catalog — including Cyberpunk, Dracula, Synthwave, and brand-curated themes like Ferrari red.

Requirements:
1. **Chrome colors** must derive from `var(--bg-surface)`, `var(--border)`, `var(--accent)`, etc. No assumptions about dark/light.
2. **Frame shadows** use `var(--panel-shadow)` regardless of glow color.
3. **Active state** uses `var(--accent)`; do not special-case neon themes.
4. **Backdrop blur** must respect `data-reduce-motion`. When motion is reduced, skip blur and use opacity transitions at 0.01ms.
5. **Dock height** scales with `var(--font-scale)` so text never clips.

Test themes for visual QA:
- `guardian-angel` (default)
- `cyberpunk` (neon yellow on black)
- `synthwave` (pink/purple glow)
- `curated-ferrari` (red dominant)
- `curated-claude` (warm light)
- `standard-light` (neutral light)

## Phased Implementation

### Phase 1: Foundation
- Add workstation mode toggle (sidebar button + hotkey)
- Implement frame manager: create, drag, resize, close
- Single frame type: renders page content, no persistence yet
- Classic mode remains default; workstation is experimental

### Phase 2: Dock & Chat
- Add bottom dock with open-frame icons
- Convert chat panel to floating companion
- Add minimize/maximize/restore on frames
- Persist frame positions in `localStorage`

### Phase 3: Workspaces & Command Palette
- Workspace CRUD (create, rename, switch, delete)
- Global command palette (`Cmd+K`) with page/tab/action search
- Live tile grid on empty desktop
- Workspace persistence

### Phase 4: Polish
- Snap zones and split-screen
- Multi-frame tab stacking
- Keyboard shortcuts for frame navigation (`Ctrl+Tab`, `Ctrl+W`, `Ctrl+N`)
- Mobile/touch considerations: simplified workstation mode or disabled

## Acceptance Criteria

1. Classic mode is pixel-for-pixel identical to today's UI.
2. Workstation mode opens any existing page in a frame without JS errors.
3. All 80+ themes render workstation chrome correctly.
4. Workspace state survives reload.
5. Chat remains functional as a floating companion.
6. No changes to `style.css` break existing pages or components.
7. Command palette finds a page by partial name in under 100ms.

## Open Questions

1. Should the sidebar be completely hidden in workstation mode, or collapsible to a narrow strip (like macOS Dock in vertical orientation)?
2. Should frames be constrained to the desktop canvas, or allowed to float partially off-screen?
3. Should we add a "presentation mode" where one frame fills the entire viewport, hiding dock and chrome?
4. Should live tiles support custom user-chosen metrics, or only show the canonical summary for each domain?
5. Do we want window tiling presets (e.g., "grid of 4") as first-class workspace templates?

## Relationship to Existing Design Docs

- **WEBUI-DESIGN.md** remains the source of truth for page content, tab structure, and domain ownership. This proposal only concerns the *shell* around those pages.
- **TOOLS-CONTROL-PLANE-DESIGN.md** is unaffected; tool discovery and deferred loading continue to work inside frames.
- Performance and security pages remain first-class owners of their domains even when rendered inside frames.

---

*This proposal is additive and reversible. It does not lock in any page-level changes and can be developed entirely in the workstation module boundary without touching page or component code.*
