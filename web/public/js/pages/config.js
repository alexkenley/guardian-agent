/**
 * Config page — editable provider settings + read-only display.
 */

import { api } from '../api.js';

export async function renderConfig(container) {
  container.innerHTML = '<h2 class="page-title">Configuration</h2><div class="loading">Loading...</div>';

  try {
    const [config, providers] = await Promise.all([
      api.config(),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
    ]);

    container.innerHTML = '<h2 class="page-title">Configuration</h2>';

    // Editable LLM Settings
    container.appendChild(createLLMEditor(config, providers));

    // Read-only sections
    container.appendChild(createSection('Channels', config.channels));
    container.appendChild(createSection('Guardian', config.guardian));
    container.appendChild(createSection('Runtime', config.runtime));
    container.appendChild(createSection('Assistant', config.assistant));

  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Configuration</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function createLLMEditor(config, providers) {
  const section = document.createElement('div');
  section.className = 'config-section';

  const header = document.createElement('div');
  header.className = 'config-section-header';
  header.innerHTML = '<span>LLM Providers</span>';

  const body = document.createElement('div');
  body.className = 'config-section-body';

  // Default provider selector
  const providerNames = Object.keys(config.llm);

  let html = `
    <div style="margin-bottom:1.5rem;">
      <label style="display:block;font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.3rem;">Default Provider</label>
      <select id="cfg-default-provider" style="padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;width:200px;">
        ${providerNames.map(n => `<option value="${esc(n)}" ${n === config.defaultProvider ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
    </div>
  `;

  // Per-provider settings
  for (const [name, cfg] of Object.entries(config.llm)) {
    const provider = providers.find(p => p.name === name);
    const connected = provider?.connected !== false;
    const statusBadge = provider
      ? `<span class="badge ${connected ? 'badge-idle' : 'badge-errored'}" style="margin-left:0.5rem;">${connected ? 'Connected' : 'Disconnected'}</span>`
      : '';
    const availableModels = provider?.availableModels || [];

    html += `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;margin-bottom:1rem;">
        <div style="font-size:0.85rem;font-weight:600;margin-bottom:0.75rem;">
          ${esc(name)} <span style="color:var(--text-muted);font-weight:400;">(${esc(cfg.provider)})</span>${statusBadge}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
          <div>
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">Model</label>
            ${availableModels.length > 0
              ? `<select id="cfg-model-${esc(name)}" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
                  ${availableModels.map(m => `<option value="${esc(m)}" ${m === cfg.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}
                  ${!availableModels.includes(cfg.model) ? `<option value="${esc(cfg.model)}" selected>${esc(cfg.model)}</option>` : ''}
                </select>`
              : `<input type="text" id="cfg-model-${esc(name)}" value="${esc(cfg.model)}" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">`
            }
          </div>
          <div>
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">Base URL</label>
            <input type="text" id="cfg-url-${esc(name)}" value="${esc(cfg.baseUrl || '')}" placeholder="${cfg.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'Default'}" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
          </div>
          ${cfg.provider !== 'ollama' ? `
          <div style="grid-column:span 2;">
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">API Key</label>
            <input type="password" id="cfg-key-${esc(name)}" value="" placeholder="Enter to change (leave blank to keep current)" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
          </div>` : ''}
        </div>
      </div>
    `;
  }

  // Test connection section
  html += `
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;margin-bottom:1rem;">
      <div style="font-size:0.85rem;font-weight:600;margin-bottom:0.75rem;">Test Connection</div>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
        ${providerNames.map(n => `<button class="btn btn-secondary test-api-btn" data-provider="${esc(n)}" style="font-size:0.75rem;padding:0.3rem 0.7rem;">${esc(n)}</button>`).join('')}
      </div>
      <div id="test-result" style="margin-top:0.75rem;font-size:0.8rem;color:var(--text-muted);display:none;"></div>
    </div>
  `;

  // Add new provider section
  html += `
    <details style="margin-bottom:1rem;">
      <summary style="cursor:pointer;font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.5rem;">Add New Provider</summary>
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;margin-top:0.5rem;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
          <div>
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">Name</label>
            <input type="text" id="cfg-new-name" placeholder="e.g. claude" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
          </div>
          <div>
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">Type</label>
            <select id="cfg-new-type" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
              <option value="ollama">Ollama (Local)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">Model</label>
            <input type="text" id="cfg-new-model" placeholder="e.g. claude-sonnet-4-20250514" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
          </div>
          <div>
            <label style="display:block;font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:0.2rem;">API Key</label>
            <input type="password" id="cfg-new-key" placeholder="Required for cloud APIs" style="width:100%;padding:0.4rem;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:0.8rem;">
          </div>
        </div>
      </div>
    </details>
  `;

  html += `
    <div style="display:flex;gap:0.5rem;align-items:center;">
      <button class="btn btn-primary" id="cfg-save">Save Changes</button>
      <span id="cfg-status" style="font-size:0.8rem;color:var(--text-muted);"></span>
    </div>
  `;

  body.innerHTML = html;
  section.append(header, body);

  // Save handler
  setTimeout(() => {
    const saveBtn = document.getElementById('cfg-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const updates = { llm: {}, defaultProvider: undefined };
        const statusEl = document.getElementById('cfg-status');

        // Default provider
        const dpSelect = document.getElementById('cfg-default-provider');
        if (dpSelect) updates.defaultProvider = dpSelect.value;

        // Existing provider updates
        for (const name of providerNames) {
          const modelEl = document.getElementById(`cfg-model-${name}`);
          const urlEl = document.getElementById(`cfg-url-${name}`);
          const keyEl = document.getElementById(`cfg-key-${name}`);

          const providerUpdate = {};
          if (modelEl) providerUpdate.model = modelEl.value;
          if (urlEl && urlEl.value) providerUpdate.baseUrl = urlEl.value;
          if (keyEl && keyEl.value) providerUpdate.apiKey = keyEl.value;

          if (Object.keys(providerUpdate).length > 0) {
            updates.llm[name] = providerUpdate;
          }
        }

        // New provider
        const newName = document.getElementById('cfg-new-name')?.value?.trim();
        const newType = document.getElementById('cfg-new-type')?.value;
        const newModel = document.getElementById('cfg-new-model')?.value?.trim();
        const newKey = document.getElementById('cfg-new-key')?.value?.trim();

        if (newName && newType && newModel) {
          updates.llm[newName] = {
            provider: newType,
            model: newModel,
          };
          if (newKey) updates.llm[newName].apiKey = newKey;
        }

        if (Object.keys(updates.llm).length === 0) delete updates.llm;

        try {
          statusEl.textContent = 'Saving...';
          statusEl.style.color = 'var(--text-muted)';
          const result = await api.updateConfig(updates);
          statusEl.textContent = result.message;
          statusEl.style.color = 'var(--warning)';
        } catch (err) {
          statusEl.textContent = 'Error: ' + err.message;
          statusEl.style.color = 'var(--error)';
        }
      });
    }

    // Test connection handlers
    document.querySelectorAll('.test-api-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.provider;
        const resultEl = document.getElementById('test-result');
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--text-muted)';
        resultEl.innerHTML = `Testing <strong>${esc(name)}</strong>...`;

        // Disable all test buttons while testing
        document.querySelectorAll('.test-api-btn').forEach(b => b.disabled = true);

        try {
          const providers = await api.providersStatus();
          const provider = providers.find(p => p.name === name);

          if (!provider) {
            resultEl.style.color = 'var(--error)';
            resultEl.innerHTML = `<strong>${esc(name)}</strong>: Provider not found in runtime.`;
          } else if (provider.connected) {
            const modelCount = provider.availableModels?.length || 0;
            resultEl.style.color = 'var(--success, #4ade80)';
            resultEl.innerHTML = `<strong>${esc(name)}</strong>: Connected &#10003; &mdash; ${esc(provider.model)} (${modelCount} model${modelCount !== 1 ? 's' : ''} available)`;
          } else {
            resultEl.style.color = 'var(--error)';
            resultEl.innerHTML = `<strong>${esc(name)}</strong>: Disconnected &#10007; &mdash; Could not reach provider.`;
          }
        } catch (err) {
          resultEl.style.color = 'var(--error)';
          resultEl.innerHTML = `<strong>${esc(name)}</strong>: Error &mdash; ${esc(err.message)}`;
        }

        document.querySelectorAll('.test-api-btn').forEach(b => b.disabled = false);
      });
    });
  }, 0);

  return section;
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

  let collapsed = false;
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
