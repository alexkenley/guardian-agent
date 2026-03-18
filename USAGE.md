# Usage

GuardianAgent can be used through:

- Web UI
- CLI
- Telegram

## Common Workflow

1. Start GuardianAgent.
2. Open the web UI or CLI.
3. Configure your model provider and auth settings.
4. Use chat for general requests, open `#/code` for repository-scoped coding work, and rely on approvals for anything mutating or externally risky.

On Windows, if you want the extra native isolation layer for risky subprocess-backed work, use the portable Windows build described in [INSTALLATION.md](/mnt/s/Development/GuardianAgent/INSTALLATION.md).

## What You Can Do

- chat with the built-in assistant
- use the Coding Assistant for project-scoped coding sessions with their own chat history, repo explorer, diffs, and terminals
- use the Coding Assistant for project-scoped work with backend workspace profiling and focus state, so the session stays aware of what repo it is in and what it is trying to do
- inspect tool availability and approvals
- run guarded filesystem, web, and automation tasks
- use orchestrated agents and playbooks
- review audit, monitoring, and threat-intel surfaces

## Coding Assistant

The web `Code` page is the dedicated client for backend-owned coding sessions rather than a variant of the main chat panel.

- each Code session has its own coding chat history, separate from the general web chat
- each Code session also keeps backend-owned workspace identity, an indexed repo map, a per-turn working set, and focus state derived from repo inspection and retrieval
- repo/app answers are retrieval-backed from that repo map and working set rather than relying on generic host-app context or keyword shortcuts
- the assistant's default reasoning context is the active Code session and attached repo, not GuardianAgent's own host-app repo/app context
- each Code session also keeps separate durable long-term memory rather than reusing Guardian's global memory
- the Code page sends chat and approval actions through dedicated session routes and fails closed if the targeted backend session is unavailable
- the workspace includes a session rail, repo explorer, file/diff viewer, and PTY-backed `xterm.js` terminals
- the assistant sidebar is split into `Chat`, `Tasks`, `Approvals`, and `Checks`
- coding approvals stay in their own tab and appear in chat only as a small notice, which keeps the transcript readable during longer edit/review flows
- assistant-driven file and shell actions are scoped to the active Code workspace root instead of widening the main chat shell policy
- global memory is not injected into Code by default; use `memory_bridge_search` for explicit read-only cross-memory lookups
- broader Guardian actions such as research, automation creation, and other assistant tasks can still be performed from the Coding Assistant without replacing the session's repo anchor
- main chat, CLI, and Telegram can attach to the same backend coding session and continue its transcript, but they remain their own chat surfaces rather than the full Code-page workspace UI

Current implementation details are documented in [docs/specs/CODING-ASSISTANT-SPEC.md](/mnt/s/Development/GuardianAgent/docs/specs/CODING-ASSISTANT-SPEC.md).

## Operator Surfaces

- Configuration Center for providers, tools, policy, search, and channels
- Security views for audit, monitoring, and threat intelligence
- Network and automation views for connectors, playbooks, and scheduled work
- Coding Assistant for repository-scoped implementation, review, approvals, and verification work

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
