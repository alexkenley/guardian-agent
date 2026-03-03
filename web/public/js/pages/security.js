/**
 * Security page — audit summary, filtered log, anomaly alerts.
 */

import { api } from '../api.js';
import { createStatusCard } from '../components/status-card.js';
import { onSSE, offSSE } from '../app.js';
import { applyInputTooltips } from '../tooltip.js';

let auditHandler = null;
let auditTableBody = null;

export async function renderSecurity(container) {
  container.innerHTML = '<h2 class="page-title">Security</h2><div class="loading">Loading...</div>';

  // Cleanup previous SSE handler
  if (auditHandler) {
    offSSE('audit', auditHandler);
    auditHandler = null;
  }

  try {
    const summary = await api.auditSummary(300000);

    container.innerHTML = '<h2 class="page-title">Security</h2>';

    // Summary cards
    const grid = document.createElement('div');
    grid.className = 'cards-grid';

    grid.appendChild(createStatusCard('Total Events', summary.totalEvents, 'Last 5 minutes', 'info'));
    grid.appendChild(createStatusCard('Denials', summary.byType.action_denied || 0, 'Actions blocked', summary.byType.action_denied ? 'warning' : 'success'));
    grid.appendChild(createStatusCard('Secrets Detected', summary.byType.secret_detected || 0, 'Credential leaks caught', summary.byType.secret_detected ? 'error' : 'success'));
    grid.appendChild(createStatusCard('Anomalies', summary.byType.anomaly_detected || 0, 'Anomaly alerts', summary.byType.anomaly_detected ? 'error' : 'success'));

    container.appendChild(grid);

    // Audit Chain Verification
    const verifySection = document.createElement('div');
    verifySection.className = 'table-container';
    verifySection.innerHTML = `
      <div class="table-header">
        <h3>Audit Chain Integrity</h3>
        <button class="btn btn-primary" id="verify-chain" style="font-size:0.7rem;padding:0.3rem 0.6rem;">Verify Audit Chain</button>
      </div>
      <div id="chain-result" style="padding:0.75rem 1rem;font-size:0.8rem;color:var(--text-secondary);">
        Click "Verify Audit Chain" to check tamper-evident hash chain integrity.
      </div>
    `;
    container.appendChild(verifySection);

    verifySection.querySelector('#verify-chain')?.addEventListener('click', async () => {
      const resultEl = verifySection.querySelector('#chain-result');
      resultEl.textContent = 'Verifying chain...';
      resultEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.verifyAuditChain();
        if (result.valid) {
          resultEl.textContent = `Chain valid. ${result.totalEntries} entries verified.`;
          resultEl.style.color = 'var(--success)';
        } else {
          resultEl.textContent = `Chain BROKEN at entry ${result.brokenAt} of ${result.totalEntries}. Possible tampering detected.`;
          resultEl.style.color = 'var(--error)';
        }
      } catch (err) {
        resultEl.textContent = `Verification failed: ${err.message || String(err)}`;
        resultEl.style.color = 'var(--error)';
      }
    });

    // Filters
    const filters = document.createElement('div');
    filters.className = 'filters';
    filters.innerHTML = `
      <label>Type:</label>
      <select id="filter-type">
        <option value="">All</option>
        <option value="action_denied">action_denied</option>
        <option value="action_allowed">action_allowed</option>
        <option value="secret_detected">secret_detected</option>
        <option value="output_blocked">output_blocked</option>
        <option value="output_redacted">output_redacted</option>
        <option value="event_blocked">event_blocked</option>
        <option value="input_sanitized">input_sanitized</option>
        <option value="rate_limited">rate_limited</option>
        <option value="capability_probe">capability_probe</option>
        <option value="policy_changed">policy_changed</option>
        <option value="anomaly_detected">anomaly_detected</option>
        <option value="agent_error">agent_error</option>
        <option value="agent_stalled">agent_stalled</option>
      </select>
      <label>Severity:</label>
      <select id="filter-severity">
        <option value="">All</option>
        <option value="critical">Critical</option>
        <option value="warn">Warning</option>
        <option value="info">Info</option>
      </select>
      <label>Agent:</label>
      <input type="text" id="filter-agent" placeholder="Agent ID" style="width:120px;">
      <label>Limit:</label>
      <input type="number" id="filter-limit" value="50" min="1" max="500" style="width:60px;">
      <button class="btn btn-primary" id="filter-apply">Apply</button>
    `;
    container.appendChild(filters);

    // Audit table
    const tableContainer = document.createElement('div');
    tableContainer.className = 'table-container';
    tableContainer.innerHTML = `
      <div class="table-header"><h3>Audit Log</h3></div>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Agent</th><th>Controller</th><th>Details</th></tr></thead>
        <tbody id="audit-table-body"></tbody>
      </table>
    `;
    container.appendChild(tableContainer);

    auditTableBody = tableContainer.querySelector('#audit-table-body');

    // Load initial data
    await loadAuditEvents();

    // Filter button
    document.getElementById('filter-apply').addEventListener('click', loadAuditEvents);
    applyInputTooltips(container);

    // Top denied agents
    if (summary.topDeniedAgents.length > 0) {
      const deniedSection = document.createElement('div');
      deniedSection.className = 'table-container';
      deniedSection.innerHTML = `
        <div class="table-header"><h3>Top Denied Agents</h3></div>
        <table>
          <thead><tr><th>Agent ID</th><th>Denial Count</th></tr></thead>
          <tbody>${summary.topDeniedAgents.map(a => `
            <tr><td>${esc(a.agentId)}</td><td>${a.count}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      container.appendChild(deniedSection);
    }

    // SSE: append new audit events in real-time
    auditHandler = (event) => {
      if (!auditTableBody) return;
      const row = createAuditRow(event);
      // Prepend new events
      auditTableBody.insertBefore(row, auditTableBody.firstChild);
      // Cap rows
      while (auditTableBody.children.length > 100) {
        auditTableBody.removeChild(auditTableBody.lastChild);
      }
    };
    onSSE('audit', auditHandler);

  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Security</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

async function loadAuditEvents() {
  if (!auditTableBody) return;

  const type = document.getElementById('filter-type')?.value;
  const severity = document.getElementById('filter-severity')?.value;
  const agentId = document.getElementById('filter-agent')?.value;
  const limit = document.getElementById('filter-limit')?.value;

  try {
    const events = await api.audit({ type, severity, agentId, limit });
    auditTableBody.innerHTML = '';
    for (const event of events.reverse()) {
      auditTableBody.appendChild(createAuditRow(event));
    }
  } catch {
    // Keep existing data
  }
}

function createAuditRow(event) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
    <td>${esc(event.type)}</td>
    <td><span class="badge badge-${event.severity}">${esc(event.severity)}</span></td>
    <td>${esc(event.agentId)}</td>
    <td>${esc(event.controller || '-')}</td>
    <td>${esc(summarize(event.details))}</td>
  `;
  return tr;
}

function summarize(details) {
  if (!details) return '-';
  if (details.reason) return String(details.reason);
  if (details.error) return String(details.error);
  return JSON.stringify(details).slice(0, 60);
}

export function updateSecurity() {
  // SSE handler above handles live updates
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
