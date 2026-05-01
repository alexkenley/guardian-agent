import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, readOptionalJsonBody, sendJSON } from './web-json.js';
import type { DashboardCallbacks } from './web-types.js';
import {
  isSecurityAlertSeverity,
  isSecurityAlertSource,
  normalizeSecurityAlertSources,
  type SecurityAlertSource,
} from '../runtime/security-alerts.js';
import { isSecurityAlertStatus } from '../runtime/security-alert-lifecycle.js';
import { isSecurityActivityStatus } from '../runtime/security-activity-log.js';
import { isDeploymentProfile, isSecurityOperatingMode } from '../runtime/security-posture.js';
import { redactWebResponse } from './web-redaction.js';

interface WebMonitoringRoutesContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  maxBodyBytes: number;
  dashboard: DashboardCallbacks;
  maybeEmitUIInvalidation: (result: unknown, topics: string[], reason: string, path: string) => void;
  emitUIInvalidation: (topics: string[], reason: string, path: string) => void;
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function securityInvalidationTopics(source?: string): string[] {
  return source === 'network' ? ['network', 'security'] : ['security'];
}

function sendBadRequestError(res: ServerResponse, err: unknown): void {
  sendJSON(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
}

export async function handleWebMonitoringRoutes(context: WebMonitoringRoutesContext): Promise<boolean> {
  const { req, res, url, dashboard } = context;

  if (req.method === 'GET' && url.pathname === '/api/network/devices') {
    if (!dashboard.onNetworkDevices) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onNetworkDevices());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/network/baseline') {
    if (!dashboard.onNetworkBaseline) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, dashboard.onNetworkBaseline());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/network/threats') {
    if (!dashboard.onNetworkThreats) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    sendJSON(res, 200, redactWebResponse(dashboard.onNetworkThreats({
      includeAcknowledged,
      limit: Number.isFinite(limit) ? limit : 100,
    })));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/network/threats/ack') {
    if (!dashboard.onNetworkThreatAcknowledge) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ alertId?: string }>(req, context.maxBodyBytes);
      if (!parsed.alertId?.trim()) {
        sendJSON(res, 400, { error: 'alertId is required' });
        return true;
      }
      const result = dashboard.onNetworkThreatAcknowledge(parsed.alertId.trim());
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['network', 'security'], 'network.threat.acknowledged', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/security/alerts') {
    if (!dashboard.onSecurityAlerts) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
    const includeInactive = (url.searchParams.get('includeInactive') ?? 'false').toLowerCase() === 'true';
    const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
    const query = trimOptionalString(url.searchParams.get('query'));
    const type = trimOptionalString(url.searchParams.get('type'));
    const rawStatus = trimOptionalString(url.searchParams.get('status'))?.toLowerCase();
    const rawSource = trimOptionalString(url.searchParams.get('source'));
    const rawSources = (trimOptionalString(url.searchParams.get('sources')) ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const rawSeverity = trimOptionalString(url.searchParams.get('severity'))?.toLowerCase();

    if (rawSource && !isSecurityAlertSource(rawSource.toLowerCase())) {
      sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
      return true;
    }
    if (rawSources.some((value) => !isSecurityAlertSource(value))) {
      sendJSON(res, 400, { error: "sources must contain only 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
      return true;
    }
    if (rawSeverity && !isSecurityAlertSeverity(rawSeverity)) {
      sendJSON(res, 400, { error: "severity must be one of 'low', 'medium', 'high', or 'critical'" });
      return true;
    }
    if (rawStatus && !isSecurityAlertStatus(rawStatus)) {
      sendJSON(res, 400, { error: "status must be one of 'active', 'acknowledged', 'resolved', or 'suppressed'" });
      return true;
    }

    const sources = normalizeSecurityAlertSources(rawSource, rawSources);
    sendJSON(res, 200, redactWebResponse(dashboard.onSecurityAlerts({
      query,
      source: rawSource?.toLowerCase() as SecurityAlertSource | undefined,
      sources,
      severity: rawSeverity as 'low' | 'medium' | 'high' | 'critical' | undefined,
      status: rawStatus as 'active' | 'acknowledged' | 'resolved' | 'suppressed' | undefined,
      type,
      includeAcknowledged,
      includeInactive,
      limit,
    })));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/security/alerts/ack') {
    if (!dashboard.onSecurityAlertAcknowledge) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ alertId?: string; source?: string }>(req, context.maxBodyBytes);
      if (!parsed.alertId?.trim()) {
        sendJSON(res, 400, { error: 'alertId is required' });
        return true;
      }
      const source = trimOptionalString(parsed.source)?.toLowerCase();
      if (source && !isSecurityAlertSource(source)) {
        sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
        return true;
      }
      const result = dashboard.onSecurityAlertAcknowledge({
        alertId: parsed.alertId.trim(),
        source: source as SecurityAlertSource | undefined,
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, securityInvalidationTopics(result.source), 'security.alert.acknowledged', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/security/alerts/resolve') {
    if (!dashboard.onSecurityAlertResolve) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ alertId?: string; source?: string; reason?: string }>(req, context.maxBodyBytes);
      if (!parsed.alertId?.trim()) {
        sendJSON(res, 400, { error: 'alertId is required' });
        return true;
      }
      const source = trimOptionalString(parsed.source)?.toLowerCase();
      if (source && !isSecurityAlertSource(source)) {
        sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
        return true;
      }
      const result = dashboard.onSecurityAlertResolve({
        alertId: parsed.alertId.trim(),
        source: source as SecurityAlertSource | undefined,
        reason: trimOptionalString(parsed.reason),
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, securityInvalidationTopics(result.source), 'security.alert.resolved', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/security/alerts/suppress') {
    if (!dashboard.onSecurityAlertSuppress) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ alertId?: string; source?: string; reason?: string; suppressedUntil?: number }>(req, context.maxBodyBytes);
      if (!parsed.alertId?.trim()) {
        sendJSON(res, 400, { error: 'alertId is required' });
        return true;
      }
      if (!Number.isFinite(parsed.suppressedUntil)) {
        sendJSON(res, 400, { error: 'suppressedUntil is required and must be a number' });
        return true;
      }
      const source = trimOptionalString(parsed.source)?.toLowerCase();
      if (source && !isSecurityAlertSource(source)) {
        sendJSON(res, 400, { error: "source must be one of 'host', 'network', 'gateway', 'native', 'assistant', or 'install'" });
        return true;
      }
      const result = dashboard.onSecurityAlertSuppress({
        alertId: parsed.alertId.trim(),
        source: source as SecurityAlertSource | undefined,
        reason: trimOptionalString(parsed.reason),
        suppressedUntil: Number(parsed.suppressedUntil),
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, securityInvalidationTopics(result.source), 'security.alert.suppressed', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/security/activity') {
    if (!dashboard.onSecurityActivityLog) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const rawLimit = Number(url.searchParams.get('limit') ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 200;
    const rawStatus = trimOptionalString(url.searchParams.get('status'))?.toLowerCase();
    const agentId = trimOptionalString(url.searchParams.get('agentId'));
    const groupLowConfidence = url.searchParams.get('groupLowConfidence') === '1' || url.searchParams.get('groupLowConfidence') === 'true';
    if (rawStatus && !isSecurityActivityStatus(rawStatus)) {
      sendJSON(res, 400, { error: "status must be one of 'started', 'skipped', 'completed', or 'failed'" });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onSecurityActivityLog({
      limit,
      status: rawStatus && isSecurityActivityStatus(rawStatus) ? rawStatus : undefined,
      agentId,
      groupLowConfidence,
    })));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/security/ai/summary') {
    if (!dashboard.onAiSecuritySummary) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onAiSecuritySummary()));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/security/ai/profiles') {
    if (!dashboard.onAiSecurityProfiles) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onAiSecurityProfiles()));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/security/ai/targets') {
    if (!dashboard.onAiSecurityTargets) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onAiSecurityTargets()));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/security/ai/runs') {
    if (!dashboard.onAiSecurityRuns) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;
    sendJSON(res, 200, redactWebResponse(dashboard.onAiSecurityRuns(limit)));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/security/ai/scan') {
    if (!dashboard.onAiSecurityScan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readOptionalJsonBody<{ profileId?: string; targetIds?: string[]; source?: string }>(req, context.maxBodyBytes, {});
      const result = await dashboard.onAiSecurityScan({
        profileId: trimOptionalString(parsed.profileId),
        targetIds: Array.isArray(parsed.targetIds)
          ? parsed.targetIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
          : undefined,
        source: parsed.source as Parameters<NonNullable<DashboardCallbacks['onAiSecurityScan']>>[0]['source'],
      });
      sendJSON(res, 200, redactWebResponse(result));
      context.maybeEmitUIInvalidation(result, ['security', 'ai-security'], 'security.ai.scan.completed', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/security/ai/findings') {
    if (!dashboard.onAiSecurityFindings) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
    const status = trimOptionalString(url.searchParams.get('status'))?.toLowerCase();
    sendJSON(res, 200, redactWebResponse(dashboard.onAiSecurityFindings({
      limit,
      status: status as Parameters<NonNullable<DashboardCallbacks['onAiSecurityFindings']>>[0]['status'],
    })));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/security/ai/findings/status') {
    if (!dashboard.onAiSecurityUpdateFindingStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ findingId?: string; status?: string }>(req, context.maxBodyBytes);
      if (!parsed.findingId?.trim() || !parsed.status?.trim()) {
        sendJSON(res, 400, { error: 'findingId and status are required' });
        return true;
      }
      const result = dashboard.onAiSecurityUpdateFindingStatus({
        findingId: parsed.findingId.trim(),
        status: parsed.status.trim().toLowerCase() as Parameters<NonNullable<DashboardCallbacks['onAiSecurityUpdateFindingStatus']>>[0]['status'],
      });
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security', 'ai-security'], 'security.ai.finding.updated', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/security/posture') {
    if (!dashboard.onSecurityPosture) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const rawProfile = trimOptionalString(url.searchParams.get('profile'))?.toLowerCase();
    const rawCurrentMode = trimOptionalString(url.searchParams.get('currentMode'))?.toLowerCase();
    const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
    if (rawProfile && !isDeploymentProfile(rawProfile)) {
      sendJSON(res, 400, { error: "profile must be one of 'personal', 'home', or 'organization'" });
      return true;
    }
    if (rawCurrentMode && !isSecurityOperatingMode(rawCurrentMode)) {
      sendJSON(res, 400, { error: "currentMode must be one of 'monitor', 'guarded', 'lockdown', or 'ir_assist'" });
      return true;
    }
    const profile = rawProfile && isDeploymentProfile(rawProfile) ? rawProfile : undefined;
    const currentMode = rawCurrentMode && isSecurityOperatingMode(rawCurrentMode) ? rawCurrentMode : undefined;
    sendJSON(res, 200, redactWebResponse(dashboard.onSecurityPosture({
      profile,
      currentMode,
      includeAcknowledged,
    })));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/security/containment') {
    if (!dashboard.onSecurityContainmentStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const rawProfile = trimOptionalString(url.searchParams.get('profile'))?.toLowerCase();
    const rawCurrentMode = trimOptionalString(url.searchParams.get('currentMode'))?.toLowerCase();
    if (rawProfile && !isDeploymentProfile(rawProfile)) {
      sendJSON(res, 400, { error: "profile must be one of 'personal', 'home', or 'organization'" });
      return true;
    }
    if (rawCurrentMode && !isSecurityOperatingMode(rawCurrentMode)) {
      sendJSON(res, 400, { error: "currentMode must be one of 'monitor', 'guarded', 'lockdown', or 'ir_assist'" });
      return true;
    }
    const profile = rawProfile && isDeploymentProfile(rawProfile) ? rawProfile : undefined;
    const currentMode = rawCurrentMode && isSecurityOperatingMode(rawCurrentMode) ? rawCurrentMode : undefined;
    sendJSON(res, 200, redactWebResponse(dashboard.onSecurityContainmentStatus({
      profile,
      currentMode,
    })));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/windows-defender/status') {
    if (!dashboard.onWindowsDefenderStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onWindowsDefenderStatus()));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/windows-defender/refresh') {
    if (!dashboard.onWindowsDefenderRefresh) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const result = await dashboard.onWindowsDefenderRefresh();
    sendJSON(res, 200, redactWebResponse(result));
    context.maybeEmitUIInvalidation(result, ['security'], 'windows-defender.refreshed', url.pathname);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/windows-defender/scan') {
    if (!dashboard.onWindowsDefenderScan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ type?: string; path?: string }>(req, context.maxBodyBytes);
      const type = trimOptionalString(parsed.type)?.toLowerCase();
      if (type !== 'quick' && type !== 'full' && type !== 'custom') {
        sendJSON(res, 400, { error: "type must be one of 'quick', 'full', or 'custom'" });
        return true;
      }
      const path = trimOptionalString(parsed.path);
      if (type === 'custom' && !path) {
        sendJSON(res, 400, { error: 'path is required when type is custom' });
        return true;
      }
      const result = await dashboard.onWindowsDefenderScan({ type, path });
      sendJSON(res, 200, redactWebResponse(result));
      context.maybeEmitUIInvalidation(result, ['security'], 'windows-defender.scan.requested', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/windows-defender/signatures/update') {
    if (!dashboard.onWindowsDefenderUpdateSignatures) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const result = await dashboard.onWindowsDefenderUpdateSignatures();
    sendJSON(res, 200, redactWebResponse(result));
    context.maybeEmitUIInvalidation(result, ['security'], 'windows-defender.signatures.updated', url.pathname);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/network/scan') {
    if (!dashboard.onNetworkScan) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const result = await dashboard.onNetworkScan();
    sendJSON(res, 200, redactWebResponse(result));
    context.maybeEmitUIInvalidation(result, ['network', 'automations', 'security'], 'network.scan.completed', url.pathname);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/host-monitor/status') {
    if (!dashboard.onHostMonitorStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onHostMonitorStatus()));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/host-monitor/alerts') {
    if (!dashboard.onHostMonitorAlerts) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    sendJSON(res, 200, redactWebResponse(dashboard.onHostMonitorAlerts({
      includeAcknowledged,
      limit: Number.isFinite(limit) ? limit : 100,
    })));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/host-monitor/alerts/ack') {
    if (!dashboard.onHostMonitorAcknowledge) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ alertId?: string }>(req, context.maxBodyBytes);
      if (!parsed.alertId?.trim()) {
        sendJSON(res, 400, { error: 'alertId is required' });
        return true;
      }
      const result = dashboard.onHostMonitorAcknowledge(parsed.alertId.trim());
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security'], 'host-monitor.alert.acknowledged', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/host-monitor/check') {
    if (!dashboard.onHostMonitorCheck) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const result = await dashboard.onHostMonitorCheck();
    sendJSON(res, 200, redactWebResponse(result));
    context.emitUIInvalidation(['security'], 'host-monitor.check.completed', url.pathname);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/gateway-monitor/status') {
    if (!dashboard.onGatewayMonitorStatus) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    sendJSON(res, 200, redactWebResponse(dashboard.onGatewayMonitorStatus()));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/gateway-monitor/alerts') {
    if (!dashboard.onGatewayMonitorAlerts) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const includeAcknowledged = (url.searchParams.get('includeAcknowledged') ?? 'false').toLowerCase() === 'true';
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    sendJSON(res, 200, redactWebResponse(dashboard.onGatewayMonitorAlerts({
      includeAcknowledged,
      limit: Number.isFinite(limit) ? limit : 100,
    })));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/gateway-monitor/alerts/ack') {
    if (!dashboard.onGatewayMonitorAcknowledge) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    try {
      const parsed = await readJsonBody<{ alertId?: string }>(req, context.maxBodyBytes);
      if (!parsed.alertId?.trim()) {
        sendJSON(res, 400, { error: 'alertId is required' });
        return true;
      }
      const result = dashboard.onGatewayMonitorAcknowledge(parsed.alertId.trim());
      sendJSON(res, 200, result);
      context.maybeEmitUIInvalidation(result, ['security'], 'gateway-monitor.alert.acknowledged', url.pathname);
      return true;
    } catch (err) {
      sendBadRequestError(res, err);
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/gateway-monitor/check') {
    if (!dashboard.onGatewayMonitorCheck) {
      sendJSON(res, 404, { error: 'Not available' });
      return true;
    }
    const result = await dashboard.onGatewayMonitorCheck();
    sendJSON(res, 200, redactWebResponse(result));
    context.emitUIInvalidation(['security'], 'gateway-monitor.check.completed', url.pathname);
    return true;
  }

  return false;
}
