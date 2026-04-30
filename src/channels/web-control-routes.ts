import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrincipalRole } from '../tools/types.js';
import type { DashboardCallbacks } from './web-types.js';
import { readJsonBody, readOptionalJsonBody, sendJSON } from './web-json.js';
import { resolveWebSurfaceId } from '../runtime/channel-surface-ids.js';

interface RequestPrincipal {
  principalId: string;
  principalRole: PrincipalRole;
}

interface WebControlRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  resolveRequestPrincipal: (req: IncomingMessage) => RequestPrincipal;
  maybeEmitUIInvalidation: (result: unknown, topics: string[], reason: string, path: string) => void;
  requirePrivilegedTicket: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    action: string,
    presented?: string,
  ) => boolean;
  isPrivilegedTicketAction: (value: string) => boolean;
  recordPrivilegedTicketMint: (req: IncomingMessage, action: string) => number;
  sendPrivilegedTicketRateLimited: (res: ServerResponse, retryAfterMs: number) => void;
  mintPrivilegedTicket: (action: string) => string;
  privilegedTicketTtlSeconds: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeApprovalDecision(value: unknown): 'approved' | 'denied' | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'approve':
    case 'approved':
      return 'approved';
    case 'deny':
    case 'denied':
    case 'reject':
    case 'rejected':
      return 'denied';
    default:
      return undefined;
  }
}

function sendBadRequestError(res: ServerResponse, err: unknown): void {
  sendJSON(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
}

function toolInvalidationTopics(toolName: string): string[] {
  const topics = ['tools'];
  if (toolName.startsWith('intel_')) {
    topics.push('threat-intel');
  }
  if (toolName.startsWith('memory_')) {
    topics.push('dashboard');
  }
  return topics;
}

export async function handleWebControlRoutes(context: WebControlRoutesContext): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    if (!dashboard.onAuthStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onAuthStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/ticket') {
    try {
      const parsed = await readOptionalJsonBody<{ action?: string }>(req, context.maxBodyBytes, {});
      const action = (parsed.action ?? '').trim();
      if (!context.isPrivilegedTicketAction(action)) {
        sendJSON(res, 400, { error: 'Invalid privileged action' });
        return true;
      }
      const retryAfterMs = context.recordPrivilegedTicketMint(req, action);
      if (retryAfterMs > 0) {
        context.sendPrivilegedTicketRateLimited(res, retryAfterMs);
        return true;
      }
      const ticket = context.mintPrivilegedTicket(action);
      sendJSON(res, 200, {
        action,
        ticket,
        expiresIn: context.privilegedTicketTtlSeconds,
      });
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/config') {
    if (!dashboard.onAuthUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{
        mode?: 'bearer_required' | 'disabled';
        token?: string;
        rotateOnStartup?: boolean;
        sessionTtlMinutes?: number;
        ticket?: string;
      }>(req, context.maxBodyBytes, {});
      if (!context.requirePrivilegedTicket(req, res, url, 'auth.config', parsed.ticket)) {
        return true;
      }
      const result = await dashboard.onAuthUpdate(parsed);
      sendJSON(res, 200, result);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/token/rotate') {
    if (!dashboard.onAuthRotate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{ ticket?: string }>(req, context.maxBodyBytes, {});
      if (!context.requirePrivilegedTicket(req, res, url, 'auth.rotate', parsed.ticket)) {
        return true;
      }
      sendJSON(res, 200, await dashboard.onAuthRotate());
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/token/reveal') {
    if (!dashboard.onAuthReveal) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{ ticket?: string }>(req, context.maxBodyBytes, {});
      if (!context.requirePrivilegedTicket(req, res, url, 'auth.reveal', parsed.ticket)) {
        return true;
      }
      sendJSON(res, 200, await dashboard.onAuthReveal());
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    if (!dashboard.onToolsState) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    sendJSON(res, 200, dashboard.onToolsState({ limit: Number.isFinite(limit) ? limit : 50 }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    if (!dashboard.onSkillsState) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onSkillsState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills') {
    if (!dashboard.onSkillsUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ skillId?: string; enabled?: boolean }>(req, context.maxBodyBytes);
      if (!parsed.skillId || typeof parsed.enabled !== 'boolean') {
        sendJSON(res, 400, { error: 'skillId and enabled are required' });
        return true;
      }
      const result = dashboard.onSkillsUpdate({
        skillId: parsed.skillId,
        enabled: parsed.enabled,
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'skills'], 'skills.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/run') {
    if (!dashboard.onToolsRun) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{
        toolName?: string;
        args?: Record<string, unknown>;
        origin?: 'assistant' | 'cli' | 'web';
        agentId?: string;
        userId?: string;
        surfaceId?: string;
        contentTrustLevel?: 'trusted' | 'low_trust' | 'quarantined';
        taintReasons?: string[];
        derivedFromTaintedContent?: boolean;
        scheduleId?: string;
        channel?: string;
        metadata?: Record<string, unknown>;
      }>(req, context.maxBodyBytes);
      if (!parsed.toolName) {
        sendJSON(res, 400, { error: 'toolName is required' });
        return true;
      }
      const principal = context.resolveRequestPrincipal(req);
      const result = await dashboard.onToolsRun({
        toolName: parsed.toolName,
        args: parsed.args ?? {},
        origin: parsed.origin ?? 'web',
        agentId: parsed.agentId,
        userId: parsed.userId ?? 'web-user',
        surfaceId: trimOptionalString(parsed.surfaceId),
        principalId: principal.principalId,
        principalRole: principal.principalRole,
        contentTrustLevel: parsed.contentTrustLevel === 'quarantined'
          ? 'quarantined'
          : parsed.contentTrustLevel === 'low_trust'
            ? 'low_trust'
            : parsed.contentTrustLevel === 'trusted'
              ? 'trusted'
              : undefined,
        taintReasons: Array.isArray(parsed.taintReasons)
          ? parsed.taintReasons.filter((value): value is string => typeof value === 'string')
          : undefined,
        derivedFromTaintedContent: parsed.derivedFromTaintedContent === true,
        scheduleId: typeof parsed.scheduleId === 'string' ? parsed.scheduleId : undefined,
        channel: parsed.channel ?? 'web',
        metadata: asRecord(parsed.metadata),
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, toolInvalidationTopics(parsed.toolName), 'tools.run', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/preflight') {
    if (!dashboard.onToolsPreflight) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{
        tools?: string[];
        requests?: Array<{ name?: string; args?: Record<string, unknown> }>;
      }>(req, context.maxBodyBytes, {});
      const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === 'string') : [];
      const requests = Array.isArray(parsed.requests)
        ? parsed.requests
          .filter((item): item is { name: string; args?: Record<string, unknown> } =>
            !!item && typeof item.name === 'string' && item.name.trim().length > 0)
          .map((item) => ({ name: item.name, ...(item.args && typeof item.args === 'object' ? { args: item.args } : {}) }))
        : [];
      if (tools.length === 0 && requests.length === 0) {
        sendJSON(res, 400, { error: 'tools array or requests array is required' });
        return true;
      }
      sendJSON(res, 200, await dashboard.onToolsPreflight({ tools, requests }));
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/policy') {
    if (!dashboard.onToolsPolicyUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{
        mode?: 'approve_each' | 'approve_by_policy' | 'autonomous';
        toolPolicies?: Record<string, 'auto' | 'policy' | 'manual' | 'deny'>;
        sandbox?: {
          allowedPaths?: string[];
          allowedCommands?: string[];
          allowedDomains?: string[];
        };
        ticket?: string;
      }>(req, context.maxBodyBytes, {});
      if (!context.requirePrivilegedTicket(req, res, url, 'tools.policy', parsed.ticket)) {
        return true;
      }
      const result = dashboard.onToolsPolicyUpdate(parsed);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'tools', 'security'], 'tools.policy.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tools/approvals/pending') {
    if (!dashboard.onToolsPendingApprovals) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const principal = context.resolveRequestPrincipal(req);
    const userId = url.searchParams.get('userId') ?? 'web-user';
    const channel = url.searchParams.get('channel') ?? 'web';
    const limitValue = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 20;
    sendJSON(res, 200, dashboard.onToolsPendingApprovals({ userId, channel, principalId: principal.principalId, limit }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/pending-action') {
    if (!dashboard.onPendingActionCurrent) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const principal = context.resolveRequestPrincipal(req);
    const userId = url.searchParams.get('userId') ?? 'web-user';
    const channel = url.searchParams.get('channel') ?? 'web';
    const surfaceId = resolveWebSurfaceId(trimOptionalString(url.searchParams.get('surfaceId')));
    sendJSON(res, 200, dashboard.onPendingActionCurrent({
      userId,
      principalId: principal.principalId,
      channel,
      surfaceId,
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/pending-action/reset') {
    if (!dashboard.onPendingActionReset) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{
        userId?: string;
        channel?: string;
        surfaceId?: string;
      }>(req, context.maxBodyBytes, {});
      const principal = context.resolveRequestPrincipal(req);
      const result = await dashboard.onPendingActionReset({
        userId: trimOptionalString(parsed.userId) ?? 'web-user',
        principalId: principal.principalId,
        principalRole: principal.principalRole,
        channel: trimOptionalString(parsed.channel) ?? 'web',
        surfaceId: resolveWebSurfaceId(trimOptionalString(parsed.surfaceId)),
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['dashboard', 'tools'], 'chat.pending-action.reset', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/approvals/decision') {
    if (!dashboard.onToolsApprovalDecision) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{
        approvalId?: string;
        decision?: unknown;
        actor?: string;
        userId?: string;
        channel?: string;
        surfaceId?: string;
        reason?: string;
      }>(req, context.maxBodyBytes);
      const decision = normalizeApprovalDecision(parsed.decision);
      if (!parsed.approvalId || !decision) {
        sendJSON(res, 400, { error: 'approvalId and decision are required' });
        return true;
      }
      const principal = context.resolveRequestPrincipal(req);
      const userId = trimOptionalString(parsed.userId) ?? 'web-user';
      const channel = trimOptionalString(parsed.channel) ?? 'web';
      const surfaceId = resolveWebSurfaceId(trimOptionalString(parsed.surfaceId));
      const result = await dashboard.onToolsApprovalDecision({
        approvalId: parsed.approvalId,
        decision,
        actor: principal.principalId,
        actorRole: principal.principalRole,
        userId,
        channel,
        surfaceId,
        reason: parsed.reason,
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'tools', 'automations'], 'tools.approval.decided', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tools/categories') {
    if (!dashboard.onToolsCategories) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onToolsCategories());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/categories') {
    if (!dashboard.onToolsCategoryToggle) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ category: string; enabled: boolean }>(req, context.maxBodyBytes);
      if (!parsed.category || typeof parsed.enabled !== 'boolean') {
        sendJSON(res, 400, { error: 'Missing category or enabled field' });
        return true;
      }
      const result = dashboard.onToolsCategoryToggle(parsed as Parameters<NonNullable<DashboardCallbacks['onToolsCategoryToggle']>>[0]);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'tools'], 'tools.category.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/provider-routing') {
    if (!dashboard.onToolsProviderRoutingUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ routing?: Record<string, string>; enabled?: boolean }>(req, context.maxBodyBytes);
      if (!parsed.routing && typeof parsed.enabled !== 'boolean') {
        sendJSON(res, 400, { error: 'routing object or enabled flag is required' });
        return true;
      }
      const result = dashboard.onToolsProviderRoutingUpdate({
        routing: parsed.routing as Record<string, 'local' | 'external' | 'default'> | undefined,
        enabled: parsed.enabled,
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'tools'], 'tools.routing.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tools/browser') {
    if (!dashboard.onBrowserConfigState) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onBrowserConfigState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/browser') {
    if (!dashboard.onBrowserConfigUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{
        enabled?: boolean;
        allowedDomains?: string[];
        playwrightEnabled?: boolean;
        playwrightBrowser?: string;
        playwrightCaps?: string;
      }>(req, context.maxBodyBytes);
      const result = await dashboard.onBrowserConfigUpdate(parsed);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'tools'], 'tools.browser.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/connectors/state') {
    if (!dashboard.onConnectorsState) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limitRuns = parseInt(url.searchParams.get('limitRuns') ?? '50', 10);
    sendJSON(res, 200, dashboard.onConnectorsState({
      limitRuns: Number.isFinite(limitRuns) ? limitRuns : 50,
    }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors/settings') {
    if (!dashboard.onConnectorsSettingsUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<
        Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] & { ticket?: string }
      >(req, context.maxBodyBytes, {} as Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0] & { ticket?: string });
      const requireTicket = dashboard.onConnectorsState?.({ limitRuns: 1 }).studio.requirePrivilegedTicket ?? false;
      if (requireTicket && !context.requirePrivilegedTicket(req, res, url, 'connectors.config', parsed.ticket)) {
        return true;
      }
      const result = dashboard.onConnectorsSettingsUpdate(parsed);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['automations', 'config'], 'connectors.settings.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors/packs/upsert') {
    if (!dashboard.onConnectorsPackUpsert) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<
        Parameters<NonNullable<DashboardCallbacks['onConnectorsPackUpsert']>>[0] & { ticket?: string }
      >(req, context.maxBodyBytes);
      if (!parsed?.id) {
        sendJSON(res, 400, { error: 'pack.id is required' });
        return true;
      }
      const requireTicket = dashboard.onConnectorsState?.({ limitRuns: 1 }).studio.requirePrivilegedTicket ?? false;
      if (requireTicket && !context.requirePrivilegedTicket(req, res, url, 'connectors.pack', parsed.ticket)) {
        return true;
      }
      const result = dashboard.onConnectorsPackUpsert(parsed);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['automations', 'config'], 'connectors.pack.upserted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors/packs/delete') {
    if (!dashboard.onConnectorsPackDelete) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ packId?: string; ticket?: string }>(req, context.maxBodyBytes);
      if (!parsed.packId?.trim()) {
        sendJSON(res, 400, { error: 'packId is required' });
        return true;
      }
      const requireTicket = dashboard.onConnectorsState?.({ limitRuns: 1 }).studio.requirePrivilegedTicket ?? false;
      if (requireTicket && !context.requirePrivilegedTicket(req, res, url, 'connectors.pack', parsed.ticket)) {
        return true;
      }
      const result = dashboard.onConnectorsPackDelete(parsed.packId.trim());
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['automations', 'config'], 'connectors.pack.deleted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  return false;
}
