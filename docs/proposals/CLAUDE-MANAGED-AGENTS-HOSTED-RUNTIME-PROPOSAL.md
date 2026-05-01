# Claude Managed Agents Hosted Runtime Proposal

**Status:** Draft
**Date:** 2026-04-09
**Primary runtime files:** [src/llm/types.ts](../../src/llm/types.ts), [src/llm/anthropic.ts](../../src/llm/anthropic.ts), [src/runtime/execution-profiles.ts](../../src/runtime/execution-profiles.ts), [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts), [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts), [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts), [src/runtime/continuity-threads.ts](../../src/runtime/continuity-threads.ts), [src/runtime/coding-backend-service.ts](../../src/runtime/coding-backend-service.ts), [src/tools/builtin/coding-tools.ts](../../src/tools/builtin/coding-tools.ts), [src/tools/executor.ts](../../src/tools/executor.ts)
**Primary control-plane files:** [src/runtime/control-plane/provider-dashboard-callbacks.ts](../../src/runtime/control-plane/provider-dashboard-callbacks.ts), [src/runtime/control-plane/setup-config-dashboard-callbacks.ts](../../src/runtime/control-plane/setup-config-dashboard-callbacks.ts), [src/channels/web-provider-admin-routes.ts](../../src/channels/web-provider-admin-routes.ts), [src/channels/web-code-session-routes.ts](../../src/channels/web-code-session-routes.ts)
**Related docs:** [docs/design/TOOLS-CONTROL-PLANE-DESIGN.md](../design/TOOLS-CONTROL-PLANE-DESIGN.md), [docs/architecture/FORWARD-ARCHITECTURE.md](../architecture/FORWARD-ARCHITECTURE.md), [docs/proposals/GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md](GENERAL-CHAT-CANONICAL-CODING-SESSIONS-PROPOSAL.md), [docs/proposals/REFERENCE-CODING-RUNTIME-UPLIFT-PROPOSAL.md](REFERENCE-CODING-RUNTIME-UPLIFT-PROPOSAL.md)
**Official sources:** [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview), [Managed Agents quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart), [Define outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes)

## Executive Summary

Guardian should not model Claude Managed Agents as "just another Anthropic chat provider."

Claude Managed Agents is a hosted agent runtime with:

- reusable `agent` definitions
- reusable `environment` container templates
- long-lived `session`s
- streamed `event`s
- Anthropic-owned tool execution inside managed infrastructure

That is fundamentally different from Guardian's current `LLMProvider` contract, which is a synchronous chat abstraction with optional tool calls.

The right fit for Guardian is a new hosted-runtime integration layer that can be used in three progressively broader ways:

1. explicit long-running hosted runs for research, security triage, and report generation
2. explicit code-session delegation using a synced workspace snapshot and patch-return flow
3. later, optional managed-cloud execution-profile selection for well-bounded tasks

The first implementation should be **hosted runtime**, not **new primary provider type**.

## Goal

Add Claude Managed Agents in a way that strengthens Guardian's existing architecture instead of bypassing it.

That means:

- keep the Intent Gateway as the entry point for user intent classification
- keep shared pending-action and continuity flow as the cross-surface blocker/resume system
- keep Guardian as the approval and governance control plane
- treat Anthropic's hosted runtime as a delegated execution substrate
- avoid duplicating orchestration logic inside one-off Anthropic-only paths

## Why This Is Not A Normal Provider

Guardian's current LLM provider interface in [src/llm/types.ts](../../src/llm/types.ts) is intentionally narrow:

- `chat(...)`
- `stream(...)`
- `listModels()`

The current Anthropic implementation in [src/llm/anthropic.ts](../../src/llm/anthropic.ts) correctly wraps Messages API behavior, prompt caching, and tool calls. That is still the right implementation for normal Anthropic model use.

Claude Managed Agents does not fit that contract well because the hosted runtime owns:

- the loop
- the tools
- the container
- the session timeline
- the persisted server-side state
- the interrupt/steer behavior

If we squeeze Managed Agents into `LLMProvider`, we lose clarity in exactly the place Guardian needs it most: ownership of execution state and approvals.

## Current Guardian Fit

Guardian already has the right extension points for a hosted runtime:

- `managed_cloud` routing tier and workload-shaped selection in [src/runtime/execution-profiles.ts](../../src/runtime/execution-profiles.ts)
- backend-owned code sessions in [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- shared approvals and continuation blocking in [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts)
- cross-surface continuity in [src/runtime/continuity-threads.ts](../../src/runtime/continuity-threads.ts)
- explicit external coding backend delegation in [src/runtime/coding-backend-service.ts](../../src/runtime/coding-backend-service.ts) and [src/tools/builtin/coding-tools.ts](../../src/tools/builtin/coding-tools.ts)

This proposal therefore recommends a new hosted-runtime service that plugs into those seams instead of changing the base conversation/provider model first.

## Recommendation

Implement a new internal abstraction:

- `HostedAgentRuntime`

Add an Anthropic implementation:

- `AnthropicManagedAgentsRuntime`

Use it in phases:

1. non-canonical, explicit hosted runs for research/security/report tasks
2. hosted coding backend for code sessions with patch-return and apply flow
3. optional execution-profile integration for managed-cloud delegation

Do **not**:

- replace `AnthropicProvider`
- bypass the Intent Gateway
- bypass `PendingActionStore`
- bypass `CodeSessionStore`
- treat Anthropic memory preview as Guardian's canonical memory store
- allow ungoverned write-capable hosted sessions to mutate the local workspace directly

## Scope Boundaries

### In scope

- Anthropic-managed hosted execution with explicit configuration
- streaming remote event progress into Guardian surfaces
- hosted-session tracking in code sessions and continuity state
- approval gating for remote hosted runs
- workspace snapshot upload and patch-return for coding tasks
- operator-visible environment/network/tool posture

### Out of scope for first release

- replacing Guardian's primary general chat provider routing with Managed Agents
- remote runtime as the default path for all Anthropic requests
- use of Anthropic preview `memory` as canonical persistence
- use of Anthropic preview `multiagent`
- direct bi-directional live filesystem mirroring between local repo and Anthropic container
- remote hidden execution without operator-visible session/run state

## Proposed Product Shape

### Product posture

Guardian remains the control plane.

Anthropic Managed Agents becomes an optional hosted execution engine that Guardian can:

- configure
- launch
- supervise
- interrupt
- summarize
- reconcile back into local shared state

### Initial user-facing capabilities

1. `Hosted research run`
   - long-running web and MCP-assisted research
   - output is report/artifact text, not local code edits

2. `Hosted security analysis run`
   - remote long-running triage / evidence gathering
   - output is summary, findings, or generated artifacts

3. `Hosted coding backend run`
   - explicit code-session delegation
   - remote session operates on uploaded workspace snapshot
   - Guardian retrieves patch/artifacts
   - Guardian applies changes locally only through its own controlled path

## Architecture

### New abstraction

Add a new runtime layer under `src/runtime/hosted-agents/`:

- `types.ts`
- `service.ts`
- `anthropic-managed-agents-client.ts`
- `workspace-sync.ts`
- `event-mapper.ts`
- `session-store.ts` or code-session/continuity integration helpers

Core interfaces:

```ts
export interface HostedAgentRuntime {
  readonly id: string;
  readonly providerType: 'anthropic_managed_agents';

  listProfiles(): HostedAgentProfile[];
  startRun(input: HostedAgentRunInput): Promise<HostedAgentRunHandle>;
  resumeRun(input: HostedAgentResumeInput): Promise<HostedAgentRunHandle>;
  interruptRun(input: HostedAgentInterruptInput): Promise<void>;
  fetchRunState(runId: string): Promise<HostedAgentRunState>;
}
```

```ts
export interface HostedAgentRunHandle {
  runId: string;
  remoteSessionId: string;
  remoteAgentId?: string;
  remoteEnvironmentId?: string;
  streamEvents(): AsyncIterable<HostedAgentEvent>;
}
```

The key design point is that this service is **not** a chat provider. It is a delegated execution runtime.

### Anthropic implementation

Add:

- `AnthropicManagedAgentsRuntime`

Responsibilities:

- create/reuse Anthropic agent definitions
- create/reuse Anthropic environment templates
- create sessions
- post user events
- attach SSE stream
- map Anthropic events into Guardian run/session events
- persist remote identifiers for resume and interrupt

### Why a direct REST adapter first

The current repo pins `@anthropic-ai/sdk` `^0.78.0` in [package.json](../../package.json), and the installed SDK surface currently exposes beta `models`, `messages`, `files`, and `skills`, but not managed-agent resources in [node_modules/@anthropic-ai/sdk/src/resources/beta/beta.ts](../../node_modules/@anthropic-ai/sdk/src/resources/beta/beta.ts).

That makes the least risky first implementation:

- a narrow REST client for `/v1/agents`, `/v1/environments`, `/v1/sessions`, `/v1/sessions/:id/events`, and `/v1/sessions/:id/stream`
- explicit handling of the required `managed-agents-2026-04-01` beta header

If Anthropic later exposes stable SDK resources, the REST client can be swapped behind the same `HostedAgentRuntime` interface.

## Configuration Design

### New config family

Add a new optional config section under `assistant.tools`:

```ts
assistant:
  tools:
    hostedAgents:
      enabled: true
      providers:
        - id: anthropic-managed
          type: anthropic_managed_agents
          llmProviderRef: anthropic_primary
          defaultProfile: repo-analysis
          profiles:
            - id: research
              mode: research
              networkPolicy: unrestricted
              toolset: full
              allowWriteBack: false
            - id: repo-analysis
              mode: repo_analysis
              networkPolicy: restricted
              toolset: full
              allowWriteBack: false
            - id: repo-patch
              mode: repo_patch
              networkPolicy: restricted
              toolset: full
              allowWriteBack: true
              requiresExplicitApply: true
```

### Why reference an existing `llm` provider profile

The hosted runtime should reuse an existing Anthropic provider profile rather than invent a separate secret store:

- credentials already exist in Guardian provider config/control plane
- provider validation UI already exists
- model/account ownership stays consistent
- operator posture is simpler

The hosted runtime config should therefore reference an existing configured `llm` entry whose `provider` is `anthropic`.

### Environment/profile model

Each hosted profile should define:

- Anthropic model
- agent system prompt extension
- environment template id or environment config
- networking mode
- allowed toolset
- MCP server configuration
- workspace sync mode
- output artifact expectations
- patch/apply policy
- budget / timeout controls

## Runtime Modes

### Mode 1: Research

Best first fit.

Characteristics:

- no local write-back
- remote web search/fetch and MCP usage allowed
- long-running session acceptable
- result is text/artifact only

Guardian fit:

- explicit `hosted_agent_run` tool or explicit managed-cloud execution-profile selection
- easy to show progress in timeline/chat
- low workspace reconciliation complexity

### Mode 2: Repo analysis

Remote session receives a bounded repo snapshot:

- selected files
- repo map
- optional git diff summary
- optional failing test output

Result:

- report
- findings
- patch suggestion
- recommended actions

No direct local mutation.

### Mode 3: Repo patch

Remote session receives a synced snapshot, performs changes remotely, and returns:

- unified diff or structured patch artifact
- optional generated files
- verification logs

Guardian then decides whether to:

- apply patch locally
- request operator approval first
- reject if patch scope exceeds policy

This mode is explicitly more powerful and should start as opt-in only.

## Workspace Sync Strategy

This is the main design constraint for coding use.

Claude Managed Agents runs in Anthropic-managed infrastructure, not on the local Guardian workspace. That means Guardian must not pretend it is the same execution surface as a local CLI backend.

### Phase 1 sync model

Use **workspace snapshot upload**, not live mirroring.

Snapshot contents should be bounded:

- selected working set files
- files explicitly named by the user
- nearby code files discovered through repo search
- optional generated repo map summaries
- optional git status/diff summaries

### Why not live mirroring

Live remote mirroring creates several problems:

- local/remote drift becomes hard to explain
- bidirectional mutation semantics become unclear
- operator trust and approval reasoning gets weaker
- partial failures are harder to reconcile

### Write-back model

For mutating hosted coding runs, the remote runtime returns a patch artifact instead of directly changing the local repo.

Guardian then:

1. validates patch size and scope
2. shows operator-visible summary
3. optionally requires approval
4. applies locally through Guardian's own file mutation path
5. records the change in `CodeSessionStore`

This keeps Guardian's local policy/approval system authoritative.

## Shared State Integration

### Code sessions

Extend [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts) to track hosted-run metadata.

Recommended additions:

- remote runtime profile id
- hosted run id
- remote session id
- remote status
- remote environment label
- artifact refs
- patch availability / apply status

This can be done either by:

- extending `CodeSessionRecentJob`
- or adding a new `hostedRuns` collection in `workState`

The second option is cleaner if hosted runs become first-class.

### Pending actions

Use [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts) for:

- approval to start hosted run
- approval to use write-capable hosted profile
- approval to apply returned patch
- clarification when target code session/workspace is ambiguous
- auth blocker when Anthropic profile is missing or invalid

This is important: hosted-run approvals should use the shared pending-action model, not a private Anthropic-specific approval flow.

### Continuity threads

Extend [src/runtime/continuity-threads.ts](../../src/runtime/continuity-threads.ts) execution refs to include hosted runs, for example:

- `hosted_agent_run`

That allows:

- resume after page refresh
- continue from web to CLI/Telegram
- interrupt from another linked surface

## Approval And Security Model

Anthropic's hosted container can run tools internally. Guardian therefore cannot rely on the same per-tool local enforcement posture it uses for its own `ToolExecutor`.

That means the approval model must be **coarser and explicit**.

### Required controls

Before run start, Guardian should evaluate:

- profile mode
- network policy
- whether write-back is allowed
- whether MCP servers are exposed
- workspace snapshot sensitivity
- whether the run targets a code session

### Approval tiers

Recommended posture:

1. read-only research profile
   - one approval per run or policy-based auto-approve if operator opted in

2. repo-analysis profile
   - explicit approval for snapshot upload if repo is not already trusted

3. repo-patch profile
   - explicit approval to start run
   - separate explicit approval to apply returned patch locally

### Non-negotiable guardrails

- Guardian must not advertise Anthropic-hosted built-in tools as if they were Guardian-local tool executions
- remote tool usage must be clearly labeled as hosted execution
- local filesystem trust decisions remain local to Guardian
- Anthropic preview `memory` is not canonical Guardian memory
- sensitive workspace upload must remain bounded and visible

## Event Mapping

Anthropic sessions stream events. Guardian should map them into its own timeline model.

Recommended event mapping:

- remote session created -> Guardian run created
- `agent.message` -> progress note / assistant status line
- `agent.tool_use` -> hosted substep event
- `session.status_idle` -> completed
- remote error/interrupt -> failed or interrupted status

This mapped event stream should feed:

- chat progress messages
- code-session timeline
- future dashboard run history

The mapping layer belongs in a hosted-runtime event adapter, not in channel code.

## Intent And Routing

### Initial posture

Do not add a new top-level intent route for the first implementation.

Initial integration should reuse existing routing shapes:

- `coding_task`
- `search_task`
- `security_task`
- `general_assistant` when explicitly invoking hosted research

### Explicit invocation

Two safe first integration paths:

1. explicit tool-backed invocation
   - `hosted_agent_run`
   - `hosted_agent_status`
   - `hosted_agent_interrupt`

2. explicit coding backend selection
   - treat Anthropic hosted runtime as a coding backend option for `coding_task`

### Future routing

If Guardian later supports natural-language explicit selection like "run this in Claude Managed Agents," then the change should go through [src/runtime/intent-gateway.ts](../../src/runtime/intent-gateway.ts) and the existing direct-routing machinery.

It should not be implemented as pre-gateway keyword interception.

## UI And Operator Surfaces

### Config Center

Add a new integration section for hosted agents:

- enabled/disabled
- Anthropic profile reference
- hosted profiles
- environment/network posture
- default budget / timeout
- last connectivity check

### Chat and Code page

Show:

- hosted profile label
- remote session id
- remote status
- environment label
- whether write-back is pending
- apply-patch action when available

### Response source labeling

Guardian already exposes response-source metadata. Hosted runs should surface as managed-cloud Anthropic hosted execution rather than plain Anthropic chat.

## Use Of Anthropic Preview Features

### Outcomes

Good future fit.

Not phase 1, but promising for:

- verifying a generated report against rubric
- verifying a returned patch against test/build/diff criteria
- structured completion for long-running coding tasks

### Memory

Do not use as Guardian's source of truth.

Possible future use:

- hosted-session scratch memory within Anthropic runtime
- never canonical long-term operator memory

### Multiagent

Not phase 1.

Potential future use:

- internal hosted decomposition for long-running report generation

But Guardian should not depend on Anthropic multiagent semantics for its own shared orchestration model.

## Implementation Plan

### Phase 0: Foundation

- add config types for hosted runtime provider/profile declarations
- add `HostedAgentRuntime` interface
- add Anthropic REST client with beta header support
- add unit tests around config validation and API payload shaping

### Phase 1: Research and security runs

- add hosted run service
- add explicit hosted-run tools
- add event streaming and timeline mapping
- persist run metadata in continuity state
- add approval gating

Success criteria:

- operator can launch, watch, interrupt, and resume a hosted report/research run
- no local repo mutation path exists yet

### Phase 2: Code-session hosted analysis

- add workspace snapshot packer
- add code-session binding
- add hosted analysis profile
- persist remote run refs in code sessions

Success criteria:

- operator can run repo analysis against remote hosted container
- results attach cleanly to the current code session

### Phase 3: Patch-return coding backend

- add patch artifact contract
- add local patch application path
- add separate apply approval
- integrate hosted runtime as a coding backend option

Success criteria:

- operator can explicitly delegate a coding task to a hosted profile
- remote patch is returned and applied locally only through Guardian-controlled flow

### Phase 4: Execution-profile integration

- allow selected managed-cloud profiles to route certain bounded tasks to hosted runtime
- keep this opt-in and role-bound

## Proposed Files And Modules

### New files

- `src/runtime/hosted-agents/types.ts`
- `src/runtime/hosted-agents/service.ts`
- `src/runtime/hosted-agents/anthropic-managed-agents-client.ts`
- `src/runtime/hosted-agents/workspace-sync.ts`
- `src/runtime/hosted-agents/event-mapper.ts`
- `src/runtime/hosted-agents/service.test.ts`
- `src/runtime/hosted-agents/workspace-sync.test.ts`

### Existing files likely to change

- [src/config/types.ts](../../src/config/types.ts)
- [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts)
- [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts)
- [src/runtime/continuity-threads.ts](../../src/runtime/continuity-threads.ts)
- [src/runtime/coding-backend-service.ts](../../src/runtime/coding-backend-service.ts)
- [src/tools/builtin/coding-tools.ts](../../src/tools/builtin/coding-tools.ts)
- [src/tools/executor.ts](../../src/tools/executor.ts)
- [src/runtime/control-plane/provider-dashboard-callbacks.ts](../../src/runtime/control-plane/provider-dashboard-callbacks.ts)
- [src/runtime/control-plane/setup-config-dashboard-callbacks.ts](../../src/runtime/control-plane/setup-config-dashboard-callbacks.ts)

## Testing Strategy

### Unit tests

- config validation
- Anthropic request/response mapping
- event mapping
- workspace snapshot selection
- patch artifact validation
- pending-action generation

### Integration tests

- fake Anthropic SSE stream server
- resume/interrupt flow
- code-session binding
- apply-patch approval flow

### Real-provider tests

Optional and off by default:

- guarded by explicit environment variables
- low-budget smoke only
- validate session creation, event stream attach, and graceful completion

## Risks

### Hosted runtime governance gap

Risk:

- Anthropic-hosted tool execution does not pass through Guardian's per-tool local enforcement model

Mitigation:

- coarse run-level approvals
- restrictive environment profiles
- explicit hosted-run labeling
- no silent local mutation

### Data handling and upload scope

Risk:

- sensitive local repo content could be uploaded to Anthropic

Mitigation:

- bounded snapshot selection
- trusted-workspace checks
- explicit approval for snapshot upload in stronger profiles
- clear operator preview of upload scope

### API churn

Risk:

- Managed Agents is beta and research-preview features may change

Mitigation:

- narrow adapter boundary
- direct REST client with isolated payload types
- avoid adopting preview `memory` and `multiagent` early

### Cost and rate limits

Risk:

- long-running hosted sessions can become materially more expensive than standard chat

Mitigation:

- per-profile timeout/budget caps
- explicit managed-cloud posture in UI
- conservative defaults

## Decision

Guardian should adopt Claude Managed Agents as a **hosted runtime integration**, not as a normal `LLMProvider`.

The correct first implementation is:

- explicit hosted runs
- shared pending-action and continuity integration
- code-session binding only after workspace snapshot and patch-return flow are in place

This respects Guardian's architecture, preserves its approval/control-plane posture, and creates a reusable path for other hosted agent runtimes later if the product wants them.
