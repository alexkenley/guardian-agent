/**
 * Network page — tabbed: Connectors + Devices.
 */

import { api } from '../api.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderNetwork(container) {
  container.innerHTML = '<h2 class="page-title">Network</h2>';

  createTabs(container, [
    { id: 'connectors', label: 'Connectors', render: renderConnectorsTab },
    { id: 'devices', label: 'Devices', render: renderDevicesTab },
  ]);
}

// ─── Connectors Tab ──────────────────────────────────────

async function renderConnectorsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const state = await api.connectorsState(40);
    const summary = state.summary || {};
    const packs = state.packs || [];
    const playbooks = state.playbooks || [];
    const runs = state.runs || [];
    const playbooksConfig = state.playbooksConfig || {};
    const studio = state.studio || {};

    panel.innerHTML = `
      <div class="intel-summary-grid">
        <div class="status-card ${summary.enabled ? 'success' : 'warning'}">
          <div class="card-title">Framework</div>
          <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Execution mode: ${esc(summary.executionMode || 'plan_then_execute')}</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Connector Packs</div>
          <div class="card-value">${Number(summary.packCount || 0)}</div>
          <div class="card-subtitle">${Number(summary.enabledPackCount || 0)} enabled</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Playbooks</div>
          <div class="card-value">${Number(summary.playbookCount || 0)}</div>
          <div class="card-subtitle">${Number(summary.enabledPlaybookCount || 0)} enabled</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Recent Runs</div>
          <div class="card-value">${Number(summary.runCount || 0)}</div>
          <div class="card-subtitle">${Number(summary.dryRunQualifiedCount || 0)} dry-run qualified</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Playbooks</h3>
          <button class="btn btn-secondary" id="connectors-refresh">Refresh</button>
        </div>
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Mode</th><th>Steps</th><th>Schedule</th><th>Actions</th></tr></thead>
          <tbody>
            ${playbooks.length === 0
              ? '<tr><td colspan="6">No playbooks configured. Playbooks are auto-installed at startup.</td></tr>'
              : playbooks.map(pb => `
                <tr>
                  <td>${esc(pb.id)}</td>
                  <td>${esc(pb.name)}</td>
                  <td>${esc(pb.mode)}</td>
                  <td>${Number(pb.steps?.length || 0)}</td>
                  <td>${esc(pb.schedule || '-')}</td>
                  <td>
                    <button class="btn btn-primary connectors-playbook-run" data-playbook-id="${escAttr(pb.id)}">Run</button>
                    <button class="btn btn-secondary connectors-playbook-dryrun" data-playbook-id="${escAttr(pb.id)}">Dry Run</button>
                    <button class="btn btn-secondary connectors-playbook-delete" data-playbook-id="${escAttr(pb.id)}">Delete</button>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
        <div id="playbook-run-results" style="padding:0 1rem 1rem"></div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Runs</h3></div>
        <table>
          <thead><tr><th>Run</th><th>Playbook</th><th>Status</th><th>Duration</th><th>Steps</th><th>Details</th></tr></thead>
          <tbody>
            ${runs.length === 0
              ? '<tr><td colspan="6">No runs yet.</td></tr>'
              : runs.map(run => `
                <tr>
                  <td>${esc(shortId(run.id))}</td>
                  <td>${esc(run.playbookName || run.playbookId)}</td>
                  <td><span style="color:${run.status === 'succeeded' ? 'var(--success)' : run.status === 'failed' ? 'var(--error)' : 'var(--warning)'}">${esc(run.status)}</span></td>
                  <td>${Number(run.durationMs || 0)}ms</td>
                  <td>${(run.steps || []).length} step${(run.steps || []).length !== 1 ? 's' : ''}</td>
                  <td><button class="btn btn-secondary run-details-toggle" data-run-id="${escAttr(run.id)}">Show</button></td>
                </tr>
                <tr class="run-details-row" id="run-detail-${escAttr(run.id)}" style="display:none">
                  <td colspan="6" style="padding:0.5rem 1rem;background:var(--bg-secondary)">
                    ${renderStepResults(run.steps || [])}
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header" style="cursor:pointer" id="advanced-toggle">
          <h3>Advanced Settings</h3>
          <span id="advanced-arrow" style="font-size:0.85rem;color:var(--text-muted)">&#9654; Show</span>
        </div>
        <div id="advanced-panel" style="display:none">
          <div class="cfg-center-body">
            <div class="cfg-form-grid">
              <div class="cfg-field">
                <label>Enabled</label>
                <select id="connectors-enabled">
                  <option value="true" ${summary.enabled ? 'selected' : ''}>true</option>
                  <option value="false" ${!summary.enabled ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Execution Mode</label>
                <select id="connectors-mode">
                  <option value="plan_then_execute" ${summary.executionMode === 'plan_then_execute' ? 'selected' : ''}>plan_then_execute</option>
                  <option value="direct_execute" ${summary.executionMode === 'direct_execute' ? 'selected' : ''}>direct_execute</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Max Connector Calls/Run</label>
                <input id="connectors-max-calls" type="number" min="1" value="${esc(String(summary.maxConnectorCallsPerRun || 12))}">
              </div>
              <div class="cfg-field">
                <label>Max Steps</label>
                <input id="connectors-max-steps" type="number" min="1" value="${esc(String(playbooksConfig.maxSteps || 12))}">
              </div>
              <div class="cfg-field">
                <label>Max Parallel Steps</label>
                <input id="connectors-max-parallel" type="number" min="1" value="${esc(String(playbooksConfig.maxParallelSteps || 3))}">
              </div>
              <div class="cfg-field">
                <label>Default Step Timeout (ms)</label>
                <input id="connectors-step-timeout" type="number" min="1000" value="${esc(String(playbooksConfig.defaultStepTimeoutMs || 15000))}">
              </div>
              <div class="cfg-field">
                <label>Require Signed Definitions</label>
                <select id="connectors-require-signed">
                  <option value="true" ${playbooksConfig.requireSignedDefinitions ? 'selected' : ''}>true</option>
                  <option value="false" ${!playbooksConfig.requireSignedDefinitions ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Require Dry-Run First</label>
                <select id="connectors-require-dryrun">
                  <option value="true" ${playbooksConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>true</option>
                  <option value="false" ${!playbooksConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Studio Enabled</label>
                <select id="connectors-studio-enabled">
                  <option value="true" ${studio.enabled ? 'selected' : ''}>true</option>
                  <option value="false" ${!studio.enabled ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Studio Mode</label>
                <select id="connectors-studio-mode">
                  <option value="builder" ${studio.mode === 'builder' ? 'selected' : ''}>builder</option>
                  <option value="read_only" ${studio.mode === 'read_only' ? 'selected' : ''}>read_only</option>
                </select>
              </div>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="connectors-settings-save">Save Settings</button>
              <span id="connectors-settings-status" class="cfg-save-status"></span>
            </div>
          </div>

          <div class="cfg-center-body">
            <h4 style="margin-bottom:0.5rem">Connector Packs</h4>
            <table>
              <thead><tr><th>ID</th><th>Name</th><th>Capabilities</th><th>Actions</th></tr></thead>
              <tbody>
                ${packs.length === 0
                  ? '<tr><td colspan="4">No connector packs.</td></tr>'
                  : packs.map(pack => `
                    <tr>
                      <td>${esc(pack.id)}</td>
                      <td>${esc(pack.name)}</td>
                      <td>${esc((pack.allowedCapabilities || []).join(', ') || '-')}</td>
                      <td>
                        <button class="btn btn-secondary connectors-pack-edit" data-pack-id="${escAttr(pack.id)}">Edit</button>
                        <button class="btn btn-secondary connectors-pack-delete" data-pack-id="${escAttr(pack.id)}">Delete</button>
                      </td>
                    </tr>
                  `).join('')}
              </tbody>
            </table>
            <div class="cfg-field" style="margin-top:0.75rem">
              <label>Pack JSON (upsert)</label>
              <textarea id="connectors-pack-json" rows="6" placeholder='{"id":"...","name":"...","enabled":true,...}'></textarea>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="connectors-pack-upsert">Upsert Pack</button>
              <span id="connectors-pack-status" class="cfg-save-status"></span>
            </div>
          </div>

          <div class="cfg-center-body">
            <h4 style="margin-bottom:0.5rem">Playbook JSON Editor</h4>
            <div class="cfg-field">
              <label>Playbook JSON (upsert)</label>
              <textarea id="connectors-playbook-json" rows="8" placeholder='{"id":"...","name":"...","enabled":true,"mode":"sequential","steps":[...]}'></textarea>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="connectors-playbook-upsert">Upsert Playbook</button>
              <span id="connectors-playbook-status" class="cfg-save-status"></span>
            </div>
          </div>
        </div>
      </div>
    `;

    // ── Event listeners ──

    panel.querySelector('#connectors-refresh')?.addEventListener('click', () => renderConnectorsTab(panel));

    // Playbook run/dry-run
    panel.querySelectorAll('.connectors-playbook-run, .connectors-playbook-dryrun').forEach(button => {
      button.addEventListener('click', async () => {
        const playbookId = button.getAttribute('data-playbook-id');
        if (!playbookId) return;
        const dryRun = button.classList.contains('connectors-playbook-dryrun');
        button.disabled = true;
        button.textContent = dryRun ? 'Running dry...' : 'Running...';
        try {
          const result = await api.runPlaybook({
            playbookId, dryRun, origin: 'web', channel: 'web', userId: 'web-user', requestedBy: 'web-user',
          });
          const resultsDiv = panel.querySelector('#playbook-run-results');
          if (resultsDiv && result.run) {
            resultsDiv.innerHTML = `
              <div style="margin-top:0.75rem;padding:1rem;background:var(--bg-secondary);border-radius:8px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                  <strong>${esc(result.run.playbookName || playbookId)}</strong>
                  <span style="color:${result.success ? 'var(--success)' : 'var(--error)'}">${esc(result.status)} (${result.run.durationMs}ms)</span>
                </div>
                ${renderStepResults(result.run.steps || [])}
              </div>
            `;
          }
        } catch (err) {
          const resultsDiv = panel.querySelector('#playbook-run-results');
          if (resultsDiv) resultsDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        }
        button.disabled = false;
        button.textContent = dryRun ? 'Dry Run' : 'Run';
      });
    });

    // Run details toggle
    panel.querySelectorAll('.run-details-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const runId = btn.getAttribute('data-run-id');
        const row = panel.querySelector(`#run-detail-${runId}`);
        if (row) {
          const visible = row.style.display !== 'none';
          row.style.display = visible ? 'none' : '';
          btn.textContent = visible ? 'Show' : 'Hide';
        }
      });
    });

    // Advanced toggle
    panel.querySelector('#advanced-toggle')?.addEventListener('click', () => {
      const advPanel = panel.querySelector('#advanced-panel');
      const arrow = panel.querySelector('#advanced-arrow');
      if (advPanel) {
        const visible = advPanel.style.display !== 'none';
        advPanel.style.display = visible ? 'none' : '';
        if (arrow) arrow.innerHTML = visible ? '&#9654; Show' : '&#9660; Hide';
      }
    });

    // Settings save
    panel.querySelector('#connectors-settings-save')?.addEventListener('click', async () => {
      const statusEl = panel.querySelector('#connectors-settings-status');
      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.updateConnectorsSettings({
          enabled: panel.querySelector('#connectors-enabled').value === 'true',
          executionMode: panel.querySelector('#connectors-mode').value,
          maxConnectorCallsPerRun: Number(panel.querySelector('#connectors-max-calls').value),
          playbooks: {
            enabled: true,
            maxSteps: Number(panel.querySelector('#connectors-max-steps').value),
            maxParallelSteps: Number(panel.querySelector('#connectors-max-parallel').value),
            defaultStepTimeoutMs: Number(panel.querySelector('#connectors-step-timeout').value),
            requireSignedDefinitions: panel.querySelector('#connectors-require-signed').value === 'true',
            requireDryRunOnFirstExecution: panel.querySelector('#connectors-require-dryrun').value === 'true',
          },
          studio: {
            enabled: panel.querySelector('#connectors-studio-enabled').value === 'true',
            mode: panel.querySelector('#connectors-studio-mode').value,
          },
        });
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });

    // Pack upsert
    panel.querySelector('#connectors-pack-upsert')?.addEventListener('click', async () => {
      const statusEl = panel.querySelector('#connectors-pack-status');
      statusEl.textContent = 'Saving...';
      try {
        const raw = panel.querySelector('#connectors-pack-json').value.trim();
        const result = await api.upsertConnectorPack(JSON.parse(raw));
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) await renderConnectorsTab(panel);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });

    panel.querySelectorAll('.connectors-pack-delete').forEach(button => {
      button.addEventListener('click', async () => {
        const packId = button.getAttribute('data-pack-id');
        if (!packId || !confirm(`Delete pack '${packId}'?`)) return;
        await api.deleteConnectorPack(packId);
        await renderConnectorsTab(panel);
      });
    });

    panel.querySelectorAll('.connectors-pack-edit').forEach(button => {
      button.addEventListener('click', () => {
        const packId = button.getAttribute('data-pack-id');
        const pack = packs.find(p => p.id === packId);
        if (!pack) return;
        panel.querySelector('#connectors-pack-json').value = JSON.stringify(pack, null, 2);
        const advPanel = panel.querySelector('#advanced-panel');
        if (advPanel) advPanel.style.display = '';
      });
    });

    // Playbook upsert
    panel.querySelector('#connectors-playbook-upsert')?.addEventListener('click', async () => {
      const statusEl = panel.querySelector('#connectors-playbook-status');
      statusEl.textContent = 'Saving...';
      try {
        const raw = panel.querySelector('#connectors-playbook-json').value.trim();
        const result = await api.upsertPlaybook(JSON.parse(raw));
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) await renderConnectorsTab(panel);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });

    panel.querySelectorAll('.connectors-playbook-delete').forEach(button => {
      button.addEventListener('click', async () => {
        const playbookId = button.getAttribute('data-playbook-id');
        if (!playbookId || !confirm(`Delete playbook '${playbookId}'?`)) return;
        await api.deletePlaybook(playbookId);
        await renderConnectorsTab(panel);
      });
    });

    applyInputTooltips(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderStepResults(steps) {
  if (!steps || steps.length === 0) return '<div style="color:var(--text-muted)">No steps</div>';
  return `<div style="font-size:0.85rem">${steps.map((step, i) => {
    const statusColor = step.status === 'succeeded' ? 'var(--success)' : step.status === 'failed' ? 'var(--error)' : 'var(--warning)';
    const hasOutput = step.output != null && step.output !== '';
    const outputId = `step-output-${i}-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:4px 0;border-bottom:1px solid var(--border)">
        <span style="color:${statusColor};font-weight:bold;min-width:18px">${step.status === 'succeeded' ? '&#10003;' : step.status === 'failed' ? '&#10007;' : '&#9679;'}</span>
        <span style="min-width:140px;font-weight:500">${esc(step.toolName)}</span>
        <span style="color:var(--text-muted)">${esc(step.message || '')}</span>
        <span style="margin-left:auto;color:var(--text-muted)">${step.durationMs}ms</span>
        ${hasOutput ? `<button class="btn btn-secondary step-output-toggle" data-output-id="${outputId}" style="font-size:0.75rem;padding:2px 6px">Output</button>` : ''}
      </div>
      ${hasOutput ? `<div id="${outputId}" style="display:none;padding:4px 0 4px 28px;max-height:300px;overflow:auto"><pre style="font-size:0.8rem;background:var(--bg-primary);padding:0.5rem;border-radius:4px;white-space:pre-wrap;word-break:break-word">${esc(typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2))}</pre></div>` : ''}
    `;
  }).join('')}</div>`;
}

// ─── Devices Tab ─────────────────────────────────────────

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
            <tr><th>Status</th><th>IP Address</th><th>MAC Address</th><th>Hostname</th><th>Open Ports</th><th>First Seen</th><th>Last Seen</th></tr>
          </thead>
          <tbody>
            ${devices.length === 0
              ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No devices discovered. Click "Scan Now" above to discover devices on your network.</td></tr>'
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

    panel.querySelector('#network-scan-btn')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#network-scan-btn');
      const statusDiv = panel.querySelector('#network-scan-status');
      btn.disabled = true;
      btn.textContent = 'Scanning...';
      statusDiv.innerHTML = '<div style="color:var(--text-muted);padding:0.5rem">Running network scan...</div>';
      try {
        const result = await api.networkScan();
        statusDiv.innerHTML = `<div style="color:${result.success ? 'var(--success)' : 'var(--error)'};padding:0.5rem">${esc(result.message)} (${result.devicesFound || 0} devices found)</div>`;
        setTimeout(() => renderDevicesTab(panel), 1500);
      } catch (err) {
        statusDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        btn.disabled = false;
        btn.textContent = 'Scan Now';
      }
    });

    panel.querySelector('#network-refresh-btn')?.addEventListener('click', () => renderDevicesTab(panel));

  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

// ─── Utilities ───────────────────────────────────────────

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function formatTime(ts) {
  if (!ts) return '-';
  try { return new Date(ts).toLocaleString(); } catch { return '-'; }
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

// Delegated event listener for step output toggles (shared)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.step-output-toggle');
  if (!btn) return;
  const outputId = btn.getAttribute('data-output-id');
  if (!outputId) return;
  const el = document.getElementById(outputId);
  if (el) {
    const visible = el.style.display !== 'none';
    el.style.display = visible ? 'none' : '';
    btn.textContent = visible ? 'Output' : 'Hide';
  }
});
