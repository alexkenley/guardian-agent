import { api } from '../api.js';

let currentContainer = null;
let state = {
  status: null,
  activeTab: 'overview',
};

export async function renderPerformance(container) {
  currentContainer = container;
  container.innerHTML = '<div class="loading">Loading Performance Data...</div>';

  try {
    const status = await api.performanceStatus();
    state.status = status;

    container.innerHTML = `
      <div class="layout-heading">
        <h2>Performance Manager</h2>
      </div>
      <div id="perf-tabs"></div>
    `;

    const tabsContainer = container.querySelector('#perf-tabs');
    const tabDefs = [
      { id: 'overview', label: 'Overview', render: renderOverview },
      { id: 'profiles', label: 'Profiles', render: renderProfiles },
      { id: 'live', label: 'Live', render: renderLive },
      { id: 'latency', label: 'Latency', render: renderLatency },
      { id: 'actions', label: 'Actions', render: renderActions },
      { id: 'history', label: 'History', render: renderHistory },
    ];

    renderTabs(tabsContainer, tabDefs, state.activeTab);
  } catch (err) {
    container.innerHTML = `<div class="loading">Error: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
}

export function updatePerformance() {
  if (currentContainer) {
    void renderPerformance(currentContainer);
  }
}

function renderTabs(container, tabs, activeId) {
  const bar = document.createElement('div');
  bar.className = 'tab-bar';
  
  const content = document.createElement('div');
  content.className = 'tab-content';
  content.style.paddingTop = '1rem';

  tabs.forEach((tab) => {
    const btn = document.createElement('button');
    btn.className = `tab-btn ${tab.id === activeId ? 'active' : ''}`;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => {
      state.activeTab = tab.id;
      bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      tab.render(content);
    });
    bar.appendChild(btn);
  });

  container.appendChild(bar);
  container.appendChild(content);

  const activeTab = tabs.find(t => t.id === activeId) || tabs[0];
  if (activeTab) {
    activeTab.render(content);
  }
}

function renderOverview(panel) {
  const snap = state.status?.snapshot;
  panel.innerHTML = `
    <div class="cards-grid">
      <div class="status-card info">
        <div class="card-title">OS</div>
        <div class="card-value">${esc(state.status?.os || 'Unknown')}</div>
        <div class="card-subtitle">Active Profile: ${esc(state.status?.activeProfile || 'None')}</div>
      </div>
      <div class="status-card ${snap?.cpuPercent > 80 ? 'warning' : 'success'}">
        <div class="card-title">CPU Usage</div>
        <div class="card-value">${Math.round(snap?.cpuPercent || 0)}%</div>
      </div>
      <div class="status-card ${snap?.memoryMb > 14000 ? 'warning' : 'success'}">
        <div class="card-title">Memory Usage</div>
        <div class="card-value">${Math.round((snap?.memoryMb || 0) / 1024)} GB</div>
      </div>
      <div class="status-card info">
        <div class="card-title">Disk Free</div>
        <div class="card-value">${Math.round((snap?.diskFreeMb || 0) / 1024)} GB</div>
      </div>
    </div>
  `;
}

function renderProfiles(panel) {
  panel.innerHTML = `
    <div class="table-container">
      <div class="table-header"><h3>Available Profiles</h3></div>
      <table>
        <thead><tr><th>Profile</th><th>Action</th></tr></thead>
        <tbody>
          <tr>
            <td>Coding Focus</td>
            <td><button class="btn btn-secondary btn-sm" onclick="applyProfile('coding-focus')">Apply</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderLive(panel) {
  panel.innerHTML = `
    <div class="table-container">
      <div class="table-header"><h3>Live Processes</h3></div>
      <div style="padding:1rem;">Live process monitoring will appear here.</div>
    </div>
  `;
}

function renderLatency(panel) {
  panel.innerHTML = `
    <div class="table-container">
      <div class="table-header"><h3>Latency Probes</h3></div>
      <div style="padding:1rem;">Active latency probes will appear here.</div>
    </div>
  `;
}

function renderActions(panel) {
  panel.innerHTML = `
    <div class="table-container">
      <div class="table-header"><h3>Performance Actions</h3></div>
      <div style="padding: 1rem;">
        <button class="btn btn-primary" id="btn-preview-cleanup">Preview Cleanup</button>
        <div id="preview-results" style="margin-top: 1rem;"></div>
      </div>
    </div>
  `;

  const btn = panel.querySelector('#btn-preview-cleanup');
  btn?.addEventListener('click', async () => {
    try {
      const res = await api.performancePreviewAction('cleanup');
      const resultsDiv = panel.querySelector('#preview-results');
      if (resultsDiv) {
        resultsDiv.innerHTML = `
          <h4>Preview: ${res.previewId}</h4>
          <ul>
            ${res.cleanupTargets.map(t => `<li>${esc(t.label)} (Risk: ${t.risk})</li>`).join('')}
          </ul>
        `;
      }
    } catch (e) {
      console.error(e);
    }
  });
}

function renderHistory(panel) {
  panel.innerHTML = `
    <div class="table-container">
      <div class="table-header"><h3>Action History</h3></div>
      <div style="padding:1rem;">History of performance actions will appear here.</div>
    </div>
  `;
}

window.applyProfile = async function(id) {
  try {
    await api.performanceApplyProfile(id);
    alert('Applied ' + id);
    updatePerformance();
  } catch(e) {
    alert('Failed: ' + e);
  }
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escAttr(value) {
  return esc(value).replace(/'/g, '&#39;');
}
