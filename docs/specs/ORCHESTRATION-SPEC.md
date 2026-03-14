# Orchestration Specification

**Status:** Implemented

This document replaces the older split between "assistant orchestrator" and "orchestration agents". Guardian has three different orchestration layers, and they solve different problems.

## 1. Request Orchestration

**Files:** `src/runtime/orchestrator.ts`, `src/runtime/assistant-jobs.ts`

This is the assistant/session control plane.

- Serializes requests per session: `<channel>:<canonicalUserId>:<agentId>`
- Allows different sessions to run in parallel
- Tracks queue depth, latency, recent traces, and background jobs
- Is used by normal chat dispatch, quick actions, and scheduled assistant turns

It does **not** decide multi-agent workflow structure. It only controls when work is admitted and how it is observed.

## 2. Scheduled Orchestration

**Files:** `src/runtime/scheduled-tasks.ts`, `src/runtime/connectors.ts`

This is the recurring automation layer.

- `type: "tool"` runs one tool on cron
- `type: "playbook"` runs a deterministic workflow on cron
- `type: "agent"` runs a scheduled assistant turn on cron
- `runOnce: true` turns any scheduled task into a one-shot job that disables itself after the first execution

Important distinction:

- Playbook `instruction` steps are text-only LLM synthesis inside a deterministic workflow
- Agent tasks dispatch a real assistant turn, so they can use skills, memory, tools, and the normal Guardian/runtime path

This is the right layer for:

- morning briefings
- recurring posture checks
- scheduled monitoring summaries
- personal-assistant reminders that must inspect multiple systems before replying
- one-time scheduled actions such as "send this email tonight once"

Approval model:

- the user approves the automation definition when it is created or updated
- later scheduled executions of that saved task do not stop to ask for the same approval again

## 3. Agent Composition

**Files:** `src/agent/orchestration.ts`, `src/agent/conditional.ts`

This is structured multi-agent composition inside one invocation.

- `SequentialAgent`
- `ParallelAgent`
- `LoopAgent`
- `ConditionalAgent`

Every sub-agent call still goes through `ctx.dispatch()` and then `Runtime.dispatchMessage()`, so Guardian admission and output controls remain intact.

## Runtime Model

```text
Scheduled trigger / user message
  -> Request orchestration
  -> Runtime dispatch
  -> Optional agent composition
  -> Tools / providers / sub-agents
```

For scheduled assistant automations, Guardian now follows the OpenClaw-style pattern more closely:

- cron wakes a real assistant turn
- the turn uses the same skill/tool stack as interactive chat
- the result can be delivered back through supported channels

## Guidance

- Use **playbooks** when the steps should be explicit and repeatable
- Use **agent tasks** when the assistant should decide what to inspect at runtime and produce a report
- Use **orchestration agents** when developers need reusable multi-agent control flow inside one request
