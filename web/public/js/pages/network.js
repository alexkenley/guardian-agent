/**
 * Network page - manual network visibility and tool execution.
 */

import { api } from '../api.js';
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

let currentPanel = null;

export async function renderNetwork(container) {
  currentPanel = container;
  container.innerHTML = '<h2 class="page-title">Network</h2>';

  createTabs(container, [
    { id: 'overview', label: 'Overview', render: renderOverviewTab },
    { id: 'devices', label: 'Devices', render: renderDevicesTab },
    { id: 'threats', label: 'Threats', render: renderThreatsTab },
    { id: 'tools', label: 'Tools', render: renderToolsTab },
  ]);
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
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>How To Use This Area</h3></div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">Use <strong>Tools</strong> to run one network tool right now. Use <strong>Workflows</strong> to chain multiple tools together. Use <strong>Operations</strong> to schedule either a single tool or a workflow.</div>
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

    applyInputTooltips(panel);
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
        <table>
          <thead>
            <tr><th>Status</th><th>IP Address</th><th>MAC Address</th><th>Hostname</th><th>Vendor</th><th>Type</th><th>Trust</th><th>Open Ports</th><th>First Seen</th><th>Last Seen</th></tr>
          </thead>
          <tbody>
            ${devices.length === 0
              ? '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">No devices discovered. Click "Scan Now" to discover devices on your network.</td></tr>'
              : devices.map((device) => `
                <tr>
                  <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${device.status === 'online' ? 'var(--success)' : 'var(--text-muted)'};margin-right:4px"></span>${esc(device.status)}</td>
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
        setTimeout(() => renderDevicesTab(panel), 1500);
      } catch (err) {
        status.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        button.disabled = false;
        button.textContent = 'Scan Now';
      }
    });

    panel.querySelector('#network-device-refresh')?.addEventListener('click', () => renderDevicesTab(panel));

    applyInputTooltips(panel);
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

    applyInputTooltips(panel);
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

    const intro = document.createElement('div');
    intro.className = 'table-container';
    intro.innerHTML = `
      <div class="table-header"><h3>Network Tools</h3></div>
      <div class="cfg-center-body">
        <div class="ops-inline-help">Run one network tool at a time here. If you want a repeatable chain, build a workflow. If you want it on a schedule, create a task in Operations.</div>
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

    const toolTabsRoot = document.createElement('div');
    panel.appendChild(toolTabsRoot);

    createTabs(toolTabsRoot, networkTools.map((tool) => ({
      id: tool.name,
      label: networkToolLabel(tool.name),
      render: (toolPanel) => renderNetworkToolPanel(toolPanel, tool),
    })));
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
            <pre class="network-tool-result">Run the tool to see output here.</pre>
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

  applyInputTooltips(panel);
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
  status.textContent = config.pending;
  status.style.color = 'var(--text-muted)';
  try {
    const result = await api.runTool({ toolName: config.toolName, args: config.args, origin: 'web' });
    status.textContent = result.message || config.success;
    status.style.color = result.success ? 'var(--success)' : 'var(--error)';
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    status.style.color = 'var(--error)';
  }
}

async function runThreatAction(panel, config) {
  const status = panel.querySelector('#network-threat-status');
  status.innerHTML = `<div style="color:var(--text-muted);padding:0.5rem">${esc(config.pending)}</div>`;
  try {
    const result = await api.runTool({ toolName: config.toolName, args: config.args, origin: 'web' });
    status.innerHTML = `<div style="color:${result.success ? 'var(--success)' : 'var(--error)'};padding:0.5rem">${esc(result.message || config.success)}</div>`;
    setTimeout(() => renderThreatsTab(panel), 1200);
  } catch (err) {
    status.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
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

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
