/**
 * Network device inventory page.
 *
 * Displays discovered devices with IP, MAC, hostname, open ports, and timestamps.
 * "Scan Now" triggers a network discovery playbook run.
 */

import { api } from '../api.js';

export async function renderNetwork(container) {
  container.innerHTML = '<h2 class="page-title">Network</h2><div class="loading">Loading...</div>';

  try {
    const data = await api.networkDevices().catch(() => ({ devices: [] }));
    const devices = data.devices || [];

    container.innerHTML = `
      <h2 class="page-title">Network Devices</h2>

      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Total Devices</div>
          <div class="card-value">${devices.length}</div>
        </div>
        <div class="status-card success">
          <div class="card-title">Online</div>
          <div class="card-value">${devices.filter(d => d.status === 'online').length}</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Offline</div>
          <div class="card-value">${devices.filter(d => d.status === 'offline').length}</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Discovered Devices</h3>
          <div>
            <button class="btn btn-primary" id="network-scan-btn">Scan Now</button>
            <button class="btn btn-secondary" id="network-refresh-btn">Refresh</button>
          </div>
        </div>
        <div id="network-scan-status" style="padding:0 1rem"></div>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>IP Address</th>
              <th>MAC Address</th>
              <th>Hostname</th>
              <th>Open Ports</th>
              <th>First Seen</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            ${devices.length === 0
              ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No devices discovered. Install the "Home Network" template on the Connectors page and run a Network Discovery playbook, or click "Scan Now" above.</td></tr>'
              : devices.map(d => `
                <tr>
                  <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${d.status === 'online' ? 'var(--success)' : 'var(--text-muted)'};margin-right:4px"></span>${esc(d.status)}</td>
                  <td style="font-family:monospace">${esc(d.ip)}</td>
                  <td style="font-family:monospace">${esc(d.mac)}</td>
                  <td>${esc(d.hostname || '-')}</td>
                  <td style="font-family:monospace">${d.openPorts && d.openPorts.length > 0 ? esc(d.openPorts.join(', ')) : '-'}</td>
                  <td>${formatTime(d.firstSeen)}</td>
                  <td>${formatTime(d.lastSeen)}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelector('#network-scan-btn')?.addEventListener('click', async () => {
      const btn = container.querySelector('#network-scan-btn');
      const statusDiv = container.querySelector('#network-scan-status');
      btn.disabled = true;
      btn.textContent = 'Scanning...';
      statusDiv.innerHTML = '<div style="color:var(--text-muted);padding:0.5rem">Running network scan...</div>';
      try {
        const result = await api.networkScan();
        statusDiv.innerHTML = `<div style="color:${result.success ? 'var(--success)' : 'var(--error)'};padding:0.5rem">${esc(result.message)} (${result.devicesFound || 0} devices found)</div>`;
        // Refresh the page to show updated devices
        setTimeout(() => renderNetwork(container), 1500);
      } catch (err) {
        statusDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        btn.disabled = false;
        btn.textContent = 'Scan Now';
      }
    });

    container.querySelector('#network-refresh-btn')?.addEventListener('click', () => renderNetwork(container));

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Network</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '-';
  }
}
