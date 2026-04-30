# Regulated Action Assurance Proposal

**Date:** 2026-04-30  
**Status:** Proposed  
**Origin:** Product strategy exercise for naming and packaging GuardianAgent's existing guarded runtime, approvals, audit, and evidence model for regulated-sector operations across defence, government, finance, legal, insurance, and critical infrastructure contexts.

## Executive Summary

GuardianAgent is already built around the core idea this proposal names:

**AI-assisted actions should pass through runtime-owned controls before they execute, and sensitive work should leave behind evidence that a human can review.**

That layer already exists in Guardian's architecture through:

- runtime-owned policy enforcement
- approval-gated tool execution
- trust-aware output handling
- brokered worker isolation
- hash-chained audit persistence
- bounded automations and scheduled work
- multi-channel operator surfaces

The product opportunity is not to invent a new assurance layer. The opportunity is to **formalize, name, document, and package the layer Guardian already has** for buyers and operators in regulated sectors.

The proposed name for that packaging is:

**Guardian Regulated Action Assurance**: a product framing for Guardian's existing model where sensitive actions are evaluated before execution, blocked when required, and packaged with defensible evidence after the fact.

This proposal is intentionally conceptual. It does not specify implementation details or architecture changes. The goal is to capture the product shape, market relevance, and capability themes that make Guardian's current control-plane thesis useful in environments where "the AI said it was fine" is not acceptable.

The central idea:

**Do not merely monitor AI-assisted work. Govern action before it leaves the system.**

## Strategic Position

Guardian's current positioning is broad:

> Security-first AI assistant with a Second Brain and operator tooling.

For regulated markets, that can become a sharper extension:

> Guardian Regulated Action Assurance helps teams use AI for operational work while preserving human accountability, pre-execution controls, and audit-ready evidence.

This is not a separate product from Guardian and not a replacement for the current architecture. It is a sector-facing name and packaging direction for Guardian's existing control-plane purpose.

## Target Sectors

### Defence

Useful for:

- controlled operational workflows
- sensitive document handling
- change approvals
- briefing and intelligence support
- supply-chain and procurement review
- incident-response coordination

Key buyer concerns:

- data locality
- operator accountability
- classified or restricted information boundaries
- auditability
- tool-use containment
- prevention of unauthorized external disclosure

### Government

Useful for:

- case work
- correspondence drafting
- policy research
- procurement workflows
- records and evidence packs
- cross-agency handoff tracking

Key buyer concerns:

- transparency
- explainability
- records retention
- privacy
- role-based access
- ministerial or statutory decision boundaries

### Finance And Insurance

Useful for:

- customer communication review
- advice-adjacent workflow controls
- complaint handling
- risk and compliance operations
- fraud triage
- controlled automation of internal processes

Key buyer concerns:

- regulatory obligations
- customer harm prevention
- evidence of control design
- supervision of AI-assisted actions
- non-repudiation of approvals

### Legal

Useful for:

- matter research
- document drafting and review
- privilege-sensitive workflows
- client communication preflight
- evidence bundling
- deadline and obligation tracking

Key buyer concerns:

- confidentiality
- privilege preservation
- source citation
- review before client-facing output
- matter-level access boundaries

### Critical Infrastructure

Useful for:

- operational playbooks
- maintenance approvals
- incident response
- vendor change review
- network and system diagnostics
- controlled escalation workflows

Key buyer concerns:

- resilience
- fail-closed behavior for high-risk actions
- change traceability
- human-in-the-loop accountability
- prevention of unauthorized control-plane changes

## Product Thesis

Regulated organizations do not only need AI assistants. They need enforceable assurance around AI-assisted action.

Guardian's existing product promise can be sharpened for those organizations:

1. Guardian helps operators work faster.
2. Guardian restricts what the assistant is allowed to do.
3. Guardian requires approval before sensitive execution when policy demands it.
4. Guardian preserves evidence showing what was requested, what was checked, who approved it, what ran, and what changed.
5. Guardian blocks or quarantines outputs when policy, risk, or trust boundaries are violated.

This is a better story than generic "AI governance" because it is tied to concrete action control rather than dashboards and after-the-fact reporting alone.

## Core Concept

### 1. Pre-Execution Action Gates

Sensitive actions should pass through an assurance gate before they execute.

Examples:

- sending an external email
- posting to a forum or external system
- changing cloud infrastructure
- modifying files in a protected workspace
- installing packages
- invoking a third-party tool server
- running shell commands
- executing scheduled automation
- using retrieved external content in a trusted workflow

The gate should answer:

- Is the operator allowed to request this?
- Is the assistant allowed to execute this?
- Is this action inside the approved workspace, domain, system, matter, or project?
- Does this require human approval?
- Does the current trust state permit execution?
- Should the action fail closed?

### 2. Policy-Aware Workflows

Regulated workflows need visible policy boundaries, not hidden prompt conventions.

Product examples:

- "External client communication requires review."
- "Cloud IAM changes require approval."
- "Legal matter files cannot be mixed across clients."
- "Government records exports require an evidence pack."
- "Critical infrastructure actions require change-ticket binding."
- "High-risk security remediation requires explicit operator confirmation."

The policy model should feel operational:

- approachable enough for a user or admin to understand
- strict enough to be enforceable
- auditable enough for compliance review

### 3. Human Accountability Binding

The system should distinguish between:

- the requester
- the approving operator
- the assistant or automation that proposed the action
- the tool or system that executed the action
- the external recipient or affected system

This matters because regulated environments often tolerate automation only when accountability remains clear.

The product should avoid vague claims like "the AI approved it." The stronger story is:

> Guardian records the user request, the policy gate, the approval decision, the execution result, and the evidence trail as separate accountable events.

### 4. Evidence Packs

For regulated work, logs are not enough. Operators need explainable evidence bundles.

An evidence pack should be a human-readable and machine-verifiable record of a sensitive action or workflow.

Useful contents:

- original request
- routed intent or workflow category
- relevant policy checks
- risk classification
- required approvals
- approval decision and approver identity
- tool inputs and outputs
- affected files, systems, recipients, or records
- trust state of external sources used
- timestamps
- redaction summary
- final outcome
- hash or integrity metadata

The product value is not "we have logs." The product value is:

> The organization can reconstruct why an action happened, what controls applied, and what evidence supports the decision.

### 5. Fail-Closed Defaults For High-Risk Paths

For regulated sectors, the system should block action when it cannot establish enough authority or context.

Examples:

- unknown workspace
- missing approval
- expired approval
- unresolved identity
- untrusted tool server
- degraded sandbox for a high-risk tool
- destination outside allowed domains
- suspicious external content
- insufficient evidence for a regulated communication

This should be framed carefully. Guardian should not claim impossible guarantees such as "zero leakage" or "perfect compliance." The defensible claim is:

> High-risk paths fail closed when required controls are unavailable.

### 6. Shadow Mode And Control Gap Discovery

Before enforcing policy, organizations may want to observe where risky actions would have been blocked.

A shadow mode concept could:

- inspect requested actions
- classify risk
- show which policies would apply
- identify missing approvals
- generate evidence previews
- surface recurring control gaps
- avoid blocking during initial assessment

This is useful for finance, government, legal, and defence because adoption often starts with risk discovery before enforcement.

The output should be practical:

- "Top action categories needing approval."
- "Most common missing evidence."
- "External destinations outside policy."
- "Automations that would fail under strict mode."
- "Teams or workflows with repeated exceptions."

### 7. Regulated Communication Preflight

Guardian could eventually support a general preflight model for sensitive communications.

This is broader than outbound sales or marketing. It includes:

- client emails
- government correspondence
- legal matter communications
- incident notifications
- procurement messages
- security advisories
- executive briefs

Preflight should check:

- recipient and domain
- matter or project binding
- confidentiality markings
- required disclaimers or review status
- sensitive data leakage
- citation/source support
- approval status
- policy conflicts

The concept is especially relevant where the cost of an incorrect message is high.

### 8. Source Trust And Citation Control

Regulated decisions often fail because evidence is weak, stale, or untraceable.

Guardian should make source trust visible in regulated workflows:

- user-provided material
- internal records
- external web results
- tool output
- memory entries
- generated summaries
- unverified model claims

Useful product behavior:

- separate trusted records from low-trust material
- require citations for research-backed outputs
- quarantine suspicious or untrusted tool output
- prevent low-trust content from silently becoming authority
- show what source material influenced a recommendation

This is already aligned with Guardian's existing trust-aware architecture.

## Guardian Fit

Guardian already has the substrate for Regulated Action Assurance. The remaining work is primarily productization, sector language, operator-facing policy presets, and evidence packaging.

| Capability theme | Guardian today | Productization direction |
|---|---|---|
| Tool approvals | Implemented core behavior | Present as pre-execution action gates |
| Runtime policy | Implemented core behavior | Make sector policies visible and configurable |
| Audit logging | Implemented core behavior | Elevate selected records into evidence packs |
| Hash-chained persistence | Implemented core behavior | Use for integrity metadata in evidence bundles |
| Brokered worker isolation | Implemented core behavior | Explain as a containment boundary for AI planning |
| Output Guardian | Implemented core behavior | Position as source/output trust control |
| Automations | Implemented core behavior | Add regulated workflow review and run evidence language |
| Code workspace | Implemented core behavior | Package for controlled engineering and change workflows |
| Cloud/network/security tools | Partial to strong capability base | Package for infrastructure and incident operations |
| Identity and approval continuity | Implemented core behavior | Bind actions to accountable operators in the product story |
| Sector-specific rule libraries | Productization gap | Needed for defence/government/finance/legal packaging |
| Formal compliance reports | Validation gap | Needed before making certification-style claims |
| External validation | Validation gap | Useful later, but should not be implied early |

## Proposed Product Shape

### Name

Recommended product/module name:

**Guardian Regulated Action Assurance**

Alternative names:

- Guardian Assurance Plane
- Guardian Control Gate
- Guardian Evidence & Action Control
- Guardian Regulated Operations Layer
- Guardian Compliance-Aware Execution

Best current choice:

**Guardian Regulated Action Assurance** because it says what matters without overclaiming certification or guaranteed compliance.

### Positioning Statement

Guardian Regulated Action Assurance names Guardian's pre-execution controls, approval binding, and audit-ready evidence model for AI-assisted operational work in regulated environments.

### Short Description

Use AI for sensitive work without reducing accountability. Guardian checks actions before execution, enforces policy and approval boundaries, and records evidence for review.

### Longer Description

Guardian Regulated Action Assurance is a proposed product framing for organizations that need AI assistance inside controlled operational environments. It focuses on sensitive action governance: what the assistant is allowed to do, when human approval is required, when execution must fail closed, and what evidence is preserved after the action completes.

It is aimed at defence, government, finance, legal, insurance, and critical infrastructure teams that want the productivity benefits of AI without relying on informal prompt rules, post-hoc monitoring, or unreviewable automation.

## Example Use Cases

### Defence Procurement Review

An operator asks Guardian to summarize vendor responses and prepare a recommendation. Guardian separates source documents from generated analysis, marks unsupported claims, requires citations, and creates an evidence pack for the final recommendation.

### Government Correspondence Control

A team drafts a response to a citizen, agency, or ministerial office. Guardian checks recipient context, sensitive data, source support, required review status, and approval before the message can be sent.

### Finance Customer Communication

An operator asks Guardian to prepare a customer-facing explanation. Guardian preflights the message for prohibited advice, missing source support, sensitive-data leakage, required disclaimers, and approval status.

### Legal Matter Boundary

A lawyer asks Guardian to research and draft a client note. Guardian keeps matter context separate, flags low-trust sources, requires citations, and prevents material from another matter being used without explicit review.

### Critical Infrastructure Change Review

An engineer asks Guardian to run diagnostics and prepare a remediation. Guardian can distinguish read-only diagnostics from mutating actions, require change-ticket binding for risky changes, and record evidence of the approval and execution result.

### Security Incident Response

A security operator asks Guardian to triage alerts and propose containment steps. Guardian can support investigation and drafting while gating disruptive actions behind policy, approval, and evidence requirements.

## What This Should Not Claim

Guardian should avoid claims that would require independent audit, legal review, or hard benchmark evidence.

Avoid:

- "zero compliance leakage"
- "fully compliant with APRA/CMMC/IRAP/SOC 2/ISO 27001"
- "regulator approved"
- "guaranteed lawful execution"
- "patented enforcement"
- "sub-100ms enterprise enforcement" unless benchmarked
- "replacement for legal or compliance review"

Prefer:

- "designed for regulated workflows"
- "supports pre-execution control"
- "approval-gated sensitive actions"
- "audit-ready evidence records"
- "fail-closed behavior for configured high-risk paths"
- "trust-aware source and output handling"
- "helps preserve accountability around AI-assisted operations"

## Recommended Productization Tracks

### Track 1: Regulated Workflow Catalog

Package common workflow templates by sector:

- government correspondence
- legal matter research and drafting
- finance customer communication
- cloud change review
- security incident response
- procurement evaluation
- sensitive document summarization

Each workflow should describe:

- actor roles
- allowed actions
- approval points
- evidence requirements
- output review expectations
- failure conditions

### Track 2: Evidence Pack Product Model

Create a product-level definition for evidence packs over Guardian's existing audit and execution records.

Questions to answer:

- What events belong in a pack?
- What is visible to an operator?
- What is exportable?
- What should be redacted?
- What integrity metadata is included?
- How are source citations represented?
- How are approvals represented?

This can be specified before implementation.

### Track 3: Assurance Policy Language

Create a user-facing policy model for regulated actions that maps cleanly onto Guardian's existing policy and approval controls.

The policy language should be understandable by administrators:

- "Require approval before sending external email."
- "Block cloud IAM changes unless linked to a change ticket."
- "Require citations for legal research outputs."
- "Quarantine low-trust external content from matter files."
- "Disallow package installs in restricted workspaces."

The policy model should not expose internal runtime terms unless necessary.

### Track 4: Shadow Mode Assessment

Define a non-blocking assessment mode for regulated teams using Guardian's existing action classification, policy, and audit concepts.

Outputs:

- control-gap report
- would-block action summary
- approval burden estimate
- recurring exception list
- missing evidence list
- suggested policy templates

This could become a strong adoption path because it gives value before enforcement.

### Track 5: Sector Readiness Packs

Create packaging by sector without claiming certification:

- Defence Readiness Pack
- Government Records Pack
- Finance Operations Pack
- Legal Matter Assurance Pack
- Critical Infrastructure Change Pack

Each pack would include:

- workflow templates
- recommended policies
- evidence-pack profiles
- review checklists
- operator guidance
- sample exports

### Track 6: External Validation Path

If the product packaging proves useful, pursue external validation in stages:

1. internal control design note
2. third-party architecture review
3. customer pilot evidence review
4. sector-specific compliance mapping
5. formal certification or attestation only where appropriate

This avoids overclaiming early while leaving room for enterprise procurement later.

## Open Questions

- Which sector is the best first wedge: legal, finance, government, defence, or critical infrastructure?
- Should this be packaged as an enterprise module, a set of workflow templates, or a broader product positioning layer over existing Guardian controls?
- What evidence export format would buyers actually trust: PDF, JSON, signed bundle, markdown dossier, or all of the above?
- Which workflows require hard blocking versus approval-only friction?
- How much policy editing should be exposed to non-technical administrators?
- What external validation would be most commercially useful without implying certification too early?

## Recommendation

Pursue this as a product-positioning and design track first. Engineering should follow only where the packaging exercise reveals concrete gaps in Guardian's existing control plane, evidence model, or operator surfaces.

The immediate next artifact should be a more detailed **Regulated Action Assurance Product Brief** covering:

- target buyer
- first sector wedge
- user stories
- evidence-pack examples
- policy examples
- trust and approval language
- non-claims and legal-safe wording

Guardian already has the runtime substance to support this direction credibly. The market-facing concept needs careful language so it explains what Guardian already does without pretending to be certified compliance magic. The strongest version is:

**AI-assisted operations with enforceable action gates, human accountability, and defensible evidence.**
