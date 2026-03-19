# Host Alert Noise Patterns

Use this reference when host-monitor output is noisy and you need to decide whether to investigate, acknowledge, resolve, or suppress.

## Common Benign Churn

- `sensitive_path_change` on `{HOME}/.guardianagent`
  - GuardianAgent writes logs, approvals, memory state, monitoring state, and other local runtime data under its own home directory.
  - Treat this as suspicious only when the path, owner, cadence, or companion alerts look unusual.
- `new_external_destination`
  - This alert is baseline-relative. It often fires on first contact with normal providers such as source control, package registries, search, LLM, cloud, or identity services.
  - Escalate only when it is coupled with suspicious processes, persistence drift, odd ports, or clear exfiltration patterns.

## Good Operator Defaults

- Prefer `acknowledge` when an alert is understood but still worth leaving visible.
- Prefer `resolve` when investigation is complete and the condition is closed.
- Prefer `suppress` only for repetitive expected noise, and always include:
  - a reason
  - a source hint when possible
  - an expiry time

## Red Flags That Should Override Benign Assumptions

- The same host alert appears with persistence changes, firewall disablement, or native AV detections.
- A sensitive-path change touches credentials, SSH material, cloud configs, or startup locations instead of only GuardianAgent state.
- New outbound destinations cluster around rare geography, suspicious hosting, or sudden high-volume transfer patterns.
