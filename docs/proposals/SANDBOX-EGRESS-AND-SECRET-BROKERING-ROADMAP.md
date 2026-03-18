# Proposal: Sandbox Egress And Secret Brokering Uplift For GuardianAgent

**Date:** 2026-03-18  
**Status:** Draft  
**Author:** Internal security gap analysis

---

## Executive Summary

GuardianAgent already has strong runtime security controls:

- brokered planner worker with no direct network access
- runtime-owned credential refs and encrypted local secret storage
- mandatory admission, taint, approval, and output-guardian chokepoints
- OS sandbox support with strong-host and degraded-host semantics

But there is still an important gap for sandboxed subprocesses and other network-capable child processes:

- child processes do not yet use a true secret-broker model
- sandboxed child environments are hardened, but not rebuilt around secret handles
- Guardian does not yet ship a general supervisor-owned egress broker/firewall
- outbound policy is still mostly tool-specific, not enforced at a single real network-exit chokepoint

The uplift we actually need is not "be more like a proxy product." It is:

1. stop giving long-lived credential values to child processes
2. move secret use and outbound authorization behind the supervisor
3. attach provider/credential capability explicitly to each sandboxed execution context
4. enforce outbound policy at the actual egress boundary where possible
5. fail closed on hosts where we cannot make those guarantees safely

---

## Why This Proposal Exists

The desired security model is:

- providers are validated and attached to a sandbox before execution
- the supervisor keeps real secret bytes in trusted memory or trusted local secret storage
- child processes receive only opaque handles or placeholders
- outbound traffic is allowed only through a supervisor-owned egress path
- that egress path applies policy and, when the protocol is under supervisor control, resolves placeholders back to real secret values

Guardian does not fully implement that model today.

The current system is already strong for the built-in planner worker, but not yet for every network-capable subprocess-backed tool path.

---

## What Guardian Already Has

Guardian should keep and build on these controls:

- brokered worker isolation for the built-in chat/planner loop
- encrypted local secret storage and runtime credential-ref resolution
- tool policy, principal-bound approvals, and taint-aware mutation gating
- output secret scanning, trust classification, and quarantined reinjection suppression
- sandbox availability detection with explicit strong vs degraded behavior

Those controls are real and valuable. This proposal is about closing the remaining gap around subprocess credentials and network egress.

---

## The Gap We Actually Need To Close

Today, Guardian's remaining weak point is not the planner worker. It is the combination of:

- resolved credentials existing as normal runtime strings
- sandboxed child processes starting from inherited process environment plus hardening
- no first-class provider-to-sandbox capability attachment model
- no universal supervisor-owned egress broker for protected child processes

That means Guardian can currently say:

- the planner worker has no direct network access
- risky tools are sandboxed when strong host support exists
- policy and approvals gate tool use

But Guardian cannot yet honestly claim all of the following for general child processes:

- child processes never receive real secret values
- provider credentials are rewritten only at egress time by the supervisor
- all protected outbound traffic is forced through a single enforcement proxy
- outbound allow/deny is decided from sandbox-attached provider capabilities rather than ambient environment state

---

## Target Security Properties

After this uplift, the intended guarantees should be:

- no long-lived provider secret is injected into a sandboxed child as plaintext
- protected child processes receive only opaque secret handles or placeholders
- the supervisor is the only component allowed to resolve those handles into secret bytes
- outbound traffic from protected sandboxes is mediated by a supervisor-owned egress layer wherever the host can enforce it
- egress decisions are based on attached provider capabilities plus explicit domain policy
- all secret-handle usage, egress decisions, and bypass attempts are auditable
- degraded hosts are explicit about weaker guarantees and fail closed for high-risk secret-bearing subprocess flows

---

## Required Architecture Changes

### 1. Secret Handles Instead Of Raw Secret Env Vars

Add a supervisor-owned secret handle registry.

What changes:

- `credentialRef` resolution still happens in trusted runtime code
- instead of placing resolved values into child environments, Guardian issues short-lived opaque handles
- child environments receive values such as `ga-secret://<handle>` or another explicit placeholder format
- handles are scoped to a run, session, or sandbox instance and have TTLs
- handles are never written to UI state, logs, or normal config storage as real secret values

Primary touchpoints:

- `src/runtime/credentials.ts`
- `src/runtime/secret-store.ts`
- new supervisor/runtime service for handle issuance and revocation

### 2. Provider-Attached Sandbox Capability Model

Add an explicit attachment layer between sandboxes and provider capabilities.

What changes:

- sandboxed executions declare which providers or credential identities they are allowed to use
- egress policy is evaluated from attached provider ids, allowed domains, and risk level
- ambient access to unrelated credentials is removed
- tool requests and long-lived subprocess launches carry an `egressContext` or equivalent structured capability bundle

Primary touchpoints:

- `src/tools/executor.ts`
- `src/config/types.ts`
- `src/runtime/connectors.ts`
- browser, MCP, cloud, and web-search integration paths

### 3. Supervisor-Owned Egress Broker

Add an optional local egress broker/firewall owned by the supervisor.

What changes:

- protected child processes receive `HTTP_PROXY` and `HTTPS_PROXY` pointing at a supervisor-owned local service
- the broker applies allow, monitor, or block policy before forwarding
- destination, method, provider attachment, and policy decisions are logged
- direct-bypass attempts are detected and surfaced when the host can enforce proxy-only networking

Important v1 constraint:

- do not make TLS MITM the default

That means the broker must distinguish two cases:

- traffic Guardian terminates or originates in trusted code: headers/body/auth can be assembled safely with real secret values
- opaque end-to-end TLS traffic from a child process: destination policy can still be enforced, but content rewriting is not generally possible without interception

This means "placeholder rewrite at proxy time" is realistic only for protocols and integrations Guardian terminates or explicitly brokers, not for every arbitrary encrypted stream.

Primary touchpoints:

- new `src/runtime/egress-broker.ts` or equivalent
- `src/channels/web.ts`
- `src/runtime/notifications.ts`
- `src/index.ts`

### 4. Split Network Execution Into Clear Classes

Guardian should stop treating all network-capable execution as the same thing.

Recommended classes:

- `brokered_llm`
  - already implemented in substance
  - worker has no network; supervisor makes provider calls

- `supervisor_owned_client`
  - preferred for secret-bearing integrations
  - supervisor constructs authenticated HTTP or SDK calls directly
  - no raw credential ever enters a child process

- `proxied_subprocess`
  - used for tools that genuinely need a child process with outbound access
  - child gets proxy configuration and opaque handles only
  - broker enforces destination policy and logs egress

- `unbrokerable_network_subprocess`
  - if Guardian cannot safely mediate the protocol on the current host, high-risk secret-bearing variants should be denied or restricted

This is the practical way to match the desired model without pretending every protocol can be safely rewritten in transit.

### 5. Sandbox Launch Hardening

Change sandboxed process startup so it does not begin from a broad inherited parent environment.

What changes:

- replace "inherit then strip some dangerous vars" with an allowlisted environment builder for protected profiles
- inject only minimal runtime variables plus explicit proxy and capability metadata
- never pass general provider API keys through inherited env
- keep the existing worker behavior of minimal env and no network access

Primary touchpoints:

- `src/sandbox/index.ts`
- `src/sandbox/profiles.ts`
- `src/supervisor/worker-manager.ts`

### 6. Audit, Detection, And Operator Visibility

Add explicit security events for this new path.

Recommended events:

- secret handle issued
- secret handle resolved
- egress allowed
- egress denied
- proxy bypass suspected
- unattached provider requested
- sandbox launched with degraded egress guarantees

Operator visibility should include:

- which provider capability was attached to a run
- why an outbound request was allowed or denied
- whether the request used a supervisor-owned client or generic proxy path
- whether the host was strong or degraded at enforcement time

### 7. Harness And Regression Coverage

Add dedicated regressions for the gap this proposal is trying to close.

Must-cover cases:

- a sandboxed child process does not receive raw provider secret values in env
- a protected subprocess can reach an allowed destination only through the supervisor-owned egress path
- an unattached provider cannot be used even if a credential exists elsewhere in runtime config
- direct-bypass attempts are blocked or explicitly surfaced on strong hosts
- degraded hosts fail closed for high-risk secret-bearing subprocess flows
- headers, query strings, and body parameters do not leak secret handles back to the user
- audit logs capture allow, deny, and bypass events

Primary touchpoints:

- `docs/guides/INTEGRATION-TEST-HARNESS.md`
- new harness scripts under `scripts/`
- targeted unit coverage in `src/sandbox/*.test.ts`, `src/tools/*.test.ts`, and runtime tests

---

## Host Guarantees And Degradation Rules

This uplift must be explicit about host differences.

### Strong hosts

On strong hosts, Guardian should aim to guarantee:

- sandboxed child network paths are forced through the approved egress mechanism where supported
- provider capability attachment is enforced
- direct-bypass attempts are blocked or surfaced clearly
- secret-bearing subprocess flows can run only under mediated conditions

### Degraded hosts

On degraded hosts, Guardian should not pretend it has full egress enforcement.

Required behavior:

- keep brokered worker no-network guarantees
- keep supervisor-owned client paths available where they do not depend on child-process secrets
- deny or restrict secret-bearing generic subprocess egress when the host cannot safely enforce the model
- surface degraded egress guarantees clearly in setup status and tool state

This is the same philosophy Guardian already uses for strict sandbox availability: explicit guarantees, no silent overclaiming.

---

## Proposed Phases

### Phase 1: Environment And Credential Hardening

Ship first:

- allowlisted child-process environment builder
- secret handle registry
- removal of broad inherited credential env for protected profiles
- audit events for handle issuance and resolution

Why first:

- lowest ambiguity
- closes the most immediate secret-exposure gap
- improves every later egress design

### Phase 2: Provider Attachment And Supervisor-Owned Client Paths

Ship next:

- `egressContext` / attached-provider capability model
- migration of secret-bearing integrations toward supervisor-owned authenticated clients
- deny-by-default behavior for unattached provider use

Why second:

- this is the cleanest way to get real security value without depending on generic transparent proxying

### Phase 3: Optional Local Egress Broker

Ship after the capability model is in place:

- local HTTP and HTTPS proxy service
- allow, monitor, and block modes
- destination policy, logging, and operator visibility
- bypass detection and strong-host enforcement where feasible

Why third:

- highest implementation complexity
- easier to do well once capability attachment and audit schemas already exist

### Phase 4: Bypass Corpus And Packaging

Ship alongside or after the broker:

- encoded and fragmented exfil fixtures
- MCP and connector poisoning fixtures
- SIEM-ready event packaging
- operator suppressions and remediation guidance

---

## Immediate Next Step

The best first implementation slice is:

1. replace inherited child env construction with an allowlisted env builder
2. add a secret handle registry so protected children never receive raw provider secrets
3. add an explicit attached-provider capability object to protected tool and subprocess execution

That work is concrete, measurable, and directly aligned with the gap identified here.

---

## Non-Goals

- claiming universal transparent secret rewrite for arbitrary encrypted traffic
- making TLS interception the default posture
- replacing Guardian's existing admission, taint, approval, or output-guardian controls
- weakening local-first operation in favor of a proxy-only product shape

---

## Success Criteria

- no protected child process receives raw long-lived provider secrets in its environment
- provider use is explicit and auditable per sandbox or execution context
- secret-bearing external integrations prefer supervisor-owned clients over child-process credential injection
- optional egress broker can allow, monitor, and block representative outbound requests
- strong and degraded hosts surface different guarantees honestly
- the integration harness covers the new failure modes and bypass attempts
