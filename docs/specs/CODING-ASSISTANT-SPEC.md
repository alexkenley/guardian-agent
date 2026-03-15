# Coding Assistant Spec

**Status:** As Built
**Date:** 2026-03-15
**Primary UI:** [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
**Primary Web API:** [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
**Primary Tools:** [executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)

## Purpose

The Coding Assistant is the `Code` page in the web UI. It provides a project-scoped workspace for:

- repository browsing
- file inspection
- diff inspection
- coding-focused assistant chat
- manual shell command execution

It runs on top of the existing Guardian web API and tool system. It is not a separate runtime.

## Current Architecture

The current Code page is implemented as a browser-side workspace shell with server-backed tool and chat calls.

Core pieces:

- Code page UI: [code.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/code.js)
- Styles: [style.css](/mnt/s/Development/GuardianAgent/web/public/css/style.css)
- Generic web API client: [api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js)
- Web API server: [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts)
- Coding tool registrations: [executor.ts](/mnt/s/Development/GuardianAgent/src/tools/executor.ts)

## Session Model

Code sessions are stored in browser `localStorage`.

Each session contains:

- session id
- title
- workspace root
- resolved root
- selected file
- diff toggle state
- expanded explorer directories
- terminal tabs and terminal output
- assistant chat history
- draft assistant message
- selected agent id

If no sessions exist, the page creates a default session automatically.

## Workspace UI

The Code page has four visible areas:

- session rail
- explorer
- editor/diff viewer
- assistant chat

The session rail lets the user:

- create a session
- edit the session title and workspace root
- delete a session
- switch between sessions

The explorer uses `fs_list` to load directory contents.

The editor uses:

- `fs_read` for source content
- `code_git_diff` for diff output

The chat panel sends a normal web message with extra coding context injected into the prompt, including:

- workspace root
- current directory
- selected file
- active skills
- active plan summary
- compacted summary

## Coding Tools Available

The Code page relies on the existing coding tool set registered in the main tool executor.

Built-in coding tools:

- `code_symbol_search`
- `code_edit`
- `code_patch`
- `code_create`
- `code_plan`
- `code_git_diff`
- `code_git_commit`
- `code_test`
- `code_build`
- `code_lint`

These tools are part of the global tool catalog and are not Code-page-only APIs.

## Terminal Behavior

The current terminal area is a PTY-backed shell surface in the Code page.

Behavior as built:

- terminals are per-session UI panes
- each pane maps to a server-side PTY process
- output is streamed to the browser over SSE
- shell state persists within the pane while the session is alive
- pane output is also cached in browser state for reload continuity

The current UI still uses a simple command entry field rather than a full terminal emulator surface, but the shell session itself is now persistent and PTY-backed.

## Shell Execution Path

Manual shell terminals in the Code page use dedicated Code terminal endpoints:

- `POST /api/code/terminals`
- `POST /api/code/terminals/:id/input`
- `POST /api/code/terminals/:id/resize`
- `DELETE /api/code/terminals/:id`

Terminal output and exit events are streamed over SSE:

- `terminal.output`
- `terminal.exit`

The backend uses `node-pty` to spawn the selected shell as a PTY process.

## Shell Selection

Shell options are platform-dependent.

Windows options in the current implementation:

- PowerShell
- CMD
- Git Bash
- WSL
- Bash

macOS options:

- Zsh
- Bash
- sh

Linux options:

- Bash
- Zsh
- sh

Shell selection affects which executable is used when the PTY terminal session is created.

## Current Limitations

As built, the Code page does not provide:

- server-side Code session persistence
- a full browser terminal emulator surface comparable to VS Code

## Verification

Relevant implementation checks in the repo:

- coding assistant harness: [test-coding-assistant.mjs](/mnt/s/Development/GuardianAgent/scripts/test-coding-assistant.mjs)
- code UI smoke: [test-code-ui-smoke.mjs](/mnt/s/Development/GuardianAgent/scripts/test-code-ui-smoke.mjs)
