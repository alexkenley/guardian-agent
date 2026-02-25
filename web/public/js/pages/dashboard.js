/**
 * Dashboard page — overview with status cards, agent table, LLM status, recent events.
 */

import { api } from '../api.js';
import { createStatusCard, updateStatusCard } from '../components/status-card.js';
import { createAgentTable, updateAgentTable } from '../components/agent-table.js';
import { onSSE, offSSE } from '../app.js';

let cards = {};
let agentTableEl = null;
let llmStatusEl = null;
let metricsHandler = null;

export async function renderDashboard(container) {
  container.innerHTML = '<h2 class="page-title">Dashboard</h2><div class="loading">Loading...</div>';

  try {
    const [agents, summary, providers] = await Promise.all([
      api.agents().catch(() => []),
      api.auditSummary(300000).catch(() => null),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
    ]);
    const setupStatus = await api.setupStatus().catch(() => null);

    container.innerHTML = '<h2 class="page-title">Dashboard</h2>';

    // Status cards
    const grid = document.createElement('div');
    grid.className = 'cards-grid';

    cards.runtime = createStatusCard('Runtime', 'Online', 'System operational', 'success');
    cards.agents = createStatusCard('Agents', agents.length, `${agents.filter(a => a.state === 'idle' || a.state === 'running').length} active`, 'info');
    cards.guardian = createStatusCard('Guardian', summary ? 'Active' : 'N/A', summary ? `${summary.totalEvents} events (5m)` : 'No data', 'accent');

    // LLM card - show primary provider status
    const primaryProvider = providers[0];
    if (primaryProvider) {
      const connected = primaryProvider.connected !== false;
      const locality = primaryProvider.locality === 'local' ? 'Local' : 'External API';
      cards.llm = createStatusCard(
        'LLM Provider',
        connected ? 'Connected' : 'Disconnected',
        `${primaryProvider.model} (${locality})`,
        connected ? 'success' : 'error'
      );
    } else {
      cards.llm = createStatusCard('LLM Provider', 'None', 'No providers configured', 'warning');
    }

    cards.setup = createStatusCard(
      'Setup',
      setupStatus?.completed ? 'Complete' : 'Pending',
      setupStatus?.ready ? 'Ready for daily use' : 'Run Setup Wizard',
      setupStatus?.completed ? 'success' : 'warning',
    );

    grid.append(cards.runtime, cards.agents, cards.guardian, cards.llm, cards.setup);
    container.appendChild(grid);

    // LLM Provider Status section
    if (providers.length > 0) {
      llmStatusEl = document.createElement('div');
      llmStatusEl.className = 'table-container';
      renderLLMStatus(llmStatusEl, providers);
      container.appendChild(llmStatusEl);
    }

    // Agent table
    agentTableEl = createAgentTable(agents, 'Agent Status');
    container.appendChild(agentTableEl);

    // Recent critical/warn events
    if (summary && (summary.bySeverity.warn > 0 || summary.bySeverity.critical > 0)) {
      const recentEvents = await api.audit({ severity: 'warn', limit: 5 }).catch(() => []);
      const critEvents = await api.audit({ severity: 'critical', limit: 5 }).catch(() => []);
      const allRecent = [...critEvents, ...recentEvents].slice(0, 5);

      if (allRecent.length > 0) {
        const section = document.createElement('div');
        section.className = 'table-container';
        section.innerHTML = `
          <div class="table-header"><h3>Recent Alerts</h3></div>
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Agent</th><th>Details</th></tr></thead>
            <tbody>${allRecent.map(e => `
              <tr>
                <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
                <td>${esc(e.type)}</td>
                <td><span class="badge badge-${e.severity}">${esc(e.severity)}</span></td>
                <td>${esc(e.agentId)}</td>
                <td>${esc(e.controller || JSON.stringify(e.details).slice(0, 60))}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        `;
        container.appendChild(section);
      }
    }

    // SSE updates
    if (metricsHandler) offSSE('metrics', metricsHandler);
    metricsHandler = (data) => {
      if (agentTableEl && data.agents) {
        updateAgentTable(agentTableEl, data.agents);
        updateStatusCard(cards.agents, data.agents.length,
          `${data.agents.filter(a => a.state === 'idle' || a.state === 'running').length} active`);
      }
    };
    onSSE('metrics', metricsHandler);

  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Dashboard</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function renderLLMStatus(container, providers) {
  container.innerHTML = `
    <div class="table-header">
      <h3>LLM Providers</h3>
      <button class="btn btn-secondary" id="refresh-llm" style="font-size:0.7rem;padding:0.3rem 0.6rem;">Refresh</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Endpoint</th><th>Status</th><th>Available Models</th></tr></thead>
      <tbody>${providers.map(p => {
        const connected = p.connected !== false;
        const locality = p.locality === 'local' ? 'Local' : 'External API';
        return `
          <tr>
            <td>${esc(p.name)}</td>
            <td>${esc(p.type)}</td>
            <td><strong>${esc(p.model)}</strong></td>
            <td>${esc(p.baseUrl || locality)}</td>
            <td><span class="badge ${connected ? 'badge-idle' : 'badge-errored'}">${connected ? 'Connected' : 'Disconnected'}</span></td>
            <td>${p.availableModels ? p.availableModels.slice(0, 5).map(m => esc(m)).join(', ') : '-'}</td>
          </tr>
        `;
      }).join('')}</tbody>
    </table>
  `;

  container.querySelector('#refresh-llm')?.addEventListener('click', async () => {
    try {
      const updated = await api.providersStatus();
      renderLLMStatus(container, updated);

      // Update the LLM card too
      const primary = updated[0];
      if (primary && cards.llm) {
        const connected = primary.connected !== false;
        const locality = primary.locality === 'local' ? 'Local' : 'External API';
        updateStatusCard(cards.llm, connected ? 'Connected' : 'Disconnected', `${primary.model} (${locality})`);
        cards.llm.className = `status-card ${connected ? 'success' : 'error'}`;
      }
    } catch { /* ignore */ }
  });
}

export function updateDashboard() {
  // SSE handler above handles live updates
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
