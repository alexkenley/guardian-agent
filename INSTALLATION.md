# Installation

GuardianAgent is intended to be installed and started from the repository root.

## Requirements

- Node.js 20 or newer
- A local or external LLM provider you intend to use
- A supported shell environment

SQLite-backed persistence and monitoring are enabled when the Node build includes `node:sqlite`. Otherwise GuardianAgent falls back to in-memory storage for those features.

## Install And Start

Use the platform start script in `scripts/`.

Windows:

```powershell
.\scripts\start-dev-windows.ps1
```

Linux or macOS:

```bash
bash scripts/start-dev-unix.sh
```

These scripts handle dependency checks, native Node dependencies such as `node-pty`, build, browser binary installation (Playwright Chromium), startup, and the initial config bootstrap flow.

## Windows Portable Isolation Build

If you want the additional native Windows isolation layer, use the portable Windows build path. This is the path that bundles the Windows sandbox helper used for stronger subprocess isolation on Windows.

Primary build command:

```powershell
npm run portable:windows
```

This produces the portable Windows package and is the recommended path for Windows users who want the extra isolation layer.

Direct PowerShell script:

```powershell
.\scripts\make-windows-portable.ps1
```

If you want an installer build instead of the portable package:

```powershell
npm run installer:windows
```

Direct PowerShell script:

```powershell
.\scripts\build-windows-installer.ps1
```

Other Windows packaging scripts are also available:

- `.\scripts\build-windows-helper.ps1`
- `.\scripts\build-windows-package.ps1`
- `.\scripts\build-windows-release.ps1`

## First Run

After startup:

1. Open the web UI and go to Configuration Center.
2. Add your LLM provider.
3. Review web auth, tools policy, and channel settings.
4. Enable optional channels such as Telegram if needed.

Most users should configure GuardianAgent through the web UI or CLI rather than editing config files directly.

## More Detail

- Deployment guidance: [docs/guides/DEPLOYMENT.md](/mnt/s/Development/GuardianAgent/docs/guides/DEPLOYMENT.md)
- Windows portable isolation option: [docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md](/mnt/s/Development/GuardianAgent/docs/proposals/WINDOWS-PORTABLE-ISOLATION-OPTION.md)
- Security model: [SECURITY.md](/mnt/s/Development/GuardianAgent/SECURITY.md)
- Architecture overview: [docs/architecture/OVERVIEW.md](/mnt/s/Development/GuardianAgent/docs/architecture/OVERVIEW.md)
