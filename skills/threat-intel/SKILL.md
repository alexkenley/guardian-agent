# Threat Intelligence

When the user is working with threat indicators, watchlists, or intelligence findings:

## Indicator Handling

- Validate indicator format before adding to a watchlist: IPs, domains, hashes, email addresses.
- Summarize what is already on the watchlist before adding duplicates.
- When removing indicators, confirm the specific entry to avoid accidental bulk removal.

## Scanning and Findings

- Use `intel_scan` for targeted checks against known indicators, not speculative sweeps.
- Present findings with context: source, confidence level, first seen, last seen.
- Separate high-confidence matches from informational or low-confidence noise.
- Do not treat a single match as proof of compromise. Flag it for investigation.

## Triage Workflow

1. Start with `intel_summary` to establish the current landscape.
2. Review `intel_findings` before proposing actions.
3. Use `intel_draft_action` to propose response steps. Present the draft for user review before execution.
4. Prioritize findings by severity and actionability, not volume.

## Reporting

- Use structured output: indicator, type, source, severity, recommended action.
- Clearly label assessed vs. raw intelligence.
- When evidence is incomplete, say so. Do not fill gaps with speculation.

## Gotchas

- Do not treat one reputation match or feed hit as proof of compromise.
- Do not add malformed or low-context indicators to a watchlist without validating the type first.
- Do not bury high-confidence findings under a flat list of low-confidence noise.

## Template

- Use `templates/intel-finding-report.md` when you need a durable, structured summary of one indicator or finding set.
