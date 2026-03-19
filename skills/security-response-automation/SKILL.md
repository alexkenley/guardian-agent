# Security Response Automation

Use this when the user wants repeatable defensive behavior instead of one-off triage.

## Workflow

1. Check existing automation first.
   - `workflow_list`
   - `task_list`
2. Keep the security workflow narrow.
   - one detection family
   - one response objective
   - one clear operator outcome
3. Prefer read-only evidence collection before containment or mutation.
4. Use `workflow_run` with `dryRun: true` when the plan is complex or risky.

## Design Rules

- Periodic defensive checks fit normal `task_create` / `task_update` cron scheduling.
- Security workflows should gather evidence first, then summarize, then recommend or trigger bounded action.
- Use existing host, gateway, posture, containment, and native AV tools instead of recreating their logic in free-form steps.
- If the current surface only exposes cron scheduling, be explicit about that limitation instead of pretending alert-driven triggers are available everywhere.

## Current Surface Boundaries

- The runtime supports event-triggered scheduled tasks, but the general tool-layer authoring flow is still mainly cron-oriented.
- Prefer existing built-in presets or dashboard/API surfaces for event-triggered security presets when the active channel does not expose event-trigger authoring directly.
- Use `automation-builder` for general-purpose workflow mechanics. Use this skill for the security semantics: evidence-first, bounded response, and safe escalation.

## Gotchas

- Do not default a monitoring workflow to mutating response.
- Do not combine unrelated detections into one oversized security playbook.
- Do not skip dry-run or verification on a workflow that could page, isolate, or otherwise change operator state.

Use `templates/response-automation-spec.md` when the user wants a reviewable design before saving the workflow.
