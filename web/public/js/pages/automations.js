/**
 * Automations page — unified view merging workflows + scheduled operations.
 *
 * Every item is an "automation": a playbook (1-step for single tools, N-step
 * for pipelines) with an optional linked scheduled task for cron execution.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;

// ─── Public API ───────────────────────────────────────────

export async function renderAutomations(container) {
  currentContainer = container;
  container.innerHTML = '<h2 class="page-title">Automations</h2><div class="loading">Loading...</div>';

  try {
    const [connState, toolsState, tasks, presets, history, templates] = await Promise.all([
      api.connectorsState(40),
      api.toolsState(500).catch(() => ({ tools: [] })),
      api.scheduledTasks().catch(() => []),
      api.scheduledTaskPresets().catch(() => []),
      api.scheduledTaskHistory().catch(() => []),
      api.connectorsTemplates().catch(() => []),
    ]);

    const summary = connState.summary || {};
    const packs = connState.packs || [];
    const playbooks = connState.playbooks || [];
    const runs = connState.runs || [];
    const workflowConfig = connState.playbooksConfig || {};
    const studio = connState.studio || {};
    const tools = Array.isArray(toolsState?.tools) ? toolsState.tools : [];

    const automations = buildAutomationList(playbooks, tasks, tools);
    const allCategories = [...new Set(automations.map((a) => a.category))].sort();
    const totalScheduled = automations.filter((a) => a.cron).length;
    const totalRuns = runs.length + tasks.reduce((sum, t) => sum + (t.runCount || 0), 0);

    container.innerHTML = `
      <h2 class="page-title">Automations</h2>

      <div class="intel-summary-grid">
        <div class="status-card ${summary.enabled ? 'success' : 'warning'}">
          <div class="card-title">Engine Status</div>
          <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Mode: ${esc(summary.executionMode || 'plan_then_execute')}</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Total Automations</div>
          <div class="card-value">${automations.length}</div>
          <div class="card-subtitle">${automations.filter((a) => a.enabled).length} enabled</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Scheduled</div>
          <div class="card-value">${totalScheduled}</div>
          <div class="card-subtitle">${totalScheduled} with cron</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Total Runs</div>
          <div class="card-value">${totalRuns}</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Automation Catalog</h3>
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <button class="btn btn-primary" id="auto-create-toggle">Create Automation</button>
            <button class="btn btn-secondary" id="auto-examples-toggle">Examples</button>
            <button class="btn btn-secondary" id="auto-refresh">Refresh</button>
          </div>
        </div>

        ${allCategories.length > 1 ? `
        <div class="wf-category-bar" id="auto-category-filter">
          <button class="wf-category-chip active" data-category="all">All</button>
          ${allCategories.map((cat) => {
            const count = automations.filter((a) => a.category === cat).length;
            return `<button class="wf-category-chip" data-category="${escAttr(cat)}">${esc(cat)} <span class="wf-category-count">${count}</span></button>`;
          }).join('')}
        </div>
        ` : ''}

        <!-- Examples panel -->
        <div class="auto-example-panel" id="auto-examples-panel" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
            <h4 style="margin:0;">Example Automations</h4>
            <button class="btn btn-secondary btn-sm" id="auto-examples-close">Close</button>
          </div>
          <div class="auto-example-grid">
            ${renderExampleCards(templates, presets)}
          </div>
        </div>

        <!-- Create form -->
        <div class="cfg-center-body" id="auto-create-form" style="display:none">
          ${renderCreateForm(tools, packs)}
        </div>

        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Tools</th><th>Schedule</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${automations.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No automations configured. Create one or install an example.</td></tr>'
              : automations.map((auto) => renderAutomationRow(auto, tools, packs)).join('')
            }
          </tbody>
        </table>
        <div id="auto-run-results" style="padding:0 1rem 1rem"></div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Run History</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Automation</th><th>Source</th><th>Status</th><th>Duration</th><th>Details</th></tr></thead>
          <tbody>
            ${renderRunHistory(runs, history)}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header" style="cursor:pointer" id="auto-engine-toggle">
          <h3>Engine Settings</h3>
          <span id="auto-engine-arrow" style="font-size:0.85rem;color:var(--text-muted)">&#9654; Show</span>
        </div>
        <div id="auto-engine-panel" style="display:none">
          ${renderEngineSettings(summary, workflowConfig, studio, packs)}
        </div>
      </div>
    `;

    bindEvents(container, { automations, playbooks, tasks, presets, tools, packs, templates, workflowConfig, summary, studio, runs, history });
    applyInputTooltips(container);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Automations</h2><div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

export async function updateAutomations() {
  if (currentContainer) await renderAutomations(currentContainer);
}

// ─── Data Model — merge playbooks + scheduled tasks ──────

function buildAutomationList(playbooks, tasks, tools) {
  const automations = [];
  const matchedTaskIds = new Set();

  // 1. For each playbook, create an automation and find linked scheduled task
  for (const pb of playbooks) {
    const linkedTask = tasks.find(
      (t) => (t.type === 'playbook' && t.target === pb.id) || (t.target === pb.id),
    );
    if (linkedTask) matchedTaskIds.add(linkedTask.id);

    automations.push({
      id: pb.id,
      name: pb.name,
      description: pb.description || '',
      category: deriveCategory(pb.steps || [], tools),
      kind: (pb.steps || []).length <= 1 ? 'single' : 'pipeline',
      mode: pb.mode || 'sequential',
      steps: pb.steps || [],
      packId: (pb.steps || [])[0]?.packId || null,
      enabled: pb.enabled !== false,
      cron: linkedTask?.cron || null,
      scheduleEnabled: linkedTask?.enabled || false,
      taskId: linkedTask?.id || null,
      lastRunAt: linkedTask?.lastRunAt || null,
      lastRunStatus: linkedTask?.lastRunStatus || null,
      runCount: linkedTask?.runCount || 0,
      _source: 'playbook',
      _playbook: pb,
      _task: linkedTask || null,
    });
  }

  // 2. Orphaned scheduled tasks (type 'tool', no matching playbook)
  for (const task of tasks) {
    if (matchedTaskIds.has(task.id)) continue;
    // Check if already linked by playbook target
    if (automations.some((a) => a.taskId === task.id)) continue;

    const tool = tools.find((t) => t.name === task.target);
    automations.push({
      id: task.id,
      name: task.name || task.target,
      description: tool?.description || '',
      category: tool?.category || 'uncategorized',
      kind: 'single',
      mode: 'sequential',
      steps: [{ id: 'step-1', name: task.target, toolName: task.target, packId: null, args: task.args || {} }],
      packId: null,
      enabled: task.enabled,
      cron: task.cron || null,
      scheduleEnabled: task.enabled,
      taskId: task.id,
      lastRunAt: task.lastRunAt || null,
      lastRunStatus: task.lastRunStatus || null,
      runCount: task.runCount || 0,
      _source: 'task',
      _playbook: null,
      _task: task,
    });
  }

  return automations;
}

function deriveCategory(steps, tools) {
  const cats = {};
  for (const step of steps) {
    const tool = tools.find((t) => t.name === step.toolName);
    const cat = tool?.category;
    if (cat) cats[cat] = (cats[cat] || 0) + 1;
  }
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : 'uncategorized';
}

// ─── Rendering helpers ──────────────────────────────────

function renderAutomationRow(auto, tools, packs) {
  const steps = auto.steps || [];
  const kindLabel = auto.kind === 'pipeline' ? 'Pipeline' : 'Single';
  const modeLabel = auto.kind === 'pipeline' ? auto.mode : '';
  const scheduleLabel = auto.cron ? cronToHuman(auto.cron) : 'Manual';

  return `
    <tr class="auto-catalog-row" data-category="${escAttr(auto.category)}" data-auto-id="${escAttr(auto.id)}">
      <td>
        <div class="ops-task-title">${esc(auto.name)}</div>
        <div class="ops-task-sub">${esc(auto.description || auto.id)}</div>
        <span class="wf-category-tag">${esc(auto.category)}</span>
      </td>
      <td>
        <span class="auto-kind-badge ${auto.kind}">${esc(kindLabel)}</span>
        ${modeLabel ? `<span class="wf-pipeline-mode-badge ${auto.mode}" style="margin-left:0.3rem">${esc(modeLabel)}</span>` : ''}
      </td>
      <td>
        <div class="wf-catalog-tools">
          ${steps.length === 0
            ? '<span style="color:var(--text-muted);font-size:0.75rem">No steps</span>'
            : steps.map((step, si) => {
                const sep = auto.mode === 'parallel'
                  ? (si < steps.length - 1 ? '<span class="wf-tool-parallel-bar">||</span>' : '')
                  : (si < steps.length - 1 ? '<span class="wf-tool-arrow">&#9654;</span>' : '');
                return `<span class="wf-tool-chip"><span class="wf-tool-chip-num">${si + 1}</span>${esc(step.toolName)}</span>${sep}`;
              }).join('')
          }
        </div>
        ${steps.length > 0 && auto.kind === 'pipeline' ? `<button class="wf-expand-btn auto-pipeline-toggle" data-auto-id="${escAttr(auto.id)}" style="margin-top:0.35rem"><span class="wf-expand-icon">&#9654;</span> Pipeline</button>` : ''}
      </td>
      <td class="auto-schedule-cell">
        <div class="ops-task-title">${esc(scheduleLabel)}</div>
        ${auto.cron ? `<div class="ops-task-sub">${esc(auto.cron)}</div>` : ''}
      </td>
      <td>
        <div class="ops-state-cell">
          <span class="badge ${auto.enabled ? 'badge-ready' : 'badge-dead'}">${auto.enabled ? 'Enabled' : 'Disabled'}</span>
          <label class="toggle-switch" style="margin:0;">
            <input type="checkbox" class="auto-toggle" data-auto-id="${escAttr(auto.id)}" ${auto.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </td>
      <td>
        <div class="ops-action-buttons">
          <button class="btn btn-primary btn-sm auto-run" data-auto-id="${escAttr(auto.id)}" ${!auto.enabled ? 'disabled title="Enable first"' : ''}>Run</button>
          <button class="btn btn-secondary btn-sm auto-dryrun" data-auto-id="${escAttr(auto.id)}">Dry Run</button>
          <button class="btn btn-secondary btn-sm auto-clone" data-auto-id="${escAttr(auto.id)}">Clone</button>
          <button class="btn btn-secondary btn-sm auto-delete" data-auto-id="${escAttr(auto.id)}" data-label="${escAttr(auto.name)}">Delete</button>
        </div>
      </td>
    </tr>
    ${auto.kind === 'pipeline' ? `
    <tr class="wf-pipeline-row auto-catalog-row" data-category="${escAttr(auto.category)}" id="auto-pipeline-${escAttr(auto.id)}">
      <td colspan="6" class="wf-pipeline-cell">
        ${renderPipelineView(auto, tools, packs)}
      </td>
    </tr>
    ` : ''}
  `;
}

function renderPipelineView(auto, toolLookup, packs) {
  const steps = auto.steps || [];
  if (steps.length === 0) return '<div style="padding:1rem;color:var(--text-muted)">No steps defined.</div>';
  const findTool = (name) => toolLookup.find((t) => t.name === name);

  const header = `
    <div class="wf-pipeline-header">
      <div class="wf-pipeline-title">
        <span>${esc(auto.name)}</span>
        <span class="wf-pipeline-mode-badge ${auto.mode}">${esc(auto.mode)}</span>
      </div>
      <div class="wf-pipeline-step-count">${steps.length} step${steps.length !== 1 ? 's' : ''}</div>
    </div>
  `;

  let pipelineBody;
  if (auto.mode === 'parallel') {
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
    const nodes = steps.map((step, i) => {
      const tool = findTool(step.toolName);
      const cat = tool?.category || '';
      const argKeys = Object.keys(step.args || {});
      const argSummary = argKeys.length > 0 ? argKeys.join(', ') : '';
      const settings = [];
      if (step.timeoutMs) settings.push(`<span class="wf-pipeline-setting-tag timeout">${step.timeoutMs}ms</span>`);
      if (step.continueOnError) settings.push(`<span class="wf-pipeline-setting-tag continue-on-error">skip-on-fail</span>`);
      const connector = i < steps.length - 1
        ? '<div class="wf-pipeline-connector"><div class="wf-pipeline-connector-line"></div><div class="wf-pipeline-connector-arrow"></div></div>'
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

  // Config panel
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
            <div class="cfg-field"><label>Tool Access</label><input type="text" value="${escAttr(formatStepAccess(step.packId, packs))}" readonly style="opacity:0.7;cursor:default"></div>
            <div class="cfg-field"><label>Timeout (ms)</label><input type="text" value="${escAttr(step.timeoutMs ? String(step.timeoutMs) : 'default')}" readonly style="opacity:0.7;cursor:default"></div>
            <div class="cfg-field"><label>Continue on Error</label><input type="text" value="${step.continueOnError ? 'yes' : 'no'}" readonly style="opacity:0.7;cursor:default"></div>
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
  `).join('') : '<div style="color:var(--text-muted);font-size:0.75rem">Using built-in tool access</div>';

  const playbookData = auto._playbook || { id: auto.id, name: auto.name, mode: auto.mode, steps, enabled: auto.enabled, description: auto.description };
  const configPanel = `
    <details class="wf-config-details">
      <summary class="wf-config-summary">
        <span class="wf-expand-icon" style="font-size:0.6rem">&#9654;</span>
        Automation Configuration
      </summary>
      <div class="wf-config-body">
        <div class="wf-config-section">
          <div class="wf-config-section-title">Step Configuration</div>
          <div class="wf-config-steps">${stepConfigs}</div>
        </div>
        <div class="wf-config-section">
          <div class="wf-config-section-title">Permission Policies</div>
          ${packInfo}
        </div>
        <div class="wf-config-section">
          <div class="wf-config-section-title">Definition JSON</div>
          <textarea class="wf-config-json-editor" data-auto-id="${escAttr(auto.id)}" rows="8">${esc(JSON.stringify(playbookData, null, 2))}</textarea>
          <div class="cfg-actions" style="margin-top:0.5rem">
            <button class="btn btn-primary btn-sm auto-config-save" data-auto-id="${escAttr(auto.id)}">Save Changes</button>
            <span class="auto-config-save-status cfg-save-status" data-auto-id="${escAttr(auto.id)}"></span>
          </div>
        </div>
      </div>
    </details>
  `;

  return `<div class="wf-pipeline-container">${header}${pipelineBody}${configPanel}</div>`;
}

function renderCreateForm(tools, packs) {
  const toolOptions = tools
    .slice()
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
    .map((tool) => `<option value="${escAttr(tool.name)}">${esc(tool.category ? tool.name + ' (' + tool.category + ')' : tool.name)}</option>`)
    .join('');

  return `
    <div class="cfg-form-grid">
      <div class="cfg-field">
        <label>Name</label>
        <input id="auto-create-name" type="text" placeholder="My Automation">
      </div>
      <div class="cfg-field">
        <label>ID</label>
        <input id="auto-create-id" type="text" placeholder="my-automation">
      </div>
      <div class="cfg-field">
        <label>Mode</label>
        <select id="auto-create-mode">
          <option value="single">Single Tool</option>
          <option value="sequential">Sequential Pipeline</option>
          <option value="parallel">Parallel Pipeline</option>
        </select>
      </div>
      <div class="cfg-field">
        <label>Tool Access</label>
        <select id="auto-create-pack" title="Built-in tools use the normal Guardian rules. Access profiles add extra host, path, and command limits.">
          <option value="">Built-in tools</option>
          ${packs.map((p) => `<option value="${escAttr(p.id)}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="cfg-field" style="margin-top:0.5rem;">
      <label>Description</label>
      <input id="auto-create-description" type="text" placeholder="What this automation does">
    </div>

    <!-- Single tool selector (shown when mode=single) -->
    <div id="auto-single-tool-section" style="margin-top:0.75rem;">
      <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:0.35rem;">Tool</label>
      <div class="cfg-field" style="margin:0;">
        <select id="auto-single-tool-select">
          <option value="">Select a tool...</option>
          ${toolOptions}
        </select>
      </div>
    </div>

    <!-- Pipeline step builder (shown when mode=sequential|parallel) -->
    <div id="auto-pipeline-section" style="margin-top:0.75rem;display:none;">
      <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:0.35rem;">Steps</label>
      <div id="auto-step-list"></div>
      <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;">
        <div class="cfg-field" style="flex:1;margin:0;">
          <select id="auto-step-tool-select">
            <option value="">Select a tool to add...</option>
            ${toolOptions}
          </select>
        </div>
        <button class="btn btn-secondary" id="auto-step-add" type="button">Add Step</button>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.35rem;">Add tools in the order they should execute. Use arrows to reorder.</div>
    </div>

    <!-- Schedule toggle -->
    <div class="auto-schedule-toggle" style="margin-top:1rem;">
      <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
        <input type="checkbox" id="auto-schedule-enabled">
        <span style="font-size:0.85rem;color:var(--text-primary);font-weight:500;">Schedule this automation</span>
      </label>
    </div>
    <div id="auto-schedule-section" style="display:none;margin-top:0.5rem;">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Schedule</label>
          <select id="auto-schedule-kind">
            <option value="every_minutes">Every few minutes</option>
            <option value="every_hours">Every few hours</option>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Advanced cron</option>
          </select>
        </div>
        <div class="cfg-field" id="auto-interval-field">
          <label>Interval (minutes)</label>
          <input id="auto-interval" type="number" min="1" step="1" value="30">
        </div>
        <div class="cfg-field" id="auto-minute-field" style="display:none">
          <label>Minute Past The Hour</label>
          <input id="auto-minute" type="number" min="0" max="59" step="1" value="0">
        </div>
        <div class="cfg-field" id="auto-time-field" style="display:none">
          <label>Time</label>
          <input id="auto-time" type="time" value="09:00">
        </div>
        <div class="cfg-field" id="auto-weekday-field" style="display:none">
          <label>Day</label>
          <select id="auto-weekday">
            <option value="1">Monday</option>
            <option value="2">Tuesday</option>
            <option value="3">Wednesday</option>
            <option value="4">Thursday</option>
            <option value="5">Friday</option>
            <option value="6">Saturday</option>
            <option value="0">Sunday</option>
          </select>
        </div>
        <div class="cfg-field" id="auto-custom-cron-field" style="display:none">
          <label>Advanced Cron</label>
          <input id="auto-cron-custom" type="text" placeholder="*/30 * * * *">
        </div>
      </div>
      <div class="ops-inline-help" id="auto-schedule-preview"></div>
    </div>

    <details class="ops-advanced" style="margin-top:0.75rem;">
      <summary>Advanced Options</summary>
      <div class="cfg-form-grid" style="margin-top:0.85rem;">
        <div class="cfg-field">
          <label>Tool Inputs (JSON, optional)</label>
          <textarea id="auto-create-args" rows="4" placeholder='{"host":"192.168.1.1","count":3}'></textarea>
        </div>
        <div class="cfg-field">
          <label>Event Name (optional)</label>
          <input id="auto-create-event" type="text" placeholder="scan_completed">
        </div>
        <div class="cfg-field">
          <label>Enabled</label>
          <select id="auto-create-enabled">
            <option value="true">Yes</option>
            <option value="false" selected>No</option>
          </select>
        </div>
      </div>
    </details>

    <div class="cfg-actions">
      <button class="btn btn-primary" id="auto-create-save">Create Automation</button>
      <button class="btn btn-secondary" id="auto-create-cancel">Cancel</button>
      <span id="auto-create-status" class="cfg-save-status"></span>
    </div>

    <input type="hidden" id="auto-edit-id" value="">
  `;
}

function renderExampleCards(templates, presets) {
  const cards = [];

  for (const tpl of (templates || [])) {
    cards.push(`
      <div class="auto-example-card">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.3rem;">
          <strong style="font-size:0.82rem;">${esc(tpl.name || tpl.id)}</strong>
          <span class="auto-kind-badge pipeline">Pipeline</span>
        </div>
        <div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem;">${esc(tpl.description || '')}</div>
        <div style="font-size:0.68rem;color:var(--text-muted);margin-bottom:0.5rem;">${(tpl.steps || tpl.playbooks || []).length} steps</div>
        <button class="btn btn-primary btn-sm auto-install-template" data-template-id="${escAttr(tpl.id)}">Install</button>
      </div>
    `);
  }

  for (const preset of (presets || [])) {
    cards.push(`
      <div class="auto-example-card">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.3rem;">
          <strong style="font-size:0.82rem;">${esc(preset.name || preset.id)}</strong>
          <span class="auto-kind-badge single">Single</span>
        </div>
        <div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem;">${esc(preset.description || '')}</div>
        <div style="font-size:0.68rem;color:var(--text-muted);margin-bottom:0.5rem;">Tool: ${esc(preset.target || '')}</div>
        <button class="btn btn-primary btn-sm auto-install-preset" data-preset-id="${escAttr(preset.id)}">Install</button>
      </div>
    `);
  }

  if (cards.length === 0) {
    return '<div style="color:var(--text-muted);padding:1rem;">No examples available.</div>';
  }

  return cards.join('');
}

function renderRunHistory(playbookRuns, taskHistory) {
  const merged = [];

  for (const run of (playbookRuns || [])) {
    merged.push({
      time: run.startedAt || run.timestamp || 0,
      name: run.playbookName || run.playbookId || '',
      source: 'playbook',
      status: run.status || '',
      duration: run.durationMs || 0,
      steps: run.steps || [],
      id: run.id,
    });
  }

  for (const item of (taskHistory || [])) {
    merged.push({
      time: item.timestamp || 0,
      name: item.taskName || '',
      source: item.taskType === 'playbook' ? 'scheduled playbook' : 'scheduled',
      status: item.status || '',
      duration: item.durationMs || 0,
      message: item.message || '',
      steps: item.steps || [],
      id: item.id || `${item.taskId || 'task'}-${item.timestamp || 0}`,
    });
  }

  merged.sort((a, b) => b.time - a.time);

  if (merged.length === 0) {
    return '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No runs yet.</td></tr>';
  }

  return merged.slice(0, 60).map((entry) => `
    <tr>
      <td>${formatTime(entry.time)}</td>
      <td>${esc(entry.name)}</td>
      <td><span class="badge ${entry.source === 'playbook' ? 'badge-info' : 'badge-created'}">${esc(entry.source)}</span></td>
      <td><span style="color:${statusColor(entry.status)}">${esc(entry.status)}</span></td>
      <td>${entry.duration}ms</td>
      <td>
        ${entry.steps && entry.steps.length > 0
          ? `<button class="btn btn-secondary btn-sm auto-run-details" data-run-id="${escAttr(entry.id || '')}">Show</button>`
          : `<span class="ops-history-message" title="${escAttr(entry.message || '')}">${esc(entry.message || '-')}</span>`
        }
      </td>
    </tr>
    ${entry.steps && entry.steps.length > 0 ? `
    <tr class="auto-run-details-row" id="auto-run-detail-${escAttr(entry.id || '')}" style="display:none">
      <td colspan="6" style="padding:0.5rem 1rem;background:var(--bg-secondary)">
        ${renderStepResults(entry.steps)}
      </td>
    </tr>
    ` : ''}
  `).join('');
}

function renderStepResults(steps) {
  if (!steps || steps.length === 0) return '<div style="color:var(--text-muted)">No steps</div>';
  return `<div style="font-size:0.85rem">${steps.map((step, index) => {
    const stepColor = step.status === 'succeeded' ? 'var(--success)' : step.status === 'failed' ? 'var(--error)' : 'var(--warning)';
    const hasOutput = step.output != null && step.output !== '';
    const outputId = `auto-step-output-${index}-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:4px 0;border-bottom:1px solid var(--border)">
        <span style="color:${stepColor};font-weight:bold;min-width:18px">${step.status === 'succeeded' ? '&#10003;' : step.status === 'failed' ? '&#10007;' : '&#9679;'}</span>
        <span style="min-width:140px;font-weight:500">${esc(step.toolName)}</span>
        <span style="color:var(--text-muted)">${esc(step.message || '')}</span>
        <span style="margin-left:auto;color:var(--text-muted)">${step.durationMs}ms</span>
        ${hasOutput ? `<button class="btn btn-secondary auto-step-output-toggle" data-output-id="${outputId}" style="font-size:0.75rem;padding:2px 6px">Output</button>` : ''}
      </div>
      ${hasOutput ? `<div id="${outputId}" style="display:none;padding:4px 0 4px 28px;max-height:300px;overflow:auto"><pre style="font-size:0.8rem;background:var(--bg-primary);padding:0.5rem;border-radius:4px;white-space:pre-wrap;word-break:break-word">${esc(typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2))}</pre></div>` : ''}
    `;
  }).join('')}</div>`;
}

function renderEngineSettings(summary, workflowConfig, studio, packs) {
  return `
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enabled</label>
          <select id="auto-engine-enabled">
            <option value="true" ${summary.enabled ? 'selected' : ''}>true</option>
            <option value="false" ${!summary.enabled ? 'selected' : ''}>false</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Execution Mode</label>
          <select id="auto-engine-mode">
            <option value="plan_then_execute" ${summary.executionMode === 'plan_then_execute' ? 'selected' : ''}>plan_then_execute</option>
            <option value="direct_execute" ${summary.executionMode === 'direct_execute' ? 'selected' : ''}>direct_execute</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Max Calls / Run</label>
          <input id="auto-max-calls" type="number" min="1" value="${esc(String(summary.maxConnectorCallsPerRun || 12))}">
        </div>
        <div class="cfg-field">
          <label>Max Steps</label>
          <input id="auto-max-steps" type="number" min="1" value="${esc(String(workflowConfig.maxSteps || 12))}">
        </div>
        <div class="cfg-field">
          <label>Max Parallel</label>
          <input id="auto-max-parallel" type="number" min="1" value="${esc(String(workflowConfig.maxParallelSteps || 3))}">
        </div>
        <div class="cfg-field">
          <label>Step Timeout (ms)</label>
          <input id="auto-step-timeout" type="number" min="1000" value="${esc(String(workflowConfig.defaultStepTimeoutMs || 15000))}">
        </div>
        <div class="cfg-field">
          <label>Signed Definitions</label>
          <select id="auto-require-signed">
            <option value="true" ${workflowConfig.requireSignedDefinitions ? 'selected' : ''}>true</option>
            <option value="false" ${!workflowConfig.requireSignedDefinitions ? 'selected' : ''}>false</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Dry Run First</label>
          <select id="auto-require-dryrun">
            <option value="true" ${workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>true</option>
            <option value="false" ${!workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>false</option>
          </select>
        </div>
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="auto-engine-save">Save</button>
        <span id="auto-engine-status" class="cfg-save-status"></span>
      </div>

      <h4 style="margin-top:1.25rem;margin-bottom:0.25rem">Permission Policies</h4>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.6rem">Each policy restricts what an automation can access.</div>
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
                  <button class="btn btn-secondary btn-sm auto-pack-edit" data-pack-id="${escAttr(pack.id)}">Edit</button>
                  <button class="btn btn-secondary btn-sm auto-pack-delete" data-pack-id="${escAttr(pack.id)}">Delete</button>
                </td>
              </tr>
            `).join('')}
        </tbody>
      </table>
      <div class="cfg-field" style="margin-top:0.75rem">
        <label>Policy JSON (upsert)</label>
        <textarea id="auto-pack-json" rows="4" placeholder='{"id":"...","name":"...","enabled":true,"allowedCapabilities":["network.read"]}'></textarea>
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="auto-pack-upsert">Save Policy</button>
        <span id="auto-pack-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;
}

// ─── Event binding ──────────────────────────────────────

function bindEvents(container, ctx) {
  const { automations, playbooks, tasks, presets, tools, packs, templates } = ctx;

  // Refresh
  container.querySelector('#auto-refresh')?.addEventListener('click', () => renderAutomations(container));

  // Category filter
  container.querySelectorAll('.wf-category-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cat = chip.getAttribute('data-category');
      container.querySelectorAll('.wf-category-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      container.querySelectorAll('.auto-catalog-row').forEach((row) => {
        const match = cat === 'all' || row.getAttribute('data-category') === cat;
        if (row.classList.contains('wf-pipeline-row')) {
          row.classList.toggle('wf-filtered-out', !match);
        } else {
          row.style.display = match ? '' : 'none';
        }
      });
    });
  });

  // Examples panel
  container.querySelector('#auto-examples-toggle')?.addEventListener('click', () => {
    const panel = container.querySelector('#auto-examples-panel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  container.querySelector('#auto-examples-close')?.addEventListener('click', () => {
    container.querySelector('#auto-examples-panel').style.display = 'none';
  });

  // Install template
  container.querySelectorAll('.auto-install-template').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-template-id');
      btn.disabled = true;
      btn.textContent = 'Installing...';
      try {
        await api.installTemplate(id);
        await renderAutomations(container);
      } catch { btn.disabled = false; btn.textContent = 'Install'; }
    });
  });

  // Install preset
  container.querySelectorAll('.auto-install-preset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-preset-id');
      btn.disabled = true;
      btn.textContent = 'Installing...';
      try {
        await api.installScheduledTaskPreset(id);
        await renderAutomations(container);
      } catch { btn.disabled = false; btn.textContent = 'Install'; }
    });
  });

  // Create form toggle
  bindCreateForm(container, { tools, packs });

  // Pipeline expand/collapse
  container.querySelectorAll('.auto-pipeline-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const autoId = btn.getAttribute('data-auto-id');
      const row = container.querySelector(`#auto-pipeline-${autoId}`);
      if (!row) return;
      const isVisible = row.classList.contains('visible');
      row.classList.toggle('visible', !isVisible);
      btn.classList.toggle('expanded', !isVisible);
    });
  });

  // Enable/disable toggle
  container.querySelectorAll('.auto-toggle').forEach((toggle) => {
    toggle.addEventListener('change', async () => {
      const autoId = toggle.getAttribute('data-auto-id');
      const auto = automations.find((a) => a.id === autoId);
      if (!auto) return;
      toggle.disabled = true;
      try {
        if (auto._source === 'playbook' && auto._playbook) {
          await api.upsertPlaybook({ ...auto._playbook, enabled: toggle.checked });
        } else if (auto._task) {
          await api.updateScheduledTask(auto._task.id, { enabled: toggle.checked });
        }
        await renderAutomations(container);
      } catch {
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
      }
    });
  });

  // Run / Dry Run
  container.querySelectorAll('.auto-run, .auto-dryrun').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const auto = automations.find((a) => a.id === autoId);
      if (!auto) return;

      const dryRun = button.classList.contains('auto-dryrun');
      button.disabled = true;
      button.textContent = dryRun ? 'Running dry...' : 'Running...';
      try {
        let result;
        if (auto._source === 'task' && !auto._playbook) {
          // Orphaned task — run via scheduled task API
          result = await api.runScheduledTaskNow(auto._task.id);
          button.textContent = result.success ? 'Done' : 'Failed';
        } else {
          result = await api.runPlaybook({
            playbookId: auto.id,
            dryRun,
            origin: 'web',
            channel: 'web',
            userId: 'web-user',
            requestedBy: 'web-user',
          });
          const resultsDiv = container.querySelector('#auto-run-results');
          if (resultsDiv && result.run) {
            resultsDiv.innerHTML = `
              <div style="margin-top:0.75rem;padding:1rem;background:var(--bg-secondary);border-radius:8px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                  <strong>${esc(result.run.playbookName || autoId)}</strong>
                  <span style="color:${result.success ? 'var(--success)' : 'var(--error)'}">${esc(result.status)} (${result.run.durationMs}ms)</span>
                </div>
                ${renderStepResults(result.run.steps || [])}
              </div>
            `;
          }
          button.textContent = dryRun ? 'Dry Run' : 'Run';
        }
        setTimeout(() => renderAutomations(container), 900);
      } catch (err) {
        const resultsDiv = container.querySelector('#auto-run-results');
        if (resultsDiv) {
          resultsDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        }
        button.disabled = false;
        button.textContent = dryRun ? 'Dry Run' : 'Run';
      }
    });
  });

  // Clone
  container.querySelectorAll('.auto-clone').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const auto = automations.find((a) => a.id === autoId);
      if (!auto) return;

      button.disabled = true;
      button.textContent = 'Cloning...';
      try {
        const newId = generateCloneId(autoId, automations);
        const newName = `${auto.name} (copy)`;

        if (auto._playbook) {
          const clonedPb = { ...auto._playbook, id: newId, name: newName, enabled: false };
          await api.upsertPlaybook(clonedPb);
        } else {
          // Wrap orphaned task as playbook
          await api.upsertPlaybook({
            id: newId,
            name: newName,
            mode: 'sequential',
            enabled: false,
            description: auto.description,
            steps: auto.steps.map((s, i) => ({ ...s, id: `${newId}-step-${i + 1}` })),
          });
        }

        // Clone linked schedule if present
        if (auto._task && auto.cron) {
          await api.createScheduledTask({
            name: newName,
            type: 'playbook',
            target: newId,
            cron: auto.cron,
            enabled: false,
          });
        }

        await renderAutomations(container);

        // Highlight + scroll to cloned row
        setTimeout(() => {
          const newRow = container.querySelector(`tr[data-auto-id="${newId}"]`);
          if (newRow) {
            newRow.classList.add('auto-clone-highlight');
            newRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      } catch {
        button.disabled = false;
        button.textContent = 'Clone';
      }
    });
  });

  // Delete
  container.querySelectorAll('.auto-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const label = button.getAttribute('data-label') || autoId;
      const auto = automations.find((a) => a.id === autoId);
      if (!auto || !confirm(`Delete automation '${label}'?`)) return;

      try {
        if (auto._playbook) await api.deletePlaybook(auto.id);
        if (auto._task) await api.deleteScheduledTask(auto._task.id);
        await renderAutomations(container);
      } catch { /* keep UI */ }
    });
  });

  // Run details toggle
  container.querySelectorAll('.auto-run-details').forEach((button) => {
    button.addEventListener('click', () => {
      const runId = button.getAttribute('data-run-id');
      const row = container.querySelector(`#auto-run-detail-${runId}`);
      if (!row) return;
      const visible = row.style.display !== 'none';
      row.style.display = visible ? 'none' : '';
      button.textContent = visible ? 'Show' : 'Hide';
    });
  });

  // Inline config save
  container.querySelectorAll('.auto-config-save').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const textarea = container.querySelector(`.wf-config-json-editor[data-auto-id="${autoId}"]`);
      const statusEl = container.querySelector(`.auto-config-save-status[data-auto-id="${autoId}"]`);
      if (!textarea || !statusEl) return;
      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.upsertPlaybook(JSON.parse(textarea.value.trim()));
        statusEl.textContent = result.message || (result.success ? 'Saved.' : 'Failed.');
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) setTimeout(() => renderAutomations(container), 500);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });
  });

  // Engine settings
  bindEngineSettings(container, ctx);
}

function bindCreateForm(container, { tools, packs }) {
  const createToggle = container.querySelector('#auto-create-toggle');
  const createForm = container.querySelector('#auto-create-form');

  createToggle?.addEventListener('click', () => {
    const isOpen = createForm.style.display !== 'none';
    createForm.style.display = isOpen ? 'none' : '';
    createToggle.textContent = isOpen ? 'Create Automation' : 'Close';
  });

  container.querySelector('#auto-create-cancel')?.addEventListener('click', () => {
    createForm.style.display = 'none';
    createToggle.textContent = 'Create Automation';
  });

  // Auto-generate ID from name
  container.querySelector('#auto-create-name')?.addEventListener('input', () => {
    const name = container.querySelector('#auto-create-name').value;
    container.querySelector('#auto-create-id').value = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  });

  // Mode switch — show/hide single vs pipeline sections
  const modeSelect = container.querySelector('#auto-create-mode');
  const singleSection = container.querySelector('#auto-single-tool-section');
  const pipelineSection = container.querySelector('#auto-pipeline-section');

  function updateModeVisibility() {
    const mode = modeSelect.value;
    singleSection.style.display = mode === 'single' ? '' : 'none';
    pipelineSection.style.display = mode !== 'single' ? '' : 'none';
  }
  modeSelect?.addEventListener('change', updateModeVisibility);
  updateModeVisibility();

  // Schedule toggle
  const scheduleCheck = container.querySelector('#auto-schedule-enabled');
  const scheduleSection = container.querySelector('#auto-schedule-section');
  scheduleCheck?.addEventListener('change', () => {
    scheduleSection.style.display = scheduleCheck.checked ? '' : 'none';
  });

  // Schedule field visibility
  const scheduleKind = container.querySelector('#auto-schedule-kind');
  scheduleKind?.addEventListener('change', () => {
    const mode = scheduleKind.value;
    const intervalInput = container.querySelector('#auto-interval');
    const currentInterval = Number(intervalInput.value);
    if (mode === 'every_minutes' && currentInterval === 2) intervalInput.value = '30';
    else if (mode === 'every_hours' && currentInterval === 30) intervalInput.value = '2';
    updateScheduleFields(container);
    updateSchedulePreview(container);
  });

  ['#auto-interval', '#auto-minute', '#auto-time', '#auto-weekday', '#auto-cron-custom'].forEach((sel) => {
    container.querySelector(sel)?.addEventListener('input', () => updateSchedulePreview(container));
    container.querySelector(sel)?.addEventListener('change', () => updateSchedulePreview(container));
  });

  updateScheduleFields(container);
  updateSchedulePreview(container);

  // Step builder for pipeline mode
  const stepList = container.querySelector('#auto-step-list');
  const stepToolSelect = container.querySelector('#auto-step-tool-select');
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
            <button class="btn btn-secondary btn-sm auto-step-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
            <button class="btn btn-secondary btn-sm auto-step-down" data-index="${i}" ${i === wfSteps.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
            <button class="btn btn-secondary btn-sm auto-step-remove" data-index="${i}" title="Remove">&times;</button>
          </div>
        </div>
      `;
    }).join('');

    stepList.querySelectorAll('.auto-step-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (idx > 0) { [wfSteps[idx - 1], wfSteps[idx]] = [wfSteps[idx], wfSteps[idx - 1]]; renderStepList(); }
      });
    });
    stepList.querySelectorAll('.auto-step-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (idx < wfSteps.length - 1) { [wfSteps[idx], wfSteps[idx + 1]] = [wfSteps[idx + 1], wfSteps[idx]]; renderStepList(); }
      });
    });
    stepList.querySelectorAll('.auto-step-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        wfSteps.splice(Number(btn.dataset.index), 1);
        renderStepList();
      });
    });
  }
  renderStepList();

  container.querySelector('#auto-step-add')?.addEventListener('click', () => {
    const toolName = stepToolSelect.value;
    if (!toolName) return;
    const packId = container.querySelector('#auto-create-pack')?.value || '';
    wfSteps.push({ id: `step-${wfSteps.length + 1}`, name: toolName, packId, toolName, args: {} });
    stepToolSelect.value = '';
    renderStepList();
  });

  // Save
  container.querySelector('#auto-create-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#auto-create-status');
    const editId = container.querySelector('#auto-edit-id').value.trim();
    const id = container.querySelector('#auto-create-id').value.trim();
    const name = container.querySelector('#auto-create-name').value.trim();
    const mode = container.querySelector('#auto-create-mode').value;
    const enabled = container.querySelector('#auto-create-enabled').value === 'true';
    const description = container.querySelector('#auto-create-description').value.trim();
    const packId = container.querySelector('#auto-create-pack')?.value || '';
    const scheduleEnabled = container.querySelector('#auto-schedule-enabled').checked;

    if (!id || !name) {
      statusEl.textContent = 'Name and ID are required.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    // Build steps
    let steps;
    if (mode === 'single') {
      const toolName = container.querySelector('#auto-single-tool-select').value;
      if (!toolName) {
        statusEl.textContent = 'Select a tool.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      let args;
      const argsRaw = container.querySelector('#auto-create-args').value.trim();
      if (argsRaw) {
        try { args = JSON.parse(argsRaw); } catch {
          statusEl.textContent = 'Tool inputs must be valid JSON.';
          statusEl.style.color = 'var(--error)';
          return;
        }
      }
      steps = [{ id: `${id}-step-1`, name: toolName, packId, toolName, args: args || {} }];
    } else {
      if (wfSteps.length === 0) {
        statusEl.textContent = 'Add at least one step.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      steps = wfSteps.map((step, i) => ({ ...step, id: `${id}-step-${i + 1}`, packId: packId || step.packId }));
    }

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const playbookMode = mode === 'single' ? 'sequential' : mode;
      const result = await api.upsertPlaybook({ id: editId || id, name, mode: playbookMode, enabled, description, steps });

      if (!result.success) {
        statusEl.textContent = result.message || 'Failed.';
        statusEl.style.color = 'var(--error)';
        return;
      }

      // Create/update linked scheduled task if schedule enabled
      if (scheduleEnabled) {
        const cron = buildCronFromForm(container);
        if (!cron) {
          statusEl.textContent = 'Automation saved, but choose a valid schedule.';
          statusEl.style.color = 'var(--warning)';
          return;
        }
        const emitEvent = container.querySelector('#auto-create-event').value.trim() || undefined;
        await api.createScheduledTask({
          name,
          type: 'playbook',
          target: editId || id,
          cron,
          enabled: true,
          emitEvent,
        });
      }

      statusEl.textContent = 'Created.';
      statusEl.style.color = 'var(--success)';
      setTimeout(() => renderAutomations(container), 350);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });
}

function bindEngineSettings(container, ctx) {
  const { packs } = ctx;

  // Toggle panel
  container.querySelector('#auto-engine-toggle')?.addEventListener('click', () => {
    const panel = container.querySelector('#auto-engine-panel');
    const arrow = container.querySelector('#auto-engine-arrow');
    if (!panel) return;
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    if (arrow) arrow.innerHTML = visible ? '&#9654; Show' : '&#9660; Hide';
  });

  // Save engine settings
  container.querySelector('#auto-engine-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#auto-engine-status');
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConnectorsSettings({
        enabled: container.querySelector('#auto-engine-enabled').value === 'true',
        executionMode: container.querySelector('#auto-engine-mode').value,
        maxConnectorCallsPerRun: Number(container.querySelector('#auto-max-calls').value),
        playbooks: {
          enabled: true,
          maxSteps: Number(container.querySelector('#auto-max-steps').value),
          maxParallelSteps: Number(container.querySelector('#auto-max-parallel').value),
          defaultStepTimeoutMs: Number(container.querySelector('#auto-step-timeout').value),
          requireSignedDefinitions: container.querySelector('#auto-require-signed').value === 'true',
          requireDryRunOnFirstExecution: container.querySelector('#auto-require-dryrun').value === 'true',
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
  container.querySelector('#auto-pack-upsert')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#auto-pack-status');
    statusEl.textContent = 'Saving...';
    try {
      const raw = container.querySelector('#auto-pack-json').value.trim();
      const result = await api.upsertConnectorPack(JSON.parse(raw));
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      if (result.success) await renderAutomations(container);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  // Pack delete
  container.querySelectorAll('.auto-pack-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const packId = button.getAttribute('data-pack-id');
      if (!packId || !confirm(`Delete policy '${packId}'?`)) return;
      await api.deleteConnectorPack(packId);
      await renderAutomations(container);
    });
  });

  // Pack edit
  container.querySelectorAll('.auto-pack-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const packId = button.getAttribute('data-pack-id');
      const pack = packs.find((p) => p.id === packId);
      if (!pack) return;
      container.querySelector('#auto-pack-json').value = JSON.stringify(pack, null, 2);
      container.querySelector('#auto-engine-panel').style.display = '';
    });
  });
}

// ─── Schedule helpers (ported from operations.js) ───────

function updateScheduleFields(container) {
  const mode = container.querySelector('#auto-schedule-kind')?.value;
  if (!mode) return;
  const intervalField = container.querySelector('#auto-interval-field');
  const minuteField = container.querySelector('#auto-minute-field');
  const timeField = container.querySelector('#auto-time-field');
  const weekdayField = container.querySelector('#auto-weekday-field');
  const customCronField = container.querySelector('#auto-custom-cron-field');

  if (intervalField) intervalField.style.display = mode === 'every_minutes' || mode === 'every_hours' ? '' : 'none';
  if (minuteField) minuteField.style.display = mode === 'every_hours' ? '' : 'none';
  if (timeField) timeField.style.display = mode === 'daily' || mode === 'weekdays' || mode === 'weekly' ? '' : 'none';
  if (weekdayField) weekdayField.style.display = mode === 'weekly' ? '' : 'none';
  if (customCronField) customCronField.style.display = mode === 'custom' ? '' : 'none';

  const intervalLabel = intervalField?.querySelector('label');
  if (intervalLabel) {
    intervalLabel.textContent = mode === 'every_minutes' ? 'Interval (minutes)' : mode === 'every_hours' ? 'Interval (hours)' : 'Interval';
  }
}

function updateSchedulePreview(container) {
  const previewEl = container.querySelector('#auto-schedule-preview');
  if (!previewEl) return;
  const cron = buildCronFromForm(container);
  if (!cron) {
    previewEl.textContent = 'Choose a valid schedule.';
    previewEl.style.color = 'var(--warning)';
    return;
  }
  previewEl.textContent = `Schedule preview: ${cronToHuman(cron)}`;
  previewEl.style.color = 'var(--text-secondary)';
}

function buildCronFromForm(container) {
  const mode = container.querySelector('#auto-schedule-kind')?.value;
  if (!mode) return '';
  const interval = clampInt(container.querySelector('#auto-interval')?.value, 1, 999);
  const minute = clampInt(container.querySelector('#auto-minute')?.value, 0, 59);
  const weekday = container.querySelector('#auto-weekday')?.value;
  const time = parseTimeValue(container.querySelector('#auto-time')?.value);
  const customCron = container.querySelector('#auto-cron-custom')?.value?.trim();

  if (mode === 'every_minutes') {
    if (!interval) return '';
    return interval === 1 ? '* * * * *' : `*/${interval} * * * *`;
  }
  if (mode === 'every_hours') {
    if (!interval && interval !== 0) return '';
    return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
  }
  if ((mode === 'daily' || mode === 'weekdays' || mode === 'weekly') && !time) return '';
  if (mode === 'daily') return `${time.minute} ${time.hour} * * *`;
  if (mode === 'weekdays') return `${time.minute} ${time.hour} * * 1-5`;
  if (mode === 'weekly') return `${time.minute} ${time.hour} * * ${weekday}`;
  if (mode === 'custom') return customCron || '';
  return '';
}

// ─── Cron display helpers ───────────────────────────────

function cronToHuman(cron) {
  if (!cron) return '-';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Number.parseInt(min.slice(2), 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${String(min).padStart(2, '0')}`;
  if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const n = Number.parseInt(hour.slice(2), 10);
    return n === 1 ? `Every hour at :${String(min).padStart(2, '0')}` : `Every ${n} hours at :${String(min).padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') return `Daily at ${fmtClock(hour, min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${fmtClock(hour, min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) return `${weekdayName(dow)} at ${fmtClock(hour, min)}`;
  return cron;
}

function fmtClock(hour, min) { return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`; }
function weekdayName(v) { return ({ '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday' })[String(v)] || 'Weekly'; }
function parseTimeValue(v) {
  if (!/^\d{2}:\d{2}$/.test(v || '')) return null;
  const [h, m] = v.split(':').map((p) => Number.parseInt(p, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}
function clampInt(v, min, max) {
  const p = Number.parseInt(String(v), 10);
  if (!Number.isFinite(p)) return null;
  return Math.max(min, Math.min(max, p));
}

// ─── Clone helpers ──────────────────────────────────────

function generateCloneId(originalId, automations) {
  let candidate = `${originalId}-copy`;
  let counter = 2;
  const existingIds = new Set(automations.map((a) => a.id));
  while (existingIds.has(candidate)) {
    candidate = `${originalId}-copy-${counter}`;
    counter++;
  }
  return candidate;
}

// ─── Utility ────────────────────────────────────────────

function statusColor(status) {
  if (status === 'succeeded') return 'var(--success)';
  if (status === 'failed') return 'var(--error)';
  if (status === 'pending_approval') return 'var(--warning)';
  return 'var(--text-muted)';
}

function formatTime(ts) {
  if (!ts) return '-';
  try { return new Date(ts).toLocaleString(); } catch { return '-'; }
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function formatStepAccess(packId, packs) {
  const normalized = (packId || '').trim();
  if (!normalized || normalized.toLowerCase() === 'default') {
    return 'Built-in tools';
  }
  const pack = (packs || []).find((candidate) => candidate.id === normalized);
  return pack ? `${pack.name} (${pack.id})` : normalized;
}

// Global click handler for step output toggles
document.addEventListener('click', (event) => {
  const button = event.target.closest('.auto-step-output-toggle');
  if (!button) return;
  const outputId = button.getAttribute('data-output-id');
  if (!outputId) return;
  const output = document.getElementById(outputId);
  if (!output) return;
  const visible = output.style.display !== 'none';
  output.style.display = visible ? 'none' : '';
  button.textContent = visible ? 'Output' : 'Hide';
});
