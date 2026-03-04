/**
 * Config Center page — unified status + provider/channel configuration.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderConfig(container) {
  container.innerHTML = '<h2 class="page-title">Configuration Center</h2><div class="loading">Loading...</div>';

  try {
    const [config, providers, setupStatus, authStatus] = await Promise.all([
      api.config(),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
      api.authStatus().catch(() => null),
    ]);

    container.innerHTML = '<h2 class="page-title">Configuration Center</h2>';

    const intro = document.createElement('div');
    intro.className = 'config-intro';
    intro.textContent = 'Configure AI providers, channel access, and assistant readiness from one place.';
    container.appendChild(intro);

    container.appendChild(createOverview(config, providers, setupStatus));
    container.appendChild(createProviderPanel(config, providers, container));
    container.appendChild(createProviderStatusTable(config, providers));
    container.appendChild(createAuthPanel(config, authStatus, container));

    container.appendChild(createWebSearchPanel(config, container));
    container.appendChild(createBrowserPanel(config, container));
    container.appendChild(createTrustPresetPanel(config));
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

  cards.appendChild(createMiniCard('Readiness', setupStatus?.ready ? 'Ready' : 'Needs attention', setupStatus?.completed ? 'Baseline saved' : 'Configuration pending', setupStatus?.ready ? 'success' : 'warning'));
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

function createWebSearchPanel(config, container) {
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
            <option value="brave" ${ws.provider === 'brave' ? 'selected' : ''}>Brave (search + free AI summary)</option>
            <option value="perplexity" ${ws.provider === 'perplexity' ? 'selected' : ''}>Perplexity (synthesized answers)</option>
            <option value="duckduckgo" ${ws.provider === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo (no key needed)</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Brave Search API Key (recommended)${ws.braveConfigured ? ' <button type="button" class="ws-clear-btn" data-target="ws-brave-key" style="font-size:0.65rem;margin-left:0.4rem;cursor:pointer;background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:0 0.3rem;">clear</button>' : ''}</label>
          <input id="ws-brave-key" type="password" placeholder="${ws.braveConfigured ? 'Configured — leave blank to keep' : 'BSA...'}">
        </div>
        <div class="cfg-field">
          <label>Perplexity API Key${ws.perplexityConfigured ? ' <button type="button" class="ws-clear-btn" data-target="ws-perplexity-key" style="font-size:0.65rem;margin-left:0.4rem;cursor:pointer;background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:0 0.3rem;">clear</button>' : ''}</label>
          <input id="ws-perplexity-key" type="password" placeholder="${ws.perplexityConfigured ? 'Configured — leave blank to keep' : 'pplx-...'}">
        </div>
        <div class="cfg-field">
          <label>OpenRouter API Key (Perplexity proxy)${ws.openRouterConfigured ? ' <button type="button" class="ws-clear-btn" data-target="ws-openrouter-key" style="font-size:0.65rem;margin-left:0.4rem;cursor:pointer;background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:0 0.3rem;">clear</button>' : ''}</label>
          <input id="ws-openrouter-key" type="password" placeholder="${ws.openRouterConfigured ? 'Configured — leave blank to keep' : 'sk-or-...'}">
        </div>
      </div>

      <div class="cfg-divider"></div>

      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Model Fallback Chain</label>
          <input id="ws-fallbacks" type="text" value="${esc(fallbacks.join(', '))}" placeholder="e.g. claude, gpt (comma-separated provider names)">
        </div>
        <div class="cfg-field">
          <label>Available Providers</label>
          <input type="text" readonly value="${esc(providerNames.join(', '))}" style="opacity:0.7;">
        </div>
      </div>

      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        Auto selects the best search provider: Brave &gt; Perplexity &gt; DuckDuckGo.
        Brave is recommended — one API key covers search + free AI Summarizer.
        Fallback chain: when the default LLM fails, tries each fallback in order.
      </div>

      <div class="cfg-actions">
        <button class="btn btn-primary" id="ws-save" type="button">Save Search &amp; Fallback</button>
        <span id="ws-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#ws-save-status');

  // Track which keys are marked for clearing
  const cleared = new Set();
  section.querySelectorAll('.ws-clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = section.querySelector(`#${targetId}`);
      if (input) {
        input.value = '';
        input.placeholder = 'Key will be removed on save';
        input.style.borderColor = 'var(--warning)';
        cleared.add(targetId);
      }
    });
  });

  // Resolve key value: new value, clear signal, or leave unchanged
  function resolveKey(fieldId, wasConfigured) {
    const value = section.querySelector(`#${fieldId}`).value.trim();
    if (value) return value;            // New key entered
    if (cleared.has(fieldId)) return ''; // Explicitly cleared → send empty string
    return undefined;                   // Untouched → leave unchanged
  }

  section.querySelector('#ws-save')?.addEventListener('click', async () => {
    const provider = section.querySelector('#ws-provider').value;
    const fallbacksRaw = section.querySelector('#ws-fallbacks').value.trim();

    const fallbackList = fallbacksRaw
      ? fallbacksRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

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
      if (result.success) {
        await renderConfig(container);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(section);
  return section;
}

function createBrowserPanel(config, container) {
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
      <span class="cfg-header-note">Headless browser for JS-rendered pages, forms, and multi-step navigation</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Browser Tools</label>
          <select id="browser-enabled">
            <option value="true" ${enabled ? 'selected' : ''}>Enabled</option>
            <option value="false" ${!enabled ? 'selected' : ''}>Disabled</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Allowed Domains</label>
          <input id="browser-domains" type="text" value="${esc(domains)}" placeholder="example.com, github.com (comma-separated)">
        </div>
        <div class="cfg-field">
          <label>Max Concurrent Sessions</label>
          <input id="browser-max-sessions" type="number" min="1" max="10" value="${maxSessions}">
        </div>
        <div class="cfg-field">
          <label>Idle Timeout (seconds)</label>
          <input id="browser-idle-timeout" type="number" min="30" max="3600" value="${Math.round(idleTimeout / 1000)}">
        </div>
      </div>

      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        Browser tools use agent-browser to render JavaScript-heavy pages, interact with forms, and navigate multi-page flows.
        All URLs are validated against the domain allowlist and blocked for private/internal addresses (SSRF protection).
        Page content is treated as untrusted. Requires agent-browser binary (npm install agent-browser &amp;&amp; npx agent-browser install).
        Changes require a restart to take effect.
      </div>

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
    const domainList = domainsRaw ? domainsRaw.split(',').map((d) => d.trim()).filter(Boolean) : [];
    const maxSessionsVal = parseInt(section.querySelector('#browser-max-sessions').value, 10) || 3;
    const idleTimeoutVal = (parseInt(section.querySelector('#browser-idle-timeout').value, 10) || 300) * 1000;

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const result = await api.saveBrowserConfig({
        enabled: enabledVal,
        allowedDomains: domainList.length > 0 ? domainList : undefined,
        maxSessions: maxSessionsVal,
        sessionIdleTimeoutMs: idleTimeoutVal,
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        await renderConfig(container);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(section);
  return section;
}

function createTrustPresetPanel(config) {
  const section = document.createElement('div');
  section.className = 'table-container';

  const currentPreset = config.guardian?.trustPreset || '';

  section.innerHTML = `
    <div class="table-header">
      <h3>Trust Preset</h3>
      <span class="cfg-header-note">Quick security posture configuration</span>
    </div>
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
      <div style="margin-top:0.75rem;font-size:0.74rem;color:var(--text-muted);">
        Presets set baseline capabilities, rate limits, and tool policies. Explicit config values always override preset defaults.
        Changes require a config file update and restart to take effect.
      </div>
    </div>
  `;

  return section;
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

function createProviderPanel(config, providers, container) {
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
              <div class="cfg-field">
                <label>Profile</label>
                <select id="cfg-local-profile"></select>
              </div>
              <div class="cfg-field">
                <label>Provider Name</label>
                <input id="cfg-local-name" type="text" placeholder="ollama">
              </div>
              <div class="cfg-field">
                <label>Model</label>
                <input id="cfg-local-model" type="text" placeholder="llama3.2">
              </div>
              <div class="cfg-field">
                <label>Base URL</label>
                <input id="cfg-local-url" type="text" placeholder="http://127.0.0.1:11434">
              </div>
            </div>
            <div class="cfg-form-grid" style="margin-top:0.75rem;">
              <div class="cfg-field">
                <label>Set As Default</label>
                <select id="cfg-local-default">
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
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
              <div class="cfg-field">
                <label>Profile</label>
                <select id="cfg-ext-profile"></select>
              </div>
              <div class="cfg-field">
                <label>Provider Name</label>
                <input id="cfg-ext-name" type="text" placeholder="claude">
              </div>
              <div class="cfg-field">
                <label>Provider Type</label>
                <select id="cfg-ext-type">
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                </select>
              </div>
              <div class="cfg-field">
                <label>Model</label>
                <input id="cfg-ext-model" type="text" placeholder="claude-sonnet-4-20250514">
              </div>
              <div class="cfg-field">
                <label>API Key</label>
                <input id="cfg-ext-key" type="password" placeholder="Leave blank to keep existing">
              </div>
              <div class="cfg-field">
                <label>Base URL (optional)</label>
                <input id="cfg-ext-url" type="text" placeholder="Optional custom endpoint">
              </div>
            </div>
            <div class="cfg-form-grid" style="margin-top:0.75rem;">
              <div class="cfg-field">
                <label>Set As Default</label>
                <select id="cfg-ext-default">
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-secondary" id="cfg-ext-test" type="button">Test Connection</button>
              <button class="btn btn-primary" id="cfg-ext-save" type="button">Save</button>
              <span id="cfg-ext-status" class="cfg-save-status"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="cfg-divider"></div>

      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enable Telegram</label>
          <select id="cfg-telegram-enabled">
            <option value="false">No</option>
            <option value="true">Yes</option>
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

  // --- Telegram fields ---
  const telegramEnabledEl = section.querySelector('#cfg-telegram-enabled');
  const telegramTokenEl = section.querySelector('#cfg-telegram-token');
  const telegramChatIdsEl = section.querySelector('#cfg-telegram-chatids');
  telegramEnabledEl.value = config.channels?.telegram?.enabled ? 'true' : 'false';

  function syncTelegramFields() {
    const enabled = telegramEnabledEl.value === 'true';
    telegramTokenEl.disabled = !enabled;
    telegramChatIdsEl.disabled = !enabled;
  }
  telegramEnabledEl.addEventListener('change', syncTelegramFields);
  syncTelegramFields();

  // --- Helpers ---
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

  // --- Wire up a panel ---
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

    // Populate profile dropdown
    function renderProfiles() {
      const options = ['__new__', ...names];
      profileEl.innerHTML = options.map((name) => {
        if (name === '__new__') return '<option value="__new__">Create new profile...</option>';
        const info = providerMap[name];
        const st = info.connected === false ? 'offline' : 'online';
        return `<option value="${esc(name)}">${esc(name)} (${esc(info.provider)}, ${st})</option>`;
      }).join('');

      const firstConfigured = options.find((n) => n !== '__new__') || '__new__';
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

    // Test connection
    section.querySelector(`#${prefix}-test`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      if (!providerName) {
        statusEl.textContent = 'Set provider name first.';
        statusEl.style.color = 'var(--warning)';
        return;
      }
      statusEl.textContent = `Testing ${providerName}...`;
      statusEl.style.color = 'var(--text-muted)';
      try {
        const latest = await api.providersStatus();
        const found = latest.find((p) => p.name === providerName);
        if (!found) {
          statusEl.textContent = `'${providerName}' not in runtime (save first).`;
          statusEl.style.color = 'var(--warning)';
          return;
        }
        if (found.connected === false) {
          statusEl.textContent = `${providerName}: disconnected.`;
          statusEl.style.color = 'var(--error)';
        } else {
          const count = found.availableModels?.length || 0;
          statusEl.textContent = `${providerName}: connected (${count} model${count === 1 ? '' : 's'}).`;
          statusEl.style.color = 'var(--success)';
        }
      } catch (err) {
        statusEl.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`;
        statusEl.style.color = 'var(--error)';
      }
    });

    // Save handler
    section.querySelector(`#${prefix}-save`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      const model = modelEl.value.trim();
      const baseUrl = urlEl.value.trim();
      const providerType = isLocal ? 'ollama' : (typeEl?.value || 'openai');

      if (!providerName) {
        statusEl.textContent = 'Provider name is required.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      if (!model) {
        statusEl.textContent = 'Model is required.';
        statusEl.style.color = 'var(--error)';
        return;
      }

      const payload = {
        llmMode: isLocal ? 'ollama' : 'external',
        providerName,
        providerType,
        model,
        baseUrl: baseUrl || undefined,
        apiKey: keyEl?.value.trim() || undefined,
        setDefaultProvider: defaultEl.value === 'true',
        telegramEnabled: telegramEnabledEl.value === 'true',
        telegramBotToken: telegramTokenEl.value.trim() || undefined,
        telegramAllowedChatIds: parseChatIdsOrUndefined(telegramChatIdsEl.value),
        setupCompleted: true,
      };

      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';

      try {
        const result = await api.applyConfig(payload);
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
        if (result.success) await renderConfig(container);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
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

function createAuthPanel(config, authStatus, container) {
  const section = document.createElement('div');
  section.className = 'table-container';

  const mode = authStatus?.mode || config.channels?.web?.auth?.mode || 'bearer_required';
  const tokenConfigured = !!authStatus?.tokenConfigured;
  const tokenSource = authStatus?.tokenSource || config.channels?.web?.auth?.tokenSource || 'ephemeral';
  const ttl = authStatus?.sessionTtlMinutes ?? config.channels?.web?.auth?.sessionTtlMinutes ?? '';

  section.innerHTML = `
    <div class="table-header">
      <h3>Web Authentication</h3>
      <span class="cfg-header-note">Bearer token controls for dashboard and API access</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Auth Mode</label>
          <select id="auth-mode">
            <option value="bearer_required" ${mode === 'bearer_required' ? 'selected' : ''}>bearer_required</option>
            <option value="localhost_no_auth" ${mode === 'localhost_no_auth' ? 'selected' : ''}>localhost_no_auth</option>
            <option value="disabled" ${mode === 'disabled' ? 'selected' : ''}>disabled</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Token Source</label>
          <input id="auth-token-source" type="text" value="${esc(tokenSource)}" readonly>
        </div>
        <div class="cfg-field">
          <label>Session TTL Minutes (optional)</label>
          <input id="auth-ttl" type="number" min="1" placeholder="120" value="${esc(String(ttl))}">
        </div>
        <div class="cfg-field">
          <label>Current Token</label>
          <input id="auth-token-preview" type="text" readonly value="${tokenConfigured ? esc(authStatus?.tokenPreview || 'configured') : 'not configured'}">
        </div>
        <div class="cfg-field">
          <label>Set/New Token (optional)</label>
          <input id="auth-token-input-new" type="password" placeholder="Leave empty to keep existing token">
        </div>
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

  const setStatus = (text, color) => {
    statusEl.textContent = text;
    statusEl.style.color = color;
  };

  section.querySelector('#auth-save')?.addEventListener('click', async () => {
    const payload = {
      mode: modeEl.value,
      token: tokenInputEl.value.trim() || undefined,
      sessionTtlMinutes: ttlEl.value ? Number(ttlEl.value) : undefined,
    };
    setStatus('Saving auth settings...', 'var(--text-muted)');
    try {
      const result = await api.updateAuth(payload);
      setStatus(result.message, result.success ? 'var(--success)' : 'var(--warning)');
      if (result.status?.tokenPreview) {
        tokenPreviewEl.value = result.status.tokenPreview;
      }
      if (result.success) {
        tokenInputEl.value = '';
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'var(--error)');
    }
  });

  section.querySelector('#auth-rotate')?.addEventListener('click', async () => {
    setStatus('Rotating token...', 'var(--text-muted)');
    try {
      const result = await api.rotateAuthToken();
      if (result.token) {
        tokenPreviewEl.value = `${result.token.slice(0, 4)}...${result.token.slice(-4)}`;
      }
      setStatus(result.message || 'Token rotated.', result.success ? 'var(--success)' : 'var(--warning)');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'var(--error)');
    }
  });

  section.querySelector('#auth-reveal')?.addEventListener('click', async () => {
    setStatus('Revealing token...', 'var(--text-muted)');
    try {
      const result = await api.revealAuthToken();
      if (result.success && result.token) {
        tokenPreviewEl.value = result.token;
        setStatus('Token revealed in field above. Keep it private.', 'var(--warning)');
      } else {
        setStatus('No active token.', 'var(--warning)');
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'var(--error)');
    }
  });

  section.querySelector('#auth-revoke')?.addEventListener('click', async () => {
    setStatus('Disabling auth...', 'var(--text-muted)');
    try {
      const result = await api.revokeAuthToken();
      setStatus(result.message || 'Auth disabled.', result.success ? 'var(--warning)' : 'var(--error)');
      if (result.success) {
        await renderConfig(container);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'var(--error)');
    }
  });

  applyInputTooltips(section);
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
