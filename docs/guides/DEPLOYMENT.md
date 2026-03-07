# Deployment Guide

Quick reference for all build, dev, and release scripts.

---

## Prerequisites

- **Node.js >= 20.0.0** (required by engines field and dependencies)
- **npm** (ships with Node.js)
- **Rust / cargo** (only for building the Windows sandbox helper)
- **Inno Setup** (only for building the Windows installer)

---

## npm Scripts

Run these from the repo root with `npm run <script>`.

| Script | Command | Description |
|---|---|---|
| `dev` | `tsx src/index.ts` | Start in dev mode (TypeScript direct execution) |
| `dev:unix` | `bash scripts/start-dev-unix.sh` | Full dev pipeline (Linux/macOS/WSL) |
| `dev:sh` | Alias for `dev:unix` | |
| `start` | `node dist/index.js` | Run compiled build |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `check` | `tsc --noEmit` | Type-check without emitting |
| `clean` | `rm -rf dist` | Remove build output |
| `test` | `vitest run` | Run all tests |
| `test:verbose` | `vitest run --reporter=verbose` | Verbose test output |
| `test:coverage` | `vitest run --coverage` | Run with v8 coverage |
| `ensure:qmd` | `node scripts/ensure-qmd.mjs` | Ensure QMD CLI is installed |
| `portable:windows` | PowerShell `make-windows-portable.ps1` | Build Windows portable zip |
| `package:windows` | PowerShell `build-windows-package.ps1` | Stage Windows app (no zip) |
| `helper:windows` | PowerShell `build-windows-helper.ps1` | Build Windows sandbox helper (Rust) |
| `installer:windows` | PowerShell `build-windows-installer.ps1` | Build Windows Inno Setup installer |
| `release:windows` | PowerShell `build-windows-release.ps1` | Full Windows release (package + installer) |

---

## Development Workflows

### Quick Start (any platform)

```bash
npm install
npm run dev
```

### Full Dev Pipeline (Unix)

```bash
bash scripts/start-dev-unix.sh
```

Does: Node check → `npm install` → ensure bundled tools (QMD, GWS) → TypeScript build → tests → Ollama check → create default config if missing → start with tsx.

**Flags:**
- `--skip-tests` — skip test step
- `--build-only` — build + test, don't start
- `--start-only` — start without rebuilding (requires prior build)

### Full Dev Pipeline (Windows)

```powershell
.\scripts\start-dev-windows.ps1
```

Same pipeline as Unix, plus: detects cross-platform node_modules (WSL vs Windows), auto-enables web dashboard, generates web auth token if missing.

**Flags:**
- `-SkipTests` — skip test step
- `-BuildOnly` — build + test, don't start
- `-StartOnly` — start without rebuilding

---

## Bundled CLI Tools

Two external CLI tools are bundled as npm dependencies and verified at startup:

### QMD (`@tobilu/qmd`)

Document search CLI for hybrid BM25 + vector + LLM re-rank search. Used by `QMDSearchService` for the `qmd_search`, `qmd_status`, `qmd_reindex` tools.

- **Ensure script:** `scripts/ensure-qmd.mjs`
- **Binary:** `node_modules/.bin/qmd` (or `qmd.cmd` on Windows)
- **Config:** `assistant.tools.qmd` in config.yaml

### Google Workspace CLI (`@googleworkspace/cli`)

Unified CLI for Google Drive, Gmail, Calendar, Sheets, Docs, Chat, and Admin APIs. Runs as an MCP server (`gws mcp -s drive,gmail,calendar`) spawned by GuardianAgent's managed provider system.

- **Not bundled** — install separately: `npm install -g @googleworkspace/cli`
- **Config:** `assistant.tools.mcp.managedProviders.gws` in config.yaml
- **Auth:** Run `gws auth setup` then `gws auth login` in a terminal (requires interactive browser OAuth)
- **Web UI:** See Settings > Google Workspace for full setup instructions

---

## Local Build & Test

```bash
bash scripts/dev-build.sh
```

Does: clean build → tests → `npm pack` tarball → prints install options.

**Testing the tarball:**
```bash
# Global install
npm install -g ./guardianagent-1.0.0.tgz
guardianagent

# Direct run
node dist/index.js

# Dev mode
npm run dev

# Linked development (live updates)
npm link
guardianagent
```

---

## npm Publish Pipeline

```bash
bash scripts/deploy.sh
```

Does: tests → clean build → verify `dist/index.js` + shebang → `npm pack --dry-run` preview → summary with next steps.

**Does NOT publish.** After reviewing the output:
```bash
npm publish              # publish to npm
npm publish --dry-run    # preview only
```

---

## Windows Builds

All Windows scripts require PowerShell and must be run on Windows.

### Portable App

```powershell
# Full portable build (package + zip)
.\scripts\make-windows-portable.ps1

# Or via npm
npm run portable:windows
```

**What it produces:** `build/windows/portable/GuardianAgent-windows-portable-{version}.zip`

The zip contains a self-contained app with:
- `node.exe` — bundled Node.js runtime
- `dist/` — compiled JavaScript
- `web/public/` — dashboard static assets
- `skills/` — bundled skill packs
- `node_modules/` — production dependencies (including QMD and GWS binaries)
- `bin/guardian-sandbox-win.exe` — AppContainer sandbox helper (if built)
- `config/portable-config.yaml` — default config with sandbox enabled
- `guardianagent.cmd` — launcher script

**Sandbox helper resolution** (in order):
1. Explicit path via `-SandboxHelperPath`
2. `GUARDIAN_SANDBOX_HELPER` environment variable
3. Auto-build from Rust source via `build-windows-helper.ps1`

**Usage after extraction:**
```cmd
cd GuardianAgent-windows-portable-1.0.0
guardianagent.cmd
```

### Staged App (no zip)

```powershell
.\scripts\build-windows-package.ps1
```

Same as portable but stops before zipping. Output at `build/windows/app/`.

**Flags:**
- `-OutputRoot <path>` — output directory (default: `build/windows`)
- `-SandboxHelperPath <path>` — pre-built helper binary
- `-BuildHelper` — force rebuild of sandbox helper
- `-RequireHelper` — fail if helper unavailable
- `-AllowNoHelper` — allow build without helper
- `-SkipInstall` — skip `npm ci` (use existing node_modules)
- `-SkipZip` — skip portable zip creation

### Windows Sandbox Helper

```powershell
.\scripts\build-windows-helper.ps1
```

Builds the Rust AppContainer sandbox helper from `native/windows-helper/`. Requires `cargo` on PATH.

Output: `build/windows/helper/bin/guardian-sandbox-win.exe`

### Windows Installer (Inno Setup)

```powershell
.\scripts\build-windows-installer.ps1
```

Requires [Inno Setup](https://jrsoftware.org/isinfo.php) installed. Searches for `ISCC.exe` in registry paths or `ISCC_PATH` env var.

Does: package app → compile Inno Setup script → output installer to `build/windows/installer/`.

### Full Windows Release

```powershell
.\scripts\build-windows-release.ps1
```

Orchestrates: `build-windows-package.ps1` → `build-windows-installer.ps1`. Everything lands under `build/windows/`.

---

## Configuration

Config is loaded from `~/.guardianagent/config.yaml` at runtime. The dev scripts auto-create a default config if none exists.

The portable Windows build uses `config/portable-config.yaml` inside the app directory (overridable via `GUARDIAN_CONFIG_PATH` env var).

See the main README.md for the full config reference.

---

## Build Output Layout

```
build/
  windows/
    app/                          # Staged app (build-windows-package.ps1)
      bin/
        guardian-sandbox-win.exe  # AppContainer helper
        README.txt
      config/
        portable-config.yaml
        windows-portable-isolation.example.yaml
      dist/                       # Compiled JS
      node_modules/               # Production deps
      skills/                     # Skill packs
      web/public/                 # Dashboard assets
      guardianagent.cmd           # Launcher
      node.exe                    # Bundled Node.js
      package.json
      package-lock.json
    helper/
      bin/
        guardian-sandbox-win.exe  # Standalone helper build
    installer/
      GuardianAgent-Setup-{version}.exe
    portable/
      GuardianAgent-windows-portable-{version}/
      GuardianAgent-windows-portable-{version}.zip
```
