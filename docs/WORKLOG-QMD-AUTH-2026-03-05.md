# Worklog: Auth + Search Sources + QMD Bundling (2026-03-05)

## Scope completed so far

### 1) Web auth simplified to bearer-only
- Removed no-auth/disabled auth flows from backend and frontend.
- Removed skip/no-auth button in web login modal.
- Removed auth revoke/disable flow from UI and API surface.
- CLI `/auth` now supports only: `status`, `rotate`, `reveal`.

Files touched (auth-related):
- `src/index.ts`
- `src/channels/web.ts`
- `src/channels/web-types.ts`
- `src/channels/cli.ts`
- `web/public/index.html`
- `web/public/js/app.js`
- `web/public/js/api.js`
- `web/public/js/pages/config.js`
- `src/reference-guide.ts`
- docs updates in `docs/specs/*`, `docs/architecture/*`, `docs/guides/*`

### 2) Search Sources UX fixes
- Fixed Add Source button behavior so it always gives feedback (instead of appearing dead).
- Improved guidance messages when QMD runtime is unavailable.
- Updated pending approvals card wording to be less misleading:
  - now says `Pending Tool Approvals`
  - subtitle clarifies this is a global queue across channels.

Primary file:
- `web/public/js/pages/config.js`

### 3) QMD made app-bundled (not manual external setup)
- Added bundled dependency:
  - `@tobilu/qmd` in app dependencies.
- Added install helper script:
  - `npm run ensure:qmd`
  - script path: `scripts/ensure-qmd.mjs`
- QMD runtime resolution changed:
  - app now prefers bundled binary from `node_modules` first,
  - falls back to PATH `qmd` only if bundled path not found.

Primary files:
- `package.json`
- `package-lock.json`
- `scripts/ensure-qmd.mjs`
- `src/runtime/qmd-search.ts`
- `src/runtime/qmd-search.test.ts`
- `src/config/types.ts`
- `src/index.ts`
- `README.md`
- `web/public/js/pages/config.js`

## Windows-specific issue found and addressed
- Root cause discovered: shell quoting for binary execution can fail on Windows when using Unix-style quoting.
- Applied Windows-safe quoting logic in `src/runtime/qmd-search.ts` (`shellQuote`).

## Validation status
- `npm run check` passed.
- `npm test -- src/runtime/qmd-search.test.ts` passed (29/29).
- `dev.ps1` full run passed in your output (54 files / 884 tests passed), and app started successfully.

## What to do when you come back
1. Start app normally (`scripts/dev.ps1` on Windows).
2. In CLI prompt, run:
   - `/tools run qmd_status {}`
3. In web UI, hard refresh (`Ctrl+F5`) and re-check Config -> Search Sources.

If QMD still reports unavailable, run in another PowerShell window from repo root:
- `node_modules\.bin\qmd.cmd --version`

Expected: version output like `qmd 1.0.7`.

## Notes
- There are unrelated, pre-existing workspace changes outside this worklog.
- No commit was created yet.
