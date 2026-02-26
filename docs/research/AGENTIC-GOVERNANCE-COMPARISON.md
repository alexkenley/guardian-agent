# Agentic Governance Cookbook vs GuardianAgent

## Overview
The [OpenAI Agentic Governance Cookbook](https://cookbook.openai.com/examples/partners/agentic_governance_guide/agentic_governance_cookbook) provides a blueprint for making AI agents production-ready by using automated, code-based governance. This document compares its key concepts with GuardianAgent's architecture and outlines the uplift implementation.

## 1. Policy as Code & Centralized Policy Package
**Cookbook Concept:** Define governance rules in version-controlled JSON/Python configs and package them as reusable libraries.
**GuardianAgent Implementation:** GuardianAgent natively implements "Policy as Code." Our configuration object defines what controllers run, what paths are denied, what rate limits apply, and what secret patterns to scan for. The `capabilities.ts` and `secret-scanner.ts` files act as our centralized policy enforcement engine.
**Uplift:** No structural change needed, but we enhanced `secret-scanner.ts` to include PII patterns (Emails, SSNs, Credit Cards) alongside API keys, expanding our policy coverage to data privacy.

## 2. Guardrails Stages (Pre-flight, Input, Output)
**Cookbook Concept:** Run checks at three stages: Pre-flight (raw input), Input (before LLM), and Output (after LLM). Available guardrails include PII Detection, Jailbreaks, Moderation, and Hallucination detection.
**GuardianAgent Implementation:** We strictly enforce a three-layer defense:
- **Layer 1 (Pre-flight/Input):** `InputSanitizer`, `RateLimiter`, `CapabilityController`, `SecretScanController`, `DeniedPathController`.
- **Layer 2 (Output):** `OutputGuardian` redacts or blocks outputs containing secrets/PII.
- **Layer 3 (Retrospective):** `SentinelAgent` for anomaly detection.
**Uplift:** Added PII Detection to our `SecretScanner` so that Layer 1 (Input) and Layer 2 (Output) automatically detect and redact PII, aligning with the cookbook's recommendation for robust data protection.

## 3. Triage / Concierge Pattern
**Cookbook Concept:** A "front-door" agent receives all queries, checks against policy, and uses handoffs to route them to domain-specific specialists.
**GuardianAgent Implementation:** We currently utilize an `AssistantOrchestrator` to queue and dispatch tasks, but messages are explicitly routed to known agents (`agentId`). 
**Future Uplift Consideration:** Implementing a specialized `TriageAgent` that intercepts generic messages (e.g., from Web or Telegram) and uses an LLM to select the appropriate specialized agent via the `EventBus`.

## 4. Zero Data Retention (ZDR) and Eval-Driven Tuning
**Cookbook Concept:** Intercept traces to redact PII before sending logs to observability platforms. Use red-teaming to tune guardrails.
**GuardianAgent Implementation:** 
- **ZDR:** GuardianAgent's `AuditLog` and `OutputGuardian` intercept payloads. With the addition of PII regexes to `secret-scanner.ts`, PII will now be redacted from both LLM outputs *and* internal event payloads, achieving ZDR compliance natively.
- **Eval-Driven Tuning:** Our `integration.test.ts` acts as a red-team evaluation suite, ensuring that the guardrails trigger appropriately without causing false positives on benign requests.

## Summary of Uplifts Performed
1. **PII Detection added to Secret Scanner:** Updated `src/guardian/secret-scanner.ts` to include robust Regular Expressions for Email Addresses, US Social Security Numbers, Credit Cards, and Phone Numbers. This directly satisfies the ZDR and Output Guardrails requirements mentioned in the cookbook.
