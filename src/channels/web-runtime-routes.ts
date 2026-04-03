import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditEventType, AuditSeverity } from '../guardian/audit-log.js';
import type { DashboardCallbacks } from './web-types.js';
import { readJsonBody, sendJSON } from './web-json.js';

type PrivilegedTicketAction =
  | 'auth.config'
  | 'auth.rotate'
  | 'auth.reveal'
  | 'connectors.config'
  | 'connectors.pack'
  | 'connectors.playbook'
  | 'guardian.config'
  | 'policy.config'
  | 'tools.policy'
  | 'config.security'
  | 'memory.config'
  | 'search.pick-path'
  | 'killswitch'
  | 'factory-reset';

interface WebRuntimeRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  maybeEmitUIInvalidation: (result: unknown, topics: string[], reason: string, path: string) => void;
  requirePrivilegedTicket: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    action: PrivilegedTicketAction,
    presented?: string,
  ) => boolean;
  getConfigPrivilegedAction: (parsed: Record<string, unknown> | undefined) => PrivilegedTicketAction | undefined;
  logInternalError: (message: string, err: unknown) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sendBadRequestError(res: ServerResponse, err: unknown): void {
  sendJSON(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
}

export async function handleWebRuntimeRoutes(context: WebRuntimeRoutesContext): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'GET' && url.pathname === '/api/agents') {
    if (!dashboard.onAgents) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onAgents());
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/agents/')) {
    if (!dashboard.onAgentDetail) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const id = url.pathname.slice('/api/agents/'.length);
    if (!id) {
      sendJSON(res, 400, { error: 'Agent ID required' });
      return true;
    }
    const detail = dashboard.onAgentDetail(id);
    if (!detail) {
      sendJSON(res, 404, { error: `Agent '${id}' not found` });
      return true;
    }
    sendJSON(res, 200, detail);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/verify') {
    if (!dashboard.onAuditVerifyChain) {
      sendJSON(res, 404, { error: 'Audit persistence not available' });
      return true;
    }
    try {
      const result = await dashboard.onAuditVerifyChain();
      sendJSON(res, 200, result);
    } catch (err) {
      context.logInternalError('Audit verification failed', err);
      sendJSON(res, 500, { error: 'Audit verification failed' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/summary') {
    if (!dashboard.onAuditSummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const windowMs = parseInt(url.searchParams.get('windowMs') ?? '300000', 10);
    sendJSON(res, 200, dashboard.onAuditSummary(windowMs));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    if (!dashboard.onAuditQuery) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const filter: Record<string, unknown> = {};
    const type = url.searchParams.get('type');
    if (type) filter.type = type as AuditEventType;
    const agentId = url.searchParams.get('agentId');
    if (agentId) filter.agentId = agentId;
    const severity = url.searchParams.get('severity');
    if (severity) filter.severity = severity as AuditSeverity;
    const limit = url.searchParams.get('limit');
    if (limit) filter.limit = parseInt(limit, 10);
    const after = url.searchParams.get('after');
    if (after) filter.after = parseInt(after, 10);
    const before = url.searchParams.get('before');
    if (before) filter.before = parseInt(before, 10);

    sendJSON(res, 200, dashboard.onAuditQuery(filter));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    if (!dashboard.onConfig) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onConfig());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/reference') {
    if (!dashboard.onReferenceGuide) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onReferenceGuide());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/setup/status') {
    if (!dashboard.onSetupStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onSetupStatus());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/quick-actions') {
    if (!dashboard.onQuickActions) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onQuickActions());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/pending-action') {
    if (!dashboard.onPendingActionCurrent) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const userId = url.searchParams.get('userId') ?? 'web-user';
    const channel = url.searchParams.get('channel') ?? 'web';
    const surfaceId = url.searchParams.get('surfaceId') ?? 'web-guardian-chat';
    sendJSON(res, 200, dashboard.onPendingActionCurrent({ userId, channel, surfaceId }));
    return true;
  }


  if (req.method === 'POST' && url.pathname === '/api/config') {
    if (!dashboard.onConfigUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const parsedRecord = asRecord(parsed);
      const bodyTicket = trimOptionalString(parsedRecord?.ticket);
      if (parsedRecord && hasOwn(parsedRecord, 'ticket')) {
        delete parsedRecord.ticket;
      }
      const privilegedAction = context.getConfigPrivilegedAction(parsedRecord);
      if (privilegedAction && !context.requirePrivilegedTicket(req, res, url, privilegedAction, bodyTicket)) {
        return true;
      }
      try {
        const result = await dashboard.onConfigUpdate(parsed as Record<string, unknown>);
        sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
        context.maybeEmitUIInvalidation(result, ['config', 'providers', 'tools', 'automations', 'network'], 'config.updated', url.pathname);
      } catch (err) {
        context.logInternalError('Config update failed', err);
        sendJSON(res, 500, { error: 'Update failed' });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
    if (!dashboard.onTelegramReload) {
      sendJSON(res, 404, { error: 'Telegram reload not available' });
      return true;
    }
    try {
      const result = await dashboard.onTelegramReload();
      sendJSON(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Telegram test failed';
      sendJSON(res, 500, { success: false, message });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/test') {
    if (!dashboard.onCloudTest) {
      sendJSON(res, 404, { error: 'Cloud test not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ provider?: string; profileId?: string }>(req, context.maxBodyBytes);
      if (!parsed.provider || !parsed.profileId) {
        sendJSON(res, 400, { error: 'provider and profileId are required' });
        return true;
      }
      try {
        const result = await dashboard.onCloudTest(parsed.provider, parsed.profileId);
        sendJSON(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Cloud test failed';
        sendJSON(res, 500, { success: false, message });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/setup/apply') {
    if (!dashboard.onSetupApply) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Parameters<NonNullable<DashboardCallbacks['onSetupApply']>>[0]>(req, context.maxBodyBytes);
      const result = await dashboard.onSetupApply(parsed);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'providers'], 'setup.applied', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/config/search') {
    if (!dashboard.onSearchConfigUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Parameters<NonNullable<DashboardCallbacks['onSearchConfigUpdate']>>[0]>(req, context.maxBodyBytes);
      try {
        const result = await dashboard.onSearchConfigUpdate(parsed);
        sendJSON(res, 200, result);
        context.maybeEmitUIInvalidation(result, ['config'], 'search.config.updated', url.pathname);
      } catch (err) {
        context.logInternalError('Search config update failed', err);
        sendJSON(res, 500, { error: 'Update failed' });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/budget') {
    if (!dashboard.onBudget) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onBudget());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/analytics/summary') {
    if (!dashboard.onAnalyticsSummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const windowMs = parseInt(url.searchParams.get('windowMs') ?? '3600000', 10);
    sendJSON(res, 200, dashboard.onAnalyticsSummary(windowMs));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/summary') {
    if (!dashboard.onThreatIntelSummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onThreatIntelSummary());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/plan') {
    if (!dashboard.onThreatIntelPlan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onThreatIntelPlan());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/watchlist') {
    if (!dashboard.onThreatIntelWatchlist) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, { targets: dashboard.onThreatIntelWatchlist() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/watchlist') {
    if (!dashboard.onThreatIntelWatchAdd || !dashboard.onThreatIntelWatchRemove) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ action?: 'add' | 'remove'; target?: string }>(req, context.maxBodyBytes);
      if (!parsed.target?.trim()) {
        sendJSON(res, 400, { error: 'target is required' });
        return true;
      }
      const action = parsed.action ?? 'add';
      if (action !== 'add' && action !== 'remove') {
        sendJSON(res, 400, { error: "action must be 'add' or 'remove'" });
        return true;
      }
      const result = action === 'add'
        ? dashboard.onThreatIntelWatchAdd(parsed.target)
        : dashboard.onThreatIntelWatchRemove(parsed.target);
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.watchlist.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/scan') {
    if (!dashboard.onThreatIntelScan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ query?: string; includeDarkWeb?: boolean; sources?: string[] }>(req, context.maxBodyBytes);
      const result = await dashboard.onThreatIntelScan({
        query: parsed.query,
        includeDarkWeb: parsed.includeDarkWeb,
        sources: parsed.sources as Parameters<NonNullable<DashboardCallbacks['onThreatIntelScan']>>[0]['sources'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.scan.completed', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/findings') {
    if (!dashboard.onThreatIntelFindings) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const status = url.searchParams.get('status') ?? undefined;
    const findings = dashboard.onThreatIntelFindings({
      limit: Number.isFinite(limit) ? limit : 50,
      status: status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelFindings']>>[0]['status'],
    });
    sendJSON(res, 200, findings);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/findings/status') {
    if (!dashboard.onThreatIntelUpdateFindingStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ findingId?: string; status?: string }>(req, context.maxBodyBytes);
      if (!parsed.findingId || !parsed.status) {
        sendJSON(res, 400, { error: 'findingId and status are required' });
        return true;
      }
      const result = dashboard.onThreatIntelUpdateFindingStatus({
        findingId: parsed.findingId,
        status: parsed.status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelUpdateFindingStatus']>>[0]['status'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.finding.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/threat-intel/actions') {
    if (!dashboard.onThreatIntelActions) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    sendJSON(res, 200, dashboard.onThreatIntelActions(Number.isFinite(limit) ? limit : 50));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/actions/draft') {
    if (!dashboard.onThreatIntelDraftAction) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ findingId?: string; type?: string }>(req, context.maxBodyBytes);
      if (!parsed.findingId || !parsed.type) {
        sendJSON(res, 400, { error: 'findingId and type are required' });
        return true;
      }
      const result = dashboard.onThreatIntelDraftAction({
        findingId: parsed.findingId,
        type: parsed.type as Parameters<NonNullable<DashboardCallbacks['onThreatIntelDraftAction']>>[0]['type'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.action.drafted', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/threat-intel/response-mode') {
    if (!dashboard.onThreatIntelSetResponseMode) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ mode?: string }>(req, context.maxBodyBytes);
      if (!parsed.mode) {
        sendJSON(res, 400, { error: 'mode is required' });
        return true;
      }
      const result = dashboard.onThreatIntelSetResponseMode(
        parsed.mode as Parameters<NonNullable<DashboardCallbacks['onThreatIntelSetResponseMode']>>[0],
      );
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'threat-intel'], 'threat-intel.response-mode.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/watchdog') {
    if (!dashboard.onWatchdog) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onWatchdog());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers') {
    if (!dashboard.onProviders) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onProviders());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers/types') {
    if (!dashboard.onProviderTypes) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onProviderTypes());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers/status') {
    if (!dashboard.onProvidersStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, await dashboard.onProvidersStatus());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/providers/models') {
    if (!dashboard.onProviderModels) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<Record<string, unknown>>(req, context.maxBodyBytes);
      const providerType = typeof parsed.providerType === 'string' ? parsed.providerType.trim() : '';
      if (!providerType) {
        sendJSON(res, 400, { error: 'providerType is required' });
        return true;
      }
      try {
        const result = await dashboard.onProviderModels({
          providerType,
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
          credentialRef: typeof parsed.credentialRef === 'string' ? parsed.credentialRef : undefined,
          baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
        });
        sendJSON(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load provider models';
        sendJSON(res, 400, { error: message });
      }
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/providers/default') {
    if (!dashboard.onConfigUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ name?: string }>(req, context.maxBodyBytes);
      if (!parsed.name || typeof parsed.name !== 'string') {
        sendJSON(res, 400, { error: 'Missing provider name' });
        return true;
      }
      const result = await dashboard.onConfigUpdate({ defaultProvider: parsed.name });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['config', 'providers'], 'providers.default.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/assistant/state') {
    if (!dashboard.onAssistantState) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onAssistantState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/assistant/jobs/follow-up') {
    if (!dashboard.onAssistantJobFollowUpAction) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ jobId?: string; action?: 'replay' | 'keep_held' | 'dismiss' }>(req, context.maxBodyBytes);
      if (!parsed.jobId || typeof parsed.jobId !== 'string') {
        sendJSON(res, 400, { success: false, message: 'Missing jobId' });
        return true;
      }
      if (parsed.action !== 'replay' && parsed.action !== 'keep_held' && parsed.action !== 'dismiss') {
        sendJSON(res, 400, { success: false, message: 'Invalid follow-up action' });
        return true;
      }
      const result = await dashboard.onAssistantJobFollowUpAction({
        jobId: parsed.jobId,
        action: parsed.action,
      });
      sendJSON(res, result.success ? 200 : (result.statusCode ?? 400), result);
      context.maybeEmitUIInvalidation(result, ['assistant', 'dashboard'], 'assistant.jobs.followup', url.pathname);
      return true;
    } catch (err) {
      sendJSON(res, 400, { success: false, message: err instanceof Error ? err.message : 'Bad request' });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/assistant/runs') {
    if (!dashboard.onAssistantRuns) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const status = trimOptionalString(url.searchParams.get('status')) as import('../runtime/run-timeline.js').DashboardRunStatus | undefined;
    const kind = trimOptionalString(url.searchParams.get('kind')) as import('../runtime/run-timeline.js').DashboardRunKind | undefined;
    const channel = trimOptionalString(url.searchParams.get('channel'));
    const agentId = trimOptionalString(url.searchParams.get('agentId'));
    const codeSessionId = trimOptionalString(url.searchParams.get('codeSessionId'));
    const continuityKey = trimOptionalString(url.searchParams.get('continuityKey'));
    const activeExecutionRef = trimOptionalString(url.searchParams.get('activeExecutionRef'));
    sendJSON(res, 200, dashboard.onAssistantRuns({
      limit: Number.isFinite(limit) ? limit : 20,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(channel ? { channel } : {}),
      ...(agentId ? { agentId } : {}),
      ...(codeSessionId ? { codeSessionId } : {}),
      ...(continuityKey ? { continuityKey } : {}),
      ...(activeExecutionRef ? { activeExecutionRef } : {}),
    }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/routing/trace') {
    if (!dashboard.onIntentRoutingTrace) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const continuityKey = trimOptionalString(url.searchParams.get('continuityKey'));
    const activeExecutionRef = trimOptionalString(url.searchParams.get('activeExecutionRef'));
    const stage = trimOptionalString(url.searchParams.get('stage'));
    const channel = trimOptionalString(url.searchParams.get('channel'));
    const agentId = trimOptionalString(url.searchParams.get('agentId'));
    const userId = trimOptionalString(url.searchParams.get('userId'));
    const requestId = trimOptionalString(url.searchParams.get('requestId'));
    sendJSON(res, 200, await dashboard.onIntentRoutingTrace({
      limit: Number.isFinite(limit) ? limit : 20,
      ...(continuityKey ? { continuityKey } : {}),
      ...(activeExecutionRef ? { activeExecutionRef } : {}),
      ...(stage ? { stage } : {}),
      ...(channel ? { channel } : {}),
      ...(agentId ? { agentId } : {}),
      ...(userId ? { userId } : {}),
      ...(requestId ? { requestId } : {}),
    }));
    return true;
  }

  const assistantRunMatch = req.method === 'GET'
    ? url.pathname.match(/^\/api\/assistant\/runs\/([^/]+)$/)
    : null;
  if (assistantRunMatch) {
    if (!dashboard.onAssistantRunDetail) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const runId = decodeURIComponent(assistantRunMatch[1]);
    const result = dashboard.onAssistantRunDetail(runId);
    if (!result) {
      sendJSON(res, 404, { error: 'Run not found' });
      return true;
    }
    sendJSON(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/routing/mode') {
    if (!dashboard.onRoutingMode) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onRoutingMode());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/routing/mode') {
    if (!dashboard.onRoutingModeUpdate) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ mode?: string }>(req, context.maxBodyBytes);
      const valid = ['auto', 'local-only', 'external-only'];
      if (!parsed.mode || !valid.includes(parsed.mode)) {
        sendJSON(res, 400, { error: `mode must be one of: ${valid.join(', ')}` });
        return true;
      }
      const result = dashboard.onRoutingModeUpdate(parsed.mode as 'auto' | 'local-only' | 'external-only');
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['config', 'dashboard'], 'routing.mode.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  return false;
}
