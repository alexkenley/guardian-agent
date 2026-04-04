/**
 * Main application — hash-based router + SSE connection manager.
 */

import { api, setToken, clearToken, AUTH_FAILED_EVENT, AUTH_RECOVERED_EVENT } from './api.js';
import { renderDashboard, updateDashboard } from './pages/dashboard.js';
import { renderSecurity, updateSecurity } from './pages/security.js';
import { renderConfig, updateConfig } from './pages/config.js';
import { renderReference } from './pages/reference.js';
import { renderMemory, updateMemory } from './pages/memory.js';
import { renderNetwork, updateNetwork } from './pages/network.js';
import { renderAutomations, updateAutomations } from './pages/automations.js';
import { renderCloud, updateCloud } from './pages/cloud.js';
import { confirmCodeRouteLeave, renderCode, updateCode, teardownCode } from './pages/code.js';
import { initChatPanel, setChatContext } from './chat-panel.js';
import { applyInputTooltips } from './tooltip.js';
import { initTheme } from './theme.js';

const content = document.getElementById('content');
const chatPanel = document.getElementById('chat-panel');
const layout = document.querySelector('.layout');
const authModal = document.getElementById('auth-modal');
const app = document.getElementById('app');
const indicator = document.getElementById('connection-indicator');
let eventSource = null;
let currentPage = '';
let lastCommittedHash = window.location.hash || '#/';
let invalidationTimer = null;
let invalidationInFlight = false;
let invalidationQueued = false;
let securityAlertTray = null;
let appStarted = false;
let authRecoveryInProgress = false;
const DENSE_CHAT_PANEL_ROUTES = new Set(['automations', 'config']);

// ─── Auth ────────────────────────────────────────────────

async function checkAuth() {
  // Try to reach status endpoint
  try {
    await api.status({ retryOnAuth: false });
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

  showAuthPrompt();
}

function showAuthPrompt(initialError = '') {
  authModal.style.display = '';
  app.style.display = 'none';

  const input = document.getElementById('auth-token-input');
  const submit = document.getElementById('auth-submit');
  const form = document.getElementById('auth-form');
  const errorEl = document.getElementById('auth-error');

  if (!input || !submit || !form || !errorEl) return;

  errorEl.textContent = initialError;
  errorEl.style.display = initialError ? '' : 'none';

  form.onsubmit = async (event) => {
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
      authRecoveryInProgress = false;
      authModal.style.display = 'none';
      app.style.display = '';
      applyInputTooltips(document);
      if (!appStarted) {
        startApp();
      } else {
        connectSSE();
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          if (typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(AUTH_RECOVERED_EVENT));
          } else {
            window.dispatchEvent(new Event(AUTH_RECOVERED_EVENT));
          }
        }
      }
    } else {
      clearToken();
      errorEl.textContent = check === 'unreachable' ? 'Server unreachable' : 'Invalid token';
      errorEl.style.display = '';
    }
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') form.requestSubmit ? form.requestSubmit() : submit.click();
  };

  applyInputTooltips(authModal);
}

// ─── SSE ─────────────────────────────────────────────────

const sseListeners = {
  audit: [],
  metrics: [],
  watchdog: [],
  'security.alert': [],
  'security.triage': [],
  'assistant.notice': [],
  'chat.thinking': [],
  'chat.tool_call': [],
  'chat.token': [],
  'chat.done': [],
  'chat.error': [],
  'ui.invalidate': [],
  'terminal.output': [],
  'terminal.exit': [],
  'run.timeline': [],
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

function pushAssistantNotice(payload) {
  pushSecurityAlert({
    severity: 'info',
    title: 'Assistant report',
    sourceEventType: 'assistant.notice',
    agentId: 'assistant',
    description: payload?.text || 'No additional detail provided.',
  });
}

// ─── Router ──────────────────────────────────────────────

const routes = {
  '/': {
    render: renderDashboard,
    update: updateDashboard,
    name: 'dashboard',
    invalidateTags: ['dashboard', 'config', 'providers', 'security', 'network', 'automations', 'tools', 'memory'],
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
  '/memory': {
    render: renderMemory,
    update: updateMemory,
    name: 'memory',
    invalidateTags: ['memory', 'config'],
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
  '/code': {
    render: renderCode,
    update: updateCode,
    name: 'code',
    invalidateTags: [],
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

  // Preserve scroll position across hot reload
  const scrollTop = content.scrollTop;
  const activeEl = document.activeElement;
  const focusId = activeEl?.id || null;
  const focusSelector = activeEl && !focusId
    ? activeEl.getAttribute('name') || activeEl.getAttribute('data-tab-id') || null
    : null;

  await updater(content);

  // Restore scroll position
  content.scrollTop = scrollTop;

  // Restore focus if possible
  if (focusId) {
    document.getElementById(focusId)?.focus();
  } else if (focusSelector) {
    const el = content.querySelector(`[name="${focusSelector}"]`)
      || content.querySelector(`[data-tab-id="${focusSelector}"]`);
    if (el) el.focus();
  }
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

async function navigate() {
  const nextHash = window.location.hash || '#/';
  const raw = nextHash.slice(1) || '/';
  const [path, query] = raw.split('?');

  const params = new URLSearchParams(query || '');
  const route = routes[path] || routes['/'];
  const previousPage = currentPage;

  if (previousPage === 'code' && route.name !== 'code') {
    const canLeaveCode = await confirmCodeRouteLeave();
    if (!canLeaveCode) {
      if (window.location.hash !== lastCommittedHash) {
        window.location.hash = lastCommittedHash;
      }
      return;
    }
    teardownCode();
  }

  currentPage = route.name;
  setChatContext(currentPage);

  const isCodeRoute = currentPage === 'code';
  const isWideChatRoute = !isCodeRoute && !DENSE_CHAT_PANEL_ROUTES.has(currentPage);
  layout?.classList.toggle('layout-code-page', isCodeRoute);
  layout?.classList.toggle('layout-chat-wide', isWideChatRoute);
  content.classList.toggle('content-code-page', isCodeRoute);
  if (chatPanel) {
    chatPanel.hidden = false;
  }

  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === route.name);
  });

  lastCommittedHash = nextHash;

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
  appStarted = true;
  connectSSE();
  onSSE('ui.invalidate', (payload) => {
    const { route } = getRouteState();
    if (!routeMatchesInvalidation(route, payload)) return;
    scheduleCurrentRouteRefresh();
  });
  onSSE('security.alert', (payload) => {
    pushSecurityAlert(payload);
  });
  onSSE('assistant.notice', (payload) => {
    pushAssistantNotice(payload);
  });
  startClock();
  initChatPanel(chatPanel);

  // ── Collapsible sidebar ──
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('app-sidebar');
  const SIDEBAR_COLLAPSED_KEY = 'guardianagent_sidebar_collapsed';
  if (sidebarToggle && sidebar) {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') {
      sidebar.classList.add('is-collapsed');
      layout?.style.setProperty('--sidebar-width', '48px');
      sidebarToggle.innerHTML = '&#x276F;';
      sidebarToggle.title = 'Expand sidebar';
    }
    sidebarToggle.addEventListener('click', () => {
      const isCollapsed = sidebar.classList.toggle('is-collapsed');
      layout?.style.setProperty('--sidebar-width', isCollapsed ? '48px' : '200px');
      sidebarToggle.innerHTML = isCollapsed ? '&#x276F;' : '&#x276E;';
      sidebarToggle.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isCollapsed));
    });
  }

  window.addEventListener('hashchange', () => {
    void navigate();
  });
  void navigate();

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

window.addEventListener(AUTH_FAILED_EVENT, () => {
  if (!appStarted || authRecoveryInProgress) return;
  authRecoveryInProgress = true;
  clearToken();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  indicator.className = 'indicator disconnected';
  indicator.textContent = 'Disconnected';
  showAuthPrompt('Session expired. Enter the dashboard token again.');
});

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
