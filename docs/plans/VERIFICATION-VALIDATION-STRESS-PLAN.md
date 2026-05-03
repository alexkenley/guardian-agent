# GuardianAgent Verification and Validation Stress Plan

## Purpose

This plan defines the verification and validation strategy for stressing GuardianAgent across skills, Intent Gateway routing, tool discovery, tool execution, approvals, orchestration, web/CLI surfaces, provider integrations, and security controls.

The goal is to find real product weaknesses without adding tactical routing shortcuts, prompt-only fixes, or per-tool exceptions that bypass the documented architecture. Failures should be isolated to the owning layer before implementation:

- intent and route selection: Intent Gateway and direct-routing contracts
- tool visibility: deferred tool loading and control-plane discovery
- approvals and blocked work: shared pending-action and channel metadata flow
- execution: ToolExecutor, Guardian policy, sandboxing, and provider/tool adapters
- skill behavior: advisory context selection and bounded prompt injection only
- rendering: shared response metadata and channel-specific presentation

## Guiding Principles

1. Every natural-language test that depends on classification must inspect the routing trace by request ID before assigning blame.
2. Deterministic tool contract tests and LLM discovery tests must be separate lanes.
3. Harness state must be disposable unless the test explicitly validates cross-turn continuity.
4. Skills must remain advisory context, not a shadow router or approval bypass.
5. Approval, continuation, and resume behavior should be tested through shared pending-action state rather than bespoke channel logic.
6. A failure that spans multiple channels or tools should trigger an architecture pause before adding adapters, prompt rules, or special cases.

## Test Lanes

### Lane 1: Static and Unit Verification

Purpose: catch contract drift before running the app.

Run:

```powershell
npm run check
npx vitest run src/skills/resolver.test.ts src/skills/prompt.test.ts src/runtime/skills-query.test.ts
npx vitest run src/runtime/intent-gateway.test.ts src/runtime/direct-intent-routing.test.ts
npx vitest run src/runtime/context-assembly.test.ts
```

Validate:

- strict TypeScript compatibility
- Intent Gateway schema and normalization behavior
- direct-routing candidate selection
- skill resolver scoring, gating, and maximum active-skill bounds
- prompt/context assembly ordering and diagnostics

Exit criteria:

- all focused tests pass
- no new route or skill behavior bypasses the Gateway
- tests cover every touched route, skill, or context-assembly change

### Lane 2: Deterministic Tool Contract Stress

Purpose: validate tool registry, schemas, policies, argument normalization, execution results, and job history without depending on LLM tool-discovery behavior.

Run through direct tool APIs or tightly controlled harness calls.

Validate:

- filesystem: list, search, read, write, copy, move, delete, denied critical paths
- shell: allowed command execution, denied command execution, timeout handling
- system: resource/process/system info
- network: interfaces, DNS, loopback ping, port check
- web: local health fetch and blocked risky fetches
- memory/search: save, recall, search, trust and redaction behavior
- automations: list/create/update/delete, approval boundaries, schedule bounds
- cloud/workspace tools: status, schema, dry-run/listing paths before mutation
- job history: status, tool name, approval state, principal, and surface metadata

Required isolation:

- unique harness run ID
- unique user ID and surface ID per test case unless continuity is under test
- scratch workspace outside production data
- fresh pending-action and approval scope
- no mutation of production config unless using the production-like lane intentionally

Exit criteria:

- tool calls match expected tool families
- argument paths are normalized correctly on Windows and Unix
- mutating tools obey policy and approval mode
- denied operations fail closed and leave durable trace/audit evidence

### Lane 3: Intent Gateway and Tool Discovery Stress

Purpose: verify that realistic user prompts route correctly through the Gateway and deferred tool discovery.

For each case, assert:

- `requestId`
- Gateway route
- confidence and normalized route
- direct candidate decision
- `find_tools` usage when relevant
- selected tool family
- pending action created or not created
- final response status and metadata

Prompt families:

- direct filesystem requests
- ambiguous file/search requests
- network diagnostics
- automation authoring
- calendar/email requests across Google and Microsoft 365
- code-session inspection and modification requests
- multi-domain orchestration requests
- security/adversarial requests
- continuation, approval, denial, and retry requests

Exit criteria:

- no regex or pre-Gateway keyword interception is introduced
- wrong-route cases have trace-backed root cause
- discovery failures identify whether the issue is classification, candidate dispatch, tool loading, tool execution, or synthesis

### Lane 4: Skills Validation

Purpose: stress skills as bounded advisory context.

Validate:

- skill inventory queries are answered accurately
- clear explicit skill mentions activate the named skill
- domain signals activate relevant domain skills
- process skills do not crowd out clear tool/domain skills
- provider gates prevent irrelevant Google/Microsoft/GitHub skill activation
- `SKILL.md` material is bounded
- references/templates/artifacts are only loaded when relevant
- active skills propagate into delegated workers without bypassing policies

Trace/metadata to inspect:

- active skill IDs
- instruction/resource skill IDs
- loaded resource paths
- prompt-material cache hits
- context-assembly diagnostics
- `skill_read`, `skill_resolved`, and `skill_prompt_injected` telemetry

Exit criteria:

- skills improve execution context without changing routing ownership
- maximum active-skill limits remain conservative
- no skill causes approval, sandbox, or tool-control bypass

### Lane 5: Approval, Pending Action, and Continuity Stress

Purpose: verify blocked work resumes consistently across channels.

Scenarios:

- approve single pending tool call
- deny single pending tool call
- chained approvals
- stale approval ID refresh
- approval in web after originating in CLI
- approval in CLI after originating in web
- mutating action after clarification
- continuation after provider/tool failure
- cross-turn resume after app restart

Exit criteria:

- pending action state is shared and canonical
- channel renderers show the same blocked/completed status
- approval propagation appears in routing trace and job history
- denied actions do not execute later through continuation

### Lane 6: Orchestration and Delegation Stress

Purpose: validate multi-step and multi-domain execution graphs.

Run:

```powershell
node scripts/test-cross-domain-orchestration-stress.mjs
node scripts/test-coding-assistant.mjs
node scripts/test-brokered-approvals.mjs
```

Validate:

- graph creation and completion
- brokered worker startup/completion/failure reporting
- evidence hydration
- result truncation behavior
- approval propagation into delegated work
- worker visibility of relevant code sessions and workspace context
- final synthesis coverage

Exit criteria:

- no orphaned workers
- no hidden approval deadlocks
- no object truncation that loses paths, line numbers, or approval IDs
- failed delegated work is surfaced with actionable metadata

### Lane 7: Web UI and Channel Rendering Stress

Purpose: validate the operator-facing app.

Run:

```powershell
node scripts/test-code-ui-smoke.mjs
node scripts/test-web-approvals.mjs
node scripts/test-web-gmail-approvals.mjs
```

Validate:

- chat stream lifecycle
- input lock/unlock
- timeline rendering
- pending approval controls
- continuation prompts
- code-session focus
- second-brain surface context
- console errors and rejected browser promises

Exit criteria:

- no user-visible deadlocks
- no stale timeline state
- no hidden pending actions after completion
- UI smoke tests pass with clean enough console output to distinguish real failures

### Lane 8: Provider and Integration Validation

Purpose: verify authenticated service surfaces without leaking credentials or requiring mutation.

Status-only validation:

```powershell
.\scripts\test-gws.ps1 -SkipStart -Port 3000 -StatusOnly
$env:HARNESS_HOST='localhost'; $env:HARNESS_PORT='3000'; $env:SKIP_START='1'; $env:HARNESS_STATUS_ONLY='1'; node scripts/test-m365.mjs
```

Validate:

- Google Workspace auth status, token freshness, service registration, schemas
- Microsoft 365 auth status, token freshness, service registration, schemas
- disabled/unauthenticated provider behavior
- approval gating for send/mutate operations
- provider-specific skill gating

Exit criteria:

- status-only checks pass before mutation tests
- unauthenticated providers fail with clear operator guidance
- no token, secret, or credential value appears in harness output or docs

### Lane 9: Security and Abuse Stress

Purpose: verify guardrails under adversarial and destructive prompts.

Run:

```powershell
node scripts/test-contextual-security-uplifts.mjs
node scripts/test-security-verification.mjs
npm run test:llmmap
```

Validate:

- prompt injection suppression
- secret and PII redaction
- denied critical paths
- destructive operation approvals
- SSRF/path traversal protections
- sandbox visibility and command restrictions
- low-trust content quarantining
- bounded automation authority

Exit criteria:

- high-risk actions fail closed
- user approval does not override critical system path blocks
- audit and routing trace records are sufficient for investigation

## Phase Plan

### Phase 1: Harness Isolation and Diagnostics

Deliverables:

- update broad tool harness to use unique run IDs, user IDs, surface IDs, and request IDs
- default scratch paths to OS-native temp locations
- keep a deliberate `/tmp` path stress mode for Windows path-normalization regressions
- print request IDs for trace correlation
- document the deterministic-vs-LLM lane split

Success criteria:

- repeated broad-harness runs do not inherit stale continuity by default
- failures can be mapped to trace rows by request ID
- managed-start harness config no longer mutates or corrupts production config

### Phase 2: Deterministic Tool Contract Lane

Deliverables:

- direct tool-contract harness for filesystem, shell, network, web, memory, automation, and status tools
- focused assertions for tool schemas, argument normalization, policy modes, approval creation, and job history
- regression for Windows `/tmp` path normalization

Success criteria:

- deterministic lane can run without real LLM variability
- direct tool failures are separated from Gateway/discovery failures

### Phase 3: Gateway Discovery Lane

Deliverables:

- natural-language prompt matrix with per-case trace assertions
- isolated surface/user per prompt
- report that classifies failures by Gateway, discovery, execution, approval, or synthesis

Success criteria:

- broad discovery failures have trace-backed root causes
- no product fix is accepted without a reproducible case and owning-layer diagnosis

### Phase 4: Skills Tuning

Deliverables:

- skill-selection regression matrix
- over-selection thresholds for process skills
- provider and capability gate checks
- context-assembly budget assertions

Success criteria:

- skills remain useful and bounded
- no skill becomes a routing or approval workaround

### Phase 5: Production-Like Validation

Deliverables:

- running-app API ladder with real provider metadata checks
- authenticated Google/Microsoft status checks
- selected safe mutation checks after status passes
- web preview smoke for key surfaces

Success criteria:

- real operator path works after deterministic lanes pass
- failures are reproducible with request IDs and trace slices

## Reporting Template

Every stress run should report:

- date/time and git SHA
- app start mode: isolated, running app, or production-like
- provider lane: fake, local, managed cloud, or status-only integration
- harness run ID
- failing request IDs
- commands run
- pass/fail/skip summary
- trace-backed root cause per failure
- product bug, harness bug, flaky provider, or expected limitation classification
- files changed and verification after change

## Immediate Known Risks To Track

- broad `test-tools.ps1` previously mixed persistent user state, LLM discovery, production config, and approval flow in one lane
- Windows direct-reasoning path handling mis-normalized `/tmp/...` into a repo-relative path
- policy setup in the broad tool harness did not reliably prevent approval pauses for scratch writes
- network and automation discovery timed out under stale long-lived harness state
- skill over-selection can activate low-value process skills alongside a clear domain skill
- web smoke can pass while still logging Monaco/browser cancellation noise
