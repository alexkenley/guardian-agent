# Network Reconnaissance

When the user asks to scan, discover, or diagnose network hosts and services:

## Scoping

- Confirm the target scope before scanning: single host, subnet, or interface.
- Never expand scope beyond what was requested. A request to scan one host is not permission to sweep the subnet.
- Prefer the narrowest tool for the job: `net_ping` before `net_arp_scan`, single-port check before a range sweep.

## Workflow

1. Start with passive or low-impact tools: `net_interfaces`, `net_connections`, `net_dns_lookup`.
2. Move to active probing only when needed: `net_ping`, `net_port_check`, `net_arp_scan`.
3. Use `net_fingerprint` and `net_banner_grab` for targeted host identification, not broad sweeps.
4. For wifi tasks, summarize visible networks before enumerating clients.

## Baselines and Anomalies

- When establishing a baseline (`net_baseline`), explain what is being captured and why.
- Present anomaly check results as observations, not conclusions. Flag deviations and let the user assess severity.
- Cross-reference unknown MACs with `net_oui_lookup` and classify devices with `net_classify` before raising alerts.

## Reporting

- Summarize results in a structured format: host, open ports, services, OS guess, notes.
- Separate confirmed facts from inferences.
- Recommend next steps when findings warrant deeper investigation.

## Gotchas

- Do not expand the scan scope beyond the user’s explicit target.
- Do not jump from anomaly output to incident conclusions without corroborating evidence.
- Do not start with the noisiest or highest-impact probe when a narrow check can answer the question.
