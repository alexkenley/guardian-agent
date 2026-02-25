/**
 * Main application — hash-based router + SSE connection manager.
 */

import { api, setToken } from './api.js';
import { renderDashboard, updateDashboard } from './pages/dashboard.js';
import { renderChat } from './pages/chat.js';
import { renderSecurity, updateSecurity } from './pages/security.js';
import { renderMonitoring, updateMonitoring } from './pages/monitoring.js';
import { renderConfig } from './pages/config.js';
import { renderReference } from './pages/reference.js';
import { renderIntel } from './pages/intel.js';

const content = document.getElementById('content');
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
    return true;
  } catch (e) {
    if (e.message === 'AUTH_FAILED') return false;
    // Server might not require auth
    return true;
  }
}

async function initAuth() {
  const ok = await checkAuth();
  if (ok) {
    authModal.style.display = 'none';
    app.style.display = '';
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
    const ok = await checkAuth();
    if (ok) {
      authModal.style.display = 'none';
      app.style.display = '';
      startApp();
    } else {
      errorEl.textContent = 'Invalid token';
      errorEl.style.display = '';
    }
  };

  skip.onclick = () => {
    authModal.style.display = 'none';
    app.style.display = '';
    startApp();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });
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
  '/chat': { render: renderChat, name: 'chat' },
  '/security': { render: renderSecurity, update: updateSecurity, name: 'security' },
  '/monitoring': { render: renderMonitoring, update: updateMonitoring, name: 'monitoring' },
  '/intel': { render: renderIntel, name: 'intel' },
  '/config': { render: renderConfig, name: 'config' },
  '/reference': { render: renderReference, name: 'reference' },
};

function navigate() {
  const hash = window.location.hash.slice(1) || '/';
  const route = routes[hash] || routes['/'];

  currentPage = route.name;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === route.name);
  });

  // Render page
  route.render(content);
}

function startApp() {
  connectSSE();
  window.addEventListener('hashchange', navigate);
  navigate();
}

// ─── Init ────────────────────────────────────────────────

initAuth();
