# Execution Identity Hardening Proposal

**Status:** Proposed  
**Date:** 2026-03-19  
**Triggered by:** internal review against the article "How Claude Code escapes its own denylist and sandbox"  
**Primary concern:** command-string policy can be bypassed through allowed interpreters or launchers that execute disallowed descendants

---

## Executive Summary

GuardianAgent is stronger than the article's Claude Code example in two important ways:

- it uses an allowlist for `shell_safe`, not a denylist
- strict sandbox blocking is enforced outside the model rather than delegated to prompt text

But the current model still has a real weakness:

- command policy is attached mainly to the top-level shell string
- allowed interpreters and launchers can execute non-allowlisted binaries as descendants
- degraded sandbox hosts still permit risky subprocess-backed tools when `assistant.tools.sandbox.enforcementMode` is `permissive`

That means GuardianAgent resists the article's exact `/proc/self/root/...` bypass, but it is still susceptible to the broader execution-identity problem behind it.

The hardening goal is not to build a kernel product inside TypeScript. It is to:

1. make Guardian's command policy follow the actual executable identity as far as the current architecture can support
2. close the highest-value interpreter and launcher trampolines in app-layer policy
3. make strong-vs-degraded guarantees explicit instead of implied
4. add an optional strong-host descendant-exec enforcement path for users who need real guarantees
5. limit downstream impact through egress and secret brokering even when a child process does run

---

## What We Verified

The current repo behavior already shows the relevant gap:

- full-path aliases such as `/usr/bin/python3 --version` and `/proc/self/root/usr/bin/python3 --version` are rejected when `python3` is merely allowlisted as a bare command prefix
- non-code `shell_safe` blocks many shell metacharacter forms
- code-session `shell_safe` accepts a broader command set and uses richer token validation than the non-code path
- an allowlisted interpreter can still launch a non-allowlisted executable

Local verification on the current codebase confirmed:

- `python3 -c "__import__('os').system('/usr/bin/id')"` succeeded when `python3` was allowlisted
- code-session `shell_safe` also permitted `python3 -c "...subprocess.run(['/usr/bin/id'])..."` under the coding-session allowlist
- current host sandbox health is `linux / degraded / ulimit / permissive`, so risky subprocess-backed tools remain available on this host

This is the flavor of vulnerability this proposal addresses.

---

## Problem Statement

GuardianAgent currently treats shell policy as a property of the requested command string.

That is necessary, but not sufficient.

An agent can still reason its way around command-prefix policy by using:

- interpreters: `python`, `python3`, `node`, `php`, `ruby`, `deno`
- launchers: `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `uv run`
- build tools that can execute arbitrary subprocesses: `make`, `cmake`, `gradle`, `mvn`, `cargo`
- shell-like wrappers or eval flags: `bash -c`, `sh -c`, `node -e`, `python -c`, `php -r`

This is fundamentally different from a normal "bad command string" problem.

The actual security boundary we need is:

- not "did the first token look allowlisted?"
- but "what executable identities actually ran, and were they allowed?"

Guardian cannot honestly claim that boundary today for general child processes.

---

## Goals

1. Prevent non-allowlisted descendant binaries from being launched through allowlisted trampolines in the common cases.
2. Remove shell-string semantics from `shell_safe` wherever they are not required.
3. Shrink the set of generic interpreters and launchers exposed to the model by default.
4. Fail closed on weak hosts when the requested command class requires stronger descendant-exec controls.
5. Preserve practical developer workflows by routing common build/test/lint tasks through more structured tools.
6. Add regression coverage for the exact bypass class we reproduced.

---

## Non-Goals

1. Do not promise universal kernel-grade content-addressable enforcement in the core TypeScript runtime.
2. Do not rely on prompt instructions or LLM self-restraint as the primary fix.
3. Do not attempt to perfectly detect malicious intent from inline code strings.
4. Do not keep broad interpreter access merely for convenience if it materially weakens the boundary.

---

## Current Weak Points

### 1. Shell policy is top-level, not descendant-aware

`shell_safe` validates the requested command and then executes it, but Guardian does not yet enforce policy on child `exec` operations performed by the launched process tree.

Practical consequence:

- `python3` can run `/usr/bin/id`
- `node` can call `child_process.spawn`
- `npx` can materialize and execute packages

### 2. Code sessions expose a broad interpreter set

The Coding Assistant allowlist currently includes broad interpreters and launchers because it optimizes for convenience and repo-local developer workflows.

Practical consequence:

- the strongest shell surface in the product is also the easiest place for a model to trampoline into other binaries

### 3. `shell_safe` is still a shell-string API

Even when the command is validated, Guardian's execution path still treats the request as a string command.

Practical consequence:

- policy logic reasons over strings
- the runtime does not have a first-class structured execution identity model

### 4. Degraded hosts remain operational in permissive mode

On degraded hosts, Guardian warns but still allows risky subprocess-backed tools when permissive mode is enabled.

Practical consequence:

- operators can easily overestimate the real strength of the boundary

### 5. Downstream egress containment is incomplete

Even when command policy is strong, Guardian does not yet provide a universal supervisor-owned egress broker for subprocesses.

Practical consequence:

- a child process that does run may still retain meaningful outbound leverage

---

## Proposed Changes

### Workstream 1: Immediate Surface Reduction

**Objective:** close the easiest trampoline paths without waiting for native helper work.

**Changes**

- Remove or sharply reduce generic interpreter and launcher entries from the default `shell_safe` surface where specialized tools already exist.
- Narrow `CODE_ASSISTANT_ALLOWED_COMMANDS` to commands that are primarily direct tooling rather than arbitrary execution environments.
- Treat the following as high-risk indirect-exec launchers by default:
  - `python -c`
  - `python3 -c`
  - `python -m`
  - `python3 -m`
  - `node -e`
  - `node --eval`
  - `php -r`
  - `ruby -e`
  - `deno eval`
  - `bash -c`
  - `sh -c`
  - `npx`
  - `npm exec`
  - `pnpm dlx`
  - `yarn dlx`
  - `uv run`
- Make these forms one of:
  - denied by default
  - or require a stronger execution class plus manual approval
- Never auto-learn or auto-persist approval patterns for `shell_safe` commands in the interpreter/launcher class.

**Rationale**

This is the fastest way to remove the exact bypass we reproduced.

**Primary files**

- `src/tools/executor.ts`
- `src/guardian/argument-sanitizer.ts`
- `src/guardian/shell-validator.ts`
- `src/prompts/guardian-core.ts`
- `src/config/types.ts`

---

### Workstream 2: Structured Command Execution Model

**Objective:** stop treating `shell_safe` as an opaque shell string when shell semantics are not actually needed.

**Changes**

- Introduce a structured execution model:

```ts
interface StructuredCommandRequest {
  executable: string;
  args: string[];
  cwd?: string;
  requestedViaShell: boolean;
  executionClass: 'direct_binary' | 'interpreter_inline' | 'launcher' | 'script_file' | 'shell_expression';
}
```

- Parse and validate `shell_safe` input into this structure before execution.
- For `direct_binary` commands:
  - resolve the executable through PATH once
  - normalize the resolved executable path
  - execute with `sandboxExecFile` / `sandboxedSpawn`, not `/bin/sh -c`
- Reserve true shell-expression execution for an explicit high-risk path rather than the default shell tool behavior.
- Store audit logs against the resolved executable identity, not only the raw input string.

**Rationale**

This does not solve descendant exec by itself, but it gives Guardian a real execution-identity model instead of a string model.

**Primary files**

- `src/tools/executor.ts`
- `src/sandbox/index.ts`
- `src/tools/types.ts`
- `src/reference-guide.ts`

---

### Workstream 3: Interpreter and Launcher Policy Classes

**Objective:** make Guardian reason about command families, not just token prefixes.

**Changes**

- Add explicit execution classes:
  - `direct_binary`
  - `interpreter_inline`
  - `script_runner`
  - `package_launcher`
  - `build_or_task_runner`
  - `shell_expression`
- Extend policy evaluation to use execution class as a first-class attribute.
- Default policy behavior:
  - `direct_binary`: allow or approve according to normal policy
  - `interpreter_inline`: deny by default
  - `package_launcher`: deny by default
  - `build_or_task_runner`: require explicit per-command approval or template-based safe routing
  - `shell_expression`: require explicit approval and strong-host sandbox availability
- Add distinct operator-facing explanations so the user sees why a trampoline form is blocked.

**Rationale**

The right abstraction is not "python is allowed" but "inline interpreter execution is a different risk class from running pytest."

**Primary files**

- `src/policy/normalize-tool.ts`
- `src/policy/engine.ts`
- `policies/base/tools.json`
- `src/tools/executor.ts`

---

### Workstream 4: Replace Generic Coding-Surface Shell With Safer Primitives

**Objective:** preserve practical coding workflows without keeping broad arbitrary-exec access open.

**Changes**

- Prefer dedicated tools for common coding actions:
  - `code_test`
  - `code_build`
  - `code_lint`
  - `code_git_*`
- Give these tools structured runner templates rather than general shell entry.
- If a repo needs a custom command, record it as an explicit per-session approved command template instead of exposing broad interpreter families.
- Add a distinct tool for "run workspace script file" only if needed, with:
  - path confined to workspace root
  - clear file provenance in audit
  - stronger review than ordinary `shell_safe`

**Rationale**

The model should not need `python -c` or `node -e` to run tests, builds, or repo automation.

**Primary files**

- `src/tools/executor.ts`
- `src/runtime/code-sessions.ts`
- `src/prompts/code-session-core.ts`
- `docs/specs/CODING-WORKSPACE-SPEC.md`

---

### Workstream 5: Strong-Host Descendant Exec Enforcement

**Objective:** provide a real enforcement path for the question "what binaries actually ran beneath this allowed parent?"

**Changes**

- Define a new optional strong-host feature: `executionIdentity.enforcement`.
- Introduce a helper-owned descendant-exec policy contract:

```ts
interface DescendantExecPolicy {
  allowedExecutables: string[];
  deniedExecutables: string[];
  allowedHashes?: string[];
  mode: 'audit' | 'enforce';
}
```

- On supported hosts, the native helper should own process-tree creation and enforce descendant exec policy, not just top-level spawn.
- Linux path:
  - evaluate a native helper or host-agent integration that can observe and block descendant `execve`
  - prefer inode/hash-aware enforcement where practical
- Windows path:
  - extend `guardian-sandbox-win.exe` toward descendant process policy rather than only top-level launch isolation
- macOS / unsupported:
  - remain explicit that this guarantee is unavailable

**Rationale**

App-layer command validation can reduce risk. It cannot fully solve descendant execution on its own.

**Important product rule**

Guardian should not claim "execution identity enforcement" on a host unless this descendant-exec layer is present and active.

**Primary files**

- `src/sandbox/index.ts`
- `src/sandbox/types.ts`
- `native/windows-helper/*`
- new native helper or host-agent integration path for Linux
- UI / API surfaces that expose sandbox strength

---

### Workstream 6: Fail-Closed Rules On Weak Hosts

**Objective:** align runtime behavior with the actual strength of the host.

**Changes**

- Add a second capability check beyond sandbox availability:
  - `supportsDescendantExecEnforcement`
- If a command falls into `interpreter_inline`, `package_launcher`, or other indirect-exec classes:
  - block it in strict mode unless descendant-exec enforcement is available
- Consider making code-session shell stricter than generic chat shell:
  - if host is degraded, disable high-risk shell classes even when basic shell is still available
- Improve runtime notices so they tell the operator which guarantees are missing:
  - top-level sandbox only
  - no descendant exec enforcement
  - no subprocess egress broker

**Rationale**

The current strong/degraded split is useful, but it is still too coarse for this class of vulnerability.

**Primary files**

- `src/tools/executor.ts`
- `src/sandbox/types.ts`
- `src/index.ts`
- web tools status surfaces

---

### Workstream 7: Downstream Egress and Secret Brokering

**Objective:** reduce the impact of any subprocess that still runs.

**Changes**

- Reuse and prioritize the existing sandbox-egress roadmap for:
  - secret handles instead of plaintext child env vars
  - supervisor-owned egress broker
  - attached provider capability model
  - protected subprocess classes
- Prioritize MCP, browser, and other network-capable child-process surfaces first.

**Rationale**

Even with better execution identity, defense in depth should still limit what a successful child process can do next.

**Dependency**

- `docs/proposals/SANDBOX-EGRESS-AND-SECRET-BROKERING-ROADMAP.md`

---

## Rollout Plan

### Phase 0: Visibility and Operator Warning

- ship telemetry for execution classes
- log all interpreter-inline and launcher requests
- add UI notices for degraded hosts and missing descendant-exec enforcement

### Phase 1: Immediate App-Layer Hardening

- deny interpreter-inline and launcher forms by default
- narrow the coding-session allowlist
- keep `shell_safe` focused on direct binaries and simple repo-local commands

### Phase 2: Structured Execution Path

- move `shell_safe` to structured parsing + direct exec for non-shell commands
- update policy normalization to understand execution classes

### Phase 3: Coding Workflow Migration

- route test/build/lint/git flows through dedicated structured tools
- reduce dependence on generic shell for normal coding tasks

### Phase 4: Strong-Host Native Enforcement

- add descendant-exec enforcement in helper or host-agent form
- expose this as a first-class runtime capability

### Phase 5: Egress and Secret Brokering

- make subprocess egress policy and secret handling supervisor-owned where possible

---

## Acceptance Tests

### Unit / executor tests

- `/usr/bin/python3 --version` is rejected unless the exact execution class is allowed
- `/proc/self/root/usr/bin/python3 --version` is rejected
- `python3 -c "__import__('os').system('/usr/bin/id')"` is denied
- `python3 -c "import subprocess; ..."` is denied
- `node -e "require('child_process').spawnSync(...)"` is denied
- `npx <pkg>` is denied or routed to explicit high-risk approval path
- `npm exec <cmd>` is denied or routed to explicit high-risk approval path
- direct safe commands such as `git status` and `pytest -q` still work when explicitly allowed

### Coding-session tests

- code-session shell refuses interpreter-inline forms by default
- code-session shell still permits expected structured repo commands
- path-confined commands still work with workspace-root enforcement

### Sandbox / platform tests

- strict mode on degraded host blocks indirect-exec command classes
- strong-host mode reports descendant-exec enforcement capability accurately
- MCP/browser subprocess startup reflects whether the host supports the required enforcement level

### Regression / harness tests

- add a dedicated harness that attempts:
  - path alias execution
  - interpreter trampoline execution
  - launcher-based execution
  - descendant child-process execution
  - network egress after allowed-parent launch

---

## Proposed File Touchpoints

### Immediate implementation

- `src/tools/executor.ts`
- `src/guardian/argument-sanitizer.ts`
- `src/guardian/shell-validator.ts`
- `src/policy/normalize-tool.ts`
- `src/policy/engine.ts`
- `policies/base/tools.json`
- `src/config/types.ts`
- `src/config/loader.ts`
- `src/prompts/guardian-core.ts`
- `src/prompts/code-session-core.ts`
- `src/tools/executor.test.ts`
- `src/sandbox/sandbox.test.ts`
- `scripts/test-security-verification.mjs`

### Follow-on native/helper work

- `src/sandbox/index.ts`
- `src/sandbox/types.ts`
- `native/windows-helper/src/main.rs`
- new Linux helper or host-agent integration path

---

## Open Decisions

1. Should broad interpreters be removed from the Coding Assistant entirely, or only moved behind a stronger approval class?
2. Should `npx` remain available anywhere in product defaults?
3. Should `shell_safe` keep any true shell-expression support, or should that become a separate explicitly dangerous tool?
4. Do we want a native Linux helper in-repo, or an integration contract for an external host agent?
5. Should new installs default to strict sandbox mode for all subprocess-backed tooling, even if that reduces convenience on weak hosts?

---

## Recommendation

Do not treat this as a narrow shell-validator bug.

The right fix is a layered hardening program:

1. reduce high-risk command classes immediately
2. give `shell_safe` a structured execution model
3. move normal coding workflows to dedicated tools
4. add strong-host descendant-exec enforcement for real guarantees
5. pair that with subprocess egress and secret brokering

Phase 1 and Phase 2 should happen first because they directly close the reproduced interpreter-trampoline escape without waiting on native platform work.
