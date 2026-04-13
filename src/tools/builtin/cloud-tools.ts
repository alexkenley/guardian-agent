import { normalizeSensitiveKeyName } from '../../util/crypto-guardrails.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';
import type { AwsClient, AwsInstanceConfig } from '../cloud/aws-client.js';
import type { AzureClient, AzureInstanceConfig, AzureServiceName } from '../cloud/azure-client.js';
import type { CpanelClient, CpanelInstanceConfig, NormalizedApiResponse } from '../cloud/cpanel-client.js';
import type { CloudflareClient, CloudflareInstanceConfig } from '../cloud/cloudflare-client.js';
import type { GcpClient, GcpInstanceConfig, GcpServiceName } from '../cloud/gcp-client.js';
import type { VercelClient, VercelInstanceConfig } from '../cloud/vercel-client.js';

type AwsServiceName =
  | 'sts'
  | 'ec2'
  | 's3'
  | 'route53'
  | 'lambda'
  | 'cloudwatch'
  | 'cloudwatchLogs'
  | 'rds'
  | 'iam'
  | 'costExplorer';

const DEFAULT_CLOUDFLARE_SSL_SETTING_IDS = [
  'ssl',
  'min_tls_version',
  'tls_1_3',
  'always_use_https',
  'automatic_https_rewrites',
  'opportunistic_encryption',
];

interface CloudToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  asStringArray: (value: unknown) => string[];
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  createWhmClient: (profileId: string) => Promise<CpanelClient>;
  resolveCpanelAccountContext: (profileId: string, requestedAccount?: string) => Promise<{ client: CpanelClient; account?: string }>;
  createVercelClient: (profileId: string) => Promise<VercelClient>;
  createCloudflareClient: (profileId: string) => Promise<CloudflareClient>;
  createAwsClient: (profileId: string, service?: AwsServiceName) => Promise<AwsClient>;
  createGcpClient: (profileId: string, service?: GcpServiceName) => Promise<GcpClient>;
  createAzureClient: (profileId: string, service?: AzureServiceName) => Promise<AzureClient>;
  describeCloudEndpoint: (profile: CpanelInstanceConfig) => string;
  describeVercelEndpoint: (profile: VercelInstanceConfig) => string;
  describeCloudflareEndpoint: (profile: CloudflareInstanceConfig) => string;
  describeAwsEndpoint: (profile: AwsInstanceConfig, service: AwsServiceName) => string;
  describeGcpEndpoint: (profile: GcpInstanceConfig, service: GcpServiceName) => string;
  describeAzureEndpoint: (profile: AzureInstanceConfig, service: AzureServiceName, accountName?: string) => string;
  resolveGcpLocation: (value: unknown, profileId: string, throwOnMissing?: boolean) => string;
  resolveAzureResourceGroup: (value: unknown, profileId: string, throwOnMissing?: boolean) => string;
}

type CloudToolValueHelpers = Pick<CloudToolRegistrarContext, 'requireString' | 'asString' | 'asStringArray'>;

export function registerBuiltinCloudTools(context: CloudToolRegistrarContext): void {
  const { requireString, asString, asNumber, asStringArray } = context;
  // ── Cloud & Hosting Tools ───────────────────────────────────

  context.registry.register(
    {
      name: 'cpanel_account',
      description: 'Inspect a cPanel account via direct cPanel auth or via a WHM profile bridged into a target account. Supports summary, domains, bandwidth, and resource usage views. Read-only.',
      shortDescription: 'Inspect cPanel account stats, domains, bandwidth, and resource usage.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id.' },
          action: { type: 'string', description: 'summary, domains, bandwidth, or resource_usage (default: summary).' },
          account: { type: 'string', description: 'Target cPanel username when using a WHM profile.' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      const action = asString(args.action, 'summary').trim().toLowerCase();
      if (!['summary', 'domains', 'bandwidth', 'resource_usage'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use summary, domains, bandwidth, or resource_usage.' };
      }
      let account: string | undefined;
      let client: CpanelClient;
      try {
        ({ client, account } = await context.resolveCpanelAccountContext(requireString(args.profile, 'profile'), asString(args.account)));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method: 'GET',
        tool: 'cpanel_account',
        action,
        account,
      });

      try {
        const invoke = async (
          module: string,
          fn: string,
          params?: Record<string, string | number | boolean | undefined>,
        ): Promise<NormalizedApiResponse> => {
          return client.config.type === 'cpanel'
            ? client.uapi(module, fn, params)
            : client.whmCpanel(account!, module, fn, params);
        };

        if (action === 'domains') {
          const domains = await invoke('DomainInfo', 'list_domains');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              data: domains.data,
              warnings: domains.warnings,
            },
          };
        }

        if (action === 'bandwidth') {
          const bandwidth = await invoke('Bandwidth', 'query');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              data: bandwidth.data,
              warnings: bandwidth.warnings,
            },
          };
        }

        if (action === 'resource_usage') {
          const resourceUsage = await invoke('ResourceUsage', 'get_usages');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              data: resourceUsage.data,
              warnings: resourceUsage.warnings,
            },
          };
        }

        const [stats, domains, resourceUsage] = await Promise.all([
          invoke('StatsBar', 'get_stats'),
          invoke('DomainInfo', 'list_domains'),
          invoke('ResourceUsage', 'get_usages').catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
        ]);

        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            account,
            action,
            stats: stats.data,
            domains: domains.data,
            resourceUsage: 'data' in resourceUsage ? resourceUsage.data : null,
            resourceUsageError: 'error' in resourceUsage ? resourceUsage.error : undefined,
            warnings: [...stats.warnings, ...domains.warnings],
          },
        };
      } catch (err) {
        return { success: false, error: `cPanel account request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cpanel_domains',
      description: 'Manage cPanel account domains and redirects via direct cPanel auth or a WHM bridge. Supports list, list_redirects, add_subdomain, delete_subdomain, add_redirect, and delete_redirect.',
      shortDescription: 'List or mutate cPanel subdomains and redirects.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id.' },
          action: { type: 'string', description: 'list, list_redirects, add_subdomain, delete_subdomain, add_redirect, or delete_redirect.' },
          account: { type: 'string', description: 'Target cPanel username when using a WHM profile.' },
          domain: { type: 'string', description: 'Domain or subdomain name.' },
          rootDomain: { type: 'string', description: 'Root domain used for subdomain creation/deletion.' },
          dir: { type: 'string', description: 'Document root or redirect target path, depending on action.' },
          destination: { type: 'string', description: 'Redirect destination URL.' },
          redirectId: { type: 'string', description: 'Redirect identifier for delete_redirect.' },
          redirectType: { type: 'string', description: 'Redirect type for add_redirect, e.g. temporary or permanent.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      const supportedActions = ['list', 'list_redirects', 'add_subdomain', 'delete_subdomain', 'add_redirect', 'delete_redirect'];
      if (!supportedActions.includes(action)) {
        return {
          success: false,
          error: `Unsupported action. Use ${supportedActions.join(', ')}.`,
        };
      }

      let account: string | undefined;
      let client: CpanelClient;
      try {
        ({ client, account } = await context.resolveCpanelAccountContext(requireString(args.profile, 'profile'), asString(args.account)));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = (action === 'list' || action === 'list_redirects') ? 'GET' : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'cpanel_domains',
        action,
        account,
      });

      try {
        const invoke = async (
          module: string,
          fn: string,
          params?: Record<string, string | number | boolean | undefined>,
          options?: { method?: 'GET' | 'POST' },
        ): Promise<NormalizedApiResponse> => {
          return client.config.type === 'cpanel'
            ? client.uapi(module, fn, params, options)
            : client.whmCpanel(account!, module, fn, params, options);
        };

        switch (action) {
          case 'list': {
            const domains = await invoke('DomainInfo', 'list_domains');
            return {
              success: true,
              output: {
                profile: client.config.id,
                profileName: client.config.name,
                host: client.config.host,
                account,
                action,
                data: domains.data,
                warnings: domains.warnings,
              },
            };
          }
          case 'list_redirects': {
            const redirects = await invoke('Redirects', 'list_redirects');
            return {
              success: true,
              output: {
                profile: client.config.id,
                profileName: client.config.name,
                host: client.config.host,
                account,
                action,
                data: redirects.data,
                warnings: redirects.warnings,
              },
            };
          }
          case 'add_subdomain': {
            const domain = requireString(args.domain, 'domain').trim();
            const rootDomain = requireString(args.rootDomain, 'rootDomain').trim();
            const dir = asString(args.dir).trim() || undefined;
            const created = await invoke('SubDomain', 'addsubdomain', {
              domain,
              rootdomain: rootDomain,
              dir,
            }, { method: 'POST' });
            return {
              success: true,
              output: {
                profile: client.config.id,
                profileName: client.config.name,
                host: client.config.host,
                account,
                action,
                domain,
                rootDomain,
                dir: dir ?? null,
                data: created.data,
                warnings: created.warnings,
              },
            };
          }
          case 'delete_subdomain': {
            const domain = requireString(args.domain, 'domain').trim();
            const rootDomain = requireString(args.rootDomain, 'rootDomain').trim();
            const removed = await invoke('SubDomain', 'delsubdomain', {
              domain,
              rootdomain: rootDomain,
            }, { method: 'POST' });
            return {
              success: true,
              output: {
                profile: client.config.id,
                profileName: client.config.name,
                host: client.config.host,
                account,
                action,
                domain,
                rootDomain,
                data: removed.data,
                warnings: removed.warnings,
              },
            };
          }
          case 'add_redirect': {
            const domain = requireString(args.domain, 'domain').trim();
            const destination = requireString(args.destination, 'destination').trim();
            const redirectType = asString(args.redirectType, 'temporary').trim() || 'temporary';
            const redirectTarget = asString(args.dir).trim() || '/';
            const created = await invoke('Redirects', 'add_redirect', {
              domain,
              url: destination,
              redirect_type: redirectType,
              path: redirectTarget,
            }, { method: 'POST' });
            return {
              success: true,
              output: {
                profile: client.config.id,
                profileName: client.config.name,
                host: client.config.host,
                account,
                action,
                domain,
                destination,
                redirectType,
                path: redirectTarget,
                data: created.data,
                warnings: created.warnings,
              },
            };
          }
          case 'delete_redirect': {
            const redirectId = requireString(args.redirectId, 'redirectId').trim();
            const removed = await invoke('Redirects', 'delete_redirect', {
              id: redirectId,
            }, { method: 'POST' });
            return {
              success: true,
              output: {
                profile: client.config.id,
                profileName: client.config.name,
                host: client.config.host,
                account,
                action,
                redirectId,
                data: removed.data,
                warnings: removed.warnings,
              },
            };
          }
          default:
            return { success: false, error: `Unsupported action '${action}'.` };
        }
      } catch (err) {
        return { success: false, error: `cPanel domain request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cpanel_dns',
      description: 'Inspect or edit a cPanel account DNS zone via direct cPanel auth or a WHM bridge. Supports parse_zone and mass_edit_zone.',
      shortDescription: 'Parse or mass-edit a cPanel DNS zone.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id.' },
          action: { type: 'string', description: 'parse_zone or mass_edit_zone.' },
          account: { type: 'string', description: 'Target cPanel username when using a WHM profile.' },
          zone: { type: 'string', description: 'DNS zone name.' },
          serial: { type: 'number', description: 'Optional zone serial for mass_edit_zone.' },
          add: { type: 'array', description: 'Records to add as JSON-serializable strings/objects.' },
          edit: { type: 'array', description: 'Records to edit as JSON-serializable strings/objects.' },
          remove: { type: 'array', description: 'Record line numbers or identifiers to remove.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['parse_zone', 'mass_edit_zone'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use parse_zone or mass_edit_zone.' };
      }

      let account: string | undefined;
      let client: CpanelClient;
      try {
        ({ client, account } = await context.resolveCpanelAccountContext(requireString(args.profile, 'profile'), asString(args.account)));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const zone = requireString(args.zone, 'zone').trim();
      const method = action === 'parse_zone' ? 'GET' : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'cpanel_dns',
        action,
        account,
        zone,
      });

      const invoke = async (
        module: string,
        fn: string,
        params?: Record<string, string | number | boolean | undefined>,
        options?: { method?: 'GET' | 'POST' },
      ): Promise<NormalizedApiResponse> => {
        return client.config.type === 'cpanel'
          ? client.uapi(module, fn, params, options)
          : client.whmCpanel(account!, module, fn, params, options);
      };

      try {
        if (action === 'parse_zone') {
          const parsed = await invoke('DNS', 'parse_zone', { zone });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              zone,
              data: parsed.data,
              warnings: parsed.warnings,
            },
          };
        }

        const edited = await invoke('DNS', 'mass_edit_zone', {
          zone,
          serial: Number.isFinite(Number(args.serial)) ? Number(args.serial) : undefined,
          add: encodeJsonParamArray(args.add),
          edit: encodeJsonParamArray(args.edit),
          remove: encodeScalarArray(args.remove),
        }, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            account,
            action,
            zone,
            changes: {
              add: Array.isArray(args.add) ? args.add.length : 0,
              edit: Array.isArray(args.edit) ? args.edit.length : 0,
              remove: Array.isArray(args.remove) ? args.remove.length : 0,
            },
            data: edited.data,
            warnings: edited.warnings,
          },
        };
      } catch (err) {
        return { success: false, error: `cPanel DNS request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cpanel_backups',
      description: 'List account backups or trigger a full backup to the account home directory.',
      shortDescription: 'List backups or create a full account backup.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id.' },
          action: { type: 'string', description: 'list or create.' },
          account: { type: 'string', description: 'Target cPanel username when using a WHM profile.' },
          email: { type: 'string', description: 'Optional completion notification email for create.' },
          homedir: { type: 'string', description: 'include or skip for create.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'create'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list or create.' };
      }

      let account: string | undefined;
      let client: CpanelClient;
      try {
        ({ client, account } = await context.resolveCpanelAccountContext(requireString(args.profile, 'profile'), asString(args.account)));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const method = action === 'list' ? 'GET' : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'cpanel_backups',
        action,
        account,
      });

      const invoke = async (
        fn: string,
        params?: Record<string, string | number | boolean | undefined>,
        options?: { method?: 'GET' | 'POST' },
      ): Promise<NormalizedApiResponse> => {
        return client.config.type === 'cpanel'
          ? client.uapi('Backup', fn, params, options)
          : client.whmCpanel(account!, 'Backup', fn, params, options);
      };

      try {
        if (action === 'list') {
          const backups = await invoke('list_backups');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              data: backups.data,
              warnings: backups.warnings,
            },
          };
        }

        const email = asString(args.email).trim() || undefined;
        const homedir = asString(args.homedir, 'include').trim().toLowerCase() === 'skip' ? 'skip' : 'include';
        const created = await invoke('fullbackup_to_homedir', {
          email,
          homedir,
        }, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            account,
            action,
            email: email ?? null,
            homedir,
            data: created.data,
            warnings: created.warnings,
          },
        };
      } catch (err) {
        return { success: false, error: `cPanel backup request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cpanel_ssl',
      description: 'Inspect or manage cPanel account SSL certificates. Supports list_certs, fetch_best_for_domain, install_ssl, and delete_ssl.',
      shortDescription: 'List, inspect, install, or delete cPanel SSL certs.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id.' },
          action: { type: 'string', description: 'list_certs, fetch_best_for_domain, install_ssl, or delete_ssl.' },
          account: { type: 'string', description: 'Target cPanel username when using a WHM profile.' },
          domain: { type: 'string', description: 'Target domain.' },
          certificate: { type: 'string', description: 'Certificate PEM for install_ssl.' },
          privateKey: { type: 'string', description: 'Private key PEM for install_ssl.' },
          caBundle: { type: 'string', description: 'CA bundle PEM for install_ssl.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_certs', 'fetch_best_for_domain', 'install_ssl', 'delete_ssl'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_certs, fetch_best_for_domain, install_ssl, or delete_ssl.' };
      }

      let account: string | undefined;
      let client: CpanelClient;
      try {
        ({ client, account } = await context.resolveCpanelAccountContext(requireString(args.profile, 'profile'), asString(args.account)));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const method = (action === 'list_certs' || action === 'fetch_best_for_domain') ? 'GET' : 'POST';
      const domain = asString(args.domain).trim() || undefined;
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'cpanel_ssl',
        action,
        account,
        domain,
      });

      const invoke = async (
        fn: string,
        params?: Record<string, string | number | boolean | undefined>,
        options?: { method?: 'GET' | 'POST' },
      ): Promise<NormalizedApiResponse> => {
        return client.config.type === 'cpanel'
          ? client.uapi('SSL', fn, params, options)
          : client.whmCpanel(account!, 'SSL', fn, params, options);
      };

      try {
        if (action === 'list_certs') {
          const certs = await invoke('list_certs');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              data: sanitizeSslData(certs.data),
              warnings: certs.warnings,
            },
          };
        }
        if (action === 'fetch_best_for_domain') {
          const target = requireString(args.domain, 'domain').trim();
          const best = await invoke('fetch_best_for_domain', { domain: target });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              domain: target,
              data: sanitizeSslData(best.data),
              warnings: best.warnings,
            },
          };
        }
        if (action === 'install_ssl') {
          const target = requireString(args.domain, 'domain').trim();
          const installed = await invoke('install_ssl', {
            domain: target,
            cert: requireString(args.certificate, 'certificate'),
            key: requireString(args.privateKey, 'privateKey'),
            cabundle: asString(args.caBundle).trim() || undefined,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              account,
              action,
              domain: target,
              data: sanitizeSslData(installed.data),
              warnings: installed.warnings,
            },
          };
        }

        const target = requireString(args.domain, 'domain').trim();
        const deleted = await invoke('delete_ssl', { domain: target }, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            account,
            action,
            domain: target,
            data: sanitizeSslData(deleted.data),
            warnings: deleted.warnings,
          },
        };
      } catch (err) {
        return { success: false, error: `cPanel SSL request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'vercel_status',
      description: 'Summarize Vercel project and deployment activity for a configured account or team profile. Read-only.',
      shortDescription: 'Summarize Vercel projects and recent deployments.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.vercelProfiles id.' },
          limitProjects: { type: 'number', description: 'Maximum projects to sample (default: 10).' },
          limitDeployments: { type: 'number', description: 'Maximum deployments to sample (default: 10).' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: VercelClient;
      try {
        client = await context.createVercelClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const limitProjects = Math.max(1, Math.min(50, asNumber(args.limitProjects, 10)));
      const limitDeployments = Math.max(1, Math.min(50, asNumber(args.limitDeployments, 10)));

      context.guardAction(request, 'http_request', {
        url: context.describeVercelEndpoint(client.config),
        method: 'GET',
        tool: 'vercel_status',
      });

      try {
        const [projects, deployments] = await Promise.all([
          client.listProjects({ limit: limitProjects }),
          client.listDeployments({ limit: limitDeployments }),
        ]);
        const projectList = asArrayField(projects, 'projects');
        const deploymentList = asArrayField(deployments, 'deployments');
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeVercelEndpoint(client.config),
            scope: describeVercelScope(client.config),
            projectCount: projectList.length,
            deploymentCount: deploymentList.length,
            projects: projectList,
            deployments: deploymentList,
          },
        };
      } catch (err) {
        return { success: false, error: `Vercel status request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'vercel_projects',
      description: 'List, inspect, create, update, or delete Vercel projects.',
      shortDescription: 'Manage Vercel projects.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.vercelProfiles id.' },
          action: { type: 'string', description: 'list, get, create, update, or delete.' },
          project: { type: 'string', description: 'Project id or name for get/update/delete.' },
          name: { type: 'string', description: 'Project name shorthand for create/update.' },
          framework: { type: 'string', description: 'Optional framework preset for create/update.' },
          rootDirectory: { type: 'string', description: 'Optional root directory for create/update.' },
          publicSource: { type: 'boolean', description: 'Optional publicSource setting.' },
          settings: { type: 'object', description: 'Raw Vercel project payload fields to merge into create/update.' },
          limit: { type: 'number', description: 'Maximum projects to return for list (default: 20).' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'create', 'update', 'delete'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, create, update, or delete.' };
      }

      let client: VercelClient;
      try {
        client = await context.createVercelClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = action === 'list' || action === 'get'
        ? 'GET'
        : (action === 'delete' ? 'DELETE' : (action === 'update' ? 'PATCH' : 'POST'));
      context.guardAction(request, 'http_request', {
        url: context.describeVercelEndpoint(client.config),
        method,
        tool: 'vercel_projects',
        action,
        project: asString(args.project).trim() || undefined,
      });

      try {
        if (action === 'list') {
          const limit = Math.max(1, Math.min(100, asNumber(args.limit, 20)));
          const projects = await client.listProjects({ limit });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              data: projects,
            },
          };
        }

        const project = asString(args.project).trim();
        if (action === 'get') {
          const result = await client.getProject(project);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              data: result,
            },
          };
        }

        if (action === 'delete') {
          const result = await client.deleteProject(project);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              data: result,
            },
          };
        }

        const payload = buildVercelProjectPayload(args, context);
        const result = action === 'create'
          ? await client.createProject(payload)
          : await client.updateProject(project, payload);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeVercelEndpoint(client.config),
            scope: describeVercelScope(client.config),
            action,
            project: action === 'create' ? undefined : project,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Vercel project request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'vercel_deployments',
      description: 'List, inspect, create, cancel, or promote Vercel deployments.',
      shortDescription: 'Manage Vercel deployments.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.vercelProfiles id.' },
          action: { type: 'string', description: 'list, get, create, cancel, or promote.' },
          project: { type: 'string', description: 'Project id or name. Required for promote and shorthand create payloads.' },
          deploymentId: { type: 'string', description: 'Deployment id or deployment URL identifier for get/cancel/promote.' },
          limit: { type: 'number', description: 'Maximum deployments to return for list (default: 20).' },
          target: { type: 'string', description: 'Deployment target such as production or preview.' },
          deployment: { type: 'object', description: 'Raw deployment payload for create.' },
          files: { type: 'array', description: 'Optional files payload for create.' },
          meta: { type: 'object', description: 'Optional deployment metadata.' },
          gitSource: { type: 'object', description: 'Optional gitSource object for create.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'create', 'cancel', 'promote'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, create, cancel, or promote.' };
      }

      let client: VercelClient;
      try {
        client = await context.createVercelClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = action === 'list' || action === 'get' ? 'GET' : (action === 'cancel' ? 'PATCH' : 'POST');
      context.guardAction(request, 'http_request', {
        url: context.describeVercelEndpoint(client.config),
        method,
        tool: 'vercel_deployments',
        action,
        deploymentId: asString(args.deploymentId).trim() || undefined,
        project: asString(args.project).trim() || undefined,
      });

      try {
        if (action === 'list') {
          const limit = Math.max(1, Math.min(100, asNumber(args.limit, 20)));
          const result = await client.listDeployments({ limit });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              data: result,
            },
          };
        }

        const deploymentId = asString(args.deploymentId).trim();
        if (action === 'get') {
          const result = await client.getDeployment(deploymentId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              deploymentId,
              data: result,
            },
          };
        }

        if (action === 'cancel') {
          const result = await client.cancelDeployment(deploymentId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              deploymentId,
              data: result,
            },
          };
        }

        if (action === 'promote') {
          const project = requireString(args.project, 'project').trim();
          const result = await client.promoteDeployment(project, deploymentId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              deploymentId,
              data: result,
            },
          };
        }

        const payload = buildVercelDeploymentPayload(args, context);
        const result = await client.createDeployment(payload);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeVercelEndpoint(client.config),
            scope: describeVercelScope(client.config),
            action,
            project: asString(args.project).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Vercel deployment request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'vercel_domains',
      description: 'List, inspect, add, update, remove, or verify project domains on Vercel.',
      shortDescription: 'Manage Vercel project domains.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.vercelProfiles id.' },
          action: { type: 'string', description: 'list, get, add, update, remove, or verify.' },
          project: { type: 'string', description: 'Project id or name.' },
          domain: { type: 'string', description: 'Domain name for get/add/update/remove/verify.' },
          gitBranch: { type: 'string', description: 'Optional git branch for branch-specific domains.' },
          redirect: { type: 'string', description: 'Optional redirect target when adding or updating a domain.' },
          redirectStatusCode: { type: 'number', description: 'Optional redirect status code when adding or updating a domain.' },
          limit: { type: 'number', description: 'Optional list limit.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'add', 'update', 'remove', 'verify'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, add, update, remove, or verify.' };
      }

      let client: VercelClient;
      try {
        client = await context.createVercelClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const project = requireString(args.project, 'project').trim();
      const method = action === 'list' || action === 'get'
        ? 'GET'
        : action === 'remove'
          ? 'DELETE'
          : action === 'update'
            ? 'PATCH'
            : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeVercelEndpoint(client.config),
        method,
        tool: 'vercel_domains',
        action,
        project,
        domain: asString(args.domain).trim() || undefined,
      });

      try {
        if (action === 'list') {
          const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : undefined;
          const result = await client.listProjectDomains(project, { limit });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              data: result,
            },
          };
        }

        const domain = requireString(args.domain, 'domain').trim();
        if (action === 'get') {
          const result = await client.getProjectDomain(project, domain);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              domain,
              data: result,
            },
          };
        }
        if (action === 'remove') {
          const result = await client.removeProjectDomain(project, domain);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              domain,
              data: result,
            },
          };
        }
        if (action === 'verify') {
          const result = await client.verifyProjectDomain(project, domain);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              domain,
              data: result,
            },
          };
        }

        const payload = buildVercelDomainPayload(args, context, { includeName: action === 'add' });
        const result = action === 'update'
          ? await client.updateProjectDomain(project, domain, payload)
          : await client.addProjectDomain(project, payload);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeVercelEndpoint(client.config),
            scope: describeVercelScope(client.config),
            action,
            project,
            domain,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Vercel domain request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'vercel_env',
      description: 'List, create, update, or delete Vercel project environment variables. Secret values are redacted from tool output.',
      shortDescription: 'Manage Vercel project environment variables.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.vercelProfiles id.' },
          action: { type: 'string', description: 'list, create, update, or delete.' },
          project: { type: 'string', description: 'Project id or name.' },
          envId: { type: 'string', description: 'Environment variable id for update/delete.' },
          key: { type: 'string', description: 'Environment variable key shorthand for create/update.' },
          value: { type: 'string', description: 'Environment variable value shorthand for create/update.' },
          type: { type: 'string', description: 'plain or encrypted (default: encrypted).' },
          targets: { type: 'array', items: { type: 'string' }, description: 'Targets such as production, preview, development.' },
          gitBranch: { type: 'string', description: 'Optional git branch for branch-scoped env vars.' },
          customEnvironmentIds: { type: 'array', items: { type: 'string' }, description: 'Optional custom environment ids.' },
          upsert: { type: 'string', description: 'Vercel env upsert mode for create, e.g. true.' },
          env: { type: 'object', description: 'Raw Vercel env payload to use for create/update.' },
          decrypt: { type: 'boolean', description: 'Forward decrypt=true on list; response values remain redacted.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'create', 'update', 'delete'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, create, update, or delete.' };
      }

      let client: VercelClient;
      try {
        client = await context.createVercelClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const project = requireString(args.project, 'project').trim();
      const method = action === 'list' ? 'GET' : (action === 'update' ? 'PATCH' : (action === 'delete' ? 'DELETE' : 'POST'));
      context.guardAction(request, 'http_request', {
        url: context.describeVercelEndpoint(client.config),
        method,
        tool: 'vercel_env',
        action,
        project,
        envId: asString(args.envId).trim() || undefined,
      });

      try {
        if (action === 'list') {
          const result = await client.listProjectEnv(project, { decrypt: args.decrypt === true });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              data: redactVercelEnvData(result),
            },
          };
        }

        if (action === 'delete') {
          const envId = requireString(args.envId, 'envId').trim();
          const result = await client.deleteProjectEnv(project, envId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              project,
              envId,
              data: redactVercelEnvData(result),
            },
          };
        }

        const payload = buildVercelEnvPayload(args, context);
        const result = action === 'create'
          ? await client.createProjectEnv(project, payload, asString(args.upsert).trim() || undefined)
          : await client.updateProjectEnv(project, requireString(args.envId, 'envId').trim(), payload);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeVercelEndpoint(client.config),
            scope: describeVercelScope(client.config),
            action,
            project,
            envId: asString(args.envId).trim() || undefined,
            data: redactVercelEnvData(result),
          },
        };
      } catch (err) {
        return { success: false, error: `Vercel env request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'vercel_logs',
      description: 'Fetch Vercel runtime logs or deployment event streams. Read-only.',
      shortDescription: 'Fetch Vercel runtime logs or deployment events.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.vercelProfiles id.' },
          action: { type: 'string', description: 'runtime or events.' },
          project: { type: 'string', description: 'Project id or name for runtime logs.' },
          deploymentId: { type: 'string', description: 'Deployment id or URL identifier.' },
          limit: { type: 'number', description: 'Maximum items to return.' },
          since: { type: 'number', description: 'Start timestamp in milliseconds.' },
          until: { type: 'number', description: 'End timestamp in milliseconds.' },
          direction: { type: 'string', description: 'forward or backward for runtime logs.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['runtime', 'events'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use runtime or events.' };
      }

      let client: VercelClient;
      try {
        client = await context.createVercelClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      context.guardAction(request, 'http_request', {
        url: context.describeVercelEndpoint(client.config),
        method: 'GET',
        tool: 'vercel_logs',
        action,
        deploymentId: asString(args.deploymentId).trim() || undefined,
        project: asString(args.project).trim() || undefined,
      });

      try {
        if (action === 'events') {
          const deploymentId = requireString(args.deploymentId, 'deploymentId').trim();
          const result = await client.getDeploymentEvents(deploymentId, {
            limit: Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : undefined,
            since: Number.isFinite(Number(args.since)) ? Number(args.since) : undefined,
            until: Number.isFinite(Number(args.until)) ? Number(args.until) : undefined,
          });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeVercelEndpoint(client.config),
              scope: describeVercelScope(client.config),
              action,
              deploymentId,
              data: result,
            },
          };
        }

        const project = requireString(args.project, 'project').trim();
        const deploymentId = requireString(args.deploymentId, 'deploymentId').trim();
        const result = await client.getRuntimeLogs(project, deploymentId, {
          limit: Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : undefined,
          since: Number.isFinite(Number(args.since)) ? Number(args.since) : undefined,
          until: Number.isFinite(Number(args.until)) ? Number(args.until) : undefined,
          direction: asString(args.direction).trim() || undefined,
        });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeVercelEndpoint(client.config),
            scope: describeVercelScope(client.config),
            action,
            project,
            deploymentId,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Vercel log request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cf_status',
      description: 'Summarize Cloudflare token validity, optional account details, and zones. Read-only.',
      shortDescription: 'Summarize Cloudflare account and zone state.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cloudflareProfiles id.' },
          limit: { type: 'number', description: 'Maximum zones to return (default: 20).' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: CloudflareClient;
      try {
        client = await context.createCloudflareClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const limit = Math.max(1, Math.min(100, asNumber(args.limit, 20)));

      context.guardAction(request, 'http_request', {
        url: context.describeCloudflareEndpoint(client.config),
        method: 'GET',
        tool: 'cf_status',
      });

      try {
        const [token, account, zones] = await Promise.all([
          client.verifyToken(),
          client.config.accountId ? client.getAccount().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) : Promise.resolve(null),
          client.listZones({ per_page: limit }),
        ]);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeCloudflareEndpoint(client.config),
            accountId: client.config.accountId ?? null,
            defaultZoneId: client.config.defaultZoneId ?? null,
            token,
            account: isRecord(account) && !('error' in account) ? account : null,
            accountError: isRecord(account) && 'error' in account ? account.error : undefined,
            zones,
          },
        };
      } catch (err) {
        return { success: false, error: `Cloudflare status request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cf_dns',
      description: 'List, inspect, create, update, or delete Cloudflare DNS records.',
      shortDescription: 'Manage Cloudflare DNS records.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cloudflareProfiles id.' },
          action: { type: 'string', description: 'list, get, create, update, or delete.' },
          zoneId: { type: 'string', description: 'Zone id override.' },
          zone: { type: 'string', description: 'Zone name to resolve when zoneId is not provided.' },
          recordId: { type: 'string', description: 'DNS record id for get/update/delete.' },
          type: { type: 'string', description: 'Record type shorthand for create/update.' },
          name: { type: 'string', description: 'Record name shorthand for create/update.' },
          content: { type: 'string', description: 'Record content shorthand for create/update.' },
          ttl: { type: 'number', description: 'Optional TTL shorthand.' },
          proxied: { type: 'boolean', description: 'Optional proxied flag shorthand.' },
          priority: { type: 'number', description: 'Optional priority shorthand.' },
          comment: { type: 'string', description: 'Optional comment shorthand.' },
          record: { type: 'object', description: 'Raw DNS record payload for create/update.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'create', 'update', 'delete'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, create, update, or delete.' };
      }

      let client: CloudflareClient;
      try {
        client = await context.createCloudflareClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      let zoneId: string;
      try {
        zoneId = await client.resolveZoneId(asString(args.zoneId).trim() || asString(args.zone).trim() || undefined);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = action === 'list' || action === 'get' ? 'GET' : (action === 'delete' ? 'DELETE' : (action === 'update' ? 'PATCH' : 'POST'));
      context.guardAction(request, 'http_request', {
        url: context.describeCloudflareEndpoint(client.config),
        method,
        tool: 'cf_dns',
        action,
        zoneId,
        recordId: asString(args.recordId).trim() || undefined,
      });

      try {
        if (action === 'list') {
          const result = await client.listDnsRecords(zoneId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeCloudflareEndpoint(client.config),
              action,
              zoneId,
              data: result,
            },
          };
        }
        if (action === 'get') {
          const recordId = requireString(args.recordId, 'recordId').trim();
          const result = await client.getDnsRecord(zoneId, recordId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeCloudflareEndpoint(client.config),
              action,
              zoneId,
              recordId,
              data: result,
            },
          };
        }
        if (action === 'delete') {
          const recordId = requireString(args.recordId, 'recordId').trim();
          const result = await client.deleteDnsRecord(zoneId, recordId);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeCloudflareEndpoint(client.config),
              action,
              zoneId,
              recordId,
              data: result,
            },
          };
        }

        const payload = buildCloudflareDnsPayload(args, context);
        const result = action === 'create'
          ? await client.createDnsRecord(zoneId, payload)
          : await client.updateDnsRecord(zoneId, requireString(args.recordId, 'recordId').trim(), payload);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeCloudflareEndpoint(client.config),
            action,
            zoneId,
            recordId: asString(args.recordId).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Cloudflare DNS request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cf_ssl',
      description: 'Inspect or update key Cloudflare zone SSL/TLS settings.',
      shortDescription: 'Inspect or update Cloudflare SSL/TLS settings.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cloudflareProfiles id.' },
          action: { type: 'string', description: 'list_settings, get_setting, or update_setting.' },
          zoneId: { type: 'string', description: 'Zone id override.' },
          zone: { type: 'string', description: 'Zone name to resolve when zoneId is not provided.' },
          settingId: { type: 'string', description: 'Cloudflare setting id, e.g. ssl or min_tls_version.' },
          value: { description: 'New setting value for update_setting.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_settings', 'get_setting', 'update_setting'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_settings, get_setting, or update_setting.' };
      }

      let client: CloudflareClient;
      try {
        client = await context.createCloudflareClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      let zoneId: string;
      try {
        zoneId = await client.resolveZoneId(asString(args.zoneId).trim() || asString(args.zone).trim() || undefined);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = action === 'update_setting' ? 'PATCH' : 'GET';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudflareEndpoint(client.config),
        method,
        tool: 'cf_ssl',
        action,
        zoneId,
        settingId: asString(args.settingId).trim() || undefined,
      });

      try {
        if (action === 'list_settings') {
          const result = await Promise.all(
            DEFAULT_CLOUDFLARE_SSL_SETTING_IDS.map(async (settingId) => ({
              settingId,
              data: await client.getZoneSetting(zoneId, settingId),
            })),
          );
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              endpoint: context.describeCloudflareEndpoint(client.config),
              action,
              zoneId,
              settings: result,
            },
          };
        }

        const settingId = requireString(args.settingId, 'settingId').trim();
        const result = action === 'get_setting'
          ? await client.getZoneSetting(zoneId, settingId)
          : await client.updateZoneSetting(zoneId, settingId, args.value);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeCloudflareEndpoint(client.config),
            action,
            zoneId,
            settingId,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Cloudflare SSL request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'cf_cache',
      description: 'Purge Cloudflare zone cache globally or by files, tags, hosts, or prefixes.',
      shortDescription: 'Purge Cloudflare cache.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cloudflareProfiles id.' },
          action: { type: 'string', description: 'purge_everything, purge_files, purge_tags, purge_hosts, or purge_prefixes.' },
          zoneId: { type: 'string', description: 'Zone id override.' },
          zone: { type: 'string', description: 'Zone name to resolve when zoneId is not provided.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute URLs for file-based purge.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Cache tags to purge.' },
          hosts: { type: 'array', items: { type: 'string' }, description: 'Hostnames to purge.' },
          prefixes: { type: 'array', items: { type: 'string' }, description: 'URL prefixes to purge.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['purge_everything', 'purge_files', 'purge_tags', 'purge_hosts', 'purge_prefixes'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use purge_everything, purge_files, purge_tags, purge_hosts, or purge_prefixes.' };
      }

      let client: CloudflareClient;
      try {
        client = await context.createCloudflareClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      let zoneId: string;
      try {
        zoneId = await client.resolveZoneId(asString(args.zoneId).trim() || asString(args.zone).trim() || undefined);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      context.guardAction(request, 'http_request', {
        url: context.describeCloudflareEndpoint(client.config),
        method: 'POST',
        tool: 'cf_cache',
        action,
        zoneId,
      });

      try {
        const payload = buildCloudflareCachePurgePayload(args, context);
        const result = await client.purgeCache(zoneId, payload);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            endpoint: context.describeCloudflareEndpoint(client.config),
            action,
            zoneId,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Cloudflare cache request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_status',
      description: 'Inspect AWS caller identity, account aliases, and configured region. Read-only.',
      shortDescription: 'Inspect AWS caller identity and account aliases.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          includeAliases: { type: 'boolean', description: 'Include IAM account aliases (default: true).' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'sts');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const includeAliases = args.includeAliases !== false;
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'sts'),
        method: 'POST',
        tool: 'aws_status',
        region: client.config.region,
      });
      try {
        const [identity, aliases] = await Promise.all([
          client.getCallerIdentity(),
          includeAliases ? client.listAccountAliases().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) : Promise.resolve(null),
        ]);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            identity,
            aliases: isRecord(aliases) && !('error' in aliases) ? aliases : null,
            aliasesError: isRecord(aliases) && 'error' in aliases ? aliases.error : undefined,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS status request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_ec2_instances',
      description: 'List, describe, start, stop, or reboot EC2 instances.',
      shortDescription: 'Manage AWS EC2 instances.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list, describe, start, stop, or reboot.' },
          instanceIds: { type: 'array', items: { type: 'string' }, description: 'EC2 instance ids.' },
          state: { type: 'string', description: 'Optional instance-state-name filter for list.' },
          tagKey: { type: 'string', description: 'Optional tag filter key for list.' },
          tagValue: { type: 'string', description: 'Optional tag filter value for list.' },
          force: { type: 'boolean', description: 'Force stop when action=stop.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'describe', 'start', 'stop', 'reboot'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, describe, start, stop, or reboot.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'ec2');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const instanceIds = asStringArray(args.instanceIds);
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'ec2'),
        method: 'POST',
        tool: 'aws_ec2_instances',
        action,
        instanceIds,
        region: client.config.region,
      });
      try {
        if (action === 'list' || action === 'describe') {
          const result = await client.listEc2Instances({
            instanceIds: action === 'describe' ? instanceIds : undefined,
            state: asString(args.state).trim() || undefined,
            tagKey: asString(args.tagKey).trim() || undefined,
            tagValue: asString(args.tagValue).trim() || undefined,
          });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              instanceIds: instanceIds.length ? instanceIds : undefined,
              instances: flattenEc2Instances(result),
              data: result,
            },
          };
        }
        const result = action === 'start'
          ? await client.startEc2Instances(instanceIds)
          : action === 'stop'
            ? await client.stopEc2Instances(instanceIds, !!args.force)
            : await client.rebootEc2Instances(instanceIds);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            action,
            instanceIds,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS EC2 request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_ec2_security_groups',
      description: 'List or modify EC2 security group ingress rules.',
      shortDescription: 'List or mutate AWS EC2 security groups.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list, describe, authorize_ingress, or revoke_ingress.' },
          groupIds: { type: 'array', items: { type: 'string' }, description: 'Optional security group ids for list/describe.' },
          groupId: { type: 'string', description: 'Security group id for authorize/revoke.' },
          protocol: { type: 'string', description: 'Ingress protocol, e.g. tcp or -1.' },
          fromPort: { type: 'number', description: 'Optional from port.' },
          toPort: { type: 'number', description: 'Optional to port.' },
          cidr: { type: 'string', description: 'Optional CIDR, e.g. 0.0.0.0/0.' },
          description: { type: 'string', description: 'Optional rule description.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'describe', 'authorize_ingress', 'revoke_ingress'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, describe, authorize_ingress, or revoke_ingress.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'ec2');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'ec2'),
        method: 'POST',
        tool: 'aws_ec2_security_groups',
        action,
        groupId: asString(args.groupId).trim() || undefined,
      });
      try {
        if (action === 'list' || action === 'describe') {
          const result = await client.listSecurityGroups(asStringArray(args.groupIds));
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              data: result,
            },
          };
        }
        const permission = {
          groupId: requireString(args.groupId, 'groupId').trim(),
          protocol: requireString(args.protocol, 'protocol').trim(),
          fromPort: Number.isFinite(Number(args.fromPort)) ? Number(args.fromPort) : undefined,
          toPort: Number.isFinite(Number(args.toPort)) ? Number(args.toPort) : undefined,
          cidr: asString(args.cidr).trim() || undefined,
          description: asString(args.description).trim() || undefined,
        };
        const result = action === 'authorize_ingress'
          ? await client.authorizeSecurityGroupIngress(permission)
          : await client.revokeSecurityGroupIngress(permission);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            action,
            ...permission,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS EC2 security group request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_s3_buckets',
      description: 'List/create/delete S3 buckets, inspect objects, or put/delete object content.',
      shortDescription: 'Manage AWS S3 buckets and objects.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list_buckets, create_bucket, delete_bucket, list_objects, get_object, put_object, or delete_object.' },
          bucket: { type: 'string', description: 'Bucket name.' },
          key: { type: 'string', description: 'Object key.' },
          prefix: { type: 'string', description: 'Optional key prefix for list_objects.' },
          maxKeys: { type: 'number', description: 'Optional max keys for list_objects.' },
          body: { type: 'string', description: 'Object body text for put_object.' },
          contentType: { type: 'string', description: 'Optional content type for put_object.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_buckets', 'create_bucket', 'delete_bucket', 'list_objects', 'get_object', 'put_object', 'delete_object'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_buckets, create_bucket, delete_bucket, list_objects, get_object, put_object, or delete_object.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 's3');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 's3'),
        method: action === 'create_bucket'
          ? 'PUT'
          : action === 'delete_bucket' || action === 'delete_object'
            ? 'DELETE'
            : action === 'put_object'
              ? 'PUT'
              : 'POST',
        tool: 'aws_s3_buckets',
        action,
        bucket: asString(args.bucket).trim() || undefined,
        key: asString(args.key).trim() || undefined,
        region: client.config.region,
      });
      try {
        if (action === 'list_buckets') {
          const result = await client.listS3Buckets();
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              data: result,
            },
          };
        }
        const bucket = requireString(args.bucket, 'bucket').trim();
        if (action === 'create_bucket' || action === 'delete_bucket') {
          const result = action === 'create_bucket'
            ? await client.createS3Bucket(bucket)
            : await client.deleteS3Bucket(bucket);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              bucket,
              data: result,
            },
          };
        }
        if (action === 'list_objects') {
          const result = await client.listS3Objects(bucket, {
            prefix: asString(args.prefix).trim() || undefined,
            maxKeys: Number.isFinite(Number(args.maxKeys)) ? Number(args.maxKeys) : undefined,
          });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              bucket,
              data: result,
            },
          };
        }
        const key = requireString(args.key, 'key').trim();
        if (action === 'get_object') {
          const result = await client.getS3ObjectText(bucket, key);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              bucket,
              key,
              data: result,
            },
          };
        }
        const result = action === 'put_object'
          ? await client.putS3ObjectText(bucket, key, requireString(args.body, 'body'), asString(args.contentType).trim() || undefined)
          : await client.deleteS3Object(bucket, key);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            action,
            bucket,
            key,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS S3 request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_route53',
      description: 'List Route53 hosted zones, inspect records, or apply change batches.',
      shortDescription: 'Manage AWS Route53 zones and records.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list_zones, list_records, or change_records.' },
          hostedZoneId: { type: 'string', description: 'Hosted zone id for record operations.' },
          startName: { type: 'string', description: 'Optional start record name for list_records.' },
          maxItems: { type: 'string', description: 'Optional max items for list_records.' },
          changes: { type: 'array', description: 'Raw Route53 change batch entries.' },
          changeAction: { type: 'string', description: 'Shorthand action for a single change, e.g. UPSERT.' },
          type: { type: 'string', description: 'Record type shorthand for a single change.' },
          name: { type: 'string', description: 'Record name shorthand for a single change.' },
          ttl: { type: 'number', description: 'TTL shorthand for a single change.' },
          records: { type: 'array', items: { type: 'string' }, description: 'Resource record values shorthand for a single change.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_zones', 'list_records', 'change_records'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_zones, list_records, or change_records.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'route53');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'route53'),
        method: 'POST',
        tool: 'aws_route53',
        action,
        hostedZoneId: asString(args.hostedZoneId).trim() || undefined,
      });
      try {
        if (action === 'list_zones') {
          const result = await client.listHostedZones();
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              action,
              data: result,
            },
          };
        }
        const hostedZoneId = requireString(args.hostedZoneId, 'hostedZoneId').trim();
        if (action === 'list_records') {
          const result = await client.listRoute53Records(hostedZoneId, {
            startName: asString(args.startName).trim() || undefined,
            maxItems: Number.isFinite(Number(args.maxItems)) ? Number(args.maxItems) : undefined,
          });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              action,
              hostedZoneId,
              data: result,
            },
          };
        }
        const changes = buildRoute53Changes(args, context);
        const result = await client.changeRoute53Records(hostedZoneId, changes);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            action,
            hostedZoneId,
            changes,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS Route53 request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_lambda',
      description: 'List, inspect, or invoke Lambda functions.',
      shortDescription: 'Manage AWS Lambda functions.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list, get, or invoke.' },
          functionName: { type: 'string', description: 'Lambda function name or ARN.' },
          maxItems: { type: 'number', description: 'Optional max items for list.' },
          payload: { type: 'string', description: 'JSON payload string for invoke.' },
          invocationType: { type: 'string', description: 'RequestResponse, Event, or DryRun.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'invoke'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, or invoke.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'lambda');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'lambda'),
        method: 'POST',
        tool: 'aws_lambda',
        action,
        functionName: asString(args.functionName).trim() || undefined,
        region: client.config.region,
      });
      try {
        if (action === 'list') {
          const result = await client.listLambdaFunctions(Number.isFinite(Number(args.maxItems)) ? Number(args.maxItems) : undefined);
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              region: client.config.region,
              action,
              data: result,
            },
          };
        }
        const functionName = requireString(args.functionName, 'functionName').trim();
        const result = action === 'get'
          ? await client.getLambdaFunction(functionName)
          : await client.invokeLambda(functionName, {
            payload: asString(args.payload).trim() || undefined,
            invocationType: asString(args.invocationType).trim() || undefined,
          });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            action,
            functionName,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS Lambda request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_cloudwatch',
      description: 'Inspect CloudWatch metrics, alarms, or log events. Read-only.',
      shortDescription: 'Inspect AWS CloudWatch metrics, alarms, and logs.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'metrics, alarms, or logs.' },
          namespace: { type: 'string', description: 'Optional metric namespace.' },
          metricName: { type: 'string', description: 'Optional metric name.' },
          dimensions: { type: 'array', description: 'Optional metric dimensions [{Name,Value}] or name=value strings.' },
          alarmNamePrefix: { type: 'string', description: 'Optional alarm name prefix.' },
          logGroupName: { type: 'string', description: 'Log group name for logs action.' },
          filterPattern: { type: 'string', description: 'Optional CloudWatch Logs filter pattern.' },
          startTime: { type: 'number', description: 'Optional start time epoch ms.' },
          endTime: { type: 'number', description: 'Optional end time epoch ms.' },
          limit: { type: 'number', description: 'Optional max log events.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['metrics', 'alarms', 'logs'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use metrics, alarms, or logs.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), action === 'logs' ? 'cloudwatchLogs' : 'cloudwatch');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, action === 'logs' ? 'cloudwatchLogs' : 'cloudwatch'),
        method: 'POST',
        tool: 'aws_cloudwatch',
        action,
        region: client.config.region,
        logGroupName: asString(args.logGroupName).trim() || undefined,
      });
      try {
        const result = action === 'metrics'
          ? await client.listMetrics({
            namespace: asString(args.namespace).trim() || undefined,
            metricName: asString(args.metricName).trim() || undefined,
            dimensions: buildCloudWatchDimensions(args.dimensions, context),
          })
          : action === 'alarms'
            ? await client.describeAlarms(asString(args.alarmNamePrefix).trim() || undefined)
            : await client.filterLogEvents({
              logGroupName: requireString(args.logGroupName, 'logGroupName').trim(),
              filterPattern: asString(args.filterPattern).trim() || undefined,
              startTime: Number.isFinite(Number(args.startTime)) ? Number(args.startTime) : undefined,
              endTime: Number.isFinite(Number(args.endTime)) ? Number(args.endTime) : undefined,
              limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined,
            });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            action,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS CloudWatch request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_rds',
      description: 'List, start, stop, or reboot RDS DB instances.',
      shortDescription: 'Manage AWS RDS DB instances.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list, start, stop, or reboot.' },
          dbInstanceIdentifier: { type: 'string', description: 'DB instance identifier.' },
          forceFailover: { type: 'boolean', description: 'Force failover on reboot for Multi-AZ instances.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'start', 'stop', 'reboot'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, start, stop, or reboot.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'rds');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'rds'),
        method: 'POST',
        tool: 'aws_rds',
        action,
        dbInstanceIdentifier: asString(args.dbInstanceIdentifier).trim() || undefined,
        region: client.config.region,
      });
      try {
        const result = action === 'list'
          ? await client.listRdsInstances()
          : action === 'start'
            ? await client.startRdsInstance(requireString(args.dbInstanceIdentifier, 'dbInstanceIdentifier').trim())
            : action === 'stop'
              ? await client.stopRdsInstance(requireString(args.dbInstanceIdentifier, 'dbInstanceIdentifier').trim())
              : await client.rebootRdsInstance(requireString(args.dbInstanceIdentifier, 'dbInstanceIdentifier').trim(), !!args.forceFailover);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            region: client.config.region,
            action,
            dbInstanceIdentifier: asString(args.dbInstanceIdentifier).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS RDS request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_iam',
      description: 'List IAM users, roles, or policies. Read-only.',
      shortDescription: 'Inspect AWS IAM users, roles, or policies.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          action: { type: 'string', description: 'list_users, list_roles, or list_policies.' },
          maxItems: { type: 'number', description: 'Optional maximum results.' },
          scope: { type: 'string', description: 'Policy scope for list_policies: AWS, Local, or All.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_users', 'list_roles', 'list_policies'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_users, list_roles, or list_policies.' };
      }
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'iam');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'iam'),
        method: 'POST',
        tool: 'aws_iam',
        action,
      });
      try {
        const maxItems = Number.isFinite(Number(args.maxItems)) ? Number(args.maxItems) : undefined;
        const result = action === 'list_users'
          ? await client.listIamUsers(maxItems)
          : action === 'list_roles'
            ? await client.listIamRoles(maxItems)
            : await client.listIamPolicies({ scope: asString(args.scope).trim() || undefined, maxItems });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            action,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS IAM request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'aws_costs',
      description: 'Query AWS Cost Explorer cost and usage summaries. Read-only.',
      shortDescription: 'Inspect AWS cost and usage summaries.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.awsProfiles id.' },
          timePeriod: { type: 'object', description: 'Time period with start and end YYYY-MM-DD.' },
          granularity: { type: 'string', description: 'DAILY, MONTHLY, or HOURLY (default: MONTHLY).' },
          metrics: { type: 'array', items: { type: 'string' }, description: 'Metrics such as UnblendedCost or UsageQuantity.' },
          groupBy: { type: 'array', description: 'Optional groupBy entries [{Type,Key}] or Type:Key strings.' },
        },
        required: ['profile', 'timePeriod'],
      },
    },
    async (args, request) => {
      let client: AwsClient;
      try {
        client = await context.createAwsClient(requireString(args.profile, 'profile'), 'costExplorer');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAwsEndpoint(client.config, 'costExplorer'),
        method: 'POST',
        tool: 'aws_costs',
      });
      try {
        const result = await client.getCostAndUsage({
          timePeriod: buildAwsCostTimePeriod(args.timePeriod, context),
          granularity: asString(args.granularity, 'MONTHLY').trim().toUpperCase() || 'MONTHLY',
          metrics: asStringArray(args.metrics).length ? asStringArray(args.metrics) : ['UnblendedCost'],
          groupBy: buildAwsCostGroupBy(args.groupBy, context),
        });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            action: 'get_cost_and_usage',
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `AWS costs request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'gcp_status',
      description: 'Inspect GCP project identity and enabled services. Read-only.',
      shortDescription: 'Inspect GCP project metadata and enabled services.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.gcpProfiles id.' },
          includeServices: { type: 'boolean', description: 'Include enabled services list (default: true).' },
          servicesPageSize: { type: 'number', description: 'Optional enabled-services page size.' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: GcpClient;
      try {
        client = await context.createGcpClient(requireString(args.profile, 'profile'), 'cloudResourceManager');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const includeServices = args.includeServices !== false;
      context.guardAction(request, 'http_request', {
        url: context.describeGcpEndpoint(client.config, 'cloudResourceManager'),
        method: 'GET',
        tool: 'gcp_status',
        projectId: client.config.projectId,
      });
      try {
        const [project, services] = await Promise.all([
          client.getProject(),
          includeServices
            ? client.listEnabledServices(Number.isFinite(Number(args.servicesPageSize)) ? Number(args.servicesPageSize) : undefined)
            : Promise.resolve(null),
        ]);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            projectId: client.config.projectId,
            project,
            services,
          },
        };
      } catch (err) {
        return { success: false, error: `GCP status request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'gcp_compute',
      description: 'List, inspect, start, stop, or reset Compute Engine VM instances.',
      shortDescription: 'Manage GCP Compute Engine VM instances.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.gcpProfiles id.' },
          action: { type: 'string', description: 'list, get, start, stop, or reset.' },
          zone: { type: 'string', description: 'Zone for get/start/stop/reset.' },
          instance: { type: 'string', description: 'Instance name for get/start/stop/reset.' },
          filter: { type: 'string', description: 'Optional Compute Engine filter for list.' },
          maxResults: { type: 'number', description: 'Optional max results for list.' },
          discardLocalSsd: { type: 'boolean', description: 'Optional discardLocalSsd for stop.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'start', 'stop', 'reset'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, start, stop, or reset.' };
      }
      let client: GcpClient;
      try {
        client = await context.createGcpClient(requireString(args.profile, 'profile'), 'compute');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeGcpEndpoint(client.config, 'compute'),
        method: action === 'list' || action === 'get' ? 'GET' : 'POST',
        tool: 'gcp_compute',
        action,
        projectId: client.config.projectId,
        zone: asString(args.zone).trim() || undefined,
        instance: asString(args.instance).trim() || undefined,
      });
      try {
        const zone = asString(args.zone).trim();
        const instance = asString(args.instance).trim();
        const result = action === 'list'
          ? await client.listComputeInstances({
            filter: asString(args.filter).trim() || undefined,
            maxResults: Number.isFinite(Number(args.maxResults)) ? Number(args.maxResults) : undefined,
          })
          : action === 'get'
            ? await client.getComputeInstance(zone, instance)
            : action === 'start'
              ? await client.startComputeInstance(zone, instance)
              : action === 'stop'
                ? await client.stopComputeInstance(zone, instance, args.discardLocalSsd === undefined ? undefined : !!args.discardLocalSsd)
                : await client.resetComputeInstance(zone, instance);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            projectId: client.config.projectId,
            action,
            zone: zone || undefined,
            instance: instance || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `GCP compute request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'gcp_cloud_run',
      description: 'List Cloud Run services/revisions, inspect a service, update traffic, or delete a service.',
      shortDescription: 'Inspect or adjust GCP Cloud Run services.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.gcpProfiles id.' },
          action: { type: 'string', description: 'list_services, get_service, list_revisions, update_traffic, or delete_service.' },
          location: { type: 'string', description: 'Region/location. Falls back to profile default.' },
          service: { type: 'string', description: 'Cloud Run service name for get_service/update_traffic/delete_service.' },
          filter: { type: 'string', description: 'Optional filter for list_revisions.' },
          pageSize: { type: 'number', description: 'Optional max results.' },
          traffic: { type: 'array', description: 'Traffic targets for update_traffic.' },
          etag: { type: 'string', description: 'Optional etag for update_traffic concurrency control.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_services', 'get_service', 'list_revisions', 'update_traffic', 'delete_service'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_services, get_service, list_revisions, update_traffic, or delete_service.' };
      }
      let client: GcpClient;
      try {
        client = await context.createGcpClient(requireString(args.profile, 'profile'), 'run');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const location = context.resolveGcpLocation(args.location, client.config.id);
      context.guardAction(request, 'http_request', {
        url: context.describeGcpEndpoint(client.config, 'run'),
        method: action === 'update_traffic' ? 'PATCH' : action === 'delete_service' ? 'DELETE' : 'GET',
        tool: 'gcp_cloud_run',
        action,
        projectId: client.config.projectId,
        location,
        service: asString(args.service).trim() || undefined,
      });
      try {
        const result = action === 'list_services'
          ? await client.listCloudRunServices(location, Number.isFinite(Number(args.pageSize)) ? Number(args.pageSize) : undefined)
          : action === 'get_service'
            ? await client.getCloudRunService(location, requireString(args.service, 'service').trim())
            : action === 'list_revisions'
              ? await client.listCloudRunRevisions(
                location,
                asString(args.filter).trim() || undefined,
                Number.isFinite(Number(args.pageSize)) ? Number(args.pageSize) : undefined,
              )
              : action === 'delete_service'
                ? await client.deleteCloudRunService(location, requireString(args.service, 'service').trim())
                : await client.updateCloudRunTraffic(
                  location,
                  requireString(args.service, 'service').trim(),
                  Array.isArray(args.traffic) ? args.traffic : [],
                  asString(args.etag).trim() || undefined,
                );
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            projectId: client.config.projectId,
            action,
            location,
            service: asString(args.service).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `GCP Cloud Run request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'gcp_storage',
      description: 'List/create/delete Cloud Storage buckets or read/write object text.',
      shortDescription: 'Manage GCP Cloud Storage buckets and objects.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.gcpProfiles id.' },
          action: { type: 'string', description: 'list_buckets, create_bucket, delete_bucket, list_objects, get_object, put_object, or delete_object.' },
          bucket: { type: 'string', description: 'Bucket name.' },
          object: { type: 'string', description: 'Object name/path.' },
          location: { type: 'string', description: 'Optional bucket location for create_bucket.' },
          storageClass: { type: 'string', description: 'Optional bucket storage class for create_bucket.' },
          prefix: { type: 'string', description: 'Optional object prefix for list_objects.' },
          maxResults: { type: 'number', description: 'Optional max results.' },
          body: { type: 'string', description: 'Object body text for put_object.' },
          contentType: { type: 'string', description: 'Optional content type for put_object.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_buckets', 'create_bucket', 'delete_bucket', 'list_objects', 'get_object', 'put_object', 'delete_object'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_buckets, create_bucket, delete_bucket, list_objects, get_object, put_object, or delete_object.' };
      }
      let client: GcpClient;
      try {
        client = await context.createGcpClient(requireString(args.profile, 'profile'), 'storage');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeGcpEndpoint(client.config, 'storage'),
        method: action === 'create_bucket' || action === 'put_object'
          ? 'POST'
          : action === 'delete_bucket' || action === 'delete_object'
            ? 'DELETE'
            : 'GET',
        tool: 'gcp_storage',
        action,
        projectId: client.config.projectId,
        bucket: asString(args.bucket).trim() || undefined,
        object: asString(args.object).trim() || undefined,
      });
      try {
        const bucket = asString(args.bucket).trim();
        const objectName = asString(args.object).trim();
        const result = action === 'list_buckets'
          ? await client.listStorageBuckets(Number.isFinite(Number(args.maxResults)) ? Number(args.maxResults) : undefined)
          : action === 'create_bucket'
            ? await client.createStorageBucket(
              bucket,
              asString(args.location).trim() || undefined,
              asString(args.storageClass).trim() || undefined,
            )
            : action === 'delete_bucket'
              ? await client.deleteStorageBucket(bucket)
          : action === 'list_objects'
            ? await client.listStorageObjects(bucket, {
              prefix: asString(args.prefix).trim() || undefined,
              maxResults: Number.isFinite(Number(args.maxResults)) ? Number(args.maxResults) : undefined,
            })
            : action === 'get_object'
              ? await client.getStorageObjectText(bucket, objectName)
              : action === 'put_object'
                ? await client.putStorageObjectText(bucket, objectName, requireString(args.body, 'body'), asString(args.contentType).trim() || undefined)
                : await client.deleteStorageObject(bucket, objectName);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            projectId: client.config.projectId,
            action,
            bucket: bucket || undefined,
            object: objectName || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `GCP storage request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'gcp_dns',
      description: 'List Cloud DNS managed zones/records or apply record-set changes.',
      shortDescription: 'Manage GCP Cloud DNS zones and record sets.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.gcpProfiles id.' },
          action: { type: 'string', description: 'list_zones, list_records, or change_records.' },
          managedZone: { type: 'string', description: 'Managed zone name for records/change operations.' },
          dnsName: { type: 'string', description: 'Optional DNS name filter for list_zones.' },
          name: { type: 'string', description: 'Optional record name for list_records.' },
          type: { type: 'string', description: 'Optional record type for list_records.' },
          maxResults: { type: 'number', description: 'Optional max results.' },
          additions: { type: 'array', description: 'Cloud DNS additions array for change_records.' },
          deletions: { type: 'array', description: 'Cloud DNS deletions array for change_records.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_zones', 'list_records', 'change_records'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_zones, list_records, or change_records.' };
      }
      let client: GcpClient;
      try {
        client = await context.createGcpClient(requireString(args.profile, 'profile'), 'dns');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeGcpEndpoint(client.config, 'dns'),
        method: action === 'change_records' ? 'POST' : 'GET',
        tool: 'gcp_dns',
        action,
        projectId: client.config.projectId,
        managedZone: asString(args.managedZone).trim() || undefined,
      });
      try {
        const result = action === 'list_zones'
          ? await client.listDnsZones({
            dnsName: asString(args.dnsName).trim() || undefined,
            maxResults: Number.isFinite(Number(args.maxResults)) ? Number(args.maxResults) : undefined,
          })
          : action === 'list_records'
            ? await client.listDnsRecordSets(requireString(args.managedZone, 'managedZone').trim(), {
              name: asString(args.name).trim() || undefined,
              type: asString(args.type).trim() || undefined,
              maxResults: Number.isFinite(Number(args.maxResults)) ? Number(args.maxResults) : undefined,
            })
            : await client.changeDnsRecordSets(requireString(args.managedZone, 'managedZone').trim(), {
              additions: normalizeObjectArray(args.additions),
              deletions: normalizeObjectArray(args.deletions),
            });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            projectId: client.config.projectId,
            action,
            managedZone: asString(args.managedZone).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `GCP DNS request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'gcp_logs',
      description: 'Query Cloud Logging entries for a project. Read-only.',
      shortDescription: 'Inspect GCP Cloud Logging entries.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.gcpProfiles id.' },
          filter: { type: 'string', description: 'Optional Cloud Logging filter expression.' },
          resourceNames: { type: 'array', items: { type: 'string' }, description: 'Optional resource names. Defaults to projects/<projectId>.' },
          pageSize: { type: 'number', description: 'Optional max results.' },
          orderBy: { type: 'string', description: 'Optional sort order, e.g. timestamp desc.' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: GcpClient;
      try {
        client = await context.createGcpClient(requireString(args.profile, 'profile'), 'logging');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeGcpEndpoint(client.config, 'logging'),
        method: 'POST',
        tool: 'gcp_logs',
        projectId: client.config.projectId,
      });
      try {
        const resourceNames = asStringArray(args.resourceNames).length
          ? asStringArray(args.resourceNames)
          : [`projects/${client.config.projectId}`];
        const result = await client.listLogEntries({
          resourceNames,
          filter: asString(args.filter).trim() || undefined,
          pageSize: Number.isFinite(Number(args.pageSize)) ? Number(args.pageSize) : undefined,
          orderBy: asString(args.orderBy).trim() || undefined,
        });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            projectId: client.config.projectId,
            resourceNames,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `GCP logs request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'azure_status',
      description: 'Inspect Azure subscription details and resource groups. Read-only.',
      shortDescription: 'Inspect Azure subscription and resource groups.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.azureProfiles id.' },
          includeResourceGroups: { type: 'boolean', description: 'Include resource group list (default: true).' },
          top: { type: 'number', description: 'Optional max resource groups.' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: AzureClient;
      try {
        client = await context.createAzureClient(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const includeResourceGroups = args.includeResourceGroups !== false;
      context.guardAction(request, 'http_request', {
        url: context.describeAzureEndpoint(client.config, 'management'),
        method: 'GET',
        tool: 'azure_status',
        subscriptionId: client.config.subscriptionId,
      });
      try {
        const [subscription, resourceGroups] = await Promise.all([
          client.getSubscription(),
          includeResourceGroups
            ? client.listResourceGroups(Number.isFinite(Number(args.top)) ? Number(args.top) : undefined)
            : Promise.resolve(null),
        ]);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            subscriptionId: client.config.subscriptionId,
            tenantId: client.config.tenantId,
            defaultResourceGroup: client.config.defaultResourceGroup,
            subscription,
            resourceGroups,
          },
        };
      } catch (err) {
        return { success: false, error: `Azure status request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'azure_vms',
      description: 'List, inspect, start, stop, restart, or deallocate Azure VMs.',
      shortDescription: 'Manage Azure virtual machines.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.azureProfiles id.' },
          action: { type: 'string', description: 'list, get, start, stop, restart, or deallocate.' },
          resourceGroup: { type: 'string', description: 'Resource group. Falls back to profile default.' },
          vmName: { type: 'string', description: 'VM name for get/start/stop/restart/deallocate.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'start', 'stop', 'restart', 'deallocate'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, start, stop, restart, or deallocate.' };
      }
      let client: AzureClient;
      try {
        client = await context.createAzureClient(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const resourceGroup = context.resolveAzureResourceGroup(args.resourceGroup, client.config.id, action === 'list' ? false : true);
      context.guardAction(request, 'http_request', {
        url: context.describeAzureEndpoint(client.config, 'management'),
        method: action === 'list' || action === 'get' ? 'GET' : 'POST',
        tool: 'azure_vms',
        action,
        subscriptionId: client.config.subscriptionId,
        resourceGroup: resourceGroup || undefined,
        vmName: asString(args.vmName).trim() || undefined,
      });
      try {
        const vmName = asString(args.vmName).trim();
        const result = action === 'list'
          ? await client.listVms(resourceGroup || undefined)
          : action === 'get'
            ? await client.getVm(resourceGroup, vmName)
            : action === 'start'
              ? await client.startVm(resourceGroup, vmName)
              : action === 'stop'
                ? await client.powerOffVm(resourceGroup, vmName)
                : action === 'restart'
                  ? await client.restartVm(resourceGroup, vmName)
                  : await client.deallocateVm(resourceGroup, vmName);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            subscriptionId: client.config.subscriptionId,
            action,
            resourceGroup: resourceGroup || undefined,
            vmName: vmName || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Azure VM request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'azure_app_service',
      description: 'List, inspect, inspect config, restart, or delete Azure Web Apps.',
      shortDescription: 'Manage Azure App Service web apps.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.azureProfiles id.' },
          action: { type: 'string', description: 'list, get, config, restart, or delete.' },
          resourceGroup: { type: 'string', description: 'Resource group. Falls back to profile default.' },
          name: { type: 'string', description: 'Web app name.' },
          softRestart: { type: 'boolean', description: 'Optional softRestart for restart.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'get', 'config', 'restart', 'delete'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, get, config, restart, or delete.' };
      }
      let client: AzureClient;
      try {
        client = await context.createAzureClient(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const resourceGroup = context.resolveAzureResourceGroup(args.resourceGroup, client.config.id, action === 'list' ? false : true);
      context.guardAction(request, 'http_request', {
        url: context.describeAzureEndpoint(client.config, 'management'),
        method: action === 'restart' ? 'POST' : action === 'delete' ? 'DELETE' : 'GET',
        tool: 'azure_app_service',
        action,
        subscriptionId: client.config.subscriptionId,
        resourceGroup: resourceGroup || undefined,
        name: asString(args.name).trim() || undefined,
      });
      try {
        const name = asString(args.name).trim();
        const result = action === 'list'
          ? await client.listWebApps(resourceGroup || undefined)
          : action === 'get'
            ? await client.getWebApp(resourceGroup, name)
            : action === 'config'
              ? await client.getWebAppConfig(resourceGroup, name)
              : action === 'delete'
                ? await client.deleteWebApp(resourceGroup, name)
                : await client.restartWebApp(resourceGroup, name, args.softRestart === undefined ? undefined : !!args.softRestart);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            subscriptionId: client.config.subscriptionId,
            action,
            resourceGroup: resourceGroup || undefined,
            name: name || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Azure App Service request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'azure_storage',
      description: 'List storage accounts, create/delete containers, list blobs, or upload/delete blob text.',
      shortDescription: 'Manage Azure Storage accounts and blobs.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.azureProfiles id.' },
          action: { type: 'string', description: 'list_accounts, list_containers, create_container, delete_container, list_blobs, put_blob, or delete_blob.' },
          resourceGroup: { type: 'string', description: 'Optional resource group filter for list_accounts.' },
          accountName: { type: 'string', description: 'Storage account name for blob actions.' },
          container: { type: 'string', description: 'Container name for container/blob actions.' },
          blobName: { type: 'string', description: 'Blob name/path.' },
          prefix: { type: 'string', description: 'Optional blob prefix for list_blobs.' },
          body: { type: 'string', description: 'Blob body text for put_blob.' },
          contentType: { type: 'string', description: 'Optional content type for put_blob.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_accounts', 'list_containers', 'create_container', 'delete_container', 'list_blobs', 'put_blob', 'delete_blob'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_accounts, list_containers, create_container, delete_container, list_blobs, put_blob, or delete_blob.' };
      }
      let client: AzureClient;
      try {
        client = await context.createAzureClient(requireString(args.profile, 'profile'), action === 'list_accounts' ? 'management' : 'blob');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAzureEndpoint(client.config, action === 'list_accounts' ? 'management' : 'blob', asString(args.accountName).trim() || undefined),
        method: action === 'create_container' || action === 'put_blob'
          ? 'PUT'
          : action === 'delete_container' || action === 'delete_blob'
            ? 'DELETE'
            : 'GET',
        tool: 'azure_storage',
        action,
        subscriptionId: client.config.subscriptionId,
        accountName: asString(args.accountName).trim() || undefined,
        container: asString(args.container).trim() || undefined,
        blobName: asString(args.blobName).trim() || undefined,
      });
      try {
        const result = action === 'list_accounts'
          ? await client.listStorageAccounts(asString(args.resourceGroup).trim() || undefined)
          : action === 'list_containers'
            ? await client.listBlobContainers(requireString(args.accountName, 'accountName').trim())
            : action === 'create_container'
              ? await client.createBlobContainer(
                requireString(args.accountName, 'accountName').trim(),
                requireString(args.container, 'container').trim(),
              )
              : action === 'delete_container'
                ? await client.deleteBlobContainer(
                  requireString(args.accountName, 'accountName').trim(),
                  requireString(args.container, 'container').trim(),
                )
            : action === 'list_blobs'
              ? await client.listBlobs(
                requireString(args.accountName, 'accountName').trim(),
                requireString(args.container, 'container').trim(),
                asString(args.prefix).trim() || undefined,
              )
              : action === 'put_blob'
                ? await client.putBlobText(
                  requireString(args.accountName, 'accountName').trim(),
                  requireString(args.container, 'container').trim(),
                  requireString(args.blobName, 'blobName').trim(),
                  requireString(args.body, 'body'),
                  asString(args.contentType).trim() || undefined,
                )
                : await client.deleteBlob(
                  requireString(args.accountName, 'accountName').trim(),
                  requireString(args.container, 'container').trim(),
                  requireString(args.blobName, 'blobName').trim(),
                );
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            subscriptionId: client.config.subscriptionId,
            action,
            accountName: asString(args.accountName).trim() || undefined,
            container: asString(args.container).trim() || undefined,
            blobName: asString(args.blobName).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Azure Storage request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'azure_dns',
      description: 'List Azure DNS zones/records or upsert/delete record sets.',
      shortDescription: 'Manage Azure DNS zones and record sets.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.azureProfiles id.' },
          action: { type: 'string', description: 'list_zones, list_records, upsert_record_set, or delete_record_set.' },
          resourceGroup: { type: 'string', description: 'Resource group. Falls back to profile default.' },
          zoneName: { type: 'string', description: 'DNS zone name.' },
          recordType: { type: 'string', description: 'Record type for record-set operations, e.g. A or TXT.' },
          relativeRecordSetName: { type: 'string', description: 'Relative record-set name, e.g. www or @.' },
          recordSet: { type: 'object', description: 'Raw Azure DNS record-set payload for upsert_record_set.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_zones', 'list_records', 'upsert_record_set', 'delete_record_set'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list_zones, list_records, upsert_record_set, or delete_record_set.' };
      }
      let client: AzureClient;
      try {
        client = await context.createAzureClient(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const resourceGroup = context.resolveAzureResourceGroup(args.resourceGroup, client.config.id);
      context.guardAction(request, 'http_request', {
        url: context.describeAzureEndpoint(client.config, 'management'),
        method: action === 'upsert_record_set' ? 'PUT' : action === 'delete_record_set' ? 'DELETE' : 'GET',
        tool: 'azure_dns',
        action,
        subscriptionId: client.config.subscriptionId,
        resourceGroup,
        zoneName: asString(args.zoneName).trim() || undefined,
      });
      try {
        const zoneName = asString(args.zoneName).trim();
        const result = action === 'list_zones'
          ? await client.listDnsZones(resourceGroup)
          : action === 'list_records'
            ? await client.listDnsRecordSets(resourceGroup, zoneName, asString(args.recordType).trim() || undefined)
            : action === 'upsert_record_set'
              ? await client.upsertDnsRecordSet(
                resourceGroup,
                zoneName,
                requireString(args.recordType, 'recordType').trim(),
                requireString(args.relativeRecordSetName, 'relativeRecordSetName').trim(),
                args.recordSet as Record<string, unknown>,
              )
              : await client.deleteDnsRecordSet(
                resourceGroup,
                zoneName,
                requireString(args.recordType, 'recordType').trim(),
                requireString(args.relativeRecordSetName, 'relativeRecordSetName').trim(),
              );
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            subscriptionId: client.config.subscriptionId,
            action,
            resourceGroup,
            zoneName: zoneName || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Azure DNS request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'azure_monitor',
      description: 'List activity logs or fetch Azure Monitor metrics. Read-only.',
      shortDescription: 'Inspect Azure activity logs and metrics.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.azureProfiles id.' },
          action: { type: 'string', description: 'activity_logs or metrics.' },
          filter: { type: 'string', description: 'Optional activity-log or metrics filter.' },
          resourceId: { type: 'string', description: 'Resource id for metrics action.' },
          metricnames: { type: 'string', description: 'Comma-separated metric names for metrics action.' },
          timespan: { type: 'string', description: 'Optional metrics timespan.' },
          interval: { type: 'string', description: 'Optional metrics interval.' },
          aggregation: { type: 'string', description: 'Optional metrics aggregation.' },
          top: { type: 'number', description: 'Optional metrics top value.' },
          orderby: { type: 'string', description: 'Optional metrics ordering.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['activity_logs', 'metrics'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use activity_logs or metrics.' };
      }
      let client: AzureClient;
      try {
        client = await context.createAzureClient(requireString(args.profile, 'profile'), 'management');
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      context.guardAction(request, 'http_request', {
        url: context.describeAzureEndpoint(client.config, 'management'),
        method: 'GET',
        tool: 'azure_monitor',
        action,
        subscriptionId: client.config.subscriptionId,
        resourceId: asString(args.resourceId).trim() || undefined,
      });
      try {
        const result = action === 'activity_logs'
          ? await client.listActivityLogs(asString(args.filter).trim() || undefined)
          : await client.listMetrics(requireString(args.resourceId, 'resourceId').trim(), {
            metricnames: requireString(args.metricnames, 'metricnames').trim(),
            timespan: asString(args.timespan).trim() || undefined,
            interval: asString(args.interval).trim() || undefined,
            aggregation: asString(args.aggregation).trim() || undefined,
            top: Number.isFinite(Number(args.top)) ? Number(args.top) : undefined,
            orderby: asString(args.orderby).trim() || undefined,
            filter: asString(args.filter).trim() || undefined,
          });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            subscriptionId: client.config.subscriptionId,
            action,
            resourceId: asString(args.resourceId).trim() || undefined,
            data: result,
          },
        };
      } catch (err) {
        return { success: false, error: `Azure Monitor request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'whm_status',
      description: 'Inspect a WHM server profile for hostname, version, load average, and service health. Read-only.',
      shortDescription: 'Inspect WHM server hostname, version, load, and services.',
      risk: 'read_only',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id for a WHM profile.' },
          includeServices: { type: 'boolean', description: 'Include service status details (default: true).' },
        },
        required: ['profile'],
      },
    },
    async (args, request) => {
      let client: CpanelClient;
      try {
        client = await context.createWhmClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const includeServices = args.includeServices !== false;

      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method: 'GET',
        tool: 'whm_status',
      });

      try {
        const [hostname, version, load, services] = await Promise.all([
          client.whm('gethostname'),
          client.whm('version'),
          client.whm('systemloadavg'),
          includeServices ? client.whm('servicestatus') : Promise.resolve(null),
        ]);
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            hostname: hostname.data,
            version: version.data,
            loadAverage: load.data,
            services: services?.data ?? null,
          },
        };
      } catch (err) {
        return { success: false, error: `WHM status request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'whm_accounts',
      description: 'Manage accounts on a WHM server profile. Supports list, create, suspend, unsuspend, modify, and remove.',
      shortDescription: 'List or mutate accounts on a WHM server profile.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id for a WHM profile.' },
          action: { type: 'string', description: 'list, create, suspend, unsuspend, modify, or remove.' },
          search: { type: 'string', description: 'Optional username/domain/owner filter applied client-side.' },
          limit: { type: 'number', description: 'Maximum accounts to return (1-200, default 50).' },
          username: { type: 'string', description: 'Account username.' },
          domain: { type: 'string', description: 'Primary domain for account creation.' },
          password: { type: 'string', description: 'Password used for account creation.' },
          email: { type: 'string', description: 'Contact email for account creation.' },
          plan: { type: 'string', description: 'WHM package name.' },
          owner: { type: 'string', description: 'Optional account owner/reseller.' },
          reason: { type: 'string', description: 'Suspend reason.' },
          quota: {
            anyOf: [
              { type: 'number' },
              { type: 'string', pattern: '^[0-9]+$' },
              { type: 'string', enum: ['unlimited'] },
            ],
            description: 'Disk quota for modify actions. Use a number or "unlimited".',
          },
          maxpark: {
            anyOf: [
              { type: 'number' },
              { type: 'string', pattern: '^[0-9]+$' },
              { type: 'string', enum: ['unlimited'] },
            ],
            description: 'Alias domain limit for modify actions. Use a number or "unlimited".',
          },
          maxaddon: {
            anyOf: [
              { type: 'number' },
              { type: 'string', pattern: '^[0-9]+$' },
              { type: 'string', enum: ['unlimited'] },
            ],
            description: 'Addon domain limit for modify actions. Use a number or "unlimited".',
          },
          maxsub: {
            anyOf: [
              { type: 'number' },
              { type: 'string', pattern: '^[0-9]+$' },
              { type: 'string', enum: ['unlimited'] },
            ],
            description: 'Subdomain limit for modify actions. Use a number or "unlimited".',
          },
          maxftp: {
            anyOf: [
              { type: 'number' },
              { type: 'string', pattern: '^[0-9]+$' },
              { type: 'string', enum: ['unlimited'] },
            ],
            description: 'FTP account limit for modify actions. Use a number or "unlimited".',
          },
          maxsql: {
            anyOf: [
              { type: 'number' },
              { type: 'string', pattern: '^[0-9]+$' },
              { type: 'string', enum: ['unlimited'] },
            ],
            description: 'Database limit for modify actions. Use a number or "unlimited".',
          },
          hasshell: {
            anyOf: [
              { type: 'boolean' },
              { type: 'string', enum: ['true', 'false', '1', '0', 'yes', 'no'] },
            ],
            description: 'Enable shell access during modify.',
          },
          keepDns: { type: 'boolean', description: 'When removing, keep DNS zone if supported.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      const supportedActions = ['list', 'create', 'suspend', 'unsuspend', 'modify', 'remove'];
      if (!supportedActions.includes(action)) {
        return { success: false, error: `Unsupported action. Use ${supportedActions.join(', ')}.` };
      }

      let client: CpanelClient;
      try {
        client = await context.createWhmClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      const search = asString(args.search).trim().toLowerCase();
      const limit = Math.max(1, Math.min(200, asNumber(args.limit, 50)));

      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method: action === 'list' ? 'GET' : 'POST',
        tool: 'whm_accounts',
        action,
      });

      try {
        if (action === 'list') {
          const accounts = await client.whm('listaccts');
          const accountData = (accounts.data && typeof accounts.data === 'object')
            ? accounts.data as { acct?: Array<Record<string, unknown>> }
            : {};
          const allAccounts = Array.isArray(accountData.acct) ? accountData.acct : [];
          const filtered = search
            ? allAccounts.filter((account) => {
              return ['user', 'domain', 'owner']
                .some((key) => String(account[key] ?? '').toLowerCase().includes(search));
            })
            : allAccounts;
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              total: allAccounts.length,
              returned: Math.min(filtered.length, limit),
              accounts: filtered.slice(0, limit),
            },
          };
        }

        if (action === 'create') {
          const username = requireString(args.username, 'username').trim();
          const domain = requireString(args.domain, 'domain').trim();
          const password = requireString(args.password, 'password');
          const email = asString(args.email).trim() || undefined;
          const plan = asString(args.plan).trim() || undefined;
          const owner = asString(args.owner).trim() || undefined;
          const created = await client.whm('createacct', {
            username,
            domain,
            password,
            contactemail: email,
            plan,
            owner,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              domain,
              email: email ?? null,
              plan: plan ?? null,
              owner: owner ?? null,
              data: created.data,
              warnings: created.warnings,
            },
          };
        }

        if (action === 'suspend') {
          const username = requireString(args.username, 'username').trim();
          const reason = asString(args.reason).trim() || undefined;
          const suspended = await client.whm('suspendacct', {
            user: username,
            reason,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              reason: reason ?? null,
              data: suspended.data,
              warnings: suspended.warnings,
            },
          };
        }

        if (action === 'unsuspend') {
          const username = requireString(args.username, 'username').trim();
          const unsuspended = await client.whm('unsuspendacct', {
            user: username,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              data: unsuspended.data,
              warnings: unsuspended.warnings,
            },
          };
        }

        if (action === 'modify') {
          const username = requireString(args.username, 'username').trim();
          const quota = toOptionalWhmLimitString(args.quota);
          const maxpark = toOptionalWhmLimitString(args.maxpark);
          const maxaddon = toOptionalWhmLimitString(args.maxaddon);
          const maxsub = toOptionalWhmLimitString(args.maxsub);
          const maxftp = toOptionalWhmLimitString(args.maxftp);
          const maxsql = toOptionalWhmLimitString(args.maxsql);
          const hasshell = toOptionalBooleanString(args.hasshell);
          const modifyParams = stripUndefined({
            user: username,
            MAXPARK: maxpark,
            MAXADDON: maxaddon,
            MAXSUB: maxsub,
            MAXFTP: maxftp,
            MAXSQL: maxsql,
            HASSHELL: hasshell,
          });
          if (quota === undefined && Object.keys(modifyParams).length <= 1) {
            return {
              success: false,
              error: 'Modify actions require at least one change: quota, maxpark, maxaddon, maxsub, maxftp, maxsql, or hasshell.',
            };
          }

          const quotaUpdate = quota === undefined
            ? null
            : await client.whm('editquota', {
              user: username,
              quota,
            }, { method: 'POST' });
          const modified = Object.keys(modifyParams).length > 1
            ? await client.whm('modifyacct', modifyParams, { method: 'POST' })
            : null;
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              changes: {
                quota: quota ?? null,
                maxpark: maxpark ?? null,
                maxaddon: maxaddon ?? null,
                maxsub: maxsub ?? null,
                maxftp: maxftp ?? null,
                maxsql: maxsql ?? null,
                hasshell: hasshell ?? null,
              },
              data: {
                quota: quotaUpdate?.data ?? null,
                modify: modified?.data ?? null,
              },
              warnings: [
                ...(quotaUpdate?.warnings ?? []),
                ...(modified?.warnings ?? []),
              ],
            },
          };
        }

        if (action === 'remove') {
          const username = requireString(args.username, 'username').trim();
          const keepDns = !!args.keepDns;
          const removed = await client.whm('removeacct', {
            user: username,
            keepdns: keepDns ? 1 : 0,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              keepDns,
              data: removed.data,
              warnings: removed.warnings,
            },
          };
        }

        return { success: false, error: `Unsupported action '${action}'.` };
      } catch (err) {
        return { success: false, error: `WHM account request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'whm_dns',
      description: 'Inspect or manage WHM DNS zones. Supports list, parse_zone, create_zone, delete_zone, and reset_zone.',
      shortDescription: 'List, parse, create, delete, or reset WHM DNS zones.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id for a WHM profile.' },
          action: { type: 'string', description: 'list, parse_zone, create_zone, delete_zone, or reset_zone.' },
          zone: { type: 'string', description: 'Zone name for parse_zone.' },
          domain: { type: 'string', description: 'Domain for create/delete/reset.' },
          ip: { type: 'string', description: 'IP address for create_zone.' },
          owner: { type: 'string', description: 'Optional true owner for create_zone.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list', 'parse_zone', 'create_zone', 'delete_zone', 'reset_zone'].includes(action)) {
        return { success: false, error: 'Unsupported action. Use list, parse_zone, create_zone, delete_zone, or reset_zone.' };
      }

      let client: CpanelClient;
      try {
        client = await context.createWhmClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = (action === 'list' || action === 'parse_zone') ? 'GET' : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'whm_dns',
        action,
      });

      try {
        if (action === 'list') {
          const zones = await client.whm('listzones');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: zones.data,
            },
          };
        }
        if (action === 'parse_zone') {
          const zone = requireString(args.zone, 'zone').trim();
          const parsed = await client.whm('parse_dns_zone', { zone });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              zone,
              data: parsed.data,
            },
          };
        }
        if (action === 'create_zone') {
          const domain = requireString(args.domain, 'domain').trim();
          const ip = requireString(args.ip, 'ip').trim();
          const owner = asString(args.owner).trim() || undefined;
          const created = await client.whm('adddns', {
            domain,
            ip,
            trueowner: owner,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              domain,
              ip,
              owner: owner ?? null,
              data: created.data,
            },
          };
        }
        if (action === 'delete_zone') {
          const domain = requireString(args.domain, 'domain').trim();
          const deleted = await client.whm('killdns', { domain }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              domain,
              data: deleted.data,
            },
          };
        }
        const domain = requireString(args.domain, 'domain').trim();
        const reset = await client.whm('resetzone', { domain }, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            action,
            domain,
            data: reset.data,
          },
        };
      } catch (err) {
        return { success: false, error: `WHM DNS request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'whm_ssl',
      description: 'Inspect or manage WHM AutoSSL settings. Supports list_providers, check_user, check_all, set_provider, get_excluded_domains, and set_excluded_domains.',
      shortDescription: 'Manage WHM AutoSSL providers and account checks.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id for a WHM profile.' },
          action: { type: 'string', description: 'list_providers, check_user, check_all, set_provider, get_excluded_domains, or set_excluded_domains.' },
          username: { type: 'string', description: 'cPanel username for account-specific actions.' },
          provider: { type: 'string', description: 'AutoSSL provider name for set_provider.' },
          domains: { type: 'array', items: { type: 'string' }, description: 'Excluded domains for set_excluded_domains.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['list_providers', 'check_user', 'check_all', 'set_provider', 'get_excluded_domains', 'set_excluded_domains'].includes(action)) {
        return { success: false, error: 'Unsupported action for whm_ssl.' };
      }

      let client: CpanelClient;
      try {
        client = await context.createWhmClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = (action === 'list_providers' || action === 'get_excluded_domains') ? 'GET' : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'whm_ssl',
        action,
      });

      try {
        if (action === 'list_providers') {
          const providers = await client.whm('get_autossl_providers');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: providers.data,
            },
          };
        }
        if (action === 'check_user') {
          const username = requireString(args.username, 'username').trim();
          const check = await client.whm('start_autossl_check_for_one_user', { username }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              data: check.data,
            },
          };
        }
        if (action === 'check_all') {
          const check = await client.whm('start_autossl_check_for_all_users', undefined, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: check.data,
            },
          };
        }
        if (action === 'set_provider') {
          const provider = requireString(args.provider, 'provider').trim();
          const updated = await client.whm('set_autossl_provider', { provider }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              provider,
              data: updated.data,
            },
          };
        }
        if (action === 'get_excluded_domains') {
          const username = requireString(args.username, 'username').trim();
          const excluded = await client.whm('get_autossl_user_excluded_domains', { username });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              username,
              data: excluded.data,
            },
          };
        }
        const username = requireString(args.username, 'username').trim();
        const domains = asStringArray(args.domains);
        const domainParams: Record<string, string> = {};
        domains.forEach((domain, index) => {
          domainParams[index === 0 ? 'domain' : `domain-${index}`] = domain;
        });
        const updated = await client.whm('set_autossl_user_excluded_domains', {
          username,
          ...domainParams,
        }, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            action,
            username,
            domains,
            data: updated.data,
          },
        };
      } catch (err) {
        return { success: false, error: `WHM SSL request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'whm_backup',
      description: 'Inspect or manage WHM backup configuration. Supports config_get, config_set, destination_list, date_list, user_list, and toggle_all.',
      shortDescription: 'Manage WHM backup configuration and backup inventory.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id for a WHM profile.' },
          action: { type: 'string', description: 'config_get, config_set, destination_list, date_list, user_list, or toggle_all.' },
          restorePoint: { type: 'string', description: 'ISO-8601 restore point for user_list.' },
          backupVersion: { type: 'string', description: 'backup or legacy for toggle_all.' },
          state: { type: 'boolean', description: 'Enable or disable for toggle_all.' },
          settings: { type: 'object', description: 'backup_config_set key/value updates.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['config_get', 'config_set', 'destination_list', 'date_list', 'user_list', 'toggle_all'].includes(action)) {
        return { success: false, error: 'Unsupported action for whm_backup.' };
      }

      let client: CpanelClient;
      try {
        client = await context.createWhmClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = ['config_get', 'destination_list', 'date_list', 'user_list'].includes(action) ? 'GET' : 'POST';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'whm_backup',
        action,
      });

      try {
        if (action === 'config_get') {
          const config = await client.whm('backup_config_get');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: config.data,
            },
          };
        }
        if (action === 'destination_list') {
          const destinations = await client.whm('backup_destination_list');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: destinations.data,
            },
          };
        }
        if (action === 'date_list') {
          const dates = await client.whm('backup_date_list');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: dates.data,
            },
          };
        }
        if (action === 'user_list') {
          const restorePoint = requireString(args.restorePoint, 'restorePoint').trim();
          const users = await client.whm('backup_user_list', { restore_point: restorePoint });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              restorePoint,
              data: users.data,
            },
          };
        }
        if (action === 'toggle_all') {
          const backupVersion = asString(args.backupVersion, 'backup').trim() === 'legacy' ? 'legacy' : 'backup';
          const state = !!args.state;
          const toggled = await client.whm('backup_skip_users_all', {
            backupversion: backupVersion,
            state: state ? 1 : 0,
          }, { method: 'POST' });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              backupVersion,
              state,
              data: toggled.data,
            },
          };
        }
        const settings = isRecord(args.settings) ? args.settings : {};
        const params = Object.fromEntries(
          Object.entries(settings)
            .map(([key, value]) => [key, coerceWhmScalar(value)])
            .filter(([, value]) => value !== undefined),
        ) as Record<string, string | number | boolean | undefined>;
        const updated = await client.whm('backup_config_set', params, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            action,
            settings: params,
            data: updated.data,
          },
        };
      } catch (err) {
        return { success: false, error: `WHM backup request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'whm_services',
      description: 'Inspect or restart WHM-managed services. Supports status, get_config, and restart.',
      shortDescription: 'Inspect or restart WHM services.',
      risk: 'mutating',
      category: 'cloud',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Configured assistant.tools.cloud.cpanelProfiles id for a WHM profile.' },
          action: { type: 'string', description: 'status, get_config, or restart.' },
          service: { type: 'string', description: 'Service name for get_config or restart.' },
        },
        required: ['profile', 'action'],
      },
    },
    async (args, request) => {
      const action = requireString(args.action, 'action').trim().toLowerCase();
      if (!['status', 'get_config', 'restart'].includes(action)) {
        return { success: false, error: 'Unsupported action for whm_services.' };
      }

      let client: CpanelClient;
      try {
        client = await context.createWhmClient(requireString(args.profile, 'profile'));
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      const method = action === 'restart' ? 'POST' : 'GET';
      context.guardAction(request, 'http_request', {
        url: context.describeCloudEndpoint(client.config),
        method,
        tool: 'whm_services',
        action,
      });

      try {
        if (action === 'status') {
          const status = await client.whm('servicestatus');
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              data: status.data,
            },
          };
        }
        const service = requireString(args.service, 'service').trim();
        if (action === 'get_config') {
          const config = await client.whm('get_service_config', { service });
          return {
            success: true,
            output: {
              profile: client.config.id,
              profileName: client.config.name,
              host: client.config.host,
              action,
              service,
              data: config.data,
            },
          };
        }
        const restarted = await client.whm('restartservice', { service }, { method: 'POST' });
        return {
          success: true,
          output: {
            profile: client.config.id,
            profileName: client.config.name,
            host: client.config.host,
            action,
            service,
            data: restarted.data,
          },
        };
      } catch (err) {
        return { success: false, error: `WHM services request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeObjectArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function encodeJsonParamArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return JSON.stringify(value);
}

function encodeScalarArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return JSON.stringify(
    value
      .map((item) => typeof item === 'number' || typeof item === 'string' ? item : null)
      .filter((item) => item !== null),
  );
}

function toOptionalWhmLimitString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.toLowerCase();
    if (normalized === 'unlimited') return 'unlimited';
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return String(parsed);
  }
  return undefined;
}

function toOptionalBooleanString(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return '1';
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return '0';
  }
  return undefined;
}

function stripUndefined<T extends Record<string, string | number | boolean | undefined>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as T;
}

function sanitizeSslData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSslData(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeSensitiveKeyName(key);
      if (normalized === 'privatekey' || normalized === 'key') {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeSslData(child);
      }
    }
    return out;
  }
  return value;
}

function coerceWhmScalar(value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

function asArrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function describeVercelScope(config: VercelInstanceConfig): { teamId: string | null; slug: string | null } {
  return {
    teamId: config.teamId?.trim() || null,
    slug: config.slug?.trim() || null,
  };
}

function buildVercelProjectPayload(args: Record<string, unknown>, helpers: Pick<CloudToolRegistrarContext, 'asString'>): Record<string, unknown> {
  const payload = isRecord(args.settings) ? { ...args.settings } : {};
  const name = helpers.asString(args.name).trim();
  const framework = helpers.asString(args.framework).trim();
  const rootDirectory = helpers.asString(args.rootDirectory).trim();

  if (name) payload['name'] = name;
  if (framework) payload['framework'] = framework;
  if (rootDirectory) payload['rootDirectory'] = rootDirectory;
  if (typeof args.publicSource === 'boolean') payload['publicSource'] = args.publicSource;
  return payload;
}

function buildVercelDeploymentPayload(args: Record<string, unknown>, helpers: Pick<CloudToolRegistrarContext, 'asString'>): Record<string, unknown> {
  const payload = isRecord(args.deployment) ? { ...args.deployment } : {};
  const project = helpers.asString(args.project).trim();
  const target = helpers.asString(args.target).trim();
  if (project && payload['name'] === undefined && payload['project'] === undefined) {
    payload['name'] = project;
  }
  if (target && payload['target'] === undefined) {
    payload['target'] = target;
  }
  if (Array.isArray(args.files) && payload['files'] === undefined) {
    payload['files'] = args.files;
  }
  if (isRecord(args.meta) && payload['meta'] === undefined) {
    payload['meta'] = args.meta;
  }
  if (isRecord(args.gitSource) && payload['gitSource'] === undefined) {
    payload['gitSource'] = args.gitSource;
  }
  return payload;
}

function buildVercelDomainPayload(
  args: Record<string, unknown>,
  helpers: Pick<CloudToolRegistrarContext, 'requireString' | 'asString'>,
  options: { includeName?: boolean } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (options.includeName !== false) {
    payload['name'] = helpers.requireString(args.domain, 'domain').trim();
  }
  const gitBranch = helpers.asString(args.gitBranch).trim();
  const redirect = helpers.asString(args.redirect).trim();
  if (gitBranch) payload['gitBranch'] = gitBranch;
  if (redirect) payload['redirect'] = redirect;
  if (typeof args.redirectStatusCode === 'number' && Number.isFinite(args.redirectStatusCode)) {
    payload['redirectStatusCode'] = args.redirectStatusCode;
  }
  return payload;
}

function buildVercelEnvPayload(args: Record<string, unknown>, helpers: CloudToolValueHelpers): Record<string, unknown> {
  if (isRecord(args.env)) {
    return { ...args.env };
  }

  const key = helpers.requireString(args.key, 'key').trim();
  const value = helpers.requireString(args.value, 'value');
  const type = helpers.asString(args.type, 'encrypted').trim() || 'encrypted';
  const targets = helpers.asStringArray(args.targets);
  const gitBranch = helpers.asString(args.gitBranch).trim();
  const customEnvironmentIds = helpers.asStringArray(args.customEnvironmentIds);

  const payload: Record<string, unknown> = {
    key,
    value,
    type,
  };
  if (targets.length > 0) payload['target'] = targets;
  if (gitBranch) payload['gitBranch'] = gitBranch;
  if (customEnvironmentIds.length > 0) payload['customEnvironmentIds'] = customEnvironmentIds;
  return payload;
}

function redactVercelEnvData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactVercelEnvData(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeSensitiveKeyName(key);
    if (normalized === 'value') {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redactVercelEnvData(child);
  }
  return out;
}

function buildCloudflareDnsPayload(args: Record<string, unknown>, helpers: Pick<CloudToolRegistrarContext, 'requireString'>): Record<string, unknown> {
  if (isRecord(args.record)) {
    return { ...args.record };
  }

  const payload: Record<string, unknown> = {
    type: helpers.requireString(args.type, 'type').trim(),
    name: helpers.requireString(args.name, 'name').trim(),
    content: helpers.requireString(args.content, 'content').trim(),
  };
  if (typeof args.ttl === 'number' && Number.isFinite(args.ttl)) payload['ttl'] = args.ttl;
  if (typeof args.proxied === 'boolean') payload['proxied'] = args.proxied;
  if (typeof args.priority === 'number' && Number.isFinite(args.priority)) payload['priority'] = args.priority;
  if (typeof args.comment === 'string' && args.comment.trim()) payload['comment'] = args.comment.trim();
  return payload;
}

function buildCloudflareCachePurgePayload(args: Record<string, unknown>, helpers: Pick<CloudToolRegistrarContext, 'requireString' | 'asStringArray'>): Record<string, unknown> {
  const action = helpers.requireString(args.action, 'action').trim().toLowerCase();
  if (action === 'purge_everything') {
    return { purge_everything: true };
  }
  if (action === 'purge_files') {
    return { files: helpers.asStringArray(args.files) };
  }
  if (action === 'purge_tags') {
    return { tags: helpers.asStringArray(args.tags) };
  }
  if (action === 'purge_hosts') {
    return { hosts: helpers.asStringArray(args.hosts) };
  }
  return { prefixes: helpers.asStringArray(args.prefixes) };
}

function flattenEc2Instances(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.Reservations)) return [];
  const instances: unknown[] = [];
  for (const reservation of value.Reservations) {
    if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)) continue;
    const reservationRecord = reservation as Record<string, unknown>;
    if (!Array.isArray(reservationRecord.Instances)) continue;
    instances.push(...reservationRecord.Instances);
  }
  return instances;
}

function buildCloudWatchDimensions(
  value: unknown,
  helpers: Pick<CloudToolRegistrarContext, 'asString'>,
): Array<{ Name: string; Value: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const dimensions = value.flatMap((entry) => {
    if (typeof entry === 'string') {
      const [name, ...rest] = entry.split('=');
      const joined = rest.join('=').trim();
      if (!name?.trim() || !joined) return [];
      return [{ Name: name.trim(), Value: joined }];
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const name = helpers.asString(record.Name).trim();
      const dimensionValue = helpers.asString(record.Value).trim();
      if (!name || !dimensionValue) return [];
      return [{ Name: name, Value: dimensionValue }];
    }
    return [];
  });
  return dimensions.length ? dimensions : undefined;
}

function buildRoute53Changes(args: Record<string, unknown>, helpers: CloudToolValueHelpers): Array<Record<string, unknown>> {
  if (Array.isArray(args.changes) && args.changes.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    return args.changes as Array<Record<string, unknown>>;
  }
  const changeAction = helpers.requireString(args.changeAction, 'changeAction').trim().toUpperCase();
  const type = helpers.requireString(args.type, 'type').trim().toUpperCase();
  const name = helpers.requireString(args.name, 'name').trim();
  const records = helpers.asStringArray(args.records);
  return [{
    Action: changeAction,
    ResourceRecordSet: {
      Name: name,
      Type: type,
      TTL: Number.isFinite(Number(args.ttl)) ? Number(args.ttl) : 300,
      ResourceRecords: records.map((value) => ({ Value: value })),
    },
  }];
}

function buildAwsCostTimePeriod(
  value: unknown,
  helpers: Pick<CloudToolRegistrarContext, 'asString'>,
): { Start: string; End: string } {
  if (!isRecord(value)) {
    throw new Error('timePeriod object is required');
  }
  const start = helpers.asString(value.start ?? value.Start).trim();
  const end = helpers.asString(value.end ?? value.End).trim();
  if (!start || !end) {
    throw new Error('timePeriod.start and timePeriod.end are required');
  }
  return { Start: start, End: end };
}

function buildAwsCostGroupBy(
  value: unknown,
  helpers: Pick<CloudToolRegistrarContext, 'asString'>,
): Array<{ Type: string; Key: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out = value.flatMap((entry) => {
    if (typeof entry === 'string') {
      const [type, ...rest] = entry.split(':');
      const key = rest.join(':').trim();
      if (!type?.trim() || !key) return [];
      return [{ Type: type.trim().toUpperCase(), Key: key }];
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const type = helpers.asString(record.Type ?? record.type).trim().toUpperCase();
      const key = helpers.asString(record.Key ?? record.key).trim();
      if (!type || !key) return [];
      return [{ Type: type, Key: key }];
    }
    return [];
  });
  return out.length ? out : undefined;
}
