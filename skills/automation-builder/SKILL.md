# Automation Builder

Use this when the user wants a recurring check, scheduled task, monitoring workflow, or reusable playbook.

## Workflow

1. Clarify the purpose.
   - What should the automation check or do?
   - What target, tool arguments, and schedule are needed?
   - What output should count as success, failure, or escalation?
2. Check for an existing workflow or task first.
   - Use `workflow_list` and `task_list` to avoid duplicates.
3. Choose the simplest workflow shape.
   - Single-tool workflow for one check or action.
   - Sequential workflow when later steps depend on earlier output.
   - Parallel workflow only when checks are independent.
   - Instruction step only for summarization or prioritization, not for hidden tool execution.
   - Scheduled assistant task when the assistant should wake up, inspect the environment with its normal skills/tools, and report back.
   - Choose one shape unless the user explicitly wants both. Do not create both a scheduled playbook and a scheduled assistant task for the same job by default.
4. Keep monitoring automations read-only by default.
   - Prefer status, list, fetch, and diagnostic tools unless the user explicitly wants a mutating action.
5. Create or update the playbook with `workflow_upsert`.
6. If recurring execution is needed, add or update the schedule with `task_create` or `task_update`.
   - For scheduled assistant turns, use `task_create` with `type: "agent"`, `target` set to an agent id (or `default`), `prompt`, and a cron expression.
   - For a one-shot scheduled action, set `runOnce: true` so the task disables itself after the first execution.
   - Scheduled tasks are considered approved once created or updated, so the later cron execution should not pause for the same approval again.
7. Verify before claiming success.
   - Use `workflow_run` with `dryRun: true` when useful.
   - For scheduled automations, confirm both the workflow and the linked task exist.

## Practical Rules

- One workflow should have one clear purpose.
- Prefer explicit tool args over vague instruction text.
- Use sequential mode by default unless parallelism clearly helps.
- Instruction steps are text-only. If the automation needs the assistant to choose tools or read skills at runtime, use an `agent` task instead of an instruction step.
- Cron schedules are minute-granularity. If the user asks for sub-minute intervals, explain that limitation.
- When the automation is domain-specific, read the matching domain skill too, such as `cloud-operations`, `google-workspace`, or `security-triage`.

## Monitoring Patterns

- HTTP or website check: `net_port_check` then `web_fetch`
- Local host health: `host_monitor_status` or `host_monitor_check` plus `sys_resources`
- Cloud posture check: provider `*_status` then the narrowest provider-specific inventory or log tool
- Security watch: `net_anomaly_check`, `net_threat_summary`, `intel_findings`, or firewall status plus an instruction step to summarize findings
- Personal assistant briefing: schedule an `agent` task with a prompt such as "Review Gmail, calendar, tasks, and monitoring alerts, then send me a concise briefing."
