/**
 * Main application — hash-based router + SSE connection manager.
 */

import { api, setToken, clearToken } from './api.js';
import { renderDashboard, updateDashboard } from './pages/dashboard.js';
import { renderSecurity, updateSecurity } from './pages/security.js';
import { renderConfig } from './pages/config.js';
import { renderReference } from './pages/reference.js';
import { renderNetwork } from './pages/network.js';
import { renderAutomations, updateAutomations } from './pages/automations.js';
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
  const errorEl = document.getElementById('auth-error');

  submit.onclick = async () => {
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

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
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

// ─── Router ──────────────────────────────────────────────

const routes = {
  '/': { render: renderDashboard, update: updateDashboard, name: 'dashboard' },
  '/security': { render: renderSecurity, update: updateSecurity, name: 'security' },
  '/network': { render: renderNetwork, name: 'network' },
  '/automations': { render: renderAutomations, update: updateAutomations, name: 'automations' },
  '/config': { render: renderConfig, name: 'config' },
  '/reference': { render: renderReference, name: 'reference' },
};

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
