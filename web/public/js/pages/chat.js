/**
 * Chat page — tier mode toggle or agent selector, message history, text input.
 * Shows LLM connection status and a thinking indicator while waiting.
 *
 * When only internal (tier-routed) agents exist, shows a unified
 * "Guardian Agent" with an Auto / Local / External mode toggle.
 * When user-configured agents exist, shows the classic agent dropdown.
 */

import { api } from '../api.js';
import { onSSE, offSSE } from '../app.js';
import { applyInputTooltips } from '../tooltip.js';

const chatHistoryByAgent = new Map();
const ACTIVE_AGENT_KEY = 'guardianagent_active_agent';
const TIER_MODE_KEY = 'guardianagent_tier_mode';
const WEB_USER_KEY = 'guardianagent_web_user';

export async function renderChat(container) {
  container.innerHTML = '<h2 class="page-title">Chat</h2><div class="loading">Loading...</div>';

  let agents = [];
  let providers = [];
  let quickActions = [];
  let routingMode = null;
  try {
    [agents, providers, quickActions, routingMode] = await Promise.all([
      api.agents().catch(() => []),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.quickActions().catch(() => []),
      api.routingMode().catch(() => null),
    ]);
  } catch {
    // Continue with empty lists
  }

  const chatAgents = agents.filter((a) => a.canChat !== false);
  const userAgents = chatAgents.filter((a) => !a.internal);
  const hasInternalOnly = userAgents.length === 0 && hasTierRoutingAgents(chatAgents);
  const webUserId = resolveWebUserId();

  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-container';

  // Provider status bar
  const providerBar = document.createElement('div');
  providerBar.style.cssText = 'display:flex;gap:0.75rem;margin-bottom:0.75rem;flex-wrap:wrap;';
  for (const p of providers) {
    const chip = document.createElement('span');
    const isConnected = p.connected !== false;
    const locality = p.locality === 'local' ? 'Local' : 'API';
    chip.className = `badge ${isConnected ? 'badge-idle' : 'badge-errored'}`;
    chip.style.cssText = 'padding:0.3rem 0.6rem;font-size:0.7rem;';
    chip.textContent = `${p.name}: ${p.model} (${locality}) ${isConnected ? 'Connected' : 'Disconnected'}`;
    providerBar.appendChild(chip);
  }
  if (providers.length === 0) {
    const chip = document.createElement('span');
    chip.className = 'badge badge-errored';
    chip.style.cssText = 'padding:0.3rem 0.6rem;font-size:0.7rem;';
    chip.textContent = 'No LLM providers configured';
    providerBar.appendChild(chip);
  }
  wrapper.appendChild(providerBar);

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'chat-toolbar';

  let select = null;
  let modeSelect = null;
  let activeAgentId = null;

  if (hasInternalOnly) {
    // Unified mode: mode toggle instead of agent dropdown
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Guardian Agent';
    modeLabel.style.cssText = 'font-size:0.8rem;color:var(--accent);font-weight:600;';

    const modeDiv = document.createElement('div');
    modeDiv.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';

    const modeTag = document.createElement('span');
    modeTag.style.cssText = 'font-size:0.7rem;color:var(--text-muted);';
    modeTag.textContent = 'Routing:';

    modeSelect = document.createElement('select');
    modeSelect.id = 'chat-mode-select';
    modeSelect.style.fontSize = '0.75rem';
    modeSelect.innerHTML = getRoutingModeOptions(chatAgents).map((option) => (
      `<option value="${esc(option.value)}">${esc(option.label)}</option>`
    )).join('');

    const currentMode = normalizeRoutingMode(
      routingMode?.tierMode ?? sessionStorage.getItem(TIER_MODE_KEY) ?? 'auto',
      chatAgents,
    );
    modeSelect.value = currentMode;
    sessionStorage.setItem(TIER_MODE_KEY, currentMode);

    modeSelect.addEventListener('change', async () => {
      const mode = modeSelect.value;
      sessionStorage.setItem(TIER_MODE_KEY, mode);
      try {
        await api.setRoutingMode(mode);
      } catch (err) {
        console.error('Failed to set routing mode', err);
      }
    });

    modeDiv.append(modeTag, modeSelect);
    toolbar.append(modeLabel, modeDiv);

    activeAgentId = '__guardian__';
  } else if (userAgents.length > 0) {
    // Classic mode
    const label = document.createElement('label');
    label.textContent = 'Agent:';
    label.style.fontSize = '0.8rem';
    label.style.color = 'var(--text-muted)';

    select = document.createElement('select');
    select.id = 'chat-agent-select';
    select.innerHTML = userAgents.map(a =>
      `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.id)})${a.provider ? ' - ' + esc(a.provider) : ''}</option>`
    ).join('');

    toolbar.append(label, select);
    activeAgentId = resolveInitialAgent(select, userAgents);
  } else {
    const noAgents = document.createElement('span');
    noAgents.style.cssText = 'font-size:0.8rem;color:var(--text-muted);';
    noAgents.textContent = 'No agents available';
    toolbar.appendChild(noAgents);
  }

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-secondary';
  resetBtn.textContent = 'New Conversation';
  resetBtn.style.padding = '0.45rem 0.7rem';
  resetBtn.style.fontSize = '0.75rem';

  toolbar.appendChild(resetBtn);
  wrapper.appendChild(toolbar);

  // Chat history
  const history = document.createElement('div');
  history.className = 'chat-history';
  history.id = 'chat-history';

  wrapper.appendChild(history);

  let quickActionSelect = null;
  let quickActionInput = null;
  let quickActionBtn = null;
  if (quickActions.length > 0) {
    const quickArea = document.createElement('div');
    quickArea.className = 'chat-quick-actions';
    quickArea.innerHTML = `
      <span class="quick-label">Quick actions:</span>
      <select id="quick-action-select">
        ${quickActions.map((action) => `<option value="${esc(action.id)}">${esc(action.label)}</option>`).join('')}
      </select>
      <input id="quick-action-input" type="text" placeholder="Add details for the selected quick action">
      <button class="btn btn-secondary" id="quick-action-run">Run</button>
    `;
    wrapper.appendChild(quickArea);
    quickActionSelect = quickArea.querySelector('#quick-action-select');
    quickActionInput = quickArea.querySelector('#quick-action-input');
    quickActionBtn = quickArea.querySelector('#quick-action-run');
  }

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a message...';
  input.id = 'chat-input';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-primary';
  sendBtn.textContent = 'Send';

  renderHistory(history, activeAgentId);

  if (select) {
    select.addEventListener('change', () => {
      const selected = select.value;
      if (selected) {
        sessionStorage.setItem(ACTIVE_AGENT_KEY, selected);
        activeAgentId = selected;
      }
      renderHistory(history, selected);
    });
  }

  resetBtn.addEventListener('click', async () => {
    const resetId = hasInternalOnly ? '__guardian__' : (select?.value || '');
    if (!resetId) return;

    resetBtn.disabled = true;
    const previousLabel = resetBtn.textContent;
    resetBtn.textContent = 'Resetting...';

    try {
      const apiAgentId = resetId === '__guardian__'
        ? (getRoutingModeAgentId(chatAgents, modeSelect?.value) || chatAgents[0]?.id || 'default')
        : resetId;
      await api.resetConversation(apiAgentId, webUserId, 'web');
      chatHistoryByAgent.delete(resetId);
      renderHistory(history, resetId);
    } catch {
      // Keep local history if reset failed.
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = previousLabel;
    }
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;

    const historyKey = hasInternalOnly ? '__guardian__' : (select?.value || '');
    if (!historyKey) return;

    const chatHistory = getHistory(historyKey);

    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    // Add user message
    chatHistory.push({ role: 'user', content: text });
    history.appendChild(createMessageEl('user', text));

    // Add thinking indicator
    const thinkingEl = createThinkingEl();
    history.appendChild(thinkingEl);
    history.scrollTop = history.scrollHeight;

    try {
      const agentId = hasInternalOnly
        ? getRoutingModeAgentId(chatAgents, modeSelect?.value)
        : (select?.value || undefined);
      const requestId = createClientRequestId();
      let cleanedUp = false;
      let finalised = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        offSSE('run.timeline', onRunTimeline);
        offSSE('chat.done', onDone);
        offSSE('chat.error', onError);
      };

      const finalizeSuccess = (data) => {
        if (finalised) return;
        finalised = true;
        cleanup();
        thinkingEl.remove();
        chatHistory.push({ role: 'agent', content: data.content || '' });
        history.appendChild(createMessageEl('agent', data.content || ''));
      };

      const finalizeError = (message) => {
        if (finalised) return;
        finalised = true;
        cleanup();
        thinkingEl.remove();
        const errorMsg = message || 'Failed to get response';
        chatHistory.push({ role: 'agent', content: `Error: ${errorMsg}` });
        history.appendChild(createMessageEl('error', `Error: ${errorMsg}`));
      };

      const onRunTimeline = (data) => {
        if (data?.summary?.runId !== requestId) return;
        updateThinkingEl(thinkingEl, data);
        history.scrollTop = history.scrollHeight;
      };

      const onDone = (data) => {
        if (data?.requestId !== requestId) return;
        finalizeSuccess(data);
      };

      const onError = (data) => {
        if (data?.requestId !== requestId) return;
        finalizeError(data.error || 'Failed to get response');
      };

      onSSE('run.timeline', onRunTimeline);
      onSSE('chat.done', onDone);
      onSSE('chat.error', onError);

      try {
        const response = await api.sendMessageStream(text, agentId, webUserId, 'web', undefined, requestId);
        if (response?.error) {
          finalizeError(response.error);
        } else if (response?.content) {
          finalizeSuccess(response);
        }
      } catch {
        cleanup();
        const response = await api.sendMessage(text, agentId, webUserId, 'web');
        thinkingEl.remove();
        chatHistory.push({ role: 'agent', content: response.content });
        history.appendChild(createMessageEl('agent', response.content));
      }
    } catch (err) {
      thinkingEl.remove();
      const errorMsg = err.message === 'AUTH_FAILED'
        ? 'Authentication failed'
        : err.message || 'Failed to get response';
      chatHistory.push({ role: 'agent', content: `Error: ${errorMsg}` });
      history.appendChild(createMessageEl('error', `Error: ${errorMsg}`));
    }

    history.scrollTop = history.scrollHeight;
    input.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    input.focus();
  };

  const runQuickAction = async () => {
    if (!quickActionSelect || !quickActionInput || !quickActionBtn) return;
    const details = quickActionInput.value.trim();
    if (!details) return;
    const actionId = quickActionSelect.value;

    const historyKey = hasInternalOnly ? '__guardian__' : (select?.value || '');
    if (!historyKey) return;

    // For quick actions, we need an actual agent ID for the API
    const agentId = hasInternalOnly
      ? (getRoutingModeAgentId(chatAgents, modeSelect?.value) || chatAgents[0]?.id || 'default')
      : (select?.value || '');

    const chatHistory = getHistory(historyKey);
    const localPrompt = `[Quick:${actionId}] ${details}`;
    chatHistory.push({ role: 'user', content: localPrompt });
    history.appendChild(createMessageEl('user', localPrompt));
    history.scrollTop = history.scrollHeight;

    quickActionInput.value = '';
    quickActionInput.disabled = true;
    quickActionBtn.disabled = true;
    quickActionBtn.textContent = 'Running...';

    const thinkingEl = createThinkingEl();
    history.appendChild(thinkingEl);
    history.scrollTop = history.scrollHeight;

    try {
      const response = await api.runQuickAction({
        actionId,
        details,
        agentId,
        userId: webUserId,
        channel: 'web',
      });
      thinkingEl.remove();
      chatHistory.push({ role: 'agent', content: response.content });
      history.appendChild(createMessageEl('agent', response.content));
    } catch (err) {
      thinkingEl.remove();
      const errorMsg = err.message || 'Quick action failed';
      chatHistory.push({ role: 'agent', content: `Error: ${errorMsg}` });
      history.appendChild(createMessageEl('error', `Error: ${errorMsg}`));
    }

    history.scrollTop = history.scrollHeight;
    quickActionInput.disabled = false;
    quickActionBtn.disabled = false;
    quickActionBtn.textContent = 'Run';
    quickActionInput.focus();
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  quickActionBtn?.addEventListener('click', runQuickAction);
  quickActionInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runQuickAction();
  });

  inputArea.append(input, sendBtn);
  wrapper.appendChild(inputArea);

  container.appendChild(wrapper);
  applyInputTooltips(container);
  input.focus();
}

function resolveInitialAgent(select, chatAgents) {
  const remembered = sessionStorage.getItem(ACTIVE_AGENT_KEY);
  const hasRemembered = remembered && chatAgents.some(a => a.id === remembered);
  const selected = hasRemembered ? remembered : (chatAgents[0]?.id || '');
  if (selected) {
    select.value = selected;
    sessionStorage.setItem(ACTIVE_AGENT_KEY, selected);
  }
  return selected;
}

function resolveWebUserId() {
  const current = sessionStorage.getItem(WEB_USER_KEY);
  const resolved = (current || 'web-user').trim();
  sessionStorage.setItem(WEB_USER_KEY, resolved);
  return resolved;
}

function getHistory(agentId) {
  if (!chatHistoryByAgent.has(agentId)) {
    chatHistoryByAgent.set(agentId, []);
  }
  return chatHistoryByAgent.get(agentId);
}

function renderHistory(historyEl, agentId) {
  historyEl.innerHTML = '';
  if (!agentId) return;
  const chatHistory = getHistory(agentId);
  for (const msg of chatHistory) {
    historyEl.appendChild(createMessageEl(msg.role, msg.content));
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

function createClientRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getRoutingLaneAgents(agents) {
  const chatAgents = Array.isArray(agents) ? agents.filter((agent) => agent?.canChat !== false) : [];
  return {
    local: chatAgents.find((agent) => agent.routingRole === 'local') || null,
    external: chatAgents.find((agent) => agent.routingRole === 'external') || null,
  };
}

function hasTierRoutingAgents(agents) {
  const { local, external } = getRoutingLaneAgents(agents);
  return !!(local || external);
}

function getRoutingModeOptions(agents) {
  const { local, external } = getRoutingLaneAgents(agents);
  return [
    { value: 'auto', label: 'Auto' },
    ...(local ? [{ value: 'local-only', label: 'Local' }] : []),
    ...(external ? [{ value: 'external-only', label: 'External' }] : []),
  ];
}

function normalizeRoutingMode(mode, agents) {
  const availableModes = new Set(getRoutingModeOptions(agents).map((option) => option.value));
  return availableModes.has(mode) ? mode : 'auto';
}

function getRoutingModeAgentId(agents, mode) {
  const { local, external } = getRoutingLaneAgents(agents);
  if (mode === 'local-only') return local?.id;
  if (mode === 'external-only') return external?.id;
  return undefined;
}

function createThinkingEl() {
  const el = document.createElement('div');
  el.className = 'chat-message agent is-thinking';
  el.innerHTML = `
    <div class="msg-header">Agent</div>
    <div class="msg-body">
      <div class="chat-thinking">
        <span class="chat-spinner" aria-hidden="true"></span>
        <span class="chat-thinking__label">Starting…</span>
      </div>
      <div class="chat-live-activity" hidden></div>
    </div>
  `;
  return el;
}

function updateThinkingEl(el, run) {
  if (!el || !run?.summary) return;
  const labelEl = el.querySelector('.chat-thinking__label');
  const activityEl = el.querySelector('.chat-live-activity');
  if (!labelEl || !activityEl) return;

  const summary = summarizeTimelineRun(run);
  labelEl.textContent = summary.label;
  if (summary.items.length === 0) {
    activityEl.hidden = true;
    activityEl.innerHTML = '';
    return;
  }

  activityEl.hidden = false;
  activityEl.innerHTML = summary.items.map((item) => `
    <div class="chat-live-activity__item">
      <div class="chat-live-activity__title">${esc(item.title)}</div>
      ${item.detail ? `<div class="chat-live-activity__detail">${esc(item.detail)}</div>` : ''}
    </div>
  `).join('');
}

function summarizeTimelineRun(run) {
  const items = Array.isArray(run?.items) ? run.items : [];
  const recentItems = items
    .filter(isMeaningfulLiveItem)
    .slice(-2)
    .map((item) => ({
    title: String(item?.title || '').trim(),
    detail: String(item?.detail || '').trim(),
    }))
    .filter((item) => item.title);
  const latestItem = recentItems[recentItems.length - 1];
  if (latestItem) {
    return {
      label: latestItem.title,
      items: recentItems,
    };
  }
  return {
    label: humanizeTimelineStatus(String(run?.summary?.status || '')),
    items: [],
  };
}

function humanizeTimelineStatus(status) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Working…';
    case 'awaiting_approval':
      return 'Waiting for approval';
    case 'verification_pending':
      return 'Verification pending';
    case 'blocked':
      return 'Blocked';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    default:
      return 'Working…';
  }
}

function isMeaningfulLiveItem(item) {
  const type = String(item?.type || '').trim();
  return type !== 'run_queued'
    && type !== 'run_started'
    && type !== 'run_completed';
}

function createMessageEl(role, content) {
  const msg = document.createElement('div');
  const cssClass = role === 'error' ? 'agent' : role;
  msg.className = `chat-message ${cssClass}`;
  const label = role === 'user' ? 'You' : 'Agent';
  msg.innerHTML = `
    <div class="msg-header">${label}</div>
    <div class="msg-body" ${role === 'error' ? 'style="color:var(--error);"' : ''}>${esc(content)}</div>
  `;
  return msg;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
