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

export async function renderConfig(container, options = {}) {
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
    ], options?.tab);
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
  panel.appendChild(createProviderStatusTable(config, providers, panel));
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

function createProviderStatusTable(config, providers, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const providerEntries = Object.entries(config.llm || {});
  const rows = providerEntries.map(([name, cfg]) => {
    const live = providers.find(p => p.name === name);
    const connected = live ? (live.connected !== false) : true;
    const locality = live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external');
    const statusBadge = '<span class="badge ' + (connected ? 'badge-idle' : 'badge-errored') + '">' + (connected ? 'Connected' : 'Disconnected') + '</span>';
    const modelList = live?.availableModels?.slice(0, 5).join(', ') || '-';
    const isDefault = name === config.defaultProvider;
    const defaultBadge = isDefault ? ' <span class="badge badge-idle">default</span>' : '';
    const actionBtn = isDefault
      ? '<span class="text-muted" style="font-size:0.75rem">Current default</span>'
      : '<button class="btn btn-sm set-default-provider-btn" data-provider="' + esc(name) + '">Set as Default</button>';
    return '<tr><td><strong>' + esc(name) + '</strong>' + defaultBadge + '</td><td>' + esc(cfg.provider) + '</td><td>' + esc(cfg.model) + '</td><td>' + esc(locality) + '</td><td>' + statusBadge + '</td><td>' + esc(modelList) + '</td><td>' + actionBtn + '</td></tr>';
  }).join('');

  section.innerHTML = `
    <div class="table-header"><h3>Configured Providers</h3></div>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Locality</th><th>Status</th><th>Available Models</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">No providers configured</td></tr>'}</tbody>
    </table>
  `;

  section.querySelectorAll('.set-default-provider-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const providerName = btn.dataset.provider;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const result = await api.setDefaultProvider(providerName);
        if (result.success) {
          sharedConfig.defaultProvider = providerName;
          if (panel) renderProvidersTab(panel);
        } else {
          alert('Failed to set default provider: ' + (result.message || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
      btn.disabled = false;
    });
  });

  return section;
}

// ─── Tools Tab ───────────────────────────────────────────

async function renderToolsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [state] = await Promise.all([
      api.toolsState(80),
    ]);
    const tools = state.tools || [];
    const approvals = state.approvals || [];
    const jobs = state.jobs || [];
    const categories = state.categories || [];
    const notices = state.notices || [];
    const sandbox = state.sandbox || null;
    const routing = state.providerRouting || {};
    const defaultLocality = state.defaultProviderLocality || 'local';
    const categoryDefaults = state.categoryDefaults || {};
    // Effective routing: user tool-level > user category-level > computed category default > default provider locality
    const effectiveRoute = (key, category) => {
      if (routing[key]) return routing[key];
      if (category && routing[category]) return routing[category];
      if (category && categoryDefaults[category]) return categoryDefaults[category];
      return defaultLocality;
    };
    // For category rows, the effective default is the computed category default
    const effectiveCategoryRoute = (category) => {
      if (routing[category]) return routing[category];
      if (categoryDefaults[category]) return categoryDefaults[category];
      return defaultLocality;
    };

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
        <div class="status-card ${sandbox?.enforcementMode === 'strict' ? 'success' : 'warning'}">
          <div class="card-title">Sandbox Mode</div>
          <div class="card-value">${esc((sandbox?.enforcementMode || 'unknown').toUpperCase())}</div>
          <div class="card-subtitle">${esc(sandbox ? `${sandbox.availability} on ${sandbox.platform}` : 'No sandbox status available')}</div>
        </div>
      </div>

      ${sandbox ? `
      <div class="table-container">
        <div class="table-header"><h3>Sandbox Status</h3></div>
        <div style="padding:0.9rem 1rem;display:grid;gap:0.5rem;">
          <div style="font-size:0.85rem;color:var(--text-secondary);">
            Backend: <strong>${esc(sandbox.backend)}</strong> |
            Availability: <strong>${esc(sandbox.availability)}</strong> |
            Enforcement: <strong>${esc(sandbox.enforcementMode)}</strong>
          </div>
          ${Array.isArray(sandbox.reasons) && sandbox.reasons.length > 0 ? `
            <div style="font-size:0.78rem;color:var(--text-muted);">${sandbox.reasons.map(reason => esc(reason)).join(' ')}</div>
          ` : ''}
          ${sandbox.enforcementMode === 'strict' && sandbox.availability !== 'strong' ? `
            <div style="font-size:0.78rem;color:var(--warning);margin-top:0.25rem;">
              Strict mode is active but native sandboxing is unavailable — some tools (shell, browser, network) are disabled.
              To allow these tools, go to <strong>Settings</strong> and set Sandbox Mode to <strong>Permissive</strong>.
            </div>
          ` : ''}
        </div>
      </div>
      ` : ''}

      ${notices.length > 0 ? `
      <div class="table-container">
        <div class="table-header"><h3>Runtime Notices</h3></div>
        <div style="padding:0.9rem 1rem;display:grid;gap:0.75rem;">
          ${notices.map(notice => `
            <div class="cfg-check-item ${notice.level === 'warn' ? 'warning' : 'complete'}">
              <div class="cfg-check-head">
                <span class="cfg-check-title">${notice.level === 'warn' ? 'Warning' : 'Notice'}</span>
                <span class="badge ${notice.level === 'warn' ? 'badge-queued' : 'badge-running'}">${esc(notice.level.toUpperCase())}</span>
              </div>
              <div class="cfg-check-detail">${esc(notice.message)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <div class="table-container">
        <div class="table-header"><h3>Execution Mode</h3></div>
        <div style="padding:0.75rem 1rem;display:flex;flex-direction:column;gap:0.5rem;">
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <label style="font-size:0.75rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.5rem;">
              <input type="checkbox" id="dry-run-toggle" ${state.dryRunDefault ? 'checked' : ''}>
              Dry Run Mode
            </label>
            <span style="font-size:0.72rem;color:var(--text-muted);">When enabled, mutating tools validate but do not execute side effects.</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <label style="font-size:0.75rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.5rem;">
              <input type="checkbox" id="provider-routing-toggle" ${state.providerRoutingEnabled !== false ? 'checked' : ''}>
              Smart LLM Routing
            </label>
            <span style="font-size:0.72rem;color:var(--text-muted);" title="When enabled, tools are automatically routed between local and external LLM providers based on the task type. External operations (web, email, workspace) use the external model for better quality synthesis, while local operations (filesystem, shell, network) use the local model for speed. Disable to force all tools through your default provider only.">Automatically route tool results between local and external models based on task type. <span style="cursor:help;text-decoration:underline dotted;">(?)</span></span>
          </div>
        </div>
      </div>

      ${categories.length > 0 ? '<div class="table-container"><div class="table-header"><h3>Tool Categories</h3></div><table><thead><tr><th>Category</th><th>Label</th><th>Tools</th><th>Status</th><th>LLM</th><th>Description</th></tr></thead><tbody>' + categories.map(cat => { const cv = effectiveCategoryRoute(cat.category); return '<tr><td>' + esc(cat.category) + '</td><td>' + esc(cat.label) + '</td><td>' + cat.toolCount + '</td><td><label class="toggle-switch" style="margin:0;"><input type="checkbox" class="category-toggle" data-category="' + escAttr(cat.category) + '"' + (cat.enabled ? ' checked' : '') + '><span class="toggle-slider"></span></label></td><td><select class="provider-route-select" data-route-key="' + escAttr(cat.category) + '" data-route-scope="category"><option value="local"' + (cv === 'local' ? ' selected' : '') + '>Local</option><option value="external"' + (cv === 'external' ? ' selected' : '') + '>External</option></select></td><td style="font-size:0.72rem;">' + esc(cat.description) + '</td></tr>'; }).join('') + '</tbody></table></div>' : ''}

      <div class="table-container">
        <div class="table-header">
          <h3>Tool Catalog</h3>
          <button class="btn btn-secondary" id="tools-refresh" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Refresh</button>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Risk</th><th>LLM</th><th>Description</th></tr></thead>
          <tbody>
            ${tools.length === 0
              ? '<tr><td colspan="4">No tools registered.</td></tr>'
              : tools.map(tool => { const tv = effectiveRoute(tool.name, tool.category); return '<tr><td>' + esc(tool.name) + '</td><td><span class="badge ' + riskClass(tool.risk) + '">' + esc(tool.risk) + '</span></td><td><select class="provider-route-select" data-route-key="' + escAttr(tool.name) + '" data-route-scope="tool" data-tool-category="' + escAttr(tool.category || '') + '"><option value="local"' + (tv === 'local' ? ' selected' : '') + '>Local</option><option value="external"' + (tv === 'external' ? ' selected' : '') + '>External</option></select></td><td>' + esc(tool.description) + '</td></tr>'; }).join('')}
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

    // Smart LLM Routing toggle
    const routingToggle = panel.querySelector('#provider-routing-toggle');
    if (routingToggle) {
      routingToggle.addEventListener('change', async () => {
        const enabled = routingToggle.checked;
        try {
          const result = await api.updateToolProviderRouting({ enabled });
          if (!result.success) {
            alert(result.message || 'Failed to update routing.');
            routingToggle.checked = !enabled;
          } else {
            // Disable/enable the per-category and per-tool dropdowns
            panel.querySelectorAll('.provider-route-select').forEach(sel => { sel.disabled = !enabled; });
          }
        } catch (err) {
          alert(err.message || 'Failed to update routing.');
          routingToggle.checked = !enabled;
        }
      });
      // Set initial disabled state on dropdowns if routing is off
      if (!routingToggle.checked) {
        panel.querySelectorAll('.provider-route-select').forEach(sel => { sel.disabled = true; });
      }
    }

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

    panel.querySelectorAll('.provider-route-select').forEach(select => {
      select.addEventListener('change', async () => {
        const key = select.getAttribute('data-route-key');
        const scope = select.getAttribute('data-route-scope');
        const value = select.value;
        if (!key) return;

        // If category changed, cascade to all tool selects in that category
        if (scope === 'category') {
          panel.querySelectorAll('.provider-route-select[data-route-scope="tool"]').forEach(toolSel => {
            if (toolSel.getAttribute('data-tool-category') === key) {
              toolSel.value = value;
            }
          });
        }

        // Build the full routing map from current UI state.
        // Only persist entries that differ from the computed default for that key.
        const updated = {};
        panel.querySelectorAll('.provider-route-select').forEach(sel => {
          const k = sel.getAttribute('data-route-key');
          const v = sel.value;
          if (!k) return;
          const scope = sel.getAttribute('data-route-scope');
          // For categories: compare against computed category default
          // For tools: compare against user category override or computed category default
          const cat = scope === 'tool' ? sel.getAttribute('data-tool-category') : k;
          const computedDefault = (cat && categoryDefaults[cat]) || defaultLocality;
          if (scope === 'tool') {
            // Tool-level: only persist if different from the category-level effective route
            const catOverride = routing[cat] || computedDefault;
            if (v !== catOverride) { updated[k] = v; }
          } else {
            // Category-level: only persist if different from computed default
            if (v !== computedDefault) { updated[k] = v; }
          }
        });
        try {
          const result = await api.updateToolProviderRouting({ routing: updated });
          if (!result.success) { alert(result.message || 'Failed to update routing.'); }
          // Update local routing ref so subsequent changes see correct state
          Object.keys(routing).forEach(k => delete routing[k]);
          Object.assign(routing, updated);
        } catch (err) { alert(err.message || 'Failed to update routing.'); }
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

  // Overview/Readiness — always visible at top
  panel.appendChild(createOverview(config, providers, setupStatus));

  // ── Helper: create an accordion group ──
  function makeGroup(title, summary, items, openByDefault) {
    const group = document.createElement('div');
    group.className = 'cfg-group' + (openByDefault ? ' open' : '');

    const header = document.createElement('div');
    header.className = 'cfg-group-header';
    header.innerHTML = `
      <span class="cfg-group-chevron">&#9654;</span>
      <span class="cfg-group-title">${esc(title)}</span>
      <span class="cfg-group-summary">${summary}</span>
    `;
    header.addEventListener('click', () => group.classList.toggle('open'));
    group.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cfg-group-body';
    const grid = document.createElement('div');
    grid.className = 'cfg-group-grid';

    for (const item of items) {
      const wrapper = document.createElement('div');
      wrapper.className = 'cfg-item' + (item.fullWidth ? ' full-width' : '');

      const itemHeader = document.createElement('div');
      itemHeader.className = 'cfg-item-header';
      itemHeader.innerHTML = `
        <span class="cfg-item-chevron">&#9654;</span>
        <span class="cfg-item-title">${esc(item.title)}</span>
        <span class="cfg-item-badge">${item.badge || ''}</span>
      `;
      itemHeader.addEventListener('click', () => wrapper.classList.toggle('open'));
      wrapper.appendChild(itemHeader);

      const itemBody = document.createElement('div');
      itemBody.className = 'cfg-item-body';
      const panelEl = item.panel;
      if (panelEl) {
        // Remove the table-header (we use our own accordion header instead)
        const tableHeader = panelEl.querySelector('.table-header');
        if (tableHeader) tableHeader.remove();
        // Remove table-container border/bg since the cfg-item provides it
        panelEl.style.background = 'none';
        panelEl.style.border = 'none';
        panelEl.style.margin = '0';
        itemBody.appendChild(panelEl);
      }
      wrapper.appendChild(itemBody);
      grid.appendChild(wrapper);
    }

    body.appendChild(grid);
    group.appendChild(body);
    return group;
  }

  // ── Build summaries ──
  const telegramEnabled = config.channels?.telegram?.enabled;
  const sandboxMode = config.assistant?.tools?.sandbox?.enforcementMode || 'strict';
  const apu = config.assistant?.tools?.agentPolicyUpdates || {};
  const apuCount = [apu.allowedPaths !== false, !!apu.allowedCommands, apu.allowedDomains !== false].filter(Boolean).length;
  const gaConfig = config.guardian?.guardianAgent;
  const trustPreset = config.guardian?.trustPreset || 'custom';
  const authMode = authStatus?.tokenConfigured ? 'Configured' : 'Not set';

  // ── Channels group ──
  panel.appendChild(makeGroup('Channels', `${telegramEnabled ? 'Telegram active' : 'CLI + Web'}`, [
    {
      title: 'Telegram',
      badge: telegramEnabled ? 'Enabled' : 'Disabled',
      panel: createTelegramPanel(config, panel),
    },
    {
      title: 'Web Search & Fallback',
      badge: config.assistant?.tools?.webSearch?.provider || 'auto',
      panel: createWebSearchPanel(config, panel),
    },
  ]));

  // ── Integrations group ──
  panel.appendChild(makeGroup('Integrations', '', [
    {
      title: 'Browser Automation',
      badge: config.assistant?.tools?.browser?.enabled !== false ? 'Enabled' : 'Disabled',
      panel: createBrowserPanel(config, panel),
    },
    {
      title: 'Google Workspace',
      badge: 'Gmail, Calendar, Drive',
      panel: createGoogleWorkspacePanel(),
      fullWidth: true,
    },
  ]));

  // ── Security group ──
  panel.appendChild(makeGroup('Security', `${sandboxMode} sandbox`, [
    {
      title: 'Guardian Agent',
      badge: gaConfig?.enabled !== false ? `${gaConfig?.llmProvider || 'auto'}` : 'Disabled',
      panel: createGuardianAgentPanel(),
    },
    {
      title: 'Policy-as-Code Engine',
      badge: (config.guardian?.policy?.mode || 'shadow'),
      panel: createPolicyEnginePanel(),
    },
    {
      title: 'Sentinel Audit',
      badge: 'Retrospective analysis',
      panel: createSentinelAuditPanel(),
    },
    {
      title: 'Sandbox Enforcement',
      badge: sandboxMode,
      panel: createSandboxPanel(config),
    },
    {
      title: 'Trust Preset',
      badge: trustPreset,
      panel: createTrustPresetPanel(config),
    },
    {
      title: 'Agent Policy Access',
      badge: `${apuCount}/3 enabled`,
      panel: createAgentPolicyAccessPanel(config, panel),
    },
  ]));

  // ── System group ──
  panel.appendChild(makeGroup('System', authMode, [
    {
      title: 'Authentication',
      badge: authMode,
      panel: createAuthPanel(config, authStatus, panel),
    },
    {
      title: 'Danger Zone',
      badge: '',
      panel: createDangerZonePanel(),
    },
  ]));

  // ── Config Snapshots group (collapsed by default) ──
  function makeSnapshotPanel(data) {
    const el = document.createElement('div');
    el.className = 'table-container';
    el.innerHTML = `<div class="cfg-center-body"><pre style="font-size:0.72rem;overflow-x:auto;max-height:400px;overflow-y:auto;">${highlight(JSON.stringify(data, null, 2))}</pre></div>`;
    return el;
  }
  panel.appendChild(makeGroup('Config Snapshots', 'Read-only', [
    { title: 'Channels', badge: 'read-only', panel: makeSnapshotPanel(config.channels), fullWidth: true },
    { title: 'Guardian', badge: 'read-only', panel: makeSnapshotPanel(config.guardian), fullWidth: true },
    { title: 'Runtime', badge: 'read-only', panel: makeSnapshotPanel(config.runtime), fullWidth: true },
    { title: 'Assistant', badge: 'read-only', panel: makeSnapshotPanel(config.assistant), fullWidth: true },
  ]));
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

function createSandboxPanel(config) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const sandbox = config.assistant?.tools?.sandbox || {};
  const mode = sandbox.enforcementMode || 'strict';

  section.innerHTML = `
    <div class="table-header">
      <h3>Sandbox Enforcement</h3>
      <span class="cfg-header-note">OS-level process isolation for tool execution</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enforcement Mode</label>
          <select id="sandbox-enforcement-mode">
            <option value="strict" ${mode === 'strict' ? 'selected' : ''}>Strict — disable risky tools when native sandbox unavailable</option>
            <option value="permissive" ${mode === 'permissive' ? 'selected' : ''}>Permissive — allow all tools even without native sandbox</option>
          </select>
        </div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        <strong>Strict</strong> disables shell, browser, and network tools when native sandboxing (bwrap) is not available.
        <strong>Permissive</strong> allows these tools to run unsandboxed. Use permissive if you trust your environment (e.g. local dev machine).
        Restart required after changes.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="sandbox-save" type="button">Save Sandbox Config</button>
        <span id="sandbox-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#sandbox-save-status');
  section.querySelector('#sandbox-save')?.addEventListener('click', async () => {
    const modeVal = section.querySelector('#sandbox-enforcement-mode').value;
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConfig({
        assistant: { tools: { sandbox: { enforcementMode: modeVal } } },
      });
      statusEl.textContent = result.message || 'Saved';
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  return section;
}

function createAgentPolicyAccessPanel(config, settingsPanel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const apu = config.assistant?.tools?.agentPolicyUpdates || {};
  const pathsEnabled = apu.allowedPaths !== false;
  const commandsEnabled = !!apu.allowedCommands;
  const domainsEnabled = apu.allowedDomains !== false;

  section.innerHTML = `
    <div class="table-header">
      <h3>Agent Policy Access</h3>
      <span class="cfg-header-note">Allow the assistant to modify sandbox policy via chat (always requires user approval)</span>
    </div>
    <div class="cfg-center-body">
      <div style="display:grid;gap:0.6rem;padding:0.25rem 0;">
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;">
          <input type="checkbox" id="apu-paths" ${pathsEnabled ? 'checked' : ''}>
          <span>Manage filesystem paths</span>
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;">
          <input type="checkbox" id="apu-commands" ${commandsEnabled ? 'checked' : ''}>
          <span>Manage shell commands</span>
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;">
          <input type="checkbox" id="apu-domains" ${domainsEnabled ? 'checked' : ''}>
          <span>Manage network domains</span>
        </label>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        When enabled, the assistant can use the <code>update_tool_policy</code> tool to add or remove paths, commands, or domains from the sandbox allowlist.
        Every change <strong>always requires explicit user approval</strong> regardless of policy mode.
        Useful for remote control via Telegram or other channels where the web UI is not accessible.
        Restart required after changes.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="apu-save" type="button">Save</button>
        <span id="apu-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#apu-save-status');
  section.querySelector('#apu-save')?.addEventListener('click', async () => {
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConfig({
        assistant: {
          tools: {
            agentPolicyUpdates: {
              allowedPaths: section.querySelector('#apu-paths').checked,
              allowedCommands: section.querySelector('#apu-commands').checked,
              allowedDomains: section.querySelector('#apu-domains').checked,
            },
          },
        },
      });
      statusEl.textContent = result.message || 'Saved';
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  return section;
}

function createGuardianAgentPanel() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Guardian Agent</h3>
      <span class="cfg-header-note">Inline LLM-powered action evaluation</span>
    </div>
    <div class="cfg-center-body" id="guardian-agent-body">
      <div class="loading" style="font-size:0.8rem;">Loading...</div>
    </div>
  `;

  async function load() {
    const body = section.querySelector('#guardian-agent-body');
    if (!body) return;
    try {
      const status = await api.guardianAgentStatus();
      body.innerHTML = `
        <div class="cfg-form-grid">
          <div class="cfg-field">
            <label>Enabled</label>
            <select id="ga-enabled">
              <option value="true" ${status.enabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!status.enabled ? 'selected' : ''}>Disabled</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>LLM Provider</label>
            <select id="ga-llm-provider">
              <option value="auto" ${status.llmProvider === 'auto' ? 'selected' : ''}>Auto (local first, then external)</option>
              <option value="local" ${status.llmProvider === 'local' ? 'selected' : ''}>Local (Ollama)</option>
              <option value="external" ${status.llmProvider === 'external' ? 'selected' : ''}>External (OpenAI/Anthropic)</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Fail Mode</label>
            <select id="ga-fail-open">
              <option value="true" ${status.failOpen ? 'selected' : ''}>Fail-open (allow when LLM unavailable)</option>
              <option value="false" ${!status.failOpen ? 'selected' : ''}>Fail-closed (block when LLM unavailable)</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Timeout (ms)</label>
            <input type="number" id="ga-timeout" value="${status.timeoutMs || 8000}" min="1000" max="30000" step="1000">
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <button class="btn btn-sm" id="ga-save-btn">Save</button>
          <span id="ga-save-status" style="font-size:0.74rem;margin-left:0.5rem;"></span>
        </div>
        <div style="margin-top:0.5rem;font-size:0.74rem;color:var(--text-muted);">
          Guardian Agent evaluates tool actions via LLM before execution. Mutating and network actions are checked; read-only actions are skipped.
        </div>
      `;
      section.querySelector('#ga-save-btn')?.addEventListener('click', async () => {
        const statusEl = section.querySelector('#ga-save-status');
        try {
          await api.updateGuardianAgent({
            enabled: section.querySelector('#ga-enabled').value === 'true',
            llmProvider: section.querySelector('#ga-llm-provider').value,
            failOpen: section.querySelector('#ga-fail-open').value === 'true',
            timeoutMs: parseInt(section.querySelector('#ga-timeout').value, 10) || 8000,
          });
          if (statusEl) { statusEl.textContent = 'Saved'; statusEl.style.color = 'var(--success)'; }
        } catch (err) {
          if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
        }
      });
    } catch (err) {
      body.innerHTML = `<div style="font-size:0.8rem;color:var(--text-secondary);">Guardian Agent status unavailable.</div>`;
    }
  }
  load();
  return section;
}

function createSentinelAuditPanel() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Sentinel Audit</h3>
      <span class="cfg-header-note">Retrospective security analysis</span>
    </div>
    <div class="cfg-center-body">
      <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.75rem;">
        Sentinel analyzes audit logs for anomalous patterns: denial spikes, capability probing, secret detection, and error storms.
        Runs automatically on a cron schedule, or trigger on-demand below.
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <button class="btn btn-sm" id="sentinel-run-btn">Run Audit Now</button>
        <span id="sentinel-run-status" style="font-size:0.74rem;"></span>
      </div>
      <div id="sentinel-results" style="margin-top:0.75rem;display:none;"></div>
    </div>
  `;

  section.querySelector('#sentinel-run-btn')?.addEventListener('click', async () => {
    const statusEl = section.querySelector('#sentinel-run-status');
    const resultsEl = section.querySelector('#sentinel-results');
    if (statusEl) { statusEl.textContent = 'Running...'; statusEl.style.color = 'var(--text-muted)'; }
    try {
      const result = await api.runSentinelAudit();
      if (statusEl) {
        const total = (result.anomalies?.length || 0) + (result.llmFindings?.length || 0);
        statusEl.textContent = total > 0 ? total + ' finding(s)' : 'No anomalies detected';
        statusEl.style.color = total > 0 ? 'var(--warning)' : 'var(--success)';
      }
      if (resultsEl && ((result.anomalies?.length || 0) + (result.llmFindings?.length || 0)) > 0) {
        resultsEl.style.display = 'block';
        const items = [
          ...(result.anomalies || []).map(a => `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
            <span class="status-badge ${a.severity === 'critical' ? 'status-error' : 'status-warning'}" style="font-size:0.65rem;">${esc(a.severity)}</span>
            <strong>${esc(a.type)}</strong>: ${esc(a.description)}${a.agentId ? ' <span style="color:var(--text-muted);">('+esc(a.agentId)+')</span>' : ''}
          </div>`),
          ...(result.llmFindings || []).map(f => `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
            <span class="status-badge ${f.severity === 'critical' ? 'status-error' : 'status-warning'}" style="font-size:0.65rem;">${esc(f.severity)}</span>
            ${esc(f.description)}
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;">Recommendation: ${esc(f.recommendation)}</div>
          </div>`),
        ];
        resultsEl.innerHTML = items.join('');
      } else if (resultsEl) {
        resultsEl.style.display = 'none';
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
    }
  });

  return section;
}

function createPolicyEnginePanel() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Policy-as-Code Engine</h3>
      <span class="cfg-header-note">Declarative rule evaluation</span>
    </div>
    <div class="cfg-center-body" id="policy-engine-body">
      <div class="loading" style="font-size:0.8rem;">Loading...</div>
    </div>
  `;

  async function load() {
    const body = section.querySelector('#policy-engine-body');
    if (!body) return;
    try {
      const status = await api.policyStatus();
      const familyMode = (fam) => status.families?.[fam] || status.mode || 'off';

      body.innerHTML = `
        <div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:0.75rem;line-height:1.5;">
          The policy engine evaluates tool requests against declarative JSON rules. Rules are loaded from
          <code style="font-size:0.72rem;background:var(--bg-secondary);padding:0.1rem 0.3rem;border-radius:3px;">${esc(status.rulesPath || 'policies/')}</code>
          and compiled into fast matchers at startup.
        </div>
        <div class="cfg-form-grid">
          <div class="cfg-field">
            <label>Enabled</label>
            <select id="pe-enabled">
              <option value="true" ${status.enabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!status.enabled ? 'selected' : ''}>Disabled</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Mode</label>
            <select id="pe-mode">
              <option value="off" ${status.mode === 'off' ? 'selected' : ''}>Off &mdash; engine disabled, legacy decide() only</option>
              <option value="shadow" ${status.mode === 'shadow' ? 'selected' : ''}>Shadow &mdash; compare with legacy, log mismatches (recommended)</option>
              <option value="enforce" ${status.mode === 'enforce' ? 'selected' : ''}>Enforce &mdash; engine is authoritative, replaces legacy logic</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Mismatch Log Limit</label>
            <input type="number" id="pe-mismatch-limit" value="${status.mismatchLogLimit || 1000}" min="100" max="100000" step="100">
          </div>
        </div>

        <div style="margin-top:0.5rem;">
          <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:0.5rem;font-weight:500;">Per-Family Mode Overrides</div>
          <div class="cfg-form-grid" style="grid-template-columns:1fr 1fr;">
            <div class="cfg-field">
              <label>Tool Family</label>
              <select id="pe-fam-tool">
                <option value="inherit" ${familyMode('tool') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.tool === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.tool === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.tool === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Admin Family</label>
              <select id="pe-fam-admin">
                <option value="inherit" ${familyMode('admin') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.admin === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.admin === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.admin === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Guardian Family</label>
              <select id="pe-fam-guardian">
                <option value="inherit" ${familyMode('guardian') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.guardian === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.guardian === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.guardian === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Event Family</label>
              <select id="pe-fam-event">
                <option value="inherit" ${familyMode('event') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.event === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.event === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.event === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
          </div>
        </div>

        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-sm" id="pe-save-btn">Save</button>
          <button class="btn btn-sm" id="pe-reload-btn" style="background:var(--bg-secondary);color:var(--text);">Reload Rules</button>
          <span id="pe-save-status" style="font-size:0.74rem;margin-left:0.25rem;"></span>
        </div>

        <div id="pe-stats" style="margin-top:0.75rem;"></div>

        <div style="margin-top:0.5rem;font-size:0.74rem;color:var(--text-muted);line-height:1.45;">
          <strong>Mode descriptions:</strong><br>
          <strong>Off</strong> &mdash; The policy engine is completely disabled. All tool decisions use the legacy <code>decide()</code> logic
          (explicit per-tool overrides, risk classification, and mode-based defaults). No policy evaluation occurs.<br>
          <strong>Shadow</strong> &mdash; The policy engine runs alongside legacy <code>decide()</code> on every tool request.
          Both decisions are computed, but only the legacy decision is used. Mismatches are logged and classified
          (<em>policy_too_strict</em>, <em>policy_too_permissive</em>, <em>normalization_bug</em>, <em>legacy_bug</em>)
          for safe, data-driven migration. This is the recommended starting mode.<br>
          <strong>Enforce</strong> &mdash; The policy engine's decision is authoritative. The legacy <code>decide()</code> path is bypassed entirely.
          Only use this after shadow mode has demonstrated a 99%+ match rate with zero <em>policy_too_permissive</em> mismatches
          over a sustained period (recommended: 14 days).
        </div>
      `;

      // Render shadow stats if available
      if (status.shadowStats && status.shadowStats.totalComparisons > 0) {
        const s = status.shadowStats;
        const rate = (s.matchRate * 100).toFixed(1);
        const statsEl = section.querySelector('#pe-stats');
        if (statsEl) {
          const rateColor = s.matchRate >= 0.99 ? 'var(--success)' : s.matchRate >= 0.95 ? 'var(--warning)' : 'var(--error)';
          statsEl.innerHTML = `
            <div style="font-size:0.74rem;color:var(--text-muted);font-weight:500;margin-bottom:0.3rem;">Shadow Mode Statistics</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:0.5rem;font-size:0.78rem;">
              <div>Comparisons: <strong>${s.totalComparisons.toLocaleString()}</strong></div>
              <div>Mismatches: <strong style="color:${s.totalMismatches > 0 ? 'var(--warning)' : 'var(--success)'}">${s.totalMismatches.toLocaleString()}</strong></div>
              <div>Match rate: <strong style="color:${rateColor}">${rate}%</strong></div>
            </div>
            ${s.totalMismatches > 0 ? `
              <div style="margin-top:0.3rem;font-size:0.72rem;color:var(--text-muted);">
                By class:
                ${Object.entries(s.mismatchesByClass).filter(([,v]) => v > 0).map(([k,v]) => `<span style="margin-right:0.5rem;">${esc(k)}: <strong>${v}</strong></span>`).join('')}
              </div>
            ` : ''}
          `;
        }
      }

      // Rule count
      const statsEl = section.querySelector('#pe-stats');
      if (statsEl && status.ruleCount !== undefined) {
        const countLine = document.createElement('div');
        countLine.style.cssText = 'font-size:0.74rem;color:var(--text-muted);margin-top:0.3rem;';
        countLine.textContent = 'Loaded rules: ' + status.ruleCount;
        statsEl.appendChild(countLine);
      }

      // Save handler
      section.querySelector('#pe-save-btn')?.addEventListener('click', async () => {
        const statusEl = section.querySelector('#pe-save-status');
        try {
          const families = {};
          for (const fam of ['tool', 'admin', 'guardian', 'event']) {
            const val = section.querySelector('#pe-fam-' + fam)?.value;
            if (val && val !== 'inherit') families[fam] = val;
          }
          await api.updatePolicy({
            enabled: section.querySelector('#pe-enabled').value === 'true',
            mode: section.querySelector('#pe-mode').value,
            mismatchLogLimit: parseInt(section.querySelector('#pe-mismatch-limit').value, 10) || 1000,
            families: Object.keys(families).length > 0 ? families : undefined,
          });
          if (statusEl) { statusEl.textContent = 'Saved'; statusEl.style.color = 'var(--success)'; }
        } catch (err) {
          if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
        }
      });

      // Reload handler
      section.querySelector('#pe-reload-btn')?.addEventListener('click', async () => {
        const statusEl = section.querySelector('#pe-save-status');
        try {
          const result = await api.reloadPolicy();
          if (statusEl) {
            statusEl.textContent = `Reloaded: ${result.loaded} rules loaded, ${result.skipped} skipped` +
              (result.errors?.length ? `, ${result.errors.length} error(s)` : '');
            statusEl.style.color = result.errors?.length ? 'var(--warning)' : 'var(--success)';
          }
          // Refresh the panel to update stats
          setTimeout(load, 500);
        } catch (err) {
          if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
        }
      });

    } catch (err) {
      body.innerHTML = `<div style="font-size:0.8rem;color:var(--text-secondary);">Policy engine status unavailable.</div>`;
    }
  }
  load();
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

function createGoogleWorkspacePanel() {
  const section = document.createElement('div');
  section.className = 'table-container';

  const codeStyle = 'display:block;background:var(--bg-tertiary);padding:0.5rem 0.75rem;border-radius:4px;font-size:0.8rem;user-select:all;';
  const inlineCode = 'background:var(--bg-tertiary);padding:0.1rem 0.3rem;border-radius:3px;';
  const stepLabel = 'font-size:0.72rem;color:var(--text-muted);margin-bottom:0.25rem;';

  section.innerHTML = `
    <div class="table-header">
      <h3>Google Workspace</h3>
      <span class="cfg-header-note">Gmail, Calendar, Drive, Docs, Sheets</span>
    </div>
    <div class="cfg-center-body" id="gws-settings-body">
      <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.75rem;">
        Google Workspace integration provides access to Gmail, Calendar, Drive, Docs, and Sheets through the assistant
        via the <a href="https://www.npmjs.com/package/@googleworkspace/cli" target="_blank" rel="noopener" style="color:var(--accent);">@googleworkspace/cli</a> command-line tool.
      </div>
      <div id="gws-status-area">
        <div class="loading" style="font-size:0.8rem;">Checking connectivity...</div>
      </div>
    </div>
  `;

  function renderStatus(gwsStatus) {
    const area = section.querySelector('#gws-status-area');
    if (!area) return;

    if (!gwsStatus || !gwsStatus.installed) {
      area.innerHTML = `
        <div style="padding:0.75rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);font-size:0.8rem;">
          <strong style="color:var(--text-primary);">Setup Guide</strong>
          <p style="margin:0.5rem 0;color:var(--text-secondary);">
            The Google Workspace CLI needs to be installed and authenticated before use.
          </p>
          <div style="margin-bottom:0.6rem;">
            <div style="${stepLabel}">Step 1 — Install the CLI globally</div>
            <code style="${codeStyle}">npm install -g @googleworkspace/cli</code>
          </div>
          <div style="margin-bottom:0.6rem;">
            <div style="${stepLabel}">Step 2 — Configure OAuth credentials</div>
            <p style="font-size:0.8rem;color:var(--text-secondary);margin:0.25rem 0 0.4rem;">
              You need a Google Cloud project with OAuth 2.0 credentials. Choose one method:
            </p>
            <div style="padding:0.5rem 0.6rem;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;">
              <strong style="font-size:0.78rem;">Option A — Automatic (requires Google Cloud CLI)</strong>
              <p style="font-size:0.78rem;color:var(--text-secondary);margin:0.25rem 0;">
                1. Install the <a href="https://docs.cloud.google.com/sdk/docs/install-sdk" target="_blank" rel="noopener" style="color:var(--accent);">Google Cloud CLI (gcloud)</a><br>
                2. Run <code style="${inlineCode}">gcloud auth login</code> to authenticate<br>
                3. Run <code style="${inlineCode}">gws auth setup</code> to auto-create OAuth credentials
              </p>
            </div>
            <div style="padding:0.5rem 0.6rem;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);">
              <strong style="font-size:0.78rem;">Option B — Manual setup via Google Cloud Console</strong>
              <ol style="font-size:0.78rem;color:var(--text-secondary);margin:0.25rem 0;padding-left:1.2rem;">
                <li style="margin-bottom:0.3rem;">
                  Go to the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" style="color:var(--accent);">Google Cloud Console</a>.
                  Create a new project if you don't have one (top-left project selector &gt; <strong>New Project</strong>).
                </li>
                <li style="margin-bottom:0.3rem;">
                  In the left sidebar, go to <strong>Google Auth Platform &gt; Audience</strong>.
                  Set user type to <strong>External</strong>, fill in the app name (e.g. "Guardian Agent") and your email address, then save.
                </li>
                <li style="margin-bottom:0.3rem;">
                  <strong style="color:var(--warning);">Important:</strong> On the Audience page, under <strong>Publishing status</strong>, click <strong>Publish App</strong>.
                  Without this, only manually-added test users can authenticate and you'll get an "access_denied" error.
                  This is safe — the OAuth credentials are only usable on your machine.
                </li>
                <li style="margin-bottom:0.3rem;">
                  In the left sidebar, go to <strong>Credentials</strong>. Click <strong>+ Create Credentials</strong> &gt; <strong>OAuth client ID</strong>.
                </li>
                <li style="margin-bottom:0.3rem;">
                  Set <strong>Application type</strong> to <strong style="color:var(--text-primary);">Desktop app</strong>
                  <span style="color:var(--warning);"> (not "Web application")</span>.
                  You do not need to fill in redirect URIs or JavaScript origins.
                </li>
                <li style="margin-bottom:0.3rem;">
                  Give it any name (e.g. "Guardian Agent Desktop") and click <strong>Create</strong>.
                </li>
                <li style="margin-bottom:0.3rem;">
                  On the confirmation dialog, click <strong>Download JSON</strong>.
                </li>
                <li style="margin-bottom:0.3rem;">
                  Save the downloaded file as:<br>
                  <code style="${codeStyle}">${navigator.platform?.startsWith('Win') ? '%USERPROFILE%\\.config\\gws\\client_secret.json' : '~/.config/gws/client_secret.json'}</code>
                  <span style="font-size:0.72rem;color:var(--text-muted);">Create the <code style="${inlineCode}">.config${navigator.platform?.startsWith('Win') ? '\\\\' : '/'}gws</code> folder if it doesn't exist.</span>
                </li>
              </ol>
            </div>
          </div>
          <div style="margin-bottom:0.6rem;">
            <div style="${stepLabel}">Step 3 — Enable Google APIs</div>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0.25rem 0;">
              In Cloud Console, go to <strong>APIs &amp; Services &gt; Library</strong>. Enable the APIs you want to use:
              <strong>Gmail API</strong>, <strong>Google Calendar API</strong>, <strong>Google Drive API</strong>,
              <strong>Google Docs API</strong>, <strong>Google Sheets API</strong>.
              Only enable what you need — you can add more later.
            </p>
          </div>
          <div style="margin-bottom:0.6rem;">
            <div style="${stepLabel}">Step 4 — Sign in with your Google account</div>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0.25rem 0;">
              After configuring OAuth credentials (either option above), run in your terminal:
            </p>
            <code style="${codeStyle}">gws auth login</code>
            <p style="font-size:0.72rem;color:var(--text-muted);margin:0.3rem 0 0;">
              A browser window will open for Google consent. If you see "access_denied", go back to
              Google Auth Platform &gt; Audience and click <strong>Publish App</strong>.
            </p>
          </div>
          <div style="margin-bottom:0.6rem;">
            <div style="${stepLabel}">Step 5 — Enable in Guardian Agent</div>
            <p style="font-size:0.8rem;color:var(--text-secondary);margin:0.25rem 0;">
              Click <strong>Test Connection</strong> below to verify, then use the <strong>Enable</strong> button that appears to activate the integration. Tools become available immediately.
            </p>
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <button class="btn btn-primary" id="gws-test-btn">Test Connection</button>
          <span id="gws-test-status" style="margin-left:0.5rem;font-size:0.8rem;"></span>
        </div>
      `;
    } else if (!gwsStatus.authenticated) {
      area.innerHTML = `
        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;">
          <div style="font-size:0.8rem;">
            <span style="color:var(--text-secondary);">CLI:</span>
            <span class="badge badge-running">Installed</span>
            ${gwsStatus.version ? `<span style="color:var(--text-muted);margin-left:0.5rem;">${esc(gwsStatus.version)}</span>` : ''}
          </div>
          <div style="font-size:0.8rem;">
            <span style="color:var(--text-secondary);">Auth:</span>
            <span class="badge badge-errored">Not authenticated</span>
          </div>
        </div>
        <div style="padding:0.75rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);font-size:0.8rem;">
          <p style="margin:0 0 0.5rem;color:var(--text-secondary);">
            The CLI is installed but not authenticated. You need OAuth credentials configured first, then sign in.
          </p>
          <div style="margin-bottom:0.5rem;">
            <div style="${stepLabel}">1. Configure OAuth credentials (if not already done)</div>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0.2rem 0;">
              <strong>With <a href="https://docs.cloud.google.com/sdk/docs/install-sdk" target="_blank" rel="noopener" style="color:var(--accent);">gcloud CLI</a>:</strong>
              Run <code style="${inlineCode}">gws auth setup</code>
            </p>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0.2rem 0;">
              <strong>Without gcloud:</strong> Go to
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" style="color:var(--accent);">Cloud Console &gt; Credentials</a>,
              click <strong>+ Create Credentials</strong> &gt; <strong>OAuth client ID</strong>,
              set type to <strong>Desktop app</strong> <span style="color:var(--warning);">(not Web application)</span>,
              download the JSON, and save it as:<br>
              <code style="${inlineCode}">${navigator.platform?.startsWith('Win') ? '%USERPROFILE%\\.config\\gws\\client_secret.json' : '~/.config/gws/client_secret.json'}</code>
            </p>
          </div>
          <div>
            <div style="${stepLabel}">2. Sign in with Google</div>
            <code style="${codeStyle}">gws auth login</code>
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <button class="btn btn-primary" id="gws-test-btn">Test Connection</button>
          <span id="gws-test-status" style="margin-left:0.5rem;font-size:0.8rem;"></span>
        </div>
      `;
    } else {
      area.innerHTML = `
        <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;font-size:0.8rem;">
          <div>
            <span style="color:var(--text-secondary);">CLI:</span>
            <span class="badge badge-running">Installed</span>
            ${gwsStatus.version ? `<span style="color:var(--text-muted);margin-left:0.5rem;">${esc(gwsStatus.version)}</span>` : ''}
          </div>
          <div>
            <span style="color:var(--text-secondary);">Auth:</span>
            <span class="badge badge-running">Connected</span>
          </div>
          ${gwsStatus.authMethod ? `<div><span style="color:var(--text-secondary);">Method:</span> <span style="color:var(--text-primary);">${esc(gwsStatus.authMethod)}</span></div>` : ''}
          ${gwsStatus.services?.length ? `<div><span style="color:var(--text-secondary);">Services:</span> <span style="color:var(--text-primary);">${gwsStatus.services.map(s => esc(s)).join(', ')}</span></div>` : ''}
          <div>
            <span style="color:var(--text-secondary);">Integration:</span>
            <span class="badge ${gwsStatus.enabled ? 'badge-running' : 'badge-dead'}">${gwsStatus.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
        </div>
        ${!gwsStatus.enabled ? `
        <div style="margin-top:0.75rem;padding:0.75rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);font-size:0.8rem;">
          <p style="margin:0 0 0.5rem;color:var(--text-secondary);">
            Authenticated but not enabled. Select the Google services you want and click Enable.
          </p>
          <div class="cfg-field" style="margin-bottom:0.5rem;">
            <label style="font-size:0.78rem;">Services</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.25rem;" id="gws-service-checks">
              ${['gmail', 'calendar', 'drive', 'docs', 'sheets'].map(s => `
                <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.78rem;color:var(--text-primary);cursor:pointer;">
                  <input type="checkbox" value="${s}" ${['gmail', 'calendar', 'drive'].includes(s) ? 'checked' : ''}> ${s}
                </label>
              `).join('')}
            </div>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <button class="btn btn-primary" id="gws-enable-btn">Enable Google Workspace</button>
            <span id="gws-enable-status" style="font-size:0.8rem;"></span>
          </div>
          <p style="margin:0.4rem 0 0;color:var(--text-muted);font-size:0.72rem;">
            Tools become available immediately after enabling.
          </p>
        </div>
        ` : ''}
        <div style="margin-top:0.75rem;">
          <button class="btn btn-secondary" id="gws-test-btn">Test Connection</button>
          <span id="gws-test-status" style="margin-left:0.5rem;font-size:0.8rem;"></span>
        </div>
      `;
    }

    // Enable button handler
    section.querySelector('#gws-enable-btn')?.addEventListener('click', async () => {
      const btn = section.querySelector('#gws-enable-btn');
      const statusEl = section.querySelector('#gws-enable-status');
      const checks = section.querySelectorAll('#gws-service-checks input:checked');
      const services = Array.from(checks).map(c => c.value);
      if (services.length === 0) {
        statusEl.textContent = 'Select at least one service.';
        statusEl.style.color = 'var(--warning)';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Enabling...';
      statusEl.textContent = '';
      try {
        await api.updateConfig({
          assistant: { tools: { mcp: { enabled: true, managedProviders: { gws: { enabled: true, services } } } } },
        });
        statusEl.textContent = 'Enabled! Restart Guardian Agent for changes to take effect.';
        statusEl.style.color = 'var(--success)';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Enable Google Workspace';
        statusEl.textContent = err.message || 'Failed to save.';
        statusEl.style.color = 'var(--error)';
      }
    });

    // Test connection handler
    section.querySelector('#gws-test-btn')?.addEventListener('click', async () => {
      const btn = section.querySelector('#gws-test-btn');
      const status = section.querySelector('#gws-test-status');
      btn.disabled = true;
      btn.textContent = 'Testing...';
      status.textContent = '';
      try {
        const fresh = await api.gwsStatus();
        renderStatus(fresh);
        const resultStatus = section.querySelector('#gws-test-status');
        if (fresh.authenticated) {
          resultStatus.textContent = 'Connection verified.';
          resultStatus.style.color = 'var(--success)';
        } else if (fresh.installed) {
          resultStatus.textContent = 'CLI found but not authenticated.';
          resultStatus.style.color = 'var(--warning)';
        } else {
          resultStatus.textContent = 'CLI not found on PATH.';
          resultStatus.style.color = 'var(--error)';
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Test Connection';
        status.textContent = err.message || 'Test failed.';
        status.style.color = 'var(--error)';
      }
    });
  }

  api.gwsStatus().catch(() => null).then(renderStatus);
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
