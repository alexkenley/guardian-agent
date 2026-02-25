/**
 * Monitoring page — live events, agent state grid, resource usage.
 */

import { api } from '../api.js';
import { createEventLog, appendEvent } from '../components/event-log.js';
import { onSSE, offSSE } from '../app.js';

let eventLogEl = null;
let auditHandler = null;
let metricsHandler = null;
let agentGridEl = null;
let budgetTableBody = null;
let pendingCountEl = null;

export async function renderMonitoring(container) {
  container.innerHTML = '<h2 class="page-title">Monitoring</h2><div class="loading">Loading...</div>';

  // Cleanup previous handlers
  if (auditHandler) { offSSE('audit', auditHandler); auditHandler = null; }
  if (metricsHandler) { offSSE('metrics', metricsHandler); metricsHandler = null; }

  try {
    const [agents, budget, analytics] = await Promise.all([
      api.agents().catch(() => []),
      api.budget().catch(() => ({ agents: [], recentOverruns: [] })),
      api.analyticsSummary(3600000).catch(() => null),
    ]);

    container.innerHTML = '<h2 class="page-title">Monitoring</h2>';

    // Live event stream
    const sectionHeader1 = document.createElement('h3');
    sectionHeader1.className = 'section-header';
    sectionHeader1.textContent = 'Live Event Stream';
    container.appendChild(sectionHeader1);

    eventLogEl = createEventLog('Audit Events');
    container.appendChild(eventLogEl);

    // Agent state grid
    const sectionHeader2 = document.createElement('h3');
    sectionHeader2.className = 'section-header';
    sectionHeader2.textContent = 'Agent States';
    container.appendChild(sectionHeader2);

    agentGridEl = document.createElement('div');
    agentGridEl.className = 'agent-grid';
    renderAgentGrid(agentGridEl, agents);
    container.appendChild(agentGridEl);

    // Resource usage
    const sectionHeader3 = document.createElement('h3');
    sectionHeader3.className = 'section-header';
    sectionHeader3.textContent = 'Resource Usage';
    container.appendChild(sectionHeader3);

    const budgetContainer = document.createElement('div');
    budgetContainer.className = 'table-container';
    budgetContainer.innerHTML = `
      <div class="table-header">
        <h3>Budget & Resources</h3>
        <span id="pending-count" style="font-size:0.75rem;color:var(--text-muted);">EventBus pending: 0</span>
      </div>
      <table>
        <thead><tr><th>Agent</th><th>Tokens/min</th><th>Concurrent</th><th>Overruns</th></tr></thead>
        <tbody id="budget-table-body"></tbody>
      </table>
    `;
    container.appendChild(budgetContainer);

    budgetTableBody = budgetContainer.querySelector('#budget-table-body');
    pendingCountEl = budgetContainer.querySelector('#pending-count');
    renderBudgetTable(budget.agents);

    if (analytics) {
      const analyticsSection = document.createElement('div');
      analyticsSection.className = 'table-container';
      analyticsSection.innerHTML = `
        <div class="table-header"><h3>Interaction Analytics (60m)</h3></div>
        <table>
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Total events</td><td>${analytics.totalEvents}</td></tr>
            <tr><td>Channels</td><td>${Object.entries(analytics.byChannel).map(([name, count]) => `${esc(name)}: ${count}`).join(', ') || '-'}</td></tr>
            <tr><td>Top agents</td><td>${analytics.topAgents.map((a) => `${esc(a.agentId)} (${a.count})`).join(', ') || '-'}</td></tr>
            <tr><td>Top commands</td><td>${analytics.commandUsage.map((c) => `/${esc(c.command)} (${c.count})`).join(', ') || '-'}</td></tr>
          </tbody>
        </table>
      `;
      container.appendChild(analyticsSection);
    }

    // Overruns
    if (budget.recentOverruns.length > 0) {
      const overrunContainer = document.createElement('div');
      overrunContainer.className = 'table-container';
      overrunContainer.innerHTML = `
        <div class="table-header"><h3>Recent Budget Overruns</h3></div>
        <table>
          <thead><tr><th>Agent</th><th>Type</th><th>Budget (ms)</th><th>Used (ms)</th></tr></thead>
          <tbody>${budget.recentOverruns.slice(-10).map(o => `
            <tr>
              <td>${esc(o.agentId)}</td>
              <td>${esc(o.invocationType)}</td>
              <td>${Math.round(o.budgetMs)}</td>
              <td>${Math.round(o.usedMs)}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
      container.appendChild(overrunContainer);
    }

    // SSE: live audit events
    auditHandler = (event) => {
      if (eventLogEl) appendEvent(eventLogEl, event);
    };
    onSSE('audit', auditHandler);

    // SSE: metrics updates
    metricsHandler = (data) => {
      if (agentGridEl && data.agents) {
        renderAgentGrid(agentGridEl, data.agents);
      }
      if (pendingCountEl) {
        pendingCountEl.textContent = `EventBus pending: ${data.eventBusPending || 0}`;
      }
    };
    onSSE('metrics', metricsHandler);

  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Monitoring</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function renderAgentGrid(gridEl, agents) {
  gridEl.innerHTML = agents.map(a => `
    <div class="agent-tile">
      <div class="tile-name">${esc(a.name)}</div>
      <div class="tile-id">${esc(a.id)}</div>
      <span class="badge badge-${a.state}">${esc(a.state)}</span>
    </div>
  `).join('');
}

function renderBudgetTable(agents) {
  if (!budgetTableBody) return;
  budgetTableBody.innerHTML = agents.map(a => `
    <tr>
      <td>${esc(a.agentId)}</td>
      <td>${a.tokensPerMinute}</td>
      <td>${a.concurrentInvocations}</td>
      <td>${a.overrunCount}</td>
    </tr>
  `).join('');
}

export function updateMonitoring() {
  // SSE handlers above manage live updates
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
