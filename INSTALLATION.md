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

These scripts handle dependency checks, build, startup, and the initial config bootstrap flow.

## First Run

After startup:

1. Open the web UI and go to Configuration Center.
2. Add your LLM provider.
3. Review web auth, tools policy, and channel settings.
4. Enable optional channels such as Telegram if needed.

Most users should configure GuardianAgent through the web UI or CLI rather than editing config files directly.

## More Detail

- Deployment guidance: [docs/guides/DEPLOYMENT.md](/mnt/s/Development/GuardianAgent/docs/guides/DEPLOYMENT.md)
- Security model: [SECURITY.md](/mnt/s/Development/GuardianAgent/SECURITY.md)
- Architecture overview: [docs/architecture/OVERVIEW.md](/mnt/s/Development/GuardianAgent/docs/architecture/OVERVIEW.md)
