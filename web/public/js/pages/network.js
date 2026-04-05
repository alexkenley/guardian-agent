/**
 * Network page - manual network visibility and tool execution.
 */

import { api } from '../api.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';

const NETWORK_TOOL_ORDER = [
  'net_interfaces',
  'net_ping',
  'net_arp_scan',
  'net_port_check',
  'net_dns_lookup',
  'net_connections',
  'net_traceroute',
  'net_oui_lookup',
  'net_classify',
  'net_banner_grab',
  'net_fingerprint',
  'net_wifi_scan',
  'net_wifi_clients',
  'net_connection_profiles',
  'net_baseline',
  'net_anomaly_check',
  'net_traffic_baseline',
  'net_threat_check',
  'net_threat_summary',
];

const NETWORK_TOOL_DEFAULTS = {
  net_ping: { count: 4 },
  net_port_check: { ports: '22,80,443' },
  net_dns_lookup: { type: 'A' },
  net_banner_grab: { port: 80 },
  net_fingerprint: { portScan: true },
  net_wifi_scan: { force: true },
  net_baseline: { windowMinutes: 120 },
  net_threat_check: { refresh: true },
  net_threat_summary: { limit: 25 },
};

const NETWORK_TOOL_GROUPS = [
  {
    id: 'discovery',
    label: 'Discovery',
    tools: ['net_interfaces', 'net_arp_scan', 'net_wifi_scan', 'net_wifi_clients'],
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    tools: ['net_ping', 'net_port_check', 'net_dns_lookup', 'net_traceroute'],
  },
  {
    id: 'identity',
    label: 'Identity & Fingerprinting',
    tools: ['net_oui_lookup', 'net_classify', 'net_banner_grab', 'net_fingerprint'],
  },
  {
    id: 'traffic',
    label: 'Traffic & Threat',
    tools: [
      'net_connections',
      'net_connection_profiles',
      'net_baseline',
      'net_anomaly_check',
      'net_traffic_baseline',
      'net_threat_check',
      'net_threat_summary',
    ],
  },
];

let currentPanel = null;

const NETWORK_HELP = {
  overview: {
    'Quick Network Actions': {
      whatItIs: 'This section is the one-click action bar for the most common ad hoc network tasks.',
      whatSeeing: 'You are seeing immediate buttons for device discovery, threat checks, and baseline refreshes, plus a live output panel underneath.',
      whatCanDo: 'Run a useful network action immediately without building a workflow first, then inspect the raw result on the same tab.',
      howLinks: 'For repeatable or scheduled work, move into Automations. For alert triage or incident response, move into Security.',
    },
    'How To Use This Area': {
      whatItIs: 'This section explains the role of the Network page relative to Security and Automations.',
      whatSeeing: 'You are seeing guidance on when to use this page for inventory and ad hoc diagnostics versus when to switch to automations or alert triage.',
      whatCanDo: 'Use it to decide whether the current task is a one-off network check, an incident requiring Security, or a repeatable workflow that belongs in Automations.',
      howLinks: 'It clarifies the handoff between Network, Automations, and Security so the same job is not attempted in the wrong page.',
    },
  },
  devices: {
    'Discovered Devices': {
      whatItIs: 'This is the live inventory table for devices Guardian has discovered on the monitored network.',
      whatSeeing: 'You are seeing each device\'s identity details, trust state, observed ports, and first-seen or last-seen timing.',
      whatCanDo: 'Refresh discovery, run another scan, and inspect what Guardian currently knows about each host on the network.',
      howLinks: 'This tab owns network inventory detail, while active security alert handling still rolls up into Security.',
    },
  },
  history: {
    'Recent Network Runs': {
      whatItIs: 'This section records the recent history of network-specific playbooks, scans, and scheduled task runs.',
      whatSeeing: 'You are seeing recent executions with run status, duration, and expandable output for the steps that actually ran.',
      whatCanDo: 'Review recent network results, inspect the output, and confirm whether a scheduled or manual network workflow succeeded.',
      howLinks: 'This is the network-focused history view, while full workflow ownership and editing stay in Automations.',
    },
  },
  diagnostics: {
    Diagnostics: {
      whatItIs: 'This is the ad hoc network tool runner for one-off diagnostics and inspection work.',
      whatSeeing: 'You are seeing the current network tool selection, its input form, and the runner surface used to execute it immediately.',
      whatCanDo: 'Choose one network tool, supply the inputs it needs, run it now, and inspect or export the result.',
      howLinks: 'Use this tab for ad hoc checks only. Move to Automations when the same sequence should repeat or be scheduled.',
    },
    'Tool Selector': {
      whatItIs: 'This section controls which network tool family and exact tool are active in the runner below.',
      whatSeeing: 'You are seeing the available network tools grouped by task type such as discovery, diagnostics, identity, and traffic or threat work.',
      whatCanDo: 'Switch between categories, pick a specific tool, and change the active runner without leaving the Diagnostics tab.',
      howLinks: 'The selection made here directly determines which input form and output you see below.',
    },
    Result: {
      whatItIs: 'This is the result viewer for the network tool you just ran.',
      whatSeeing: 'You are seeing the raw output produced by the selected tool together with quick copy and export actions.',
      whatCanDo: 'Inspect the result immediately, copy it elsewhere, or export it as text or HTML for follow-up work.',
      howLinks: 'Use the output here for immediate diagnosis, then move to Security if the result reveals something that needs incident triage.',
    },
  },
};

export async function renderNetwork(container, options = {}) {
  currentPanel = container;
  container.innerHTML = `
    <h2 class="page-title">Network</h2>
    ${renderGuidancePanel({
      kicker: 'Network Guide',
      title: 'Inventory, diagnostics, and network history',
      whatItIs: 'Network is the operational page for device visibility, manual diagnostics, and network-specific workflow history.',
      whatSeeing: 'You are seeing tabs for posture overview, discovered-device inventory, ad hoc network tools, and recent network run history.',
      whatCanDo: 'Inspect devices, run targeted network checks, and review results without leaving the network domain.',
      howLinks: 'Security owns the unified alert queue, while Automations owns repeatable and scheduled workflow configuration.',
    })}
  `;

  createTabs(container, [
    { id: 'overview', label: 'Overview', render: renderOverviewTab },
    { id: 'devices', label: 'Devices', render: renderDevicesTab },
    { id: 'history', label: 'History', render: renderHistoryTab },
    { id: 'diagnostics', label: 'Diagnostics', render: renderToolsTab },
  ], normalizeNetworkTab(options?.tab));
}

export async function updateNetwork() {
  if (!currentPanel) return;
  const activeTab = currentPanel.dataset.activeTab;
  await renderNetwork(currentPanel, activeTab ? { tab: activeTab } : {});
}

function normalizeNetworkTab(tab) {
  if (tab === 'threats') return 'overview';
  if (tab === 'tools') return 'diagnostics';
  return tab || 'overview';
}

async function renderOverviewTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [deviceData, baseline, threatState, toolsState] = await Promise.all([
      api.networkDevices().catch(() => ({ devices: [] })),
      api.networkBaseline().catch(() => null),
      api.networkThreats({ limit: 20 }).catch(() => null),
      api.toolsState(200).catch(() => ({ tools: [] })),
    ]);

    const devices = deviceData.devices || [];
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
    const networkTools = (toolsState.tools || []).filter((tool) => tool.category === 'network');

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Overview',
        compact: true,
        whatItIs: 'Overview is the quick posture and action surface for the network domain.',
        whatSeeing: 'You are seeing device counts, baseline state, active network alerts, and fast action buttons.',
        whatCanDo: 'Run high-value one-off actions immediately or decide whether you need Devices, Diagnostics, or Security next.',
        howLinks: 'This tab summarizes state; full device detail lives in Devices and ad hoc execution lives in Diagnostics.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Devices</div>
          <div class="card-value">${devices.length}</div>
          <div class="card-subtitle">${devices.filter((device) => device.status === 'online').length} online</div>
        </div>
        <div class="status-card ${safeBaseline.baselineReady ? 'success' : 'warning'}">
          <div class="card-title">Baseline</div>
          <div class="card-value">${safeBaseline.baselineReady ? 'Ready' : 'Learning'}</div>
          <div class="card-subtitle">${safeBaseline.snapshotCount}/${safeBaseline.minSnapshotsForBaseline} snapshots</div>
        </div>
        <div class="status-card ${safeThreatState.activeAlertCount > 0 ? 'error' : 'success'}">
          <div class="card-title">Active Alerts</div>
          <div class="card-value">${safeThreatState.activeAlertCount}</div>
          <div class="card-subtitle">Critical: ${safeThreatState.bySeverity.critical}, High: ${safeThreatState.bySeverity.high}</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Network Tools</div>
          <div class="card-value">${networkTools.length}</div>
          <div class="card-subtitle">Run one-off scans from the Tools tab</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Quick Network Actions</h3>
          <button class="btn btn-secondary" id="network-overview-refresh">Refresh</button>
        </div>
        <div class="cfg-center-body">
          <div class="cfg-actions" style="margin-top:0;">
            <button class="btn btn-primary" id="network-overview-scan">Scan Devices</button>
            <button class="btn btn-secondary" id="network-overview-threat">Run Threat Check</button>
            <button class="btn btn-secondary" id="network-overview-baseline">Refresh Baseline</button>
          </div>
          <div id="network-overview-status" class="cfg-save-status" style="margin-top:0.75rem;"></div>
          ${renderOutputPanel({
            id: 'network-overview-output',
            exportName: 'network-overview-output',
            initialText: 'Run an action to see output here.',
          })}
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>How To Use This Area</h3></div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">Use <strong>Diagnostics</strong> to run one network tool right now. Use <strong>Automations</strong> when you want a repeatable chain or a schedule. Use <strong>Security</strong> when you need the unified alert queue and cross-domain investigation view.</div>
        </div>
      </div>
    `;

    panel.querySelector('#network-overview-refresh')?.addEventListener('click', () => renderOverviewTab(panel));
    panel.querySelector('#network-overview-scan')?.addEventListener('click', () => runOverviewAction(panel, {
      toolName: 'net_arp_scan',
      args: {},
      pending: 'Scanning devices...',
      success: 'Device scan complete.',
    }));
    panel.querySelector('#network-overview-threat')?.addEventListener('click', () => runOverviewAction(panel, {
      toolName: 'net_threat_check',
      args: { refresh: true },
      pending: 'Running threat check...',
      success: 'Threat check complete.',
    }));
    panel.querySelector('#network-overview-baseline')?.addEventListener('click', () => runOverviewAction(panel, {
      toolName: 'net_anomaly_check',
      args: {},
      pending: 'Refreshing baseline snapshot...',
      success: 'Baseline refresh complete.',
    }));

    bindOutputActions(panel);
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, NETWORK_HELP.overview, createGenericHelpFactory('Network Overview'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderDevicesTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const data = await api.networkDevices().catch(() => ({ devices: [] }));
    const devices = data.devices || [];

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Devices',
        compact: true,
        whatItIs: 'Devices is the inventory view for discovered hosts and their observed attributes.',
        whatSeeing: 'You are seeing the current discovered device list, trust state, ports, and presence over time.',
        whatCanDo: 'Run discovery again, review what is online, and inspect device-level network details.',
        howLinks: 'This tab handles inventory detail; suspicious conditions still roll up into Security for unified triage.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Total Devices</div>
          <div class="card-value">${devices.length}</div>
        </div>
        <div class="status-card success">
          <div class="card-title">Online</div>
          <div class="card-value">${devices.filter((device) => device.status === 'online').length}</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Offline</div>
          <div class="card-value">${devices.filter((device) => device.status === 'offline').length}</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Trusted</div>
          <div class="card-value">${devices.filter((device) => device.trusted).length}</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Discovered Devices</h3>
          <div>
            <button class="btn btn-primary" id="network-device-scan">Scan Now</button>
            <button class="btn btn-secondary" id="network-device-refresh">Refresh</button>
          </div>
        </div>
        <div id="network-device-status" style="padding:0 1rem"></div>
        <div style="padding:0 1rem 1rem">
          ${renderOutputPanel({
            id: 'network-device-output',
            exportName: 'network-device-output',
            initialText: 'Run a scan to inspect discovery output here.',
          })}
        </div>
        <table>
          <thead>
            <tr><th>Status</th><th>IP Address</th><th>MAC Address</th><th>Hostname</th><th>Vendor</th><th>Type</th><th>Trust</th><th>Open Ports</th><th>First Seen</th><th>Last Seen</th></tr>
          </thead>
          <tbody>
            ${devices.length === 0
              ? '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">No devices discovered. Click "Scan Now" to discover devices on your network.</td></tr>'
              : devices.map((device) => `
                <tr>
                  <td><span style="display:inline-block;width:10px;height:10px;border-radius:0;background:${device.status === 'online' ? 'var(--success)' : 'var(--text-muted)'};margin-right:4px"></span>${esc(device.status)}</td>
                  <td style="font-family:monospace">${esc(device.ip)}</td>
                  <td style="font-family:monospace">${esc(device.mac)}</td>
                  <td>${esc(device.hostname || '-')}</td>
                  <td>${esc(device.vendor || '-')}</td>
                  <td>${esc(device.deviceType || 'unknown')}${device.deviceTypeConfidence ? ` (${Math.round(Number(device.deviceTypeConfidence) * 100)}%)` : ''}</td>
                  <td>${device.trusted ? '<span class="badge badge-running">trusted</span>' : '<span class="badge badge-idle">untrusted</span>'}</td>
                  <td style="font-family:monospace">${device.openPorts?.length ? esc(device.openPorts.join(', ')) : '-'}</td>
                  <td>${formatTime(device.firstSeen)}</td>
                  <td>${formatTime(device.lastSeen)}</td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>
    `;

    panel.querySelector('#network-device-scan')?.addEventListener('click', async () => {
      const button = panel.querySelector('#network-device-scan');
      const status = panel.querySelector('#network-device-status');
      button.disabled = true;
      button.textContent = 'Scanning...';
      status.innerHTML = '<div style="color:var(--text-muted);padding:0.5rem">Running network scan...</div>';
      try {
        const result = await api.networkScan();
        status.innerHTML = `<div style="color:${result.success ? 'var(--success)' : 'var(--error)'};padding:0.5rem">${esc(result.message)} (${result.devicesFound || 0} devices found)</div>`;
        const output = panel.querySelector('#network-device-output');
        if (output && result.run?.steps) {
          output.textContent = JSON.stringify(result.run.steps, null, 2);
        }
        setTimeout(() => renderDevicesTab(panel), 1500);
      } catch (err) {
        status.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        button.disabled = false;
        button.textContent = 'Scan Now';
      }
    });

    panel.querySelector('#network-device-refresh')?.addEventListener('click', () => renderDevicesTab(panel));

    bindOutputActions(panel);
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, NETWORK_HELP.devices, createGenericHelpFactory('Network Devices'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderThreatsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [baseline, threatState] = await Promise.all([
      api.networkBaseline().catch(() => null),
      api.networkThreats({ limit: 100 }).catch(() => null),
    ]);

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

    panel.innerHTML = `
      <div class="intel-summary-grid">
        <div class="status-card ${safeBaseline.baselineReady ? 'success' : 'warning'}">
          <div class="card-title">Baseline</div>
          <div class="card-value">${safeBaseline.baselineReady ? 'Ready' : 'Learning'}</div>
          <div class="card-subtitle">${safeBaseline.snapshotCount}/${safeBaseline.minSnapshotsForBaseline} snapshots</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Known Devices</div>
          <div class="card-value">${safeBaseline.knownDevices.length}</div>
          <div class="card-subtitle">Updated: ${safeBaseline.lastUpdatedAt ? formatTime(safeBaseline.lastUpdatedAt) : 'never'}</div>
        </div>
        <div class="status-card ${safeThreatState.activeAlertCount > 0 ? 'error' : 'success'}">
          <div class="card-title">Active Alerts</div>
          <div class="card-value">${safeThreatState.activeAlertCount}</div>
          <div class="card-subtitle">Critical: ${safeThreatState.bySeverity.critical}, High: ${safeThreatState.bySeverity.high}</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Threat Operations</h3>
          <div>
            <button class="btn btn-secondary" id="network-threat-refresh">Refresh</button>
            <button class="btn btn-primary" id="network-threat-check">Run Threat Check</button>
            <button class="btn btn-secondary" id="network-baseline-refresh">Refresh Baseline</button>
          </div>
        </div>
        <div id="network-threat-status" style="padding:0 1rem"></div>
        <div style="padding:0 1rem 1rem">
          ${renderOutputPanel({
            id: 'network-threat-output',
            exportName: 'network-threat-output',
            initialText: 'Run a threat action to inspect output here.',
          })}
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Active Alerts</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Host</th><th>Description</th><th>Action</th></tr></thead>
          <tbody>
            ${safeThreatState.alerts.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active alerts.</td></tr>'
              : safeThreatState.alerts.map((alert) => `
                <tr>
                  <td>${formatTime(alert.lastSeenAt || alert.timestamp)}</td>
                  <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
                  <td>${esc(alert.type)}</td>
                  <td>${esc(alert.ip || alert.mac || '-')}</td>
                  <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
                  <td><button class="btn btn-secondary network-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>
    `;

    panel.querySelector('#network-threat-refresh')?.addEventListener('click', () => renderThreatsTab(panel));
    panel.querySelector('#network-baseline-refresh')?.addEventListener('click', () => runThreatAction(panel, {
      toolName: 'net_anomaly_check',
      args: {},
      pending: 'Refreshing baseline snapshot...',
      success: 'Baseline refresh complete.',
    }));
    panel.querySelector('#network-threat-check')?.addEventListener('click', () => runThreatAction(panel, {
      toolName: 'net_threat_check',
      args: { refresh: true },
      pending: 'Running threat check...',
      success: 'Threat check complete.',
    }));

    panel.querySelectorAll('.network-alert-ack').forEach((button) => {
      button.addEventListener('click', async () => {
        const alertId = button.getAttribute('data-alert-id');
        if (!alertId) return;
        button.disabled = true;
        try {
          await api.acknowledgeNetworkThreat(alertId);
          await renderThreatsTab(panel);
        } catch {
          button.disabled = false;
        }
      });
    });

    bindOutputActions(panel);
    applyInputTooltips(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderHistoryTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [connState, taskHistory] = await Promise.all([
      api.connectorsState(40).catch(() => ({ runs: [] })),
      api.scheduledTaskHistory().catch(() => []),
    ]);

    const runs = [];

    for (const run of (connState.runs || [])) {
      if (!isNetworkPlaybookRun(run)) continue;
      runs.push({
        id: run.id || `playbook-${run.playbookId}-${run.startedAt || run.completedAt || 0}`,
        time: run.startedAt || run.completedAt || run.createdAt || 0,
        name: run.playbookName || run.playbookId || 'Network Playbook',
        source: 'playbook',
        status: run.status || 'unknown',
        durationMs: run.durationMs || 0,
        message: run.message || '',
        steps: run.steps || [],
      });
    }

    for (const item of (taskHistory || [])) {
      if (!isNetworkTaskRun(item)) continue;
      runs.push({
        id: item.id || `task-${item.taskId}-${item.timestamp || 0}`,
        time: item.timestamp || 0,
        name: item.taskName || item.target || 'Scheduled Run',
        source: item.taskType === 'playbook' ? 'scheduled playbook' : 'scheduled tool',
        status: item.status || 'unknown',
        durationMs: item.durationMs || 0,
        message: item.message || '',
        steps: item.steps || [],
      });
    }

    runs.sort((a, b) => b.time - a.time);

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'History',
        compact: true,
        whatItIs: 'History is the recent run ledger for network-specific tools and workflows.',
        whatSeeing: 'You are seeing recent playbook and scheduled runs that involved network tooling, with expandable step output.',
        whatCanDo: 'Inspect recent executions and confirm what ran, when it ran, and what it returned.',
        howLinks: 'This is a focused history view for the network domain; automation ownership and editing remain in Automations.',
      })}
      <div class="table-container">
        <div class="table-header">
          <h3>Recent Network Runs</h3>
          <button class="btn btn-secondary" id="network-history-refresh">Refresh</button>
        </div>
        <table>
          <thead><tr><th>Time</th><th>Name</th><th>Source</th><th>Status</th><th>Duration</th><th>Output</th></tr></thead>
          <tbody>
            ${runs.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No network runs recorded yet.</td></tr>'
              : runs.slice(0, 30).map((run) => `
                <tr>
                  <td>${formatTime(run.time)}</td>
                  <td>${esc(run.name)}</td>
                  <td>${esc(run.source)}</td>
                  <td><span class="badge ${severityClass(run.status === 'succeeded' ? 'low' : run.status === 'failed' ? 'high' : 'medium')}">${esc(run.status)}</span></td>
                  <td>${run.durationMs}ms</td>
                  <td>
                    ${run.steps.length > 0
                      ? `<button class="btn btn-secondary btn-sm network-run-toggle" data-run-id="${escAttr(run.id)}">Show</button>`
                      : `<span style="color:var(--text-muted)">${esc(run.message || '-')}</span>`
                    }
                  </td>
                </tr>
                ${run.steps.length > 0 ? `
                <tr id="network-run-detail-${escAttr(run.id)}" style="display:none">
                  <td colspan="6" style="padding:0.75rem 1rem;background:var(--bg-secondary)">
                    ${renderRunSteps(run.steps, run.name || run.id)}
                  </td>
                </tr>
                ` : ''}
              `).join('')
            }
          </tbody>
        </table>
      </div>
    `;

    panel.querySelector('#network-history-refresh')?.addEventListener('click', () => renderHistoryTab(panel));
    panel.querySelectorAll('.network-run-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const runId = button.getAttribute('data-run-id');
        const detail = panel.querySelector(`#network-run-detail-${cssEscape(runId || '')}`);
        if (!detail) return;
        const visible = detail.style.display !== 'none';
        detail.style.display = visible ? 'none' : '';
        button.textContent = visible ? 'Show' : 'Hide';
      });
    });
    panel.querySelectorAll('.auto-step-output-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const outputId = button.getAttribute('data-output-id');
        const output = panel.querySelector(`#${cssEscape(outputId || '')}`);
        if (!output) return;
        const visible = output.style.display !== 'none';
        output.style.display = visible ? 'none' : '';
        button.textContent = visible ? 'Output' : 'Hide';
      });
    });

    bindOutputActions(panel);
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, NETWORK_HELP.history, createGenericHelpFactory('Network History'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderToolsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const toolsState = await api.toolsState(200);
    const networkTools = (toolsState.tools || [])
      .filter((tool) => tool.category === 'network')
      .sort((a, b) => {
        const ai = NETWORK_TOOL_ORDER.indexOf(a.name);
        const bi = NETWORK_TOOL_ORDER.indexOf(b.name);
        const aRank = ai === -1 ? 999 : ai;
        const bRank = bi === -1 ? 999 : bi;
        return aRank - bRank || a.name.localeCompare(b.name);
      });

    panel.innerHTML = '';

    panel.insertAdjacentHTML('beforeend', renderGuidancePanel({
      kicker: 'Diagnostics',
      compact: true,
      whatItIs: 'Diagnostics is the manual network tool runner, not a shared output console.',
      whatSeeing: 'You are seeing a category selector, a tool selector, parameter fields for the active tool, Run Tool and Clear actions, and the output for the tool run started from this tab.',
      whatCanDo: 'Use it to run one network tool immediately, inspect the result, and export that single run if needed.',
      howLinks: 'It does not stream output from Automations or unrelated tools. Repeatable work belongs in Automations, and actionable findings should be followed into Security.',
    }));

    const intro = document.createElement('div');
    intro.className = 'table-container';
    intro.innerHTML = `
      <div class="table-header"><h3>Diagnostics</h3></div>
      <div class="cfg-center-body">
        <div class="ops-inline-help">Run one network tool at a time here. This tab is only for the tool you select below, and the result panel only shows output from runs started here. If you want a repeatable or scheduled workflow, create it in Automations. If the result should feed the unified alert queue, review it in Security.</div>
      </div>
    `;
    panel.appendChild(intro);

    if (networkTools.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'table-container';
      empty.innerHTML = '<div class="loading">No network tools are currently available.</div>';
      panel.appendChild(empty);
      return;
    }

    const groupedTools = buildNetworkToolGroups(networkTools);
    const initialGroupId = panel.dataset.networkToolGroup && groupedTools.some((group) => group.id === panel.dataset.networkToolGroup)
      ? panel.dataset.networkToolGroup
      : groupedTools[0]?.id;
    const initialGroup = groupedTools.find((group) => group.id === initialGroupId) || groupedTools[0];
    const initialToolName = panel.dataset.networkToolName && initialGroup.tools.some((tool) => tool.name === panel.dataset.networkToolName)
      ? panel.dataset.networkToolName
      : initialGroup.tools[0]?.name;

    panel.insertAdjacentHTML('beforeend', `
      <div class="table-container">
        <div class="table-header">
          <h3>Tool Selector</h3>
          <span class="cfg-header-note">Choose a category, then pick a tool</span>
        </div>
        <div class="cfg-center-body network-tool-picker">
          <div class="cfg-form-grid">
            <div class="cfg-field">
              <label>Category</label>
              <select id="network-tool-group-select">
                ${groupedTools.map((group) => `<option value="${escAttr(group.id)}"${group.id === initialGroup.id ? ' selected' : ''}>${esc(group.label)} (${group.tools.length})</option>`).join('')}
              </select>
            </div>
            <div class="cfg-field">
              <label>Tool</label>
              <select id="network-tool-select"></select>
            </div>
          </div>
          <div class="network-tool-picker-meta" id="network-tool-picker-meta"></div>
        </div>
      </div>
    `);

    const toolPanel = document.createElement('div');
    panel.appendChild(toolPanel);

    const groupSelect = panel.querySelector('#network-tool-group-select');
    const toolSelect = panel.querySelector('#network-tool-select');
    const pickerMeta = panel.querySelector('#network-tool-picker-meta');

    function renderSelectedTool(groupId, toolName) {
      const group = groupedTools.find((entry) => entry.id === groupId) || groupedTools[0];
      if (!group) return;
      const tool = group.tools.find((entry) => entry.name === toolName) || group.tools[0];
      if (!tool) return;
      panel.dataset.networkToolGroup = group.id;
      panel.dataset.networkToolName = tool.name;
      pickerMeta.textContent = `${group.label}: ${tool.description || networkToolLabel(tool.name)}`;
      renderNetworkToolPanel(toolPanel, tool);
    }

    function syncToolOptions(groupId, preferredToolName) {
      const group = groupedTools.find((entry) => entry.id === groupId) || groupedTools[0];
      if (!group) return;
      toolSelect.innerHTML = group.tools
        .map((tool) => `<option value="${escAttr(tool.name)}">${esc(networkToolLabel(tool.name))}</option>`)
        .join('');
      const selectedTool = group.tools.some((tool) => tool.name === preferredToolName)
        ? preferredToolName
        : group.tools[0]?.name;
      toolSelect.value = selectedTool || '';
      renderSelectedTool(group.id, selectedTool);
    }

    groupSelect?.addEventListener('change', () => {
      syncToolOptions(groupSelect.value, null);
    });
    toolSelect?.addEventListener('change', () => {
      renderSelectedTool(groupSelect.value, toolSelect.value);
    });

    syncToolOptions(initialGroup.id, initialToolName);
    enhanceSectionHelp(panel, NETWORK_HELP.diagnostics, createGenericHelpFactory('Network Diagnostics'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderNetworkToolPanel(panel, tool) {
  const properties = tool.parameters?.properties || {};
  const required = new Set(tool.parameters?.required || []);
  const fieldEntries = Object.entries(properties);

  panel.innerHTML = `
    <div class="table-container">
      <div class="table-header">
        <h3>${esc(networkToolLabel(tool.name))}</h3>
        <span class="cfg-header-note">${esc(tool.name)}</span>
      </div>
      <div class="cfg-center-body">
        <div class="ops-inline-help">${esc(tool.description || '')}</div>
        <div class="cfg-form-grid" style="margin-top:1rem;">
          ${fieldEntries.length === 0
            ? '<div class="ops-inline-help">This tool does not need any input fields.</div>'
            : fieldEntries.map(([key, schema]) => renderToolField(tool.name, key, schema, required.has(key))).join('')
          }
        </div>
        <div class="cfg-actions">
          <button class="btn btn-primary network-tool-run">Run Tool</button>
          <button class="btn btn-secondary network-tool-clear">Clear</button>
          <span class="cfg-save-status network-tool-status"></span>
        </div>
        <div class="table-container" style="margin-top:1rem;margin-bottom:0;">
          <div class="table-header"><h3>Result</h3></div>
          <div class="cfg-center-body">
            ${renderOutputPanel({
              id: `network-tool-output-${tool.name}`,
              exportName: tool.name,
              initialText: 'Run the tool to see output here.',
            })}
          </div>
        </div>
      </div>
    </div>
  `;

  panel.querySelector('.network-tool-run')?.addEventListener('click', async () => {
    const statusEl = panel.querySelector('.network-tool-status');
    const resultEl = panel.querySelector('.network-tool-result');

    let args;
    try {
      args = collectToolArgs(panel, properties, required);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
      return;
    }

    statusEl.textContent = 'Running...';
    statusEl.style.color = 'var(--text-muted)';
    resultEl.textContent = 'Running...';

    try {
      const result = await api.runTool({ toolName: tool.name, args, origin: 'web' });
      statusEl.textContent = result.message || (result.success ? 'Tool completed.' : 'Tool failed.');
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      resultEl.textContent = JSON.stringify(result.output ?? result, null, 2);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
      resultEl.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  panel.querySelector('.network-tool-clear')?.addEventListener('click', () => {
    panel.querySelectorAll('[data-tool-field]').forEach((field) => {
      const defaultValue = field.getAttribute('data-default-value');
      if (field.type === 'checkbox') {
        field.checked = defaultValue === 'true';
      } else {
        field.value = defaultValue || '';
      }
    });
    panel.querySelector('.network-tool-status').textContent = '';
    panel.querySelector('.network-tool-result').textContent = 'Run the tool to see output here.';
  });

  bindOutputActions(panel);
  applyInputTooltips(panel);
  enhanceSectionHelp(panel, NETWORK_HELP.diagnostics, createGenericHelpFactory('Network Diagnostics'));
  activateContextHelp(panel);
}

function renderToolField(toolName, key, schema, isRequired) {
  const label = humanizeKey(key);
  const type = schema?.type || 'string';
  const defaultValue = NETWORK_TOOL_DEFAULTS[toolName]?.[key];
  const placeholder = schema?.description || '';
  const requiredLabel = isRequired ? ' *' : '';

  if (type === 'boolean') {
    return `
      <div class="cfg-field">
        <label>${esc(label + requiredLabel)}</label>
        <select data-tool-field="${escAttr(key)}" data-schema-type="boolean" data-default-value="${defaultValue === true ? 'true' : defaultValue === false ? 'false' : ''}">
          <option value="">Default</option>
          <option value="true" ${defaultValue === true ? 'selected' : ''}>true</option>
          <option value="false" ${defaultValue === false ? 'selected' : ''}>false</option>
        </select>
      </div>
    `;
  }

  if (type === 'number' || type === 'integer') {
    return `
      <div class="cfg-field">
        <label>${esc(label + requiredLabel)}</label>
        <input data-tool-field="${escAttr(key)}" data-schema-type="number" data-default-value="${defaultValue ?? ''}" type="number" placeholder="${escAttr(placeholder)}" value="${escAttr(defaultValue ?? '')}">
      </div>
    `;
  }

  if (type === 'array') {
    const itemType = schema?.items?.type || 'string';
    return `
      <div class="cfg-field">
        <label>${esc(label + requiredLabel)}</label>
        <input data-tool-field="${escAttr(key)}" data-schema-type="array" data-array-item-type="${escAttr(itemType)}" data-default-value="${escAttr(defaultValue ?? '')}" type="text" placeholder="${escAttr(placeholder || 'Comma-separated values')}" value="${escAttr(defaultValue ?? '')}">
      </div>
    `;
  }

  if (type === 'object') {
    return `
      <div class="cfg-field">
        <label>${esc(label + requiredLabel)}</label>
        <textarea data-tool-field="${escAttr(key)}" data-schema-type="object" data-default-value="${escAttr(defaultValue ? JSON.stringify(defaultValue) : '')}" rows="4" placeholder="${escAttr(placeholder || '{}')}">${esc(defaultValue ? JSON.stringify(defaultValue, null, 2) : '')}</textarea>
      </div>
    `;
  }

  return `
    <div class="cfg-field">
      <label>${esc(label + requiredLabel)}</label>
      <input data-tool-field="${escAttr(key)}" data-schema-type="string" data-default-value="${escAttr(defaultValue ?? '')}" type="text" placeholder="${escAttr(placeholder)}" value="${escAttr(defaultValue ?? '')}">
    </div>
  `;
}

function collectToolArgs(panel, properties, required) {
  const args = {};

  for (const [key] of Object.entries(properties)) {
    const field = panel.querySelector(`[data-tool-field="${cssEscape(key)}"]`);
    if (!field) continue;

    const schemaType = field.getAttribute('data-schema-type');
    let value;

    if (schemaType === 'boolean') {
      if (!field.value) continue;
      value = field.value === 'true';
    } else if (schemaType === 'number') {
      if (field.value === '') continue;
      value = Number(field.value);
      if (!Number.isFinite(value)) throw new Error(`${humanizeKey(key)} must be a number.`);
    } else if (schemaType === 'array') {
      if (!field.value.trim()) continue;
      const rawItems = field.value.split(',').map((item) => item.trim()).filter(Boolean);
      const itemType = field.getAttribute('data-array-item-type');
      value = itemType === 'number'
        ? rawItems.map((item) => Number(item)).filter((item) => Number.isFinite(item))
        : rawItems;
    } else if (schemaType === 'object') {
      if (!field.value.trim()) continue;
      try {
        value = JSON.parse(field.value);
      } catch {
        throw new Error(`${humanizeKey(key)} must be valid JSON.`);
      }
    } else {
      if (!field.value.trim()) continue;
      value = field.value.trim();
    }

    args[key] = value;
  }

  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`${humanizeKey(key)} is required.`);
    }
  }

  return args;
}

async function runOverviewAction(panel, config) {
  const status = panel.querySelector('#network-overview-status');
  const output = panel.querySelector('#network-overview-output');
  status.textContent = config.pending;
  status.style.color = 'var(--text-muted)';
  if (output) output.textContent = 'Running...';
  try {
    const result = await api.runTool({ toolName: config.toolName, args: config.args, origin: 'web' });
    status.textContent = result.message || config.success;
    status.style.color = result.success ? 'var(--success)' : 'var(--error)';
    if (output) {
      output.textContent = JSON.stringify(result.output ?? result, null, 2);
    }
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    status.style.color = 'var(--error)';
    if (output) {
      output.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}

async function runThreatAction(panel, config) {
  const status = panel.querySelector('#network-threat-status');
  const output = panel.querySelector('#network-threat-output');
  status.innerHTML = `<div style="color:var(--text-muted);padding:0.5rem">${esc(config.pending)}</div>`;
  if (output) output.textContent = 'Running...';
  try {
    const result = await api.runTool({ toolName: config.toolName, args: config.args, origin: 'web' });
    status.innerHTML = `<div style="color:${result.success ? 'var(--success)' : 'var(--error)'};padding:0.5rem">${esc(result.message || config.success)}</div>`;
    if (output) {
      output.textContent = JSON.stringify(result.output ?? result, null, 2);
    }
    setTimeout(() => renderThreatsTab(panel), 1200);
  } catch (err) {
    status.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
    if (output) {
      output.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}

function renderRunSteps(steps, runName = 'network-run') {
  if (!steps || steps.length === 0) {
    return '<div style="color:var(--text-muted)">No output recorded.</div>';
  }

  return steps.map((step, index) => {
    const outputId = `network-run-output-${index}-${Math.random().toString(36).slice(2, 8)}`;
    const hasOutput = step.output != null && step.output !== '';
    return `
      <div style="padding:0.45rem 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:0.5rem;align-items:center">
          <strong>${esc(step.toolName || 'step')}</strong>
          <span style="color:var(--text-muted)">${esc(step.message || '')}</span>
          <span style="margin-left:auto;color:var(--text-muted)">${Number(step.durationMs || 0)}ms</span>
          ${hasOutput ? `<button class="btn btn-secondary btn-sm auto-step-output-toggle" data-output-id="${outputId}">Output</button>` : ''}
        </div>
        ${hasOutput ? `<div id="${outputId}" style="display:none;padding-top:0.5rem">${renderOutputPanel({
          id: `${outputId}-content`,
          exportName: `${runName}-${step.toolName || 'step'}-${index + 1}`,
          initialText: typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2),
          compact: true,
        })}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderOutputPanel({ id, exportName, initialText, compact = false }) {
  return `
    <div class="network-output-shell${compact ? ' compact' : ''}">
      <div class="network-output-toolbar">
        <div class="network-output-actions">
          <button class="btn btn-secondary btn-sm" data-output-action="copy" data-output-target="${escAttr(id)}" data-export-name="${escAttr(exportName)}">Copy</button>
          <button class="btn btn-secondary btn-sm" data-output-action="text" data-output-target="${escAttr(id)}" data-export-name="${escAttr(exportName)}">Text</button>
          <button class="btn btn-secondary btn-sm" data-output-action="html" data-output-target="${escAttr(id)}" data-export-name="${escAttr(exportName)}">HTML</button>
        </div>
        <span class="network-output-feedback" data-output-feedback="${escAttr(id)}"></span>
      </div>
      <pre id="${escAttr(id)}" class="network-tool-result">${esc(initialText || '')}</pre>
    </div>
  `;
}

function bindOutputActions(root) {
  root.querySelectorAll('[data-output-action]').forEach((button) => {
    if (button.dataset.outputBound === 'true') return;
    button.dataset.outputBound = 'true';
    button.addEventListener('click', async () => {
      const targetId = button.getAttribute('data-output-target') || '';
      const target = root.querySelector(`#${cssEscape(targetId)}`);
      if (!target) return;

      const exportName = button.getAttribute('data-export-name') || 'network-output';
      const content = target.textContent || '';
      const action = button.getAttribute('data-output-action');
      const feedback = root.querySelector(`[data-output-feedback="${cssEscapeAttr(targetId)}"]`);

      try {
        if (action === 'copy') {
          await copyText(content);
          setOutputFeedback(feedback, 'Copied');
          return;
        }

        if (action === 'text') {
          downloadOutput(`${exportName}.txt`, content, 'text/plain;charset=utf-8');
          setOutputFeedback(feedback, 'Saved .txt');
          return;
        }

        if (action === 'html') {
          const html = buildOutputHtml(exportName, content);
          downloadOutput(`${exportName}.html`, html, 'text/html;charset=utf-8');
          setOutputFeedback(feedback, 'Saved .html');
        }
      } catch (err) {
        setOutputFeedback(feedback, err instanceof Error ? err.message : 'Action failed');
      }
    });
  });
}

async function copyText(content) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function downloadOutput(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeFilename(filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildOutputHtml(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 24px; background: #0b1220; color: #e5edf7; }
    h1 { font-size: 18px; margin-bottom: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #11192b; border: 1px solid #23314f; border-radius:0; padding: 16px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre>${escapeHtml(content)}</pre>
</body>
</html>`;
}

function setOutputFeedback(element, message) {
  if (!element) return;
  element.textContent = message;
  clearTimeout(Number(element.dataset.feedbackTimer || 0));
  const timer = window.setTimeout(() => {
    element.textContent = '';
    element.dataset.feedbackTimer = '';
  }, 1800);
  element.dataset.feedbackTimer = String(timer);
}

function sanitizeFilename(filename) {
  return String(filename || 'network-output')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'network-output';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildNetworkToolGroups(networkTools) {
  const toolMap = new Map(networkTools.map((tool) => [tool.name, tool]));
  const grouped = NETWORK_TOOL_GROUPS
    .map((group) => ({
      id: group.id,
      label: group.label,
      tools: group.tools.map((toolName) => toolMap.get(toolName)).filter(Boolean),
    }))
    .filter((group) => group.tools.length > 0);

  const groupedNames = new Set(grouped.flatMap((group) => group.tools.map((tool) => tool.name)));
  const remaining = networkTools.filter((tool) => !groupedNames.has(tool.name));
  if (remaining.length > 0) {
    grouped.push({
      id: 'other',
      label: 'Other',
      tools: remaining,
    });
  }

  return grouped;
}

function isNetworkPlaybookRun(run) {
  return (run.steps || []).some((step) => typeof step.toolName === 'string' && step.toolName.startsWith('net_'));
}

function isNetworkTaskRun(entry) {
  if (typeof entry?.target === 'string' && entry.target.startsWith('net_')) {
    return true;
  }
  return (entry?.steps || []).some((step) => typeof step.toolName === 'string' && step.toolName.startsWith('net_'));
}

function networkToolLabel(toolName) {
  return ({
    net_interfaces: 'Interfaces',
    net_ping: 'Ping',
    net_arp_scan: 'ARP Scan',
    net_port_check: 'Port Check',
    net_dns_lookup: 'DNS Lookup',
    net_connections: 'Connections',
    net_traceroute: 'Traceroute',
    net_oui_lookup: 'OUI Lookup',
    net_classify: 'Classify Device',
    net_banner_grab: 'Banner Grab',
    net_fingerprint: 'Fingerprint',
    net_wifi_scan: 'WiFi Scan',
    net_wifi_clients: 'WiFi Clients',
    net_connection_profiles: 'Profiles',
    net_baseline: 'Baseline',
    net_anomaly_check: 'Anomaly Check',
    net_traffic_baseline: 'Traffic Baseline',
    net_threat_check: 'Threat Check',
    net_threat_summary: 'Threat Summary',
  })[toolName] || toolName;
}

function humanizeKey(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function createGenericHelpFactory(area) {
  const knownToolTitles = new Set(NETWORK_TOOL_ORDER.map((toolName) => networkToolLabel(toolName)));

  return (title) => {
    if (knownToolTitles.has(title)) {
      return {
        whatItIs: `This section is the input and run surface for the ${title} network tool.`,
        whatSeeing: `You are seeing the arguments required by ${title}, the run and clear controls, and the result panel for runs started from this section.`,
        whatCanDo: `Supply the parameters ${title} needs, execute it immediately, and inspect or export the returned output.`,
        howLinks: 'This is an ad hoc one-tool runner inside Network Diagnostics, not a shared log and not a scheduled workflow.',
      };
    }
    return null;
  };
}

function severityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'high') return 'badge-errored';
  if (severity === 'medium') return 'badge-warn';
  return 'badge-info';
}

function formatTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '-';
  }
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function cssEscapeAttr(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
