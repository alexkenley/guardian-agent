/**
 * API client for the GuardianAgent web UI.
 *
 * Wraps fetch with Bearer token from sessionStorage.
 */

const TOKEN_KEY = 'guardianagent_token';
export const AUTH_FAILED_EVENT = 'guardianagent:auth-failed';
export const AUTH_RECOVERED_EVENT = 'guardianagent:auth-recovered';

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function hasToken() {
  return !!sessionStorage.getItem(TOKEN_KEY);
}

/** Whether we have an active HttpOnly session cookie (server-side token custody). */
let cookieSessionActive = false;

async function readErrorBody(res) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return res.json().catch(() => ({ error: res.statusText }));
  }
  const text = await res.text().catch(() => '');
  return { error: text || res.statusText };
}

function isAuthFailureResponse(status, body) {
  if (status === 401) return true;
  if (status !== 403) return false;
  const errorText = typeof body?.error === 'string' ? body.error.trim() : '';
  const errorCode = typeof body?.errorCode === 'string' ? body.errorCode.trim().toUpperCase() : '';
  if (errorCode === 'AUTH_FAILED' || errorCode === 'AUTH_REQUIRED' || errorCode === 'AUTH_INVALID_TOKEN') {
    return true;
  }
  return errorText === 'Invalid token'
    || errorText === 'Authentication required'
    || errorText.startsWith('Authentication required.');
}

function dispatchAuthFailed(detail = { code: 'AUTH_FAILED' }) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    if (typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(AUTH_FAILED_EVENT, { detail }));
    } else {
      window.dispatchEvent(new Event(AUTH_FAILED_EVENT));
    }
  }
}

function waitForAuthRecovery() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return Promise.reject(new Error('AUTH_FAILED'));
  }
  return new Promise((resolve) => {
    const onRecovered = () => resolve();
    window.addEventListener(AUTH_RECOVERED_EVENT, onRecovered, { once: true });
  });
}

async function request(path, options = {}) {
  const { retryOnAuth = true, _authRetryCount = 0, ...fetchOptions } = options || {};
  const token = getToken();
  const headers = { ...fetchOptions.headers };
  if (token && !cookieSessionActive) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (fetchOptions.body && typeof fetchOptions.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...fetchOptions, headers, credentials: 'same-origin' });

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (isAuthFailureResponse(res.status, body)) {
      cookieSessionActive = false;
      const detail = {
        status: res.status,
        code: typeof body.errorCode === 'string' && body.errorCode.trim()
          ? body.errorCode.trim()
          : 'AUTH_FAILED',
      };
      dispatchAuthFailed(detail);
      if (retryOnAuth && _authRetryCount < 1) {
        await waitForAuthRecovery();
        return request(path, {
          ...fetchOptions,
          retryOnAuth: false,
          _authRetryCount: _authRetryCount + 1,
        });
      }
      const error = new Error('AUTH_FAILED');
      error.status = res.status;
      if (typeof body.errorCode === 'string' && body.errorCode.trim()) {
        error.code = body.errorCode.trim();
      }
      throw error;
    }
    const error = new Error(body.error || `HTTP ${res.status}`);
    error.status = res.status;
    if (typeof body.errorCode === 'string' && body.errorCode.trim()) {
      error.code = body.errorCode.trim();
    }
    throw error;
  }

  return res.json();
}

async function requestPrivileged(path, action, payload = {}) {
  const issued = await request('/api/auth/ticket', {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
  if (!issued?.ticket) {
    throw new Error('Failed to obtain privileged ticket');
  }
  return request(path, {
    method: 'POST',
    body: JSON.stringify({ ...(payload || {}), ticket: issued.ticket }),
  });
}

/**
 * Exchange bearer token for an HttpOnly session cookie.
 * After success, clears the token from sessionStorage.
 */
async function createSession(token) {
  const res = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Failed to create session');
  cookieSessionActive = true;
  clearToken();
  return res.json();
}

/**
 * Destroy the HttpOnly session cookie.
 */
async function destroySession() {
  await fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' });
  cookieSessionActive = false;
}

export function hasCookieSession() {
  return cookieSessionActive;
}

function buildQueryString(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) qs.set(key, value.join(','));
      continue;
    }
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

export const api = {
  createSession,
  destroySession,
  status:       (options = {}) => request('/api/status', options),
  authStatus:   (options = {}) => request('/api/auth/status', options),
  updateAuth:   (input) => requestPrivileged('/api/auth/config', 'auth.config', input || {}),
  rotateAuthToken: () => requestPrivileged('/api/auth/token/rotate', 'auth.rotate', {}),
  revealAuthToken: () => requestPrivileged('/api/auth/token/reveal', 'auth.reveal', {}),
  agents:       () => request('/api/agents'),
  agentDetail:  (id) => request(`/api/agents/${encodeURIComponent(id)}`),
  audit:        (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return request(`/api/audit${q ? '?' + q : ''}`);
  },
  auditSummary: (windowMs = 300000) => request(`/api/audit/summary?windowMs=${windowMs}`),
  verifyAuditChain: () => request('/api/audit/verify'),
  config:       () => request('/api/config'),
  reference:    () => request('/api/reference'),
  memory:       (params = {}) => request(`/api/memory${buildQueryString(params)}`),
  memoryCurate: (input) => request('/api/memory/curate', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainOverview: () => request('/api/second-brain/overview'),
  secondBrainBriefs: (params = {}) => request(`/api/second-brain/briefs${buildQueryString(params)}`),
  secondBrainGenerateBrief: (input) => request('/api/second-brain/briefs/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainBriefUpdate: (input) => request('/api/second-brain/briefs/update', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainBriefDelete: (id) => request('/api/second-brain/briefs/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainCalendar: (params = {}) => request(`/api/second-brain/calendar${buildQueryString(params)}`),
  secondBrainCalendarUpsert: (input) => request('/api/second-brain/calendar/upsert', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainCalendarDelete: (id) => request('/api/second-brain/calendar/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainTasks: (params = {}) => request(`/api/second-brain/tasks${buildQueryString(params)}`),
  secondBrainTaskUpsert: (input) => request('/api/second-brain/tasks/upsert', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainTaskDelete: (id) => request('/api/second-brain/tasks/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainNotes: (params = {}) => request(`/api/second-brain/notes${buildQueryString(params)}`),
  secondBrainNoteUpsert: (input) => request('/api/second-brain/notes/upsert', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainNoteDelete: (id) => request('/api/second-brain/notes/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainPeople: (params = {}) => request(`/api/second-brain/people${buildQueryString(params)}`),
  secondBrainPersonUpsert: (input) => request('/api/second-brain/people/upsert', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainPersonDelete: (id) => request('/api/second-brain/people/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainLinks: (params = {}) => request(`/api/second-brain/links${buildQueryString(params)}`),
  secondBrainLinkUpsert: (input) => request('/api/second-brain/links/upsert', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainLinkDelete: (id) => request('/api/second-brain/links/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainRoutineCatalog: () => request('/api/second-brain/routines/catalog'),
  secondBrainRoutines: () => request('/api/second-brain/routines'),
  secondBrainSyncNow: () => request('/api/second-brain/sync', {
    method: 'POST',
  }),
  secondBrainRoutineCreate: (input) => request('/api/second-brain/routines/create', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainRoutineUpdate: (input) => request('/api/second-brain/routines/update', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  secondBrainRoutineDelete: (id) => request('/api/second-brain/routines/delete', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }),
  secondBrainUsage: () => request('/api/second-brain/usage'),
  performanceStatus: () => request('/api/performance/status'),
  performanceProcesses: () => request('/api/performance/processes'),
  performanceApplyProfile: (profileId) => requestPrivileged('/api/performance/profile/apply', 'performance.manage', { profileId }),
  performancePreviewAction: (actionId) => request('/api/performance/action/preview', {
    method: 'POST',
    body: JSON.stringify({ actionId }),
  }),
  performanceRunAction: (action) => requestPrivileged('/api/performance/action/run', 'performance.manage', action || {}),
  setupStatus:  () => request('/api/setup/status'),
  applySetup:   (input) => request('/api/setup/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  applyConfig:  (input) => request('/api/setup/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  saveSearchConfig: (input) => request('/api/config/search', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  browserConfig: () => request('/api/tools/browser'),
  saveBrowserConfig: (input) => request('/api/tools/browser', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  budget:       () => request('/api/budget'),
  watchdog:     () => request('/api/watchdog'),
  analyticsSummary: (windowMs = 3600000) => request(`/api/analytics/summary?windowMs=${windowMs}`),
  aiSecuritySummary: () => request('/api/security/ai/summary'),
  aiSecurityProfiles: () => request('/api/security/ai/profiles'),
  aiSecurityTargets: () => request('/api/security/ai/targets'),
  aiSecurityRuns: (limit = 20) => request(`/api/security/ai/runs?limit=${limit}`),
  aiSecurityScan: (payload = {}) => request('/api/security/ai/scan', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  aiSecurityFindings: (params = {}) => request(`/api/security/ai/findings${buildQueryString(params)}`),
  aiSecuritySetFindingStatus: (findingId, status) => request('/api/security/ai/findings/status', {
    method: 'POST',
    body: JSON.stringify({ findingId, status }),
  }),
  threatIntelSummary: () => request('/api/threat-intel/summary'),
  threatIntelPlan: () => request('/api/threat-intel/plan'),
  threatIntelWatchlist: () => request('/api/threat-intel/watchlist'),
  threatIntelWatch: (target, action = 'add') => request('/api/threat-intel/watchlist', {
    method: 'POST',
    body: JSON.stringify({ target, action }),
  }),
  threatIntelScan: (payload = {}) => request('/api/threat-intel/scan', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  threatIntelFindings: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return request(`/api/threat-intel/findings${q ? '?' + q : ''}`);
  },
  threatIntelSetFindingStatus: (findingId, status) => request('/api/threat-intel/findings/status', {
    method: 'POST',
    body: JSON.stringify({ findingId, status }),
  }),
  threatIntelActions: (limit = 50) => request(`/api/threat-intel/actions?limit=${limit}`),
  threatIntelDraftAction: (findingId, type) => request('/api/threat-intel/actions/draft', {
    method: 'POST',
    body: JSON.stringify({ findingId, type }),
  }),
  threatIntelSetResponseMode: (mode) => request('/api/threat-intel/response-mode', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  }),
  telegramTest: () => request('/api/telegram/test', { method: 'POST' }),
  cloudTest: (provider, profileId) => request('/api/cloud/test', {
    method: 'POST',
    body: JSON.stringify({ provider, profileId }),
  }),
  providers:    () => request('/api/providers'),
  providerTypes: () => request('/api/providers/types'),
  providersStatus: () => request('/api/providers/status'),
  providerModels: (payload) => request('/api/providers/models', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  assistantState: () => request('/api/assistant/state'),
  assistantJobFollowUp: (payload) => request('/api/assistant/jobs/follow-up', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  assistantRuns: (params = {}) => request(`/api/assistant/runs${buildQueryString(params)}`),
  assistantRun: (runId) => request(`/api/assistant/runs/${encodeURIComponent(runId)}`),
  toolsState: (limit = 50) => request(`/api/tools?limit=${limit}`),
  runTool: (payload) => request('/api/tools/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateToolPolicy: (payload) => requestPrivileged('/api/tools/policy', 'tools.policy', payload || {}),
  preflightTools: (payload) => request('/api/tools/preflight', {
    method: 'POST',
    body: JSON.stringify(Array.isArray(payload) ? { tools: payload } : payload),
  }),
  pendingToolApprovals: (userId = 'web-user', channel = 'web', limit = 20) => {
    const qs = new URLSearchParams({ userId, channel, limit: String(limit) });
    return request(`/api/tools/approvals/pending?${qs.toString()}`);
  },
  decideToolApproval: (payload) => request('/api/tools/approvals/decision', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  toolCategories: () => request('/api/tools/categories'),
  toggleToolCategory: (payload) => request('/api/tools/categories', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateToolProviderRouting: (payload) => request('/api/tools/provider-routing', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  connectorsState: (limitRuns = 50) => request(`/api/connectors/state?limitRuns=${limitRuns}`),
  updateConnectorsSettings: (payload) => requestPrivileged('/api/connectors/settings', 'connectors.config', payload || {}),
  upsertConnectorPack: (pack) => requestPrivileged('/api/connectors/packs/upsert', 'connectors.pack', pack || {}),
  deleteConnectorPack: (packId) => requestPrivileged('/api/connectors/packs/delete', 'connectors.pack', { packId }),
  networkDevices: () => request('/api/network/devices'),
  networkBaseline: () => request('/api/network/baseline'),
  networkThreats: (params = {}) => {
    return request(`/api/network/threats${buildQueryString(params)}`);
  },
  acknowledgeNetworkThreat: (alertId) => request('/api/network/threats/ack', {
    method: 'POST',
    body: JSON.stringify({ alertId }),
  }),
  securityAlerts: (params = {}) => request(`/api/security/alerts${buildQueryString(params)}`),
  acknowledgeSecurityAlert: (alertId, source) => request('/api/security/alerts/ack', {
    method: 'POST',
    body: JSON.stringify({ alertId, source }),
  }),
  resolveSecurityAlert: (alertId, source, reason) => request('/api/security/alerts/resolve', {
    method: 'POST',
    body: JSON.stringify({ alertId, source, reason }),
  }),
  suppressSecurityAlert: (alertId, source, suppressedUntil, reason) => request('/api/security/alerts/suppress', {
    method: 'POST',
    body: JSON.stringify({ alertId, source, suppressedUntil, reason }),
  }),
  securityActivity: (params = {}) => request(`/api/security/activity${buildQueryString(params)}`),
  securityPosture: (params = {}) => request(`/api/security/posture${buildQueryString(params)}`),
  securityContainment: (params = {}) => request(`/api/security/containment${buildQueryString(params)}`),
  windowsDefenderStatus: () => request('/api/windows-defender/status'),
  windowsDefenderRefresh: () => request('/api/windows-defender/refresh', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  windowsDefenderScan: (type, path) => request('/api/windows-defender/scan', {
    method: 'POST',
    body: JSON.stringify({ type, path }),
  }),
  windowsDefenderUpdateSignatures: () => request('/api/windows-defender/signatures/update', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  hostMonitorStatus: () => request('/api/host-monitor/status'),
  hostMonitorAlerts: (params = {}) => {
    return request(`/api/host-monitor/alerts${buildQueryString(params)}`);
  },
  acknowledgeHostMonitorAlert: (alertId) => request('/api/host-monitor/alerts/ack', {
    method: 'POST',
    body: JSON.stringify({ alertId }),
  }),
  runHostMonitorCheck: () => request('/api/host-monitor/check', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  gatewayMonitorStatus: () => request('/api/gateway-monitor/status'),
  gatewayMonitorAlerts: (params = {}) => {
    return request(`/api/gateway-monitor/alerts${buildQueryString(params)}`);
  },
  acknowledgeGatewayMonitorAlert: (alertId) => request('/api/gateway-monitor/alerts/ack', {
    method: 'POST',
    body: JSON.stringify({ alertId }),
  }),
  runGatewayMonitorCheck: () => request('/api/gateway-monitor/check', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  networkScan: () => request('/api/network/scan', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  quickActions: () => request('/api/quick-actions'),
  runQuickAction: (payload) => request('/api/quick-actions/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateConfig: (updates) => request('/api/config', {
    method: 'POST',
    body: JSON.stringify(updates),
  }),
  sendMessage:  (content, agentId, userId, channel = 'web', metadata, surfaceId, requestId) => {
    const payload = { content, userId, channel };
    if (agentId) payload.agentId = agentId;
    if (requestId) payload.requestId = requestId;
    if (metadata && typeof metadata === 'object') payload.metadata = metadata;
    if (surfaceId) payload.surfaceId = surfaceId;
    return request('/api/message', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  sendMessageStream: (content, agentId, userId, channel = 'web', metadata, requestId, surfaceId) => {
    const payload = { content, userId, channel };
    if (agentId) payload.agentId = agentId;
    if (requestId) payload.requestId = requestId;
    if (metadata && typeof metadata === 'object') payload.metadata = metadata;
    if (surfaceId) payload.surfaceId = surfaceId;
    return request('/api/message/stream', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  cancelMessage: (requestId, userId = 'web-user', channel = 'web', agentId, reason) => {
    const payload = { requestId, userId, channel };
    if (agentId) payload.agentId = agentId;
    if (reason) payload.reason = reason;
    return request('/api/message/cancel', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  currentPendingAction: (userId = 'web-user', channel = 'web', surfaceId = 'web-guardian-chat') => {
    const qs = new URLSearchParams({ userId, channel, surfaceId });
    return request(`/api/chat/pending-action?${qs.toString()}`);
  },
  routingTrace: (params = {}) => request(`/api/routing/trace${buildQueryString(params)}`),
  routingMode: () => request('/api/routing/mode'),
  setRoutingMode: (mode) => request('/api/routing/mode', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  }),
  resetConversation: (agentId, userId = 'web-user', channel = 'web') => request('/api/conversations/reset', {
    method: 'POST',
    body: JSON.stringify({ agentId, userId, channel }),
  }),
  conversationSessions: (agentId, userId = 'web-user', channel = 'web') => {
    const qs = new URLSearchParams({ userId, channel });
    if (agentId) qs.set('agentId', agentId);
    return request(`/api/conversations/sessions?${qs.toString()}`);
  },
  useConversationSession: (agentId, sessionId, userId = 'web-user', channel = 'web') => request('/api/conversations/session', {
    method: 'POST',
    body: JSON.stringify({ agentId, sessionId, userId, channel }),
  }),
  killswitch: () => request('/api/killswitch', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  factoryReset: (scope) => requestPrivileged('/api/factory-reset', 'factory-reset', { scope }),
  automationsCatalog: () => request('/api/automations/catalog'),
  automationRunHistory: () => request('/api/automations/history'),
  saveAutomation: (payload) => request('/api/automations/save', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }),
  saveAutomationDefinition: (id, payload) => request(`/api/automations/${encodeURIComponent(id)}/definition`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }),
  createAutomation: (id) => request(`/api/automations/${encodeURIComponent(id)}/create`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  setAutomationEnabled: (id, enabled) => request(`/api/automations/${encodeURIComponent(id)}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }),
  runAutomation: (id, payload = {}) => request(`/api/automations/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }),
  deleteAutomation: (id) => request(`/api/automations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  scheduledTasks: () => request('/api/scheduled-tasks'),
  scheduledTask: (id) => request(`/api/scheduled-tasks/${encodeURIComponent(id)}`),
  createScheduledTask: (data) => request('/api/scheduled-tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  updateScheduledTask: (id, data) => request(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  deleteScheduledTask: (id) => request(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  runScheduledTaskNow: (id) => request(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  scheduledTaskHistory: () => request('/api/scheduled-tasks/history'),

  // Document Search
  searchStatus: () => request('/api/search/status'),
  searchSources: () => request('/api/search/sources'),
  searchSourceAdd: (source) => request('/api/search/sources', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(source),
  }),
  searchSourceRemove: (id) => request(`/api/search/sources/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  searchSourceToggle: (id, enabled) => request(`/api/search/sources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ enabled }),
  }),
  pickSearchPath: (kind = 'directory') => requestPrivileged('/api/search/pick-path', 'search.pick-path', { kind }),
  searchReindex: (collection) => request('/api/search/reindex', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(collection ? { collection } : {}),
  }),

  gwsStatus: () => request('/api/gws/status'),
  gwsReauth: () => request('/api/gws/reauth', { method: 'POST' }),

  // Native Google integration
  googleStatus: () => request('/api/google/status'),
  googleAuthStart: (services) => request('/api/google/auth/start', {
    method: 'POST',
    body: JSON.stringify({ services }),
  }),
  googleAuthCancel: () => request('/api/google/auth/cancel', { method: 'POST' }),
  googleCredentials: (credentials) => request('/api/google/credentials', {
    method: 'POST',
    body: JSON.stringify({ credentials }),
  }),
  googleDisconnect: () => request('/api/google/disconnect', { method: 'POST' }),

  // Native Microsoft 365 integration
  microsoftStatus: () => request('/api/microsoft/status'),
  microsoftAuthStart: (services) => request('/api/microsoft/auth/start', {
    method: 'POST',
    body: JSON.stringify({ services }),
  }),
  microsoftAuthCancel: () => request('/api/microsoft/auth/cancel', { method: 'POST' }),
  microsoftConfig: (clientId, tenantId) => request('/api/microsoft/config', {
    method: 'POST',
    body: JSON.stringify({ clientId, tenantId }),
  }),
  microsoftDisconnect: () => request('/api/microsoft/disconnect', { method: 'POST' }),

  // Policy-as-Code Engine
  policyStatus: () => request('/api/policy/status'),
  updatePolicy: (payload) => requestPrivileged('/api/policy/config', 'policy.config', payload || {}),
  reloadPolicy: () => requestPrivileged('/api/policy/reload', 'policy.config', {}),

  // User shell (unrestricted, auth-gated)
  shellExec: (payload) => request('/api/shell/exec', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeTerminalOpen: (payload) => request('/api/code/terminals', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeTerminalInput: (terminalId, payload) => request(`/api/code/terminals/${encodeURIComponent(terminalId)}/input`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeTerminalResize: (terminalId, payload) => request(`/api/code/terminals/${encodeURIComponent(terminalId)}/resize`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeTerminalClose: (terminalId) => request(`/api/code/terminals/${encodeURIComponent(terminalId)}`, {
    method: 'DELETE',
  }),
  codeSessions: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    return request(`/api/code/sessions${qs.toString() ? `?${qs.toString()}` : ''}`);
  },
  codeSessionGet: (sessionId, params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    return request(`/api/code/sessions/${encodeURIComponent(sessionId)}${qs.toString() ? `?${qs.toString()}` : ''}`);
  },
  codeSessionTimeline: (sessionId, params = {}) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/timeline${buildQueryString(params)}`),
  codeSessionCreate: (payload) => request('/api/code/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionUpdate: (sessionId, payload) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  }),
  codeSessionDelete: (sessionId, payload = {}) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  }),
  codeSessionAttach: (sessionId, payload = {}) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/attach`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionDetach: (payload = {}) => request('/api/code/sessions/detach', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionSetReferences: (payload = {}) => request('/api/code/sessions/references', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionSetTarget: (payload = {}) => request('/api/code/sessions/target', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionDecideApproval: (sessionId, approvalId, payload) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionResetConversation: (sessionId, payload = {}) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/reset`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeSessionStructure: (sessionId, params = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    });
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request(`/api/code/sessions/${encodeURIComponent(sessionId)}/structure${suffix}`);
  },
  codeSessionStructurePreview: (sessionId, payload) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/structure-preview`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeFsList: (payload) => request('/api/code/fs/list', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeFsRead: (payload) => request('/api/code/fs/read', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeFsWrite: (payload) => request('/api/code/fs/write', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeGitDiff: (payload) => request('/api/code/git/diff', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeGitStatus: (sessionId, params = {}) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/git/status${buildQueryString(params)}`),
  codeGitAction: (sessionId, payload) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/git/action`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeGitGraph: (sessionId, params = {}) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/git/graph${buildQueryString(params)}`),

  // Guardian Agent + Sentinel Audit
  guardianAgentStatus: () => request('/api/guardian-agent/status'),
  updateGuardianAgent: (payload) => requestPrivileged('/api/guardian-agent/config', 'guardian.config', payload || {}),
  runSentinelAudit: (windowMs) => request('/api/sentinel/audit', {
    method: 'POST',
    body: JSON.stringify(windowMs ? { windowMs } : {}),
  }),
};
