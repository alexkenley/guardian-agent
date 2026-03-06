/**
 * Operations page - scheduled tasks management.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;

export async function renderOperations(container) {
  currentContainer = container;
  container.innerHTML = '<h2 class="page-title">Operations</h2><div class="loading">Loading...</div>';

  try {
    const [tasks, presets, history, toolsState, connectorsState] = await Promise.all([
      api.scheduledTasks().catch(() => []),
      api.scheduledTaskPresets().catch(() => []),
      api.scheduledTaskHistory().catch(() => []),
      api.toolsState(500).catch(() => ({ tools: [] })),
      api.connectorsState(50).catch(() => ({ playbooks: [] })),
    ]);

    const tools = Array.isArray(toolsState?.tools) ? toolsState.tools : [];
    const playbooks = Array.isArray(connectorsState?.playbooks) ? connectorsState.playbooks : [];
    const activeTasks = tasks.filter((task) => task.enabled);
    const lastRun = tasks.reduce((latest, task) => Math.max(latest, task.lastRunAt || 0), 0);
    const rows = buildOperationRows(tasks, presets, tools, playbooks);

    container.innerHTML = `
      <h2 class="page-title">Operations</h2>

      <div class="table-container">
        <div class="table-header">
          <h3>Create Task</h3>
          <button class="btn btn-primary" id="ops-create-toggle" aria-expanded="false">Create Task</button>
        </div>
        <div class="cfg-center-body" id="ops-add-form" style="display:none">
          <div class="cfg-form-grid">
            <div class="cfg-field">
              <label>Name</label>
              <input id="ops-name" type="text" placeholder="Network Watch">
            </div>
            <div class="cfg-field">
              <label>What Runs</label>
              <select id="ops-type">
                <option value="tool">Tool</option>
                <option value="playbook">Workflow</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Target</label>
              <select id="ops-target"></select>
            </div>
            <div class="cfg-field">
              <label>Starts Enabled</label>
              <select id="ops-enabled">
                <option value="true" selected>Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Schedule</label>
              <select id="ops-schedule-kind">
                <option value="every_minutes">Every few minutes</option>
                <option value="every_hours">Every few hours</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Advanced cron</option>
              </select>
            </div>
            <div class="cfg-field" id="ops-interval-field">
              <label>Interval</label>
              <input id="ops-interval" type="number" min="1" step="1" value="30">
            </div>
            <div class="cfg-field" id="ops-minute-field" style="display:none">
              <label>Minute Past The Hour</label>
              <input id="ops-minute" type="number" min="0" max="59" step="1" value="0">
            </div>
            <div class="cfg-field" id="ops-time-field" style="display:none">
              <label>Time</label>
              <input id="ops-time" type="time" value="09:00">
            </div>
            <div class="cfg-field" id="ops-weekday-field" style="display:none">
              <label>Day</label>
              <select id="ops-weekday">
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                <option value="0">Sunday</option>
              </select>
            </div>
            <div class="cfg-field" id="ops-custom-cron-field" style="display:none">
              <label>Advanced Cron</label>
              <input id="ops-cron-custom" type="text" placeholder="*/30 * * * *">
            </div>
          </div>

          <div class="ops-inline-help" id="ops-target-help"></div>
          <div class="ops-inline-help" id="ops-schedule-preview"></div>

          <details class="ops-advanced">
            <summary>Advanced Options</summary>
            <div class="cfg-form-grid" style="margin-top:0.85rem;">
              <div class="cfg-field" id="ops-args-field">
                <label>Tool Inputs (JSON, optional)</label>
                <textarea id="ops-args" rows="4" placeholder='{"host":"192.168.1.1","count":3}'></textarea>
              </div>
              <div class="cfg-field">
                <label>Event Name (optional)</label>
                <input id="ops-event" type="text" placeholder="network_scan_completed">
              </div>
            </div>
          </details>

          <div class="cfg-actions">
            <button class="btn btn-primary" id="ops-save">Create Task</button>
            <button class="btn btn-secondary" id="ops-cancel">Cancel</button>
            <span id="ops-save-status" class="cfg-save-status"></span>
          </div>

          <input type="hidden" id="ops-edit-id" value="">
          <input type="hidden" id="ops-preset-id" value="">
        </div>
      </div>

      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Tasks</div>
          <div class="card-value">${tasks.length}</div>
        </div>
        <div class="status-card success">
          <div class="card-title">Enabled</div>
          <div class="card-value">${activeTasks.length}</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Last Run</div>
          <div class="card-value" style="font-size:1rem">${lastRun ? formatTime(lastRun) : 'Never'}</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Total Runs</div>
          <div class="card-value">${tasks.reduce((sum, task) => sum + (task.runCount || 0), 0)}</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Task Table</h3>
          <button class="btn btn-secondary" id="ops-refresh">Refresh</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Action</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last Run</th>
              <th>Runs</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0
              ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No scheduled tasks or preset jobs available.</td></tr>'
              : rows.map((row) => renderOperationRow(row)).join('')
            }
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Run History</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Task</th><th>Status</th><th>Duration</th><th>Message</th></tr></thead>
          <tbody>
            ${history.length === 0
              ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No runs yet.</td></tr>'
              : history.slice(0, 50).map((item) => `
                <tr>
                  <td>${formatTime(item.timestamp)}</td>
                  <td>${esc(item.taskName)}</td>
                  <td><span style="color:${statusColor(item.status)}">${esc(item.status)}</span></td>
                  <td>${item.durationMs}ms</td>
                  <td class="ops-history-message" title="${escAttr(item.message)}">${esc(item.message)}</td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>
    `;

    bindEvents(container, { tasks, presets, tools, playbooks, rows });
    initializeForm(container, { tools, playbooks, presets });
    applyInputTooltips(container);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Operations</h2><div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

export async function updateOperations() {
  if (currentContainer) {
    await renderOperations(currentContainer);
  }
}

function buildOperationRows(tasks, presets, tools, playbooks) {
  const rows = [];
  const presetMap = new Map(presets.map((preset) => [preset.id, preset]));
  const matchedTaskIds = new Set();

  for (const preset of presets) {
    const task = findTaskForPreset(tasks, preset);
    if (task) matchedTaskIds.add(task.id);
    rows.push({
      rowType: 'preset',
      preset,
      task,
      tool: tools.find((candidate) => candidate.name === (task?.target || preset.target)) || null,
      playbook: playbooks.find((candidate) => candidate.id === (task?.target || preset.target)) || null,
    });
  }

  for (const task of tasks) {
    if (matchedTaskIds.has(task.id)) continue;
    const preset = task.presetId ? presetMap.get(task.presetId) || null : null;
    rows.push({
      rowType: 'custom',
      preset,
      task,
      tool: tools.find((candidate) => candidate.name === task.target) || null,
      playbook: playbooks.find((candidate) => candidate.id === task.target) || null,
    });
  }

  return rows;
}

function renderOperationRow(row) {
  const task = row.task;
  const preset = row.preset;
  const isPresetRow = row.rowType === 'preset';
  const enabled = task ? task.enabled : false;
  const name = task?.name || preset?.name || 'Unnamed Task';
  const type = task?.type || preset?.type || 'tool';
  const target = task?.target || preset?.target || '';
  const description = row.tool?.description || row.playbook?.description || preset?.description || '';
  const args = task?.args ?? preset?.args;
  const schedule = task?.cron || preset?.cron || '';
  const stateLabel = enabled ? 'Enabled' : 'Disabled';
  const rowKey = task?.id || preset?.id || name;
  const hasTask = !!task;
  const deleteLabel = isPresetRow ? 'Remove' : 'Delete';

  return `
    <tr>
      <td>
        <div class="ops-task-title">${esc(name)}</div>
        <div class="ops-task-sub">
          <span class="badge ${isPresetRow ? 'badge-info' : 'badge-created'}">${isPresetRow ? 'Preset job' : 'Custom task'}</span>
          ${task?.presetId && !isPresetRow ? '<span class="badge badge-info">Preset based</span>' : ''}
        </div>
      </td>
      <td>
        <div class="ops-task-title">${type === 'tool' ? 'Tool' : 'Workflow'}: <span class="ops-mono">${esc(target)}</span></div>
        ${description ? `<div class="ops-task-sub">${esc(description)}</div>` : ''}
        ${args && Object.keys(args).length > 0 ? `<div class="ops-task-sub">${esc(renderArgsSummary(args))}</div>` : ''}
      </td>
      <td title="${escAttr(schedule)}">
        <div class="ops-task-title">${esc(cronToHuman(schedule))}</div>
        <div class="ops-task-sub">${esc(schedulePreviewSuffix(schedule))}</div>
      </td>
      <td>
        <div class="ops-state-cell">
          <span class="badge ${enabled ? 'badge-ready' : 'badge-dead'}">${stateLabel}</span>
          <label class="toggle-switch" style="margin:0;">
            <input
              type="checkbox"
              class="ops-toggle"
              data-row-key="${escAttr(rowKey)}"
              ${task ? `data-task-id="${escAttr(task.id)}"` : ''}
              ${preset ? `data-preset-id="${escAttr(preset.id)}"` : ''}
              ${enabled ? 'checked' : ''}
            >
            <span class="toggle-slider"></span>
          </label>
        </div>
      </td>
      <td>
        <div>${hasTask && task.lastRunAt ? formatTime(task.lastRunAt) : '-'}</div>
        <div class="ops-task-sub">${hasTask && task.lastRunStatus ? esc(task.lastRunStatus) : 'Not run yet'}</div>
      </td>
      <td>${hasTask ? task.runCount || 0 : 0}</td>
      <td>
        ${hasTask
          ? `
            <button class="btn btn-primary ops-run" data-task-id="${escAttr(task.id)}">Run</button>
            <button class="btn btn-secondary ops-edit-task" data-task-id="${escAttr(task.id)}">Edit</button>
            <button class="btn btn-secondary ops-delete" data-task-id="${escAttr(task.id)}" data-label="${escAttr(name)}" data-delete-label="${escAttr(deleteLabel)}">${deleteLabel}</button>
          `
          : `
            <button class="btn btn-primary ops-enable-preset" data-preset-id="${escAttr(preset.id)}">Enable</button>
            <button class="btn btn-secondary ops-edit-preset" data-preset-id="${escAttr(preset.id)}">Edit</button>
          `
        }
      </td>
    </tr>
  `;
}

function bindEvents(container, context) {
  const { tasks, presets, tools, playbooks } = context;

  container.querySelector('#ops-create-toggle')?.addEventListener('click', () => {
    const isOpen = container.querySelector('#ops-add-form').style.display !== 'none';
    if (isOpen) {
      closeForm(container);
      return;
    }
    resetForm(container, { tools, playbooks });
    openForm(container);
  });

  container.querySelector('#ops-cancel')?.addEventListener('click', () => {
    closeForm(container);
  });

  container.querySelector('#ops-refresh')?.addEventListener('click', () => {
    renderOperations(container);
  });

  container.querySelector('#ops-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#ops-save-status');
    const editId = container.querySelector('#ops-edit-id').value.trim();

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    let args;
    const argsRaw = container.querySelector('#ops-args').value.trim();
    if (argsRaw) {
      try {
        args = JSON.parse(argsRaw);
      } catch {
        statusEl.textContent = 'Tool inputs must be valid JSON.';
        statusEl.style.color = 'var(--error)';
        return;
      }
    }

    const cron = buildCronFromForm(container);
    if (!cron) {
      statusEl.textContent = 'Choose a valid schedule.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    const data = {
      name: container.querySelector('#ops-name').value.trim(),
      type: container.querySelector('#ops-type').value,
      target: container.querySelector('#ops-target').value,
      cron,
      args: args || undefined,
      emitEvent: container.querySelector('#ops-event').value.trim() || undefined,
      enabled: container.querySelector('#ops-enabled').value === 'true',
      presetId: container.querySelector('#ops-preset-id').value.trim() || undefined,
    };

    if (data.presetId) {
      const preset = presets.find((candidate) => candidate.id === data.presetId);
      if (!preset || preset.type !== data.type || preset.target !== data.target) {
        data.presetId = undefined;
      }
    }

    if (!data.name) {
      statusEl.textContent = 'Name is required.';
      statusEl.style.color = 'var(--error)';
      return;
    }
    if (!data.target) {
      statusEl.textContent = 'Target is required.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    try {
      const result = editId
        ? await api.updateScheduledTask(editId, data)
        : await api.createScheduledTask(data);

      statusEl.textContent = result.message || (result.success ? 'Saved.' : 'Save failed.');
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';

      if (result.success) {
        setTimeout(() => renderOperations(container), 350);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  container.querySelectorAll('.ops-toggle').forEach((toggle) => {
    toggle.addEventListener('change', async () => {
      const taskId = toggle.getAttribute('data-task-id');
      const presetId = toggle.getAttribute('data-preset-id');

      toggle.disabled = true;
      try {
        if (taskId) {
          await api.updateScheduledTask(taskId, { enabled: toggle.checked });
        } else if (presetId && toggle.checked) {
          await api.installScheduledTaskPreset(presetId);
        }
        await renderOperations(container);
      } catch {
        await renderOperations(container);
      }
    });
  });

  container.querySelectorAll('.ops-enable-preset').forEach((button) => {
    button.addEventListener('click', async () => {
      const presetId = button.getAttribute('data-preset-id');
      if (!presetId) return;

      button.disabled = true;
      button.textContent = 'Enabling...';
      try {
        await api.installScheduledTaskPreset(presetId);
        await renderOperations(container);
      } catch {
        button.disabled = false;
        button.textContent = 'Enable';
      }
    });
  });

  container.querySelectorAll('.ops-run').forEach((button) => {
    button.addEventListener('click', async () => {
      const taskId = button.getAttribute('data-task-id');
      if (!taskId) return;

      button.disabled = true;
      button.textContent = 'Running...';
      try {
        const result = await api.runScheduledTaskNow(taskId);
        button.textContent = result.success ? 'Done' : 'Failed';
        setTimeout(() => renderOperations(container), 900);
      } catch {
        button.disabled = false;
        button.textContent = 'Run';
      }
    });
  });

  container.querySelectorAll('.ops-edit-task').forEach((button) => {
    button.addEventListener('click', () => {
      const taskId = button.getAttribute('data-task-id');
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;

      populateFormFromTask(container, task, { tools, playbooks, preset: findPresetForTask(tasks, task, presets) });
      openForm(container);
    });
  });

  container.querySelectorAll('.ops-edit-preset').forEach((button) => {
    button.addEventListener('click', () => {
      const presetId = button.getAttribute('data-preset-id');
      const preset = presets.find((candidate) => candidate.id === presetId);
      if (!preset) return;

      populateFormFromPreset(container, preset, { tools, playbooks });
      openForm(container);
    });
  });

  container.querySelectorAll('.ops-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const taskId = button.getAttribute('data-task-id');
      const label = button.getAttribute('data-label') || 'this task';
      const deleteLabel = button.getAttribute('data-delete-label') || 'Delete';
      if (!taskId) return;
      if (!confirm(`${deleteLabel} '${label}'?`)) return;

      try {
        await api.deleteScheduledTask(taskId);
        await renderOperations(container);
      } catch {
        // Ignore and keep current UI.
      }
    });
  });
}

function initializeForm(container, context) {
  const { tools, playbooks } = context;
  const nameInput = container.querySelector('#ops-name');
  const typeSelect = container.querySelector('#ops-type');
  const targetSelect = container.querySelector('#ops-target');
  const scheduleKind = container.querySelector('#ops-schedule-kind');

  nameInput.dataset.autoName = 'true';

  nameInput.addEventListener('input', () => {
    const hasValue = nameInput.value.trim().length > 0;
    nameInput.dataset.autoName = hasValue ? 'false' : 'true';
  });

  typeSelect.addEventListener('change', () => {
    refreshTargetOptions(container, { tools, playbooks, preserveTarget: false });
    updateAdvancedFieldVisibility(container);
    maybeAutoFillTaskName(container);
  });

  targetSelect.addEventListener('change', () => {
    updateTargetHelp(container, { tools, playbooks });
    maybeAutoFillTaskName(container);
  });

  scheduleKind.addEventListener('change', () => {
    updateScheduleFields(container);
    updateSchedulePreview(container);
  });

  ['#ops-interval', '#ops-minute', '#ops-time', '#ops-weekday', '#ops-cron-custom'].forEach((selector) => {
    container.querySelector(selector)?.addEventListener('input', () => updateSchedulePreview(container));
    container.querySelector(selector)?.addEventListener('change', () => updateSchedulePreview(container));
  });

  resetForm(container, { tools, playbooks });
}

function resetForm(container, context) {
  container.querySelector('#ops-edit-id').value = '';
  container.querySelector('#ops-preset-id').value = '';
  container.querySelector('#ops-save').textContent = 'Create Task';
  container.querySelector('#ops-name').value = '';
  container.querySelector('#ops-name').dataset.autoName = 'true';
  container.querySelector('#ops-type').value = 'tool';
  container.querySelector('#ops-enabled').value = 'true';
  container.querySelector('#ops-schedule-kind').value = 'every_minutes';
  container.querySelector('#ops-interval').value = '30';
  container.querySelector('#ops-minute').value = '0';
  container.querySelector('#ops-time').value = '09:00';
  container.querySelector('#ops-weekday').value = '1';
  container.querySelector('#ops-cron-custom').value = '';
  container.querySelector('#ops-args').value = '';
  container.querySelector('#ops-event').value = '';
  container.querySelector('#ops-save-status').textContent = '';
  container.querySelector('.ops-advanced').open = false;

  refreshTargetOptions(container, { ...context, preserveTarget: false });
  updateScheduleFields(container);
  updateAdvancedFieldVisibility(container);
  updateTargetHelp(container, context);
  maybeAutoFillTaskName(container);
  updateSchedulePreview(container);
}

function populateFormFromTask(container, task, context) {
  const preset = context.preset;
  const schedule = parseCronToSchedule(task.cron);

  container.querySelector('#ops-edit-id').value = task.id;
  container.querySelector('#ops-preset-id').value = task.presetId || '';
  container.querySelector('#ops-save').textContent = 'Save Changes';
  container.querySelector('#ops-name').value = task.name;
  container.querySelector('#ops-name').dataset.autoName = 'false';
  container.querySelector('#ops-type').value = task.type;
  refreshTargetOptions(container, {
    tools: context.tools,
    playbooks: context.playbooks,
    preserveTarget: false,
    selectedValue: task.target,
  });
  container.querySelector('#ops-enabled').value = String(task.enabled);
  container.querySelector('#ops-args').value = task.args ? JSON.stringify(task.args, null, 2) : '';
  container.querySelector('#ops-event').value = task.emitEvent || '';
  applyScheduleToForm(container, schedule);
  container.querySelector('#ops-save-status').textContent = preset ? `Editing preset job '${preset.name}'.` : 'Editing custom task.';
  container.querySelector('#ops-save-status').style.color = 'var(--text-muted)';
  container.querySelector('.ops-advanced').open = !!(task.args || task.emitEvent || schedule.mode === 'custom');
  updateTargetHelp(container, context);
  updateScheduleFields(container);
  updateAdvancedFieldVisibility(container);
  updateSchedulePreview(container);
}

function populateFormFromPreset(container, preset, context) {
  resetForm(container, context);
  container.querySelector('#ops-edit-id').value = '';
  container.querySelector('#ops-preset-id').value = preset.id;
  container.querySelector('#ops-save').textContent = 'Create Task';
  container.querySelector('#ops-name').value = preset.name;
  container.querySelector('#ops-name').dataset.autoName = 'false';
  container.querySelector('#ops-type').value = preset.type;
  refreshTargetOptions(container, {
    tools: context.tools,
    playbooks: context.playbooks,
    preserveTarget: false,
    selectedValue: preset.target,
  });
  container.querySelector('#ops-args').value = preset.args ? JSON.stringify(preset.args, null, 2) : '';
  container.querySelector('#ops-event').value = preset.emitEvent || '';
  applyScheduleToForm(container, parseCronToSchedule(preset.cron));
  container.querySelector('#ops-save-status').textContent = `Creating from preset '${preset.name}'.`;
  container.querySelector('#ops-save-status').style.color = 'var(--text-muted)';
  container.querySelector('.ops-advanced').open = !!(preset.args || preset.emitEvent);
  updateTargetHelp(container, context);
  updateScheduleFields(container);
  updateAdvancedFieldVisibility(container);
  updateSchedulePreview(container);
}

function openForm(container) {
  container.querySelector('#ops-add-form').style.display = '';
  container.querySelector('#ops-create-toggle').textContent = 'Close';
  container.querySelector('#ops-create-toggle').setAttribute('aria-expanded', 'true');
}

function closeForm(container) {
  container.querySelector('#ops-add-form').style.display = 'none';
  container.querySelector('#ops-create-toggle').textContent = 'Create Task';
  container.querySelector('#ops-create-toggle').setAttribute('aria-expanded', 'false');
}

function refreshTargetOptions(container, context) {
  const targetSelect = container.querySelector('#ops-target');
  const type = container.querySelector('#ops-type').value;
  const previousValue = context.selectedValue || (context.preserveTarget ? targetSelect.value : '');
  const options = type === 'tool'
    ? context.tools
      .slice()
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
      .map((tool) => ({
        value: tool.name,
        label: tool.category ? `${tool.name} (${tool.category})` : tool.name,
        description: tool.description,
      }))
    : context.playbooks
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((playbook) => ({
        value: playbook.id,
        label: playbook.enabled ? `${playbook.name}` : `${playbook.name} (disabled)`,
        description: playbook.description || `Workflow ID: ${playbook.id}`,
      }));

  if (previousValue && !options.some((option) => option.value === previousValue)) {
    options.unshift({
      value: previousValue,
      label: `${previousValue} (unavailable)`,
      description: 'This target is no longer available in the current tool or workflow catalog.',
    });
  }

  targetSelect.innerHTML = options.length === 0
    ? '<option value="">No targets available</option>'
    : options.map((option) => `
      <option value="${escAttr(option.value)}" data-description="${escAttr(option.description || '')}">
        ${esc(option.label)}
      </option>
    `).join('');

  if (options.some((option) => option.value === previousValue)) {
    targetSelect.value = previousValue;
  }

  updateTargetHelp(container, context);
}

function updateTargetHelp(container, context) {
  const type = container.querySelector('#ops-type').value;
  const target = container.querySelector('#ops-target').value;
  const helpEl = container.querySelector('#ops-target-help');
  const selectedOption = container.querySelector('#ops-target option:checked');
  let message = '';

  if (!target) {
    message = type === 'tool'
      ? 'Choose a tool from the live tool catalog. Advanced JSON inputs are only needed for tools that require extra parameters.'
      : 'Choose a workflow from the configured workflow list.';
  } else if (selectedOption?.dataset.description) {
    message = selectedOption.dataset.description;
  } else if (type === 'tool') {
    const tool = context.tools.find((candidate) => candidate.name === target);
    message = tool?.description || 'This tool may need advanced JSON inputs depending on what it does.';
  } else {
    const playbook = context.playbooks.find((candidate) => candidate.id === target);
    message = playbook?.description || `Workflow ID: ${target}`;
  }

  helpEl.textContent = message;
}

function maybeAutoFillTaskName(container) {
  const nameInput = container.querySelector('#ops-name');
  if (nameInput.dataset.autoName !== 'true' && nameInput.value.trim()) return;

  const targetSelect = container.querySelector('#ops-target');
  const label = targetSelect.options[targetSelect.selectedIndex]?.textContent?.trim();
  if (!label) return;

  const cleaned = label.replace(/\s+\([^)]*\)\s*$/, '');
  nameInput.value = cleaned;
}

function updateScheduleFields(container) {
  const mode = container.querySelector('#ops-schedule-kind').value;
  const intervalField = container.querySelector('#ops-interval-field');
  const minuteField = container.querySelector('#ops-minute-field');
  const timeField = container.querySelector('#ops-time-field');
  const weekdayField = container.querySelector('#ops-weekday-field');
  const customCronField = container.querySelector('#ops-custom-cron-field');

  intervalField.style.display = mode === 'every_minutes' || mode === 'every_hours' ? '' : 'none';
  minuteField.style.display = mode === 'every_hours' ? '' : 'none';
  timeField.style.display = mode === 'daily' || mode === 'weekdays' || mode === 'weekly' ? '' : 'none';
  weekdayField.style.display = mode === 'weekly' ? '' : 'none';
  customCronField.style.display = mode === 'custom' ? '' : 'none';
}

function updateAdvancedFieldVisibility(container) {
  const argsField = container.querySelector('#ops-args-field');
  const isTool = container.querySelector('#ops-type').value === 'tool';
  argsField.style.display = isTool ? '' : 'none';
}

function updateSchedulePreview(container) {
  const previewEl = container.querySelector('#ops-schedule-preview');
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
  const mode = container.querySelector('#ops-schedule-kind').value;
  const interval = clampInt(container.querySelector('#ops-interval').value, 1, 999);
  const minute = clampInt(container.querySelector('#ops-minute').value, 0, 59);
  const weekday = container.querySelector('#ops-weekday').value;
  const time = parseTimeValue(container.querySelector('#ops-time').value);
  const customCron = container.querySelector('#ops-cron-custom').value.trim();

  if (mode === 'every_minutes') {
    if (!interval) return '';
    if (interval === 1) return '* * * * *';
    return `*/${interval} * * * *`;
  }

  if (mode === 'every_hours') {
    if (!interval && interval !== 0) return '';
    return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
  }

  if ((mode === 'daily' || mode === 'weekdays' || mode === 'weekly') && !time) {
    return '';
  }

  if (mode === 'daily') {
    return `${time.minute} ${time.hour} * * *`;
  }

  if (mode === 'weekdays') {
    return `${time.minute} ${time.hour} * * 1-5`;
  }

  if (mode === 'weekly') {
    return `${time.minute} ${time.hour} * * ${weekday}`;
  }

  if (mode === 'custom') {
    return customCron;
  }

  return '';
}

function applyScheduleToForm(container, schedule) {
  container.querySelector('#ops-schedule-kind').value = schedule.mode;
  container.querySelector('#ops-interval').value = String(schedule.interval || 1);
  container.querySelector('#ops-minute').value = String(schedule.minute || 0);
  container.querySelector('#ops-time').value = schedule.time || '09:00';
  container.querySelector('#ops-weekday').value = schedule.weekday || '1';
  container.querySelector('#ops-cron-custom').value = schedule.customCron || '';
}

function parseCronToSchedule(cron) {
  if (!cron) return { mode: 'every_minutes', interval: 30, minute: 0, time: '09:00', weekday: '1', customCron: '' };

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { mode: 'custom', interval: 1, minute: 0, time: '09:00', weekday: '1', customCron: cron };
  }

  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { mode: 'every_minutes', interval: 1, minute: 0, time: '09:00', weekday: '1', customCron: '' };
  }

  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'every_minutes',
      interval: Number.parseInt(min.slice(2), 10) || 30,
      minute: 0,
      time: '09:00',
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'every_hours',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: '09:00',
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'every_hours',
      interval: Number.parseInt(hour.slice(2), 10) || 1,
      minute: Number.parseInt(min, 10) || 0,
      time: '09:00',
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'daily',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '1-5') {
    return {
      mode: 'weekdays',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return {
      mode: 'weekly',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      weekday: dow,
      customCron: '',
    };
  }

  return { mode: 'custom', interval: 1, minute: 0, time: '09:00', weekday: '1', customCron: cron };
}

function findTaskForPreset(tasks, preset) {
  return tasks.find((task) => (
    task.presetId === preset.id
    || (!task.presetId && task.name === preset.name && task.type === preset.type && task.target === preset.target)
  )) || null;
}

function findPresetForTask(tasks, task, presets) {
  if (task.presetId) {
    return presets.find((preset) => preset.id === task.presetId) || null;
  }
  return presets.find((preset) => findTaskForPreset(tasks, preset)?.id === task.id) || null;
}

function renderArgsSummary(args) {
  const entries = Object.entries(args).slice(0, 3).map(([key, value]) => `${key}: ${formatInlineValue(value)}`);
  const suffix = Object.keys(args).length > 3 ? ` +${Object.keys(args).length - 3} more` : '';
  return `Inputs: ${entries.join(', ')}${suffix}`;
}

function formatInlineValue(value) {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === 'object') return '{...}';
  return String(value);
}

function schedulePreviewSuffix(cron) {
  if (!cron) return '';
  return cron === cronToHuman(cron) ? 'Advanced schedule' : 'Friendly schedule';
}

function cronToHuman(cron) {
  if (!cron) return '-';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every minute';
  }

  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const interval = Number.parseInt(min.slice(2), 10);
    return interval === 1 ? 'Every minute' : `Every ${interval} minutes`;
  }

  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every hour at ${formatMinute(min)}`;
  }

  if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const interval = Number.parseInt(hour.slice(2), 10);
    return interval === 1
      ? `Every hour at ${formatMinute(min)}`
      : `Every ${interval} hours at ${formatMinute(min)}`;
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `Daily at ${formatClock(hour, min)}`;
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '1-5') {
    return `Weekdays at ${formatClock(hour, min)}`;
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return `${weekdayName(dow)} at ${formatClock(hour, min)}`;
  }

  return cron;
}

function formatClock(hour, min) {
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function formatMinute(min) {
  return `:${String(min).padStart(2, '0')}`;
}

function weekdayName(value) {
  return ({
    '0': 'Sunday',
    '1': 'Monday',
    '2': 'Tuesday',
    '3': 'Wednesday',
    '4': 'Thursday',
    '5': 'Friday',
    '6': 'Saturday',
  })[String(value)] || 'Weekly';
}

function parseTimeValue(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
}

function statusColor(status) {
  if (status === 'succeeded') return 'var(--success)';
  if (status === 'failed') return 'var(--error)';
  if (status === 'pending_approval') return 'var(--warning)';
  return 'var(--text-muted)';
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
