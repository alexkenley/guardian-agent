# Security Claim Verification Matrix

This matrix tracks the highest-value security claims from [SECURITY.md](/mnt/s/Development/GuardianAgent/SECURITY.md) against:

- implementation files
- existing unit/integration tests
- runtime proof through the automated verification harness

Primary runtime harness:

```bash
node scripts/test-security-verification.mjs
```

## Claim Matrix

| Claim | Implementation | Existing Test Coverage | Runtime Proof |
|------|----------------|------------------------|---------------|
| Prompt injection payloads are blocked before agent execution | `src/guardian/input-sanitizer.ts`, `src/guardian/guardian.ts`, `src/runtime/runtime.ts` | `src/guardian/input-sanitizer.test.ts`, `src/guardian/guardian.test.ts`, `src/runtime/runtime.test.ts`, `src/integration.test.ts` | `scripts/test-security-verification.mjs` sends a prompt-injection payload through `POST /api/message` and verifies a blocked response plus `action_denied` audit evidence |
| Remote web content is normalized and tainted before follow-up planning | `src/tools/executor.ts`, `src/guardian/input-sanitizer.ts`, `src/index.ts`, `src/worker/worker-llm-loop.ts`, `src/util/tainted-content.ts` | `src/tools/executor.test.ts`, `src/guardian/input-sanitizer.test.ts`, `src/guardian/output-guardian.test.ts`, `src/util/tainted-content.test.ts` | `scripts/test-contextual-security-uplifts.mjs` verifies tainted-content tool gating end to end; DOM normalization and fragmented-signal detection are covered by unit tests |
| Secret exfiltration through model output is redacted | `src/guardian/output-guardian.ts`, `src/runtime/runtime.ts`, `src/worker/worker-session.ts` | `src/guardian/output-guardian.test.ts`, `src/integration.test.ts` | `scripts/test-security-verification.mjs` runs the app against a mock LLM that emits an AWS key and verifies the HTTP response is redacted and the audit log records secret detection |
| SSRF protection blocks localhost/private and obfuscated forms | `src/guardian/ssrf-protection.ts`, `src/tools/browser-session.ts`, `src/tools/executor.ts` | `src/guardian/ssrf-protection.test.ts`, `src/tools/executor.test.ts`, `src/tools/browser-session.test.ts` | `scripts/test-security-verification.mjs` exercises `web_fetch` against decimal, hex, octal, loopback, and metadata endpoint URLs through `POST /api/tools/run` |
| Denied-path and traversal reads are blocked | `src/guardian/guardian.ts`, `src/tools/executor.ts`, `src/guardian/secret-scanner.ts` | `src/guardian/guardian.test.ts`, `src/tools/executor.test.ts`, `src/integration.test.ts` | `scripts/test-security-verification.mjs` attempts `.env` reads inside an allowlisted root and path traversal outside the root through `POST /api/tools/run` |
| Agent cannot self-modify config or control plane | `src/guardian/secret-scanner.ts` (`.guardianagent/` denied pattern), `src/guardian/security-baseline.ts` (enforced minimum), `src/guardian/control-plane-integrity.ts` (HMAC signing), `src/tools/executor.ts` (path allowlist) | `src/guardian/guardian.test.ts` (DeniedPathController blocks `.guardianagent/`), `src/guardian/security-baseline.test.ts` | `.guardianagent/` is hard-denied at the admission layer; config is HMAC-signed; process restart requires privileged ticket; shell is allowlisted. Even with user-approved path widening, the denied-path pattern prevents filesystem tool access to the data directory |
| Shell argument injection is rejected | `src/guardian/shell-validator.ts`, `src/guardian/argument-sanitizer.ts`, `src/tools/executor.ts` | `src/guardian/shell-validator.test.ts`, `src/tools/executor.test.ts` | `scripts/test-security-verification.mjs` verifies `sanitizeShellArgs()` rejects control operators and also verifies strict-sandbox runtime blocking of public shell access on degraded hosts |
| Event spoofing and fake source IDs are blocked | `src/runtime/runtime.ts`, `src/queue/event-bus.ts`, `src/agent/types.ts` | `src/queue/event-bus.test.ts`, `src/runtime/runtime.test.ts`, `src/integration.test.ts` | `scripts/test-security-verification.mjs` runs an internal invariant check against built runtime modules and verifies `Runtime.emit()` rejects an untrusted `sourceAgentId` |
| Capability escalation attempts are denied | `src/guardian/capabilities.ts`, `src/runtime/runtime.ts`, `src/tools/executor.ts` | `src/runtime/runtime.test.ts`, `src/integration.test.ts`, `src/tools/executor.test.ts` | `scripts/test-security-verification.mjs` runs an internal invariant check against the Guardian capability gate and verifies a `write_file` action without `write_files` is denied |
| Strict sandbox mode blocks risky tools when no strong backend exists | `src/sandbox/index.ts`, `src/tools/executor.ts`, `src/runtime/setup.ts`, `src/supervisor/worker-manager.ts` | `src/tools/executor.test.ts`, `src/runtime/setup.test.ts`, `src/sandbox/sandbox.test.ts` | `scripts/test-security-verification.mjs` inspects `GET /api/tools` and verifies strict-mode sandbox state and disabled shell category behavior on the host under test |
| Approval-gated actions do not execute before approval | `src/tools/executor.ts`, `src/tools/approvals.ts`, `src/channels/web.ts`, `src/worker/worker-session.ts` | `src/tools/executor.test.ts`, `src/runtime/pending-approval-copy.test.ts`, `scripts/test-web-approvals.mjs`, `scripts/test-cli-approvals.mjs` | `scripts/test-security-verification.mjs` runs `fs_write` in `approve_by_policy`, verifies a pending approval response, verifies the file does not exist before approval, then approves and verifies the write occurs |

## Notes

- The harness verifies exposed runtime behavior through the web/API surface where that behavior is public.
- Event-source spoofing and capability checks are also verified directly against the built runtime modules because they are internal runtime invariants rather than public HTTP endpoints.
- Strong OS sandbox claims must be interpreted on the actual host where the harness runs. If sandbox availability is `degraded` or `unavailable`, the harness verifies the degraded-path behavior rather than claiming strong isolation.
