# Cloud Operations

Use the built-in cloud and hosting tools for read-first inspection across Vercel, Cloudflare, AWS, GCP, Azure, cPanel, and WHM.

## Core Rules

- Check `<tool-context>` for configured cloud profiles before asking the user to repeat provider details.
- Prefer the narrowest read-only status or inventory tool first.
- Separate confirmed tool output from your inference.
- If the exact provider tool is not visible, call `find_tools` with the provider name before saying a capability is missing.
- The current built-in cloud surface is primarily status, inventory, DNS, SSL, log, and posture inspection. Do not promise unsupported write operations.

## Provider Workflow

1. Start with the provider health or account summary.
   - `vercel_status`, `cf_status`, `aws_status`, `gcp_status`, `azure_status`, `cpanel_account`, `whm_status`
2. Move to the narrow provider-specific tool that matches the request.
   - Vercel: projects, deployments, domains, env, logs
   - Cloudflare: DNS, SSL, cache
   - AWS: EC2, security groups, S3, Route53, Lambda, CloudWatch, RDS, IAM, costs
   - GCP: Compute, Cloud Run, Storage, DNS, logs
   - Azure: VMs, App Service, Storage, DNS, Monitor
   - cPanel / WHM: domains, DNS, SSL, backups, services, accounts
3. Summarize the result in operator language.
   - what exists
   - what is degraded or unusual
   - what the likely next inspection step is

## Monitoring Guidance

- For recurring cloud checks, pair this skill with `automation-builder`.
- Prefer low-noise inventory or status checks before logs-heavy workflows.
- For possible security issues, hand off to `security-triage` after gathering the minimal cloud evidence.
