# Security Test Results

Date: 2026-03-12

## Commands Run

```bash
npm run build
node scripts/test-security-verification.mjs
```

## Result Summary

- Build: passed
- Security verification harness: passed
- Harness result: `11/11 passed`

## Verified Checks

- unauthenticated status requests are rejected
- prompt injection is blocked before model execution
- model output secrets are redacted
- SSRF blocks private and obfuscated URL forms
- denied-path and traversal reads are blocked
- approval-gated writes do not execute before approval
- strict sandbox state is surfaced through the tools API
- audit chain verifies and config responses redact secrets
- fake event source IDs are blocked
- shell control-operator injection is rejected
- capability escalation without the required grant is denied

## Host-Specific Observation

The harness ran on Linux with sandbox availability reported as `degraded` and backend `ulimit` while `assistant.tools.sandbox.enforcementMode` remained `strict`.

Observed runtime behavior on this host:

- risky subprocess-backed tools were removed or disabled from the public tool surface
- strict-sandbox downgrade state was surfaced through the tools API
- brokered execution remained active

This run validates degraded-host behavior. It does not constitute proof of a `strong` sandbox backend such as Linux `bwrap` or the Windows native helper.

## Primary Artifacts

- [SECURITY-CLAIM-MATRIX.md](SECURITY-CLAIM-MATRIX.md)
- [RELATED-TEST-SCRIPTS.md](RELATED-TEST-SCRIPTS.md)
- [test-security-verification.mjs](../../scripts/test-security-verification.mjs)
