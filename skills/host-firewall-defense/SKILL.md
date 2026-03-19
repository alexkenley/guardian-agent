# Host And Firewall Defense

Use this when the question is specifically about GuardianAgent host-monitor alerts, sensitive path drift, new external destinations, host firewall posture, or gateway firewall findings.

## Workflow

1. Start with the narrowest security view that answers the question.
   - `security_alert_search` with `source: "host"` or `source: "gateway"` when the user is asking about active alerts.
   - `host_monitor_status` or `gateway_firewall_status` when they want posture plus counts.
2. Refresh only when stale state is the problem.
   - `host_monitor_check`
   - `gateway_firewall_check`
3. Separate:
   - confirmed drift or suspicious activity
   - baseline-relative noise
   - alert-hygiene candidates
4. If the finding is repetitive but expected, use the alert lifecycle tools with a reason and a time bound.

## Interpretation Rules

- `sensitive_path_change` means the fingerprint changed, not that compromise is confirmed.
- `new_external_destination` means GuardianAgent observed a previously unseen outbound address, not that the address is malicious.
- Treat host and gateway firewall disablement or rule drift as higher-confidence control degradation than a single medium host anomaly.

## Boundaries

- Use `native-av-management` for Windows Defender, Malwarebytes coexistence, scans, signatures, and Controlled Folder Access.
- Use `network-recon` for deeper network diagnostics beyond the alert queue itself.
- Use `security-triage` when the work has become a broader incident review rather than focused host or firewall interpretation.
- Use `security-alert-hygiene` when the primary task is acknowledge/resolve/suppress workflow rather than technical interpretation.

## Gotchas

- Do not treat GuardianAgent's own state churn as proof of tampering without corroborating evidence.
- Do not call normal SaaS traffic malicious just because the destination is new to the local baseline.
- Do not suppress broad classes of alerts without narrowing by source, evidence pattern, and time window.

Read [references/noise-patterns.md](./references/noise-patterns.md) when repeated host alerts might be benign churn rather than meaningful drift.
