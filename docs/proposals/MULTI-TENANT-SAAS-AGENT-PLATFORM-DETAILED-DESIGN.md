# GuardianAgent Multi-Tenant SaaS Platform - Detailed Design

**Status:** Draft
**Date:** 2026-03-28
**Related:**
- [Private-By-Default Cloud Deployment Model for GuardianAgent](PRIVATE-CLOUD-DEPLOYMENT-PROPOSAL.md)
- [Vercel-First Hosted Agent Platform](VERCEL-FIRST-HOSTED-AGENT-PLATFORM-PROPOSAL.md)
- [SaaS Pricing and Unit Economics Plan](../plans/SAAS-PRICING-AND-UNIT-ECONOMICS-PLAN.md)
- [AWS Bedrock Provider - Implementation Plan](../plans/AWS-BEDROCK-PROVIDER-IMPLEMENTATION-PLAN.md)
- [Multi-User Server + Client Agent Proposal](MULTI-USER-CLIENT-AGENT-PROPOSAL.md)
- ZeroTrustAgent-inspired uplifts for GuardianAgent
- [Identity & Memory Spec](../design/IDENTITY-MEMORY-DESIGN.md)
- [Web Auth Configuration Spec](../design/WEB-AUTH-CONFIG-DESIGN.md)

## Executive Summary

GuardianAgent can evolve into a hosted SaaS product, but it should not be modeled as "one giant shared agent server."

The correct shape is:

- a shared control plane for signup, identity, billing, tenant provisioning, feature flags, and platform policy
- one regional workload cell per group of tenants
- one logical workspace per paying customer or self-serve user
- one or more logical agents per workspace
- isolated execution workers per run, session, or browser job
- container-backed by default, with an optional Firecracker-backed microVM tier for higher-risk Linux execution classes
- a shared model gateway that fronts:
  - central local-model inference pools
  - Amazon Bedrock
  - customer bring-your-own API keys
  - later Guardian-managed premium frontier model access

This design preserves the parts of Guardian that matter:

- always-on behavior for channels, schedules, and automation
- strong execution isolation
- explicit approvals and audit
- multi-provider model routing
- future expansion to managed endpoint agents

It also avoids the main trap in the current native-cloud thought process:

- "always-on agent" does **not** need to mean "one permanently running VM or container per user"

For most tenants, the agent should be logically always-on but physically event-driven:

- messages, web actions, schedules, and connector events wake work
- persistent state lives in platform storage
- execution happens in isolated worker sandboxes
- idle tenants do not hold dedicated compute

Firecracker is a credible additional execution-plane option for this design, but only in the hosted Linux workload cells. It should be treated as a stronger isolation substrate for selected worker classes, not as a replacement for Guardian's control plane, auth, approval, or memory architecture.

## Problem Statement

The current Guardian runtime is optimized for a private, single-host deployment:

- bearer-first web auth with in-memory browser sessions
- local PTYs and long-lived process state
- SQLite-backed persistence
- loopback-style Google and Microsoft OAuth flows
- same-host local model assumptions

That is a good fit for private installs and a poor fit for a public SaaS product.

The SaaS product needs a new platform shape that supports:

- public signup and login
- hosted web UI access
- tenant-safe always-on agents
- platform-managed channels such as Telegram
- per-tenant and per-user connector accounts
- isolated execution
- shared model infrastructure
- clear metering and billing
- recoverable operations at multi-tenant scale

## Goals

- Provide a hosted Guardian SaaS for general users with web UI first.
- Support one default personal agent on signup and optional additional agents later.
- Keep Telegram and future channels first-class.
- Support per-tenant and per-user Google and Microsoft 365 connections with server-side OAuth.
- Isolate tenant state, secrets, channels, approvals, and executions.
- Allow a shared local-model platform and shared Bedrock integration.
- Allow bring-your-own external API keys without exposing them to other tenants or platform operators.
- Leave room for premium Guardian-managed frontier model access later.
- Leave room for a future client-agent / managed-endpoint mode for advanced users.

## Non-Goals For V1

- Raw SSH access into Guardian platform hosts
- Local CLI parity inside the hosted product
- Per-agent physical database instances by default
- Unlimited browser automation for anonymous or free users
- Generic workstation access without a later client-agent or connector boundary
- Peer-to-peer agent meshes
- Cross-tenant shared memory, shared browser sessions, or shared connector accounts

## Core Design Principles

### 1. Workspace is the primary security and billing boundary

The primary multi-tenant boundary should be the **workspace**:

- a self-serve user gets one workspace by default
- a team plan can later add multiple users to one workspace
- every agent belongs to exactly one workspace

This is a better boundary than "user" or "agent" for:

- billing
- secrets
- shared connections
- approvals
- storage quotas
- audit

### 2. Agent is a logical runtime boundary, not a mandatory dedicated process

Each agent should have:

- its own identity
- memory namespace
- automation set
- configuration overlay
- run history
- approval scope

But that does **not** imply:

- one dedicated VM per agent
- one dedicated container per agent at all times
- one physical database per agent

Instead, an agent should be represented as a durable state package that is hydrated into isolated workers when needed.

### 3. Shared control plane, isolated execution plane

The platform should not execute tenant tools inside the same long-lived API process that handles signup, auth, and billing.

Split the system into:

- control plane
- workload cells
- execution workers
- model gateway

### 4. Public SaaS auth and third-party connector auth are different systems

There are two separate auth problems:

- the user signing into Guardian
- Guardian acting on the user's Google, Microsoft, Telegram, or future accounts

They must not be collapsed into one token model.

### 5. Shared model infrastructure must sit behind a platform gateway

No tenant traffic should call central Ollama directly.

All model traffic should go through a Guardian model gateway that applies:

- routing
- quotas
- audit
- prompt redaction policy
- metering
- fallback
- tenant isolation

### 6. Hosted tier and endpoint-access tier should be separate product modes

Hosted Guardian should focus on:

- web UI
- channels
- SaaS connectors
- cloud tools
- managed browser jobs

Local files, shells, coding workspaces, and workstation telemetry should come later through:

- a client agent
- a remote execution connector
- or a tightly scoped SSH connector

## Target Product Shape

### User-facing product

- users sign up through the hosted web app
- a default personal workspace is created
- a default agent is created automatically
- users can:
  - chat in the web UI
  - link Telegram
  - connect Google and Microsoft 365
  - configure automations and schedules
  - choose model policies
  - add their own API keys

### Advanced product modes

Later additions can include:

- team workspaces
- shared workspace agents
- advanced browser jobs
- managed endpoint client agent
- remote exec connectors
- premium dedicated cells

## High-Level Architecture

```text
Internet
  |
  v
CloudFront / WAF / Rate Limits
  |
  v
Web App + API Gateway
  |
  +--> Identity Service
  +--> Billing / Entitlements
  +--> Tenant Directory
  +--> Control Plane API
          |
          +--> Regional Workload Cell Router
                    |
                    +--> Cell API / BFF
                    +--> Orchestrator
                    +--> Job Queue
                    +--> Approval Service
                    +--> Connection Broker
                    +--> Model Gateway Client
                    +--> Execution Worker Pools
                    +--> Browser Worker Pools
                    +--> Storage / Memory / Audit
                    +--> Channel Adapters

Shared Services
  |
  +--> Model Gateway
  |      +--> Ollama GPU pools
  |      +--> Bedrock
  |      +--> Customer BYO provider calls
  |      +--> Guardian premium frontier accounts
  |
  +--> KMS / Secrets / Key Broker
  +--> Metrics / Logs / Trace / Audit Lake
  +--> Artifact Storage
```

## Deployment Topology

## Global Control Plane

The global control plane owns:

- signup and login
- workspace provisioning
- billing
- entitlements
- feature flags
- tenant-to-cell routing
- support tooling
- product-wide policy defaults

Recommended AWS footprint:

- CloudFront
- AWS WAF
- Cognito user pools for hosted identity
- public app/API services on ECS Fargate
- Aurora PostgreSQL for control-plane metadata
- Redis for sessions, rate limits, and cache
- S3 for shared control-plane artifacts
- EventBridge for provisioning and domain events

Why this split works:

- control-plane services are mostly stateless HTTP/API services
- they do not need GPU
- they should not hold tenant execution state

## Regional Workload Cells

Each tenant is assigned a **home cell** in one region.

A workload cell owns:

- web session execution for that tenant
- orchestration
- approvals
- connector brokers
- agent state
- run queues
- execution workers
- browser workers
- per-cell audit and metrics export

Recommended AWS footprint per cell:

- ECS services for cell API / orchestrator / approval service / connection broker
- SQS for run queues
- Redis for hot cache, locks, rate limits, queue coordination
- Aurora PostgreSQL or PostgreSQL-compatible service for tenant state
- S3 bucket or prefix for cell-scoped artifacts
- ECS on EC2 for execution and browser worker pools
- ECS on EC2 GPU clusters for Ollama pools if colocated in-cell
- optional EC2 worker hosts with KVM enabled for Firecracker-backed microVM pools

### Optional Firecracker-backed worker pools

For selected worker classes, a workload cell can add a Firecracker-backed execution tier instead of relying only on containers.

Recommended use cases:

- high-risk browser jobs
- untrusted or customer-supplied automation code
- coding or shell-like execution surfaces if those are later introduced in hosted tiers
- package install, build, or test runs that materially increase breakout risk

Recommended posture:

- Guardian remains the control plane and queue owner
- Firecracker is only an execution substrate inside Linux/KVM worker hosts
- one microVM per run or short-lived bounded session
- per-run ephemeral rootfs or scratch disk
- no direct tenant access to the host or microVM control API
- model access, secret brokerage, approvals, and audit remain Guardian-managed

Important constraint:

- this is a hosted Linux design option only; it is not the answer for Windows local installs or for the cross-platform managed endpoint client-agent mode

## Why use cells

Cells provide:

- blast-radius reduction
- simpler noisy-neighbor control
- easier tenant pinning
- cleaner premium dedicated-tier upgrades
- better regional expansion later

The platform can start with one cell and preserve the abstraction for future scaling.

## Identity and Signup

## SaaS Identity Plane

Guardian SaaS should adopt first-class hosted identity instead of bearer token copy-paste.

Recommended design:

- Cognito user pools as the initial hosted identity provider
- Guardian web app uses OIDC login
- Guardian application session is an HttpOnly cookie session issued by the web backend
- support external federation later through Cognito:
  - Google
  - Microsoft Entra ID
  - enterprise SAML / OIDC

Why this is the right split:

- hosted identity solves Guardian login
- connector identity remains separate and per integration

## Workspace and Membership Model

Core entities:

- `workspace`
- `user`
- `workspace_membership`
- `agent`
- `connection`
- `channel_binding`
- `thread`
- `approval_request`
- `run`

Recommended roles:

- `owner`
- `admin`
- `member`
- `viewer`
- later: `approver`

## Session Model

The current in-memory web session model is acceptable only inside one process.

For SaaS:

- browser sessions should be stored in Redis or a session service
- SSE or WebSocket auth should bind to the authenticated Guardian session
- request principals should resolve to:
  - `workspaceId`
  - `userId`
  - `sessionId`
  - `role`

Caller-supplied `userId` values must never define tenancy in the hosted product.

## Tenant, User, and Agent Model

### Recommended hierarchy

```text
Platform User
  -> Workspace
      -> Agent
          -> Threads
          -> Memory Namespace
          -> Automations
          -> Connections in use
          -> Approvals
          -> Runs
```

### Default self-serve behavior

On signup:

- create one workspace
- create one default personal agent
- provision one default memory namespace
- assign one default model policy
- assign one default approval policy

This gives the user the feeling of "their own always-on agent" without provisioning dedicated infrastructure.

### Important design decision

The default physical isolation boundary should be **workspace**, not **agent**.

Each agent gets its own logical namespace for:

- prompts
- memory
- automations
- artifacts
- browser state
- schedules

But by default these live in shared cell infrastructure under strict workspace and agent scoping.

### Optional stronger tiers

Offer stronger isolation tiers later:

- `shared_cell`
- `dedicated_cell`
- `single_tenant_private_deployment`

## Agent State Package

Every agent should own a durable state package with:

- `agentId`
- `workspaceId`
- model routing policy
- system prompt and profile
- conversation history
- knowledge and memory state
- automation definitions
- schedules
- tool and browser policy
- channel preferences
- linked connection references
- run history and current work state

This state package is loaded into workers on demand.

## Data Plane Design

## Control-plane storage

Use PostgreSQL for:

- users
- workspaces
- memberships
- billing state
- feature flags
- global model catalogs
- tenant-to-cell mapping

## Cell storage

Use PostgreSQL for:

- agents
- threads and messages
- approvals
- runs and events
- automations and schedules
- connection metadata
- usage meters

Use S3 for:

- attachments
- exports
- browser screenshots
- browser traces
- generated files
- audit archives

Use Redis for:

- sessions
- transient coordination
- throttles
- hot caches
- worker heartbeats

## Memory and Search

The current SQLite-first state model is not the right default for SaaS.

Recommended SaaS memory posture:

- migrate conversations and durable memory to PostgreSQL-backed storage
- add vector support through `pgvector` or a dedicated vector service
- keep memory namespaced by workspace and agent
- use object storage for large artifacts

Recommended memory layers:

- working memory:
  - in-run state in Redis or worker-local memory
- episodic memory:
  - Postgres thread history plus vector or indexed retrieval
- procedural memory:
  - later, learned automations and reusable recipes

## Why not one database per agent

Per-agent physical databases sound attractive but create large operational cost:

- provisioning overhead
- migrations at high cardinality
- connection management
- backup sprawl
- painful support operations

The better default is:

- one shared control-plane database
- one database per workload cell
- strict workspace and agent partitioning
- optional dedicated-cell or dedicated-database tiers for enterprise plans

## Execution Plane

## Worker pool model

Use separate worker pools by risk and workload type:

- `orchestrator_workers`
- `safe_tool_workers`
- `connector_workers`
- `browser_workers`
- `cloud_tool_workers`
- later: `coding_workers`
- optional: `microvm_workers` for higher-risk run classes that justify stronger isolation than containers alone

All tenant work runs through queues and isolated workers.

## Isolation model

Each job gets:

- a signed job token
- workspace and agent identity
- scoped capabilities
- TTL and replay protection
- tenant-scoped temp storage
- a clean process boundary

Recommended execution environment:

- ECS on EC2 worker nodes
- one container per run or one container per short-lived session
- rootless container user
- hardened seccomp / AppArmor where available
- no shared writable host paths
- per-job ephemeral filesystem
- network egress policy by worker class

Additional execution option for stronger isolation:

- Firecracker-backed microVMs on dedicated Linux/KVM worker hosts
- one microVM per run or short-lived session for selected high-risk worker classes
- jailed Firecracker processes with host-level cgroup, namespace, and privilege dropping
- host-brokered access to models, secrets, and audit sinks rather than direct uncontrolled guest access
- workspace snapshot plus patch/artifact return for later coding tiers instead of live host filesystem sharing
- optional warm pools or snapshots to reduce startup latency for repeated run classes

Design guardrails for this option:

- Firecracker should strengthen the execution plane, not replace the control plane
- tenancy, identity, approvals, policy, and routing stay in Guardian services
- the guest should receive scoped job identity and scoped credentials, not platform-wide authority
- high-risk network access should still flow through Guardian-defined egress policy and broker layers
- this tier should be introduced first for hosted Linux cells, not for local desktop deployments

### Browser isolation

Browser automation is a distinct high-risk tier.

Each browser run should use:

- a dedicated browser worker
- isolated browser profile storage per workspace and agent
- one context or session per run by default
- encrypted persisted cookies only when explicitly required
- separate quotas and policy

For stronger hosted tiers, browser workers are one of the best candidates for Firecracker-backed microVM execution because they combine complex parsers, network exposure, downloads, and artifact handling.

### Coding and shell access

Hosted SaaS should **not** initially expose arbitrary shell or filesystem access to the Guardian platform hosts.

For advanced users, later options are:

- managed client agent on the user's machine or VM
- scoped SSH connector to customer-owned hosts
- scoped cloud or repo connectors

This is safer than "SSH into the SaaS agent box."

If hosted coding is introduced later, the preferred stronger-isolation shape is not "shell on the shared worker host." The better shape is a Firecracker-backed or otherwise equivalent isolated execution environment with explicit workspace snapshot input and patch or artifact return into Guardian's normal approval and audit flow.

## Always-On Behavior

The agent should be logically always-on through:

- channel listeners
- schedules
- web actions
- connector callbacks or polling
- background jobs

It should be physically realized through:

- persisted state
- queues
- wake-on-event workers
- optional warm pools

This reduces cost dramatically relative to "one hot runtime per user."

## Channel Architecture

## Web UI

Web is the primary SaaS interface.

Recommended pattern:

- SPA or server-rendered app at the edge
- backend-for-frontend API
- OIDC login
- session cookie
- SSE or WebSockets for run updates

The current Guardian web auth model can inform the browser session custody pattern, but the hosted product should not expose bearer tokens as the primary UX.

## Telegram

Telegram should be platform-managed in v1.

Recommended model:

- one Guardian platform bot per environment
- user links Telegram account from web UI
- platform issues short-lived link code
- user messages `/link <code>` to the platform bot
- platform binds that Telegram chat to:
  - workspace
  - user
  - default agent or selected agent

This is simpler than asking every general user to create their own bot.

Later:

- allow workspace-owned Telegram bots for premium plans

## Future channels

Future channels should follow the same pattern:

- channel binding belongs to a workspace
- end-user identity maps to a platform user
- each inbound message resolves:
  - workspace
  - user
  - agent
  - channel session

Candidate channels:

- email ingest
- Slack
- Discord
- SMS / WhatsApp via providers
- voice and telephony

## Connector and OAuth Architecture

## Critical design decision

Google and Microsoft 365 integrations must become **server-side SaaS OAuth** integrations.

The current loopback desktop flow is not suitable for hosted Guardian.

## Connection object model

Introduce a `connection` service with explicit ownership and scope:

- `connectionId`
- `workspaceId`
- optional `userId`
- `provider`
- `connectionScope`:
  - `user`
  - `workspace`
- scopes granted
- token status
- refresh status
- last validated at

### Examples

- personal Gmail account:
  - user-scoped connection
- personal Outlook account:
  - user-scoped connection
- shared org mailbox:
  - workspace-scoped connection
- workspace Google Drive service account later:
  - workspace-scoped connection

## Token custody

Do not give raw refresh tokens to workers.

Recommended pattern:

- refresh tokens stored encrypted in a secrets system
- control plane or connection broker exchanges refresh token for access token
- worker receives only short-lived access token or brokered request result

This reduces blast radius if a worker is compromised.

## OAuth flow requirements

For Google and Microsoft:

- use server-hosted redirect URIs on the Guardian app domain
- use web-application or confidential-client flow for hosted Guardian
- store offline-refresh capability securely
- support reauth and scope upgrades in-product
- show token health in the UI

### Admin-consent and review implications

This product will need to plan for:

- Google app verification and restricted-scope review
- Microsoft Graph app registration, consent, and possibly admin consent flows
- user-facing privacy policy and data usage disclosures

That is a product and compliance dependency, not just an engineering task.

## Model Plane

## Model Gateway

The model gateway is the platform boundary for all LLM traffic.

It owns:

- model routing
- quota enforcement
- usage metering
- fallback
- tenant policy
- secret resolution
- prompt and response logging policy
- cost attribution

## Provider lanes

### 1. Platform local-model lane

Initial implementation:

- central Ollama pools on GPU-backed worker nodes
- internal-only access
- model gateway routes requests to Ollama

Important design note:

Do not make "Ollama" the long-term platform contract.

Internally define a local inference interface so the backend can later swap:

- Ollama
- vLLM
- TGI
- Bedrock-hosted open models

without changing tenant-facing configuration semantics.

### 2. Managed cloud lane

Add Bedrock as a first-party managed cloud provider:

- route through model gateway
- authenticate with platform IAM roles
- meter usage per workspace
- optionally use Bedrock VPC endpoints for private AWS traffic

### 3. Customer BYO key lane

Tenants can provide:

- OpenAI key
- Anthropic key
- Groq key
- other supported keys later

These keys should be:

- stored as workspace secrets
- decrypted only at request time
- never exposed in raw form to the UI after save
- metered separately from platform-paid usage

### 4. Guardian premium frontier lane

Later, Guardian can offer premium included access to frontier models through platform-owned accounts.

This requires:

- entitlement checks
- spend budgets
- rate limits
- margin-aware billing
- quota enforcement

## Routing policy

Each agent should have a model policy:

- `local_preferred`
- `bedrock_preferred`
- `byo_required`
- `premium_allowed`
- `auto`

The model gateway then resolves the actual provider based on:

- feature entitlement
- user preference
- task class
- data policy
- current quota
- provider availability

## Prompt and data policy

An overlooked requirement in SaaS model design is prompt data handling.

The platform needs explicit per-lane policy for:

- whether prompts are retained
- whether responses are retained
- how long traces are stored
- whether prompts may be used for eval datasets
- whether prompt caching is enabled

Prompt caching and deduplication must be tenant-scoped by default. Cross-tenant prompt caching should be avoided unless explicitly designed and reviewed.

## Approvals and Policy

Approvals must bind to:

- workspace
- user
- agent
- thread or run
- requested capability

An approval ID alone is not enough.

Required approval classes:

- external posting
- connector writes
- cloud mutations
- browser mutations
- future endpoint or shell actions

Policy layers:

- platform baseline policy
- plan-based policy
- workspace policy
- agent policy
- per-run overrides where allowed

## Billing, Quotas, and Plan Enforcement

The design needs an explicit usage ledger from day one.

Meter by:

- workspace
- agent
- model provider
- channel
- browser minutes
- connector actions
- storage
- execution minutes

Required plan controls:

- monthly token caps
- concurrency caps
- browser minute caps
- connector count caps
- automation count caps
- storage caps

The platform should support:

- hard stop on cap
- soft alerts
- auto-upgrade prompts
- admin-configurable spend caps for workspace owners

## Security Design

## Tenant isolation

Every request and every job must carry:

- `workspaceId`
- `agentId`
- `userId`
- `sessionId` or `runId`

Every state read and write must scope by workspace first.

## Secret management

Secret classes:

- platform secrets
- workspace secrets
- user-scoped connector secrets
- agent-scoped config secrets
- model provider secrets

Recommended custody:

- KMS-backed envelope encryption
- secret metadata in Postgres
- secret material in a dedicated secret store or encrypted blob store
- rotation support
- audit trail for reads and writes

## Support and break-glass access

This is often missed in SaaS agent designs.

The platform needs explicit rules for operator access:

- no routine direct tenant-data browsing
- audited support sessions only
- time-boxed break-glass access
- customer-visible audit where appropriate

## Abuse prevention

Public signup means the product must handle:

- signup fraud
- spam through outbound channels
- card testing and billing abuse
- prompt abuse
- connector abuse
- browser abuse

Required controls:

- WAF and rate limiting
- signup throttles
- reputation and risk scoring
- trust tiers
- free-tier restrictions
- per-tenant domain and tool restrictions
- anomaly detection on outbound actions

## Observability and Operations

## Required telemetry

Track:

- signup funnel
- channel link success and failure
- connector auth success and refresh failure
- run latency
- model latency and cost
- worker failures
- queue depth
- browser run failure classes
- policy denials
- approval turnaround time

## Audit

Audit trails must cover:

- signups and identity events
- workspace membership changes
- connector grants and revocations
- model usage
- tool executions
- approvals
- policy changes
- support access

## Disaster recovery

Plan for:

- database backups
- point-in-time recovery
- artifact replication
- queue replay where possible
- cell failover

Initial recommendation:

- single region per cell
- cross-region backups
- later add active-passive regional recovery for higher tiers

## Product and UX Flows

## Signup and initial provisioning

1. User signs up.
2. Identity provider confirms account.
3. Control plane provisions workspace and default agent.
4. User lands in onboarding.
5. User chooses:
   - default model policy
   - approval profile
   - Telegram link
   - optional Google or Microsoft connection
6. Workload cell assignment is created.
7. User starts chatting.

## Telegram link flow

1. User requests Telegram link from web UI.
2. Platform issues short-lived link token.
3. User sends token to platform Telegram bot.
4. Channel service validates token and binds:
   - workspace
   - user
   - target agent
5. Future Telegram messages resolve directly to that binding.

## Google or Microsoft connection flow

1. User clicks connect in the web UI.
2. Guardian redirects to provider OAuth page using server callback URL.
3. Provider redirects back to Guardian SaaS callback.
4. Connection service stores encrypted refresh token and granted scopes.
5. UI shows connection health and scope status.
6. Future runs request short-lived access through the connection broker.

## Web chat flow

1. User sends message from web UI.
2. Cell API authenticates session and resolves workspace, user, and agent.
3. Orchestrator creates run and enqueues work.
4. Worker hydrates agent state package.
5. Worker calls model gateway and tools as allowed.
6. Run timeline streams back to the UI.
7. Outputs, audit, and usage records are persisted.

## Hosted Browser and Execution Policy

Not every existing Guardian capability should be exposed equally in hosted SaaS.

Recommended hosted v1 capability posture:

- allow:
  - chat
  - channels
  - Google and Microsoft 365
  - cloud connectors
  - web search and web fetch
  - safe automations
- restrict:
  - arbitrary filesystem access
  - arbitrary shell
  - unrestricted browser mutation
  - unrestricted package install

This keeps the public SaaS product aligned with general-user expectations and reduces abuse surface.

## Things The Product Needs That Are Easy To Miss

### 1. Workspace vs agent boundary

The platform needs both. Do not collapse them.

### 2. User auth vs connector auth

Signing into Guardian is not the same as granting Gmail or Outlook access.

### 3. "Always-on" cost control

Queue-driven execution is mandatory unless you want runaway idle cost.

### 4. Token refresh and connector health

Long-lived agent automation depends on reliable refresh and reauth UX.

### 5. Abuse and spam controls

A public agent product that can send messages or browse the web becomes an abuse target immediately.

### 6. Browser state isolation

Shared browsers are a cross-tenant data leak risk.

### 7. Support access model

Without explicit support and break-glass rules, operations will create ad hoc backdoors.

### 8. Data retention and deletion

Tenants need export and delete semantics for:

- threads
- memory
- artifacts
- connector data
- audit

### 9. App review and compliance

Google and Microsoft connector approval is a product dependency, not just an engineering dependency.

### 10. Bring-your-own keys vs included usage

These require different quota, billing, and observability semantics.

## Recommended Implementation Phases

### Phase 1 - Hosted identity and workspace model

- introduce workspace and membership primitives
- add hosted auth with OIDC
- replace bearer-copy login with browser session auth
- create one default agent per workspace

### Phase 2 - Cell-aware control plane

- add tenant directory and cell assignment
- split control plane from workload services
- move sessions and hot state out of process memory

### Phase 3 - Agent state and queues

- define agent state package
- move runs onto queued worker execution
- add per-agent namespaces for memory, runs, and approvals

### Phase 4 - Telegram and channel binding

- add platform-managed Telegram bot
- add link and revoke flows
- scope channel identities by workspace and user

### Phase 5 - Server-side Google and Microsoft connections

- replace loopback connector OAuth with hosted callback flows
- add connection service and token broker
- support user-scoped refresh tokens

### Phase 6 - Model gateway

- add central model gateway
- support shared Ollama and Bedrock
- add BYO key lane
- add metering and quotas

### Phase 7 - Hosted browser and cloud execution workers

- create dedicated worker pools
- add browser isolation
- add workspace quotas and trust tiers

### Phase 8 - Advanced execution modes

- add client-agent or remote execution connector
- add premium dedicated cells
- add premium platform-managed frontier model access

## Recommended Explicit Decisions

- Hosted Guardian should be **workspace-multi-tenant**, not one-host-per-user.
- Agent state should be logically isolated per agent, but physical infrastructure should default to shared cells.
- Web auth should move to hosted OIDC sessions.
- Google and Microsoft integrations should move to server-side OAuth with hosted callbacks.
- Telegram should start as a platform-wide bot, not BYO bot.
- Model access should flow through a Guardian model gateway.
- Bedrock should be a first-class managed-cloud model lane.
- Central Ollama should sit behind an abstraction so it can be replaced later.
- Hosted SaaS should not expose raw shell or host CLI in v1.
- Advanced local or server access should come later through a client-agent or scoped connector.

## Open Questions

- Should self-serve signup create exactly one workspace per user, or allow multiple from day one?
- Should the initial team plan support shared agents, or only personal agents plus shared billing?
- Should premium model access be usage-billed, seat-billed, or both?
- Should workspace-scoped Google and Microsoft connections be in v1, or only user-scoped delegated connections?
- Should browser automation be limited to allowlisted domains in self-serve tiers?
- Should dedicated-cell isolation be an enterprise-only feature?

## External Assumptions Checked On 2026-03-28

- Amazon Cognito user pools support sign-up, sign-in, OIDC, managed login, and third-party federation.
- Amazon ECS Fargate task definitions do not support `gpu`, which keeps GPU inference on EC2-backed worker pools rather than Fargate.
- Cloudflare Tunnel remains an outbound-only way to publish private services behind Cloudflare Access.
- Google installed-app OAuth still documents loopback redirects for desktop apps, while hosted SaaS should use web-server OAuth redirect URIs.
- Microsoft identity platform still documents `http://localhost` and public-client flows for desktop apps, which are not the right hosted-SaaS connector model.

Official references:

- Amazon Cognito user pools: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools.html
- Cognito third-party federation: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html
- ECS Fargate task definition differences: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html
- ECS GPU workloads on EC2: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-gpu.html
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/cloudflared/
- Cloudflare Access application setup: https://developers.cloudflare.com/learning-paths/clientless-access/access-application/create-access-app/
- Google OAuth for installed apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google OAuth for web server apps: https://developers.google.com/identity/protocols/oauth2/web-server
- Microsoft desktop app registration: https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration
