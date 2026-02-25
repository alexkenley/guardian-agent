/**
 * Config Center page — unified status + provider/channel configuration.
 */

import { api } from '../api.js';

export async function renderConfig(container) {
  container.innerHTML = '<h2 class="page-title">Configuration Center</h2><div class="loading">Loading...</div>';

  try {
    const [config, providers, setupStatus] = await Promise.all([
      api.config(),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
    ]);

    container.innerHTML = '<h2 class="page-title">Configuration Center</h2>';

    const intro = document.createElement('div');
    intro.className = 'config-intro';
    intro.textContent = 'Configure AI providers, onboarding status, and channel readiness from one place.';
    container.appendChild(intro);

    container.appendChild(createOverview(config, providers, setupStatus));
    container.appendChild(createProviderPanel(config, providers, setupStatus, container));
    container.appendChild(createProviderStatusTable(config, providers));

    container.appendChild(createSection('Channels (Read-Only Snapshot)', config.channels));
    container.appendChild(createSection('Guardian (Read-Only Snapshot)', config.guardian));
    container.appendChild(createSection('Runtime (Read-Only Snapshot)', config.runtime));
    container.appendChild(createSection('Assistant (Read-Only Snapshot)', config.assistant));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Configuration Center</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

function createOverview(config, providers, setupStatus) {
  const wrap = document.createElement('div');

  const cards = document.createElement('div');
  cards.className = 'cfg-overview-grid';

  const defaultProvider = providers.find((p) => p.name === config.defaultProvider);
  const connectedText = defaultProvider
    ? (defaultProvider.connected === false ? 'Disconnected' : 'Connected')
    : 'Unknown';
  const connectedTone = defaultProvider && defaultProvider.connected === false ? 'error' : 'success';

  cards.appendChild(createMiniCard('Setup', setupStatus?.completed ? 'Complete' : 'Pending', setupStatus?.ready ? 'Ready' : 'Needs attention', setupStatus?.completed ? 'success' : 'warning'));
  cards.appendChild(createMiniCard('Default Provider', config.defaultProvider || 'None', connectedText, connectedTone));
  cards.appendChild(createMiniCard('Providers', String(Object.keys(config.llm || {}).length), `${providers.length} detected`, 'info'));
  cards.appendChild(createMiniCard('Telegram', config.channels?.telegram?.enabled ? 'Enabled' : 'Disabled', 'Configure below', config.channels?.telegram?.enabled ? 'success' : 'warning'));

  wrap.appendChild(cards);

  if (setupStatus?.steps?.length) {
    const stepBox = document.createElement('div');
    stepBox.className = 'table-container';
    stepBox.innerHTML = `
      <div class="table-header"><h3>Readiness Checklist</h3></div>
      <div class="cfg-checklist-grid">
        ${setupStatus.steps.map((step) => `
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

function createMiniCard(title, value, subtitle, tone) {
  const card = document.createElement('div');
  card.className = `status-card ${tone}`;
  card.innerHTML = `
    <div class="card-title">${esc(title)}</div>
    <div class="card-value">${esc(String(value))}</div>
    <div class="card-subtitle">${esc(String(subtitle))}</div>
  `;
  return card;
}

function createProviderPanel(config, providers, setupStatus, container) {
  const section = document.createElement('div');
  section.className = 'table-container';

  const providerMap = Object.entries(config.llm || {}).reduce((acc, [name, cfg]) => {
    const live = providers.find((p) => p.name === name);
    acc[name] = {
      ...cfg,
      locality: live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external'),
      connected: live?.connected,
      availableModels: live?.availableModels || [],
    };
    return acc;
  }, {});

  const localNames = Object.keys(providerMap).filter((name) => providerMap[name].provider === 'ollama');
  const externalNames = Object.keys(providerMap).filter((name) => providerMap[name].provider !== 'ollama');

  const defaultMode = providerMap[config.defaultProvider]?.provider === 'ollama' ? 'local' : 'external';

  const state = {
    mode: defaultMode,
    selectedProfile: '',
  };

  section.innerHTML = `
    <div class="table-header">
      <h3>AI Provider Configuration</h3>
      <span class="cfg-header-note">Local vs external switching, keys, and onboarding</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-mode-toggle" role="tablist" aria-label="Provider mode">
        <button class="cfg-mode-btn ${state.mode === 'local' ? 'active' : ''}" data-mode="local" type="button">Local (Ollama)</button>
        <button class="cfg-mode-btn ${state.mode === 'external' ? 'active' : ''}" data-mode="external" type="button">External API</button>
      </div>

      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Profile</label>
          <select id="cfg-profile"></select>
        </div>

        <div class="cfg-field">
          <label>Provider Name</label>
          <input id="cfg-provider-name" type="text" placeholder="ollama">
        </div>

        <div class="cfg-field" id="cfg-provider-type-field">
          <label>Provider Type</label>
          <select id="cfg-provider-type">
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>

        <div class="cfg-field">
          <label>Model</label>
          <input id="cfg-model" type="text" placeholder="llama3.2">
        </div>

        <div class="cfg-field">
          <label>Base URL (optional)</label>
          <input id="cfg-base-url" type="text" placeholder="http://127.0.0.1:11434">
        </div>

        <div class="cfg-field" id="cfg-api-key-field">
          <label>API Key</label>
          <input id="cfg-api-key" type="password" placeholder="Leave blank to keep existing key">
        </div>
      </div>

      <div class="cfg-divider"></div>

      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Set As Default Provider</label>
          <select id="cfg-set-default">
            <option value="true" selected>Yes</option>
            <option value="false">No</option>
          </select>
        </div>

        <div class="cfg-field">
          <label>Enable Telegram</label>
          <select id="cfg-telegram-enabled">
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>

        <div class="cfg-field" id="cfg-telegram-token-field">
          <label>Telegram Bot Token</label>
          <input id="cfg-telegram-token" type="password" placeholder="Leave blank to keep existing token">
        </div>

        <div class="cfg-field" id="cfg-telegram-chatids-field">
          <label>Allowed Chat IDs</label>
          <input id="cfg-telegram-chatids" type="text" placeholder="12345,67890">
        </div>

        <div class="cfg-field">
          <label>Mark Setup Complete</label>
          <select id="cfg-setup-complete">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      </div>

      <div class="cfg-actions">
        <button class="btn btn-secondary" id="cfg-test-selected" type="button">Test Selected Profile</button>
        <button class="btn btn-primary" id="cfg-save" type="button">Save Configuration</button>
        <span id="cfg-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const profileEl = section.querySelector('#cfg-profile');
  const providerNameEl = section.querySelector('#cfg-provider-name');
  const providerTypeEl = section.querySelector('#cfg-provider-type');
  const modelEl = section.querySelector('#cfg-model');
  const baseUrlEl = section.querySelector('#cfg-base-url');
  const apiKeyEl = section.querySelector('#cfg-api-key');
  const setDefaultEl = section.querySelector('#cfg-set-default');
  const telegramEnabledEl = section.querySelector('#cfg-telegram-enabled');
  const telegramTokenEl = section.querySelector('#cfg-telegram-token');
  const telegramChatIdsEl = section.querySelector('#cfg-telegram-chatids');
  const setupCompleteEl = section.querySelector('#cfg-setup-complete');
  const providerTypeFieldEl = section.querySelector('#cfg-provider-type-field');
  const apiKeyFieldEl = section.querySelector('#cfg-api-key-field');
  const saveStatusEl = section.querySelector('#cfg-save-status');

  telegramEnabledEl.value = config.channels?.telegram?.enabled ? 'true' : 'false';
  setupCompleteEl.value = setupStatus?.completed || config.assistant?.setupCompleted ? 'true' : 'false';

  function buildProfiles(mode) {
    const names = mode === 'local' ? localNames : externalNames;
    return ['__new__', ...names];
  }

  function getSuggestedName(mode, type) {
    const base = mode === 'local' ? 'ollama' : (type === 'anthropic' ? 'claude' : 'openai');
    if (!providerMap[base]) return base;
    let i = 2;
    while (providerMap[`${base}${i}`]) i += 1;
    return `${base}${i}`;
  }

  function getDefaultModel(mode, type) {
    if (mode === 'local') return 'llama3.2';
    return type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  }

  function applyProfile(name) {
    if (name === '__new__') {
      const providerType = state.mode === 'local' ? 'ollama' : providerTypeEl.value;
      providerNameEl.value = getSuggestedName(state.mode, providerType);
      modelEl.value = getDefaultModel(state.mode, providerType);
      baseUrlEl.value = state.mode === 'local' ? 'http://127.0.0.1:11434' : '';
      apiKeyEl.value = '';
      if (state.mode === 'external' && providerType !== 'openai' && providerType !== 'anthropic') {
        providerTypeEl.value = 'openai';
      }
      return;
    }

    const selected = providerMap[name];
    if (!selected) return;

    providerNameEl.value = name;
    providerTypeEl.value = selected.provider === 'ollama' ? 'openai' : selected.provider;
    modelEl.value = selected.model || '';
    baseUrlEl.value = selected.baseUrl || '';
    apiKeyEl.value = '';
  }

  function renderProfileOptions() {
    const profiles = buildProfiles(state.mode);
    profileEl.innerHTML = profiles.map((name) => {
      if (name === '__new__') return '<option value="__new__">Create new profile...</option>';
      const info = providerMap[name];
      const status = info.connected === false ? 'offline' : 'online';
      return `<option value="${esc(name)}">${esc(name)} (${esc(info.provider)}, ${status})</option>`;
    }).join('');

    const firstConfigured = profiles.find((name) => name !== '__new__') || '__new__';
    const preferred = profiles.includes(config.defaultProvider) ? config.defaultProvider : firstConfigured;
    state.selectedProfile = preferred;
    profileEl.value = preferred;
    applyProfile(preferred);
  }

  function syncModeUI() {
    const isLocal = state.mode === 'local';
    section.querySelectorAll('.cfg-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    providerTypeFieldEl.style.display = isLocal ? 'none' : '';
    apiKeyFieldEl.style.display = isLocal ? 'none' : '';
    modelEl.placeholder = isLocal ? 'llama3.2' : getDefaultModel('external', providerTypeEl.value);
    baseUrlEl.placeholder = isLocal ? 'http://127.0.0.1:11434' : 'Optional custom endpoint';

    renderProfileOptions();
  }

  function syncTelegramFields() {
    const enabled = telegramEnabledEl.value === 'true';
    telegramTokenEl.disabled = !enabled;
    telegramChatIdsEl.disabled = !enabled;
  }

  section.querySelectorAll('.cfg-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode === 'local' ? 'local' : 'external';
      syncModeUI();
    });
  });

  profileEl.addEventListener('change', () => {
    state.selectedProfile = profileEl.value;
    applyProfile(state.selectedProfile);
  });

  providerTypeEl.addEventListener('change', () => {
    if (state.mode !== 'external') return;
    if (state.selectedProfile === '__new__' && !modelEl.value.trim()) {
      modelEl.value = getDefaultModel('external', providerTypeEl.value);
    }
  });

  telegramEnabledEl.addEventListener('change', syncTelegramFields);

  section.querySelector('#cfg-test-selected').addEventListener('click', async () => {
    const providerName = providerNameEl.value.trim();
    if (!providerName) {
      saveStatusEl.textContent = 'Set provider name first.';
      saveStatusEl.style.color = 'var(--warning)';
      return;
    }

    saveStatusEl.textContent = `Testing ${providerName}...`;
    saveStatusEl.style.color = 'var(--text-muted)';

    try {
      const latest = await api.providersStatus();
      const found = latest.find((p) => p.name === providerName);
      if (!found) {
        saveStatusEl.textContent = `Provider '${providerName}' not yet active in runtime (save first).`;
        saveStatusEl.style.color = 'var(--warning)';
        return;
      }

      if (found.connected === false) {
        saveStatusEl.textContent = `${providerName}: disconnected.`;
        saveStatusEl.style.color = 'var(--error)';
      } else {
        const count = found.availableModels?.length || 0;
        saveStatusEl.textContent = `${providerName}: connected (${count} model${count === 1 ? '' : 's'} visible).`;
        saveStatusEl.style.color = 'var(--success)';
      }
    } catch (err) {
      saveStatusEl.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`;
      saveStatusEl.style.color = 'var(--error)';
    }
  });

  section.querySelector('#cfg-save').addEventListener('click', async () => {
    const providerName = providerNameEl.value.trim();
    const model = modelEl.value.trim();
    const baseUrl = baseUrlEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    const providerType = state.mode === 'local' ? 'ollama' : providerTypeEl.value;

    if (!providerName) {
      saveStatusEl.textContent = 'Provider name is required.';
      saveStatusEl.style.color = 'var(--error)';
      return;
    }
    if (!model) {
      saveStatusEl.textContent = 'Model is required.';
      saveStatusEl.style.color = 'var(--error)';
      return;
    }

    const payload = {
      llmMode: state.mode === 'local' ? 'ollama' : 'external',
      providerName,
      providerType,
      model,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      setDefaultProvider: setDefaultEl.value === 'true',
      telegramEnabled: telegramEnabledEl.value === 'true',
      telegramBotToken: telegramTokenEl.value.trim() || undefined,
      telegramAllowedChatIds: parseChatIdsOrUndefined(telegramChatIdsEl.value),
      setupCompleted: setupCompleteEl.value === 'true',
    };

    saveStatusEl.textContent = 'Saving configuration...';
    saveStatusEl.style.color = 'var(--text-muted)';

    try {
      const result = await api.applySetup(payload);
      saveStatusEl.textContent = result.message;
      saveStatusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';

      if (result.success) {
        await renderConfig(container);
      }
    } catch (err) {
      saveStatusEl.textContent = err instanceof Error ? err.message : String(err);
      saveStatusEl.style.color = 'var(--error)';
    }
  });

  syncModeUI();
  syncTelegramFields();

  return section;
}

function createProviderStatusTable(config, providers) {
  const section = document.createElement('div');
  section.className = 'table-container';

  const rows = Object.entries(config.llm || {}).map(([name, cfg]) => {
    const live = providers.find((p) => p.name === name);
    const connected = live ? (live.connected !== false) : true;
    const locality = live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external');
    const statusBadge = `<span class="badge ${connected ? 'badge-idle' : 'badge-errored'}">${connected ? 'Connected' : 'Disconnected'}</span>`;
    const modelList = live?.availableModels?.slice(0, 5).join(', ') || '-';
    const defaultMark = name === config.defaultProvider ? ' (default)' : '';

    return `
      <tr>
        <td><strong>${esc(name)}</strong>${esc(defaultMark)}</td>
        <td>${esc(cfg.provider)}</td>
        <td>${esc(cfg.model)}</td>
        <td>${esc(locality)}</td>
        <td>${statusBadge}</td>
        <td>${esc(modelList)}</td>
      </tr>
    `;
  }).join('');

  section.innerHTML = `
    <div class="table-header"><h3>Configured Providers</h3></div>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Model</th>
          <th>Locality</th>
          <th>Status</th>
          <th>Available Models</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="6">No providers configured</td></tr>'}</tbody>
    </table>
  `;

  return section;
}

function badgeForStep(status) {
  if (status === 'complete') return 'badge-idle';
  if (status === 'warning') return 'badge-warn';
  return 'badge-errored';
}

function parseChatIdsOrUndefined(input) {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const parsed = trimmed
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id));
  return parsed.length > 0 ? parsed : undefined;
}

function createSection(title, data) {
  const section = document.createElement('div');
  section.className = 'config-section';

  const header = document.createElement('div');
  header.className = 'config-section-header';
  header.innerHTML = `<span>${esc(title)}</span><span class="toggle-icon">&#9660;</span>`;

  const body = document.createElement('div');
  body.className = 'config-section-body';
  body.innerHTML = `<pre>${highlight(JSON.stringify(data, null, 2))}</pre>`;

  let collapsed = true;
  body.style.display = 'none';
  header.querySelector('.toggle-icon').innerHTML = '&#9654;';

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

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
