# Related Test Scripts

The executable verification scripts remain in [scripts/](/mnt/s/Development/GuardianAgent/scripts) so they can be run directly. This index groups the ones used for the current security verification and the adjacent brokered/approval paths they depend on.

## Primary Script

- [test-security-verification.mjs](/mnt/s/Development/GuardianAgent/scripts/test-security-verification.mjs)
  Purpose: end-to-end security verification harness covering prompt injection, output redaction, SSRF, denied paths, approval gating, strict sandbox state, fake event sources, shell argument injection, and capability denial.

## Supporting Security And Approval Harnesses

- [test-web-approvals.mjs](/mnt/s/Development/GuardianAgent/scripts/test-web-approvals.mjs)
  Purpose: web approval continuation path and approval UX regression checks.

- [test-cli-approvals.mjs](/mnt/s/Development/GuardianAgent/scripts/test-cli-approvals.mjs)
  Purpose: CLI approval flow regression checks.

- [test-telegram-approvals.mjs](/mnt/s/Development/GuardianAgent/scripts/test-telegram-approvals.mjs)
  Purpose: Telegram approval flow regression checks.

## Supporting Brokered Runtime Harnesses

- [test-brokered-isolation.mjs](/mnt/s/Development/GuardianAgent/scripts/test-brokered-isolation.mjs)
  Purpose: end-to-end brokered worker execution check through the web/API surface.

- [test-brokered-worker-smoke.mjs](/mnt/s/Development/GuardianAgent/scripts/test-brokered-worker-smoke.mjs)
  Purpose: focused worker bootstrap smoke test.

## Re-run Commands

```bash
npm run build
node scripts/test-security-verification.mjs
node scripts/test-brokered-isolation.mjs
```
