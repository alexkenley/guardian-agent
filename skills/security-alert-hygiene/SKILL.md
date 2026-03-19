# Security Alert Hygiene

Use this when the main job is to manage alert state cleanly: acknowledge, resolve, suppress, or reduce duplicate noise.

## Workflow

1. Search first with `security_alert_search`.
2. Narrow by source, type, and evidence pattern before mutating state.
3. Choose the correct disposition:
   - `security_alert_ack` for understood alerts that should remain visible
   - `security_alert_resolve` for investigated alerts that are closed
   - `security_alert_suppress` for expected repetitive noise with an expiry
4. Always record the operator reason when resolving or suppressing.

## Decision Rules

- Use acknowledge when the alert is real and still relevant.
- Use resolve when the condition has been investigated and closed.
- Use suppress when the alert is expected to recur and would otherwise overwhelm the queue.
- Prefer suppressing one narrow pattern over broad source-wide suppression.

## Boundaries

- Use `host-firewall-defense` or `native-av-management` if the first problem is understanding whether the alert is meaningful.
- Use `security-triage` if multiple alert families suggest a broader incident.

## Gotchas

- Do not suppress without an expiry unless there is a compelling operational reason.
- Do not resolve an alert just because it is noisy.
- Do not mutate alert state from a vague natural-language description when the exact alert id or narrow pattern can be found first.
