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

export const api = {
  status:       () => request('/api/status'),
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
  config:       () => request('/api/config'),
  reference:    () => request('/api/reference'),
  setupStatus:  () => request('/api/setup/status'),
  applySetup:   (input) => request('/api/setup/apply', {
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
  quickActions: () => request('/api/quick-actions'),
  runQuickAction: (payload) => request('/api/quick-actions/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateConfig: (updates) => request('/api/config', {
    method: 'POST',
    body: JSON.stringify(updates),
  }),
  sendMessage:  (content, agentId, userId, channel = 'web') => request('/api/message', {
    method: 'POST',
    body: JSON.stringify({ content, agentId, userId, channel }),
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
};
