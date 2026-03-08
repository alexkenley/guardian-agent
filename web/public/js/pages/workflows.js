/**
 * Workflows page - multi-step automation management.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderWorkflows(container) {
  container.innerHTML = '<h2 class="page-title">Workflows</h2><div class="loading">Loading...</div>';

  try {
    const [state, toolsState] = await Promise.all([
      api.connectorsState(40),
      api.toolsState(500).catch(() => ({ tools: [] })),
    ]);
    const summary = state.summary || {};
    const packs = state.packs || [];
    const workflows = state.playbooks || [];
    const runs = state.runs || [];
    const workflowConfig = state.playbooksConfig || {};
    const studio = state.studio || {};

    // Derive category for each workflow from its tools' categories
    const toolMap = {};
    for (const t of (toolsState?.tools || [])) { toolMap[t.name] = t; }
    const workflowCategories = {};
    for (const wf of workflows) {
      const cats = {};
      for (const step of (wf.steps || [])) {
        const cat = toolMap[step.toolName]?.category;
        if (cat) cats[cat] = (cats[cat] || 0) + 1;
      }
      // Primary = most-used category; fallback to 'uncategorized'
      const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
      workflowCategories[wf.id] = sorted.length > 0 ? sorted[0][0] : 'uncategorized';
    }
    const allCategories = [...new Set(Object.values(workflowCategories))].sort();

    container.innerHTML = `
      <h2 class="page-title">Workflows</h2>

      <div class="intel-summary-grid">
        <div class="status-card ${summary.enabled ? 'success' : 'warning'}">
          <div class="card-title">Workflow Engine</div>
          <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Execution mode: ${esc(summary.executionMode || 'plan_then_execute')}</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Policies</div>
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
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <button class="btn btn-primary" id="workflow-create-toggle">Create Workflow</button>
            <button class="btn btn-secondary" id="workflow-refresh">Refresh</button>
          </div>
        </div>
        ${allCategories.length > 1 ? `
        <div class="wf-category-bar" id="wf-category-filter">
          <button class="wf-category-chip active" data-category="all">All</button>
          ${allCategories.map((cat) => {
            const count = Object.values(workflowCategories).filter((c) => c === cat).length;
            return `<button class="wf-category-chip" data-category="${escAttr(cat)}">${esc(cat)} <span class="wf-category-count">${count}</span></button>`;
          }).join('')}
        </div>
        ` : ''}
        <div class="cfg-center-body" id="workflow-create-form" style="display:none">
          <div class="cfg-form-grid">
            <div class="cfg-field">
              <label>Name</label>
              <input id="wf-create-name" type="text" placeholder="My Workflow">
            </div>
            <div class="cfg-field">
              <label>ID</label>
              <input id="wf-create-id" type="text" placeholder="my-workflow">
            </div>
            <div class="cfg-field">
              <label>Mode</label>
              <select id="wf-create-mode">
                <option value="sequential">Sequential</option>
                <option value="parallel">Parallel</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Enabled</label>
              <select id="wf-create-enabled">
                <option value="false" selected>No</option>
                <option value="true">Yes</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Permission Policy</label>
              <select id="wf-create-pack" title="Controls what hosts, paths, and commands each step is allowed to access">
                ${packs.map((pack) => `<option value="${escAttr(pack.id)}">${esc(pack.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="cfg-field" style="margin-top:0.5rem;">
            <label>Description</label>
            <input id="wf-create-description" type="text" placeholder="What this workflow does">
          </div>
          <div style="margin-top:0.75rem;">
            <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:0.35rem;">Steps</label>
            <div id="wf-step-list"></div>
            <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;">
              <div class="cfg-field" style="flex:1;margin:0;">
                <select id="wf-step-tool-select">
                  <option value="">Select a tool to add...</option>
                  ${(toolsState?.tools || [])
                    .slice()
                    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
                    .map((tool) => `<option value="${escAttr(tool.name)}">${esc(tool.category ? tool.name + ' (' + tool.category + ')' : tool.name)}</option>`)
                    .join('')}
                </select>
              </div>
              <button class="btn btn-secondary" id="wf-step-add" type="button">Add Step</button>
            </div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.35rem;">Add tools in the order they should execute. Drag steps to reorder, or use the arrow and remove buttons.</div>
          </div>
          <div class="cfg-actions">
            <button class="btn btn-primary" id="wf-create-save">Create</button>
            <button class="btn btn-secondary" id="wf-create-cancel">Cancel</button>
            <span id="wf-create-status" class="cfg-save-status"></span>
          </div>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Mode</th><th>Tools</th><th title="Disabled workflows cannot be executed via the assistant, scheduled tasks, or manual runs">Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${workflows.length === 0
              ? '<tr><td colspan="5">No workflows configured.</td></tr>'
              : workflows.map((workflow) => {
                  const steps = workflow.steps || [];
                  const toolLookup = (toolsState?.tools || []);
                  const wfCategory = workflowCategories[workflow.id] || 'uncategorized';
                  return `
                <tr class="wf-catalog-row" data-category="${escAttr(wfCategory)}">
                  <td>
                    <div>${esc(workflow.name)}</div>
                    <div class="ops-task-sub">${esc(workflow.description || workflow.id)}</div>
                    <span class="wf-category-tag">${esc(wfCategory)}</span>
                  </td>
                  <td><span class="wf-pipeline-mode-badge ${workflow.mode}">${esc(workflow.mode)}</span></td>
                  <td>
                    <div class="wf-catalog-tools">
                      ${steps.length === 0
                        ? '<span style="color:var(--text-muted);font-size:0.75rem">No steps</span>'
                        : steps.map((step, si) => {
                            const sep = workflow.mode === 'parallel'
                              ? (si < steps.length - 1 ? '<span class="wf-tool-parallel-bar">||</span>' : '')
                              : (si < steps.length - 1 ? '<span class="wf-tool-arrow">&#9654;</span>' : '');
                            return `<span class="wf-tool-chip"><span class="wf-tool-chip-num">${si + 1}</span>${esc(step.toolName)}</span>${sep}`;
                          }).join('')
                      }
                    </div>
                    ${steps.length > 0 ? `<button class="wf-expand-btn wf-pipeline-toggle" data-workflow-id="${escAttr(workflow.id)}" style="margin-top:0.35rem"><span class="wf-expand-icon">&#9654;</span> Pipeline</button>` : ''}
                  </td>
                  <td>
                    <div class="ops-state-cell">
                      <span class="badge ${workflow.enabled ? 'badge-ready' : 'badge-dead'}">${workflow.enabled ? 'Enabled' : 'Disabled'}</span>
                      <label class="toggle-switch" style="margin:0;" title="${workflow.enabled ? 'Disable this workflow (prevents execution)' : 'Enable this workflow (allows execution)'}">
                        <input type="checkbox" class="workflow-toggle" data-workflow-id="${escAttr(workflow.id)}" ${workflow.enabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                  </td>
                  <td>
                    <div class="ops-action-buttons">
                      <button class="btn btn-primary btn-sm workflow-run" data-workflow-id="${escAttr(workflow.id)}" ${!workflow.enabled ? 'disabled title="Enable workflow first"' : ''}>Run</button>
                      <button class="btn btn-secondary btn-sm workflow-dryrun" data-workflow-id="${escAttr(workflow.id)}">Dry Run</button>
                      <button class="btn btn-secondary btn-sm workflow-delete" data-workflow-id="${escAttr(workflow.id)}">Delete</button>
                    </div>
                  </td>
                </tr>
                <tr class="wf-pipeline-row wf-catalog-row" data-category="${escAttr(wfCategory)}" id="wf-pipeline-${escAttr(workflow.id)}">
                  <td colspan="5" class="wf-pipeline-cell">
                    ${renderPipelineView(workflow, toolLookup, packs)}
                  </td>
                </tr>
              `;}).join('')
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
          <h3>Engine Settings</h3>
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
                <label>Max Calls / Run</label>
                <input id="workflow-max-calls" type="number" min="1" value="${esc(String(summary.maxConnectorCallsPerRun || 12))}">
              </div>
              <div class="cfg-field">
                <label>Max Steps</label>
                <input id="workflow-max-steps" type="number" min="1" value="${esc(String(workflowConfig.maxSteps || 12))}">
              </div>
              <div class="cfg-field">
                <label>Max Parallel</label>
                <input id="workflow-max-parallel" type="number" min="1" value="${esc(String(workflowConfig.maxParallelSteps || 3))}">
              </div>
              <div class="cfg-field">
                <label>Step Timeout (ms)</label>
                <input id="workflow-step-timeout" type="number" min="1000" value="${esc(String(workflowConfig.defaultStepTimeoutMs || 15000))}">
              </div>
              <div class="cfg-field">
                <label>Signed Definitions</label>
                <select id="workflow-require-signed">
                  <option value="true" ${workflowConfig.requireSignedDefinitions ? 'selected' : ''}>true</option>
                  <option value="false" ${!workflowConfig.requireSignedDefinitions ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Dry Run First</label>
                <select id="workflow-require-dryrun">
                  <option value="true" ${workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>true</option>
                  <option value="false" ${!workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>false</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Studio</label>
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
              <button class="btn btn-primary" id="workflow-settings-save">Save</button>
              <span id="workflow-settings-status" class="cfg-save-status"></span>
            </div>
          </div>

          <div class="cfg-center-body">
            <h4 style="margin-bottom:0.25rem">Permission Policies</h4>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.6rem">Each policy restricts what a workflow can access — allowed hosts, file paths, shell commands, and capabilities. Workflows run under a policy to prevent steps from reaching outside their sandbox.</div>
            <table>
              <thead><tr><th>ID</th><th>Name</th><th>Allowed Capabilities</th><th>Actions</th></tr></thead>
              <tbody>
                ${packs.length === 0
                  ? '<tr><td colspan="4">No permission policies defined.</td></tr>'
                  : packs.map((pack) => `
                    <tr>
                      <td>${esc(pack.id)}</td>
                      <td>${esc(pack.name)}</td>
                      <td>${esc((pack.allowedCapabilities || []).join(', ') || '-')}</td>
                      <td>
                        <button class="btn btn-secondary btn-sm workflow-pack-edit" data-pack-id="${escAttr(pack.id)}">Edit</button>
                        <button class="btn btn-secondary btn-sm workflow-pack-delete" data-pack-id="${escAttr(pack.id)}">Delete</button>
                      </td>
                    </tr>
                  `).join('')}
              </tbody>
            </table>
            <div class="cfg-field" style="margin-top:0.75rem">
              <label>Policy JSON (upsert)</label>
              <textarea id="workflow-pack-json" rows="4" placeholder='{"id":"...","name":"...","enabled":true,"allowedCapabilities":["network.read"],"allowedHosts":[],"allowedPaths":[],"allowedCommands":[]}'></textarea>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary" id="workflow-pack-upsert">Save Policy</button>
              <span id="workflow-pack-status" class="cfg-save-status"></span>
            </div>
          </div>
        </div>
      </div>
    `;

    bindWorkflowEvents(container, { packs, workflows, tools: toolsState?.tools || [], workflowCategories });
    applyInputTooltips(container);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Workflows</h2><div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function bindWorkflowEvents(container, context) {
  const { packs, workflows, tools, workflowCategories } = context;

  container.querySelector('#workflow-refresh')?.addEventListener('click', () => renderWorkflows(container));

  // Category filter
  container.querySelectorAll('.wf-category-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cat = chip.getAttribute('data-category');
      container.querySelectorAll('.wf-category-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      container.querySelectorAll('.wf-catalog-row').forEach((row) => {
        const match = cat === 'all' || row.getAttribute('data-category') === cat;
        if (row.classList.contains('wf-pipeline-row')) {
          // Pipeline rows use CSS class .visible for show/hide — just toggle a filter class
          row.classList.toggle('wf-filtered-out', !match);
        } else {
          row.style.display = match ? '' : 'none';
        }
      });
    });
  });

  // Create workflow form toggle
  const createToggle = container.querySelector('#workflow-create-toggle');
  const createForm = container.querySelector('#workflow-create-form');
  createToggle?.addEventListener('click', () => {
    const isOpen = createForm.style.display !== 'none';
    createForm.style.display = isOpen ? 'none' : '';
    createToggle.textContent = isOpen ? 'Create Workflow' : 'Close';
  });

  // Auto-generate ID from name
  container.querySelector('#wf-create-name')?.addEventListener('input', () => {
    const name = container.querySelector('#wf-create-name').value;
    container.querySelector('#wf-create-id').value = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  });

  container.querySelector('#wf-create-cancel')?.addEventListener('click', () => {
    createForm.style.display = 'none';
    createToggle.textContent = 'Create Workflow';
  });

  // Step builder
  const stepList = container.querySelector('#wf-step-list');
  const stepToolSelect = container.querySelector('#wf-step-tool-select');
  const wfSteps = [];

  function renderStepList() {
    if (wfSteps.length === 0) {
      stepList.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:0.5rem 0;">No steps added yet.</div>';
      return;
    }
    stepList.innerHTML = wfSteps.map((step, i) => {
      const tool = tools.find((t) => t.name === step.toolName);
      const desc = tool?.description || '';
      return `
        <div class="wf-step-row" data-index="${i}">
          <span class="wf-step-number">${i + 1}</span>
          <span class="wf-step-name">${esc(step.toolName)}</span>
          <span class="wf-step-desc">${esc(desc)}</span>
          <div class="wf-step-actions">
            <button class="btn btn-secondary btn-sm wf-step-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
            <button class="btn btn-secondary btn-sm wf-step-down" data-index="${i}" ${i === wfSteps.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
            <button class="btn btn-secondary btn-sm wf-step-remove" data-index="${i}" title="Remove">&times;</button>
          </div>
        </div>
      `;
    }).join('');

    stepList.querySelectorAll('.wf-step-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (idx > 0) { [wfSteps[idx - 1], wfSteps[idx]] = [wfSteps[idx], wfSteps[idx - 1]]; renderStepList(); }
      });
    });
    stepList.querySelectorAll('.wf-step-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (idx < wfSteps.length - 1) { [wfSteps[idx], wfSteps[idx + 1]] = [wfSteps[idx + 1], wfSteps[idx]]; renderStepList(); }
      });
    });
    stepList.querySelectorAll('.wf-step-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        wfSteps.splice(Number(btn.dataset.index), 1);
        renderStepList();
      });
    });
  }

  renderStepList();

  container.querySelector('#wf-step-add')?.addEventListener('click', () => {
    const toolName = stepToolSelect.value;
    if (!toolName) return;
    const packId = container.querySelector('#wf-create-pack')?.value || packs[0]?.id || 'default';
    const stepId = `step-${wfSteps.length + 1}`;
    wfSteps.push({ id: stepId, name: toolName, packId, toolName, args: {} });
    stepToolSelect.value = '';
    renderStepList();
  });

  container.querySelector('#wf-create-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#wf-create-status');
    const id = container.querySelector('#wf-create-id').value.trim();
    const name = container.querySelector('#wf-create-name').value.trim();
    const mode = container.querySelector('#wf-create-mode').value;
    const enabled = container.querySelector('#wf-create-enabled').value === 'true';
    const description = container.querySelector('#wf-create-description').value.trim();

    if (!id || !name) {
      statusEl.textContent = 'Name and ID are required.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    if (wfSteps.length === 0) {
      statusEl.textContent = 'Add at least one step.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const packId = container.querySelector('#wf-create-pack')?.value || packs[0]?.id || 'default';
      const steps = wfSteps.map((step, i) => ({
        ...step,
        id: `${id}-step-${i + 1}`,
        packId,
      }));
      const result = await api.upsertPlaybook({ id, name, mode, enabled, description, steps });
      statusEl.textContent = result.message || (result.success ? 'Created.' : 'Failed.');
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      if (result.success) {
        setTimeout(() => renderWorkflows(container), 350);
      }
    } catch (err) {
      statusEl.textContent = err.message || String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  // Pipeline expand/collapse
  container.querySelectorAll('.wf-pipeline-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const workflowId = btn.getAttribute('data-workflow-id');
      const row = container.querySelector(`#wf-pipeline-${workflowId}`);
      if (!row) return;
      const isVisible = row.classList.contains('visible');
      row.classList.toggle('visible', !isVisible);
      btn.classList.toggle('expanded', !isVisible);
    });
  });

  // Workflow enable/disable toggle
  container.querySelectorAll('.workflow-toggle').forEach((toggle) => {
    toggle.addEventListener('change', async () => {
      const workflowId = toggle.getAttribute('data-workflow-id');
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return;
      toggle.disabled = true;
      try {
        const updated = { ...workflow, enabled: toggle.checked };
        const result = await api.upsertPlaybook(updated);
        if (result.success) {
          await renderWorkflows(container);
        } else {
          toggle.checked = !toggle.checked;
          toggle.disabled = false;
        }
      } catch {
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    });
  });

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

  // Per-workflow inline JSON save (inside pipeline config panel)
  container.querySelectorAll('.wf-config-save').forEach((button) => {
    button.addEventListener('click', async () => {
      const workflowId = button.getAttribute('data-workflow-id');
      const textarea = container.querySelector(`.wf-config-json-editor[data-workflow-id="${workflowId}"]`);
      const statusEl = container.querySelector(`.wf-config-save-status[data-workflow-id="${workflowId}"]`);
      if (!textarea || !statusEl) return;
      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.upsertPlaybook(JSON.parse(textarea.value.trim()));
        statusEl.textContent = result.message || (result.success ? 'Saved.' : 'Failed.');
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) setTimeout(() => renderWorkflows(container), 500);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
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

function renderPipelineView(workflow, toolLookup, packs) {
  const steps = workflow.steps || [];
  if (steps.length === 0) return '<div style="padding:1rem;color:var(--text-muted)">No steps defined.</div>';

  const findTool = (name) => toolLookup.find((t) => t.name === name);

  const header = `
    <div class="wf-pipeline-header">
      <div class="wf-pipeline-title">
        <span>${esc(workflow.name)}</span>
        <span class="wf-pipeline-mode-badge ${workflow.mode}">${esc(workflow.mode)}</span>
      </div>
      <div class="wf-pipeline-step-count">${steps.length} step${steps.length !== 1 ? 's' : ''}</div>
    </div>
  `;

  let pipelineBody;

  if (workflow.mode === 'parallel') {
    const lanes = steps.map((step, i) => {
      const tool = findTool(step.toolName);
      const cat = tool?.category || '';
      const argKeys = Object.keys(step.args || {});
      const argSummary = argKeys.length > 0 ? argKeys.join(', ') : '';
      const settings = [];
      if (step.timeoutMs) settings.push(`<span class="wf-pipeline-setting-tag timeout">${step.timeoutMs}ms</span>`);
      if (step.continueOnError) settings.push(`<span class="wf-pipeline-setting-tag continue-on-error">continue-on-error</span>`);
      return `
        <div class="wf-pipeline-parallel-lane">
          <span class="wf-pipeline-lane-num">${i + 1}</span>
          <span class="wf-pipeline-lane-tool">${esc(step.toolName)}</span>
          ${cat ? `<span class="wf-pipeline-lane-category">${esc(cat)}</span>` : ''}
          ${argSummary ? `<span class="wf-pipeline-lane-args" title="${escAttr(JSON.stringify(step.args, null, 2))}">${esc(argSummary)}</span>` : ''}
          <div class="wf-pipeline-lane-settings">${settings.join('')}</div>
        </div>
      `;
    }).join('');

    pipelineBody = `
      <div class="wf-pipeline-parallel">
        <div class="wf-pipeline-parallel-header">
          <span class="wf-pipeline-parallel-icon">&#9781;</span>
          <span class="wf-pipeline-parallel-label">All steps execute concurrently</span>
        </div>
        <div class="wf-pipeline-parallel-tracks">${lanes}</div>
      </div>`;
  } else {
    // Sequential mode — horizontal pipeline nodes
    const nodes = steps.map((step, i) => {
      const tool = findTool(step.toolName);
      const cat = tool?.category || '';
      const argKeys = Object.keys(step.args || {});
      const argSummary = argKeys.length > 0 ? argKeys.join(', ') : '';
      const settings = [];
      if (step.timeoutMs) settings.push(`<span class="wf-pipeline-setting-tag timeout">${step.timeoutMs}ms</span>`);
      if (step.continueOnError) settings.push(`<span class="wf-pipeline-setting-tag continue-on-error">skip-on-fail</span>`);

      const connector = i < steps.length - 1
        ? `<div class="wf-pipeline-connector"><div class="wf-pipeline-connector-line"></div><div class="wf-pipeline-connector-arrow"></div></div>`
        : '';

      return `
        <div class="wf-pipeline-node">
          <div class="wf-pipeline-node-circle">${i + 1}</div>
          <div class="wf-pipeline-node-label">
            <div class="wf-pipeline-node-tool">${esc(step.toolName)}</div>
            ${cat ? `<div class="wf-pipeline-node-category">${esc(cat)}</div>` : ''}
            ${argSummary ? `<div class="wf-pipeline-node-args" title="${escAttr(JSON.stringify(step.args, null, 2))}">${esc(argSummary)}</div>` : ''}
            ${settings.length > 0 ? `<div style="margin-top:0.2rem;display:flex;gap:0.2rem;justify-content:center;flex-wrap:wrap">${settings.join('')}</div>` : ''}
          </div>
        </div>
        ${connector}
      `;
    }).join('');

    pipelineBody = `<div class="wf-pipeline-track">${nodes}</div>`;
  }

  // Nested config panel — per-workflow settings
  const usedPackIds = [...new Set(steps.map((s) => s.packId).filter(Boolean))];
  const usedPacks = (packs || []).filter((p) => usedPackIds.includes(p.id));

  const stepConfigs = steps.map((step, i) => {
    const tool = findTool(step.toolName);
    const cat = tool?.category || '';
    const hasArgs = step.args && Object.keys(step.args).length > 0;
    return `
      <div class="wf-config-step">
        <div class="wf-config-step-header">
          <span class="wf-config-step-num">${i + 1}</span>
          <span class="wf-config-step-tool">${esc(step.toolName)}</span>
          ${cat ? `<span class="wf-config-step-cat">${esc(cat)}</span>` : ''}
          <span class="wf-config-step-id">${esc(step.id)}</span>
        </div>
        <div class="wf-config-step-body">
          <div class="wf-config-step-fields">
            <div class="cfg-field">
              <label>Policy</label>
              <input type="text" value="${escAttr(step.packId || '')}" readonly style="opacity:0.7;cursor:default" title="Permission policy that restricts what this step can access">
            </div>
            <div class="cfg-field">
              <label>Timeout (ms)</label>
              <input type="text" value="${escAttr(step.timeoutMs ? String(step.timeoutMs) : 'default')}" readonly style="opacity:0.7;cursor:default">
            </div>
            <div class="cfg-field">
              <label>Continue on Error</label>
              <input type="text" value="${step.continueOnError ? 'yes' : 'no'}" readonly style="opacity:0.7;cursor:default">
            </div>
          </div>
          ${hasArgs ? `<div class="cfg-field" style="margin-top:0.35rem"><label>Arguments</label><pre class="wf-config-args-pre">${esc(JSON.stringify(step.args, null, 2))}</pre></div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const packInfo = usedPacks.length > 0 ? usedPacks.map((pack) => `
    <div class="wf-config-pack">
      <div class="wf-config-pack-name">${esc(pack.name)} <span style="color:var(--text-muted);font-size:0.65rem">${esc(pack.id)}</span></div>
      <div class="wf-config-pack-caps">Capabilities: ${esc((pack.allowedCapabilities || []).join(', ') || 'unrestricted')}</div>
      ${(pack.allowedHosts || []).length > 0 ? `<div class="wf-config-pack-detail">Allowed hosts: ${esc(pack.allowedHosts.join(', '))}</div>` : '<div class="wf-config-pack-detail">Hosts: unrestricted</div>'}
      ${(pack.allowedPaths || []).length > 0 ? `<div class="wf-config-pack-detail">Allowed paths: ${esc(pack.allowedPaths.join(', '))}</div>` : '<div class="wf-config-pack-detail">Paths: unrestricted</div>'}
      ${(pack.allowedCommands || []).length > 0 ? `<div class="wf-config-pack-detail">Allowed commands: ${esc(pack.allowedCommands.join(', '))}</div>` : '<div class="wf-config-pack-detail">Commands: none allowed</div>'}
      ${pack.requireHumanApprovalForWrites ? '<div class="wf-config-pack-detail" style="color:var(--warning)">Requires human approval for writes</div>' : ''}
    </div>
  `).join('') : '<div style="color:var(--text-muted);font-size:0.75rem">No permission policy assigned</div>';

  const configPanel = `
    <details class="wf-config-details">
      <summary class="wf-config-summary">
        <span class="wf-expand-icon" style="font-size:0.6rem">&#9654;</span>
        Workflow Configuration
      </summary>
      <div class="wf-config-body">
        <div class="wf-config-section">
          <div class="wf-config-section-title">Step Configuration</div>
          <div class="wf-config-steps">${stepConfigs}</div>
        </div>

        <div class="wf-config-section">
          <div class="wf-config-section-title">Connector Packs</div>
          ${packInfo}
        </div>

        <div class="wf-config-section">
          <div class="wf-config-section-title">Definition JSON</div>
          <textarea class="wf-config-json-editor" data-workflow-id="${escAttr(workflow.id)}" rows="8">${esc(JSON.stringify(workflow, null, 2))}</textarea>
          <div class="cfg-actions" style="margin-top:0.5rem">
            <button class="btn btn-primary btn-sm wf-config-save" data-workflow-id="${escAttr(workflow.id)}">Save Changes</button>
            <span class="wf-config-save-status cfg-save-status" data-workflow-id="${escAttr(workflow.id)}"></span>
          </div>
        </div>
      </div>
    </details>
  `;

  return `<div class="wf-pipeline-container">${header}${pipelineBody}${configPanel}</div>`;
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
