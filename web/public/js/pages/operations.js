/**
 * Operations page — scheduled tasks management.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;

export async function renderOperations(container) {
  currentContainer = container;
  container.innerHTML = '<h2 class="page-title">Operations</h2><div class="loading">Loading...</div>';

  try {
    const [tasks, presets, history] = await Promise.all([
      api.scheduledTasks().catch(() => []),
      api.scheduledTaskPresets().catch(() => []),
      api.scheduledTaskHistory().catch(() => []),
    ]);

    const activeTasks = tasks.filter(t => t.enabled);
    const lastRun = tasks.reduce((latest, t) => Math.max(latest, t.lastRunAt || 0), 0);

    container.innerHTML = `
      <h2 class="page-title">Operations</h2>

      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Total Schedules</div>
          <div class="card-value">${tasks.length}</div>
        </div>
        <div class="status-card success">
          <div class="card-title">Active</div>
          <div class="card-value">${activeTasks.length}</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Last Run</div>
          <div class="card-value" style="font-size:1rem">${lastRun ? formatTime(lastRun) : 'Never'}</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Total Runs</div>
          <div class="card-value">${tasks.reduce((sum, t) => sum + (t.runCount || 0), 0)}</div>
        </div>
      </div>

      ${presets.length > 0 ? `
      <div class="table-container">
        <div class="table-header">
          <h3>Quick Setup</h3>
          <span style="color:var(--text-muted);font-size:0.85rem">One-click presets</span>
        </div>
        <div class="preset-bar">
          ${presets.map(p => {
            const installed = tasks.some(t => t.name === p.name && t.target === p.target);
            return `
              <div class="preset-btn ${installed ? 'installed' : ''}" data-preset-id="${escAttr(p.id)}">
                <div class="preset-name">${esc(p.name)}</div>
                <div class="preset-desc">${esc(p.description)}</div>
                <div class="preset-meta">
                  <span>${esc(p.type)} &middot; ${esc(p.cron)}</span>
                  ${installed
                    ? '<span class="preset-status installed">Installed</span>'
                    : '<button class="btn btn-primary preset-install">Install</button>'
                  }
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      ` : ''}

      <div class="table-container">
        <div class="table-header">
          <h3>Scheduled Tasks</h3>
          <div>
            <button class="btn btn-primary" id="ops-add-toggle">Add Schedule</button>
            <button class="btn btn-secondary" id="ops-refresh">Refresh</button>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Name</th><th>Type</th><th>Target</th><th>Schedule</th><th>Last Run</th><th>Status</th><th>Runs</th><th>Actions</th></tr>
          </thead>
          <tbody id="ops-tasks-body">
            ${tasks.length === 0
              ? '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No scheduled tasks. Install a preset above or add a custom schedule.</td></tr>'
              : tasks.map(t => renderTaskRow(t)).join('')
            }
          </tbody>
        </table>
      </div>

      <div class="table-container" id="ops-add-form" style="display:none">
        <div class="table-header"><h3 id="ops-form-title">Add Schedule</h3></div>
        <div class="cfg-center-body">
          <div class="cfg-form-grid">
            <div class="cfg-field">
              <label>Name</label>
              <input id="ops-name" type="text" placeholder="My Task">
            </div>
            <div class="cfg-field">
              <label>Type</label>
              <select id="ops-type">
                <option value="tool">Tool</option>
                <option value="playbook">Playbook</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Target</label>
              <input id="ops-target" type="text" placeholder="tool name or playbook ID">
            </div>
            <div class="cfg-field">
              <label>Cron Expression</label>
              <input id="ops-cron" type="text" placeholder="*/30 * * * *">
            </div>
            <div class="cfg-field">
              <label>Args (JSON, optional)</label>
              <textarea id="ops-args" rows="3" placeholder='{"key": "value"}'></textarea>
            </div>
            <div class="cfg-field">
              <label>Event Name (optional)</label>
              <input id="ops-event" type="text" placeholder="custom_event_name">
            </div>
            <div class="cfg-field">
              <label>Enabled</label>
              <select id="ops-enabled">
                <option value="true" selected>true</option>
                <option value="false">false</option>
              </select>
            </div>
          </div>
          <div class="cfg-actions">
            <button class="btn btn-primary" id="ops-save">Create</button>
            <button class="btn btn-secondary" id="ops-cancel">Cancel</button>
            <span id="ops-save-status" class="cfg-save-status"></span>
          </div>
          <input type="hidden" id="ops-edit-id" value="">
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Run History</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Task</th><th>Status</th><th>Duration</th><th>Message</th></tr></thead>
          <tbody>
            ${history.length === 0
              ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No runs yet.</td></tr>'
              : history.slice(0, 50).map(h => `
                <tr>
                  <td>${formatTime(h.timestamp)}</td>
                  <td>${esc(h.taskName)}</td>
                  <td><span style="color:${statusColor(h.status)}">${esc(h.status)}</span></td>
                  <td>${h.durationMs}ms</td>
                  <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(h.message)}">${esc(h.message)}</td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>
    `;

    bindEvents(container, tasks);
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

function renderTaskRow(t) {
  return `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${esc(t.type)}</td>
      <td style="font-family:monospace">${esc(t.target)}</td>
      <td style="font-family:monospace">${esc(t.cron)}</td>
      <td>${t.lastRunAt ? formatTime(t.lastRunAt) : '-'}</td>
      <td>
        <span style="color:${t.enabled ? (t.lastRunStatus ? statusColor(t.lastRunStatus) : 'var(--text-muted)') : 'var(--text-muted)'}">
          ${t.enabled ? (t.lastRunStatus || 'idle') : 'disabled'}
        </span>
      </td>
      <td>${t.runCount || 0}</td>
      <td>
        <button class="btn btn-${t.enabled ? 'secondary' : 'primary'} ops-toggle" data-task-id="${escAttr(t.id)}" data-enabled="${t.enabled}">${t.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-primary ops-run" data-task-id="${escAttr(t.id)}">Run</button>
        <button class="btn btn-secondary ops-edit" data-task-id="${escAttr(t.id)}">Edit</button>
        <button class="btn btn-secondary ops-delete" data-task-id="${escAttr(t.id)}">Delete</button>
      </td>
    </tr>
  `;
}

function bindEvents(container, tasks) {
  // Preset install
  container.querySelectorAll('.preset-install').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const presetId = btn.closest('.preset-btn')?.getAttribute('data-preset-id');
      if (!presetId) return;
      btn.disabled = true;
      btn.textContent = 'Installing...';
      try {
        const result = await api.installScheduledTaskPreset(presetId);
        if (result.success) {
          await renderOperations(container);
        } else {
          btn.textContent = result.message || 'Failed';
          setTimeout(() => { btn.textContent = 'Install'; btn.disabled = false; }, 2000);
        }
      } catch (err) {
        btn.textContent = 'Error';
        setTimeout(() => { btn.textContent = 'Install'; btn.disabled = false; }, 2000);
      }
    });
  });

  // Add form toggle
  container.querySelector('#ops-add-toggle')?.addEventListener('click', () => {
    const form = container.querySelector('#ops-add-form');
    if (form) {
      form.style.display = form.style.display === 'none' ? '' : 'none';
      // Reset form for new task
      container.querySelector('#ops-edit-id').value = '';
      container.querySelector('#ops-form-title').textContent = 'Add Schedule';
      container.querySelector('#ops-save').textContent = 'Create';
      container.querySelector('#ops-name').value = '';
      container.querySelector('#ops-type').value = 'tool';
      container.querySelector('#ops-target').value = '';
      container.querySelector('#ops-cron').value = '';
      container.querySelector('#ops-args').value = '';
      container.querySelector('#ops-event').value = '';
      container.querySelector('#ops-enabled').value = 'true';
      container.querySelector('#ops-save-status').textContent = '';
    }
  });

  container.querySelector('#ops-cancel')?.addEventListener('click', () => {
    container.querySelector('#ops-add-form').style.display = 'none';
  });

  // Save (create or update)
  container.querySelector('#ops-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#ops-save-status');
    const editId = container.querySelector('#ops-edit-id').value;
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    let args;
    const argsRaw = container.querySelector('#ops-args').value.trim();
    if (argsRaw) {
      try {
        args = JSON.parse(argsRaw);
      } catch {
        statusEl.textContent = 'Invalid JSON in args';
        statusEl.style.color = 'var(--error)';
        return;
      }
    }

    const data = {
      name: container.querySelector('#ops-name').value.trim(),
      type: container.querySelector('#ops-type').value,
      target: container.querySelector('#ops-target').value.trim(),
      cron: container.querySelector('#ops-cron').value.trim(),
      args: args || undefined,
      emitEvent: container.querySelector('#ops-event').value.trim() || undefined,
      enabled: container.querySelector('#ops-enabled').value === 'true',
    };

    try {
      let result;
      if (editId) {
        result = await api.updateScheduledTask(editId, data);
      } else {
        result = await api.createScheduledTask(data);
      }
      statusEl.textContent = result.message || (result.success ? 'Saved' : 'Failed');
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      if (result.success) {
        setTimeout(() => renderOperations(container), 500);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  // Refresh
  container.querySelector('#ops-refresh')?.addEventListener('click', () => renderOperations(container));

  // Toggle enable/disable
  container.querySelectorAll('.ops-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const taskId = btn.getAttribute('data-task-id');
      const currentlyEnabled = btn.getAttribute('data-enabled') === 'true';
      btn.disabled = true;
      try {
        await api.updateScheduledTask(taskId, { enabled: !currentlyEnabled });
        await renderOperations(container);
      } catch {
        btn.disabled = false;
      }
    });
  });

  // Run now
  container.querySelectorAll('.ops-run').forEach(btn => {
    btn.addEventListener('click', async () => {
      const taskId = btn.getAttribute('data-task-id');
      btn.disabled = true;
      btn.textContent = 'Running...';
      try {
        const result = await api.runScheduledTaskNow(taskId);
        btn.textContent = result.success ? 'Done' : 'Failed';
        setTimeout(() => renderOperations(container), 1000);
      } catch {
        btn.textContent = 'Error';
        setTimeout(() => { btn.textContent = 'Run'; btn.disabled = false; }, 2000);
      }
    });
  });

  // Edit
  container.querySelectorAll('.ops-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const taskId = btn.getAttribute('data-task-id');
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;

      container.querySelector('#ops-add-form').style.display = '';
      container.querySelector('#ops-edit-id').value = task.id;
      container.querySelector('#ops-form-title').textContent = 'Edit Schedule';
      container.querySelector('#ops-save').textContent = 'Update';
      container.querySelector('#ops-name').value = task.name;
      container.querySelector('#ops-type').value = task.type;
      container.querySelector('#ops-target').value = task.target;
      container.querySelector('#ops-cron').value = task.cron;
      container.querySelector('#ops-args').value = task.args ? JSON.stringify(task.args, null, 2) : '';
      container.querySelector('#ops-event').value = task.emitEvent || '';
      container.querySelector('#ops-enabled').value = String(task.enabled);
      container.querySelector('#ops-save-status').textContent = '';
    });
  });

  // Delete
  container.querySelectorAll('.ops-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const taskId = btn.getAttribute('data-task-id');
      const task = tasks.find(t => t.id === taskId);
      if (!task || !confirm(`Delete scheduled task '${task.name}'?`)) return;
      try {
        await api.deleteScheduledTask(taskId);
        await renderOperations(container);
      } catch { /* ignore */ }
    });
  });
}

// ─── Utilities ───────────────────────────────────────────

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
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}
