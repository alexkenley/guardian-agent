/**
 * API client for GuardianAgent dashboard.
 *
 * Wraps fetch with Bearer token from sessionStorage.
 */

const TOKEN_KEY = 'guardianagent_token';

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

async function request(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token && !cookieSessionActive) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });

  if (res.status === 401 || res.status === 403) {
    throw new Error('AUTH_FAILED');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
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
  status:       () => request('/api/status'),
  authStatus:   () => request('/api/auth/status'),
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
  setDefaultProvider: (name) => request('/api/providers/default', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),
  assistantState: () => request('/api/assistant/state'),
  toolsState: (limit = 50) => request(`/api/tools?limit=${limit}`),
  runTool: (payload) => request('/api/tools/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateToolPolicy: (payload) => request('/api/tools/policy', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
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
  upsertPlaybook: (playbook) => requestPrivileged('/api/connectors/playbooks/upsert', 'connectors.playbook', playbook || {}),
  deletePlaybook: (playbookId) => requestPrivileged('/api/connectors/playbooks/delete', 'connectors.playbook', { playbookId }),
  runPlaybook: (payload) => request('/api/connectors/playbooks/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  connectorsTemplates: () => request('/api/connectors/templates'),
  installTemplate: (templateId) => request('/api/connectors/templates/install', {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  }),
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
  sendMessage:  (content, agentId, userId, channel = 'web', metadata) => {
    const payload = { content, userId, channel };
    if (agentId) payload.agentId = agentId;
    if (metadata && typeof metadata === 'object') payload.metadata = metadata;
    return request('/api/message', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  sendMessageStream: (content, agentId, userId, channel = 'web', metadata) => {
    const payload = { content, agentId, userId, channel };
    if (metadata && typeof metadata === 'object') payload.metadata = metadata;
    return request('/api/message/stream', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
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
  scheduledTaskPresets: () => request('/api/scheduled-tasks/presets'),
  installScheduledTaskPreset: (presetId) => request('/api/scheduled-tasks/presets/install', {
    method: 'POST',
    body: JSON.stringify({ presetId }),
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
  microsoftConfig: (clientId, tenantId) => request('/api/microsoft/config', {
    method: 'POST',
    body: JSON.stringify({ clientId, tenantId }),
  }),
  microsoftDisconnect: () => request('/api/microsoft/disconnect', { method: 'POST' }),

  // Policy-as-Code Engine
  policyStatus: () => request('/api/policy/status'),
  updatePolicy: (payload) => request('/api/policy/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  reloadPolicy: () => request('/api/policy/reload', {
    method: 'POST',
    body: '{}',
  }),

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
  codeSessionSendMessage: (sessionId, payload) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/message`, {
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
  codeGitStatus: (sessionId) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/git/status`),
  codeGitAction: (sessionId, payload) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/git/action`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  codeGitGraph: (sessionId) => request(`/api/code/sessions/${encodeURIComponent(sessionId)}/git/graph`),

  // Guardian Agent + Sentinel Audit
  guardianAgentStatus: () => request('/api/guardian-agent/status'),
  updateGuardianAgent: (payload) => request('/api/guardian-agent/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  runSentinelAudit: (windowMs) => request('/api/sentinel/audit', {
    method: 'POST',
    body: JSON.stringify(windowMs ? { windowMs } : {}),
  }),
};
