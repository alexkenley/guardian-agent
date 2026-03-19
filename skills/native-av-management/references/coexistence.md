# Native AV Coexistence

GuardianAgent distinguishes two broad native AV states on Windows:

- Defender is available and queryable
- Defender is inactive because another antivirus is registered

## How To Read The Current Provider State

- `inactiveReason: "third_party_antivirus"`
  - GuardianAgent detected a Defender-service-disabled style failure and confirmed another AV provider through Windows Security Center.
  - This should be explained as inactive coexistence, not as a generic host warning.
- `inactiveReason: "query_failed"`
  - GuardianAgent could not query the native provider and did not confirm a third-party AV explanation.
  - Treat this as an actual provider-health issue.

## Practical Operator Guidance

- If Malwarebytes or another AV is still registered as the primary provider, Defender may remain inactive even if the UI appears closed.
- Disabling or uninstalling the third-party AV, and sometimes rebooting, may be required before Defender becomes active again.
- When the user wants GuardianAgent to treat Defender as the native protection base, confirm the third-party AV is no longer registered before recommending Defender actions.
