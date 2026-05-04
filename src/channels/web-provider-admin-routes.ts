import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardCallbacks } from './web-types.js';
import { readBody, sendJSON } from './web-json.js';

interface WebProviderAdminRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  requirePrivilegedTicket: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    action: 'guardian.config' | 'policy.config' | 'factory-reset' | 'killswitch',
    presented?: string,
  ) => boolean;
  maybeEmitUIInvalidation: (result: unknown, topics: string[], reason: string, path: string) => void;
}

export async function handleWebProviderAdminRoutes(
  context: WebProviderAdminRoutesContext,
): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'GET' && url.pathname === '/api/gws/status') {
    if (dashboard.onGoogleStatus) {
      const status = await dashboard.onGoogleStatus();
      sendJSON(res, 200, {
        installed: true,
        authenticated: status.authenticated,
        authMethod: 'native_oauth',
        authPending: status.authPending,
        tokenExpiry: status.tokenExpiry,
        services: status.services,
        enabled: true,
        mode: status.mode,
        legacyEndpoint: true,
      });
      return true;
    }
    if (!dashboard.onGwsStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGwsStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/gws/reauth') {
    sendJSON(res, 410, {
      success: false,
      message: 'Legacy gws CLI authentication is no longer used. Start native Google OAuth with /api/google/auth/start or use the Google Workspace settings page.',
      nextAction: 'Open Settings > Integrations > Google Workspace and click Connect Google.',
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/google/status') {
    if (!dashboard.onGoogleStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGoogleStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/google/auth/start') {
    if (!dashboard.onGoogleAuthStart) {
      sendJSON(res, 404, { error: 'Native Google integration not enabled' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { services?: string[] };
    sendJSON(res, 200, await dashboard.onGoogleAuthStart(parsed.services ?? []));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/google/credentials') {
    if (!dashboard.onGoogleCredentials) {
      sendJSON(res, 404, { error: 'Native Google integration not enabled' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { credentials?: string };
    if (!parsed.credentials) {
      sendJSON(res, 400, { success: false, message: 'Missing credentials field.' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGoogleCredentials(parsed.credentials));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/google/auth/cancel') {
    if (!dashboard.onGoogleAuthCancel) {
      sendJSON(res, 404, { error: 'Native Google integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGoogleAuthCancel());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/google/disconnect') {
    if (!dashboard.onGoogleDisconnect) {
      sendJSON(res, 404, { error: 'Native Google integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGoogleDisconnect());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/microsoft/status') {
    if (!dashboard.onMicrosoftStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onMicrosoftStatus());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/github/status') {
    if (!dashboard.onGitHubStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGitHubStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/github/auth/start') {
    if (!dashboard.onGitHubAuthStart) {
      sendJSON(res, 404, { error: 'Native GitHub integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGitHubAuthStart());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/github/auth/cancel') {
    if (!dashboard.onGitHubAuthCancel) {
      sendJSON(res, 404, { error: 'Native GitHub integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGitHubAuthCancel());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/github/disconnect') {
    if (!dashboard.onGitHubDisconnect) {
      sendJSON(res, 404, { error: 'Native GitHub integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onGitHubDisconnect());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/microsoft/auth/start') {
    if (!dashboard.onMicrosoftAuthStart) {
      sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { services?: string[] };
    sendJSON(res, 200, await dashboard.onMicrosoftAuthStart(parsed.services ?? []));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/microsoft/config') {
    if (!dashboard.onMicrosoftConfig) {
      sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body || '{}') as { clientId?: string; tenantId?: string };
    if (!parsed.clientId) {
      sendJSON(res, 400, { success: false, message: 'Missing clientId field.' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onMicrosoftConfig({
      clientId: parsed.clientId,
      tenantId: parsed.tenantId,
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/microsoft/auth/cancel') {
    if (!dashboard.onMicrosoftAuthCancel) {
      sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onMicrosoftAuthCancel());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/microsoft/disconnect') {
    if (!dashboard.onMicrosoftDisconnect) {
      sendJSON(res, 404, { error: 'Native Microsoft integration not enabled' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onMicrosoftDisconnect());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/guardian-agent/status') {
    if (!dashboard.onGuardianAgentStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onGuardianAgentStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/guardian-agent/config') {
    if (!dashboard.onGuardianAgentUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const input = JSON.parse(body) as {
      enabled?: boolean;
      llmProvider?: 'local' | 'external' | 'auto';
      failOpen?: boolean;
      timeoutMs?: number;
      ticket?: string;
    };
    if (!context.requirePrivilegedTicket(req, res, url, 'guardian.config', input.ticket)) {
      return true;
    }
    const result = dashboard.onGuardianAgentUpdate(input);
    sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
    context.maybeEmitUIInvalidation(result, ['config', 'security'], 'guardian-agent.updated', url.pathname);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/policy/status') {
    if (!dashboard.onPolicyStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onPolicyStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/policy/config') {
    if (!dashboard.onPolicyUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const input = JSON.parse(body) as {
      enabled?: boolean;
      mode?: 'off' | 'shadow' | 'enforce';
      families?: {
        tool?: 'off' | 'shadow' | 'enforce';
        admin?: 'off' | 'shadow' | 'enforce';
        guardian?: 'off' | 'shadow' | 'enforce';
        event?: 'off' | 'shadow' | 'enforce';
      };
      mismatchLogLimit?: number;
      ticket?: string;
    };
    if (!context.requirePrivilegedTicket(req, res, url, 'policy.config', input.ticket)) {
      return true;
    }
    const result = dashboard.onPolicyUpdate(input);
    sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
    context.maybeEmitUIInvalidation(result, ['config', 'security'], 'policy.config.updated', url.pathname);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/policy/reload') {
    if (!dashboard.onPolicyReload) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    let parsed: { ticket?: string } = {};
    try {
      const body = await readBody(req, context.maxBodyBytes);
      if (body.trim()) {
        parsed = JSON.parse(body) as { ticket?: string };
      }
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!context.requirePrivilegedTicket(req, res, url, 'policy.config', parsed.ticket)) {
      return true;
    }
    const result = dashboard.onPolicyReload();
    sendJSON(res, 200, result);
    context.maybeEmitUIInvalidation(result, ['config', 'security'], 'policy.reloaded', url.pathname);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/sentinel/audit') {
    if (!dashboard.onSentinelAuditRun) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    let windowMs: number | undefined;
    try {
      const body = await readBody(req, context.maxBodyBytes);
      if (body) {
        const parsed = JSON.parse(body) as { windowMs?: number };
        windowMs = parsed.windowMs;
      }
    } catch { /* empty body is fine */ }
    const result = await dashboard.onSentinelAuditRun(windowMs);
    sendJSON(res, 200, result);
    context.maybeEmitUIInvalidation(result, ['security'], 'sentinel.audit.completed', url.pathname);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/factory-reset') {
    if (!dashboard.onFactoryReset) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const body = await readBody(req, context.maxBodyBytes);
    const parsed = JSON.parse(body) as { scope?: string; ticket?: string };
    if (!parsed.scope || !['data', 'config', 'all'].includes(parsed.scope)) {
      sendJSON(res, 400, { error: 'scope must be "data", "config", or "all"' });
      return true;
    }
    if (!context.requirePrivilegedTicket(req, res, url, 'factory-reset', parsed.ticket)) {
      return true;
    }
    const result = await dashboard.onFactoryReset({ scope: parsed.scope as 'data' | 'config' | 'all' });
    sendJSON(res, 200, result);
    context.maybeEmitUIInvalidation(
      result,
      ['dashboard', 'config', 'providers', 'tools', 'automations', 'network', 'security'],
      'factory-reset.completed',
      url.pathname,
    );
    if (parsed.scope === 'all' && result.success && dashboard.onKillswitch) {
      setTimeout(() => dashboard.onKillswitch!(), 100);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/killswitch') {
    if (!dashboard.onKillswitch) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    let parsed: { ticket?: string } = {};
    try {
      const body = await readBody(req, context.maxBodyBytes);
      if (body.trim()) {
        parsed = JSON.parse(body) as { ticket?: string };
      }
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!context.requirePrivilegedTicket(req, res, url, 'killswitch', parsed.ticket)) {
      return true;
    }
    sendJSON(res, 200, { success: true, message: 'Shutting down...' });
    setTimeout(() => dashboard.onKillswitch!(), 100);
    return true;
  }

  return false;
}
