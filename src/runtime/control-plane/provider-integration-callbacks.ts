import { homedir } from 'node:os';

import type { DashboardCallbacks } from '../../channels/web-types.js';
import type {
  AssistantCloudAwsProfileConfig,
  AssistantCloudAzureProfileConfig,
  AssistantCloudCloudflareProfileConfig,
  AssistantCloudCpanelProfileConfig,
  AssistantCloudDaytonaProfileConfig,
  AssistantCloudGcpProfileConfig,
  AssistantCloudVercelProfileConfig,
  GuardianAgentConfig,
} from '../../config/types.js';
import type { GoogleAuth } from '../../google/google-auth.js';
import type { GoogleService } from '../../google/google-service.js';
import type { MicrosoftAuth } from '../../microsoft/microsoft-auth.js';
import type { MicrosoftService } from '../../microsoft/microsoft-service.js';
import { resolveRuntimeCredentialView } from '../../runtime/credentials.js';
import type { LocalSecretStore } from '../../runtime/secret-store.js';
import type { ToolExecutor } from '../../tools/executor.js';

type ProviderIntegrationCallbacks = Pick<
  DashboardCallbacks,
  | 'onGwsStatus'
  | 'onGoogleStatus'
  | 'onGoogleAuthStart'
  | 'onGoogleCredentials'
  | 'onGoogleAuthCancel'
  | 'onGoogleDisconnect'
  | 'onMicrosoftStatus'
  | 'onMicrosoftAuthStart'
  | 'onMicrosoftConfig'
  | 'onMicrosoftAuthCancel'
  | 'onMicrosoftDisconnect'
  | 'onCloudTest'
>;

interface ProviderIntegrationCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  googleAuthRef: { current: GoogleAuth | null };
  googleServiceRef: { current: GoogleService | null };
  microsoftAuthRef: { current: MicrosoftAuth | null };
  microsoftServiceRef: { current: MicrosoftService | null };
  toolExecutorRef: { current: ToolExecutor | null };
  enabledManagedProviders: Set<string>;
  secretStore: LocalSecretStore;
  loadRawConfig: () => Record<string, unknown>;
  persistAndApplyConfig: (rawConfig: Record<string, unknown>, meta?: { changedBy?: string; reason?: string }) => {
    success: boolean;
    message: string;
  };
  probeGwsCli: (config: GuardianAgentConfig) => Promise<{
    installed: boolean;
    version?: string;
    authenticated: boolean;
    authMethod?: string;
  }>;
  testCloudConnections: {
    cpanel: (profile: AssistantCloudCpanelProfileConfig) => Promise<void>;
    vercel: (profile: AssistantCloudVercelProfileConfig) => Promise<void>;
    daytona: (profile: AssistantCloudDaytonaProfileConfig) => Promise<void>;
    cloudflare: (profile: AssistantCloudCloudflareProfileConfig) => Promise<void>;
    aws: (profile: AssistantCloudAwsProfileConfig) => Promise<void>;
    gcp: (profile: AssistantCloudGcpProfileConfig) => Promise<void>;
    azure: (profile: AssistantCloudAzureProfileConfig) => Promise<void>;
  };
}

export function createProviderIntegrationCallbacks(
  options: ProviderIntegrationCallbackOptions,
): ProviderIntegrationCallbacks {
  return {
    onGwsStatus: async () => {
      const status = await options.probeGwsCli(options.configRef.current);
      const gwsConfig = options.configRef.current.assistant.tools.mcp?.managedProviders?.gws;
      const services = gwsConfig?.services ?? ['gmail', 'calendar', 'drive'];
      return {
        installed: status.installed,
        version: status.version,
        authenticated: status.authenticated,
        authMethod: status.authMethod,
        services: gwsConfig?.enabled ? services : [],
        enabled: gwsConfig?.enabled ?? false,
      };
    },

    onGoogleStatus: async () => {
      const auth = options.googleAuthRef.current;
      const svc = options.googleServiceRef.current;
      if (!auth) return { authenticated: false, services: [], mode: 'native' as const };
      const expiry = auth.getTokenExpiry();
      return {
        authenticated: auth.isAuthenticated(),
        authPending: auth.hasPendingAuth(),
        tokenExpiry: expiry,
        tokenExpired: expiry ? expiry < Date.now() : false,
        services: svc?.getEnabledServices() ?? [],
        mode: 'native' as const,
      };
    },

    onGoogleAuthStart: async (services: string[]) => {
      const auth = options.googleAuthRef.current;
      if (!auth) return { success: false, message: 'Google auth not initialized. Restart the application.' };
      try {
        const rawConfig = options.loadRawConfig();
        const rawAssistant = (rawConfig.assistant as Record<string, unknown>) ?? {};
        const rawTools = (rawAssistant.tools as Record<string, unknown>) ?? {};
        rawTools.google = {
          ...(rawTools.google as Record<string, unknown> ?? {}),
          enabled: true,
          mode: 'native',
          services: services.length ? services : ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'],
        };
        rawAssistant.tools = rawTools;
        rawConfig.assistant = rawAssistant;
        options.persistAndApplyConfig(rawConfig, { reason: 'Enable native Google integration' });

        options.enabledManagedProviders.add('gws');
        const { authUrl, state } = await auth.startAuth();
        return { success: true, authUrl, state };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    onGoogleCredentials: async (credentials: string) => {
      const googleCfg = options.configRef.current.assistant.tools.google;
      const credPath = googleCfg?.credentialsPath?.replace(/^~/, homedir()) || `${homedir()}/.guardianagent/google-credentials.json`;
      try {
        const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdirAsync(dirname(credPath), { recursive: true });
        await writeFileAsync(credPath, credentials, { mode: 0o600 });
        return { success: true, message: 'Credentials saved.' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    onGoogleAuthCancel: async () => {
      const auth = options.googleAuthRef.current;
      if (!auth) return { success: false, message: 'Google auth not initialized.' };
      auth.cancelPendingAuth('Google OAuth flow was cancelled from the web UI.');
      return { success: true, message: 'Cancelled pending Google auth flow.' };
    },

    onGoogleDisconnect: async () => {
      const auth = options.googleAuthRef.current;
      if (!auth) return { success: false, message: 'Native Google integration is not enabled.' };
      try {
        await auth.disconnect();
        return { success: true, message: 'Disconnected.' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    onMicrosoftStatus: async () => {
      const auth = options.microsoftAuthRef.current;
      const svc = options.microsoftServiceRef.current;
      const msConfig = options.configRef.current.assistant.tools.microsoft;
      if (!auth) return { authenticated: false, services: [], clientId: msConfig?.clientId, tenantId: msConfig?.tenantId };
      const expiry = auth.getTokenExpiry();
      return {
        authenticated: auth.isAuthenticated(),
        authPending: auth.hasPendingAuth(),
        tokenExpiry: expiry,
        tokenExpired: expiry ? expiry < Date.now() : false,
        services: svc?.getEnabledServices() ?? [],
        clientId: msConfig?.clientId,
        tenantId: msConfig?.tenantId,
      };
    },

    onMicrosoftAuthStart: async (services: string[]) => {
      const auth = options.microsoftAuthRef.current;
      if (!auth) return { success: false, message: 'Microsoft auth not initialized. Enter a Client ID and restart, or save config first.' };
      try {
        const rawConfig = options.loadRawConfig();
        const rawAssistant = (rawConfig.assistant as Record<string, unknown>) ?? {};
        const rawTools = (rawAssistant.tools as Record<string, unknown>) ?? {};
        const existingMs = (rawTools.microsoft as Record<string, unknown>) ?? {};
        rawTools.microsoft = {
          ...existingMs,
          enabled: true,
          services: services.length ? services : ['mail', 'calendar', 'onedrive', 'contacts'],
        };
        rawAssistant.tools = rawTools;
        rawConfig.assistant = rawAssistant;
        options.persistAndApplyConfig(rawConfig, { reason: 'Enable native Microsoft 365 integration' });

        options.enabledManagedProviders.add('m365');
        const { authUrl, state } = await auth.startAuth();
        return { success: true, authUrl, state };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    onMicrosoftConfig: async (config) => {
      try {
        const rawConfig = options.loadRawConfig();
        const rawAssistant = (rawConfig.assistant as Record<string, unknown>) ?? {};
        const rawTools = (rawAssistant.tools as Record<string, unknown>) ?? {};
        const existingMs = (rawTools.microsoft as Record<string, unknown>) ?? {};
        rawTools.microsoft = {
          ...existingMs,
          clientId: config.clientId,
          tenantId: config.tenantId || 'common',
        };
        rawAssistant.tools = rawTools;
        rawConfig.assistant = rawAssistant;
        options.persistAndApplyConfig(rawConfig, { reason: 'Save Microsoft 365 client configuration' });

        if (!options.microsoftAuthRef.current) {
          try {
            const { MicrosoftAuth, MicrosoftService, MICROSOFT_SERVICE_SCOPES } = await import('../../microsoft/index.js');
            const msConfig = options.configRef.current.assistant.tools.microsoft;
            const services = msConfig?.services?.length ? msConfig.services : ['mail', 'calendar', 'onedrive', 'contacts'];
            const scopes = services
              .flatMap((service: string) => MICROSOFT_SERVICE_SCOPES[service.toLowerCase()] ?? []);

            const auth = new MicrosoftAuth({
              clientId: config.clientId,
              tenantId: config.tenantId || 'common',
              callbackPort: msConfig?.oauthCallbackPort ?? 18433,
              scopes,
            });
            await auth.loadStoredTokens();
            const service = new MicrosoftService(auth, { services, timeoutMs: msConfig?.timeoutMs });
            options.microsoftAuthRef.current = auth;
            options.microsoftServiceRef.current = service;
            options.toolExecutorRef.current?.setMicrosoftService(service);
          } catch (initErr) {
            return { success: false, message: `Config saved but auth init failed: ${initErr instanceof Error ? initErr.message : String(initErr)}` };
          }
        }

        return { success: true, message: 'Microsoft configuration saved.' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    onMicrosoftAuthCancel: async () => {
      const auth = options.microsoftAuthRef.current;
      if (!auth) return { success: false, message: 'Microsoft auth not initialized.' };
      auth.cancelPendingAuth('Microsoft OAuth flow was cancelled from the web UI.');
      return { success: true, message: 'Cancelled pending Microsoft auth flow.' };
    },

    onMicrosoftDisconnect: async () => {
      const auth = options.microsoftAuthRef.current;
      if (!auth) return { success: false, message: 'Native Microsoft integration is not enabled.' };
      try {
        await auth.disconnect();
        return { success: true, message: 'Disconnected.' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    onCloudTest: async (providerKey: string, profileId: string) => {
      const runtimeCreds = resolveRuntimeCredentialView(options.configRef.current, options.secretStore);
      const cloud = runtimeCreds.resolvedCloud;
      if (!cloud) return { success: false, message: 'Cloud tools are not configured.' };

      try {
        switch (providerKey) {
          case 'cpanelProfiles': {
            const profile = cloud.cpanelProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `cPanel profile '${profileId}' not found.` };
            if (!profile.apiToken) return { success: false, message: `No credential resolved for cPanel profile '${profileId}'.` };
            await options.testCloudConnections.cpanel(profile);
            return { success: true, message: `cPanel profile '${profile.name}': connected.` };
          }
          case 'vercelProfiles': {
            const profile = cloud.vercelProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `Vercel profile '${profileId}' not found.` };
            if (!profile.apiToken) return { success: false, message: `No credential resolved for Vercel profile '${profileId}'.` };
            await options.testCloudConnections.vercel(profile);
            return { success: true, message: `Vercel profile '${profile.name}': connected.` };
          }
          case 'daytonaProfiles': {
            const profile = cloud.daytonaProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `Daytona profile '${profileId}' not found.` };
            if (!profile.apiKey) return { success: false, message: `No credential resolved for Daytona profile '${profileId}'.` };
            await options.testCloudConnections.daytona(profile);
            return { success: true, message: `Daytona profile '${profile.name}': connected.` };
          }
          case 'cloudflareProfiles': {
            const profile = cloud.cloudflareProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `Cloudflare profile '${profileId}' not found.` };
            if (!profile.apiToken) return { success: false, message: `No credential resolved for Cloudflare profile '${profileId}'.` };
            await options.testCloudConnections.cloudflare(profile);
            return { success: true, message: `Cloudflare profile '${profile.name}': connected.` };
          }
          case 'awsProfiles': {
            const profile = cloud.awsProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `AWS profile '${profileId}' not found.` };
            if (!profile.accessKeyId && !profile.sessionToken) {
              return { success: false, message: `No credential resolved for AWS profile '${profileId}'.` };
            }
            await options.testCloudConnections.aws(profile);
            return { success: true, message: `AWS profile '${profile.name}': connected.` };
          }
          case 'gcpProfiles': {
            const profile = cloud.gcpProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `GCP profile '${profileId}' not found.` };
            if (!profile.accessToken && !profile.serviceAccountJson) {
              return { success: false, message: `No credential resolved for GCP profile '${profileId}'.` };
            }
            await options.testCloudConnections.gcp(profile);
            return { success: true, message: `GCP profile '${profile.name}': connected.` };
          }
          case 'azureProfiles': {
            const profile = cloud.azureProfiles?.find((entry) => entry.id === profileId);
            if (!profile) return { success: false, message: `Azure profile '${profileId}' not found.` };
            if (!profile.accessToken && !profile.clientId) {
              return { success: false, message: `No credential resolved for Azure profile '${profileId}'.` };
            }
            await options.testCloudConnections.azure(profile);
            return { success: true, message: `Azure profile '${profile.name}': connected.` };
          }
          default:
            return { success: false, message: `Unknown cloud provider: '${providerKey}'.` };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Connection failed: ${message}` };
      }
    },
  };
}
