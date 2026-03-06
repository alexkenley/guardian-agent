/**
 * Workflows page - multi-step automation management.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderWorkflows(container) {
  container.innerHTML = '<h2 class="page-title">Workflows</h2><div class="loading">Loading...</div>';

  try {
    const state = await api.connectorsState(40);
    const summary = state.summary || {};
    const packs = state.packs || [];
    const workflows = state.playbooks || [];
    const runs = state.runs || [];
    const workflowConfig = state.playbooksConfig || {};
    const studio = state.studio || {};

    container.innerHTML = `
      <h2 class="page-title">Workflows</h2>

      <div class="intel-summary-grid">
        <div class="status-card ${summary.enabled ? 'success' : 'warning'}">
          <div class="card-title">Workflow Engine</div>
          <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Execution mode: ${esc(summary.executionMode || 'plan_then_execute')}</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Connector Packs</div>
          <div class="card-value">${Number(summary.packCount || 0)}</div>
          <div class="card-subtitle">${Number(summary.enabledPackCount || 0)} enabled</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Workflows</div>
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
          <h3>Workflow Catalog</h3>
          <button class="btn btn-secondary" id="workflow-refresh">Refresh</button>
        </div>
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Mode</th><th>Steps</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${workflows.length === 0
              ? '<tr><td colspan="6">No workflows configured.</td></tr>'
              : workflows.map((workflow) => `
                <tr>
                  <td>${esc(workflow.id)}</td>
                  <td>
                    <div>${esc(workflow.name)}</div>
                    <div class="ops-task-sub">${esc(workflow.description || '')}</div>
                  </td>
                  <td>${esc(workflow.mode)}</td>
                  <td>${Number(workflow.steps?.length || 0)}</td>
                  <td><span class="badge ${workflow.enabled ? 'badge-ready' : 'badge-dead'}">${workflow.enabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td>
                    <button class="btn btn-primary workflow-run" data-workflow-id="${escAttr(workflow.id)}">Run</button>
                    <button class="btn btn-secondary workflow-dryrun" data-workflow-id="${escAttr(workflow.id)}">Dry Run</button>
                    <button class="btn btn-secondary workflow-edit" data-workflow-id="${escAttr(workflow.id)}">Edit JSON</button>
                    <button class="btn btn-secondary workflow-delete" data-workflow-id="${escAttr(workflow.id)}">Delete</button>
                  </td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
        <div id="workflow-run-results" style="padding:0 1rem 1rem"></div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Workflow Runs</h3></div>
        <table>
          <thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Duration</th><th>Steps</th><th>Details</th></tr></thead>
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
                  <td><button class="btn btn-secondary workflow-run-details" data-run-id="${escAttr(run.id)}">Show</button></td>
                </tr>
                <tr class="workflow-run-details-row" id="workflow-run-detail-${escAttr(run.id)}" style="display:none">
                  <td colspan="6" style="padding:0.5rem 1rem;background:var(--bg-secondary)">
                    ${renderStepResults(run.steps || [])}
                  </td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header" style="cursor:pointer" id="workflow-advanced-toggle">
          <h3>Advanced Workflow Settings</h3>
          <span id="workflow-advanced-arrow" style="font-size:0.85rem;color:var(--text-muted)">&#9654; Show</span>
        </div>
        <div id="workflow-advanced-panel" style="display:none">
          <div class="cfg-center-body">
            <div class="cfg-form-grid">
              <div class="cfg-field">
                <label>Enabled</label>
                <select id="workflow-engine-enabled">
                  <option value="true" ${summary.enabled ? 'selected' : ''}>true</option>
                  <option value="false" ${!summary.enabled ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Execution Mode</label>
                <select id="workflow-engine-mode">
                  <option value="plan_then_execute" ${summary.executionMode === 'plan_then_execute' ? 'selected' : ''}>plan_then_execute</option>
                  <option value="direct_execute" ${summary.executionMode === 'direct_execute' ? 'selected' : ''}>direct_execute</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Max Tool Calls Per Run</label>
                <input id="workflow-max-calls" type="number" min="1" value="${esc(String(summary.maxConnectorCallsPerRun || 12))}">
              </div>
              <div class="cfg-field">
                <label>Max Steps</label>
                <input id="workflow-max-steps" type="number" min="1" value="${esc(String(workflowConfig.maxSteps || 12))}">
              </div>
              <div class="cfg-field">
                <label>Max Parallel Steps</label>
                <input id="workflow-max-parallel" type="number" min="1" value="${esc(String(workflowConfig.maxParallelSteps || 3))}">
              </div>
              <div class="cfg-field">
                <label>Default Step Timeout (ms)</label>
                <input id="workflow-step-timeout" type="number" min="1000" value="${esc(String(workflowConfig.defaultStepTimeoutMs || 15000))}">
              </div>
              <div class="cfg-field">
                <label>Require Signed Definitions</label>
                <select id="workflow-require-signed">
                  <option value="true" ${workflowConfig.requireSignedDefinitions ? 'selected' : ''}>true</option>
                  <option value="false" ${!workflowConfig.requireSignedDefinitions ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Require Dry Run First</label>
                <select id="workflow-require-dryrun">
                  <option value="true" ${workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>true</option>
                  <option value="false" ${!workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Studio Enabled</label>
                <select id="workflow-studio-enabled">
                  <option value="true" ${studio.enabled ? 'selected' : ''}>true</option>
                  <option value="false" ${!studio.enabled ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Studio Mode</label>
                <select id="workflow-studio-mode">
                  <option value="builder" ${studio.mode === 'builder' ? 'selected' : ''}>builder</option>
                  <option value="read_only" ${studio.mode === 'read_only' ? 'selected' : ''}>read_only</option>
                </select>
              </div>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="workflow-settings-save">Save Settings</button>
              <span id="workflow-settings-status" class="cfg-save-status"></span>
            </div>
          </div>

          <div class="cfg-center-body">
            <h4 style="margin-bottom:0.5rem">Connector Packs</h4>
            <table>
              <thead><tr><th>ID</th><th>Name</th><th>Capabilities</th><th>Actions</th></tr></thead>
              <tbody>
                ${packs.length === 0
                  ? '<tr><td colspan="4">No connector packs.</td></tr>'
                  : packs.map((pack) => `
                    <tr>
                      <td>${esc(pack.id)}</td>
                      <td>${esc(pack.name)}</td>
                      <td>${esc((pack.allowedCapabilities || []).join(', ') || '-')}</td>
                      <td>
                        <button class="btn btn-secondary workflow-pack-edit" data-pack-id="${escAttr(pack.id)}">Edit</button>
                        <button class="btn btn-secondary workflow-pack-delete" data-pack-id="${escAttr(pack.id)}">Delete</button>
                      </td>
                    </tr>
                  `).join('')}
              </tbody>
            </table>
            <div class="cfg-field" style="margin-top:0.75rem">
              <label>Pack JSON (upsert)</label>
              <textarea id="workflow-pack-json" rows="6" placeholder='{"id":"...","name":"...","enabled":true,...}'></textarea>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="workflow-pack-upsert">Upsert Pack</button>
              <span id="workflow-pack-status" class="cfg-save-status"></span>
            </div>
          </div>

          <div class="cfg-center-body">
            <h4 style="margin-bottom:0.5rem">Workflow JSON Editor</h4>
            <div class="cfg-field">
              <label>Workflow JSON (upsert)</label>
              <textarea id="workflow-json" rows="10" placeholder='{"id":"...","name":"...","enabled":true,"mode":"sequential","steps":[...]}'></textarea>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="workflow-upsert">Upsert Workflow</button>
              <span id="workflow-upsert-status" class="cfg-save-status"></span>
            </div>
          </div>
        </div>
      </div>
    `;

    bindWorkflowEvents(container, { packs, workflows });
    applyInputTooltips(container);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Workflows</h2><div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function bindWorkflowEvents(container, context) {
  const { packs, workflows } = context;

  container.querySelector('#workflow-refresh')?.addEventListener('click', () => renderWorkflows(container));

  container.querySelectorAll('.workflow-run, .workflow-dryrun').forEach((button) => {
    button.addEventListener('click', async () => {
      const workflowId = button.getAttribute('data-workflow-id');
      if (!workflowId) return;

      const dryRun = button.classList.contains('workflow-dryrun');
      button.disabled = true;
      button.textContent = dryRun ? 'Running dry...' : 'Running...';
      try {
        const result = await api.runPlaybook({
          playbookId: workflowId,
          dryRun,
          origin: 'web',
          channel: 'web',
          userId: 'web-user',
          requestedBy: 'web-user',
        });
        const resultsDiv = container.querySelector('#workflow-run-results');
        if (resultsDiv && result.run) {
          resultsDiv.innerHTML = `
            <div style="margin-top:0.75rem;padding:1rem;background:var(--bg-secondary);border-radius:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                <strong>${esc(result.run.playbookName || workflowId)}</strong>
                <span style="color:${result.success ? 'var(--success)' : 'var(--error)'}">${esc(result.status)} (${result.run.durationMs}ms)</span>
              </div>
              ${renderStepResults(result.run.steps || [])}
            </div>
          `;
        }
      } catch (err) {
        const resultsDiv = container.querySelector('#workflow-run-results');
        if (resultsDiv) {
          resultsDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        }
      }
      button.disabled = false;
      button.textContent = dryRun ? 'Dry Run' : 'Run';
    });
  });

  container.querySelectorAll('.workflow-run-details').forEach((button) => {
    button.addEventListener('click', () => {
      const runId = button.getAttribute('data-run-id');
      const row = container.querySelector(`#workflow-run-detail-${runId}`);
      if (!row) return;
      const visible = row.style.display !== 'none';
      row.style.display = visible ? 'none' : '';
      button.textContent = visible ? 'Show' : 'Hide';
    });
  });

  container.querySelector('#workflow-advanced-toggle')?.addEventListener('click', () => {
    const panel = container.querySelector('#workflow-advanced-panel');
    const arrow = container.querySelector('#workflow-advanced-arrow');
    if (!panel) return;
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    if (arrow) arrow.innerHTML = visible ? '&#9654; Show' : '&#9660; Hide';
  });

  container.querySelector('#workflow-settings-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#workflow-settings-status');
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConnectorsSettings({
        enabled: container.querySelector('#workflow-engine-enabled').value === 'true',
        executionMode: container.querySelector('#workflow-engine-mode').value,
        maxConnectorCallsPerRun: Number(container.querySelector('#workflow-max-calls').value),
        playbooks: {
          enabled: true,
          maxSteps: Number(container.querySelector('#workflow-max-steps').value),
          maxParallelSteps: Number(container.querySelector('#workflow-max-parallel').value),
          defaultStepTimeoutMs: Number(container.querySelector('#workflow-step-timeout').value),
          requireSignedDefinitions: container.querySelector('#workflow-require-signed').value === 'true',
          requireDryRunOnFirstExecution: container.querySelector('#workflow-require-dryrun').value === 'true',
        },
        studio: {
          enabled: container.querySelector('#workflow-studio-enabled').value === 'true',
          mode: container.querySelector('#workflow-studio-mode').value,
        },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  container.querySelector('#workflow-pack-upsert')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#workflow-pack-status');
    statusEl.textContent = 'Saving...';
    try {
      const raw = container.querySelector('#workflow-pack-json').value.trim();
      const result = await api.upsertConnectorPack(JSON.parse(raw));
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      if (result.success) await renderWorkflows(container);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  container.querySelectorAll('.workflow-pack-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const packId = button.getAttribute('data-pack-id');
      if (!packId || !confirm(`Delete pack '${packId}'?`)) return;
      await api.deleteConnectorPack(packId);
      await renderWorkflows(container);
    });
  });

  container.querySelectorAll('.workflow-pack-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const packId = button.getAttribute('data-pack-id');
      const pack = packs.find((candidate) => candidate.id === packId);
      if (!pack) return;
      container.querySelector('#workflow-pack-json').value = JSON.stringify(pack, null, 2);
      container.querySelector('#workflow-advanced-panel').style.display = '';
    });
  });

  container.querySelector('#workflow-upsert')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#workflow-upsert-status');
    statusEl.textContent = 'Saving...';
    try {
      const raw = container.querySelector('#workflow-json').value.trim();
      const result = await api.upsertPlaybook(JSON.parse(raw));
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      if (result.success) await renderWorkflows(container);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  container.querySelectorAll('.workflow-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const workflowId = button.getAttribute('data-workflow-id');
      const workflow = workflows.find((candidate) => candidate.id === workflowId);
      if (!workflow) return;
      container.querySelector('#workflow-json').value = JSON.stringify(workflow, null, 2);
      container.querySelector('#workflow-advanced-panel').style.display = '';
    });
  });

  container.querySelectorAll('.workflow-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const workflowId = button.getAttribute('data-workflow-id');
      if (!workflowId || !confirm(`Delete workflow '${workflowId}'?`)) return;
      await api.deletePlaybook(workflowId);
      await renderWorkflows(container);
    });
  });
}

function renderStepResults(steps) {
  if (!steps || steps.length === 0) return '<div style="color:var(--text-muted)">No steps</div>';
  return `<div style="font-size:0.85rem">${steps.map((step, index) => {
    const stepColor = step.status === 'succeeded' ? 'var(--success)' : step.status === 'failed' ? 'var(--error)' : 'var(--warning)';
    const hasOutput = step.output != null && step.output !== '';
    const outputId = `workflow-step-output-${index}-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:4px 0;border-bottom:1px solid var(--border)">
        <span style="color:${stepColor};font-weight:bold;min-width:18px">${step.status === 'succeeded' ? '&#10003;' : step.status === 'failed' ? '&#10007;' : '&#9679;'}</span>
        <span style="min-width:140px;font-weight:500">${esc(step.toolName)}</span>
        <span style="color:var(--text-muted)">${esc(step.message || '')}</span>
        <span style="margin-left:auto;color:var(--text-muted)">${step.durationMs}ms</span>
        ${hasOutput ? `<button class="btn btn-secondary workflow-step-output-toggle" data-output-id="${outputId}" style="font-size:0.75rem;padding:2px 6px">Output</button>` : ''}
      </div>
      ${hasOutput ? `<div id="${outputId}" style="display:none;padding:4px 0 4px 28px;max-height:300px;overflow:auto"><pre style="font-size:0.8rem;background:var(--bg-primary);padding:0.5rem;border-radius:4px;white-space:pre-wrap;word-break:break-word">${esc(typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2))}</pre></div>` : ''}
    `;
  }).join('')}</div>`;
}

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('.workflow-step-output-toggle');
  if (!button) return;
  const outputId = button.getAttribute('data-output-id');
  if (!outputId) return;
  const output = document.getElementById(outputId);
  if (!output) return;
  const visible = output.style.display !== 'none';
  output.style.display = visible ? 'none' : '';
  button.textContent = visible ? 'Output' : 'Hide';
});
