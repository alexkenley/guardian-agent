/**
 * Configuration page — tabbed: Providers + Tools + Policy + Settings.
 */

import { api } from '../api.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';
import { themes, getSavedTheme, applyTheme } from '../theme.js';

// Shared state loaded once and passed to tabs
let sharedConfig = null;
let sharedProviders = null;
let sharedSetupStatus = null;
let sharedAuthStatus = null;

export async function renderConfig(container) {
  container.innerHTML = '<h2 class="page-title">Configuration</h2><div class="loading">Loading...</div>';

  try {
    [sharedConfig, sharedProviders, sharedSetupStatus, sharedAuthStatus] = await Promise.all([
      api.config(),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
      api.authStatus().catch(() => null),
    ]);

    container.innerHTML = '<h2 class="page-title">Configuration</h2>';

    createTabs(container, [
      { id: 'providers', label: 'Providers', render: renderProvidersTab },
      { id: 'tools', label: 'Tools', render: renderToolsTab },
      { id: 'policy', label: 'Policy', render: renderPolicyTab },
      { id: 'search-sources', label: 'Search Sources', render: renderSearchSourcesTab },
      { id: 'settings', label: 'Settings', render: renderSettingsTab },
      { id: 'appearance', label: 'Appearance', render: renderAppearanceTab },
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Configuration</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

// ─── Providers Tab ───────────────────────────────────────

function renderProvidersTab(panel) {
  const config = sharedConfig;
  const providers = sharedProviders;
  panel.innerHTML = '';

  panel.appendChild(createProviderPanel(config, providers, panel));
  panel.appendChild(createProviderStatusTable(config, providers));
  applyInputTooltips(panel);
}

function createProviderPanel(config, providers, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';

  const providerMap = Object.entries(config.llm || {}).reduce((acc, [name, cfg]) => {
    const live = providers.find(p => p.name === name);
    acc[name] = {
      ...cfg,
      locality: live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external'),
      connected: live?.connected,
      availableModels: live?.availableModels || [],
    };
    return acc;
  }, {});

  const localNames = Object.keys(providerMap).filter(name => providerMap[name].provider === 'ollama');
  const externalNames = Object.keys(providerMap).filter(name => providerMap[name].provider !== 'ollama');

  section.innerHTML = `
    <div class="table-header">
      <h3>AI Provider Configuration</h3>
      <span class="cfg-header-note">Configure local and external providers side by side</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-provider-panels">
        <div class="table-container" id="cfg-local-panel">
          <div class="table-header"><h3>Local Providers (Ollama)</h3></div>
          <div class="cfg-center-body">
            <div class="cfg-form-grid">
              <div class="cfg-field"><label>Profile</label><select id="cfg-local-profile"></select></div>
              <div class="cfg-field"><label>Provider Name</label><input id="cfg-local-name" type="text" placeholder="ollama"></div>
              <div class="cfg-field"><label>Model</label><select id="cfg-local-model-select" style="display:none"></select><input id="cfg-local-model" type="text" placeholder="llama3.2"></div>
              <div class="cfg-field"><label>Base URL</label><input id="cfg-local-url" type="text" placeholder="http://127.0.0.1:11434"></div>
            </div>
            <div class="cfg-form-grid" style="margin-top:0.75rem;">
              <div class="cfg-field"><label>Set As Default</label><select id="cfg-local-default"><option value="true">Yes</option><option value="false">No</option></select></div>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-secondary" id="cfg-local-test" type="button">Test Connection</button>
              <button class="btn btn-primary" id="cfg-local-save" type="button">Save</button>
              <span id="cfg-local-status" class="cfg-save-status"></span>
            </div>
          </div>
        </div>

        <div class="table-container" id="cfg-ext-panel">
          <div class="table-header"><h3>External Providers (APIs)</h3></div>
          <div class="cfg-center-body">
            <div class="cfg-form-grid">
              <div class="cfg-field"><label>Profile</label><select id="cfg-ext-profile"></select></div>
              <div class="cfg-field"><label>Provider Name</label><input id="cfg-ext-name" type="text" placeholder="claude"></div>
              <div class="cfg-field"><label>Provider Type</label><select id="cfg-ext-type"><option value="openai">openai</option><option value="anthropic">anthropic</option></select></div>
              <div class="cfg-field"><label>Model</label><select id="cfg-ext-model-select" style="display:none"></select><input id="cfg-ext-model" type="text" placeholder="claude-sonnet-4-6"></div>
              <div class="cfg-field"><label>API Key</label><input id="cfg-ext-key" type="password" placeholder="Leave blank to keep existing"></div>
              <div class="cfg-field"><label>Base URL (optional)</label><input id="cfg-ext-url" type="text" placeholder="Optional custom endpoint"></div>
            </div>
            <div class="cfg-form-grid" style="margin-top:0.75rem;">
              <div class="cfg-field"><label>Set As Default</label><select id="cfg-ext-default"><option value="true">Yes</option><option value="false">No</option></select></div>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-secondary" id="cfg-ext-test" type="button">Test Connection</button>
              <button class="btn btn-primary" id="cfg-ext-save" type="button">Save</button>
              <span id="cfg-ext-status" class="cfg-save-status"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  function getSuggestedName(side, type) {
    const base = side === 'local' ? 'ollama' : (type === 'anthropic' ? 'claude' : 'openai');
    if (!providerMap[base]) return base;
    let i = 2;
    while (providerMap[`${base}${i}`]) i += 1;
    return `${base}${i}`;
  }

  function getDefaultModel(side, type) {
    if (side === 'local') return 'llama3.2';
    return type === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o';
  }

  function wirePanel(side) {
    const isLocal = side === 'local';
    const prefix = isLocal ? 'cfg-local' : 'cfg-ext';
    const names = isLocal ? localNames : externalNames;

    const profileEl = section.querySelector(`#${prefix}-profile`);
    const nameEl = section.querySelector(`#${prefix}-name`);
    const modelInputEl = section.querySelector(`#${prefix}-model`);
    const modelSelectEl = section.querySelector(`#${prefix}-model-select`);
    const urlEl = section.querySelector(`#${prefix}-url`);
    const defaultEl = section.querySelector(`#${prefix}-default`);
    const statusEl = section.querySelector(`#${prefix}-status`);
    const typeEl = isLocal ? null : section.querySelector('#cfg-ext-type');
    const keyEl = isLocal ? null : section.querySelector('#cfg-ext-key');

    // Model accessor — reads from whichever element is visible
    const modelEl = {
      get value() { return modelSelectEl.style.display !== 'none' ? modelSelectEl.value : modelInputEl.value; },
      set value(v) { modelInputEl.value = v; if (modelSelectEl.style.display !== 'none') modelSelectEl.value = v; },
    };

    /** Show a <select> dropdown if models are available, otherwise fall back to text input. */
    function updateModelSelector(models, currentModel) {
      if (models && models.length > 0) {
        const customOpt = currentModel && !models.includes(currentModel)
          ? `<option value="${esc(currentModel)}">${esc(currentModel)} (custom)</option>` : '';
        modelSelectEl.innerHTML = customOpt + models.map(m =>
          `<option value="${esc(m)}"${m === currentModel ? ' selected' : ''}>${esc(m)}</option>`
        ).join('');
        modelSelectEl.style.display = '';
        modelInputEl.style.display = 'none';
      } else {
        modelSelectEl.style.display = 'none';
        modelInputEl.style.display = '';
      }
    }

    function renderProfiles() {
      const options = ['__new__', ...names];
      profileEl.innerHTML = options.map(name => {
        if (name === '__new__') return '<option value="__new__">Create new profile...</option>';
        const info = providerMap[name];
        const st = info.connected === false ? 'offline' : 'online';
        return `<option value="${esc(name)}">${esc(name)} (${esc(info.provider)}, ${st})</option>`;
      }).join('');

      const firstConfigured = options.find(n => n !== '__new__') || '__new__';
      const defaultInSide = names.includes(config.defaultProvider) ? config.defaultProvider : firstConfigured;
      profileEl.value = defaultInSide;
      applyProfile(defaultInSide);
    }

    function applyProfile(name) {
      if (name === '__new__') {
        const pt = isLocal ? 'ollama' : (typeEl?.value || 'openai');
        nameEl.value = getSuggestedName(side, pt);
        const defaultModel = getDefaultModel(side, pt);
        updateModelSelector([], null);
        modelInputEl.value = defaultModel;
        urlEl.value = isLocal ? 'http://127.0.0.1:11434' : '';
        if (keyEl) keyEl.value = '';
        return;
      }
      const entry = providerMap[name];
      if (!entry) return;
      nameEl.value = name;
      updateModelSelector(entry.availableModels, entry.model || '');
      if (!entry.availableModels?.length) modelInputEl.value = entry.model || '';
      urlEl.value = entry.baseUrl || '';
      if (typeEl) typeEl.value = entry.provider === 'ollama' ? 'openai' : entry.provider;
      if (keyEl) keyEl.value = '';
    }

    profileEl.addEventListener('change', () => applyProfile(profileEl.value));

    if (typeEl) {
      typeEl.addEventListener('change', () => {
        if (profileEl.value === '__new__' && !modelEl.value.trim()) {
          modelEl.value = getDefaultModel('external', typeEl.value);
        }
      });
    }

    section.querySelector(`#${prefix}-test`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      if (!providerName) { statusEl.textContent = 'Set provider name first.'; statusEl.style.color = 'var(--warning)'; return; }
      statusEl.textContent = `Testing ${providerName}...`;
      statusEl.style.color = 'var(--text-muted)';
      try {
        const latest = await api.providersStatus();
        const found = latest.find(p => p.name === providerName);
        if (!found) { statusEl.textContent = `'${providerName}' not in runtime (save first).`; statusEl.style.color = 'var(--warning)'; return; }
        if (found.connected === false) { statusEl.textContent = `${providerName}: disconnected.`; statusEl.style.color = 'var(--error)'; }
        else {
          const count = found.availableModels?.length || 0;
          statusEl.textContent = `${providerName}: connected (${count} model${count === 1 ? '' : 's'}).`;
          statusEl.style.color = 'var(--success)';
          // Refresh model dropdown with live models
          if (found.availableModels?.length) {
            const currentModel = modelSelectEl.style.display !== 'none' ? modelSelectEl.value : modelInputEl.value;
            updateModelSelector(found.availableModels, currentModel);
            if (providerMap[providerName]) providerMap[providerName].availableModels = found.availableModels;
          }
        }
      } catch (err) { statusEl.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`; statusEl.style.color = 'var(--error)'; }
    });

    section.querySelector(`#${prefix}-save`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      const model = modelEl.value.trim();
      const baseUrl = urlEl.value.trim();
      const providerType = isLocal ? 'ollama' : (typeEl?.value || 'openai');

      if (!providerName) { statusEl.textContent = 'Provider name is required.'; statusEl.style.color = 'var(--error)'; return; }
      if (!model) { statusEl.textContent = 'Model is required.'; statusEl.style.color = 'var(--error)'; return; }

      const payload = {
        llmMode: isLocal ? 'ollama' : 'external',
        providerName, providerType, model,
        baseUrl: baseUrl || undefined,
        apiKey: keyEl?.value.trim() || undefined,
        setDefaultProvider: defaultEl.value === 'true',
        setupCompleted: true,
      };

      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.applyConfig(payload);
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      } catch (err) { statusEl.textContent = err instanceof Error ? err.message : String(err); statusEl.style.color = 'var(--error)'; }
    });

    renderProfiles();
  }

  wirePanel('local');
  wirePanel('external');
  applyInputTooltips(section);
  return section;
}

function createProviderStatusTable(config, providers) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const rows = Object.entries(config.llm || {}).map(([name, cfg]) => {
    const live = providers.find(p => p.name === name);
    const connected = live ? (live.connected !== false) : true;
    const locality = live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external');
    const statusBadge = `<span class="badge ${connected ? 'badge-idle' : 'badge-errored'}">${connected ? 'Connected' : 'Disconnected'}</span>`;
    const modelList = live?.availableModels?.slice(0, 5).join(', ') || '-';
    const defaultMark = name === config.defaultProvider ? ' (default)' : '';
    return `<tr><td><strong>${esc(name)}</strong>${esc(defaultMark)}</td><td>${esc(cfg.provider)}</td><td>${esc(cfg.model)}</td><td>${esc(locality)}</td><td>${statusBadge}</td><td>${esc(modelList)}</td></tr>`;
  }).join('');

  section.innerHTML = `
    <div class="table-header"><h3>Configured Providers</h3></div>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Locality</th><th>Status</th><th>Available Models</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">No providers configured</td></tr>'}</tbody>
    </table>
  `;
  return section;
}

// ─── Tools Tab ───────────────────────────────────────────

async function renderToolsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [state, gwsStatus] = await Promise.all([
      api.toolsState(80),
      api.gwsStatus().catch(() => null),
    ]);
    const tools = state.tools || [];
    const approvals = state.approvals || [];
    const jobs = state.jobs || [];
    const categories = state.categories || [];

    panel.innerHTML = `
      <div class="intel-summary-grid">
        <div class="status-card ${state.enabled ? 'success' : 'error'}">
          <div class="card-title">Tool Runtime</div>
          <div class="card-value">${state.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Assistant + manual task execution</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Catalog</div>
          <div class="card-value">${tools.length}</div>
          <div class="card-subtitle">Available tools</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Pending Tool Approvals</div>
          <div class="card-value">${approvals.filter(a => a.status === 'pending').length}</div>
          <div class="card-subtitle">Global queue across channels</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Recent Jobs</div>
          <div class="card-value">${jobs.length}</div>
          <div class="card-subtitle">Execution history</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Execution Mode</h3></div>
        <div style="padding:0.75rem 1rem;display:flex;align-items:center;gap:0.75rem;">
          <label style="font-size:0.75rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.5rem;">
            <input type="checkbox" id="dry-run-toggle" ${state.dryRunDefault ? 'checked' : ''}>
            Dry Run Mode
          </label>
          <span style="font-size:0.72rem;color:var(--text-muted);">When enabled, mutating tools validate but do not execute side effects.</span>
        </div>
      </div>

      ${categories.length > 0 ? `
      <div class="table-container">
        <div class="table-header"><h3>Tool Categories</h3></div>
        <table>
          <thead><tr><th>Category</th><th>Label</th><th>Tools</th><th>Status</th><th>Description</th></tr></thead>
          <tbody>
            ${categories.map(cat => `
              <tr>
                <td>${esc(cat.category)}</td>
                <td>${esc(cat.label)}</td>
                <td>${cat.toolCount}</td>
                <td>
                  <label class="toggle-switch" style="margin:0;">
                    <input type="checkbox" class="category-toggle" data-category="${escAttr(cat.category)}" ${cat.enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </td>
                <td style="font-size:0.72rem;">${esc(cat.description)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ` : ''}

      ${gwsStatus ? `
      <div class="table-container">
        <div class="table-header">
          <h3>Google Workspace</h3>
          <span class="cfg-header-note">Gmail, Calendar, Drive, Docs, Sheets</span>
        </div>
        <div style="padding:0.75rem 1rem;">
          <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;">
            <div style="font-size:0.75rem;">
              <span style="color:var(--text-secondary);">Status:</span>
              ${gwsStatus.authenticated
                ? `<span class="badge badge-running">Connected</span>`
                : `<span class="badge badge-errored">Not connected</span>`}
            </div>
            ${gwsStatus.authenticated && gwsStatus.authMethod ? `
              <div style="font-size:0.75rem;">
                <span style="color:var(--text-secondary);">Auth:</span>
                <span style="color:var(--text-primary);">${esc(gwsStatus.authMethod)}</span>
              </div>
            ` : ''}
            ${gwsStatus.services.length > 0 ? `
              <div style="font-size:0.75rem;">
                <span style="color:var(--text-secondary);">Services:</span>
                <span style="color:var(--text-primary);">${gwsStatus.services.map(s => esc(s)).join(', ')}</span>
              </div>
            ` : ''}
            ${!gwsStatus.installed ? `
              <div style="font-size:0.72rem;color:var(--text-muted);">Google Workspace CLI not found.</div>
            ` : ''}
          </div>
          ${gwsStatus.installed ? `
          <div style="margin-top:0.75rem;display:flex;gap:0.5rem;">
            ${!gwsStatus.authenticated ? `
              <button class="btn btn-secondary" id="gws-login" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Connect Google Account</button>
            ` : `
              <button class="btn btn-secondary" id="gws-logout" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Disconnect</button>
            `}
          </div>
          ` : ''}
        </div>
      </div>
      ` : ''}

      <div class="table-container">
        <div class="table-header">
          <h3>Tool Catalog</h3>
          <button class="btn btn-secondary" id="tools-refresh" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Refresh</button>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Risk</th><th>Description</th></tr></thead>
          <tbody>
            ${tools.length === 0
              ? '<tr><td colspan="3">No tools registered.</td></tr>'
              : tools.map(tool => `
                <tr>
                  <td>${esc(tool.name)}</td>
                  <td><span class="badge ${riskClass(tool.risk)}">${esc(tool.risk)}</span></td>
                  <td>${esc(tool.description)}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Pending Approvals</h3></div>
        <table>
          <thead><tr><th>Approval</th><th>Tool</th><th>Risk</th><th>Origin</th><th>Created</th><th>Decision</th></tr></thead>
          <tbody>
            ${approvals.length === 0
              ? '<tr><td colspan="6">No approvals.</td></tr>'
              : approvals.map(approval => `
                <tr>
                  <td title="${esc(approval.id)}">${esc(shortId(approval.id))}</td>
                  <td>${esc(approval.toolName)}</td>
                  <td>${esc(approval.risk)}</td>
                  <td>${esc(approval.origin)}</td>
                  <td>${esc(formatDate(approval.createdAt))}</td>
                  <td>
                    ${approval.status === 'pending' ? `
                      <button class="btn btn-secondary tool-approve" data-approval-id="${escAttr(approval.id)}" data-decision="approved">Approve</button>
                      <button class="btn btn-secondary tool-approve" data-approval-id="${escAttr(approval.id)}" data-decision="denied">Deny</button>
                    ` : `<span class="badge ${approval.status === 'approved' ? 'badge-running' : 'badge-errored'}">${esc(approval.status)}</span>`}
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Tool Jobs</h3></div>
        <table>
          <thead><tr><th>Job</th><th>Tool</th><th>Status</th><th>Origin</th><th>Created</th><th>Duration</th><th>Detail</th></tr></thead>
          <tbody>
            ${jobs.length === 0
              ? '<tr><td colspan="7">No tool jobs yet.</td></tr>'
              : jobs.map(job => `
                <tr>
                  <td title="${esc(job.id)}">${esc(shortId(job.id))}</td>
                  <td>${esc(job.toolName)}</td>
                  <td><span class="badge ${statusClass(job.status)}">${esc(job.status)}</span></td>
                  <td>${esc(job.origin)}</td>
                  <td>${esc(formatDate(job.createdAt))}</td>
                  <td>${job.durationMs ? `${job.durationMs}ms` : '-'}</td>
                  <td>${esc(job.error || job.resultPreview || job.argsPreview || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;

    panel.querySelector('#tools-refresh')?.addEventListener('click', () => renderToolsTab(panel));

    panel.querySelector('#gws-login')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#gws-login');
      btn.disabled = true;
      btn.textContent = 'Connecting...';
      try {
        const result = await api.gwsLogin();
        if (result.success) {
          await renderToolsTab(panel);
        } else {
          alert(result.message || 'Google login failed.');
          btn.disabled = false;
          btn.textContent = 'Connect Google Account';
        }
      } catch (err) {
        alert(err.message || 'Google login failed.');
        btn.disabled = false;
        btn.textContent = 'Connect Google Account';
      }
    });

    panel.querySelector('#gws-logout')?.addEventListener('click', async () => {
      if (!confirm('Disconnect Google Workspace? This will clear saved credentials.')) return;
      try {
        const result = await api.gwsLogout();
        if (result.success) {
          await renderToolsTab(panel);
        } else {
          alert(result.message || 'Logout failed.');
        }
      } catch (err) {
        alert(err.message || 'Logout failed.');
      }
    });

    panel.querySelectorAll('.category-toggle').forEach(toggle => {
      toggle.addEventListener('change', async () => {
        const category = toggle.getAttribute('data-category');
        const enabled = toggle.checked;
        if (!category) return;
        try {
          const result = await api.toggleToolCategory({ category, enabled });
          if (!result.success) { alert(result.message || 'Failed to toggle category.'); toggle.checked = !enabled; }
          else await renderToolsTab(panel);
        } catch (err) { alert(err.message || 'Failed to toggle category.'); toggle.checked = !enabled; }
      });
    });

    panel.querySelectorAll('.tool-approve').forEach(button => {
      button.addEventListener('click', async () => {
        const approvalId = button.getAttribute('data-approval-id');
        const decision = button.getAttribute('data-decision');
        if (!approvalId || !decision) return;
        try {
          const result = await api.decideToolApproval({ approvalId, decision, actor: 'web-user' });
          if (!result.success) alert(result.message || 'Failed to update approval.');
          await renderToolsTab(panel);
        } catch (err) { alert(err.message || 'Failed to update approval.'); }
      });
    });

    applyInputTooltips(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message || String(err))}</div>`;
  }
}

// ─── Policy Tab (Interactive Allowlist Editor) ───────────

async function renderPolicyTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const state = await api.toolsState(1);
    const policy = state.policy || { mode: 'approve_by_policy', sandbox: { allowedPaths: [], allowedCommands: [], allowedDomains: [] } };

    const categories = [
      { key: 'allowedPaths', label: 'Allowed Paths', icon: 'folder', placeholder: 'e.g. /home/user/data', hint: 'Filesystem paths the sandbox can access' },
      { key: 'allowedCommands', label: 'Allowed Commands', icon: 'terminal', placeholder: 'e.g. ls, cat, ping', hint: 'Shell commands the sandbox can execute' },
      { key: 'allowedDomains', label: 'Allowed Domains', icon: 'globe', placeholder: 'e.g. api.github.com', hint: 'Network domains the sandbox can reach' },
    ];

    const iconSvgs = {
      folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
      terminal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
    };

    const modeLabels = {
      approve_all: { label: 'Approve All', desc: 'Every tool call requires manual approval', tone: 'warning' },
      approve_by_policy: { label: 'Policy-Based', desc: 'Allowlisted items auto-approve; others require confirmation', tone: 'info' },
      auto_approve: { label: 'Auto Approve', desc: 'All tool calls execute without approval', tone: 'error' },
    };

    function render() {
      const modeInfo = modeLabels[policy.mode] || { label: policy.mode, desc: '', tone: 'info' };
      const totalItems = categories.reduce((sum, c) => sum + (policy.sandbox?.[c.key]?.length || 0), 0);

      panel.innerHTML = `
        <div class="policy-overview">
          <div class="status-card ${modeInfo.tone}">
            <div class="card-title">Execution Mode</div>
            <div class="card-value">${esc(modeInfo.label)}</div>
            <div class="card-subtitle">${esc(modeInfo.desc)}</div>
          </div>
          <div class="status-card accent">
            <div class="card-title">Allowlist Entries</div>
            <div class="card-value">${totalItems}</div>
            <div class="card-subtitle">${categories.map(c => `${policy.sandbox?.[c.key]?.length || 0} ${c.label.toLowerCase().replace('allowed ', '')}`).join(', ')}</div>
          </div>
        </div>

        <div class="policy-columns">
          ${categories.map(cat => {
            const items = policy.sandbox?.[cat.key] || [];
            return `
              <div class="table-container policy-category-card" data-category="${cat.key}">
                <div class="table-header">
                  <h3>${iconSvgs[cat.icon]} ${esc(cat.label)}</h3>
                  <span class="badge badge-idle">${items.length}</span>
                </div>
                <div class="cfg-center-body">
                  <p class="policy-hint">${esc(cat.hint)}</p>
                  <div class="policy-add-row">
                    <input type="text" class="policy-add-input" data-category="${cat.key}" placeholder="${esc(cat.placeholder)}">
                    <button class="btn btn-primary btn-sm policy-add-btn" data-category="${cat.key}">Add</button>
                  </div>
                  <div class="policy-item-list" data-category="${cat.key}">
                    ${items.length === 0
                      ? '<div class="policy-empty">No entries yet</div>'
                      : items.map(item => `
                        <div class="policy-item" data-category="${cat.key}" data-item="${escAttr(item)}">
                          <code>${esc(item)}</code>
                          <button class="policy-item-remove" data-category="${cat.key}" data-item="${escAttr(item)}" title="Remove ${esc(item)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>
                      `).join('')}
                  </div>
                  <div class="policy-feedback" data-category="${cat.key}"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      // Wire add buttons and Enter key
      panel.querySelectorAll('.policy-add-btn').forEach(btn => {
        btn.addEventListener('click', () => addItem(btn.dataset.category));
      });
      panel.querySelectorAll('.policy-add-input').forEach(input => {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(input.dataset.category); });
      });

      // Wire remove buttons
      panel.querySelectorAll('.policy-item-remove').forEach(btn => {
        btn.addEventListener('click', () => removeItem(btn.dataset.category, btn.dataset.item));
      });

      applyInputTooltips(panel);
    }

    function feedback(catKey, message, tone = 'muted') {
      const el = panel.querySelector(`.policy-feedback[data-category="${catKey}"]`);
      if (!el) return;
      el.textContent = message;
      el.style.color = tone === 'error' ? 'var(--error)' : tone === 'success' ? 'var(--success)' : tone === 'warning' ? 'var(--warning)' : 'var(--text-muted)';
      if (tone === 'success') setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 2000);
    }

    async function addItem(catKey) {
      const input = panel.querySelector(`.policy-add-input[data-category="${catKey}"]`);
      if (!input) return;
      // Support comma-separated bulk add
      const values = input.value.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;

      const current = policy.sandbox?.[catKey] || [];
      const dupes = values.filter(v => current.includes(v));
      const newValues = values.filter(v => !current.includes(v));

      if (newValues.length === 0) {
        feedback(catKey, dupes.length === 1 ? `"${dupes[0]}" already exists.` : 'All items already exist.', 'warning');
        return;
      }

      const updated = [...current, ...newValues];
      feedback(catKey, 'Saving...', 'muted');
      try {
        const result = await api.updateToolPolicy({ sandbox: { [catKey]: updated } });
        if (result.success !== false) {
          if (!policy.sandbox) policy.sandbox = {};
          policy.sandbox[catKey] = updated;
          const added = newValues.length === 1 ? `Added "${newValues[0]}"` : `Added ${newValues.length} items`;
          const dupeNote = dupes.length > 0 ? ` (${dupes.length} duplicate${dupes.length > 1 ? 's' : ''} skipped)` : '';
          render();
          feedback(catKey, added + dupeNote, 'success');
        } else {
          feedback(catKey, result.message || 'Failed to save.', 'error');
        }
      } catch (err) {
        feedback(catKey, err instanceof Error ? err.message : String(err), 'error');
      }
    }

    async function removeItem(catKey, item) {
      const current = policy.sandbox?.[catKey] || [];
      const updated = current.filter(i => i !== item);

      // Optimistic UI: immediately fade the item
      const itemEl = panel.querySelector(`.policy-item[data-category="${catKey}"][data-item="${CSS.escape(item)}"]`);
      if (itemEl) itemEl.style.opacity = '0.4';

      try {
        const result = await api.updateToolPolicy({ sandbox: { [catKey]: updated } });
        if (result.success !== false) {
          policy.sandbox[catKey] = updated;
          render();
          feedback(catKey, `Removed "${item}"`, 'success');
        } else {
          if (itemEl) itemEl.style.opacity = '1';
          feedback(catKey, result.message || 'Failed to remove.', 'error');
        }
      } catch (err) {
        if (itemEl) itemEl.style.opacity = '1';
        feedback(catKey, err instanceof Error ? err.message : String(err), 'error');
      }
    }

    render();
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message || String(err))}</div>`;
  }
}

// ─── Search Sources Tab (QMD) ────────────────────────────

function renderSearchSourcesTab(panel) {
  const qmdCfg = sharedConfig?.assistant?.tools?.qmd || {};
  const state = {
    enabled: qmdCfg.enabled !== false,
    runtimeAvailable: qmdCfg.enabled !== false,
    status: null,
    sources: Array.isArray(qmdCfg.sources) ? [...qmdCfg.sources] : [],
    filter: '',
  };

  panel.innerHTML = `
    <div class="intel-summary-grid qmd-summary-grid" id="qmd-summary-grid"></div>
    <div class="qmd-feedback qmd-feedback-muted" id="qmd-feedback"></div>

    <div class="table-container">
      <div class="table-header">
        <h3>Document Sources</h3>
        <div class="qmd-toolbar-actions">
          <button class="btn btn-secondary btn-sm" id="qmd-config-toggle" type="button">${state.enabled ? 'Disable QMD' : 'Enable QMD'}</button>
          <button class="btn btn-secondary btn-sm" id="qmd-refresh" type="button">Refresh</button>
          <button class="btn btn-secondary btn-sm" id="qmd-reindex-all" type="button" ${state.enabled ? '' : 'disabled'}>Reindex All</button>
          <button class="btn btn-primary btn-sm" id="qmd-add-source" type="button" aria-expanded="false">+ Add Source</button>
        </div>
      </div>
      <div class="cfg-center-body">
        <div class="qmd-filter-row">
          <div class="qmd-filter-field">
            <label for="qmd-source-filter">Filter Sources</label>
            <input id="qmd-source-filter" type="text" placeholder="Filter by id, name, path, or type">
          </div>
          <div class="qmd-hint">
            ${state.enabled
    ? 'Add, enable, disable, reindex, and remove document sources from one place.'
    : 'QMD is disabled in config. Enable it here, then restart to activate runtime source management.'}
          </div>
        </div>
      </div>
    </div>

    <div class="table-container qmd-add-form-wrap" id="qmd-add-form-wrap" hidden>
      <div class="table-header"><h3>Add Source</h3></div>
      <div class="cfg-center-body">
        <form id="qmd-add-form" class="qmd-add-form-grid">
          <div class="cfg-field"><label>ID (collection)</label><input name="id" required placeholder="my-notes"></div>
          <div class="cfg-field"><label>Display Name</label><input name="name" required placeholder="My Notes"></div>
          <div class="cfg-field">
            <label>Type</label>
            <select name="type">
              <option value="directory">Directory</option>
              <option value="git">Git Repository</option>
              <option value="url">URL</option>
              <option value="file">Single File</option>
            </select>
          </div>
          <div class="cfg-field"><label>Path / URL</label><input name="path" required placeholder="/home/user/notes or https://..."></div>
          <div class="cfg-field" data-qmd-field="globs">
            <label>Globs</label>
            <input name="globs" placeholder="**/*.md, **/*.txt">
          </div>
          <div class="cfg-field" data-qmd-field="branch">
            <label>Git Branch</label>
            <input name="branch" placeholder="main">
          </div>
          <div class="cfg-field qmd-form-span-2">
            <label>Description</label>
            <input name="description" placeholder="Optional description">
          </div>
          <div class="cfg-actions qmd-form-span-2">
            <button class="btn btn-primary" type="submit">Add Source</button>
            <button class="btn btn-secondary" type="button" id="qmd-add-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <div class="table-container">
      <div class="table-header">
        <h3>Configured Sources</h3>
        <span class="cfg-header-note" id="qmd-source-count">0 sources</span>
      </div>
      <div class="cfg-center-body qmd-sources-wrap" id="qmd-sources-area">
        <div class="loading">Loading...</div>
      </div>
    </div>
  `;

  const feedbackEl = panel.querySelector('#qmd-feedback');
  const summaryEl = panel.querySelector('#qmd-summary-grid');
  const configToggleBtn = panel.querySelector('#qmd-config-toggle');
  const addBtn = panel.querySelector('#qmd-add-source');
  const addWrap = panel.querySelector('#qmd-add-form-wrap');
  const addForm = panel.querySelector('#qmd-add-form');
  const addCancelBtn = panel.querySelector('#qmd-add-cancel');
  const refreshBtn = panel.querySelector('#qmd-refresh');
  const reindexAllBtn = panel.querySelector('#qmd-reindex-all');
  const filterInput = panel.querySelector('#qmd-source-filter');
  const sourcesArea = panel.querySelector('#qmd-sources-area');
  const sourceCountEl = panel.querySelector('#qmd-source-count');

  const typeLabels = {
    directory: 'Directory',
    git: 'Git Repo',
    url: 'URL',
    file: 'File',
  };

  function setFeedback(message, tone = 'muted') {
    feedbackEl.className = `qmd-feedback qmd-feedback-${tone}`;
    feedbackEl.textContent = message;
  }

  function canManageSources() {
    return state.enabled && state.runtimeAvailable;
  }

  function updateManageControls() {
    const canManage = canManageSources();
    addBtn.disabled = false;
    addBtn.classList.toggle('btn-primary', canManage);
    addBtn.classList.toggle('btn-secondary', !canManage);
    addBtn.title = canManage
      ? 'Add a new document source'
      : 'QMD runtime is unavailable. Click for guidance.';
    reindexAllBtn.disabled = !canManage;
    filterInput.disabled = false;
    configToggleBtn.textContent = state.enabled ? 'Disable QMD' : 'Enable QMD';
    if (state.enabled) {
      configToggleBtn.classList.remove('btn-primary');
      configToggleBtn.classList.add('btn-secondary');
    } else {
      configToggleBtn.classList.remove('btn-secondary');
      configToggleBtn.classList.add('btn-primary');
    }
  }

  function renderSummary() {
    const installed = state.enabled
      ? (state.status?.installed === true ? 'Yes' : state.status?.installed === false ? 'No' : 'Unknown')
      : 'Disabled';
    const installedTone = state.enabled
      ? (state.status?.installed === true ? 'success' : state.status?.installed === false ? 'error' : 'warning')
      : 'warning';
    const collections = Array.isArray(state.status?.collections) ? state.status.collections.length : 0;
    const sourceCount = state.sources.length;
    const enabledCount = state.sources.filter((source) => source.enabled !== false).length;
    const versionValue = state.status?.version ? esc(state.status.version) : 'n/a';

    summaryEl.innerHTML = `
      <div class="status-card ${installedTone}">
        <div class="card-title">QMD Installed</div>
        <div class="card-value">${esc(installed)}</div>
        <div class="card-subtitle">${state.enabled ? 'Runtime binary availability' : 'Service is not active in current config'}</div>
      </div>
      <div class="status-card info">
        <div class="card-title">QMD Version</div>
        <div class="card-value">${versionValue}</div>
        <div class="card-subtitle">Reported by runtime status</div>
      </div>
      <div class="status-card accent">
        <div class="card-title">Collections</div>
        <div class="card-value">${collections}</div>
        <div class="card-subtitle">Known in QMD index</div>
      </div>
      <div class="status-card warning">
        <div class="card-title">Configured Sources</div>
        <div class="card-value">${sourceCount}</div>
        <div class="card-subtitle">${enabledCount} enabled</div>
      </div>
    `;
  }

  function toggleAddForm(show) {
    addWrap.hidden = !show;
    addBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      addForm.querySelector('input[name="id"]')?.focus();
    }
  }

  function syncAddFormFields() {
    const type = addForm.querySelector('select[name="type"]')?.value || 'directory';
    const globsField = addForm.querySelector('[data-qmd-field="globs"]');
    const branchField = addForm.querySelector('[data-qmd-field="branch"]');
    const showGlobs = type === 'directory' || type === 'git';
    const showBranch = type === 'git';
    if (globsField) globsField.hidden = !showGlobs;
    if (branchField) branchField.hidden = !showBranch;
  }

  function renderSources() {
    const canManage = canManageSources();
    const normalized = state.filter.trim().toLowerCase();
    const filtered = normalized
      ? state.sources.filter((source) => {
        const haystack = [
          source.id,
          source.name,
          source.path,
          source.type,
          source.description,
        ].map((item) => String(item || '').toLowerCase()).join(' ');
        return haystack.includes(normalized);
      })
      : state.sources;

    sourceCountEl.textContent = `${filtered.length} of ${state.sources.length} source${state.sources.length === 1 ? '' : 's'}`;

    if (state.sources.length === 0) {
      sourcesArea.innerHTML = `
        <div class="qmd-empty-state">
          <strong>No sources configured.</strong>
          <span>Add a source to start indexing notes, repos, or documents.</span>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      sourcesArea.innerHTML = `
        <div class="qmd-empty-state">
          <strong>No matching sources.</strong>
          <span>Try a different filter or clear the search input.</span>
        </div>
      `;
      return;
    }

    sourcesArea.innerHTML = `
      <div class="qmd-table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Type</th><th>Path</th><th>Pattern</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${filtered.map((source) => {
    const globs = Array.isArray(source.globs) && source.globs.length > 0
      ? source.globs.map((glob) => `<code>${esc(glob)}</code>`).join(', ')
      : '<span class="qmd-muted">default</span>';
    const branch = source.branch ? ` <span class="qmd-muted">(${esc(source.branch)})</span>` : '';
    return `
                <tr>
                  <td>
                    <strong>${esc(source.name)}</strong>
                    <div class="qmd-muted">${esc(source.id)}${source.description ? ` • ${esc(source.description)}` : ''}</div>
                  </td>
                  <td>${esc(typeLabels[source.type] || source.type)}${branch}</td>
                  <td class="qmd-path-cell" title="${esc(source.path)}">${esc(source.path)}</td>
                  <td>${globs}</td>
                  <td>
                    <label class="toggle-switch">
                      <input type="checkbox" ${source.enabled !== false ? 'checked' : ''} data-source-id="${escAttr(source.id)}" class="qmd-toggle" ${canManage ? '' : 'disabled'}>
                      <span class="toggle-slider"></span>
                    </label>
                  </td>
                  <td class="qmd-actions-cell">
                    <button class="btn btn-secondary btn-sm qmd-action" data-action="reindex" data-source-id="${escAttr(source.id)}" ${canManage ? '' : 'disabled'}>Reindex</button>
                    <button class="btn btn-danger btn-sm qmd-action" data-action="remove" data-source-id="${escAttr(source.id)}" ${canManage ? '' : 'disabled'}>Remove</button>
                  </td>
                </tr>
              `;
  }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function refreshStatus() {
    if (!state.enabled) return;
    state.status = await api.qmdStatus();
  }

  async function refreshSources() {
    if (!state.enabled) return;
    state.sources = await api.qmdSources();
  }

  async function refreshAll(showMessage = false) {
    try {
      if (state.enabled) {
        await Promise.all([refreshStatus(), refreshSources()]);
        state.runtimeAvailable = true;
      }
      renderSummary();
      renderSources();
      updateManageControls();
      if (showMessage) setFeedback('Search sources refreshed.', 'success');
      if (state.enabled && state.status?.installed === false) {
        setFeedback('QMD is unavailable in this runtime. Run npm install to include bundled QMD, or set assistant.tools.qmd.binaryPath.', 'warning');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (state.enabled && /not available/i.test(message)) {
        state.runtimeAvailable = false;
        setFeedback('QMD is enabled in config but not active in this runtime. Restart GuardianAgent to apply the change.', 'warning');
      } else {
        setFeedback(`Failed to refresh search sources: ${message}`, 'error');
      }
      renderSummary();
      renderSources();
      updateManageControls();
    }
  }

  configToggleBtn.addEventListener('click', async () => {
    const nextEnabled = !state.enabled;
    configToggleBtn.disabled = true;
    try {
      const result = await api.updateConfig({
        assistant: {
          tools: {
            qmd: { enabled: nextEnabled },
          },
        },
      });
      if (!result.success) {
        throw new Error(result.message || 'Failed to update QMD setting.');
      }

      state.enabled = nextEnabled;
      state.runtimeAvailable = nextEnabled ? state.runtimeAvailable : false;
      if (sharedConfig) {
        sharedConfig.assistant = sharedConfig.assistant || {};
        sharedConfig.assistant.tools = sharedConfig.assistant.tools || {};
        sharedConfig.assistant.tools.qmd = sharedConfig.assistant.tools.qmd || { sources: [] };
        sharedConfig.assistant.tools.qmd.enabled = nextEnabled;
      }
      if (!nextEnabled) {
        toggleAddForm(false);
      }
      renderSummary();
      renderSources();
      updateManageControls();
      setFeedback(
        `Saved: QMD ${nextEnabled ? 'enabled' : 'disabled'} in config. Restart GuardianAgent to apply runtime changes.`,
        'warning',
      );
      if (nextEnabled) {
        void refreshAll();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      configToggleBtn.disabled = false;
    }
  });

  addBtn.addEventListener('click', () => {
    if (!state.enabled) {
      setFeedback('QMD is disabled. Enable it first, then restart GuardianAgent to manage live sources.', 'warning');
      return;
    }
    if (!state.runtimeAvailable) {
      setFeedback('QMD is enabled in config but not active in this runtime. Restart GuardianAgent to manage sources.', 'warning');
      return;
    }
    toggleAddForm(addWrap.hidden);
  });

  addCancelBtn.addEventListener('click', () => {
    addForm.reset();
    syncAddFormFields();
    toggleAddForm(false);
  });

  addForm.querySelector('select[name="type"]')?.addEventListener('change', syncAddFormFields);

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canManageSources()) {
      setFeedback('QMD source management is unavailable until QMD is enabled and active in runtime.', 'warning');
      return;
    }

    const submitBtn = addForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';
    try {
      const formData = new FormData(addForm);
      const sourceId = String(formData.get('id') || '').trim();
      const sourceType = String(formData.get('type') || 'directory').trim();
      const sourcePath = String(formData.get('path') || '').trim();
      const sourceName = String(formData.get('name') || '').trim();
      if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(sourceId)) {
        throw new Error('Source ID must be 2-64 chars using letters, numbers, dash, or underscore.');
      }
      if (!sourceName) throw new Error('Display Name is required.');
      if (!sourcePath) throw new Error('Path / URL is required.');

      const supportsGlobs = sourceType === 'directory' || sourceType === 'git';
      const globsRaw = String(formData.get('globs') || '').trim();
      const source = {
        id: sourceId,
        name: sourceName,
        type: sourceType,
        path: sourcePath,
        globs: supportsGlobs && globsRaw
          ? globsRaw.split(',').map((glob) => glob.trim()).filter(Boolean)
          : undefined,
        branch: sourceType === 'git'
          ? (String(formData.get('branch') || '').trim() || undefined)
          : undefined,
        description: String(formData.get('description') || '').trim() || undefined,
        enabled: true,
      };

      const result = await api.qmdSourceAdd(source);
      if (!result.success) {
        throw new Error(result.message || 'Failed to add source.');
      }

      addForm.reset();
      syncAddFormFields();
      toggleAddForm(false);
      setFeedback(`Added source '${sourceId}'.`, 'success');
      await refreshAll();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Source';
    }
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await refreshAll(true);
    } finally {
      refreshBtn.disabled = false;
    }
  });

  reindexAllBtn.addEventListener('click', async () => {
    if (!canManageSources()) {
      setFeedback('QMD reindex is unavailable until QMD is enabled and active in runtime.', 'warning');
      return;
    }
    reindexAllBtn.disabled = true;
    reindexAllBtn.textContent = 'Reindexing...';
    try {
      const result = await api.qmdReindex();
      if (!result.success) throw new Error(result.message || 'Reindex all failed.');
      setFeedback('Reindex started for all sources.', 'success');
    } catch (err) {
      setFeedback(`Reindex failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      reindexAllBtn.disabled = false;
      reindexAllBtn.textContent = 'Reindex All';
    }
  });

  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value || '';
    renderSources();
  });

  sourcesArea.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('qmd-toggle')) return;
    const sourceId = target.dataset.sourceId;
    if (!sourceId || !canManageSources()) return;

    target.disabled = true;
    try {
      const result = await api.qmdSourceToggle(sourceId, target.checked);
      if (!result.success) throw new Error(result.message || 'Unable to update source status.');
      const item = state.sources.find((source) => source.id === sourceId);
      if (item) item.enabled = target.checked;
      setFeedback(`Source '${sourceId}' ${target.checked ? 'enabled' : 'disabled'}.`, 'success');
      renderSources();
    } catch (err) {
      target.checked = !target.checked;
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      target.disabled = false;
    }
  });

  sourcesArea.addEventListener('click', async (event) => {
    const button = event.target instanceof HTMLElement
      ? event.target.closest('.qmd-action')
      : null;
    if (!(button instanceof HTMLButtonElement)) return;
    if (!canManageSources()) return;

    const action = button.dataset.action;
    const sourceId = button.dataset.sourceId;
    if (!action || !sourceId) return;

    button.disabled = true;
    const originalLabel = button.textContent || '';
    try {
      if (action === 'reindex') {
        button.textContent = 'Reindexing...';
        const result = await api.qmdReindex(sourceId);
        if (!result.success) throw new Error(result.message || `Reindex failed for '${sourceId}'.`);
        setFeedback(`Reindex started for '${sourceId}'.`, 'success');
      } else if (action === 'remove') {
        if (!confirm(`Remove source '${sourceId}'?`)) return;
        button.textContent = 'Removing...';
        const result = await api.qmdSourceRemove(sourceId);
        if (!result.success) throw new Error(result.message || `Failed to remove '${sourceId}'.`);
        state.sources = state.sources.filter((source) => source.id !== sourceId);
        setFeedback(`Removed source '${sourceId}'.`, 'success');
        renderSources();
        renderSummary();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  syncAddFormFields();
  renderSummary();
  renderSources();
  updateManageControls();
  if (!state.enabled) {
    state.runtimeAvailable = false;
    updateManageControls();
    setFeedback('QMD is disabled in config. Enable it here, then restart GuardianAgent to activate indexing.', 'warning');
  } else {
    setFeedback('Loading QMD status and sources...', 'muted');
    void refreshAll();
  }
}

// ─── Settings Tab ────────────────────────────────────────

function renderSettingsTab(panel) {
  const config = sharedConfig;
  const providers = sharedProviders;
  const setupStatus = sharedSetupStatus;
  const authStatus = sharedAuthStatus;

  panel.innerHTML = '';

  // Overview/Readiness
  panel.appendChild(createOverview(config, providers, setupStatus));

  // Telegram channel
  panel.appendChild(createTelegramPanel(config, panel));

  // Web Search & Fallback
  panel.appendChild(createWebSearchPanel(config, panel));

  // Browser Automation
  panel.appendChild(createBrowserPanel(config, panel));

  // Trust Preset
  panel.appendChild(createTrustPresetPanel(config));

  // Auth
  panel.appendChild(createAuthPanel(config, authStatus, panel));

  // Danger Zone
  panel.appendChild(createDangerZonePanel());

  // Read-only config snapshots
  panel.appendChild(createSection('Channels (Read-Only Snapshot)', config.channels));
  panel.appendChild(createSection('Guardian (Read-Only Snapshot)', config.guardian));
  panel.appendChild(createSection('Runtime (Read-Only Snapshot)', config.runtime));
  panel.appendChild(createSection('Assistant (Read-Only Snapshot)', config.assistant));
}

function createOverview(config, providers, setupStatus) {
  const wrap = document.createElement('div');
  wrap.className = 'cfg-settings-overview';
  const cards = document.createElement('div');
  cards.className = 'cfg-overview-grid';
  const defaultProvider = providers.find(p => p.name === config.defaultProvider);
  const connectedText = defaultProvider ? (defaultProvider.connected === false ? 'Disconnected' : 'Connected') : 'Unknown';
  const connectedTone = defaultProvider && defaultProvider.connected === false ? 'error' : 'success';

  cards.appendChild(createMiniCard('Readiness', setupStatus?.ready ? 'Ready' : 'Needs attention', setupStatus?.completed ? 'Baseline saved' : 'Configuration pending', setupStatus?.ready ? 'success' : 'warning'));
  cards.appendChild(createMiniCard('Default Provider', config.defaultProvider || 'None', connectedText, connectedTone));
  cards.appendChild(createMiniCard('Providers', String(Object.keys(config.llm || {}).length), `${providers.length} detected`, 'info'));
  cards.appendChild(createMiniCard('Telegram', config.channels?.telegram?.enabled ? 'Enabled' : 'Disabled', 'Configure in Settings tab', config.channels?.telegram?.enabled ? 'success' : 'warning'));
  wrap.appendChild(cards);

  if (setupStatus?.steps?.length) {
    const stepBox = document.createElement('div');
    stepBox.className = 'table-container';
    stepBox.innerHTML = `
      <div class="table-header"><h3>Readiness Checklist</h3></div>
      <div class="cfg-checklist-grid">
        ${setupStatus.steps.map(step => `
          <div class="cfg-check-item ${esc(step.status)}">
            <div class="cfg-check-head">
              <span class="cfg-check-title">${esc(step.title)}</span>
              <span class="badge ${badgeForStep(step.status)}">${esc(step.status.toUpperCase())}</span>
            </div>
            <div class="cfg-check-detail">${esc(step.detail)}</div>
          </div>
        `).join('')}
      </div>
    `;
    wrap.appendChild(stepBox);
  }
  return wrap;
}

function createTelegramPanel(config, settingsPanel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const telegram = config.channels?.telegram || {};
  const enabled = !!telegram.enabled;
  const tokenConfigured = !!telegram.botTokenConfigured;
  const chatIdPreview = Array.isArray(telegram.allowedChatIds) && telegram.allowedChatIds.length > 0
    ? telegram.allowedChatIds.join(', ')
    : '';

  section.innerHTML = `
    <div class="table-header">
      <h3>Telegram Channel</h3>
      <span class="cfg-header-note">Configure bot token and chat allowlist</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enable Telegram</label>
          <select id="cfg-telegram-enabled">
            <option value="false" ${!enabled ? 'selected' : ''}>No</option>
            <option value="true" ${enabled ? 'selected' : ''}>Yes</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Telegram Bot Token</label>
          <input id="cfg-telegram-token" type="password" placeholder="${tokenConfigured ? 'Configured — leave blank to keep existing token' : '123456789:AA...'}">
        </div>
        <div class="cfg-field">
          <label>Allowed Chat IDs</label>
          <input id="cfg-telegram-chatids" type="text" value="${esc(chatIdPreview)}" placeholder="12345,-1001234567890">
        </div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        Setup: create bot with @BotFather, send one message to the bot, then run <code>getUpdates</code> to find <code>message.chat.id</code>.
        Leave token/chat IDs blank to keep current values. Restart required after Telegram channel changes.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="cfg-telegram-save" type="button">Save Telegram Settings</button>
        <span id="cfg-telegram-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#cfg-telegram-status');
  section.querySelector('#cfg-telegram-save')?.addEventListener('click', async () => {
    const enabledVal = section.querySelector('#cfg-telegram-enabled')?.value === 'true';
    const token = section.querySelector('#cfg-telegram-token')?.value.trim() || '';
    const chatIdsRaw = section.querySelector('#cfg-telegram-chatids')?.value || '';

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const result = await api.updateConfig({
        channels: {
          telegram: {
            enabled: enabledVal,
            botToken: token || undefined,
            allowedChatIds: parseChatIdsOrUndefined(chatIdsRaw),
          },
        },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success && token) {
        const tokenInput = section.querySelector('#cfg-telegram-token');
        if (tokenInput) tokenInput.value = '';
      }
      if (result.success) {
        await refreshSettingsOverview(settingsPanel);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(section);
  return section;
}

async function refreshSettingsOverview(panel) {
  try {
    const [nextConfig, nextSetupStatus] = await Promise.all([
      api.config().catch(() => sharedConfig),
      api.setupStatus().catch(() => sharedSetupStatus),
    ]);

    if (nextConfig) sharedConfig = nextConfig;
    if (nextSetupStatus) sharedSetupStatus = nextSetupStatus;

    const currentOverview = panel.querySelector('.cfg-settings-overview');
    if (!currentOverview || !sharedConfig) return;

    const updatedOverview = createOverview(sharedConfig, sharedProviders || [], sharedSetupStatus);
    panel.replaceChild(updatedOverview, currentOverview);
  } catch {
    // Best-effort refresh; keep existing UI if status fetch fails.
  }
}

function createWebSearchPanel(config, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const ws = config.assistant?.tools?.webSearch || {};
  const fallbacks = config.fallbacks || [];
  const providerNames = Object.keys(config.llm || {});

  section.innerHTML = `
    <div class="table-header">
      <h3>Web Search &amp; Model Fallback</h3>
      <span class="cfg-header-note">Search API keys and LLM fallback chain</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Search Provider</label>
          <select id="ws-provider">
            <option value="auto" ${ws.provider === 'auto' || !ws.provider ? 'selected' : ''}>Auto (best available)</option>
            <option value="brave" ${ws.provider === 'brave' ? 'selected' : ''}>Brave</option>
            <option value="perplexity" ${ws.provider === 'perplexity' ? 'selected' : ''}>Perplexity</option>
            <option value="duckduckgo" ${ws.provider === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo (no key)</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Brave Search API Key${ws.braveConfigured ? ' <button type="button" class="ws-clear-btn" data-target="ws-brave-key" style="font-size:0.65rem;margin-left:0.4rem;cursor:pointer;background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:0 0.3rem;">clear</button>' : ''}</label>
          <input id="ws-brave-key" type="password" placeholder="${ws.braveConfigured ? 'Configured — leave blank to keep' : 'BSA...'}">
        </div>
        <div class="cfg-field">
          <label>Perplexity API Key${ws.perplexityConfigured ? ' <button type="button" class="ws-clear-btn" data-target="ws-perplexity-key" style="font-size:0.65rem;margin-left:0.4rem;cursor:pointer;background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:0 0.3rem;">clear</button>' : ''}</label>
          <input id="ws-perplexity-key" type="password" placeholder="${ws.perplexityConfigured ? 'Configured — leave blank to keep' : 'pplx-...'}">
        </div>
        <div class="cfg-field">
          <label>OpenRouter API Key${ws.openRouterConfigured ? ' <button type="button" class="ws-clear-btn" data-target="ws-openrouter-key" style="font-size:0.65rem;margin-left:0.4rem;cursor:pointer;background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:0 0.3rem;">clear</button>' : ''}</label>
          <input id="ws-openrouter-key" type="password" placeholder="${ws.openRouterConfigured ? 'Configured — leave blank to keep' : 'sk-or-...'}">
        </div>
      </div>
      <div class="cfg-divider"></div>
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Model Fallback Chain</label>
          <input id="ws-fallbacks" type="text" value="${esc(fallbacks.join(', '))}" placeholder="e.g. claude, gpt (comma-separated)">
        </div>
        <div class="cfg-field">
          <label>Available Providers</label>
          <input type="text" readonly value="${esc(providerNames.join(', '))}" style="opacity:0.7;">
        </div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">Auto selects best search provider: Brave &gt; Perplexity &gt; DuckDuckGo.</div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="ws-save" type="button">Save Search &amp; Fallback</button>
        <span id="ws-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#ws-save-status');
  const cleared = new Set();
  section.querySelectorAll('.ws-clear-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = section.querySelector(`#${targetId}`);
      if (input) { input.value = ''; input.placeholder = 'Key will be removed on save'; input.style.borderColor = 'var(--warning)'; cleared.add(targetId); }
    });
  });

  function resolveKey(fieldId, wasConfigured) {
    const value = section.querySelector(`#${fieldId}`).value.trim();
    if (value) return value;
    if (cleared.has(fieldId)) return '';
    return undefined;
  }

  section.querySelector('#ws-save')?.addEventListener('click', async () => {
    const provider = section.querySelector('#ws-provider').value;
    const fallbacksRaw = section.querySelector('#ws-fallbacks').value.trim();
    const fallbackList = fallbacksRaw ? fallbacksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.saveSearchConfig({
        webSearchProvider: provider,
        perplexityApiKey: resolveKey('ws-perplexity-key', ws.perplexityConfigured),
        openRouterApiKey: resolveKey('ws-openrouter-key', ws.openRouterConfigured),
        braveApiKey: resolveKey('ws-brave-key', ws.braveConfigured),
        fallbacks: fallbackList,
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) { statusEl.textContent = err instanceof Error ? err.message : String(err); statusEl.style.color = 'var(--error)'; }
  });

  applyInputTooltips(section);
  return section;
}

function createBrowserPanel(config, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const browser = config.assistant?.tools?.browser || {};
  const enabled = browser.enabled !== false;
  const domains = (browser.allowedDomains || config.assistant?.tools?.allowedDomains || []).join(', ');
  const maxSessions = browser.maxSessions ?? 3;
  const idleTimeout = browser.sessionIdleTimeoutMs ?? 300000;

  section.innerHTML = `
    <div class="table-header">
      <h3>Browser Automation</h3>
      <span class="cfg-header-note">Headless browser for JS-rendered pages</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field"><label>Browser Tools</label><select id="browser-enabled"><option value="true" ${enabled ? 'selected' : ''}>Enabled</option><option value="false" ${!enabled ? 'selected' : ''}>Disabled</option></select></div>
        <div class="cfg-field"><label>Allowed Domains</label><input id="browser-domains" type="text" value="${esc(domains)}" placeholder="example.com, github.com"></div>
        <div class="cfg-field"><label>Max Concurrent Sessions</label><input id="browser-max-sessions" type="number" min="1" max="10" value="${maxSessions}"></div>
        <div class="cfg-field"><label>Idle Timeout (seconds)</label><input id="browser-idle-timeout" type="number" min="30" max="3600" value="${Math.round(idleTimeout / 1000)}"></div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">Changes require a restart to take effect.</div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="browser-save" type="button">Save Browser Config</button>
        <span id="browser-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#browser-save-status');
  section.querySelector('#browser-save')?.addEventListener('click', async () => {
    const enabledVal = section.querySelector('#browser-enabled').value === 'true';
    const domainsRaw = section.querySelector('#browser-domains').value.trim();
    const domainList = domainsRaw ? domainsRaw.split(',').map(d => d.trim()).filter(Boolean) : [];
    const maxSessionsVal = parseInt(section.querySelector('#browser-max-sessions').value, 10) || 3;
    const idleTimeoutVal = (parseInt(section.querySelector('#browser-idle-timeout').value, 10) || 300) * 1000;
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.saveBrowserConfig({ enabled: enabledVal, allowedDomains: domainList.length > 0 ? domainList : undefined, maxSessions: maxSessionsVal, sessionIdleTimeoutMs: idleTimeoutVal });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) { statusEl.textContent = err instanceof Error ? err.message : String(err); statusEl.style.color = 'var(--error)'; }
  });

  applyInputTooltips(section);
  return section;
}

function createTrustPresetPanel(config) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const currentPreset = config.guardian?.trustPreset || '';
  section.innerHTML = `
    <div class="table-header"><h3>Trust Preset</h3><span class="cfg-header-note">Quick security posture configuration</span></div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Security Posture</label>
          <select id="trust-preset-select">
            <option value="" ${!currentPreset ? 'selected' : ''}>Custom (no preset)</option>
            <option value="locked" ${currentPreset === 'locked' ? 'selected' : ''}>Locked — read-only, strict limits</option>
            <option value="safe" ${currentPreset === 'safe' ? 'selected' : ''}>Safe — read + email, moderate limits</option>
            <option value="balanced" ${currentPreset === 'balanced' ? 'selected' : ''}>Balanced — read/write/exec, standard limits</option>
            <option value="power" ${currentPreset === 'power' ? 'selected' : ''}>Power — all capabilities, high limits</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Active Preset</label>
          <input type="text" readonly value="${esc(currentPreset || 'none')}" style="opacity:0.7;">
        </div>
      </div>
      <div style="margin-top:0.75rem;font-size:0.74rem;color:var(--text-muted);">Presets set baseline capabilities, rate limits, and tool policies. Changes require a restart.</div>
    </div>
  `;
  return section;
}

function createAuthPanel(config, authStatus, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const mode = 'bearer_required';
  const tokenConfigured = !!authStatus?.tokenConfigured;
  const tokenSource = authStatus?.tokenSource || config.channels?.web?.auth?.tokenSource || 'ephemeral';
  const ttl = authStatus?.sessionTtlMinutes ?? config.channels?.web?.auth?.sessionTtlMinutes ?? '';

  section.innerHTML = `
    <div class="table-header"><h3>Web Authentication</h3><span class="cfg-header-note">Bearer token controls for dashboard and API access</span></div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field"><label>Auth Mode</label><input id="auth-mode" type="text" readonly value="${mode}"></div>
        <div class="cfg-field"><label>Token Source</label><input id="auth-token-source" type="text" value="${esc(tokenSource)}" readonly></div>
        <div class="cfg-field"><label>Session TTL Minutes</label><input id="auth-ttl" type="number" min="1" placeholder="120" value="${esc(String(ttl))}"></div>
        <div class="cfg-field"><label>Current Token</label><input id="auth-token-preview" type="text" readonly value="${tokenConfigured ? esc(authStatus?.tokenPreview || 'configured') : 'not configured'}"></div>
        <div class="cfg-field"><label>Set/New Token</label><input id="auth-token-input-new" type="password" placeholder="Leave empty to keep existing"></div>
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="auth-save" type="button">Save Auth Settings</button>
        <button class="btn btn-secondary" id="auth-rotate" type="button">Rotate Token</button>
        <button class="btn btn-secondary" id="auth-reveal" type="button">Reveal Token</button>
        <span id="auth-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const ttlEl = section.querySelector('#auth-ttl');
  const tokenInputEl = section.querySelector('#auth-token-input-new');
  const tokenPreviewEl = section.querySelector('#auth-token-preview');
  const statusEl = section.querySelector('#auth-save-status');
  const setStatus = (text, color) => { statusEl.textContent = text; statusEl.style.color = color; };

  section.querySelector('#auth-save')?.addEventListener('click', async () => {
    const payload = {
      mode: 'bearer_required',
      token: tokenInputEl.value.trim() || undefined,
      sessionTtlMinutes: ttlEl.value ? Number(ttlEl.value) : undefined,
    };
    setStatus('Saving...', 'var(--text-muted)');
    try {
      const result = await api.updateAuth(payload);
      setStatus(result.message, result.success ? 'var(--success)' : 'var(--warning)');
      if (result.status?.tokenPreview) tokenPreviewEl.value = result.status.tokenPreview;
      if (result.success) tokenInputEl.value = '';
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  section.querySelector('#auth-rotate')?.addEventListener('click', async () => {
    setStatus('Rotating...', 'var(--text-muted)');
    try {
      const result = await api.rotateAuthToken();
      if (result.token) tokenPreviewEl.value = `${result.token.slice(0, 4)}...${result.token.slice(-4)}`;
      setStatus(result.message || 'Token rotated.', result.success ? 'var(--success)' : 'var(--warning)');
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  section.querySelector('#auth-reveal')?.addEventListener('click', async () => {
    setStatus('Revealing...', 'var(--text-muted)');
    try {
      const result = await api.revealAuthToken();
      if (result.success && result.token) { tokenPreviewEl.value = result.token; setStatus('Token revealed. Keep it private.', 'var(--warning)'); }
      else setStatus('No active token.', 'var(--warning)');
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  applyInputTooltips(section);
  return section;
}

function createDangerZonePanel() {
  const section = document.createElement('div');
  section.className = 'table-container danger-zone';

  const scopes = [
    { scope: 'data', label: 'Clear Data', desc: 'Delete conversations, analytics, audit logs, memory, devices, tasks, and network data. Config is preserved.' },
    { scope: 'config', label: 'Reset Config', desc: 'Reset config.yaml to defaults. All data is preserved.' },
    { scope: 'all', label: 'Clear Everything', desc: 'Delete all data and config, then shut down the server.' },
  ];

  section.innerHTML = `
    <div class="table-header"><h3 style="color: var(--error);">Danger Zone</h3><span class="cfg-header-note">Irreversible reset operations</span></div>
    <div class="cfg-center-body" id="danger-zone-body">
      ${scopes.map(s => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border);">
          <div style="flex: 1;">
            <div style="font-size: 0.82rem; color: var(--text-primary); font-weight: 600;">${esc(s.label)}</div>
            <div style="font-size: 0.74rem; color: var(--text-secondary); margin-top: 0.2rem;">${esc(s.desc)}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; margin-left: 1rem;">
            <button class="btn btn-danger" data-reset-scope="${esc(s.scope)}">${esc(s.label)}</button>
            <span class="cfg-save-status" data-reset-status="${esc(s.scope)}"></span>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  for (const s of scopes) {
    const btn = section.querySelector(`[data-reset-scope="${s.scope}"]`);
    const statusEl = section.querySelector(`[data-reset-status="${s.scope}"]`);
    btn?.addEventListener('click', async () => {
      const msg = s.scope === 'all'
        ? 'This will DELETE all data AND config, then shut down the server. Are you sure?'
        : `This will ${s.label.toLowerCase()}. Are you sure?`;
      if (!confirm(msg)) return;
      btn.disabled = true;
      statusEl.textContent = 'Working...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.factoryReset(s.scope);
        if (s.scope === 'all') {
          const body = section.querySelector('#danger-zone-body');
          if (body) body.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--error); font-size: 0.9rem;">Server is shutting down. Reload the page once the server restarts.</div>';
        } else {
          statusEl.textContent = result.message || 'Done.';
          statusEl.style.color = 'var(--success)';
          btn.disabled = false;
        }
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
        btn.disabled = false;
      }
    });
  }

  return section;
}

// ─── Shared Utilities ────────────────────────────────────

function createMiniCard(title, value, subtitle, tone) {
  const card = document.createElement('div');
  card.className = `status-card ${tone}`;
  card.innerHTML = `<div class="card-title">${esc(title)}</div><div class="card-value">${esc(String(value))}</div><div class="card-subtitle">${esc(String(subtitle))}</div>`;
  return card;
}

function createSection(title, data) {
  const section = document.createElement('div');
  section.className = 'config-section';
  const header = document.createElement('div');
  header.className = 'config-section-header';
  header.innerHTML = `<span>${esc(title)}</span><span class="toggle-icon">&#9654;</span>`;
  const body = document.createElement('div');
  body.className = 'config-section-body';
  body.innerHTML = `<pre>${highlight(JSON.stringify(data, null, 2))}</pre>`;
  let collapsed = true;
  body.style.display = 'none';
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    header.querySelector('.toggle-icon').innerHTML = collapsed ? '&#9654;' : '&#9660;';
  });
  section.append(header, body);
  return section;
}

function highlight(json) {
  return json.replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="config-key">$1</span>:')
    .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="config-string">$1</span>')
    .replace(/:\s*(\d+(?:\.\d+)?)/g, ': <span class="config-number">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="config-boolean">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="config-null">$1</span>');
}

function badgeForStep(status) {
  if (status === 'complete') return 'badge-idle';
  if (status === 'warning') return 'badge-warn';
  return 'badge-errored';
}

function parseChatIdsOrUndefined(input) {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const parsed = trimmed.split(',').map(part => Number(part.trim())).filter(id => Number.isFinite(id));
  return parsed.length > 0 ? parsed : undefined;
}

function shortId(id) { return id?.slice(0, 8) || ''; }

function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

function riskClass(risk) {
  if (risk === 'external_post') return 'badge-critical';
  if (risk === 'mutating') return 'badge-errored';
  if (risk === 'network') return 'badge-warn';
  return 'badge-info';
}

function statusClass(status) {
  if (status === 'succeeded') return 'badge-running';
  if (status === 'pending_approval') return 'badge-warn';
  if (status === 'running') return 'badge-running';
  if (status === 'failed' || status === 'denied') return 'badge-errored';
  return 'badge-idle';
}

// ─── Appearance Tab ─────────────────────────────────────

function renderAppearanceTab(panel) {
  const currentTheme = getSavedTheme();
  let activeFilter = 'all';

  panel.innerHTML = `
    <div class="config-intro">Choose a visual theme. Your selection is saved locally in the browser.</div>
    <div class="theme-filter-bar">
      <button class="theme-filter-btn active" data-filter="all">All</button>
      <button class="theme-filter-btn" data-filter="dark">Dark</button>
      <button class="theme-filter-btn" data-filter="light">Light</button>
    </div>
    <div class="theme-grid"></div>
  `;

  const grid = panel.querySelector('.theme-grid');
  const filterBar = panel.querySelector('.theme-filter-bar');

  function renderCards(filter) {
    grid.innerHTML = '';
    const visible = filter === 'all' ? themes : themes.filter(t => t.category === filter);
    for (const theme of visible) {
      const card = document.createElement('div');
      card.className = 'theme-card' + (theme.id === getSavedTheme() ? ' active' : '');
      card.dataset.themeId = theme.id;

      const v = theme.vars;
      card.innerHTML = `
        <div class="theme-preview" style="background:${v['--bg-primary']}">
          <div class="theme-preview-bar" style="background:${v['--bg-surface']};border-right:1px solid ${v['--border']}"></div>
          <div class="theme-preview-main">
            <div class="theme-preview-accent" style="background:${v['--accent']}"></div>
            <div class="theme-preview-line" style="background:${v['--text-primary']}; opacity:0.4"></div>
            <div class="theme-preview-line" style="background:${v['--text-secondary']}; opacity:0.3"></div>
            <div class="theme-preview-line" style="background:${v['--text-muted']}; opacity:0.25"></div>
          </div>
        </div>
        <div class="theme-card-info">
          <div class="theme-card-name">${esc(theme.name)}<span class="theme-card-badge ${theme.category}">${theme.category}</span></div>
          <div class="theme-card-desc">${esc(theme.description)}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        applyTheme(theme.id);
        grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
      });

      grid.appendChild(card);
    }
  }

  filterBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-filter-btn');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    filterBar.querySelectorAll('.theme-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderCards(activeFilter);
  });

  renderCards(activeFilter);
}

// ─── Helpers ────────────────────────────────────────────

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}
