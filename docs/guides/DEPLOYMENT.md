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
| `portable:windows` | PowerShell `make-windows-portable.ps1` | Build Windows portable zip |
| `package:windows` | PowerShell `build-windows-package.ps1` | Stage Windows app (no zip) |
| `helper:windows` | PowerShell `build-windows-helper.ps1` | Build Windows sandbox helper (Rust) |
| `installer:windows` | PowerShell `build-windows-installer.ps1` | Build Windows Inno Setup installer |
| `release:windows` | PowerShell `build-windows-release.ps1` | Full Windows release (package + installer) |
| `validate:dependency-contract` | `node scripts/validate-dependency-contract.mjs` | Verify exact pins and root manifest/lockfile alignment |
| `validate:windows-package` | `node scripts/validate-dependency-contract.mjs --stage-root build/windows/app` | Verify generated staged manifests still match the root manifests |

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

Does: Node check → `npm install` → TypeScript build → tests → Ollama check → create default config if missing → start with tsx.

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

## Connector Runtime Tools

### Google Workspace

GuardianAgent uses native Google Workspace OAuth by default. The assistant-facing tool name remains `gws` for compatibility with prompts, policies, skills, and automations, but operator authentication is handled by Guardian's direct Google OAuth flow rather than the Google Workspace CLI.

#### Native Mode (Default)

Calls Google APIs directly via the `googleapis` SDK. OAuth 2.0 PKCE handled within GuardianAgent.

- **No external dependency** — no CLI install needed
- **Config:** `assistant.tools.google` in config.yaml (enabled, mode: `native`, services, credentialsPath)
- **Auth:** Upload `client_secret.json` via web UI, click Connect Google (browser opens for consent)
- **Tokens:** Encrypted at rest in `~/.guardianagent/secrets.enc.json`
- **Web UI:** Configuration > Integrations > Google Workspace (select Native mode)

Native mode is recommended because it reduces setup from 7 steps to 3 and eliminates subprocess latency.

Legacy `gws` CLI auth is no longer the operator path. Existing `gws` tool references still route through Guardian's native Google adapter when Google Workspace is enabled.

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

### Dependency Contract

- `package.json` and `package-lock.json` at the repo root are the only authoritative source for shipped Node dependencies and SDK versions.
- Guardian-owned direct runtime/tooling dependencies are pinned to exact reviewed versions in `package.json`.
- Transitive security remediations are captured as exact-version root `overrides`, rather than ad hoc staging-only changes.
- `build/windows/app/package.json` and `build/windows/app/package-lock.json` are generated packaging copies, not an independent manifest set.
- `build-windows-package.ps1` validates the root dependency contract before packaging and validates the staged manifests again after they are generated.
- You can run `npm run validate:dependency-contract` manually at any time, and `npm run validate:windows-package` after staging a Windows app build.

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
- `npm.cmd` / `npx.cmd` / `corepack.cmd` — bundled when available from the Windows Node.js install used for packaging
- `dist/` — compiled JavaScript
- `web/public/` — dashboard static assets
- `skills/` — bundled skill packs (native manifests and frontmatter-compatible reviewed imports)
- `policies/` — bundled default policy rules
- `SOUL.md` — bundled default SOUL profile when present in the repo
- `node_modules/` — production dependencies
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

The staged `package.json` and `package-lock.json` are copied from the repo root during the build and must match the root manifests exactly.

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
      policies/                   # Default policy rules
      skills/                     # Skill packs (native + reviewed imports)
      SOUL.md                     # Default SOUL profile when present
      web/public/                 # Dashboard assets
      guardianagent.cmd           # Launcher
      node.exe                    # Bundled Node.js
      npm.cmd                     # Bundled when available from local Node install
      npx.cmd                     # Bundled when available from local Node install
      corepack.cmd                # Bundled when available from local Node install
      package.json                # Generated copy of the repo-root manifest
      package-lock.json           # Generated copy of the repo-root lockfile
    helper/
      bin/
        guardian-sandbox-win.exe  # Standalone helper build
    installer/
      GuardianAgent-Setup-{version}.exe
    portable/
      GuardianAgent-windows-portable-{version}/
      GuardianAgent-windows-portable-{version}.zip
```
