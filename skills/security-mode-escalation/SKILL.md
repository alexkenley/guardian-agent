# Security Mode Escalation

Use this when the job is to decide whether the system should remain in `monitor` or move to `guarded`, `lockdown`, or `ir_assist`.

## Workflow

1. Start with `security_posture_status`.
2. Follow with `security_containment_status` when the user needs the effective bounded-response state, not just the recommendation.
3. Explain the decision in terms of:
   - alert confidence
   - blast radius
   - reversibility
   - user impact
4. Keep `monitor` as the default unless current evidence justifies more control.

## Escalation Discipline

- Prefer advising escalation before enforcing it when the mode is currently `monitor`.
- `guarded` is the normal next step for credible but still bounded risk.
- `lockdown` and `ir_assist` should be framed as higher-friction states and justified explicitly.
- If policy allows temporary automatic escalation, describe it as temporary and bounded.

## Boundaries

- Use `security-triage`, `host-firewall-defense`, or `native-av-management` to interpret the underlying evidence.
- Use `security-response-automation` when the user wants this posture logic turned into repeatable automation.

## Gotchas

- Do not recommend `lockdown` from one weak or noisy signal.
- Do not describe a recommendation as an enforced state unless `security_containment_status` shows it is effective now.
- Do not conflate deployment profile (`personal`, `home`, `organization`) with operating mode (`monitor`, `guarded`, `lockdown`, `ir_assist`).

Use `templates/mode-decision.md` when you need a short, repeatable containment recommendation format.
