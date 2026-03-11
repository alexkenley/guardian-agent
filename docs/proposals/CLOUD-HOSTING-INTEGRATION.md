# Implementation Document: Cloud & Hosting Management for GuardianAgent

**Date:** 2026-03-11
**Status:** Active Implementation Document

---

## Executive Summary

Cloud and hosting operations are a strong product extension for GuardianAgent, especially because the app already has approval gating, policy controls, audit history, and operator-facing output surfaces.

This implementation document has been revised against official provider documentation on **2026-03-11**. The original draft was directionally good, but it was too broad and included several API assumptions that were deprecated, plugin-specific, or too optimistic for GuardianAgent's current architecture.

The recommended implementation order is:
- **Phase 1:** cPanel/WHM core account, domain, DNS, backup, and SSL operations
- **Phase 2:** Vercel projects, deployments, project domains, environment variables, and logs
- **Phase 3:** Cloudflare DNS and SSL settings
- **Phase 4:** AWS foundation
- **Phase 5:** GCP foundation
- **Phase 6:** Azure foundation
- **Phase 7:** DigitalOcean stretch

### Delivery Breakdown

To keep this operationally safe, **Phase 1** should be delivered in smaller slices:

- **Phase 1A: Foundation + Read-Only Discovery**
  - add config + credential-ref support for cPanel/WHM profiles
  - implement a reusable cPanel/WHM HTTP client with auth, TLS options, and response normalization
  - ship read-only tools first: `cpanel_account`, `whm_status`, `whm_accounts` (`list` only)
- **Phase 1B: Core Account and Domain Mutations**
  - extend `whm_accounts` to support create/suspend/unsuspend/modify/remove
  - add `cpanel_domains` for listing and mutating subdomains, redirects, aliases, and addon domains
- **Phase 1C: DNS, SSL, and Backup Operations**
  - add `cpanel_dns`, `cpanel_ssl`, and `cpanel_backups`
  - add explicit dry-run previews, redaction rules, and stronger error mapping for mutating flows
- **Phase 1D: UX + Hardening**
  - operator-facing summaries in web/CLI surfaces
  - audit-history shaping, approval copy, retries, and more complete fixture coverage

This repository change implements the core of **Phase 1**:
- `cpanel_account`
- `cpanel_domains`
- `cpanel_dns`
- `cpanel_backups`
- `cpanel_ssl`
- `whm_status`
- `whm_accounts`
- `whm_dns`
- `whm_ssl`
- `whm_backup`
- `whm_services`

The remaining work for this provider family is primarily hardening, richer action coverage, and operator-facing UX polish rather than missing phase-one tool surfaces.

This repository now also implements the core of **Phase 2**:
- `vercel_status`
- `vercel_projects`
- `vercel_deployments`
- `vercel_domains`
- `vercel_env`
- `vercel_logs`

The remaining work for this provider family is primarily broader action coverage (`vercel_dns`, `vercel_edge_config`, `vercel_checks`), richer provider-specific validation, and live-environment verification against staged Vercel projects.

This repository now also implements the core of **Phase 3**:
- `cf_status`
- `cf_dns`
- `cf_ssl`

The remaining work for this provider family is primarily wider Cloudflare surface area (`cf_firewall`, `cf_cache`, `cf_workers`, `cf_analytics`, `cf_page_rules`) and live-environment verification against a staged Cloudflare account.

This repository now also implements the core of **Phase 4**:
- `aws_status`
- `aws_ec2_instances`
- `aws_ec2_security_groups`
- `aws_s3_buckets`
- `aws_route53`
- `aws_lambda`
- `aws_cloudwatch`
- `aws_rds`
- `aws_iam`
- `aws_costs`

The remaining work for this provider family is primarily deeper action coverage per AWS service, richer pagination/filter helpers, and live-environment verification against a staged AWS account.

### Cloud Service Providers

The current provider roadmap is:

| Phase | Provider Family | Status | Notes |
|------|------------------|--------|------|
| 1 | cPanel/WHM | Implemented | Core account, domain, DNS, backup, SSL, and server operations |
| 2 | Vercel | Implemented | Core project, deployment, domain, env, and log operations |
| 3 | Cloudflare | Implemented | Core DNS and SSL/TLS operations |
| 4 | AWS | Implemented foundation | Broad service foundation across EC2, S3, Route53, Lambda, CloudWatch, RDS, IAM, and Cost Explorer |
| 5 | GCP | Implemented foundation | Hyperscaler coverage focused on hosting/runtime, storage, DNS, and logging |
| 6 | Azure | Implemented foundation | Hyperscaler coverage focused on VMs, app hosting, storage, DNS, and monitoring |
| 7 | DigitalOcean | Planned stretch | Smaller hosting-oriented provider surface |

This should be treated as a pragmatic infrastructure-management expansion, not a claim of absolute market uniqueness.

---

## Part 1: cPanel Integration

### API Overview

cPanel provides two API layers:
- **UAPI** (cPanel user-level) — manage a single hosting account
- **WHM API 1** (root/reseller-level) — manage the entire server and all accounts

For multi-account implementations, WHM is the better anchor because it can manage server-wide operations directly and can proxy some cPanel account actions through the documented WHM `cpanel` bridge endpoint.

Both use HTTPS with token-based or credential auth:
```
# UAPI (per-account)
https://{host}:2083/execute/{Module}/{function}?param=value
Authorization: cpanel {username}:{api_token}

# WHM API 1 (server admin)
https://{host}:2087/json-api/{function}?api.version=1&param=value
Authorization: whm {username}:{api_token}
```

### Validated Scope

The initial implementation should stay on **documented, standard APIs**. The following items are explicitly **deferred** from Phase 1:
- **Cron management**: current cPanel docs still place Cron in deprecated cPanel API 2, not UAPI
- **WP Toolkit operations**: plugin-dependent, not portable across cPanel installs
- **CSF management**: third-party/plugin-specific, not a standard WHM API 1 surface
- **Private key retrieval**: DKIM private keys, SSL private keys, and decrypted secrets must not be exposed back to the LLM or UI
- **Large multipart file operations and restore flows**: supported later after the base client and output model are stable

### Proposed Tool Set

#### cPanel/WHM Initial Tools — Category: `cloud`

| Tool | Purpose | Risk Level | Complexity |
|------|---------|-----------|------------|
| `cpanel_account` | Account metadata, resource usage, domains, bandwidth, resource pressure | read_only | LOW |
| `cpanel_domains` | List/add/remove addon domains, subdomains, aliases, redirects | mutating | LOW |
| `cpanel_dns` | Parse and edit DNS zone records | mutating | MODERATE |
| `cpanel_email_accounts` | List/create/delete/reset mailbox passwords | mutating | MODERATE |
| `cpanel_databases` | List/create/delete MySQL databases and users, assign privileges | mutating | MODERATE |
| `cpanel_backups` | List backups and trigger supported account backup creation | mutating | MODERATE |
| `cpanel_ssl` | List certs, check expiry, install supported certs, inspect AutoSSL status | mutating | MODERATE |
| `whm_status` | Server load, service status, disk usage, Apache/MySQL status | read_only | LOW |
| `whm_accounts` | List/create/suspend/terminate/modify hosting accounts | mutating | LOW |
| `whm_packages` | List/create/edit hosting packages (quotas, features) | mutating | MODERATE |
| `whm_dns` | Server-wide DNS cluster management, zone operations | mutating | MODERATE |
| `whm_ssl` | Server SSL management, AutoSSL provider config | mutating | MODERATE |
| `whm_backup` | Configure backup schedule, destinations, restore accounts | mutating | MODERATE |
| `whm_services` | Restart Apache, MySQL, DNS, FTP, mail services | mutating | MODERATE |
| `whm_cpanel_proxy` | Execute approved cPanel account operations through the WHM bridge where appropriate | mutating | MODERATE |

#### Deferred Hosting Tools

| Tool | Reason Deferred |
|------|-----------------|
| `cpanel_cron` | Cron is documented under deprecated cPanel API 2 rather than standard UAPI |
| `cpanel_wordpress` | WP Toolkit is not guaranteed to exist on the target server |
| `cpanel_files` | Multipart upload/download and archive operations need a stronger client abstraction |
| `cpanel_email_auth` | Secret-bearing operations must be write-only and need dedicated redaction rules |
| `whm_security` | cPHulk and ModSecurity are standard, but CSF is not; this needs tighter scoping |
| `whm_transfers` | High-risk workflow with long-running async behavior and rollback concerns |

### Implementation Architecture

```typescript
// src/tools/hosting/cpanel-client.ts
interface CpanelConfig {
  host: string;          // e.g. "server1.example.com"
  port: number;          // 2083 (cPanel) or 2087 (WHM)
  username: string;
  credentialRef: string; // assistant.credentials.refs key
  type: 'cpanel' | 'whm';
  ssl: boolean;          // default true
}

class CpanelClient {
  async request(input: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<unknown>;

  // UAPI calls
  async uapi(module: string, fn: string, params?: Record<string, string>): Promise<UapiResponse>;

  // WHM API 1 calls
  async whm(fn: string, params?: Record<string, string>): Promise<WhmResponse>;

  // WHM bridge to cPanel account context
  async whmCpanel(user: string, module: string, fn: string, params?: Record<string, string>): Promise<UapiResponse>;
}
```

The client must support:
- normal query-string GET requests
- POST requests for mutating operations
- provider-specific retries, pagination, and rate-limit handling
- strict secret redaction in logs, run history, audit records, and tool output

### UAPI Modules to Implement First

| Module | Key Functions | What It Manages |
|--------|-------------|-----------------|
| `StatsBar` | `get_stats` | Account resource usage (disk, bandwidth, email, domains) |
| `DomainInfo` | `list_domains`, `domains_data` | All domain types on account |
| `SubDomain` | `addsubdomain`, `delsubdomain` | Subdomains |
| `Redirects` | `list_redirects`, `add_redirect`, `delete_redirect` | URL redirects |
| `DNS` | `mass_edit_zone`, `parse_zone` | DNS zone records |
| `Email` | `list_pops`, `add_pop`, `delete_pop`, `passwd_pop` | Email accounts |
| `Mysql` | `list_databases`, `create_database`, `delete_database` | MySQL databases |
| `Backup` | documented backup listing/creation operations | Backups |
| `SSL` | `list_certs`, `install_ssl`, `delete_cert`, `fetch_best_for_domain` | SSL certificates |
| `Bandwidth` | `query` | Bandwidth statistics |
| `ResourceUsage` | `get_usages` | CPU, memory, IO usage |

### Deferred or Conditional cPanel Modules

| Module | Status | Reason |
|--------|--------|--------|
| `Cron` | Deferred | Documented under deprecated cPanel API 2 rather than UAPI |
| `Fileman` | Deferred | Higher implementation complexity due to multipart/file-stream flows |
| `VersionControl` | Deferred | Useful, but not core to hosting operations |
| `LangPHP` | Deferred | Lower priority than domains/DNS/SSL/backup/account actions |
| WP Toolkit | Conditional | Plugin-dependent, not guaranteed on all servers |
| DKIM private-key operations | Deferred | Must be write-only and heavily redacted |

### WHM API 1 Key Functions

| Function | What It Does |
|----------|-------------|
| `listaccts` | List all hosting accounts |
| `createacct` | Create new hosting account |
| `suspendacct` / `unsuspendacct` | Suspend/unsuspend account |
| `modifyacct` | Modify account quotas and settings |
| `removeacct` | Terminate hosting account |
| `listpkgs` / `addpkg` / `editpkg` | Hosting package management |
| `gethostname` / `version` | Server identity |
| `systemloadavg` | Server load average |
| `servicestatus` | All service statuses (httpd, mysql, named, etc.) |
| `restartservice` | Restart specific services |
| `installssl` | Install SSL certificate on domain |
| `backup_config_set` | Configure backup settings |
| `cpanel` | Execute supported cPanel operations for a target account via WHM |

### Estimated LOC

| Component | LOC |
|-----------|-----|
| `CpanelClient` (HTTP client, auth, bridge, error handling) | ~350 |
| cPanel/WHM initial tools (15 tools) | ~900 |
| Config types, validation, redaction rules | ~180 |
| Tests | ~500 |
| UI + output/history integration | ~250 |
| **Total** | **~2,180** |

---

## Part 2: Vercel Integration

### API Overview

Vercel exposes a documented REST API at `https://api.vercel.com`, but the implementation should prefer the official **TypeScript SDK** and only drop to raw REST where needed.

Auth: Bearer token (`Authorization: Bearer {token}`)

Do not hardcode a guessed request-per-minute limit. Respect the documented Vercel rate-limit headers and backoff behavior instead.

### Implemented Tool Set — Category: `cloud`

| Tool | Purpose | Risk Level | Complexity |
|------|---------|-----------|------------|
| `vercel_status` | List projects, deployment summary, team info | read_only | LOW |
| `vercel_projects` | List/create/update/delete projects | mutating | LOW |
| `vercel_deployments` | List/create/cancel/promote deployments, view build logs | mutating | MODERATE |
| `vercel_domains` | List/add/remove/verify project domains, inspect DNS config | mutating | MODERATE |
| `vercel_env` | List/create/update/delete project environment variables | mutating | MODERATE |
| `vercel_logs` | Fetch runtime logs, function invocation logs | read_only | LOW |
| `vercel_dns` | List/create/update/delete DNS records on Vercel-managed domains | mutating | MODERATE |
| `vercel_edge_config` | Manage Edge Config stores (key-value at the edge) | mutating | MODERATE |
| `vercel_checks` | Deployment checks and integration status | read_only | LOW |

#### Deferred Vercel Tooling

| Tool | Reason Deferred |
|------|-----------------|
| `vercel_certs` | Domain workflows already cover most operator needs and cert issuance is often implicit |
| broad team/admin management | Adds little value versus projects/deployments/domains/logs in the first release |

### Initial API Surface

```
# Prefer official SDK methods where available.
# The implementation should map these logical operations:

Projects            — list, create, read, update, delete
Deployments         — list, create, read, cancel, promote
Project Domains     — list, add, remove, verify, inspect config
Environment Vars    — list, create, update, delete
Runtime / Build Logs — deployment events and runtime logs
DNS Records         — list, create, update, delete
Edge Config         — list stores, read/update items
```

### Implementation Architecture

```typescript
// src/tools/cloud/vercel-client.ts
interface VercelConfig {
  credentialRef: string; // assistant.credentials.refs key
  teamId?: string;      // Optional team scope
}

class VercelClient {
  async request(method: string, path: string, body?: unknown): Promise<unknown>;

  // Convenience methods
  async listProjects(): Promise<VercelProject[]>;
  async listDeployments(projectId: string): Promise<VercelDeployment[]>;
  async getDeploymentLogs(deploymentId: string): Promise<string>;
  // etc.
}
```

### Estimated LOC

| Component | LOC |
|-----------|-----|
| `VercelClient` or SDK wrapper | ~220 |
| Vercel initial tools (9 tools) | ~650 |
| Config types + redaction rules | ~100 |
| Tests | ~350 |
| UI + output/history integration | ~150 |
| **Total** | **~1,470** |

---

## Part 3: AWS Integration

### Approach

Rather than wrapping the entire AWS SDK, we would implement a focused set of tools for the most common infrastructure management tasks using `@aws-sdk/*` modular packages.

AWS has the largest blast radius, the broadest auth surface, and the highest verification burden. For that reason, the implementation should stay intentionally narrow and service-scoped even though the foundation layer now exists in the repository.

### Possible Future Tool Set — Category: `cloud`

| Tool | Purpose | AWS Service | Risk Level | Complexity |
|------|---------|------------|-----------|------------|
| `aws_status` | Account info, region, IAM identity | STS, IAM | read_only | LOW |
| `aws_ec2_instances` | List/start/stop/reboot/describe instances | EC2 | mutating | MODERATE |
| `aws_ec2_security_groups` | List/describe/modify security group rules | EC2 | mutating | MODERATE |
| `aws_s3_buckets` | List buckets, list objects, get/put objects, bucket policy | S3 | mutating | MODERATE |
| `aws_route53` | List hosted zones, list/create/update/delete DNS records | Route53 | mutating | MODERATE |
| `aws_lambda` | List/invoke/get-config for Lambda functions | Lambda | mutating | MODERATE |
| `aws_cloudwatch` | Get metrics, alarms, recent log events | CloudWatch | read_only | MODERATE |
| `aws_rds` | List/describe/start/stop RDS instances | RDS | mutating | MODERATE |
| `aws_iam` | List users/roles/policies, check permissions | IAM | read_only | MODERATE |
| `aws_costs` | Get cost/usage data from Cost Explorer | CE | read_only | MODERATE |

### Dependencies

```json
{
  "@aws-sdk/client-sts": "^3.x",
  "@aws-sdk/client-ec2": "^3.x",
  "@aws-sdk/client-s3": "^3.x",
  "@aws-sdk/client-route-53": "^3.x",
  "@aws-sdk/client-lambda": "^3.x",
  "@aws-sdk/client-cloudwatch": "^3.x",
  "@aws-sdk/client-cloudwatch-logs": "^3.x",
  "@aws-sdk/client-rds": "^3.x",
  "@aws-sdk/client-iam": "^3.x",
  "@aws-sdk/client-cost-explorer": "^3.x"
}
```

### Auth: Standard AWS credential chain (env vars, `~/.aws/credentials`, IAM role)

### Estimated LOC

| Component | LOC |
|-----------|-----|
| AWS client wrapper (multi-service) | ~350 |
| AWS tools (10 tools) | ~900 |
| Config types | ~120 |
| Tests | ~500 |
| **Total** | **~1,870** |

---

## Part 4: Cloudflare Integration

### Implemented Tool Set — Category: `cloud`

| Tool | Purpose | Risk Level | Complexity |
|------|---------|-----------|------------|
| `cf_status` | Account info, zone list | read_only | LOW |
| `cf_dns` | List/create/update/delete DNS records per zone | mutating | LOW |
| `cf_ssl` | SSL/TLS settings, certificate packs, edge certificates | mutating | LOW |
| `cf_firewall` | WAF rules, IP access rules, rate limiting rules | mutating | MODERATE |
| `cf_cache` | Purge cache (all, by URL, by tag), cache settings | mutating | LOW |
| `cf_workers` | List/deploy/delete Workers scripts | mutating | MODERATE |
| `cf_analytics` | Traffic analytics, security analytics, DNS analytics | read_only | LOW |
| `cf_page_rules` | List/create/update/delete page rules | mutating | LOW |

### API: `https://api.cloudflare.com/client/v4/`
### Auth: `Authorization: Bearer {token}` or `X-Auth-Email` + `X-Auth-Key`

### Estimated LOC: ~1,200

---

## Part 5: GCP Integration

### Proposed Tool Set — Category: `cloud`

| Tool | Purpose | GCP Service | Risk Level | Complexity |
|------|---------|-------------|-----------|------------|
| `gcp_status` | Project metadata and enabled services | Resource Manager, Service Usage | read_only | LOW |
| `gcp_compute` | List/start/stop/reset VM instances | Compute Engine | mutating | MODERATE |
| `gcp_cloud_run` | List services/revisions, inspect a service, update traffic | Cloud Run | mutating | MODERATE |
| `gcp_storage` | List buckets, list/get/put/delete objects | Cloud Storage | mutating | MODERATE |
| `gcp_dns` | List managed zones/records and mutate record sets | Cloud DNS | mutating | MODERATE |
| `gcp_logs` | Read log entries for projects/services | Cloud Logging | read_only | LOW |

### API / SDK

- Implemented via direct REST clients against the official Google Cloud APIs
- Authentication currently supports explicit bearer tokens or service-account JSON via `assistant.credentials.refs`
- Service-account profiles use OAuth JWT bearer exchange; broader ADC support can be added later if needed

### Estimated LOC

| Component | LOC |
|-----------|-----|
| GCP client wrappers | ~300 |
| GCP tools (6 tools) | ~700 |
| Config types | ~120 |
| Tests | ~450 |
| **Total** | **~1,570** |

---

## Part 6: Azure Integration

### Proposed Tool Set — Category: `cloud`

| Tool | Purpose | Azure Service | Risk Level | Complexity |
|------|---------|---------------|-----------|------------|
| `azure_status` | Subscription metadata and resource group summary | ARM | read_only | LOW |
| `azure_vms` | List/get/start/stop/restart/deallocate VMs | Compute | mutating | MODERATE |
| `azure_app_service` | List/get web apps, inspect config, restart | App Service | mutating | MODERATE |
| `azure_storage` | List accounts/containers/blobs and put/delete blobs | Storage | mutating | MODERATE |
| `azure_dns` | List zones/records and mutate DNS record sets | Azure DNS | mutating | MODERATE |
| `azure_monitor` | Metrics and activity logs | Azure Monitor | read_only | LOW |

### API / SDK

- Implemented via direct REST clients against Azure ARM and Blob APIs
- Authentication currently supports explicit bearer tokens or service principal client-credentials via `assistant.credentials.refs`
- Managed identity and broader Azure credential-chain support can be added later if needed

### Estimated LOC

| Component | LOC |
|-----------|-----|
| Azure client wrappers | ~320 |
| Azure tools (6 tools) | ~760 |
| Config types | ~120 |
| Tests | ~450 |
| **Total** | **~1,650** |

---

## Part 7: DigitalOcean Integration (Stretch)

### Proposed Tool Set — Category: `cloud`

| Tool | Purpose | Risk Level |
|------|---------|-----------|
| `do_status` | Account info, droplet list | read_only |
| `do_droplets` | List/create/resize/destroy/reboot droplets | mutating |
| `do_domains` | Domain and DNS record management | mutating |
| `do_firewalls` | Firewall rule management | mutating |
| `do_databases` | Managed database operations | mutating |
| `do_spaces` | Object storage (S3-compatible) | mutating |

### API: `https://api.digitalocean.com/v2/`
### Auth: Bearer token
### Estimated LOC: ~800

---

## Configuration Design

GuardianAgent already has an environment-backed credential registry under `assistant.credentials.refs`. Cloud and hosting integrations should follow that pattern instead of introducing raw provider tokens as first-class config values.

```yaml
# ~/.guardianagent/config.yaml

assistant:
  credentials:
    refs:
      cpanel_main_token:
        source: env
        env: CPANEL_API_TOKEN
      whm_root_token:
        source: env
        env: WHM_API_TOKEN
      vercel_main_token:
        source: env
        env: VERCEL_TOKEN

  tools:
    cloud:
      enabled: true

      hosting:
        servers:
          - id: main-cpanel
            type: cpanel
            host: server1.example.com
            port: 2083
            username: myuser
            credentialRef: cpanel_main_token
          - id: main-whm
            type: whm
            host: server1.example.com
            port: 2087
            username: root
            credentialRef: whm_root_token

      vercel:
        credentialRef: vercel_main_token
        teamId: team_xxxxx
```

### Config Types

```typescript
interface CloudConfig {
  enabled: boolean;
  hosting?: {
    servers: HostingServerConfig[];
  };
  vercel?: {
    credentialRef: string;
    teamId?: string;
  };
  aws?: {
    region: string;
    profile?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  cloudflare?: { credentialRef: string };
  digitalocean?: {
    credentialRef: string;
  };
}
```

This requires an explicit config/schema update in `assistant.tools` and a new `cloud` tool category in the tool registry and web configuration UI.

Initial release constraint:
- Build for future multi-connection support, but do not ship the full multi-connection UX yet.
- Internal models, run history, audit records, and API payloads should carry stable `providerId` and `connectionId` values from day one.
- The first implementation may expose only one actively managed connection per provider type in the UI, but it must not hardcode singleton assumptions into storage or tool execution paths.

---

## Security Considerations

### Guardian Integration

All cloud/hosting tools MUST pass through the Guardian pipeline:

1. **Capability Gating**: New capabilities needed:
   - `manage_hosting` — cPanel/WHM operations
   - `manage_cloud` — Cloud provider operations (Vercel, AWS, CF, DO)

2. **Risk Classification**:
   - `read_only` — status, list, describe, metrics queries
   - `mutating` — create, update, delete operations on infrastructure
   - `external_post` — destructive operations (terminate instances, delete zones, remove accounts)

3. **GuardianAgent Evaluation**: All mutating cloud operations should trigger inline LLM evaluation (Layer 2), since mistakes can be costly/irreversible.

4. **Credential Protection**:
   - Provider credentials stored through `assistant.credentials.refs`
   - SecretScanController patterns for cPanel tokens, AWS keys, Vercel tokens, CF tokens
   - DeniedPathController blocks `~/.aws/credentials`, Vercel auth files

5. **Approval Escalation**:
   - **Auto-approve**: read_only operations (status, list, describe)
   - **Require approval**: mutating operations (create domain, modify DNS, change PHP version)
   - **Always require approval**: destructive operations (delete account, terminate instance, purge cache)

### Secret and Output Handling

- Tool output must never expose:
  - decrypted Vercel environment variable values
  - DKIM private keys
  - SSL private keys
  - raw API tokens
- Secret-bearing write operations should return metadata only: target, status, timestamps, identifiers, and validation results
- Provider responses must be redacted before:
  - LLM reinjection
  - audit storage
  - automation run history
  - network/reference/UI export surfaces

### Dangerous Operation Safeguards

```typescript
// Operations that require explicit confirmation + Guardian Agent eval
const DANGEROUS_OPS = [
  'whm_accounts:terminate',    // Delete hosting account
  'aws_ec2:terminate',         // Terminate EC2 instance
  'aws_s3:delete_bucket',      // Delete S3 bucket
  'aws_route53:delete_zone',   // Delete DNS zone
  'vercel_projects:delete',    // Delete project
  'cf_dns:delete_zone',        // Delete entire DNS zone
  'cpanel_databases:delete',   // Drop database
];
```

---

## Automated Testing Strategy

The cloud/hosting implementation must ship with an automated black-box test suite built on the existing integration harness documented in `docs/guides/INTEGRATION-TEST-HARNESS.md`.

This is not optional. The goal is to catch provider-integration bugs, approval regressions, output-redaction failures, and UX wiring problems before manual or production testing.

### Required Harness Deliverables

- `scripts/test-cloud-hosting.mjs`
  - end-to-end natural-language scenarios through `POST /api/message`
  - validates tool discovery, correct tool selection, approval wording, and final user-visible response copy
- `scripts/test-cloud-tools.mjs`
  - direct tool API and approval transport coverage via `/api/tools/run` and `/api/tools/approvals/decision`
  - validates args handling, destructive approval gating, and run-history output
- `scripts/test-cloud-config.mjs`
  - validates cloud config CRUD, credential-ref wiring, redaction, provider status, and connection test paths
- `scripts/test-cloud-automation.mjs`
  - creates workflows/tasks using cloud tools, runs them, and verifies step output/history/export behavior
- `scripts/test-cloud-cli.mjs`
  - validates CLI command families, approval prompts, history inspection, and error copy
- Provider-focused suites as needed:
  - `scripts/test-cpanel-whm.mjs`
  - `scripts/test-vercel.mjs`
  - `scripts/test-cloudflare.mjs`

### Required Coverage

- provider auth and connection validation
- tool discovery from natural-language prompts
- direct tool execution and structured output
- approval and denial flows for mutating/destructive actions
- secret redaction in responses, logs, history, exports, and audit records
- expected failure handling for auth errors, missing resources, unsupported features, and rate limiting
- automation creation, scheduling, execution, and run-history inspection
- CLI command behavior and approval UX
- web API support for UI configuration, monitoring, and management flows

### Test Environment Requirements

- Use sandbox or disposable provider targets:
  - cPanel test account
  - WHM development server or isolated reseller/root environment
  - Vercel sandbox project/team
  - Cloudflare sandbox zone/account
- Prefer self-contained Node.js harness scripts as described in the harness guide.
- Each script must stand up a temporary GuardianAgent instance, wait for health, execute assertions, and cleanly tear down the process.
- Manual testing starts only after the harness suite passes.

---

## Channel and UI Requirements

Cloud and hosting tools are not just backend integrations. They must be first-class features across chat, CLI, web, automations, output history, and documentation.

### All Channels

- All supported tools must be usable through the normal chat path on web, CLI, and Telegram.
- Approvals must use the native channel experience already used elsewhere in GuardianAgent.
- Output must be retained in run history with the same inspect/copy/export behavior already used for network and automation output.

### CLI Requirements

The implementation should include explicit CLI command families in addition to natural-language access.

- `/cloud`
  - summary status, provider list, recent runs, and connection health
- `/cpanel`
  - direct access to cPanel account tools
- `/whm`
  - direct access to WHM admin tools
- `/vercel`
  - direct access to Vercel project/deployment/domain/env tools
- `/cf`
  - direct access to Cloudflare tools when that phase lands

Each family should support subcommands for:
- `status`
- `list`
- `run`
- `history`
- `help`

The direct CLI commands should map to the same underlying tool handlers and output model as the web/API path.

### Web UI Requirements

#### Security Panel

Add a **Cloud Security** section for provider security posture and monitoring.

It should support:
- SSL expiry and AutoSSL health views
- backup health and recent backup status
- deployment health and failed deployment visibility
- Cloudflare/WAF posture once available
- provider auth or permission failure alerts
- approval/audit visibility for cloud and hosting actions

#### Network Panel

Add a **Cloud** section focused on management operations with a polished operator workflow.

It should support:
- provider switcher
- connection/context selector
- account/project/server overview
- domains and DNS management
- deployment and service operations
- logs and recent action output
- run history with expandable output
- copy, text export, and HTML export for output blocks

The UX should be designed for future multi-connection support, even if the initial release only exposes one active connection per provider.

#### Automations

Cloud and hosting tools must appear in the automation catalog and be schedulable anywhere automation currently works.

Required automation support:
- tool discovery for cloud/hosting tools
- workflow creation with cloud steps
- cron scheduling where appropriate
- run history with step output and copy/export controls
- starter templates for common operations such as:
  - SSL expiry checks
  - backup health checks
  - deployment verification
  - DNS drift monitoring

#### Configuration

Add a **Cloud** section in Configuration for:
- provider enable/disable controls
- credential-ref selection
- connection/server definitions
- connection test actions
- provider defaults and routing
- cloud tool policies and approval behavior
- monitoring defaults and notification settings

### Documentation Requirement

- The Reference Guide must be updated as cloud and hosting features land.
- The Reference Guide coverage must be thorough. It should document all new hosting and cloud capabilities across setup, provider connections, approvals, monitoring, automation, output/history inspection, export behavior, CLI usage, web UI workflows, and destructive-action safeguards.
- Operator-facing docs should cover setup, approvals, monitoring, automation, output inspection, and safe destructive-operation handling.

---

## Cross-Cutting Implementation Requirements

- Add a new `cloud` tool category end-to-end:
  - config schema
  - tool registry
  - policy UI
  - reference guide
  - tool discovery metadata
- Reuse the existing output/history patterns rather than inventing a new provider-specific output system.
- Keep provider adapters separate from UI orchestration logic.
- Any operation that can reveal secrets must be explicitly redacted before it touches LLM context, logs, UI exports, or automation history.

---

## Implementation Roadmap

### Phase 0: Shared Foundations

| Task | Est. LOC |
|------|---------|
| `cloud` tool category, config schema, provider/connection identifiers | 250 |
| Shared output model, redaction rules, and run-history plumbing | 250 |
| CLI and web scaffolding for cloud features | 250 |
| Harness scaffolding for cloud suites | 200 |
| **Subtotal** | **950** |

### Phase 1: cPanel & WHM (Week 1-3)

| Task | Est. LOC |
|------|---------|
| `CpanelClient` HTTP client with auth, bridge, retries | 350 |
| cPanel/WHM initial tools | 900 |
| Provider config wiring, validation, redaction rules | 220 |
| CLI commands + web Config/Security/Network integration | 500 |
| Automation integration and starter templates | 180 |
| Harness suites + provider fixtures | 450 |
| Tests | 550 |
| **Subtotal** | **3,150** |

### Phase 2: Vercel (Week 2-3)

| Task | Est. LOC |
|------|---------|
| `VercelClient` / SDK wrapper | 220 |
| Vercel initial tools | 650 |
| Provider config, redaction, team scoping | 120 |
| CLI commands + web integration | 250 |
| Automation integration + templates | 120 |
| Harness suites + sandbox coverage | 300 |
| Tests | 400 |
| **Subtotal** | **2,060** |

### Phase 3: Cloudflare (Week 3-4)

| Task | Est. LOC |
|------|---------|
| `CloudflareClient` HTTP client | 200 |
| Cloudflare tools (8 tools) | 600 |
| Config types | 60 |
| Tests | 300 |
| **Subtotal** | **1,160** |

### Phase 4: AWS Foundation

| Task | Est. LOC |
|------|---------|
| AWS client wrapper (multi-service) | 350 |
| AWS tools (10 tools) | 900 |
| Config types | 120 |
| Tests | 500 |
| **Subtotal** | **1,870** |

### Phase 5: GCP Foundation

| Task | Est. LOC |
|------|---------|
| GCP client wrappers | 300 |
| GCP tools (6 tools) | 700 |
| Config types | 120 |
| Tests | 450 |
| **Subtotal** | **1,570** |

### Phase 6: Azure Foundation

| Task | Est. LOC |
|------|---------|
| Azure client wrappers | 320 |
| Azure tools (6 tools) | 760 |
| Config types | 120 |
| Tests | 450 |
| **Subtotal** | **1,650** |

### Phase 7: DigitalOcean (Week 6-7, stretch)

| Task | Est. LOC |
|------|---------|
| DO client + tools (6 tools) | 600 |
| Config + tests | 200 |
| **Subtotal** | **800** |

---

## Total Estimates

| Phase | Provider | Tools | Est. LOC |
|-------|---------|-------|---------|
| 0 | Shared Foundations | N/A | 950 |
| 1 | cPanel + WHM | 15 | 3,150 |
| 2 | Vercel | 9 | 2,060 |
| 3 | Cloudflare | 8 | 1,160 |
| 4 | AWS | 10 | 1,870 |
| 5 | GCP | 6 | 1,570 |
| 6 | Azure | 6 | 1,650 |
| 7 | DigitalOcean | 6 | 800 |
| **Total** | **7 providers + shared foundations** | **60 tools** | **~13,210** |

---

## Differentiator Value

This suite would give GuardianAgent a differentiated infrastructure-management story:

| Capability | OpenClaw | Claude Code | Other Agents | GuardianAgent |
|-----------|---------|------------|-------------|---------------|
| cPanel/WHM management | Limited/none | No | Rare | **Implemented** |
| Vercel deployment mgmt | Limited/none | No | Rare | **Implemented** |
| AWS infrastructure | No | No | Limited | **Implemented foundation** |
| GCP infrastructure | No | No | Limited | **Implemented foundation** |
| Azure infrastructure | No | No | Limited | **Implemented foundation** |
| Cloudflare WAF/DNS | Limited/none | No | Rare | **Implemented foundation** |
| Security-gated cloud ops | N/A | N/A | N/A | **4-layer Guardian** |
| Network + cloud unified | No | No | No | **Yes** |

The combination of **local network security tools** (existing 19 net_* tools) + **cloud infrastructure management** + **Guardian security gating** creates a unique value proposition: a security-first infrastructure management agent that can monitor your network AND manage your hosting/cloud from a single interface.

---

## Example Workflows

### 1. "Check my hosting and renew SSL"
```
User: "Check the SSL status on server1 and renew anything expiring soon"
→ cpanel_ssl (list certs, check expiry dates)
→ cpanel_ssl (trigger AutoSSL for expiring domains)
→ Report: "3 certs renewed, 2 already valid"
```

### 2. "Deploy the latest to production on Vercel"
```
User: "Deploy my-app to production"
→ vercel_deployments (list recent deployments)
→ vercel_deployments (promote latest preview to production)  [REQUIRES APPROVAL]
→ vercel_logs (check deployment build logs)
→ Report: "Deployed v47 to production, all checks passing"
```

### 3. "Add a subdomain and point it to my Vercel project"
```
User: "Create staging.example.com pointing to my Vercel project"
→ cpanel_domains (add subdomain staging.example.com)
→ cpanel_dns (add CNAME record: staging → cname.vercel-dns.com)
→ vercel_domains (add staging.example.com to project)
→ Report: "staging.example.com is live with SSL"
```

### 4. "Security audit across hosting and edge"
```
User: "Run a security check across my hosting and edge"
→ whm_status (check service health and server status)
→ cpanel_ssl (check all cert expiry)
→ cf_firewall (check WAF rules)
→ net_port_check (verify only expected ports are open)
→ Report: consolidated security findings with recommendations
```

### 5. "Create a new client hosting account"
```
User: "Set up a new hosting account for client acme-corp"
→ whm_packages (list available packages)
→ whm_accounts (create account: acme-corp, standard package)  [REQUIRES APPROVAL]
→ cpanel_email_accounts (create admin@acme-corp.com)
→ cpanel_ssl (enable AutoSSL)
→ Report: "Account created, login details: ..."
```
