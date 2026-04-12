# Vercel Remote Sandbox Connector Implementation Plan

**Date:** 2026-04-12  
**Status:** Draft  
**Primary references:** [Vercel-First Hosted Agent Platform Proposal](../proposals/VERCEL-FIRST-HOSTED-AGENT-PLATFORM-PROPOSAL.md), [Cloud Hosting Integration Spec](../specs/CLOUD-HOSTING-INTEGRATION-SPEC.md), [Coding Workspace Spec](../specs/CODING-WORKSPACE-SPEC.md)  
**External references:** [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox/), [Vercel Sandbox Managing / Authentication](https://vercel.com/docs/vercel-sandbox/managing), [Vercel Sandbox Pricing and Limits](https://vercel.com/docs/vercel-sandbox/pricing), [Daytona Documentation](https://www.daytona.io/docs/)

---

## Goal

Add a cloud connector capability for **explicit remote isolated execution** from Guardian running locally, while keeping:

- local execution as the default path
- isolation as an explicit opt-in lane for higher-risk operations
- one shared approval and orchestration model
- low operational complexity

This plan is for **bounded remote operations**, not for moving Guardian’s whole runtime into a remote VM product.

---

## Recommendation

### Phase 1 provider choice: Vercel

Use **Vercel first** for the initial remote sandbox connector.

Why:

- Guardian already has Vercel cloud profiles, tools, and config surfaces
- you already have a Vercel account
- Vercel Sandbox is a documented, supported primitive for isolated code execution
- adding sandbox capability to the existing Vercel profile model is materially simpler than introducing a brand new provider family

### Important caveat

This is **not** because Vercel clearly wins on raw sandbox capability. Daytona is attractive and in some areas more naturally aligned with remote dev environments.

The recommendation is mainly:

- lower integration cost
- lower config sprawl
- lower support burden for a first implementation

### Australia latency note

For Australia specifically, neither shared offering currently gives a clean regional advantage:

- Vercel Sandbox is currently only available in `iad1`
- Daytona shared regions are currently `us` and `eu`

That means Daytona does **not** currently beat Vercel on shared-region proximity for an Australia-based operator. Daytona becomes more compelling later if we want dedicated or custom runners.

---

## Daytona vs Vercel Comparison

| Dimension | Vercel Sandbox | Daytona |
|---|---|---|
| Current Guardian fit | Strong, because Guardian already has Vercel profiles and cloud tooling | Moderate, because it would be a new provider family |
| Core product shape | Ephemeral isolated compute primitive | Full composable sandbox computer for AI/dev work |
| Auth from local Guardian | Access token path supported outside Vercel-hosted runtime | API key / SDK model |
| Shared-region availability | `iad1` only today | `us` and `eu` shared regions |
| Future regional flexibility | Limited by current Sandbox region availability | Stronger story through dedicated/custom runners |
| Dev-environment richness | Good for bounded jobs, file operations, command execution, previews | Stronger native dev-computer posture: filesystem, git, process execution, interactive sessions, code execution, desktop automation |
| Best first use in Guardian | Explicit isolated jobs with low integration overhead | Heavier future remote-dev or custom-runner lane |
| Operational complexity for phase 1 | Lower | Higher |

### Where Vercel is better for Guardian right now

- fastest path to a working phase 1
- easiest place to reuse existing config and cloud-provider UX
- better fit if the main need is `run this in isolation, collect artifacts, destroy it`

### Where Daytona is more attractive

- more natural remote development environment model
- stronger long-term story if we want richer interactive sandboxes
- custom runners make it more attractive if latency, residency, or dedicated capacity become important

### Decision rule

Phase 1 should optimize for **getting isolated execution into Guardian without creating a new support problem**.

That favors Vercel first, while keeping the abstraction provider-neutral enough to add Daytona later.

---

## Scope

### In scope

- bounded remote isolated execution
- provider-attached sandbox capability under the cloud connector model
- remote job lifecycle: create, run, stream/read logs, fetch artifacts, destroy
- coding workflow integration for explicit high-risk or isolation-required steps

### Out of scope

- full remote-hosted Guardian runtime
- interactive PTY parity with local Code terminals
- silent migration of normal local coding work into the cloud
- provider-specific duplication of approvals, routing, or pending-action behavior

---

## Design Principles

1. Isolation must be explicit. Guardian should not silently ship normal work into a remote sandbox.
2. Reuse the existing cloud profile model where possible.
3. Keep the runtime provider-neutral even if Vercel is the only initial implementation.
4. Support only bounded job shapes first.
5. Destroy remote sandboxes promptly when the job finishes.

---

## Recommended Architecture

### A. Provider-neutral runtime service

Add a small provider-neutral remote execution layer:

- `src/runtime/remote-execution/remote-execution-service.ts`
- `src/runtime/remote-execution/types.ts`

This layer owns:

- job lifecycle
- provider abstraction
- artifact metadata
- run status
- approval and audit metadata

### B. First provider adapter: Vercel

Implement:

- `src/tools/cloud/vercel-sandbox-client.ts`
- `src/runtime/remote-execution/providers/vercel-remote-execution.ts`

### C. Later provider adapter: Daytona

Do **not** build Daytona in phase 1, but keep a clean adapter seam for:

- `src/runtime/remote-execution/providers/daytona-remote-execution.ts`

---

## Configuration Direction

Do not add a new top-level provider family for phase 1. Extend the existing `vercelProfiles` model with optional sandbox capability.

Recommended direction:

```yaml
assistant:
  tools:
    cloud:
      vercelProfiles:
        - id: vercel-main
          name: Main Vercel
          credentialRef: cloud.vercel.main
          teamId: team_xxx
          slug: guardian
          sandbox:
            enabled: true
            projectId: prj_xxx
            defaultTimeoutMs: 900000
            defaultVcpu: 2
            defaultMemoryGb: 4
            allowNetwork: true
            allowedDomains:
              - registry.npmjs.org
              - api.anthropic.com
```

This is illustrative only. The key rule is:

- keep sandbox capability under the existing Vercel connection
- do not force the user to configure the same account twice

---

## Supported Phase 1 Job Shapes

Only support bounded jobs with clear lifecycle and artifact expectations.

Recommended initial shapes:

- run tests in isolation
- run dependency install plus build in isolation
- execute untrusted or risky repo commands in isolation
- run a review-only repo scan in isolation
- run one-shot document or code conversion jobs that should not touch the host

Not recommended in phase 1:

- long-lived interactive development sessions
- browser-fleet replacement
- full remote coding workspace replacement

---

## Coding Workflow Integration

This connector should plug into the coding workflow plan as an explicit workflow step.

Examples:

- `Run this repo bootstrap in a remote isolated environment`
- `Verify this untrusted setup script in isolation before we run anything locally`
- `Use isolated execution for the dependency install and test run`

This keeps the product model clear:

- local coding session remains primary
- remote sandbox is a bounded verification or execution lane

---

## Vercel-Specific Integration Notes

### Authentication

For Guardian running locally, use the **access-token** authentication path rather than assuming a Vercel-hosted runtime.

Expected profile material:

- Vercel access token
- team ID
- project ID for sandbox auth context where needed

### Lifecycle

Guardian should be able to:

1. create sandbox
2. upload or sync bounded workspace input
3. run command or job
4. stream or poll logs
5. collect outputs
6. stop and destroy sandbox

### Constraints to design around

- current Vercel Sandbox region availability is `iad1` only
- Vercel Sandbox is best for bounded jobs, not for turning Guardian into a full remote IDE

---

## Daytona Follow-On Option

If we later decide that Vercel’s region model or sandbox shape is too limiting, Daytona is the most natural phase 2 candidate.

Daytona becomes the stronger choice if one or more of these become true:

- we need dedicated or custom-runner regions
- we need a richer remote dev-computer model
- we need more persistent interactive sessions
- we want remote git/filesystem/process operations as first-class primitives

The phase 1 abstraction should preserve that option.

---

## Implementation Phases

### Phase 1: Vercel Capability Foundation

Deliver:

- config extension on existing `vercelProfiles`
- Vercel sandbox client
- provider-neutral remote execution service
- basic job lifecycle APIs

Exit criteria:

- Guardian can launch one bounded remote job through a configured Vercel profile and return logs plus completion status

### Phase 2: Artifact And Approval Integration

Deliver:

- artifact upload/download
- approval-gated launch for mutating or risky remote jobs
- timeline and audit visibility

Exit criteria:

- remote jobs behave like first-class Guardian operations, not hidden background work

### Phase 3: Coding Workflow Integration

Deliver:

- coding workflow step for explicit isolated execution
- clear UI/source badging for remote execution
- verification results folded back into the active coding session

Exit criteria:

- remote isolated execution can be used from coding workflows without confusing the active local session model

### Phase 4: Daytona Adapter Decision

Deliver:

- explicit go / no-go review for Daytona adapter
- only proceed if Vercel limitations are material in real use

Exit criteria:

- provider-neutral abstraction proves sufficient to add Daytona without reworking the control plane

---

## File-Level Impact

Primary areas:

- `src/tools/cloud/*`
- `src/runtime/remote-execution/*`
- `src/channels/web-types.ts`
- `src/channels/web-runtime-routes.ts`
- `web/public/js/pages/cloud.js`
- `web/public/js/pages/config.js`
- `docs/specs/CLOUD-HOSTING-INTEGRATION-SPEC.md`
- `docs/specs/CONFIG-CENTER-SPEC.md`

---

## Acceptance Gates

- Vercel is integrated through the existing cloud profile model, not a duplicate config family
- remote isolation remains explicit and approval-aware
- phase 1 supports bounded jobs only
- local coding sessions remain the default and primary coding path
- the provider abstraction remains clean enough to add Daytona later if needed
