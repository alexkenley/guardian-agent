import type { WebAuthRuntimeConfig } from '../../channels/web.js';
import type { DashboardCallbacks } from '../../channels/web-types.js';
import type { GuardianAgentConfig } from '../../config/types.js';

type AuthControlCallbacks = Pick<
  DashboardCallbacks,
  'onAuthStatus' | 'onAuthUpdate' | 'onAuthRotate' | 'onAuthReveal'
>;

interface AuthControlCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  webAuthStateRef: { current: WebAuthRuntimeConfig };
  applyWebAuthRuntime: (auth: WebAuthRuntimeConfig) => void;
  generateSecureToken: () => string;
  loadRawConfig: () => Record<string, unknown>;
  persistAndApplyConfig: (
    rawConfig: Record<string, unknown>,
    meta?: { changedBy?: string; reason?: string },
  ) => { success: boolean; message: string };
  trackAnalytics: (type: string, metadata?: Record<string, unknown>) => void;
}

export function createAuthControlCallbacks(options: AuthControlCallbackOptions): AuthControlCallbacks {
  const getAuthStatus = () => ({
    mode: options.webAuthStateRef.current.mode,
    tokenConfigured: !!options.webAuthStateRef.current.token,
    tokenSource: options.webAuthStateRef.current.tokenSource ?? 'ephemeral',
    tokenPreview: options.webAuthStateRef.current.token
      ? `${options.webAuthStateRef.current.token.slice(0, 4)}...${options.webAuthStateRef.current.token.slice(-4)}`
      : undefined,
    rotateOnStartup: !!options.webAuthStateRef.current.rotateOnStartup,
    sessionTtlMinutes: options.webAuthStateRef.current.sessionTtlMinutes,
    host: options.configRef.current.channels.web?.host ?? 'localhost',
    port: options.configRef.current.channels.web?.port ?? 3000,
  });

  const persistAuthState = (): { success: boolean; message: string } => {
    const rawConfig = options.loadRawConfig();
    rawConfig.channels = rawConfig.channels ?? {};
    const rawChannels = rawConfig.channels as Record<string, unknown>;
    const rawWeb = (rawChannels.web as Record<string, unknown> | undefined) ?? {};
    rawWeb.enabled = rawWeb.enabled ?? true;
    rawWeb.auth = {
      mode: options.webAuthStateRef.current.mode,
      rotateOnStartup: options.webAuthStateRef.current.rotateOnStartup ?? false,
      sessionTtlMinutes: options.webAuthStateRef.current.sessionTtlMinutes,
      tokenSource: options.webAuthStateRef.current.tokenSource ?? 'ephemeral',
    };
    delete (rawWeb.auth as Record<string, unknown>).token;
    delete rawWeb.authToken;
    rawChannels.web = rawWeb;
    return options.persistAndApplyConfig(rawConfig, {
      changedBy: 'auth-control',
      reason: 'web auth settings update',
    });
  };

  return {
    onAuthStatus: () => getAuthStatus(),

    onAuthUpdate: async (input) => {
      if (input.token?.trim()) {
        return {
          success: false,
          message: 'Dashboard auth no longer accepts raw token values. Use Rotate Token for an ephemeral runtime token instead.',
          status: getAuthStatus(),
        };
      }
      const nextMode = input.mode ?? options.webAuthStateRef.current.mode;
      const nextToken = nextMode === 'bearer_required'
        ? (options.webAuthStateRef.current.token || options.generateSecureToken())
        : options.webAuthStateRef.current.token;
      options.webAuthStateRef.current = {
        ...options.webAuthStateRef.current,
        mode: nextMode,
        token: nextToken,
        rotateOnStartup: input.rotateOnStartup ?? options.webAuthStateRef.current.rotateOnStartup,
        sessionTtlMinutes: input.sessionTtlMinutes ?? options.webAuthStateRef.current.sessionTtlMinutes,
        tokenSource: nextToken ? (options.webAuthStateRef.current.tokenSource ?? 'ephemeral') : 'ephemeral',
      };
      options.applyWebAuthRuntime(options.webAuthStateRef.current);
      const persisted = persistAuthState();
      if (!persisted.success) {
        return { success: false, message: persisted.message, status: getAuthStatus() };
      }
      options.trackAnalytics('auth_updated', { mode: nextMode });
      return { success: true, message: 'Web auth settings saved.', status: getAuthStatus() };
    },

    onAuthRotate: async () => {
      const token = options.generateSecureToken();
      options.webAuthStateRef.current = {
        ...options.webAuthStateRef.current,
        token,
        tokenSource: 'ephemeral',
      };
      options.applyWebAuthRuntime(options.webAuthStateRef.current);
      const persisted = persistAuthState();
      if (!persisted.success) {
        return { success: false, message: persisted.message, status: getAuthStatus() };
      }
      options.trackAnalytics('auth_token_rotated');
      return { success: true, message: 'Bearer token rotated.', token, status: getAuthStatus() };
    },

    onAuthReveal: () => ({
      success: !!options.webAuthStateRef.current.token,
      token: options.webAuthStateRef.current.token,
    }),
  };
}
