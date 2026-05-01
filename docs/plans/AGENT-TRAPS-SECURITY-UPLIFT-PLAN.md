# Agent Traps Security Uplift Plan

**Status:** Published
**Date:** 2026-04-03
**Origins:** implementation review against *AI Agent Traps* (Franklin et al.), [Stream B Security Uplift](../implemented/STREAM-B-SECURITY-UPLIFT.md), [Security Policy](../../SECURITY.md), and the current shipped runtime/spec set
**Companion specs:** [Security Policy](../../SECURITY.md), [Architecture Overview](../architecture/OVERVIEW.md), [Contextual Security Uplift Spec](../design/CONTEXTUAL-SECURITY-UPLIFT-DESIGN.md), [Agentic Defensive Security Suite - As-Built Spec](../design/AGENTIC-DEFENSIVE-SECURITY-SUITE-AS-BUILT.md), [Tools Control Plane Spec](../design/TOOLS-CONTROL-PLANE-DESIGN.md)

## Objective

Close the gap between GuardianAgent's current strong action-time controls and the broader environmental-manipulation threat model described in *AI Agent Traps*.

The target outcome is a runtime that:

1. resists hidden or adaptive hostile content before it can steer planning
2. treats persuasive or weakly sourced evidence as lower-authority than explicit operator intent and verified provenance
3. hardens memory, delegation, and outbound action paths against delayed or indirect compromise
4. reduces human-review fatigue and multi-agent systemic failure modes
5. validates the above with repeatable adversarial harnesses instead of doc-only claims

## Planning Principles

- **Preserve current strengths.** Do not regress the existing Guardian admission pipeline, OutputGuardian trust model, trust-aware memory, principal-bound approvals, or bounded schedule authority.
- **Treat perception and evidence as first-class attack surfaces.** The next uplift is not primarily more approvals; it is stronger ingestion, provenance, and corroboration.
- **Keep shared orchestration shared.** New blocked-work, clarification, approval, and resume behavior must remain in the `IntentGateway` / `PendingActionStore` model rather than forking per tool or per channel.
- **Default conservative on external capability surfaces.** Third-party MCP, browser, remote content, and unmanaged subprocesses should stay risk-heavy by default unless there is hard evidence for narrowing.
- **Prefer enforceable runtime boundaries over prompt-only mitigations.** If a defense can live in code, policy, storage, or sandboxing, put it there first.
- **Ship benchmarks with defenses.** Every new security family in this plan needs at least one black-box harness or adversarial regression suite.

## Current Baseline

| Area | Current state | Notes |
|---|---|---|
| Content injection / hidden instructions | Partial | Text-side taint classification is strong, but render-vs-source diffing, dynamic cloaking detection, and multimodal payload detection remain weak. |
| Semantic manipulation / persuasion | Partial | Action-time controls exist, but explicit defenses for framing bias, authority priming, and provenance-weighted synthesis are limited. |
| Memory / retrieval poisoning | Strong partial | Trust-aware memory and quarantined writes exist; stronger corroboration and poisoning forensics are still needed. |
| Behavioural control / exfiltration | Strong | Guardian approvals, taint-aware tool gating, SSRF protection, capability freezing, and contract-mediated handoffs are already solid. |
| Systemic multi-agent traps | Weak partial | Dispatch limits, handoff validation, and run budgets exist, but congestion, cascade, collusion, fragment, and Sybil defenses are not yet first-class. |
| Human-in-the-loop traps | Partial | Principal-bound approvals and shared pending actions exist, but anti-fatigue, deceptive-summary, and consequence-preview defenses need more work. |

## Stream B Merge Result

The archived Stream B work is **mostly implemented** and should not be reopened as a large standalone stream.

### Implemented from Stream B

- PII scanner and `PiiScanController`
- tool-result secret/PII redaction and prompt-injection scanning via `OutputGuardian.scanToolResult()`
- structured `<tool_result ...>` reinjection envelopes
- argument-size validation and write-content secret/PII scanning
- shell argument sanitization helpers
- MCP startup approval, trust-floor handling, metadata sanitization, and `maxCallsPerMinute`

### Residual Stream B work that remains active

1. **Richer third-party MCP risk inference**
   - Current third-party MCP handling is no longer hardcoded, but it still defaults conservatively to `mutating` unless a stronger signal exists.
   - Remaining work is to design a **verified** narrowing path for genuinely read-only third-party tools without letting untrusted metadata downgrade risk.
2. **Documentation and operator guidance harmonization**
   - Keep MCP trust guidance, PII redaction behavior, and tool-result trust behavior aligned across specs, guides, and operator-facing reference docs.

These residual items are incorporated below instead of tracked as a separate active stream.

### Research note: external coding backend inheritance risk

- April 2026 review of the reported Claude Code long-compound-command deny-rule bypass did **not** find an equivalent fail-open path in Guardian's managed shell validation flow.
- Local stress check against Guardian's validator still denied a disallowed command after more than 50 chained subcommands, so this specific parser-limit failure mode is not currently reproduced in the native managed shell path.
- However, optional external coding backends remain an inherited trust boundary:
  - Guardian controls launch approval, workspace/session binding, audit, and post-run verification expectations
  - the delegated backend CLI still enforces its **own** internal permission, parser, and sandbox model after launch
  - an upstream flaw in a delegated backend can therefore become a Guardian deployment risk when that backend is enabled
- Coding backends are disabled by default today. This should remain the default posture until backend-specific containment and operator-warning controls are stronger.

---

## Phase 1: Perception and Ingestion Defenses

### Goal

Detect hostile content before it can enter planning as apparently ordinary evidence.

### Deliver

- browser/content ingestion scanning that compares:
  - rendered text
  - DOM/source text
  - accessibility/metadata text
  - extracted PDF/Markdown text where applicable
- hidden-content detection for:
  - CSS offscreen or invisible text
  - metadata / aria / alt / comments / low-visibility markup
  - Markdown / LaTeX / PDF masking patterns
- dynamic cloaking detection through bounded multi-fetch comparison:
  - vary fingerprint/profile where safe
  - compare semantic deltas instead of only raw HTML deltas
- initial multimodal trap heuristics:
  - OCR-vs-raw extracted text mismatch detection
  - suspicious image/audio payload flags
  - quarantine/approval escalation instead of over-claiming full steganography detection
- stronger threat reasons in tool-result trust metadata so downstream tooling can explain *why* content was downgraded

### Likely implementation areas

- `src/guardian/output-guardian.ts`
- `src/tools/browser-hybrid.ts`
- `src/tools/builtin/browser-tools.ts`
- `src/search/`
- new `src/guardian/content-ingestion-guardian.ts`
- new browser/content diff helpers under `src/runtime/` or `src/tools/helpers/`

### Exit criteria

- Guardian can flag meaningful source-vs-render mismatches before reinjection
- suspicious hidden instruction patterns produce explicit `taintReasons`
- browser/content fetch flows can compare bounded alternate fetches for cloaking evidence
- PDF/Markdown/LaTeX masking cases have regression tests and harness coverage

---

## Phase 2: Provenance, Corroboration, and Semantic Manipulation Defenses

### Goal

Reduce the power of persuasive, authority-biased, or weakly sourced content to steer synthesis.

### Deliver

- provenance-aware evidence envelopes for remote content
- citation-required synthesis mode for high-stakes factual outputs
- corroboration thresholds before promoting remote facts into stronger trust states
- reasoning-time separation of:
  - user goal
  - retrieved evidence
  - inferred conclusions
  - unsupported claims
- detection signals for:
  - extreme authority framing
  - emotional priming
  - self-referential identity claims about the model or system
- persona-hyperstition guardrails for self/identity claims entering memory or system summaries

### Likely implementation areas

- `src/chat-agent.ts`
- `src/runtime/context-assembly.ts`
- `src/runtime/agent-memory-store.ts`
- `src/runtime/search-intent.ts`
- `src/prompts/`
- `src/util/tainted-content.ts`

### Exit criteria

- high-stakes synthesis paths can surface source-backed claims distinctly from unsupported text
- remote persuasive content cannot silently become high-trust memory or direct action context
- model/self-identity claims from remote content are explicitly downgraded or excluded from durable state

---

## Phase 3: Memory and Retrieval Poisoning Hardening

### Goal

Make delayed compromise through retrieval, memory, and long-horizon context materially harder.

### Deliver

- corroborated promotion flow for quarantined or low-trust memory
- retrieval poisoning forensics:
  - why a document was retrieved
  - which item introduced a poisoned claim
  - where a promoted fact came from
- review tooling for quarantined memory and remote-derived knowledge
- optional trust-decay / revalidation for stale remote-derived memory
- stronger detection of backdoor-like repeated retrieval triggers
- memory write heuristics that distinguish:
  - stable user preferences
  - transient remote claims
  - self-referential or identity-shaping content

### Likely implementation areas

- `src/runtime/agent-memory-store.ts`
- `src/tools/builtin/memory-tools.ts`
- `src/runtime/control-plane/`
- `web/public/`
- new memory provenance helpers under `src/runtime/`

### Exit criteria

- operators can inspect and promote quarantined memory deliberately
- retrieval provenance is visible enough to trace suspicious outputs back to source material
- repeated poisoned retrieval patterns are detectable in tests and harnesses

---

## Phase 4: Action, Exfiltration, Delegation, and Capability Surface Hardening

### Goal

Tighten the remaining routes from hostile context to real-world side effects.

### Deliver

- descendant executable identity enforcement or a stronger equivalent boundary for subprocess trees
- standalone or brokered secrets access path so credentials are not only protected by in-process redaction
- external coding backend hardening:
  - treat delegated backend CLI security as part of the runtime trust boundary, not as a transparent extension of Guardian policy
  - keep external coding backends disabled by default unless explicitly enabled
  - add backend-specific operator warnings, feature kill switches, and incident-response-friendly disable paths
  - support stronger containment where feasible for delegated backend runs, such as tighter sandboxing, reduced credentials, and narrower network posture
- richer outbound approval context:
  - destination
  - data class
  - evidence source
  - why the action is being requested
- stronger delegation rules:
  - external content cannot define new sub-agent roles or system prompts
  - delegation uses trusted recipes/contracts only
  - tighter quotas and audit around spawned work
- residual Stream B MCP work:
  - verified read-only narrowing path for third-party MCP servers
  - keep default conservative when evidence is insufficient
  - avoid metadata-only downgrades of tool risk

### Likely implementation areas

- `src/tools/executor.ts`
- `src/guardian/shell-validator.ts`
- `src/runtime/runtime.ts`
- `src/runtime/handoffs.ts`
- `src/runtime/handoff-policy.ts`
- `src/tools/mcp-client.ts`
- new `src/runtime/secrets-broker.ts`

### Exit criteria

- Guardian no longer relies only on top-level command validation for child-process identity
- delegated coding backends have explicit operator-visible risk posture and can be rapidly disabled or contained when an upstream backend issue appears
- approval surfaces communicate exfiltration and delegation risk clearly
- third-party MCP read-only narrowing requires explicit verified evidence, not just self-described metadata

---

## Phase 5: Human Oversight and Systemic Trap Defenses

### Goal

Reduce the chance that humans or groups of agents become the amplifier for the attack.

### Deliver

- anti-fatigue approval UX and policy:
  - consequence previews
  - suspicious-context markers
  - grouped approvals where safe
  - cooldown or escalation for repetitive risky prompts
- deceptive-summary defenses in blocked-work and approval flows
- orchestration/runtime signals for:
  - congestion-style resource pileups
  - cascade-style repeated cross-agent propagation
  - compositional fragment assembly across agents/turns
  - Sybil-like repeated low-diversity pseudo-sources
- response controls when these patterns are detected:
  - hold for operator
  - downgrade trust
  - block dispatch
  - pause schedules or fan-out

### Likely implementation areas

- `src/runtime/pending-actions.ts`
- `src/runtime/run-timeline.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/assistant-jobs.ts`
- `src/channels/web.ts`
- `web/public/`

### Exit criteria

- approval UX is materially more resistant to fatigue and deceptive summaries
- orchestration can detect and contain basic congestion/cascade/Sybil patterns in test scenarios
- multi-agent fragment reassembly has at least bounded detection and containment hooks

---

## Phase 6: Benchmarks, Harnesses, and Security Regression Gates

### Goal

Turn the threat model into executable regression coverage.

### Deliver

- adversarial suites for each trap family:
  - content injection
  - semantic manipulation
  - memory/retrieval poisoning
  - behavioural control and exfiltration
  - delegation/sub-agent hijack
  - human-review fatigue
  - systemic multi-agent scenarios
- real-model harness lanes where practical
- scorecards that distinguish:
  - detection
  - containment
  - operator clarity
  - unsafe action prevention
- docs and release criteria tying new defenses to concrete tests

### Likely implementation areas

- `scripts/`
- `src/eval/`
- `docs/guides/INTEGRATION-TEST-HARNESS.md`
- `docs/security-testing-results/`

### Exit criteria

- new trap categories have named regression coverage
- major security claims in `SECURITY.md` and specs are backed by repeatable tests
- release validation includes the new harness families, not just unit coverage

---

## Sequencing Recommendation

1. **Phase 1** before broad new capability work.
2. **Phase 2** and **Phase 3** together after Phase 1 lands enough ingestion signals.
3. **Phase 4** in parallel where implementation is boundary-heavy rather than prompt-heavy.
4. **Phase 5** only after the shared signals from earlier phases exist.
5. **Phase 6** continuously, but require at least one harness per phase before calling that phase complete.

## Non-Goals for This Plan

- claiming full steganography or universal jailbreak detection
- replacing the shared `IntentGateway`, pending-action model, or current trust-aware memory model
- weakening conservative defaults for third-party MCP or unmanaged subprocesses in the name of convenience
- treating policy copy or prompt tweaks alone as sufficient mitigation for environmental manipulation

## Immediate Next Work to Schedule

1. Build Phase 1 hidden-content and render-vs-source diffing for browser/web/PDF flows.
2. Define the verified narrowing model for third-party MCP read-only tools and document why current conservative defaults remain until that lands.
3. Add provenance/corroboration rules for remote-derived memory promotion.
4. Add backend-specific warnings and containment controls for external coding CLIs so upstream permission-parser flaws do not silently become Guardian trust assumptions.
5. Design anti-fatigue approval surfaces on top of the shared pending-action model.
6. Create the first paper-aligned adversarial harness pack for content injection, memory poisoning, delegation hijack, and approval fatigue.
