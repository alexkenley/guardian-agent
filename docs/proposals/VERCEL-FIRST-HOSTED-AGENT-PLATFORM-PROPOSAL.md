# Proposal: Vercel-First Hosted Agent Platform

**Status:** Draft
**Date:** 2026-03-31
**Related:**
- [GuardianAgent Multi-Tenant SaaS Platform - Detailed Design](MULTI-TENANT-SAAS-AGENT-PLATFORM-DETAILED-DESIGN.md)
- [Private-By-Default Cloud Deployment Model for GuardianAgent](PRIVATE-CLOUD-DEPLOYMENT-PROPOSAL.md)
- [Multi-User Server + Client Agent Proposal](MULTI-USER-CLIENT-AGENT-PROPOSAL.md)
- [Identity & Memory Spec](../design/IDENTITY-MEMORY-DESIGN.md)
- [Web Auth Configuration Spec](../design/WEB-AUTH-CONFIG-DESIGN.md)

## Executive Summary

GuardianAgent should adopt **Vercel as the primary hosted SaaS control plane and web runtime** for a web-first product, but it should **not** treat Vercel as the only execution substrate for every Guardian capability.

The recommended shape is:

- Vercel for the public web app, API/BFF, preview deployments, and hosted SaaS control plane
- Vercel Workflow and Queues for durable orchestration, scheduling, wake-on-event execution, and background jobs
- Vercel AI Gateway for the managed model gateway layer
- Vercel Marketplace plus `vercel install` for fast provisioning of databases, Redis, storage, auth, and other platform services
- optional Vercel Chat SDK where it reduces channel-specific bot glue
- an external isolated execution plane for higher-risk or host-dependent work such as browser jobs, coding jobs, long-running workers, local-model pools, and later client-agent execution

This is a simpler path than building the first hosted Guardian release around a full AWS cell stack from day one.

It is **not** a drop-in hosting answer for the current runtime as-is. Guardian today still depends on:

- PTY-backed web terminals and local shell semantics
- Telegram polling in process
- SQLite-backed orchestration and resumability state
- assumptions about local-model and same-host execution

Those capabilities need redesign, externalization, or explicit deferral for a Vercel-first hosted product.

## Why Revisit This Now

The Vercel platform is materially more relevant to agent hosting in March 2026 than it was when many "serverless is not for agents" judgments were formed.

Relevant changes:

- Marketplace integrations can now be installed directly from the CLI with `vercel install`
- Workflow provides durable multi-step orchestration with pause/resume behavior
- Queues provides a lower-level durable background primitive
- AI Gateway provides a managed model-routing layer with provider failover, observability, and BYOK support
- AI SDK 5 and AI SDK 6 provide stronger agent, tool, approval, and MCP primitives
- Chat SDK is now positioned as a unified bot/channel layer and has added Telegram and PostgreSQL state support
- Vercel Sandbox provides a bounded isolated compute surface for untrusted or heavy jobs

The result is that Vercel can now replace a meaningful portion of the previously custom control-plane work.

## Current Guardian Reality

Guardian's current codebase still has several runtime assumptions that matter for this decision:

- The web channel opens real PTY-backed terminals through `node-pty` and streams terminal output over SSE. See [src/channels/web.ts](../../src/channels/web.ts).
- Telegram currently starts in polling mode inside the main process. See [src/channels/telegram.ts](../../src/channels/telegram.ts).
- pending actions and approval resume state currently use a SQLite-backed store with in-memory fallback. See [src/runtime/pending-actions.ts](../../src/runtime/pending-actions.ts).
- the broader SaaS design already assumes event-driven workers, isolated execution, and durable state rather than one permanently hot process per tenant. See [MULTI-TENANT-SAAS-AGENT-PLATFORM-DETAILED-DESIGN.md](./MULTI-TENANT-SAAS-AGENT-PLATFORM-DETAILED-DESIGN.md).

This leads to an important conclusion:

- Vercel is a strong fit for the **hosted web-first SaaS control plane**
- Vercel is not a full substitute for the **entire current Guardian runtime shape**

## Decision

Guardian should adopt a **Vercel-first hybrid architecture** for hosted SaaS.

That means:

- Vercel is the default platform for the public app, API, orchestration, previews, and model gateway
- higher-risk or host-shaped execution remains outside the request-serving runtime
- the hosted SaaS product should intentionally narrow scope in v1 rather than force PTY, browser-pool, and local-model assumptions into the Vercel runtime

This keeps the product simple where Vercel is strong and avoids forcing Vercel to be something it is not.

## Proposed Architecture

```text
Internet
  |
  v
Vercel Edge / CDN / WAF
  |
  v
Hosted Web App + API / BFF
  |
  +--> Auth integration
  +--> Billing / Entitlements
  +--> Workspace / Agent metadata
  +--> Approval and audit APIs
  +--> Vercel Workflow
  +--> Vercel Queues
  +--> Vercel AI Gateway
  +--> Marketplace-provisioned data services
  |       +--> PostgreSQL
  |       +--> Redis / cache
  |       +--> Blob / artifacts
  |       +--> optional auth / realtime providers
  |
  +--> Execution Router
          |
          +--> Vercel Sandbox for bounded isolated jobs
          +--> External browser worker service
          +--> External coding worker service
          +--> Later: managed client agent / remote exec connector
          +--> Later: dedicated enterprise execution cells
```

## What Vercel Can Replace

### 1. Public web app and control plane

Vercel is a strong fit for:

- signup and login surfaces
- app shell and dashboard delivery
- API/BFF routes
- preview deployments for rapid iteration
- product settings, billing UI, and workspace management
- hosted callback endpoints for OAuth and channel webhooks

This is the cleanest place to remove the most operational weight early.

### 2. Durable orchestration

Workflow and Queues can absorb much of the first-wave orchestration surface:

- message-triggered agent runs
- scheduled wakeups
- approval wait states
- connector callback handling
- retries and fan-out
- background summarization, indexing, and notification jobs

This maps well to the existing SaaS design goal that agents be logically always-on but physically event-driven.

### 3. Managed model gateway

AI Gateway can replace much of the custom hosted model-gateway work for:

- provider abstraction
- centralized credentials
- observability
- routing and failover
- tenant metering hooks
- bring-your-own-key support

This is one of the clearest simplifications relative to building and operating a full custom model gateway immediately.

### 4. Fast platform provisioning

Marketplace plus `vercel install` reduces setup tax for common dependencies such as:

- PostgreSQL / serverless Postgres
- Redis / cache
- blob storage
- auth providers
- realtime providers
- AI providers and related integrations

This is valuable not only for humans but also for future Guardian-managed bootstrap and provisioning flows.

### 5. Bot and channel abstractions

Where the product benefits from shared bot plumbing, Vercel's SDK layer can reduce bespoke channel code for:

- message normalization
- state adapters
- deployment shape across channel surfaces

Guardian does not need to force this abstraction everywhere, but it is now credible enough to use selectively.

## What Should Stay Outside Vercel

### 1. Host-shaped shell and PTY execution

The hosted SaaS product should not try to keep the current PTY-backed terminal model inside the Vercel request runtime.

For hosted SaaS, the better options are:

- defer raw shell access from v1
- move advanced execution behind a client agent
- use a dedicated coding worker service
- use Vercel Sandbox only for bounded, explicitly supported execution paths

This is consistent with the existing multi-tenant design, which already recommends against exposing arbitrary shell access on platform hosts in the first phase.

### 2. Long-running browser and coding workers

Browser isolation and coding execution still deserve their own boundary:

- browser jobs are high-risk and need separate quotas, policy, and storage handling
- coding jobs need strong process isolation and often have longer runtime, artifact, and package-install requirements
- enterprise customers may eventually need regional or dedicated execution planes

Vercel Sandbox may be useful for some bounded jobs, but it should not be treated as proof that a general browser-worker or coding-worker platform no longer needs its own architecture.

### 3. Local-model pools

The current and proposed Guardian architecture still leaves room for:

- local Ollama pools
- private GPU inference hosts
- managed endpoint inference

Vercel can simplify frontier-provider routing and web product delivery, but it does not eliminate the need for a separate strategy when Guardian wants to own or colocate model compute.

### 4. Strict regional or enterprise isolation

The detailed SaaS design assumes:

- home-cell assignment by region
- workload pinning
- premium dedicated cells later

That remains a better fit for an external execution plane than for a pure Vercel-only model.

## Platform Constraints To Design Around

The Vercel-first recommendation depends on acknowledging several real platform constraints up front.

### 1. Workflow and Queues are promising, but still not the final enterprise execution story

Guardian should use them for hosted orchestration only behind Guardian-owned abstractions.

That keeps room for:

- future dedicated execution cells
- alternative queue backends if requirements outgrow current platform limits
- enterprise isolation or residency requirements that need a separate execution plane

### 2. Queue retention and background primitives are not a substitute for every durable workload

Queues are a good fit for event-driven agent wakeups, retries, and fan-out.

They should not be treated as the only long-horizon durability layer for:

- enterprise audit retention
- large artifact or transcript storage
- indefinitely deferred work without a Guardian-owned state model

### 3. Sandbox is useful, but should stay bounded

Sandbox improves the Vercel story substantially, but it should be used selectively for:

- short-lived isolated tool runs
- controlled coding or browser tasks with clear resource limits
- bounded untrusted execution

It should not become the only answer for:

- region-pinned execution
- the full browser-worker fleet
- the full coding-worker fleet
- local-model hosting

### 4. Realtime still needs an explicit provider choice

Guardian's hosted SaaS UI will still need a deliberate approach for:

- realtime run updates
- collaborative or shared session updates later
- channel and notification fan-out

Vercel is a good place to host the app, but Guardian should treat realtime as its own platform decision rather than assuming the request runtime should subscribe to everything directly.

### 5. Hosted auth still needs an explicit identity decision

Guardian still needs a deliberate end-user identity layer for:

- signup and login
- team membership
- workspace membership
- enterprise federation later

Vercel improves delivery and integration ergonomics here, but it does not remove the need to choose and integrate the actual hosted identity system.

## Mapping From The Existing SaaS Design

| Existing SaaS concept | Vercel-first mapping | Notes |
| --- | --- | --- |
| Shared control plane | Vercel web app + API/BFF | Strong fit |
| Hosted auth/session plane | External auth provider integrated into Vercel-hosted app | Vercel hosts it well but does not replace general SaaS identity by itself |
| Tenant directory and workspace metadata | PostgreSQL via Marketplace integration | Strong fit |
| Queue-driven orchestration | Vercel Workflow + Queues | Good fit for event-driven runs |
| Approval service | API + durable workflow state | Good fit if approvals stay in shared orchestration contracts |
| Audit and artifacts | Blob/object storage + Postgres metadata | Strong fit |
| Model gateway | Vercel AI Gateway | Strong fit |
| Browser workers | External worker service or tightly scoped Sandbox usage | Keep separate |
| Coding workers | External worker service or later client-agent boundary | Keep separate |
| Local model pools | External GPU/runtime plane | Not a Vercel-native replacement |
| Regional execution cells | External execution plane | Preserve for enterprise and data-bound workloads |

## Product Shape Recommended For A Vercel-First V1

The hosted product should focus on:

- web UI first
- hosted auth and browser sessions
- workspace and agent management
- approvals and audit
- schedules and automations
- server-side SaaS OAuth connectors
- model routing through AI Gateway
- notifications and chat surfaces that can run through webhook-first or adapter-first flows

The hosted product should avoid, defer, or externalize:

- raw shell access to platform hosts
- persistent PTY terminals as a core SaaS primitive
- long-running browser pools in the primary request runtime
- local workstation access without a client-agent boundary
- same-host local-model assumptions

This product shape is not a compromise. It is a cleaner first hosted product.

## Recommended Implementation Phases

### Phase 1 - Vercel control plane and web shell

- stand up the hosted web app and API on Vercel
- introduce hosted auth and cookie sessions
- create workspace and agent metadata in PostgreSQL
- preserve shared orchestration contracts rather than creating channel-specific resume logic

### Phase 2 - Shared state migration

- move pending actions, approvals, session metadata, and other durable shared state out of SQLite-only assumptions
- keep the shared orchestration model centered on the Intent Gateway contract, shared response metadata, and shared channel rendering

### Phase 3 - Orchestration on Workflow and Queues

- move automations, delayed work, approval waits, and wake-on-event execution onto Workflow and Queues
- preserve explicit audit, approval correlation, and resume semantics

### Phase 4 - AI Gateway adoption

- route managed frontier-provider traffic through AI Gateway
- keep an abstraction boundary so Guardian can still support external or private model lanes later

### Phase 5 - Channel and connector reshape

- convert Telegram and other chat surfaces to a hosted-friendly shape
- prefer webhook-first flows where available
- use shared channel abstractions or Chat SDK selectively where it reduces bespoke glue

### Phase 6 - External execution plane

- introduce a dedicated execution router for browser jobs, coding jobs, and other higher-risk work
- use Vercel Sandbox for bounded jobs where it is a good fit
- keep room for a later client-agent and dedicated enterprise cell story

## Benefits

- materially lower day-one operational complexity than building ECS, SQS, Redis, Aurora, and service wiring up front
- faster product iteration through previews, deploy ergonomics, and hosted web infrastructure
- a cleaner managed model-gateway path
- simpler developer and internal-agent provisioning through `vercel install`
- clearer separation between user-facing SaaS surfaces and high-risk execution surfaces

## Risks And Mitigations

### Risk: over-trusting Vercel as a universal runtime

Mitigation:

- keep the architecture explicitly hybrid
- maintain a separate execution router and external worker path

### Risk: Workflow and Queues maturity or platform limits

Mitigation:

- keep orchestration behind Guardian-owned contracts and interfaces
- avoid hard-coding business logic directly to one vendor primitive without an adapter boundary

### Risk: auth and realtime still need outside help

Mitigation:

- treat auth and realtime as explicit platform choices, not accidental gaps
- choose provider integrations that fit the hosted SaaS requirements instead of expecting Vercel itself to become the identity product

### Risk: premature deletion of the cell model

Mitigation:

- keep the regional cell concept for the external execution plane and enterprise tiers
- use Vercel-first for the public control plane and shared web experience first

### Risk: forcing current PTY and polling behavior into hosted SaaS

Mitigation:

- redesign those surfaces intentionally
- prefer client-agent, webhook, or dedicated-worker boundaries over request-runtime hacks

## Recommendation

Guardian should adopt a **Vercel-first hybrid hosted architecture** for the SaaS product.

Specifically:

- use Vercel as the default hosted control plane and web runtime
- use Workflow, Queues, AI Gateway, and Marketplace integrations to remove a large amount of custom platform work
- keep browser, coding, local-model, and enterprise-isolation execution in a separate plane
- narrow the first hosted product to a web-first, event-driven, approval-heavy agent experience rather than trying to preserve every local-runtime behavior in SaaS

This is the simpler option for shipping a hosted agent product sooner.

It is not a reason to delete the external worker, client-agent, or regional-cell ideas. Those remain important for advanced execution, enterprise isolation, and the broader Guardian roadmap.

## References

- Vercel CLI install: <https://vercel.com/docs/cli/install>
- Vercel Workflow: <https://vercel.com/docs/workflow>
- Vercel Queues: <https://vercel.com/docs/queues>
- Vercel Queues pricing and limits: <https://vercel.com/docs/queues/pricing>
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway>
- Vercel AI Gateway BYOK: <https://vercel.com/docs/ai-gateway/authentication-and-byok>
- Vercel Sandbox pricing: <https://vercel.com/docs/vercel-sandbox/pricing>
- Vercel Sandbox examples: <https://vercel.com/docs/vercel-sandbox/examples>
- AI SDK 5: <https://vercel.com/blog/ai-sdk-5>
- AI SDK 6: <https://vercel.com/blog/ai-sdk-6>
- Chat SDK: <https://vercel.com/changelog/chat-sdk>
- Chat SDK Telegram adapter: <https://vercel.com/changelog/chat-sdk-adds-telegram-adapter-support>
- Chat SDK PostgreSQL adapter: <https://vercel.com/changelog/chat-sdk-adds-postgresql-state-adapter>
- Realtime guidance on Vercel: <https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel>
