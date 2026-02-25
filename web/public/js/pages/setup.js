/**
 * Setup Wizard page.
 */

import { api } from '../api.js';

export async function renderSetup(container) {
  container.innerHTML = '<h2 class="page-title">Setup Wizard</h2><div class="loading">Loading...</div>';

  try {
    const [status, providers] = await Promise.all([
      api.setupStatus().catch(() => null),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
    ]);

    container.innerHTML = '<h2 class="page-title">Setup Wizard</h2>';

    if (status) {
      const statusCard = document.createElement('div');
      statusCard.className = 'table-container';
      statusCard.innerHTML = `
        <div class="table-header"><h3>Current Setup Status</h3></div>
        <div class="setup-status-grid">
          ${status.steps.map((step) => `
            <div class="setup-step ${step.status}">
              <div class="setup-step-title">${esc(step.title)}</div>
              <div class="setup-step-badge">${esc(step.status.toUpperCase())}</div>
              <div class="setup-step-detail">${esc(step.detail)}</div>
            </div>
          `).join('')}
        </div>
      `;
      container.appendChild(statusCard);
    }

    const configuredProviders = providers.map((p) =>
      `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.type)})</option>`,
    ).join('');

    const form = document.createElement('div');
    form.className = 'table-container';
    form.innerHTML = `
      <div class="table-header"><h3>Apply Setup</h3></div>
      <div class="setup-form">
        <div class="setup-row">
          <label>LLM Mode</label>
          <select id="setup-llm-mode">
            <option value="ollama">Local Ollama</option>
            <option value="external">External API (OpenAI / Anthropic)</option>
          </select>
        </div>

        <div class="setup-row">
          <label>Provider Name</label>
          <input id="setup-provider-name" type="text" value="${providers[0]?.name || 'ollama'}" placeholder="ollama">
        </div>

        <div class="setup-row">
          <label>Provider Type</label>
          <select id="setup-provider-type">
            <option value="ollama">ollama</option>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>

        <div class="setup-row">
          <label>Model</label>
          <input id="setup-model" type="text" value="${providers[0]?.model || 'llama3.2'}" placeholder="llama3.2">
        </div>

        <div class="setup-row">
          <label>Base URL</label>
          <input id="setup-base-url" type="text" value="${providers[0]?.baseUrl || ''}" placeholder="http://127.0.0.1:11434">
        </div>

        <div class="setup-row">
          <label>API Key</label>
          <input id="setup-api-key" type="password" placeholder="Required for external providers">
        </div>

        <div class="setup-row">
          <label>Set As Default</label>
          <select id="setup-default">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>

        <div class="setup-divider"></div>

        <div class="setup-row">
          <label>Enable Telegram</label>
          <select id="setup-telegram-enabled">
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>

        <div class="setup-row">
          <label>Telegram Bot Token</label>
          <input id="setup-telegram-token" type="password" placeholder="123456:ABCDEF...">
        </div>

        <div class="setup-row">
          <label>Allowed Chat IDs</label>
          <input id="setup-telegram-chatids" type="text" placeholder="12345,67890">
        </div>

        <div class="setup-row">
          <label>Complete Setup</label>
          <select id="setup-completed">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>

        <div class="setup-actions">
          <button class="btn btn-primary" id="setup-apply">Apply Setup</button>
          <span id="setup-status" class="setup-status-text"></span>
        </div>
      </div>
    `;
    container.appendChild(form);

    const modeEl = form.querySelector('#setup-llm-mode');
    const providerTypeEl = form.querySelector('#setup-provider-type');
    const apiKeyEl = form.querySelector('#setup-api-key');

    function syncMode() {
      const mode = modeEl.value;
      providerTypeEl.value = mode === 'ollama' ? 'ollama' : (providerTypeEl.value === 'ollama' ? 'openai' : providerTypeEl.value);
      apiKeyEl.disabled = mode === 'ollama';
    }

    modeEl.addEventListener('change', syncMode);
    syncMode();

    form.querySelector('#setup-apply')?.addEventListener('click', async () => {
      const statusEl = form.querySelector('#setup-status');
      statusEl.textContent = 'Applying...';
      statusEl.style.color = 'var(--text-muted)';

      const mode = modeEl.value;
      const payload = {
        llmMode: mode,
        providerName: form.querySelector('#setup-provider-name').value.trim(),
        providerType: providerTypeEl.value,
        model: form.querySelector('#setup-model').value.trim(),
        baseUrl: form.querySelector('#setup-base-url').value.trim() || undefined,
        apiKey: form.querySelector('#setup-api-key').value.trim() || undefined,
        setDefaultProvider: form.querySelector('#setup-default').value === 'true',
        telegramEnabled: form.querySelector('#setup-telegram-enabled').value === 'true',
        telegramBotToken: form.querySelector('#setup-telegram-token').value.trim() || undefined,
        telegramAllowedChatIds: parseChatIds(form.querySelector('#setup-telegram-chatids').value),
        setupCompleted: form.querySelector('#setup-completed').value === 'true',
      };

      if (!payload.providerName || !payload.providerType || !payload.model) {
        statusEl.textContent = 'Provider name, type, and model are required.';
        statusEl.style.color = 'var(--error)';
        return;
      }

      try {
        const result = await api.applySetup(payload);
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      } catch (err) {
        statusEl.textContent = err.message || 'Failed to apply setup.';
        statusEl.style.color = 'var(--error)';
      }
    });

    // Existing provider quick-fill
    if (providers.length > 0) {
      const existing = document.createElement('div');
      existing.className = 'table-container';
      existing.innerHTML = `
        <div class="table-header"><h3>Detected Providers</h3></div>
        <div class="setup-form">
          <div class="setup-row">
            <label>Use Existing</label>
            <select id="setup-existing-provider">
              <option value="">Select...</option>
              ${configuredProviders}
            </select>
          </div>
        </div>
      `;
      container.appendChild(existing);
      existing.querySelector('#setup-existing-provider')?.addEventListener('change', (e) => {
        const name = e.target.value;
        const provider = providers.find((p) => p.name === name);
        if (!provider) return;
        form.querySelector('#setup-provider-name').value = provider.name;
        form.querySelector('#setup-provider-type').value = provider.type;
        form.querySelector('#setup-model').value = provider.model;
        form.querySelector('#setup-base-url').value = provider.baseUrl || '';
        form.querySelector('#setup-llm-mode').value = provider.type === 'ollama' ? 'ollama' : 'external';
        syncMode();
      });
    }
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Setup Wizard</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function parseChatIds(input) {
  if (!input.trim()) return [];
  return input
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id));
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
