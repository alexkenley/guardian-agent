# Daytona Integration Roadmap

## Overview
GuardianAgent uses Daytona as a managed sandbox-compute layer for remote execution of coding tasks. This provides a secure, isolated environment for running potentially risky commands like `npm install`, `test`, and `build` without exposing the host system.

## Status: V1 (Shipped)
- **Bounded Remote Execution:** Support for `code_remote_exec` tool.
- **Ephemeral Sandboxes:** Automatic creation and destruction of sandboxes for one-shot commands.
- **Workspace Staging:** Project files are staged into the sandbox before execution.
- **Artifact Retrieval:** Ability to read back files from the sandbox after execution.
- **Integration with Coding Skills:** `code_test`, `code_build`, and `code_lint` automatically promote to the remote sandbox when one is configured.
- **Managed Package Install:** `package_install` automatically executes in the remote sandbox when one is configured, bypassing local host staging.
- **Deterministic Routing:** Explicit natural language requests like "run pwd in the remote sandbox" are captured by the Intent Gateway and executed via the LLM multi-turn loop using `code_remote_exec`. This ensures missing policy domains and approvals can be handled interactively.

## Future Phases

### Phase 2: Enhanced Efficiency
- **Snapshot-based "Golden" Environments:** Pre-built images for faster startup times.
- **Persistent Volumes:** Shared storage across sandbox runs for caching (e.g., `node_modules`).

### Phase 3: Advanced Workspaces
- **Full Remote Coding Workspaces:** Persistent sessions for long-running tasks.
- **Terminal/Log Streaming:** Real-time feedback from remote processes.
- **Remote Browser/Computer-Use:** Leveraging Daytona's computer-use APIs for UI testing.

### Phase 4: Platform Scale
- **Long-running Agent Jobs:** Hosting independent agent processes in Daytona.
- **Multi-region/Runner Controls:** Fine-grained policy controls for workload placement.

## Configuration
Daytona is configured via the Cloud Connections UI. API keys should be permission-scoped to the necessary sandbox operations.
