/**
 * Connector + Playbook control plane.
 *
 * Template gallery first, then installed playbooks, run history,
 * and advanced settings (collapsed by default).
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderConnectors(container) {
  container.innerHTML = '<h2 class="page-title">Connectors</h2><div class="loading">Loading...</div>';

  try {
    const [state, templates] = await Promise.all([
      api.connectorsState(40),
      api.connectorsTemplates().catch(() => []),
    ]);
    const summary = state.summary || {};
    const packs = state.packs || [];
    const playbooks = state.playbooks || [];
    const runs = state.runs || [];
    const playbooksConfig = state.playbooksConfig || {};
    const studio = state.studio || {};

    container.innerHTML = `
      <h2 class="page-title">Connectors</h2>

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

      <!-- Template Gallery -->
      ${templates.length > 0 ? `
      <div class="table-container">
        <div class="table-header">
          <h3>Template Gallery</h3>
          <span style="color:var(--text-muted);font-size:0.85rem">One-click install — no configuration needed</span>
        </div>
        <div class="template-gallery" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;padding:1rem">
          ${templates.map((t) => `
            <div class="status-card ${t.installed ? 'success' : 'info'}" style="cursor:default;position:relative">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                <span class="card-title" style="margin:0">${esc(t.name)}</span>
                <span style="font-size:0.75rem;padding:2px 8px;border-radius:12px;background:${t.installed ? 'var(--success)' : 'var(--bg-secondary)'};color:${t.installed ? '#fff' : 'var(--text-muted)'}">${t.installed ? 'Installed' : t.category}</span>
              </div>
              <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.75rem;min-height:2.5em">${esc(t.description)}</div>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:0.8rem;color:var(--text-muted)">${t.playbookCount} playbook${t.playbookCount !== 1 ? 's' : ''}</span>
                ${t.installed
                  ? '<span style="font-size:0.85rem;color:var(--success)">Installed</span>'
                  : `<button class="btn btn-primary template-install" data-template-id="${escAttr(t.id)}">Install</button>`
                }
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <!-- Installed Playbooks -->
      <div class="table-container">
        <div class="table-header">
          <h3>Playbooks</h3>
          <button class="btn btn-secondary" id="connectors-refresh">Refresh</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Mode</th>
              <th>Steps</th>
              <th>Schedule</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${playbooks.length === 0
              ? '<tr><td colspan="6">No playbooks configured. Install a template above to get started.</td></tr>'
              : playbooks.map((playbook) => `
                <tr>
                  <td>${esc(playbook.id)}</td>
                  <td>${esc(playbook.name)}</td>
                  <td>${esc(playbook.mode)}</td>
                  <td>${Number(playbook.steps?.length || 0)}</td>
                  <td>${esc(playbook.schedule || '-')}</td>
                  <td>
                    <button class="btn btn-primary connectors-playbook-run" data-playbook-id="${escAttr(playbook.id)}">Run</button>
                    <button class="btn btn-secondary connectors-playbook-dryrun" data-playbook-id="${escAttr(playbook.id)}">Dry Run</button>
                    <button class="btn btn-secondary connectors-playbook-delete" data-playbook-id="${escAttr(playbook.id)}">Delete</button>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
        <div id="playbook-run-results" style="padding:0 1rem 1rem"></div>
      </div>

      <!-- Recent Runs -->
      <div class="table-container">
        <div class="table-header"><h3>Recent Runs</h3></div>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Playbook</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Steps</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${runs.length === 0
              ? '<tr><td colspan="6">No runs yet.</td></tr>'
              : runs.map((run) => `
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

      <!-- Advanced Settings (collapsed) -->
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
              <thead>
                <tr>
                  <th>ID</th><th>Name</th><th>Capabilities</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${packs.length === 0
                  ? '<tr><td colspan="4">No connector packs.</td></tr>'
                  : packs.map((pack) => `
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

    // Template install
    container.querySelectorAll('.template-install').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const templateId = btn.getAttribute('data-template-id');
        if (!templateId) return;
        btn.disabled = true;
        btn.textContent = 'Installing...';
        try {
          const result = await api.installTemplate(templateId);
          if (result.success) {
            await renderConnectors(container);
          } else {
            btn.textContent = result.message || 'Failed';
          }
        } catch (err) {
          btn.textContent = 'Error';
          btn.disabled = false;
        }
      });
    });

    // Refresh
    container.querySelector('#connectors-refresh')?.addEventListener('click', () => renderConnectors(container));

    // Playbook run/dry-run with inline results
    container.querySelectorAll('.connectors-playbook-run, .connectors-playbook-dryrun').forEach((button) => {
      button.addEventListener('click', async () => {
        const playbookId = button.getAttribute('data-playbook-id');
        if (!playbookId) return;
        const dryRun = button.classList.contains('connectors-playbook-dryrun');
        button.disabled = true;
        button.textContent = dryRun ? 'Running dry...' : 'Running...';
        try {
          const result = await api.runPlaybook({
            playbookId,
            dryRun,
            origin: 'web',
            channel: 'web',
            userId: 'web-user',
            requestedBy: 'web-user',
          });
          const resultsDiv = container.querySelector('#playbook-run-results');
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
          const resultsDiv = container.querySelector('#playbook-run-results');
          if (resultsDiv) {
            resultsDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
          }
        }
        button.disabled = false;
        button.textContent = dryRun ? 'Dry Run' : 'Run';
      });
    });

    // Run details toggle
    container.querySelectorAll('.run-details-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const runId = btn.getAttribute('data-run-id');
        const row = container.querySelector(`#run-detail-${runId}`);
        if (row) {
          const visible = row.style.display !== 'none';
          row.style.display = visible ? 'none' : '';
          btn.textContent = visible ? 'Show' : 'Hide';
        }
      });
    });

    // Advanced toggle
    container.querySelector('#advanced-toggle')?.addEventListener('click', () => {
      const panel = container.querySelector('#advanced-panel');
      const arrow = container.querySelector('#advanced-arrow');
      if (panel) {
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : '';
        if (arrow) arrow.innerHTML = visible ? '&#9654; Show' : '&#9660; Hide';
      }
    });

    // Settings save
    container.querySelector('#connectors-settings-save')?.addEventListener('click', async () => {
      const status = container.querySelector('#connectors-settings-status');
      status.textContent = 'Saving...';
      status.style.color = 'var(--text-muted)';
      try {
        const result = await api.updateConnectorsSettings({
          enabled: container.querySelector('#connectors-enabled').value === 'true',
          executionMode: container.querySelector('#connectors-mode').value,
          maxConnectorCallsPerRun: Number(container.querySelector('#connectors-max-calls').value),
          playbooks: {
            enabled: true,
            maxSteps: Number(container.querySelector('#connectors-max-steps').value),
            maxParallelSteps: Number(container.querySelector('#connectors-max-parallel').value),
            defaultStepTimeoutMs: Number(container.querySelector('#connectors-step-timeout').value),
            requireSignedDefinitions: container.querySelector('#connectors-require-signed').value === 'true',
            requireDryRunOnFirstExecution: container.querySelector('#connectors-require-dryrun').value === 'true',
          },
          studio: {
            enabled: container.querySelector('#connectors-studio-enabled').value === 'true',
            mode: container.querySelector('#connectors-studio-mode').value,
          },
        });
        status.textContent = result.message;
        status.style.color = result.success ? 'var(--success)' : 'var(--error)';
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        status.style.color = 'var(--error)';
      }
    });

    // Pack upsert
    container.querySelector('#connectors-pack-upsert')?.addEventListener('click', async () => {
      const status = container.querySelector('#connectors-pack-status');
      status.textContent = 'Saving...';
      try {
        const raw = container.querySelector('#connectors-pack-json').value.trim();
        const result = await api.upsertConnectorPack(JSON.parse(raw));
        status.textContent = result.message;
        status.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) await renderConnectors(container);
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        status.style.color = 'var(--error)';
      }
    });

    container.querySelectorAll('.connectors-pack-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        const packId = button.getAttribute('data-pack-id');
        if (!packId || !confirm(`Delete pack '${packId}'?`)) return;
        await api.deleteConnectorPack(packId);
        await renderConnectors(container);
      });
    });

    container.querySelectorAll('.connectors-pack-edit').forEach((button) => {
      button.addEventListener('click', () => {
        const packId = button.getAttribute('data-pack-id');
        const pack = packs.find((p) => p.id === packId);
        if (!pack) return;
        container.querySelector('#connectors-pack-json').value = JSON.stringify(pack, null, 2);
        // Expand advanced panel
        const panel = container.querySelector('#advanced-panel');
        if (panel) panel.style.display = '';
      });
    });

    // Playbook upsert
    container.querySelector('#connectors-playbook-upsert')?.addEventListener('click', async () => {
      const status = container.querySelector('#connectors-playbook-status');
      status.textContent = 'Saving...';
      try {
        const raw = container.querySelector('#connectors-playbook-json').value.trim();
        const result = await api.upsertPlaybook(JSON.parse(raw));
        status.textContent = result.message;
        status.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) await renderConnectors(container);
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        status.style.color = 'var(--error)';
      }
    });

    container.querySelectorAll('.connectors-playbook-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        const playbookId = button.getAttribute('data-playbook-id');
        if (!playbookId || !confirm(`Delete playbook '${playbookId}'?`)) return;
        await api.deletePlaybook(playbookId);
        await renderConnectors(container);
      });
    });

    applyInputTooltips(container);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Connectors</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

/** Render step-by-step results with expandable output */
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

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

// Delegated event listener for step output toggles
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
