import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { GuardianAgentConfig } from '../../config/types.js';
import type { createProviderIntegrationCallbacks } from './provider-integration-callbacks.js';

type GwsCliProbe = NonNullable<Parameters<typeof createProviderIntegrationCallbacks>[0]['probeGwsCli']>;
type CloudConnectionTesters = Parameters<typeof createProviderIntegrationCallbacks>[0]['testCloudConnections'];

interface DebugLoggerLike {
  debug(data: unknown, message: string): void;
}

type ExecFileAsync = (
  file: string,
  args: string[],
  options: {
    timeout: number;
    shell: boolean;
  },
) => Promise<{ stdout: string }>;

const defaultExecFileAsync = promisify(execFileCb);

export function createGwsCliProbe(
  log: DebugLoggerLike,
  execFileAsync: ExecFileAsync = defaultExecFileAsync,
): GwsCliProbe {
  return async (config: GuardianAgentConfig) => {
    const command = config.assistant.tools.mcp?.managedProviders?.gws?.command?.trim() || 'gws';
    const execOpts = { timeout: 5000, shell: process.platform === 'win32' };
    try {
      const { stdout } = await execFileAsync(command, ['--version'], execOpts);
      const version = stdout.trim();
      try {
        const { stdout: statusJson } = await execFileAsync(command, ['auth', 'status'], execOpts);
        const status = JSON.parse(statusJson) as { auth_method?: string };
        const authenticated = !!status.auth_method && status.auth_method !== 'none';
        return {
          installed: true,
          version,
          authenticated,
          authMethod: authenticated ? status.auth_method : undefined,
        };
      } catch (err) {
        log.debug({ err, command }, 'GWS auth status check failed, reporting as not authenticated');
        return { installed: true, version, authenticated: false };
      }
    } catch (err) {
      log.debug({ err, command }, 'GWS CLI not found or version check failed');
      return { installed: false, authenticated: false };
    }
  };
}

export function createCloudConnectionTesters(): CloudConnectionTesters {
  return {
    cpanel: async (profile) => {
      const { CpanelClient } = await import('../../tools/cloud/cpanel-client.js');
      const client = new CpanelClient(profile as unknown as ConstructorParameters<typeof CpanelClient>[0]);
      await client.whm('version');
    },
    vercel: async (profile) => {
      const { VercelClient } = await import('../../tools/cloud/vercel-client.js');
      const client = new VercelClient(profile as unknown as ConstructorParameters<typeof VercelClient>[0]);
      await client.listProjects({ limit: 1 });
    },
    daytona: async (profile) => {
      const { Daytona } = await import('@daytona/sdk');
      await using client = new Daytona({
        apiKey: profile.apiKey,
        apiUrl: profile.apiUrl,
        target: profile.target,
      });
      await client.list(undefined, 1, 1);
    },
    cloudflare: async (profile) => {
      const { CloudflareClient } = await import('../../tools/cloud/cloudflare-client.js');
      const client = new CloudflareClient(profile as unknown as ConstructorParameters<typeof CloudflareClient>[0]);
      await client.verifyToken();
    },
    aws: async (profile) => {
      const { AwsClient } = await import('../../tools/cloud/aws-client.js');
      const client = new AwsClient(profile as unknown as ConstructorParameters<typeof AwsClient>[0]);
      await client.getCallerIdentity();
    },
    gcp: async (profile) => {
      const { GcpClient } = await import('../../tools/cloud/gcp-client.js');
      const client = new GcpClient(profile as unknown as ConstructorParameters<typeof GcpClient>[0]);
      await client.getProject();
    },
    azure: async (profile) => {
      const { AzureClient } = await import('../../tools/cloud/azure-client.js');
      const client = new AzureClient(profile as unknown as ConstructorParameters<typeof AzureClient>[0]);
      await client.getSubscription();
    },
  };
}
