/**
 * Main application — hash-based router + SSE connection manager.
 */

import { api, setToken, clearToken } from './api.js';
import { renderDashboard, updateDashboard } from './pages/dashboard.js';
import { renderSecurity, updateSecurity } from './pages/security.js';
import { renderConfig, updateConfig } from './pages/config.js';
import { renderReference } from './pages/reference.js';
import { renderNetwork, updateNetwork } from './pages/network.js';
import { renderAutomations, updateAutomations } from './pages/automations.js';
import { renderCloud, updateCloud } from './pages/cloud.js';
import { initChatPanel, setChatContext } from './chat-panel.js';
import { applyInputTooltips } from './tooltip.js';
import { initTheme } from './theme.js';

const content = document.getElementById('content');
const chatPanel = document.getElementById('chat-panel');
const authModal = document.getElementById('auth-modal');
const app = document.getElementById('app');
const indicator = document.getElementById('connection-indicator');
let eventSource = null;
let currentPage = '';
let invalidationTimer = null;
let invalidationInFlight = false;
let invalidationQueued = false;
let securityAlertTray = null;

// ─── Auth ────────────────────────────────────────────────

async function checkAuth() {
  // Try to reach status endpoint
  try {
    await api.status();
    return 'ok';
  } catch (e) {
    if (e.message === 'AUTH_FAILED') return 'auth_failed';
    // Network error — server is unreachable
    return 'unreachable';
  }
}

async function initAuth() {
  const result = await checkAuth();
  if (result === 'ok') {
    // If we authenticated with a bearer token, exchange it for an HttpOnly session cookie
    // so SSE can authenticate without leaking tokens in URLs.
    const existingToken = sessionStorage.getItem('guardianagent_token') || '';
    if (existingToken) {
      try {
        await api.createSession(existingToken);
      } catch {
        // Keep the token for API calls if session creation fails.
      }
    }
    authModal.style.display = 'none';
    app.style.display = '';
    applyInputTooltips(document);
    startApp();
    return;
  }

  if (result === 'unreachable') {
    // Server is down — show a connection error, not the auth form
    authModal.style.display = '';
    app.style.display = 'none';
    authModal.querySelector('.modal-content').innerHTML = `
      <h2>Guardian Agent</h2>
      <p>Cannot reach the server. Make sure Guardian Agent is running.</p>
      <button id="auth-retry" class="btn btn-primary">Retry</button>
    `;
    document.getElementById('auth-retry').onclick = () => location.reload();
    return;
  }

  // AUTH_FAILED — clear any stale token so it doesn't keep causing 401s
  clearToken();

  // Show auth modal
  authModal.style.display = '';
  app.style.display = 'none';

  const input = document.getElementById('auth-token-input');
  const submit = document.getElementById('auth-submit');
  const form = document.getElementById('auth-form');
  const errorEl = document.getElementById('auth-error');

  const handleSubmit = async (event) => {
    event?.preventDefault?.();
    const token = input.value.trim();
    if (!token) {
      errorEl.textContent = 'Token is required';
      errorEl.style.display = '';
      return;
    }
    setToken(token);
    const check = await checkAuth();
    if (check === 'ok') {
      try {
        await api.createSession(token);
      } catch {
        clearToken();
        errorEl.textContent = 'Authenticated, but failed to create secure session.';
        errorEl.style.display = '';
        return;
      }
      authModal.style.display = 'none';
      app.style.display = '';
      applyInputTooltips(document);
      startApp();
    } else {
      clearToken();
      errorEl.textContent = check === 'unreachable' ? 'Server unreachable' : 'Invalid token';
      errorEl.style.display = '';
    }
  };
  form?.addEventListener('submit', handleSubmit);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') form?.requestSubmit ? form.requestSubmit() : submit.click();
  });

  applyInputTooltips(authModal);
}

// ─── SSE ─────────────────────────────────────────────────

const sseListeners = {
  audit: [],
  metrics: [],
  watchdog: [],
  'security.alert': [],
  'chat.thinking': [],
  'chat.tool_call': [],
  'chat.token': [],
  'chat.done': [],
  'chat.error': [],
  'ui.invalidate': [],
};

export function onSSE(type, fn) {
  if (sseListeners[type]) sseListeners[type].push(fn);
}

export function offSSE(type, fn) {
  if (sseListeners[type]) {
    sseListeners[type] = sseListeners[type].filter(f => f !== fn);
  }
}

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  // SSE always uses cookie auth. Bearer tokens are exchanged for secure sessions at login.
  eventSource = new EventSource('/sse', { withCredentials: true });

  eventSource.onopen = () => {
    indicator.className = 'indicator connected';
    indicator.textContent = 'Connected';
  };

  eventSource.onerror = () => {
    indicator.className = 'indicator disconnected';
    indicator.textContent = 'Disconnected';
  };

  // Register listeners for all known SSE event types
  for (const eventType of Object.keys(sseListeners)) {
    eventSource.addEventListener(eventType, (e) => {
      const data = JSON.parse(e.data);
      for (const fn of sseListeners[eventType]) fn(data);
    });
  }
}

function ensureSecurityAlertTray() {
  if (securityAlertTray) return securityAlertTray;
  securityAlertTray = document.createElement('div');
  securityAlertTray.id = 'security-alert-tray';
  securityAlertTray.className = 'security-alert-tray';
  document.body.appendChild(securityAlertTray);
  return securityAlertTray;
}

function pushSecurityAlert(notification) {
  const tray = ensureSecurityAlertTray();
  const item = document.createElement('div');
  item.className = `security-alert-item severity-${notification.severity || 'warn'}`;

  const description = notification.description || 'No additional detail provided.';
  item.innerHTML = `
    <button class="security-alert-dismiss" type="button" aria-label="Dismiss alert">&times;</button>
    <div class="security-alert-title">${esc(notification.title || 'Security alert')}</div>
    <div class="security-alert-meta">${esc(String(notification.sourceEventType || 'unknown'))} · ${esc(String(notification.agentId || 'system'))}</div>
    <div class="security-alert-description">${esc(description)}</div>
  `;

  const dismiss = () => item.remove();
  item.querySelector('.security-alert-dismiss')?.addEventListener('click', dismiss);
  tray.prepend(item);

  while (tray.children.length > 5) {
    tray.removeChild(tray.lastChild);
  }

  window.setTimeout(() => {
    item.remove();
    if (tray.children.length === 0) {
      tray.classList.remove('has-items');
    }
  }, 15000);

  tray.classList.add('has-items');
}

// ─── Router ──────────────────────────────────────────────

const routes = {
  '/': {
    render: renderDashboard,
    update: updateDashboard,
    name: 'dashboard',
    invalidateTags: ['dashboard', 'config', 'providers', 'security', 'network', 'automations', 'tools'],
  },
  '/security': {
    render: renderSecurity,
    update: updateSecurity,
    name: 'security',
    invalidateTags: ['security', 'threat-intel', 'network', 'config'],
  },
  '/network': {
    render: renderNetwork,
    update: updateNetwork,
    name: 'network',
    invalidateTags: ['network', 'automations', 'security'],
  },
  '/cloud': {
    render: renderCloud,
    update: updateCloud,
    name: 'cloud',
    invalidateTags: ['cloud', 'config', 'security', 'automations', 'tools'],
  },
  '/automations': {
    render: renderAutomations,
    update: updateAutomations,
    name: 'automations',
    invalidateTags: ['automations', 'network', 'tools', 'config'],
  },
  '/config': {
    render: renderConfig,
    update: updateConfig,
    name: 'config',
    invalidateTags: ['config', 'providers', 'tools', 'skills', 'security'],
  },
  '/reference': { render: renderReference, name: 'reference' },
};

function getRouteState() {
  const raw = window.location.hash.slice(1) || '/';
  const [path] = raw.split('?');
  const route = routes[path] || routes['/'];
  return { path, route };
}

function routeMatchesInvalidation(route, payload) {
  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  const invalidateTags = route?.invalidateTags || [];
  return topics.some((topic) => invalidateTags.includes(topic));
}

async function refreshCurrentRoute() {
  const { route } = getRouteState();
  const updater = route?.update || route?.render;
  if (!updater) return;
  await updater(content);
}

function scheduleCurrentRouteRefresh() {
  if (invalidationTimer) {
    clearTimeout(invalidationTimer);
  }

  invalidationTimer = setTimeout(async () => {
    invalidationTimer = null;

    if (invalidationInFlight) {
      invalidationQueued = true;
      return;
    }

    invalidationInFlight = true;
    try {
      await refreshCurrentRoute();
    } finally {
      invalidationInFlight = false;
      if (invalidationQueued) {
        invalidationQueued = false;
        scheduleCurrentRouteRefresh();
      }
    }
  }, 250);
}

function navigate() {
  const raw = window.location.hash.slice(1) || '/';
  const [path, query] = raw.split('?');

  // Redirect old pages to unified Automations
  if (path === '/workflows' || path === '/operations') {
    window.location.hash = '#/automations';
    return;
  }

  const params = new URLSearchParams(query || '');
  const route = routes[path] || routes['/'];

  currentPage = route.name;
  setChatContext(currentPage);

  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === route.name);
  });

  // Render page, passing options like tab deep-link
  route.render(content, { tab: params.get('tab') });
}

function startClock() {
  const el = document.getElementById('header-clock');
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

function startApp() {
  connectSSE();
  onSSE('ui.invalidate', (payload) => {
    const { route } = getRouteState();
    if (!routeMatchesInvalidation(route, payload)) return;
    scheduleCurrentRouteRefresh();
  });
  onSSE('security.alert', (payload) => {
    pushSecurityAlert(payload);
  });
  startClock();
  initChatPanel(chatPanel);
  window.addEventListener('hashchange', navigate);
  navigate();

  // Killswitch button
  const killBtn = document.getElementById('killswitch-btn');
  if (killBtn) {
    killBtn.onclick = async () => {
      if (!confirm('Shut down Guardian Agent and all services?')) return;
      killBtn.disabled = true;
      killBtn.textContent = 'Shutting down...';
      try {
        await api.killswitch();
      } catch {}
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#e8e4dc;font-family:Georgia,serif;font-size:1.4rem;">Guardian Agent has been shut down.</div>';
    };
  }
}

// ─── Init ────────────────────────────────────────────────

initTheme();
initAuth();

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
