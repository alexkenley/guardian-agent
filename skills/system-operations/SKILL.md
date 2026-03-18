# System Operations

Use this when the user is troubleshooting the local machine, checking service health, or reviewing host and gateway monitoring state.

## Workflow

1. Start with the lightest summary that answers the question.
   - `sys_info` for OS and platform facts
   - `sys_resources` for CPU, memory, and disk pressure
   - `host_monitor_status` for current host monitoring posture
   - `gateway_firewall_status` for gateway firewall posture
2. Drill down only where needed.
   - `sys_processes` for resource-heavy or suspicious processes
   - `sys_services` for service state and obvious failures
   - `host_monitor_check` or `gateway_firewall_check` for a fresh posture check
3. Report symptoms first, then likely cause.
   - what is healthy
   - what is degraded
   - what needs deeper investigation

## Task Patterns

- "My computer is slow" -> `sys_resources`, then `sys_processes`
- "Is service X healthy?" -> `sys_services`
- "What changed in host posture?" -> `host_monitor_status` or `host_monitor_check`
- "Is the gateway firewall okay?" -> `gateway_firewall_status` or `gateway_firewall_check`

## Boundaries

- Use `network-recon` for host, subnet, DNS, or port diagnostics.
- Use `security-triage` when the findings look security-relevant rather than purely operational.
- Use `automation-builder` for recurring health checks.

## Gotchas

- Do not jump to root cause before establishing the current symptoms with host data.
- Do not switch to network or security tooling when host-level tools already answer the question.
- Do not treat a stale monitoring snapshot as current state if a fresh check is cheap and relevant.
