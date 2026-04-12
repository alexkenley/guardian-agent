import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../../config/types.js';
import { createProviderIntegrationCallbacks } from './provider-integration-callbacks.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

function createOptions(overrides: Partial<Parameters<typeof createProviderIntegrationCallbacks>[0]> = {}): Parameters<typeof createProviderIntegrationCallbacks>[0] {
  const configRef = { current: createConfig() };
  return {
    configRef,
    googleAuthRef: { current: null },
    googleServiceRef: { current: null },
    microsoftAuthRef: { current: null },
    microsoftServiceRef: { current: null },
    toolExecutorRef: { current: null },
    enabledManagedProviders: new Set<string>(),
    secretStore: {} as never,
    loadRawConfig: () => ({}),
    persistAndApplyConfig: () => ({ success: true, message: 'ok' }),
    probeGwsCli: vi.fn(async () => ({ installed: false, authenticated: false })),
    testCloudConnections: {
      cpanel: vi.fn(async () => {}),
      vercel: vi.fn(async () => {}),
      daytona: vi.fn(async () => {}),
      cloudflare: vi.fn(async () => {}),
      aws: vi.fn(async () => {}),
      gcp: vi.fn(async () => {}),
      azure: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('createProviderIntegrationCallbacks', () => {
  it('reports pending native auth state for Google and Microsoft', async () => {
    const googleAuth = {
      isAuthenticated: vi.fn(() => false),
      hasPendingAuth: vi.fn(() => true),
      getTokenExpiry: vi.fn(() => undefined),
    };
    const microsoftAuth = {
      isAuthenticated: vi.fn(() => false),
      hasPendingAuth: vi.fn(() => true),
      getTokenExpiry: vi.fn(() => undefined),
    };

    const callbacks = createProviderIntegrationCallbacks(createOptions({
      googleAuthRef: { current: googleAuth as never },
      microsoftAuthRef: { current: microsoftAuth as never },
    }));

    await expect(callbacks.onGoogleStatus?.()).resolves.toMatchObject({
      authenticated: false,
      authPending: true,
    });
    await expect(callbacks.onMicrosoftStatus?.()).resolves.toMatchObject({
      authenticated: false,
      authPending: true,
    });
  });

  it('cancels pending native auth flows from the dashboard callbacks', async () => {
    const googleAuth = {
      cancelPendingAuth: vi.fn(),
    };
    const microsoftAuth = {
      cancelPendingAuth: vi.fn(),
    };

    const callbacks = createProviderIntegrationCallbacks(createOptions({
      googleAuthRef: { current: googleAuth as never },
      microsoftAuthRef: { current: microsoftAuth as never },
    }));

    await expect(callbacks.onGoogleAuthCancel?.()).resolves.toEqual({
      success: true,
      message: 'Cancelled pending Google auth flow.',
    });
    await expect(callbacks.onMicrosoftAuthCancel?.()).resolves.toEqual({
      success: true,
      message: 'Cancelled pending Microsoft auth flow.',
    });
    expect(googleAuth.cancelPendingAuth).toHaveBeenCalledOnce();
    expect(microsoftAuth.cancelPendingAuth).toHaveBeenCalledOnce();
  });

  it('tests a configured cPanel profile through the injected cloud tester', async () => {
    const config = createConfig();
    config.assistant.tools.cloud = {
      enabled: true,
      cpanelProfiles: [
        {
          id: 'cp-1',
          name: 'Primary',
          type: 'cpanel',
          host: 'example.test',
          username: 'root',
          apiToken: 'secret-token',
          ssl: true,
          allowSelfSigned: false,
        },
      ],
    };
    const testCloudConnections = {
      cpanel: vi.fn(async () => {}),
      vercel: vi.fn(async () => {}),
      daytona: vi.fn(async () => {}),
      cloudflare: vi.fn(async () => {}),
      aws: vi.fn(async () => {}),
      gcp: vi.fn(async () => {}),
      azure: vi.fn(async () => {}),
    };

    const callbacks = createProviderIntegrationCallbacks(createOptions({
      configRef: { current: config },
      testCloudConnections,
    }));

    const result = await callbacks.onCloudTest?.('cpanelProfiles', 'cp-1');

    expect(testCloudConnections.cpanel).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, message: "cPanel profile 'Primary': connected." });
  });

  it('tests a configured Daytona profile through the injected cloud tester', async () => {
    const config = createConfig();
    config.assistant.tools.cloud = {
      enabled: true,
      daytonaProfiles: [
        {
          id: 'daytona-1',
          name: 'Primary Daytona',
          apiKey: 'secret-token',
          enabled: true,
          language: 'typescript',
        },
      ],
    };
    const testCloudConnections = {
      cpanel: vi.fn(async () => {}),
      vercel: vi.fn(async () => {}),
      daytona: vi.fn(async () => {}),
      cloudflare: vi.fn(async () => {}),
      aws: vi.fn(async () => {}),
      gcp: vi.fn(async () => {}),
      azure: vi.fn(async () => {}),
    };

    const callbacks = createProviderIntegrationCallbacks(createOptions({
      configRef: { current: config },
      testCloudConnections,
    }));

    const result = await callbacks.onCloudTest?.('daytonaProfiles', 'daytona-1');

    expect(testCloudConnections.daytona).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, message: "Daytona profile 'Primary Daytona': connected." });
  });

  it('returns a configuration error when cloud tools are not enabled', async () => {
    const config = createConfig();
    config.assistant.tools.cloud = undefined as never;
    const callbacks = createProviderIntegrationCallbacks(createOptions({
      configRef: { current: config },
    }));

    const result = await callbacks.onCloudTest?.('cpanelProfiles', 'cp-1');

    expect(result).toEqual({ success: false, message: 'Cloud tools are not configured.' });
  });
});
