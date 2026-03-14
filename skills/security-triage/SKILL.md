# Security Triage

Use this when the user is reviewing a security alert, posture change, suspicious network behavior, firewall issue, or combined monitoring output.

## Workflow

1. Start with a short statement of what triggered triage.
2. Separate:
   - confirmed facts
   - likely inferences
   - open questions
3. Build a timeline when the order of events matters.
4. Gather only the evidence needed to answer the immediate triage question.
5. Recommend next steps in priority order.

## Tooling Guidance

- Use the narrowest relevant tool set.
- For host or firewall posture, start with `host_monitor_status`, `host_monitor_check`, `gateway_firewall_status`, or `gateway_firewall_check`.
- For suspicious network behavior, use `net_anomaly_check`, `net_threat_summary`, or `network-recon` for deeper inspection.
- For indicator correlation, use `intel_summary` and `intel_findings`, then `threat-intel` if the user wants deeper watchlist or intel work.
- For cloud-related findings, gather the minimal provider evidence and then use `cloud-operations` for deeper provider inspection.

## Reporting

- Prefer chronological and evidence-based summaries.
- Clearly label severity, affected asset or surface, evidence, and recommended next action.
- Avoid speculative conclusions when evidence is incomplete.
