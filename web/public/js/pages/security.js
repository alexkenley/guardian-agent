/**
 * Security page — tabbed: Audit + Monitoring + Threat Intel.
 */

import { api } from '../api.js';
import { createStatusCard } from '../components/status-card.js';
import { createEventLog, appendEvent } from '../components/event-log.js';
import { createTabs } from '../components/tabs.js';
import { onSSE, offSSE } from '../app.js';
import { applyInputTooltips } from '../tooltip.js';

let auditHandler = null;
let monAuditHandler = null;
let monMetricsHandler = null;
let monSecurityAlertHandler = null;
let currentContainer = null;

function cleanupSSE() {
  if (auditHandler) { offSSE('audit', auditHandler); auditHandler = null; }
  if (monAuditHandler) { offSSE('audit', monAuditHandler); monAuditHandler = null; }
  if (monMetricsHandler) { offSSE('metrics', monMetricsHandler); monMetricsHandler = null; }
  if (monSecurityAlertHandler) { offSSE('security.alert', monSecurityAlertHandler); monSecurityAlertHandler = null; }
}

export async function renderSecurity(container, options = {}) {
  currentContainer = container;
  cleanupSSE();
  container.innerHTML = '<h2 class="page-title">Security</h2>';

  createTabs(container, [
    { id: 'audit', label: 'Audit', render: renderAuditTab },
    { id: 'monitoring', label: 'Monitoring', render: renderMonitoringTab },
    { id: 'intel', label: 'Threat Intel', render: renderIntelTab },
  ], options?.tab);
}

export async function updateSecurity() {
  if (!currentContainer) return;
  const activeTab = currentContainer.dataset.activeTab;
  await renderSecurity(currentContainer, activeTab ? { tab: activeTab } : {});
}

// ─── Audit Tab ────────────────────────────────────────────

async function renderAuditTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const summary = await api.auditSummary(300000);
    panel.innerHTML = '';

    // Summary cards
    const grid = document.createElement('div');
    grid.className = 'cards-grid';
    grid.appendChild(createStatusCard('Total Events', summary.totalEvents, 'Last 5 minutes', 'info'));
    grid.appendChild(createStatusCard('Denials', summary.byType.action_denied || 0, 'Actions blocked', summary.byType.action_denied ? 'warning' : 'success'));
    grid.appendChild(createStatusCard('Secrets Detected', summary.byType.secret_detected || 0, 'Credential leaks caught', summary.byType.secret_detected ? 'error' : 'success'));
    grid.appendChild(createStatusCard('Anomalies', summary.byType.anomaly_detected || 0, 'Anomaly alerts', summary.byType.anomaly_detected ? 'error' : 'success'));
    panel.appendChild(grid);

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
    panel.appendChild(verifySection);

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
    panel.appendChild(filters);

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
    panel.appendChild(tableContainer);

    const auditTableBody = tableContainer.querySelector('#audit-table-body');

    // Load initial data
    async function loadAuditEvents() {
      const type = panel.querySelector('#filter-type')?.value;
      const severity = panel.querySelector('#filter-severity')?.value;
      const agentId = panel.querySelector('#filter-agent')?.value;
      const limit = panel.querySelector('#filter-limit')?.value;
      try {
        const events = await api.audit({ type, severity, agentId, limit });
        auditTableBody.innerHTML = '';
        for (const event of events.reverse()) {
          auditTableBody.appendChild(createAuditRow(event));
        }
      } catch { /* keep existing data */ }
    }

    await loadAuditEvents();
    panel.querySelector('#filter-apply')?.addEventListener('click', loadAuditEvents);
    applyInputTooltips(panel);

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
      panel.appendChild(deniedSection);
    }

    // SSE: append new audit events
    auditHandler = (event) => {
      if (!auditTableBody) return;
      auditTableBody.insertBefore(createAuditRow(event), auditTableBody.firstChild);
      while (auditTableBody.children.length > 100) {
        auditTableBody.removeChild(auditTableBody.lastChild);
      }
    };
    onSSE('audit', auditHandler);

  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
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

// ─── Monitoring Tab ──────────────────────────────────────

async function renderMonitoringTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [agents, budget, analytics, baseline, threatState] = await Promise.all([
      api.agents().catch(() => []),
      api.budget().catch(() => ({ agents: [], recentOverruns: [] })),
      api.analyticsSummary(3600000).catch(() => null),
      api.networkBaseline().catch(() => null),
      api.networkThreats({ limit: 50 }).catch(() => null),
    ]);

    panel.innerHTML = '';

    const safeBaseline = baseline || {
      snapshotCount: 0,
      minSnapshotsForBaseline: 3,
      baselineReady: false,
      lastUpdatedAt: 0,
      knownDevices: [],
    };
    const safeThreatState = threatState || {
      alerts: [],
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      baselineReady: safeBaseline.baselineReady,
      snapshotCount: safeBaseline.snapshotCount,
    };

    const threatSectionHeader = document.createElement('h3');
    threatSectionHeader.className = 'section-header';
    threatSectionHeader.textContent = 'Network Threat Posture';
    panel.appendChild(threatSectionHeader);

    const threatGrid = document.createElement('div');
    threatGrid.className = 'cards-grid';
    panel.appendChild(threatGrid);

    const threatContainer = document.createElement('div');
    threatContainer.className = 'table-container';
    threatContainer.innerHTML = `
      <div class="table-header">
        <h3>Active Network Alerts</h3>
        <div>
          <span id="net-threat-meta" style="font-size:0.8rem;color:var(--text-muted);margin-right:0.75rem;"></span>
          <button class="btn btn-secondary" id="net-threat-refresh">Refresh</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Host</th><th>Details</th><th>Action</th></tr></thead>
        <tbody id="net-threat-table-body"></tbody>
      </table>
    `;
    panel.appendChild(threatContainer);

    const threatMetaEl = threatContainer.querySelector('#net-threat-meta');
    const threatTableBody = threatContainer.querySelector('#net-threat-table-body');

    const renderThreatCards = (baselineState, currentThreatState) => {
      threatGrid.innerHTML = '';
      threatGrid.appendChild(createStatusCard(
        'Baseline',
        baselineState.baselineReady ? 'Ready' : 'Learning',
        `${baselineState.snapshotCount}/${baselineState.minSnapshotsForBaseline} snapshots`,
        baselineState.baselineReady ? 'success' : 'warning',
      ));
      threatGrid.appendChild(createStatusCard(
        'Known Devices',
        baselineState.knownDevices.length,
        baselineState.lastUpdatedAt ? `Updated ${new Date(baselineState.lastUpdatedAt).toLocaleTimeString()}` : 'No snapshots yet',
        'info',
      ));
      threatGrid.appendChild(createStatusCard(
        'Active Alerts',
        currentThreatState.activeAlertCount || 0,
        `${currentThreatState.bySeverity?.critical ?? 0} critical`,
        (currentThreatState.bySeverity?.high ?? 0) > 0 || (currentThreatState.bySeverity?.critical ?? 0) > 0 ? 'error' : 'accent',
      ));
      threatGrid.appendChild(createStatusCard(
        'High + Critical',
        (currentThreatState.bySeverity?.high ?? 0) + (currentThreatState.bySeverity?.critical ?? 0),
        `Medium ${currentThreatState.bySeverity?.medium ?? 0} / Low ${currentThreatState.bySeverity?.low ?? 0}`,
        (currentThreatState.bySeverity?.high ?? 0) + (currentThreatState.bySeverity?.critical ?? 0) > 0 ? 'warning' : 'success',
      ));
    };

    const renderThreatRows = (alerts) => {
      if (!threatTableBody) return;
      if (!alerts || alerts.length === 0) {
        threatTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active network alerts.</td></tr>';
        return;
      }
      threatTableBody.innerHTML = alerts.map((alert) => `
        <tr>
          <td>${new Date(alert.lastSeenAt || alert.timestamp || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
          <td>${esc(alert.type)}</td>
          <td>${esc(alert.ip || alert.mac || '-')}</td>
          <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
          <td><button class="btn btn-secondary net-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
        </tr>
      `).join('');
    };

    const applyThreatState = (baselineState, currentThreatState) => {
      renderThreatCards(baselineState, currentThreatState);
      renderThreatRows(currentThreatState.alerts || []);
      if (threatMetaEl) {
        threatMetaEl.textContent = `Snapshots: ${baselineState.snapshotCount} • Baseline: ${baselineState.baselineReady ? 'ready' : 'learning'}`;
      }
    };

    const loadThreatState = async () => {
      const [latestBaseline, latestThreats] = await Promise.all([
        api.networkBaseline().catch(() => safeBaseline),
        api.networkThreats({ limit: 50 }).catch(() => safeThreatState),
      ]);
      applyThreatState(latestBaseline, latestThreats);
    };

    applyThreatState(safeBaseline, safeThreatState);

    threatContainer.querySelector('#net-threat-refresh')?.addEventListener('click', () => {
      loadThreatState().catch(() => {});
    });

    threatContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.net-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      if (!alertId) return;
      button.setAttribute('disabled', 'true');
      try {
        await api.acknowledgeNetworkThreat(alertId);
        await loadThreatState();
      } catch {
        button.removeAttribute('disabled');
      }
    });

    // Live event stream
    const sectionHeader1 = document.createElement('h3');
    sectionHeader1.className = 'section-header';
    sectionHeader1.textContent = 'Live Event Stream';
    panel.appendChild(sectionHeader1);

    const eventLogEl = createEventLog('Audit Events');
    panel.appendChild(eventLogEl);

    // Agent state grid
    const sectionHeader2 = document.createElement('h3');
    sectionHeader2.className = 'section-header';
    sectionHeader2.textContent = 'Agent States';
    panel.appendChild(sectionHeader2);

    const agentGridEl = document.createElement('div');
    agentGridEl.className = 'agent-grid';
    renderAgentGrid(agentGridEl, agents);
    panel.appendChild(agentGridEl);

    // Resource usage
    const sectionHeader3 = document.createElement('h3');
    sectionHeader3.className = 'section-header';
    sectionHeader3.textContent = 'Resource Usage';
    panel.appendChild(sectionHeader3);

    const budgetContainer = document.createElement('div');
    budgetContainer.className = 'table-container';
    budgetContainer.innerHTML = `
      <div class="table-header">
        <h3>Budget & Resources</h3>
        <span id="mon-pending-count" style="font-size:0.75rem;color:var(--text-muted);">EventBus pending: 0</span>
      </div>
      <table>
        <thead><tr><th>Agent</th><th>Tokens/min</th><th>Concurrent</th><th>Overruns</th></tr></thead>
        <tbody id="mon-budget-table-body"></tbody>
      </table>
    `;
    panel.appendChild(budgetContainer);

    const budgetTableBody = budgetContainer.querySelector('#mon-budget-table-body');
    const pendingCountEl = budgetContainer.querySelector('#mon-pending-count');
    budgetTableBody.innerHTML = budget.agents.map(a => `
      <tr>
        <td>${esc(a.agentId)}</td>
        <td>${a.tokensPerMinute}</td>
        <td>${a.concurrentInvocations}</td>
        <td>${a.overrunCount}</td>
      </tr>
    `).join('');

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
            <tr><td>Top agents</td><td>${analytics.topAgents.map(a => `${esc(a.agentId)} (${a.count})`).join(', ') || '-'}</td></tr>
            <tr><td>Top commands</td><td>${analytics.commandUsage.map(c => `/${esc(c.command)} (${c.count})`).join(', ') || '-'}</td></tr>
          </tbody>
        </table>
      `;
      panel.appendChild(analyticsSection);
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
      panel.appendChild(overrunContainer);
    }

    // SSE: live audit events
    monAuditHandler = (event) => {
      if (eventLogEl) appendEvent(eventLogEl, event);
    };
    onSSE('audit', monAuditHandler);

    monSecurityAlertHandler = async (alert) => {
      if (eventLogEl) {
        appendEvent(eventLogEl, {
          timestamp: alert?.timestamp || Date.now(),
          type: 'security_alert',
          severity: mapNetworkSeverityToAudit(alert?.severity),
          agentId: 'network-sentinel',
          details: {
            reason: alert?.description || 'Network threat detected',
          },
        });
      }
      await loadThreatState();
    };
    onSSE('security.alert', monSecurityAlertHandler);

    // SSE: metrics updates
    monMetricsHandler = (data) => {
      if (agentGridEl && data.agents) {
        renderAgentGrid(agentGridEl, data.agents);
      }
      if (pendingCountEl) {
        pendingCountEl.textContent = `EventBus pending: ${data.eventBusPending || 0}`;
      }
    };
    onSSE('metrics', monMetricsHandler);

  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
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

// ─── Threat Intel Tab ────────────────────────────────────

async function renderIntelTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [summary, plan, watchlistResponse, findings, actions] = await Promise.all([
      api.threatIntelSummary(),
      api.threatIntelPlan(),
      api.threatIntelWatchlist(),
      api.threatIntelFindings({ limit: 30 }),
      api.threatIntelActions(30),
    ]);

    const watchlist = watchlistResponse.targets ?? [];
    const connectorText = (summary.forumConnectors || [])
      .map(c => `${c.id}:${c.enabled ? 'on' : 'off'}:${c.mode}${c.hostile ? ':hostile' : ''}`)
      .join(', ');

    panel.innerHTML = `
      <div class="intel-summary-grid">
        <div class="status-card ${summary.enabled ? 'success' : 'error'}">
          <div class="card-title">Monitoring</div>
          <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Auto-scan active when watchlist is configured</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Watchlist</div>
          <div class="card-value">${summary.watchlistCount}</div>
          <div class="card-subtitle">Tracked people, handles, domains, keywords</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">New Findings</div>
          <div class="card-value">${summary.findings.new}</div>
          <div class="card-subtitle">${summary.findings.total} total findings</div>
        </div>
        <div class="status-card ${summary.findings.highOrCritical > 0 ? 'error' : 'accent'}">
          <div class="card-title">High Risk</div>
          <div class="card-value">${summary.findings.highOrCritical}</div>
          <div class="card-subtitle">High/Critical severity detections</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Operations Configuration</h3>
          <button class="btn btn-secondary" id="intel-refresh" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Refresh</button>
        </div>
        <div class="intel-controls" style="pointer-events: none; opacity: 0.8;">
          <div class="intel-control-row">
            <label>Response Mode</label>
            <span class="intel-inline">${esc(summary.responseMode)}</span>
            <span class="intel-muted">Darkweb scans: ${summary.darkwebEnabled ? 'enabled' : 'disabled'}</span>
            <span class="intel-muted">Forum connectors: ${esc(connectorText || 'none')}</span>
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Watchlist</h3></div>
        <div class="intel-watchlist-panel">
          <div class="intel-watch-items">
            ${watchlist.length === 0
              ? '<span class="intel-muted">No watch targets configured.</span>'
              : watchlist.map(target => `<span class="intel-chip">${esc(target)}</span>`).join('')}
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Findings</h3></div>
        <table>
          <thead>
            <tr><th>ID</th><th>Target</th><th>Source</th><th>Severity</th><th>Confidence</th><th>Status</th><th>Summary</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${findings.length === 0 ? '<tr><td colspan="8">No findings yet. Run a scan to populate results.</td></tr>' : findings.map(finding => `
              <tr>
                <td title="${esc(finding.id)}">${esc(shortId(finding.id))}</td>
                <td>${esc(finding.target)}</td>
                <td>${esc(finding.sourceType)}</td>
                <td><span class="badge ${severityClass(finding.severity)}">${esc(finding.severity)}</span></td>
                <td>${Math.round((finding.confidence ?? 0) * 100)}%</td>
                <td>
                  <select data-finding-status="${escAttr(finding.id)}">
                    ${['new', 'triaged', 'actioned', 'dismissed'].map(status => `
                      <option value="${status}" ${finding.status === status ? 'selected' : ''}>${status}</option>
                    `).join('')}
                  </select>
                </td>
                <td>${esc(finding.summary)}</td>
                <td>
                  <div class="intel-actions">
                    <button class="btn btn-secondary intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="report">Report</button>
                    <button class="btn btn-secondary intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="request_takedown">Takedown</button>
                    <button class="btn btn-secondary intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="draft_response">Draft Reply</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Drafted Actions</h3></div>
        <table>
          <thead>
            <tr><th>Action ID</th><th>Finding</th><th>Type</th><th>Status</th><th>Approval</th><th>Rationale</th></tr>
          </thead>
          <tbody>
            ${actions.length === 0 ? '<tr><td colspan="6">No drafted actions yet.</td></tr>' : actions.map(action => `
              <tr>
                <td title="${esc(action.id)}">${esc(shortId(action.id))}</td>
                <td title="${esc(action.findingId)}">${esc(shortId(action.findingId))}</td>
                <td>${esc(action.type)}</td>
                <td>${esc(action.status)}</td>
                <td>${action.requiresApproval ? 'required' : 'optional'}</td>
                <td>${esc(action.rationale)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Operating Plan</h3></div>
        <div class="intel-plan">
          <p class="intel-muted">${esc(plan.title)}</p>
          <div class="intel-plan-grid">
            ${plan.phases.map(phase => `
              <div class="intel-plan-card">
                <h4>${esc(phase.phase)}</h4>
                <p>${esc(phase.objective)}</p>
                <ul>
                  ${phase.deliverables.map(d => `<li>${esc(d)}</li>`).join('')}
                </ul>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // Event listeners
    panel.querySelector('#intel-refresh')?.addEventListener('click', () => renderIntelTab(panel));

    panel.querySelectorAll('[data-finding-status]').forEach(select => {
      select.addEventListener('change', async () => {
        const findingId = select.getAttribute('data-finding-status');
        if (!findingId) return;
        try {
          await api.threatIntelSetFindingStatus(findingId, select.value);
        } catch { /* ignore */ }
      });
    });

    panel.querySelectorAll('.intel-action-btn').forEach(button => {
      button.addEventListener('click', async () => {
        const findingId = button.getAttribute('data-finding');
        const type = button.getAttribute('data-action');
        if (!findingId || !type) return;
        try {
          const result = await api.threatIntelDraftAction(findingId, type);
          if (result.success) await renderIntelTab(panel);
        } catch { /* ignore */ }
      });
    });

    applyInputTooltips(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

// ─── Utilities ───────────────────────────────────────────

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function severityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'high') return 'badge-errored';
  if (severity === 'medium') return 'badge-warn';
  return 'badge-info';
}

function mapNetworkSeverityToAudit(severity) {
  if (severity === 'critical') return 'critical';
  if (severity === 'high' || severity === 'medium') return 'warn';
  return 'info';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(input) {
  return esc(input).replace(/"/g, '&quot;');
}
