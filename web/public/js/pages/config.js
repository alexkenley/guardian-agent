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

  // Telegram config section
  const telegramSection = document.createElement('div');
  telegramSection.className = 'table-container';
  telegramSection.innerHTML = `
    <div class="table-header"><h3>Telegram Channel</h3></div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enable Telegram</label>
          <select id="cfg-telegram-enabled">
            <option value="false" ${!config.channels?.telegram?.enabled ? 'selected' : ''}>No</option>
            <option value="true" ${config.channels?.telegram?.enabled ? 'selected' : ''}>Yes</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Telegram Bot Token</label>
          <input id="cfg-telegram-token" type="password" placeholder="Leave blank to keep existing token">
        </div>
        <div class="cfg-field">
          <label>Allowed Chat IDs</label>
          <input id="cfg-telegram-chatids" type="text" placeholder="12345,67890">
        </div>
      </div>
    </div>
  `;
  panel.appendChild(telegramSection);
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
              <div class="cfg-field"><label>Model</label><input id="cfg-local-model" type="text" placeholder="llama3.2"></div>
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
              <div class="cfg-field"><label>Model</label><input id="cfg-ext-model" type="text" placeholder="claude-sonnet-4-20250514"></div>
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
    return type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  }

  function wirePanel(side) {
    const isLocal = side === 'local';
    const prefix = isLocal ? 'cfg-local' : 'cfg-ext';
    const names = isLocal ? localNames : externalNames;

    const profileEl = section.querySelector(`#${prefix}-profile`);
    const nameEl = section.querySelector(`#${prefix}-name`);
    const modelEl = section.querySelector(`#${prefix}-model`);
    const urlEl = section.querySelector(`#${prefix}-url`);
    const defaultEl = section.querySelector(`#${prefix}-default`);
    const statusEl = section.querySelector(`#${prefix}-status`);
    const typeEl = isLocal ? null : section.querySelector('#cfg-ext-type');
    const keyEl = isLocal ? null : section.querySelector('#cfg-ext-key');

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
        modelEl.value = getDefaultModel(side, pt);
        urlEl.value = isLocal ? 'http://127.0.0.1:11434' : '';
        if (keyEl) keyEl.value = '';
        return;
      }
      const entry = providerMap[name];
      if (!entry) return;
      nameEl.value = name;
      modelEl.value = entry.model || '';
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
        else { const count = found.availableModels?.length || 0; statusEl.textContent = `${providerName}: connected (${count} model${count === 1 ? '' : 's'}).`; statusEl.style.color = 'var(--success)'; }
      } catch (err) { statusEl.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`; statusEl.style.color = 'var(--error)'; }
    });

    section.querySelector(`#${prefix}-save`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      const model = modelEl.value.trim();
      const baseUrl = urlEl.value.trim();
      const providerType = isLocal ? 'ollama' : (typeEl?.value || 'openai');

      if (!providerName) { statusEl.textContent = 'Provider name is required.'; statusEl.style.color = 'var(--error)'; return; }
      if (!model) { statusEl.textContent = 'Model is required.'; statusEl.style.color = 'var(--error)'; return; }

      const telegramEnabledEl = panel.querySelector('#cfg-telegram-enabled');
      const telegramTokenEl = panel.querySelector('#cfg-telegram-token');
      const telegramChatIdsEl = panel.querySelector('#cfg-telegram-chatids');

      const payload = {
        llmMode: isLocal ? 'ollama' : 'external',
        providerName, providerType, model,
        baseUrl: baseUrl || undefined,
        apiKey: keyEl?.value.trim() || undefined,
        setDefaultProvider: defaultEl.value === 'true',
        telegramEnabled: telegramEnabledEl?.value === 'true',
        telegramBotToken: telegramTokenEl?.value.trim() || undefined,
        telegramAllowedChatIds: parseChatIdsOrUndefined(telegramChatIdsEl?.value || ''),
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
    const state = await api.toolsState(80);
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
          <div class="card-title">Pending Approvals</div>
          <div class="card-value">${approvals.filter(a => a.status === 'pending').length}</div>
          <div class="card-subtitle">Manual decisions required</div>
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
      { key: 'allowedPaths', label: 'Allowed Paths', placeholder: '/home/user/data, /tmp/scratch' },
      { key: 'allowedCommands', label: 'Allowed Commands', placeholder: 'ls, cat, ping' },
      { key: 'allowedDomains', label: 'Allowed Domains', placeholder: 'example.com, api.github.com' },
    ];

    let activeCategory = categories[0].key;

    function render() {
      const cat = categories.find(c => c.key === activeCategory);
      const items = policy.sandbox?.[activeCategory] || [];

      panel.innerHTML = `
        <div class="table-container">
          <div class="table-header">
            <h3>Sandbox Allowlist Editor</h3>
            <span class="cfg-header-note">Add and remove items in real-time</span>
          </div>
          <div class="cfg-center-body">
            <div class="cfg-form-grid" style="margin-bottom:1rem;">
              <div class="cfg-field">
                <label>Execution Mode</label>
                <span class="intel-inline" style="padding:0.4rem 0">${esc(policy.mode)}</span>
              </div>
              <div class="cfg-field">
                <label>Category</label>
                <select id="policy-category">
                  ${categories.map(c => `<option value="${c.key}" ${c.key === activeCategory ? 'selected' : ''}>${c.label}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="policy-add-row">
              <input type="text" id="policy-add-input" placeholder="${esc(cat.placeholder)}">
              <button class="btn btn-primary" id="policy-add-btn">Add</button>
            </div>

            <div class="policy-chip-list" id="policy-chip-list">
              ${items.length === 0
                ? '<span style="color:var(--text-muted);font-size:0.78rem;">No items in this category. Add one above.</span>'
                : items.map(item => `
                  <span class="policy-chip">
                    ${esc(item)}
                    <button class="chip-remove" data-item="${escAttr(item)}" title="Remove">&times;</button>
                  </span>
                `).join('')}
            </div>

            <div id="policy-status" style="margin-top:0.75rem;font-size:0.78rem;color:var(--text-muted);"></div>
          </div>
        </div>
      `;

      // Category switch
      panel.querySelector('#policy-category')?.addEventListener('change', (e) => {
        activeCategory = e.target.value;
        render();
      });

      // Add item
      const addInput = panel.querySelector('#policy-add-input');
      const addBtn = panel.querySelector('#policy-add-btn');
      const statusEl = panel.querySelector('#policy-status');

      async function addItem() {
        const value = addInput.value.trim();
        if (!value) return;
        const current = policy.sandbox?.[activeCategory] || [];
        if (current.includes(value)) {
          statusEl.textContent = 'Item already exists.';
          statusEl.style.color = 'var(--warning)';
          return;
        }
        const updated = [...current, value];
        statusEl.textContent = 'Saving...';
        statusEl.style.color = 'var(--text-muted)';
        try {
          const result = await api.updateToolPolicy({ sandbox: { [activeCategory]: updated } });
          if (result.success !== false) {
            if (!policy.sandbox) policy.sandbox = {};
            policy.sandbox[activeCategory] = updated;
            render();
          } else {
            statusEl.textContent = result.message || 'Failed to save.';
            statusEl.style.color = 'var(--error)';
          }
        } catch (err) {
          statusEl.textContent = err instanceof Error ? err.message : String(err);
          statusEl.style.color = 'var(--error)';
        }
      }

      addBtn?.addEventListener('click', addItem);
      addInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });

      // Remove item
      panel.querySelectorAll('.chip-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          const item = btn.getAttribute('data-item');
          if (!item) return;
          if (!confirm(`Remove "${item}" from ${categories.find(c => c.key === activeCategory)?.label}?`)) return;
          const current = policy.sandbox?.[activeCategory] || [];
          const updated = current.filter(i => i !== item);
          statusEl.textContent = 'Removing...';
          statusEl.style.color = 'var(--text-muted)';
          try {
            const result = await api.updateToolPolicy({ sandbox: { [activeCategory]: updated } });
            if (result.success !== false) {
              policy.sandbox[activeCategory] = updated;
              render();
            } else {
              statusEl.textContent = result.message || 'Failed to remove.';
              statusEl.style.color = 'var(--error)';
            }
          } catch (err) {
            statusEl.textContent = err instanceof Error ? err.message : String(err);
            statusEl.style.color = 'var(--error)';
          }
        });
      });

      applyInputTooltips(panel);
    }

    render();
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message || String(err))}</div>`;
  }
}

// ─── Search Sources Tab (QMD) ────────────────────────────

function renderSearchSourcesTab(panel) {
  const qmdCfg = sharedConfig?.assistant?.tools?.qmd;
  const enabled = qmdCfg?.enabled ?? false;

  panel.innerHTML = `
    <div class="cfg-card" style="margin-bottom:1rem;">
      <div class="cfg-card-header"><h3>QMD Search Engine</h3></div>
      <div class="cfg-card-body" id="qmd-status-area">
        <p style="color:var(--text-muted);">${enabled ? 'Loading status...' : 'QMD search is <strong>disabled</strong> in config. Set <code>assistant.tools.qmd.enabled: true</code> to activate.'}</p>
      </div>
    </div>
    <div class="cfg-card" style="margin-bottom:1rem;">
      <div class="cfg-card-header">
        <h3>Document Sources</h3>
        <button class="btn btn-primary btn-sm" id="qmd-add-source" type="button" ${enabled ? '' : 'disabled'}>+ Add Source</button>
      </div>
      <div class="cfg-card-body" id="qmd-sources-area">
        ${enabled ? '<p style="color:var(--text-muted);">Loading...</p>' : ''}
      </div>
    </div>
    <div id="qmd-add-form-area" style="display:none;">
      <div class="cfg-card">
        <div class="cfg-card-header"><h3>Add Source</h3></div>
        <div class="cfg-card-body">
          <form id="qmd-add-form" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem 1rem;">
            <div class="form-field"><label>ID (collection name)</label><input name="id" required placeholder="my-notes" /></div>
            <div class="form-field"><label>Display Name</label><input name="name" required placeholder="My Notes" /></div>
            <div class="form-field">
              <label>Type</label>
              <select name="type">
                <option value="directory">Directory</option>
                <option value="git">Git Repository</option>
                <option value="url">URL</option>
                <option value="file">Single File</option>
              </select>
            </div>
            <div class="form-field"><label>Path / URL</label><input name="path" required placeholder="/home/user/notes or https://..." /></div>
            <div class="form-field"><label>Globs (comma-separated)</label><input name="globs" placeholder="**/*.md, **/*.txt" /></div>
            <div class="form-field"><label>Branch (git only)</label><input name="branch" placeholder="main" /></div>
            <div class="form-field"><label>Description</label><input name="description" placeholder="Optional description" /></div>
            <div class="form-field" style="display:flex;align-items:end;gap:0.5rem;">
              <button class="btn btn-primary" type="submit">Add</button>
              <button class="btn" type="button" id="qmd-add-cancel">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  if (!enabled) return;

  // Load status
  loadQMDStatus(panel);
  loadQMDSources(panel);

  // Wire add source toggle
  panel.querySelector('#qmd-add-source').addEventListener('click', () => {
    panel.querySelector('#qmd-add-form-area').style.display = '';
  });
  panel.querySelector('#qmd-add-cancel').addEventListener('click', () => {
    panel.querySelector('#qmd-add-form-area').style.display = 'none';
  });

  // Wire add form
  panel.querySelector('#qmd-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const source = {
      id: fd.get('id')?.trim(),
      name: fd.get('name')?.trim(),
      type: fd.get('type'),
      path: fd.get('path')?.trim(),
      globs: fd.get('globs')?.trim() ? fd.get('globs').split(',').map(g => g.trim()).filter(Boolean) : undefined,
      branch: fd.get('branch')?.trim() || undefined,
      description: fd.get('description')?.trim() || undefined,
      enabled: true,
    };
    try {
      const result = await api.qmdSourceAdd(source);
      if (result.success) {
        e.target.reset();
        panel.querySelector('#qmd-add-form-area').style.display = 'none';
        loadQMDSources(panel);
      } else {
        alert(result.message || 'Failed to add source.');
      }
    } catch (err) {
      alert(err.message || 'Error adding source.');
    }
  });
}

async function loadQMDStatus(panel) {
  const area = panel.querySelector('#qmd-status-area');
  try {
    const status = await api.qmdStatus();
    area.innerHTML = `
      <div style="display:flex;gap:2rem;flex-wrap:wrap;">
        <div><strong>Installed:</strong> ${status.installed ? '<span style="color:var(--success);">Yes</span>' : '<span style="color:var(--danger);">No</span>'}</div>
        ${status.version ? `<div><strong>Version:</strong> ${esc(status.version)}</div>` : ''}
        <div><strong>Collections:</strong> ${status.collections?.length ?? 0}</div>
        <div><strong>Configured Sources:</strong> ${status.configuredSources?.length ?? 0}</div>
      </div>
      ${!status.installed ? '<p style="margin-top:0.5rem;color:var(--warning);">Install QMD from <a href="https://github.com/tobi/qmd" target="_blank">github.com/tobi/qmd</a> to enable search.</p>' : ''}
    `;
  } catch (err) {
    area.innerHTML = `<p style="color:var(--danger);">Error loading status: ${esc(err.message)}</p>`;
  }
}

async function loadQMDSources(panel) {
  const area = panel.querySelector('#qmd-sources-area');
  try {
    const sources = await api.qmdSources();
    if (!sources.length) {
      area.innerHTML = '<p style="color:var(--text-muted);">No sources configured. Add one to start indexing documents.</p>';
      return;
    }
    const typeLabels = { directory: 'Directory', git: 'Git Repo', url: 'URL', file: 'File' };
    area.innerHTML = `
      <table class="data-table" style="width:100%;">
        <thead><tr><th>Name</th><th>Type</th><th>Path</th><th>Globs</th><th>Enabled</th><th>Actions</th></tr></thead>
        <tbody>
          ${sources.map(s => `<tr>
            <td><strong>${esc(s.name)}</strong><br/><small style="color:var(--text-muted);">${esc(s.id)}</small></td>
            <td>${esc(typeLabels[s.type] || s.type)}</td>
            <td style="max-width:20rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(s.path)}">${esc(s.path)}</td>
            <td>${(s.globs || []).map(g => `<code>${esc(g)}</code>`).join(', ') || '<span style="color:var(--text-muted);">default</span>'}</td>
            <td>
              <label class="toggle-switch">
                <input type="checkbox" ${s.enabled ? 'checked' : ''} data-source-id="${esc(s.id)}" class="qmd-toggle" />
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td>
              <button class="btn btn-sm qmd-reindex-btn" data-source-id="${esc(s.id)}" title="Reindex">Reindex</button>
              <button class="btn btn-sm btn-danger qmd-remove-btn" data-source-id="${esc(s.id)}" title="Remove">Remove</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="margin-top:0.75rem;">
        <button class="btn btn-primary btn-sm" id="qmd-reindex-all" type="button">Reindex All</button>
      </div>
    `;

    // Wire toggle handlers
    area.querySelectorAll('.qmd-toggle').forEach(el => {
      el.addEventListener('change', async (e) => {
        const id = e.target.dataset.sourceId;
        try {
          await api.qmdSourceToggle(id, e.target.checked);
        } catch (err) {
          alert(err.message);
          e.target.checked = !e.target.checked;
        }
      });
    });

    // Wire reindex buttons
    area.querySelectorAll('.qmd-reindex-btn').forEach(el => {
      el.addEventListener('click', async (e) => {
        const id = e.target.dataset.sourceId;
        e.target.disabled = true;
        e.target.textContent = 'Reindexing...';
        try {
          const result = await api.qmdReindex(id);
          e.target.textContent = result.success ? 'Done' : 'Failed';
          setTimeout(() => { e.target.textContent = 'Reindex'; e.target.disabled = false; }, 2000);
        } catch (err) {
          e.target.textContent = 'Error';
          setTimeout(() => { e.target.textContent = 'Reindex'; e.target.disabled = false; }, 2000);
        }
      });
    });

    // Wire remove buttons
    area.querySelectorAll('.qmd-remove-btn').forEach(el => {
      el.addEventListener('click', async (e) => {
        const id = e.target.dataset.sourceId;
        if (!confirm(`Remove source "${id}"?`)) return;
        try {
          const result = await api.qmdSourceRemove(id);
          if (result.success) loadQMDSources(panel);
          else alert(result.message);
        } catch (err) {
          alert(err.message);
        }
      });
    });

    // Wire reindex all
    area.querySelector('#qmd-reindex-all')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Reindexing all...';
      try {
        const result = await api.qmdReindex();
        e.target.textContent = result.success ? 'Done' : 'Failed';
        setTimeout(() => { e.target.textContent = 'Reindex All'; e.target.disabled = false; }, 2000);
      } catch (err) {
        e.target.textContent = 'Error';
        setTimeout(() => { e.target.textContent = 'Reindex All'; e.target.disabled = false; }, 2000);
      }
    });
  } catch (err) {
    area.innerHTML = `<p style="color:var(--danger);">Error loading sources: ${esc(err.message)}</p>`;
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

  // Web Search & Fallback
  panel.appendChild(createWebSearchPanel(config, panel));

  // Browser Automation
  panel.appendChild(createBrowserPanel(config, panel));

  // Trust Preset
  panel.appendChild(createTrustPresetPanel(config));

  // Auth
  panel.appendChild(createAuthPanel(config, authStatus, panel));

  // Read-only config snapshots
  panel.appendChild(createSection('Channels (Read-Only Snapshot)', config.channels));
  panel.appendChild(createSection('Guardian (Read-Only Snapshot)', config.guardian));
  panel.appendChild(createSection('Runtime (Read-Only Snapshot)', config.runtime));
  panel.appendChild(createSection('Assistant (Read-Only Snapshot)', config.assistant));
}

function createOverview(config, providers, setupStatus) {
  const wrap = document.createElement('div');
  const cards = document.createElement('div');
  cards.className = 'cfg-overview-grid';
  const defaultProvider = providers.find(p => p.name === config.defaultProvider);
  const connectedText = defaultProvider ? (defaultProvider.connected === false ? 'Disconnected' : 'Connected') : 'Unknown';
  const connectedTone = defaultProvider && defaultProvider.connected === false ? 'error' : 'success';

  cards.appendChild(createMiniCard('Readiness', setupStatus?.ready ? 'Ready' : 'Needs attention', setupStatus?.completed ? 'Baseline saved' : 'Configuration pending', setupStatus?.ready ? 'success' : 'warning'));
  cards.appendChild(createMiniCard('Default Provider', config.defaultProvider || 'None', connectedText, connectedTone));
  cards.appendChild(createMiniCard('Providers', String(Object.keys(config.llm || {}).length), `${providers.length} detected`, 'info'));
  cards.appendChild(createMiniCard('Telegram', config.channels?.telegram?.enabled ? 'Enabled' : 'Disabled', 'Configure in Providers tab', config.channels?.telegram?.enabled ? 'success' : 'warning'));
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
  const mode = authStatus?.mode || config.channels?.web?.auth?.mode || 'bearer_required';
  const tokenConfigured = !!authStatus?.tokenConfigured;
  const tokenSource = authStatus?.tokenSource || config.channels?.web?.auth?.tokenSource || 'ephemeral';
  const ttl = authStatus?.sessionTtlMinutes ?? config.channels?.web?.auth?.sessionTtlMinutes ?? '';

  section.innerHTML = `
    <div class="table-header"><h3>Web Authentication</h3><span class="cfg-header-note">Bearer token controls for dashboard and API access</span></div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field"><label>Auth Mode</label><select id="auth-mode"><option value="bearer_required" ${mode === 'bearer_required' ? 'selected' : ''}>bearer_required</option><option value="localhost_no_auth" ${mode === 'localhost_no_auth' ? 'selected' : ''}>localhost_no_auth</option><option value="disabled" ${mode === 'disabled' ? 'selected' : ''}>disabled</option></select></div>
        <div class="cfg-field"><label>Token Source</label><input id="auth-token-source" type="text" value="${esc(tokenSource)}" readonly></div>
        <div class="cfg-field"><label>Session TTL Minutes</label><input id="auth-ttl" type="number" min="1" placeholder="120" value="${esc(String(ttl))}"></div>
        <div class="cfg-field"><label>Current Token</label><input id="auth-token-preview" type="text" readonly value="${tokenConfigured ? esc(authStatus?.tokenPreview || 'configured') : 'not configured'}"></div>
        <div class="cfg-field"><label>Set/New Token</label><input id="auth-token-input-new" type="password" placeholder="Leave empty to keep existing"></div>
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="auth-save" type="button">Save Auth Settings</button>
        <button class="btn btn-secondary" id="auth-rotate" type="button">Rotate Token</button>
        <button class="btn btn-secondary" id="auth-reveal" type="button">Reveal Token</button>
        <button class="btn btn-secondary" id="auth-revoke" type="button">Disable Auth</button>
        <span id="auth-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const modeEl = section.querySelector('#auth-mode');
  const ttlEl = section.querySelector('#auth-ttl');
  const tokenInputEl = section.querySelector('#auth-token-input-new');
  const tokenPreviewEl = section.querySelector('#auth-token-preview');
  const statusEl = section.querySelector('#auth-save-status');
  const setStatus = (text, color) => { statusEl.textContent = text; statusEl.style.color = color; };

  section.querySelector('#auth-save')?.addEventListener('click', async () => {
    const payload = { mode: modeEl.value, token: tokenInputEl.value.trim() || undefined, sessionTtlMinutes: ttlEl.value ? Number(ttlEl.value) : undefined };
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

  section.querySelector('#auth-revoke')?.addEventListener('click', async () => {
    setStatus('Disabling...', 'var(--text-muted)');
    try {
      const result = await api.revokeAuthToken();
      setStatus(result.message || 'Auth disabled.', result.success ? 'var(--warning)' : 'var(--error)');
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  applyInputTooltips(section);
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
