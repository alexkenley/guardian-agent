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

async function request(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401 || res.status === 403) {
    throw new Error('AUTH_FAILED');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
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

export const api = {
  status:       () => request('/api/status'),
  authStatus:   () => request('/api/auth/status'),
  updateAuth:   (input) => requestPrivileged('/api/auth/config', 'auth.config', input || {}),
  rotateAuthToken: () => requestPrivileged('/api/auth/token/rotate', 'auth.rotate', {}),
  revealAuthToken: () => requestPrivileged('/api/auth/token/reveal', 'auth.reveal', {}),
  revokeAuthToken: () => requestPrivileged('/api/auth/token/revoke', 'auth.revoke', {}),
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
  providers:    () => request('/api/providers'),
  providersStatus: () => request('/api/providers/status'),
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
  decideToolApproval: (payload) => request('/api/tools/approvals/decision', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  toolCategories: () => request('/api/tools/categories'),
  toggleToolCategory: (payload) => request('/api/tools/categories', {
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
  sendMessage:  (content, agentId, userId, channel = 'web') => {
    const payload = { content, userId, channel };
    if (agentId) payload.agentId = agentId;
    return request('/api/message', {
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

  // QMD Search
  qmdStatus: () => request('/api/qmd/status'),
  qmdSources: () => request('/api/qmd/sources'),
  qmdSourceAdd: (source) => request('/api/qmd/sources', {
    method: 'POST',
    body: JSON.stringify(source),
  }),
  qmdSourceRemove: (id) => request(`/api/qmd/sources/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  qmdSourceToggle: (id, enabled) => request(`/api/qmd/sources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  }),
  qmdReindex: (collection) => request('/api/qmd/reindex', {
    method: 'POST',
    body: JSON.stringify(collection ? { collection } : {}),
  }),
};
