/**
 * Security page — overview, unified alerts, audit, and threat intel.
 */

import { api } from '../api.js';
import { createStatusCard } from '../components/status-card.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createEventLog, appendEvent } from '../components/event-log.js';
import { createTabs } from '../components/tabs.js';
import { onSSE, offSSE } from '../app.js';
import { applyInputTooltips } from '../tooltip.js';

let auditHandler = null;
let monAuditHandler = null;
let monMetricsHandler = null;
let monSecurityAlertHandler = null;
let currentContainer = null;

const SECURITY_HELP = {
  overview: {
    'Security Domains': {
      whatItIs: 'This section shows where major security responsibilities live across the app.',
      whatSeeing: 'You are seeing alert ownership, cloud ownership, network ownership, and direct links into each destination.',
      whatCanDo: 'Use it to understand which page owns the next action before you drill further.',
      howLinks: 'It links Security, Cloud, and Network together without duplicating their full control planes.',
    },
    'Recent Security Activity': {
      whatItIs: 'This is the recent cross-domain activity feed for notable security events.',
      whatSeeing: 'You are seeing recent high-signal audit events such as denials, anomalies, host alerts, gateway alerts, and promoted automation findings.',
      whatCanDo: 'Scan for recent change, then move to Alerts or Audit depending on whether you need action or investigation.',
      howLinks: 'It bridges the summary view in Overview with the deeper queues in Alerts and Audit.',
    },
  },
  alerts: {
    'Unified Alert Queue': {
      whatItIs: 'This is the main operator queue for actionable security issues.',
      whatSeeing: 'You are seeing normalized alerts from network, host, gateway, cloud, policy, and automation sources in one place.',
      whatCanDo: 'Filter by source or severity, acknowledge supported alerts, and open linked automation runs when relevant.',
      howLinks: 'Alerts is the action surface; detailed evidence and history continue to live in Audit and the originating owner pages.',
    },
  },
  audit: {
    'Audit Chain Integrity': {
      whatItIs: 'This section verifies the tamper-evident audit chain.',
      whatSeeing: 'You are seeing a manual integrity check for the stored audit ledger.',
      whatCanDo: 'Run verification when you need confidence that the event history has not been altered.',
      howLinks: 'This supports trust in the Audit tab and any downstream investigation based on those events.',
    },
    'Audit Log': {
      whatItIs: 'This is the canonical historical ledger of security and policy events.',
      whatSeeing: 'You are seeing filterable audit events with timestamps, event types, controller context, and full detail payloads.',
      whatCanDo: 'Filter by event type, severity, or agent and expand rows for deeper investigation.',
      howLinks: 'Audit complements Alerts by preserving full history even when an event never became an active alert.',
    },
    'Top Denied Agents': {
      whatItIs: 'This is a short summary of which agents are most often blocked by policy.',
      whatSeeing: 'You are seeing the agents with the highest denial counts over the current summary window.',
      whatCanDo: 'Use it to identify noisy automations, misconfigured routing, or overly aggressive agent behavior.',
      howLinks: 'It helps explain patterns you see in the Audit log and policy-related alerts.',
    },
  },
  intel: {
    'Operations Configuration': {
      whatItIs: 'This section summarizes the active threat-intel operating mode.',
      whatSeeing: 'You are seeing response mode, darkweb status, and forum connector posture.',
      whatCanDo: 'Refresh the page and confirm how aggressive the threat-intel workflow is configured to be.',
      howLinks: 'It provides the policy context for the watchlist, findings, and drafted actions below.',
    },
    Watchlist: {
      whatItIs: 'This is the set of monitored targets for threat-intel scanning.',
      whatSeeing: 'You are seeing people, handles, brands, domains, or phrases currently under watch.',
      whatCanDo: 'Review coverage and confirm the monitored set before interpreting findings.',
      howLinks: 'Watchlist entries feed the Findings and Drafted Actions sections.',
    },
    Findings: {
      whatItIs: 'This section contains the current threat-intel detections.',
      whatSeeing: 'You are seeing findings with severity, confidence, status, and action shortcuts.',
      whatCanDo: 'Triages findings, update their status, and draft follow-up actions.',
      howLinks: 'Findings drive drafted actions and inform the operating plan.',
    },
    'Drafted Actions': {
      whatItIs: 'This is the queue of generated follow-up actions for threat-intel findings.',
      whatSeeing: 'You are seeing response, reporting, or takedown drafts along with approval posture.',
      whatCanDo: 'Review what actions have been drafted and whether they need approval.',
      howLinks: 'These actions are downstream of Findings and should be evaluated against the Operating Plan.',
    },
    'Operating Plan': {
      whatItIs: 'This section outlines the current phased response plan for threat-intel work.',
      whatSeeing: 'You are seeing the plan title, objectives, and deliverables by phase.',
      whatCanDo: 'Use it to align triage and response work with the intended operating sequence.',
      howLinks: 'It gives broader context for how Watchlist items, Findings, and Actions should be handled.',
    },
  },
};

function cleanupSSE() {
  if (auditHandler) { offSSE('audit', auditHandler); auditHandler = null; }
  if (monAuditHandler) { offSSE('audit', monAuditHandler); monAuditHandler = null; }
  if (monMetricsHandler) { offSSE('metrics', monMetricsHandler); monMetricsHandler = null; }
  if (monSecurityAlertHandler) { offSSE('security.alert', monSecurityAlertHandler); monSecurityAlertHandler = null; }
}

export async function renderSecurity(container, options = {}) {
  currentContainer = container;
  cleanupSSE();
  container.innerHTML = `
    <h2 class="page-title">Security</h2>
    ${renderGuidancePanel({
      kicker: 'Security Guide',
      title: 'Investigation, triage, and evidence',
      whatItIs: 'Security is the canonical home for alert triage, audit review, and threat-intel investigation.',
      whatSeeing: 'You are seeing tabs for posture overview, the active alert queue, the historical audit ledger, and threat-intel operations.',
      whatCanDo: 'Use Alerts for action now, Audit for full history and verification, Overview for posture, and Threat Intel for monitoring and response planning.',
      howLinks: 'Security receives normalized signals from Network, Cloud, policy, and automations, while deep operational edits stay on the owner pages.',
    })}
  `;

  createTabs(container, [
    { id: 'overview', label: 'Overview', render: renderOverviewTab },
    { id: 'alerts', label: 'Alerts', render: renderAlertsTab },
    { id: 'audit', label: 'Audit', render: renderAuditTab },
    { id: 'intel', label: 'Threat Intel', render: renderIntelTab },
  ], normalizeSecurityTab(options?.tab));
}

export async function updateSecurity() {
  if (!currentContainer) return;
  const activeTab = currentContainer.dataset.activeTab;
  await renderSecurity(currentContainer, activeTab ? { tab: activeTab } : {});
}

function normalizeSecurityTab(tab) {
  if (tab === 'monitoring') return 'overview';
  if (tab === 'cloud') return 'overview';
  return tab || 'overview';
}

async function renderOverviewTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [networkThreats, hostAlerts, gatewayAlerts, config, auditEvents] = await Promise.all([
      api.networkThreats({ limit: 20 }).catch(() => ({ alerts: [], activeAlertCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } })),
      api.hostMonitorAlerts({ limit: 20 }).catch(() => ({ alerts: [], activeAlertCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } })),
      api.gatewayMonitorAlerts({ limit: 20 }).catch(() => ({ alerts: [], activeAlertCount: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } })),
      api.config().catch(() => ({})),
      api.audit({ limit: 100 }).catch(() => []),
    ]);

    const cloud = config?.assistant?.tools?.cloud || { profileCounts: { total: 0 }, enabled: false };
    const cloudEvents = (auditEvents || []).filter(isCloudAuditEvent);
    const notableAudit = (auditEvents || [])
      .filter((event) => ['action_denied', 'secret_detected', 'anomaly_detected', 'host_alert', 'gateway_alert', 'automation_finding'].includes(event.type))
      .slice(0, 12);

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Overview',
        compact: true,
        whatItIs: 'Overview is the posture summary for the major security domains.',
        whatSeeing: 'You are seeing high-level counts for network, host, gateway, and cloud-adjacent activity plus a short security activity feed.',
        whatCanDo: 'Use it to decide whether to move into Alerts for triage or Audit for detail.',
        howLinks: 'This tab summarizes domain state without replacing the owner queues in Alerts, Cloud, or Network.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card ${networkThreats.activeAlertCount > 0 ? 'warning' : 'success'}">
          <div class="card-title">Network Alerts</div>
          <div class="card-value">${networkThreats.activeAlertCount || 0}</div>
          <div class="card-subtitle">${networkThreats.bySeverity?.critical || 0} critical</div>
        </div>
        <div class="status-card ${hostAlerts.activeAlertCount > 0 ? 'warning' : 'success'}">
          <div class="card-title">Host Alerts</div>
          <div class="card-value">${hostAlerts.activeAlertCount || 0}</div>
          <div class="card-subtitle">${hostAlerts.bySeverity?.critical || 0} critical</div>
        </div>
        <div class="status-card ${gatewayAlerts.activeAlertCount > 0 ? 'warning' : 'success'}">
          <div class="card-title">Gateway Alerts</div>
          <div class="card-value">${gatewayAlerts.activeAlertCount || 0}</div>
          <div class="card-subtitle">${gatewayAlerts.bySeverity?.critical || 0} critical</div>
        </div>
        <div class="status-card ${cloudEvents.length > 0 ? 'info' : 'accent'}">
          <div class="card-title">Cloud Activity</div>
          <div class="card-value">${cloudEvents.length}</div>
          <div class="card-subtitle">${cloud.profileCounts?.total || 0} cloud profiles</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Security Domains</h3></div>
        <table>
          <thead><tr><th>Domain</th><th>Current State</th><th>Owner</th><th>Next Action</th></tr></thead>
          <tbody>
            <tr><td>Alerts</td><td>${(networkThreats.activeAlertCount || 0) + (hostAlerts.activeAlertCount || 0) + (gatewayAlerts.activeAlertCount || 0)} active</td><td>Security</td><td><a href="#/security?tab=alerts">Open unified alert queue</a></td></tr>
            <tr><td>Cloud</td><td>${cloud.enabled ? 'Enabled' : 'Disabled'} · ${cloud.profileCounts?.total || 0} profiles</td><td>Cloud</td><td><a href="#/cloud">Open cloud hub</a></td></tr>
            <tr><td>Network Operations</td><td>${networkThreats.activeAlertCount || 0} alerts</td><td>Network</td><td><a href="#/network">Open network tools</a></td></tr>
            <tr><td>Threat Intel</td><td>Watchlist and findings available</td><td>Security</td><td><a href="#/security?tab=intel">Open threat intel</a></td></tr>
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Security Activity</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Source</th><th>Detail</th></tr></thead>
          <tbody>
            ${notableAudit.length === 0
              ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No recent security activity.</td></tr>'
              : notableAudit.map((event) => `
                <tr>
                  <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
                  <td>${esc(event.type)}</td>
                  <td><span class="badge ${auditSeverityClass(event.severity)}">${esc(event.severity)}</span></td>
                  <td>${esc(event.details?.source || event.details?.toolName || event.controller || '-')}</td>
                  <td>${esc(event.details?.description || event.details?.reason || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
    enhanceSectionHelp(panel, SECURITY_HELP.overview, createGenericHelpFactory('Security Overview'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderAlertsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [networkThreats, hostAlerts, gatewayAlerts, auditEvents] = await Promise.all([
      api.networkThreats({ limit: 100 }).catch(() => ({ alerts: [] })),
      api.hostMonitorAlerts({ limit: 100 }).catch(() => ({ alerts: [] })),
      api.gatewayMonitorAlerts({ limit: 100 }).catch(() => ({ alerts: [] })),
      api.audit({ limit: 200 }).catch(() => []),
    ]);

    const rows = [
      ...(networkThreats.alerts || []).map((alert) => ({
        id: alert.id,
        source: 'network',
        timestamp: alert.lastSeenAt || alert.timestamp || Date.now(),
        severity: mapNetworkSeverityToAudit(alert.severity),
        title: alert.type,
        subject: alert.ip || alert.mac || '-',
        detail: alert.description || '-',
        ackType: 'network',
      })),
      ...(hostAlerts.alerts || []).map((alert) => ({
        id: alert.id,
        source: 'host',
        timestamp: alert.lastSeenAt || alert.timestamp || Date.now(),
        severity: mapNetworkSeverityToAudit(alert.severity),
        title: alert.type,
        subject: alert.evidence?.path || alert.evidence?.name || alert.evidence?.remoteAddress || '-',
        detail: alert.description || '-',
        ackType: 'host',
      })),
      ...(gatewayAlerts.alerts || []).map((alert) => ({
        id: alert.id,
        source: 'gateway',
        timestamp: alert.lastSeenAt || alert.timestamp || Date.now(),
        severity: mapNetworkSeverityToAudit(alert.severity),
        title: alert.type,
        subject: alert.targetName || alert.targetId || '-',
        detail: alert.description || '-',
        ackType: 'gateway',
      })),
      ...(auditEvents || [])
        .filter((event) => isCloudAuditEvent(event))
        .map((event) => ({
          id: `cloud-${event.timestamp}-${event.type}`,
          source: 'cloud',
          timestamp: event.timestamp,
          severity: event.severity || 'info',
          title: event.type,
          subject: event.details?.toolName || '-',
          detail: event.details?.reason || event.details?.source || '-',
          ackType: '',
        })),
      ...(auditEvents || [])
        .filter((event) => ['action_denied', 'secret_detected', 'policy_changed', 'anomaly_detected'].includes(event.type))
        .map((event) => ({
          id: `policy-${event.timestamp}-${event.type}`,
          source: 'tool/policy',
          timestamp: event.timestamp,
          severity: event.severity || 'info',
          title: event.type,
          subject: event.details?.toolName || event.agentId || '-',
          detail: event.details?.reason || event.details?.description || '-',
          ackType: '',
        })),
      ...(auditEvents || [])
        .filter((event) => isAutomationAuditEvent(event))
        .map((event) => ({
          id: event.id || `automation-${event.timestamp}`,
          source: 'automation',
          timestamp: event.timestamp,
          severity: event.severity || 'info',
          title: event.details?.title || 'Automation finding',
          subject: event.details?.automationName || event.details?.automationId || '-',
          detail: event.details?.description || '-',
          ackType: '',
          href: event.details?.runLink || '',
          actionLabel: 'Open run',
        })),
    ]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 200);

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Alerts',
        compact: true,
        whatItIs: 'Alerts is the active queue for security items that may need operator action.',
        whatSeeing: 'You are seeing normalized alert rows from multiple sources with shared filtering.',
        whatCanDo: 'Filter, acknowledge supported alerts, and follow linked rows back to the originating run or owner system.',
        howLinks: 'This is the action queue, while Audit remains the durable ledger of everything that happened.',
      })}
      <div class="filters">
        <label>Source:</label>
        <select id="security-alert-source">
          <option value="">All</option>
          <option value="network">Network</option>
          <option value="host">Host</option>
          <option value="gateway">Gateway</option>
          <option value="cloud">Cloud</option>
          <option value="tool/policy">Tool/Policy</option>
          <option value="automation">Automation</option>
        </select>
        <label>Severity:</label>
        <select id="security-alert-severity">
          <option value="">All</option>
          <option value="critical">Critical</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
        </select>
        <button class="btn btn-secondary" id="security-alert-refresh">Refresh</button>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Unified Alert Queue</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Source</th><th>Title</th><th>Severity</th><th>Subject</th><th>Detail</th><th>Action</th></tr></thead>
          <tbody id="security-alerts-body"></tbody>
        </table>
      </div>
    `;

    const bodyEl = panel.querySelector('#security-alerts-body');
    const sourceEl = panel.querySelector('#security-alert-source');
    const severityEl = panel.querySelector('#security-alert-severity');

    const renderRows = () => {
      const source = sourceEl?.value || '';
      const severity = severityEl?.value || '';
      const filtered = rows.filter((row) => (!source || row.source === source) && (!severity || row.severity === severity));
      bodyEl.innerHTML = filtered.length === 0
        ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No alerts match the current filters.</td></tr>'
        : filtered.map((row) => `
          <tr>
            <td>${new Date(row.timestamp).toLocaleTimeString()}</td>
            <td>${esc(row.source)}</td>
            <td>${esc(row.title)}</td>
            <td><span class="badge ${auditSeverityClass(row.severity)}">${esc(row.severity)}</span></td>
            <td>${esc(row.subject)}</td>
            <td title="${escAttr(row.detail)}">${esc(row.detail)}</td>
            <td>
              ${row.ackType
                ? `<button class="btn btn-secondary btn-sm security-alert-ack" data-alert-id="${escAttr(row.id)}" data-ack-type="${escAttr(row.ackType)}">Acknowledge</button>`
                : row.href
                  ? `<a class="btn btn-secondary btn-sm" href="${escAttr(row.href)}">${esc(row.actionLabel || 'Open')}</a>`
                : '<span style="color:var(--text-muted)">Audit only</span>'}
            </td>
          </tr>
        `).join('');
    };

    renderRows();

    sourceEl?.addEventListener('change', renderRows);
    severityEl?.addEventListener('change', renderRows);
    panel.querySelector('#security-alert-refresh')?.addEventListener('click', () => renderAlertsTab(panel));
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, SECURITY_HELP.alerts, createGenericHelpFactory('Security Alerts'));
    activateContextHelp(panel);

    bodyEl.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.security-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      const ackType = button.getAttribute('data-ack-type');
      if (!alertId || !ackType) return;
      button.setAttribute('disabled', 'true');
      try {
        if (ackType === 'network') await api.acknowledgeNetworkThreat(alertId);
        else if (ackType === 'host') await api.acknowledgeHostMonitorAlert(alertId);
        else if (ackType === 'gateway') await api.acknowledgeGatewayMonitorAlert(alertId);
        await renderAlertsTab(panel);
      } catch {
        button.removeAttribute('disabled');
      }
    });
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

// ─── Audit Tab ────────────────────────────────────────────

async function renderAuditTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const summary = await api.auditSummary(300000);
    panel.innerHTML = renderGuidancePanel({
      kicker: 'Audit',
      compact: true,
      whatItIs: 'Audit is the full historical ledger for security, policy, and promoted automation events.',
      whatSeeing: 'You are seeing summary cards, chain verification, a filterable event log, and denial summaries.',
      whatCanDo: 'Use it to verify integrity, investigate what happened, and review the evidence behind alerts or policy decisions.',
      howLinks: 'Audit preserves full context for current alerts and for events that never surfaced in the active alert queue.',
    });

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
        <option value="host_alert">host_alert</option>
        <option value="gateway_alert">gateway_alert</option>
        <option value="agent_error">agent_error</option>
        <option value="agent_stalled">agent_stalled</option>
        <option value="automation_finding">automation_finding</option>
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
    enhanceSectionHelp(panel, SECURITY_HELP.audit, createGenericHelpFactory('Security Audit'));
    activateContextHelp(panel);

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
  const preview = summarize(event.details);
  const fullDetails = formatAuditDetails(event.details);
  tr.innerHTML = `
    <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
    <td>${esc(event.type)}</td>
    <td><span class="badge badge-${event.severity}">${esc(event.severity)}</span></td>
    <td>${esc(event.agentId)}</td>
    <td>${esc(event.controller || '-')}</td>
    <td>
      <details class="audit-details">
        <summary>${esc(preview)}</summary>
        <pre>${esc(fullDetails)}</pre>
      </details>
    </td>
  `;
  return tr;
}

function summarize(details) {
  if (!details) return '-';
  if (details.reason) return String(details.reason);
  if (details.error) return String(details.error);
  if (details.description) return String(details.description);
  const json = JSON.stringify(details);
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}

function formatAuditDetails(details) {
  if (!details) return '-';
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

// ─── Monitoring Tab ──────────────────────────────────────

async function renderMonitoringTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [agents, budget, analytics, baseline, threatState, hostStatus, hostAlerts, gatewayStatus, gatewayAlerts] = await Promise.all([
      api.agents().catch(() => []),
      api.budget().catch(() => ({ agents: [], recentOverruns: [] })),
      api.analyticsSummary(3600000).catch(() => null),
      api.networkBaseline().catch(() => null),
      api.networkThreats({ limit: 50 }).catch(() => null),
      api.hostMonitorStatus().catch(() => null),
      api.hostMonitorAlerts({ limit: 50 }).catch(() => null),
      api.gatewayMonitorStatus().catch(() => null),
      api.gatewayMonitorAlerts({ limit: 50 }).catch(() => null),
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
    const safeHostStatus = hostStatus || {
      platform: 'unknown',
      enabled: false,
      baselineReady: false,
      lastUpdatedAt: 0,
      snapshot: {
        processCount: 0,
        suspiciousProcesses: [],
        persistenceEntryCount: 0,
        watchedPathCount: 0,
        knownExternalDestinationCount: 0,
        listeningPortCount: 0,
        firewallBackend: 'unavailable',
        firewallEnabled: null,
        firewallRuleCount: 0,
      },
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    };
    const safeHostAlerts = hostAlerts || {
      alerts: [],
      activeAlertCount: 0,
      bySeverity: safeHostStatus.bySeverity,
      baselineReady: safeHostStatus.baselineReady,
      lastUpdatedAt: safeHostStatus.lastUpdatedAt,
    };
    const safeGatewayStatus = gatewayStatus || {
      enabled: false,
      baselineReady: false,
      lastUpdatedAt: 0,
      monitorCount: 0,
      availableGatewayCount: 0,
      gateways: [],
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    };
    const safeGatewayAlerts = gatewayAlerts || {
      alerts: [],
      activeAlertCount: 0,
      bySeverity: safeGatewayStatus.bySeverity,
      baselineReady: safeGatewayStatus.baselineReady,
      lastUpdatedAt: safeGatewayStatus.lastUpdatedAt,
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

    const hostSectionHeader = document.createElement('h3');
    hostSectionHeader.className = 'section-header';
    hostSectionHeader.textContent = 'Host Monitor Posture';
    panel.appendChild(hostSectionHeader);

    const hostGrid = document.createElement('div');
    hostGrid.className = 'cards-grid';
    panel.appendChild(hostGrid);

    const hostContainer = document.createElement('div');
    hostContainer.className = 'table-container';
    hostContainer.innerHTML = `
      <div class="table-header">
        <h3>Active Host Alerts</h3>
        <div>
          <span id="host-monitor-meta" style="font-size:0.8rem;color:var(--text-muted);margin-right:0.75rem;"></span>
          <button class="btn btn-secondary" id="host-monitor-refresh">Refresh</button>
          <button class="btn btn-primary" id="host-monitor-check">Run Check</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Evidence</th><th>Details</th><th>Action</th></tr></thead>
        <tbody id="host-monitor-table-body"></tbody>
      </table>
    `;
    panel.appendChild(hostContainer);

    const hostMetaEl = hostContainer.querySelector('#host-monitor-meta');
    const hostTableBody = hostContainer.querySelector('#host-monitor-table-body');

    const renderHostCards = (status, alertState) => {
      hostGrid.innerHTML = '';
      hostGrid.appendChild(createStatusCard(
        'Host Monitor',
        status.enabled ? 'Enabled' : 'Disabled',
        `${String(status.platform).toUpperCase()} • ${status.baselineReady ? 'baseline ready' : 'learning'}`,
        status.enabled ? 'success' : 'warning',
      ));
      hostGrid.appendChild(createStatusCard(
        'Active Host Alerts',
        alertState.activeAlertCount || 0,
        `${alertState.bySeverity?.critical ?? 0} critical / ${alertState.bySeverity?.high ?? 0} high`,
        (alertState.bySeverity?.critical ?? 0) > 0 ? 'error' : (alertState.bySeverity?.high ?? 0) > 0 ? 'warning' : 'success',
      ));
      hostGrid.appendChild(createStatusCard(
        'Suspicious Processes',
        status.snapshot?.suspiciousProcesses?.length || 0,
        `${status.snapshot?.processCount || 0} total processes sampled`,
        (status.snapshot?.suspiciousProcesses?.length || 0) > 0 ? 'warning' : 'info',
      ));
      hostGrid.appendChild(createStatusCard(
        'Watched Paths',
        status.snapshot?.watchedPathCount || 0,
        `${status.snapshot?.persistenceEntryCount || 0} persistence entries • ${status.snapshot?.knownExternalDestinationCount || 0} remotes`,
        'info',
      ));
      hostGrid.appendChild(createStatusCard(
        'Host Firewall',
        status.snapshot?.firewallEnabled === true ? 'Enabled' : status.snapshot?.firewallEnabled === false ? 'Alert' : 'Unknown',
        `${status.snapshot?.firewallBackend || 'unavailable'} • ${status.snapshot?.firewallRuleCount || 0} rules`,
        status.snapshot?.firewallEnabled === false ? 'error' : status.snapshot?.firewallEnabled === true ? 'success' : 'warning',
      ));
    };

    const summarizeHostEvidence = (alert) => {
      if (!alert?.evidence) return '-';
      if (typeof alert.evidence.path === 'string') return alert.evidence.path;
      if (typeof alert.evidence.entry === 'string') return alert.evidence.entry;
      if (typeof alert.evidence.remoteAddress === 'string') return alert.evidence.remoteAddress;
      if (typeof alert.evidence.port === 'number') return `port ${alert.evidence.port}`;
      if (typeof alert.evidence.name === 'string') return alert.evidence.name;
      if (typeof alert.evidence.backend === 'string') return `${alert.evidence.backend}`;
      if (typeof alert.evidence.summary === 'string') return alert.evidence.summary;
      return '-';
    };

    const renderHostRows = (alerts) => {
      if (!hostTableBody) return;
      if (!alerts || alerts.length === 0) {
        hostTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active host alerts.</td></tr>';
        return;
      }
      hostTableBody.innerHTML = alerts.map((alert) => `
        <tr>
          <td>${new Date(alert.lastSeenAt || alert.timestamp || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
          <td>${esc(alert.type)}</td>
          <td title="${escAttr(JSON.stringify(alert.evidence || {}))}">${esc(summarizeHostEvidence(alert))}</td>
          <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
          <td><button class="btn btn-secondary host-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
        </tr>
      `).join('');
    };

    const applyHostState = (status, alertState) => {
      renderHostCards(status, alertState);
      renderHostRows(alertState.alerts || []);
      if (hostMetaEl) {
        const updated = alertState.lastUpdatedAt || status.lastUpdatedAt;
        hostMetaEl.textContent = `Baseline: ${status.baselineReady ? 'ready' : 'learning'} • Updated: ${updated ? new Date(updated).toLocaleTimeString() : 'never'}`;
      }
    };

    const loadHostState = async () => {
      const [latestStatus, latestAlerts] = await Promise.all([
        api.hostMonitorStatus().catch(() => safeHostStatus),
        api.hostMonitorAlerts({ limit: 50 }).catch(() => safeHostAlerts),
      ]);
      applyHostState(latestStatus, latestAlerts);
    };

    applyHostState(safeHostStatus, safeHostAlerts);

    hostContainer.querySelector('#host-monitor-refresh')?.addEventListener('click', () => {
      loadHostState().catch(() => {});
    });

    hostContainer.querySelector('#host-monitor-check')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      try {
        await api.runHostMonitorCheck();
        await loadHostState();
      } catch {
        button.disabled = false;
        return;
      }
      button.disabled = false;
    });

    hostContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.host-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      if (!alertId) return;
      button.setAttribute('disabled', 'true');
      try {
        await api.acknowledgeHostMonitorAlert(alertId);
        await loadHostState();
      } catch {
        button.removeAttribute('disabled');
      }
    });

    const gatewaySectionHeader = document.createElement('h3');
    gatewaySectionHeader.className = 'section-header';
    gatewaySectionHeader.textContent = 'Gateway Firewall Posture';
    panel.appendChild(gatewaySectionHeader);

    const gatewayGrid = document.createElement('div');
    gatewayGrid.className = 'cards-grid';
    panel.appendChild(gatewayGrid);

    const gatewayContainer = document.createElement('div');
    gatewayContainer.className = 'table-container';
    gatewayContainer.innerHTML = `
      <div class="table-header">
        <h3>Active Gateway Alerts</h3>
        <div>
          <span id="gateway-monitor-meta" style="font-size:0.8rem;color:var(--text-muted);margin-right:0.75rem;"></span>
          <button class="btn btn-secondary" id="gateway-monitor-refresh">Refresh</button>
          <button class="btn btn-primary" id="gateway-monitor-check">Run Check</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Severity</th><th>Gateway</th><th>Type</th><th>Details</th><th>Action</th></tr></thead>
        <tbody id="gateway-monitor-table-body"></tbody>
      </table>
    `;
    panel.appendChild(gatewayContainer);

    const gatewayMetaEl = gatewayContainer.querySelector('#gateway-monitor-meta');
    const gatewayTableBody = gatewayContainer.querySelector('#gateway-monitor-table-body');

    const renderGatewayCards = (status, alertState) => {
      gatewayGrid.innerHTML = '';
      gatewayGrid.appendChild(createStatusCard(
        'Gateway Monitors',
        status.monitorCount || 0,
        `${status.availableGatewayCount || 0} reachable`,
        (status.availableGatewayCount || 0) > 0 ? 'info' : 'warning',
      ));
      gatewayGrid.appendChild(createStatusCard(
        'Gateway Alerts',
        alertState.activeAlertCount || 0,
        `${alertState.bySeverity?.critical ?? 0} critical / ${alertState.bySeverity?.high ?? 0} high`,
        (alertState.bySeverity?.critical ?? 0) > 0 ? 'error' : (alertState.bySeverity?.high ?? 0) > 0 ? 'warning' : 'success',
      ));
      const firstGateway = status.gateways?.[0];
      gatewayGrid.appendChild(createStatusCard(
        'Primary WAN Policy',
        firstGateway?.wanDefaultAction || 'unknown',
        firstGateway ? `${firstGateway.displayName} • ${firstGateway.provider}` : 'No gateway snapshot',
        firstGateway?.wanDefaultAction === 'allow' ? 'warning' : 'info',
      ));
      gatewayGrid.appendChild(createStatusCard(
        'Port Forwards',
        status.gateways?.reduce((sum, gateway) => sum + (gateway.portForwardCount || 0), 0) || 0,
        status.gateways?.map((gateway) => `${gateway.displayName}: ${gateway.portForwardCount || 0}`).join(' • ') || 'No gateway snapshot',
        'info',
      ));
    };

    const summarizeGatewayAlert = (alert) => {
      if (typeof alert?.evidence?.gatewayName === 'string') return alert.evidence.gatewayName;
      if (typeof alert?.evidence?.gatewayId === 'string') return alert.evidence.gatewayId;
      if (typeof alert?.targetName === 'string') return alert.targetName;
      return '-';
    };

    const renderGatewayRows = (alerts) => {
      if (!gatewayTableBody) return;
      if (!alerts || alerts.length === 0) {
        gatewayTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active gateway alerts.</td></tr>';
        return;
      }
      gatewayTableBody.innerHTML = alerts.map((alert) => `
        <tr>
          <td>${new Date(alert.lastSeenAt || alert.timestamp || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
          <td>${esc(summarizeGatewayAlert(alert))}</td>
          <td>${esc(alert.type)}</td>
          <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
          <td><button class="btn btn-secondary gateway-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
        </tr>
      `).join('');
    };

    const applyGatewayState = (status, alertState) => {
      renderGatewayCards(status, alertState);
      renderGatewayRows(alertState.alerts || []);
      if (gatewayMetaEl) {
        gatewayMetaEl.textContent = `Baseline: ${status.baselineReady ? 'ready' : 'learning'} • Updated: ${status.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleTimeString() : 'never'}`;
      }
    };

    const loadGatewayState = async () => {
      const [latestStatus, latestAlerts] = await Promise.all([
        api.gatewayMonitorStatus().catch(() => safeGatewayStatus),
        api.gatewayMonitorAlerts({ limit: 50 }).catch(() => safeGatewayAlerts),
      ]);
      applyGatewayState(latestStatus, latestAlerts);
    };

    applyGatewayState(safeGatewayStatus, safeGatewayAlerts);

    gatewayContainer.querySelector('#gateway-monitor-refresh')?.addEventListener('click', () => {
      loadGatewayState().catch(() => {});
    });

    gatewayContainer.querySelector('#gateway-monitor-check')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      try {
        await api.runGatewayMonitorCheck();
        await loadGatewayState();
      } catch {
        button.disabled = false;
        return;
      }
      button.disabled = false;
    });

    gatewayContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.gateway-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      if (!alertId) return;
      button.setAttribute('disabled', 'true');
      try {
        await api.acknowledgeGatewayMonitorAlert(alertId);
        await loadGatewayState();
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
      const description = alert?.description || alert?.details?.reason || 'Security alert detected';
      const severity = alert?.severity || 'warn';
      if (eventLogEl) {
        appendEvent(eventLogEl, {
          timestamp: alert?.timestamp || Date.now(),
          type: 'security_alert',
          severity: mapNetworkSeverityToAudit(severity),
          agentId: alert?.agentId || 'security-monitor',
          details: {
            reason: description,
          },
        });
      }
      await Promise.all([
        loadThreatState(),
        loadHostState(),
        loadGatewayState(),
      ]);
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

// ─── Cloud Tab ──────────────────────────────────────────

async function renderCloudTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [config, auditEvents] = await Promise.all([
      api.config(),
      api.audit({ limit: 200 }).catch(() => []),
    ]);
    const cloud = config.assistant?.tools?.cloud || {
      enabled: false,
      cpanelProfiles: [],
      vercelProfiles: [],
      cloudflareProfiles: [],
      awsProfiles: [],
      gcpProfiles: [],
      azureProfiles: [],
      profileCounts: { cpanel: 0, vercel: 0, cloudflare: 0, aws: 0, gcp: 0, azure: 0, total: 0 },
      security: {
        inlineSecretProfileCount: 0,
        credentialRefCount: 0,
        selfSignedProfileCount: 0,
        customEndpointProfileCount: 0,
      },
    };

    const providerRows = [
      {
        provider: 'cPanel / WHM',
        count: cloud.cpanelProfiles.length,
        inline: cloud.cpanelProfiles.filter((profile) => profile.apiTokenConfigured).length,
        refs: cloud.cpanelProfiles.filter((profile) => !!profile.credentialRef).length,
        customEndpoints: 0,
        notes: cloud.cpanelProfiles.filter((profile) => profile.allowSelfSigned).length
          ? `${cloud.cpanelProfiles.filter((profile) => profile.allowSelfSigned).length} self-signed`
          : '-',
      },
      {
        provider: 'Vercel',
        count: cloud.vercelProfiles.length,
        inline: cloud.vercelProfiles.filter((profile) => profile.apiTokenConfigured).length,
        refs: cloud.vercelProfiles.filter((profile) => !!profile.credentialRef).length,
        customEndpoints: cloud.vercelProfiles.filter((profile) => !!profile.apiBaseUrl).length,
        notes: '-',
      },
      {
        provider: 'Cloudflare',
        count: cloud.cloudflareProfiles.length,
        inline: cloud.cloudflareProfiles.filter((profile) => profile.apiTokenConfigured).length,
        refs: cloud.cloudflareProfiles.filter((profile) => !!profile.credentialRef).length,
        customEndpoints: cloud.cloudflareProfiles.filter((profile) => !!profile.apiBaseUrl).length,
        notes: '-',
      },
      {
        provider: 'AWS',
        count: cloud.awsProfiles.length,
        inline: cloud.awsProfiles.filter((profile) => profile.accessKeyIdConfigured || profile.secretAccessKeyConfigured || profile.sessionTokenConfigured).length,
        refs: cloud.awsProfiles.filter((profile) => !!profile.accessKeyIdCredentialRef || !!profile.secretAccessKeyCredentialRef || !!profile.sessionTokenCredentialRef).length,
        customEndpoints: cloud.awsProfiles.filter((profile) => profile.endpoints && Object.keys(profile.endpoints).length > 0).length,
        notes: '-',
      },
      {
        provider: 'GCP',
        count: cloud.gcpProfiles.length,
        inline: cloud.gcpProfiles.filter((profile) => profile.accessTokenConfigured || profile.serviceAccountConfigured).length,
        refs: cloud.gcpProfiles.filter((profile) => !!profile.accessTokenCredentialRef || !!profile.serviceAccountCredentialRef).length,
        customEndpoints: cloud.gcpProfiles.filter((profile) => profile.endpoints && Object.keys(profile.endpoints).length > 0).length,
        notes: '-',
      },
      {
        provider: 'Azure',
        count: cloud.azureProfiles.length,
        inline: cloud.azureProfiles.filter((profile) => profile.accessTokenConfigured || profile.clientIdConfigured || profile.clientSecretConfigured).length,
        refs: cloud.azureProfiles.filter((profile) => !!profile.accessTokenCredentialRef || !!profile.clientIdCredentialRef || !!profile.clientSecretCredentialRef).length,
        customEndpoints: cloud.azureProfiles.filter((profile) => (profile.endpoints && Object.keys(profile.endpoints).length > 0) || !!profile.blobBaseUrl).length,
        notes: '-',
      },
    ];
    const activeProviders = providerRows.filter((row) => row.count > 0).length;
    const cloudEvents = (auditEvents || []).filter(isCloudAuditEvent).slice(0, 40);
    const deniedCount = cloudEvents.filter((event) => event.type === 'action_denied').length;

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Threat Intel',
        compact: true,
        whatItIs: 'Threat Intel is the monitored-target and response-planning workspace.',
        whatSeeing: 'You are seeing watch targets, findings, drafted actions, and the current operating plan.',
        whatCanDo: 'Review monitored targets, update finding status, and generate follow-up actions from detections.',
        howLinks: 'This tab is separate from the alert queue because it handles longer-running monitoring and response workflows.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card ${cloud.enabled ? 'success' : 'error'}">
          <div class="card-title">Cloud Controls</div>
          <div class="card-value">${cloud.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">${activeProviders} provider families configured</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Profiles</div>
          <div class="card-value">${cloud.profileCounts?.total || 0}</div>
          <div class="card-subtitle">Across cPanel, Vercel, Cloudflare, AWS, GCP, and Azure</div>
        </div>
        <div class="status-card ${cloud.security?.inlineSecretProfileCount ? 'warning' : 'success'}">
          <div class="card-title">Inline Secret Usage</div>
          <div class="card-value">${cloud.security?.inlineSecretProfileCount || 0}</div>
          <div class="card-subtitle">${cloud.security?.credentialRefCount || 0} credential refs configured</div>
        </div>
        <div class="status-card ${cloud.security?.selfSignedProfileCount ? 'warning' : 'accent'}">
          <div class="card-title">TLS Exceptions</div>
          <div class="card-value">${cloud.security?.selfSignedProfileCount || 0}</div>
          <div class="card-subtitle">Profiles accepting self-signed certs</div>
        </div>
        <div class="status-card ${deniedCount > 0 ? 'warning' : 'info'}">
          <div class="card-title">Recent Cloud Denials</div>
          <div class="card-value">${deniedCount}</div>
          <div class="card-subtitle">${cloudEvents.length} recent cloud-related audit events</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Provider Posture</h3></div>
        <table>
          <thead><tr><th>Provider</th><th>Profiles</th><th>Inline Secrets</th><th>Credential Refs</th><th>Custom Endpoints</th><th>Notes</th></tr></thead>
          <tbody>
            ${providerRows.map((row) => `
              <tr>
                <td>${esc(row.provider)}</td>
                <td>${row.count}</td>
                <td>${row.inline}</td>
                <td>${row.refs}</td>
                <td>${row.customEndpoints}</td>
                <td>${esc(row.notes)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Cloud Security Guidance</h3></div>
        <div style="padding:0.95rem 1rem;font-size:0.8rem;color:var(--text-secondary);line-height:1.55;">
          Prefer <code>credentialRef</code>-backed auth over inline secrets, especially for AWS/GCP/Azure credentials.<br>
          Review any cPanel/WHM profile with <code>allowSelfSigned: true</code> and remove custom endpoint overrides unless you intentionally target emulators, proxies, or sovereign clouds.<br>
          Cloud tool approval behavior still follows the existing Guardian/tool policy stack; this page summarizes posture and recent decisions, not just static config.
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Cloud Audit Activity</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Tool</th><th>Controller</th><th>Reason</th></tr></thead>
          <tbody>
            ${cloudEvents.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent cloud-related audit events.</td></tr>'
              : cloudEvents.map((event) => `
                <tr>
                  <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
                  <td>${esc(event.type)}</td>
                  <td><span class="badge ${auditSeverityClass(event.severity)}">${esc(event.severity)}</span></td>
                  <td>${esc(event.details?.toolName || '-')}</td>
                  <td>${esc(event.controller || '-')}</td>
                  <td title="${escAttr(event.details?.reason || '')}">${esc(event.details?.reason || event.details?.source || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
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
    enhanceSectionHelp(panel, SECURITY_HELP.intel, createGenericHelpFactory('Threat Intel'));
    activateContextHelp(panel);
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

function createGenericHelpFactory(area) {
  return (title) => ({
    whatItIs: `${title} is part of ${area}.`,
    whatSeeing: 'You are seeing the current data, controls, or actions available in this section.',
    whatCanDo: 'Review the current state here and use the controls or links in the section when you need to act.',
    howLinks: `This section supports the broader ${area} workflow and links outward to related owner pages when deeper work is needed.`,
  });
}

function mapNetworkSeverityToAudit(severity) {
  if (severity === 'critical') return 'critical';
  if (severity === 'high' || severity === 'medium' || severity === 'warn') return 'warn';
  return 'info';
}

function auditSeverityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'warn') return 'badge-warn';
  return 'badge-info';
}

function isCloudToolName(toolName) {
  return /^(cpanel_|whm_|vercel_|cf_|aws_|gcp_|azure_)/.test(String(toolName || ''));
}

function isCloudAuditEvent(event) {
  const toolName = event?.details?.toolName;
  if (isCloudToolName(toolName)) return true;
  const source = String(event?.details?.source || '');
  return source.includes('tool:cf_')
    || source.includes('tool:aws_')
    || source.includes('tool:gcp_')
    || source.includes('tool:azure_')
    || source.includes('tool:vercel_')
    || source.includes('tool:cpanel_')
    || source.includes('tool:whm_');
}

function isAutomationAuditEvent(event) {
  if (event?.type !== 'automation_finding') return false;
  return event?.details?.automationDisposition?.sendToSecurity === true;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(input) {
  return esc(input).replace(/"/g, '&quot;');
}
