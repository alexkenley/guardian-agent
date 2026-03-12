# Usage

GuardianAgent can be used through:

- Web UI
- CLI
- Telegram

## Common Workflow

1. Start GuardianAgent.
2. Open the web UI or CLI.
3. Configure your model provider and auth settings.
4. Use chat for general requests, tools for guarded actions, and approvals for anything mutating or externally risky.

On Windows, if you want the extra native isolation layer for risky subprocess-backed work, use the portable Windows build described in [INSTALLATION.md](/mnt/s/Development/GuardianAgent/INSTALLATION.md).

## What You Can Do

- chat with the built-in assistant
- inspect tool availability and approvals
- run guarded filesystem, web, and automation tasks
- use orchestrated agents and playbooks
- review audit, monitoring, and threat-intel surfaces

## Operator Surfaces

- Configuration Center for providers, tools, policy, search, and channels
- Security views for audit, monitoring, and threat intelligence
- Network and automation views for connectors, playbooks, and scheduled work

## Approvals And Safety

GuardianAgent uses mandatory runtime enforcement. Depending on policy and risk level, actions may:

- run automatically
- wait for approval
- be denied before execution

For the detailed security model and verification evidence:

- [SECURITY.md](/mnt/s/Development/GuardianAgent/SECURITY.md)
- [docs/security-testing-results/README.md](/mnt/s/Development/GuardianAgent/docs/security-testing-results/README.md)

## More Detail

- Architecture overview: [docs/architecture/OVERVIEW.md](/mnt/s/Development/GuardianAgent/docs/architecture/OVERVIEW.md)
- Integration harness: [docs/guides/INTEGRATION-TEST-HARNESS.md](/mnt/s/Development/GuardianAgent/docs/guides/INTEGRATION-TEST-HARNESS.md)
- Deployment guide: [docs/guides/DEPLOYMENT.md](/mnt/s/Development/GuardianAgent/docs/guides/DEPLOYMENT.md)
