# Native AV Management

Use this when the user is asking about Windows Defender or native host protection rather than generic host-monitor output.

## Workflow

1. Start with `windows_defender_status`.
2. If the state may be stale, use `windows_defender_refresh`.
3. Interpret the result before acting:
   - `available: true` means Defender status is readable and active enough for native checks.
   - `inactiveReason: "third_party_antivirus"` means Defender is not the primary AV because another provider is registered.
   - `inactiveReason: "query_failed"` means the native provider itself could not be queried cleanly.
4. Only request `windows_defender_scan` or `windows_defender_update_signatures` when the user wants an action and policy allows it.

## Interpretation Rules

- A third-party AV such as Malwarebytes can make Defender inactive without that being a security failure.
- Defender detections and control disablement are higher-confidence signals than generic baseline alerts.
- Treat Controlled Folder Access, firewall profile disablement, and stale signatures as host-protection posture findings, not proof of compromise.

## Boundaries

- Use `host-firewall-defense` for `sensitive_path_change`, `new_external_destination`, host monitor posture, and gateway firewall drift.
- Use `security-triage` when Defender findings need full incident review across other telemetry.
- Use `security-alert-hygiene` when the question is primarily about dismissing or suppressing repeated native alerts.

## Gotchas

- Do not call Defender "broken" when the provider explicitly says it is inactive because another AV is primary.
- Do not assume quitting a tray app reactivates Defender; service and registration state matter.
- Do not recommend scans or signature updates as if they were read-only operations.

Read [references/coexistence.md](./references/coexistence.md) when third-party AV coexistence or fallback behavior is the main question.
