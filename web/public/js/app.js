/**
 * Main application — hash-based router + SSE connection manager.
 */

import { api, setToken, clearToken } from './api.js';
import { renderDashboard, updateDashboard } from './pages/dashboard.js';
import { renderSecurity, updateSecurity } from './pages/security.js';
import { renderConfig } from './pages/config.js';
import { renderReference } from './pages/reference.js';
import { renderNetwork } from './pages/network.js';
import { renderOperations, updateOperations } from './pages/operations.js';
import { initChatPanel, setChatContext } from './chat-panel.js';
import { applyInputTooltips } from './tooltip.js';

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

  // Try once more without the stale token (works for localhost_no_auth mode)
  const retry = await checkAuth();
  if (retry === 'ok') {
    authModal.style.display = 'none';
    app.style.display = '';
    applyInputTooltips(document);
    startApp();
    return;
  }

  // Show auth modal
  authModal.style.display = '';
  app.style.display = 'none';

  const input = document.getElementById('auth-token-input');
  const submit = document.getElementById('auth-submit');
  const skip = document.getElementById('auth-skip');
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

  skip.onclick = () => {
    clearToken();
    authModal.style.display = 'none';
    app.style.display = '';
    startApp();
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

  const token = sessionStorage.getItem('guardianagent_token') || '';
  const url = token ? `/sse?token=${encodeURIComponent(token)}` : '/sse';

  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    indicator.className = 'indicator connected';
    indicator.textContent = 'Connected';
  };

  eventSource.onerror = () => {
    indicator.className = 'indicator disconnected';
    indicator.textContent = 'Disconnected';
  };

  eventSource.addEventListener('audit', (e) => {
    const data = JSON.parse(e.data);
    for (const fn of sseListeners.audit) fn(data);
  });

  eventSource.addEventListener('metrics', (e) => {
    const data = JSON.parse(e.data);
    for (const fn of sseListeners.metrics) fn(data);
  });

  eventSource.addEventListener('watchdog', (e) => {
    const data = JSON.parse(e.data);
    for (const fn of sseListeners.watchdog) fn(data);
  });
}

// ─── Router ──────────────────────────────────────────────

const routes = {
  '/': { render: renderDashboard, update: updateDashboard, name: 'dashboard' },
  '/security': { render: renderSecurity, update: updateSecurity, name: 'security' },
  '/network': { render: renderNetwork, name: 'network' },
  '/operations': { render: renderOperations, update: updateOperations, name: 'operations' },
  '/config': { render: renderConfig, name: 'config' },
  '/reference': { render: renderReference, name: 'reference' },
};

function navigate() {
  const hash = window.location.hash.slice(1) || '/';
  const route = routes[hash] || routes['/'];

  currentPage = route.name;
  setChatContext(currentPage);

  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === route.name);
  });

  // Render page
  route.render(content);
}

function startApp() {
  connectSSE();
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

initAuth();
