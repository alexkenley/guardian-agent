/**
 * Persistent Chat Panel — tier mode toggle, message history, text input.
 * Integrated into the right-hand sidebar.
 *
 * When only internal (tier-routed) agents exist, shows a unified
 * "Guardian Agent" with an Auto / Local / External mode toggle.
 * When user-configured agents exist, shows the classic agent dropdown.
 */

import { api } from './api.js';
import { onSSE, offSSE } from './app.js';
import { applyInputTooltips } from './tooltip.js';

const chatHistoryByAgent = new Map();
const ACTIVE_AGENT_KEY = 'guardianagent_active_agent';
const TIER_MODE_KEY = 'guardianagent_tier_mode';
const WEB_USER_KEY = 'guardianagent_web_user';
let currentChatContext = 'dashboard';

export async function initChatPanel(container) {
  container.innerHTML = '<div class="loading">Loading Chat...</div>';

  let agents = [];
  let routingMode = null;
  try {
    [agents, routingMode] = await Promise.all([
      api.agents().catch(() => []),
      api.routingMode().catch(() => null),
    ]);
  } catch {
    // Continue with empty
  }

  const chatAgents = agents.filter((a) => a.canChat !== false);
  const userAgents = chatAgents.filter((a) => !a.internal);
  const hasInternalOnly = userAgents.length === 0 && chatAgents.length > 0;
  const webUserId = resolveWebUserId();

  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-container';
  wrapper.style.height = '100%';
  wrapper.style.padding = '1rem';

  // Header
  const header = document.createElement('div');
  header.className = 'chat-panel-header';
  header.style.marginBottom = '1rem';
  header.innerHTML = '<h3 style="font-size:0.9rem;color:var(--accent);font-family:var(--font-display);">&#x1F6E1; Guardian Assistant</h3>';
  wrapper.appendChild(header);

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'chat-toolbar';
  toolbar.style.flexDirection = 'column';
  toolbar.style.alignItems = 'stretch';
  toolbar.style.gap = '0.5rem';

  // Agent selector OR mode toggle
  let select = null;
  let modeSelect = null;
  let activeAgentId = null;

  if (hasInternalOnly) {
    // Unified mode: show tier mode toggle instead of agent dropdown
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';

    const modeLabel = document.createElement('span');
    modeLabel.style.cssText = 'font-size:0.7rem;color:var(--text-muted);';
    modeLabel.textContent = 'Mode:';

    modeSelect = document.createElement('select');
    modeSelect.id = 'chat-mode-select';
    modeSelect.style.cssText = 'flex:1;font-size:0.7rem;';
    modeSelect.innerHTML = `
      <option value="auto">Auto (recommended)</option>
      <option value="local-only">Local Only</option>
      <option value="external-only">External Only</option>
    `;

    const currentMode = routingMode?.tierMode ?? sessionStorage.getItem(TIER_MODE_KEY) ?? 'auto';
    modeSelect.value = currentMode;

    modeSelect.addEventListener('change', async () => {
      const mode = modeSelect.value;
      sessionStorage.setItem(TIER_MODE_KEY, mode);
      try {
        await api.setRoutingMode(mode);
      } catch (err) {
        console.error('Failed to set routing mode', err);
      }
    });

    modeRow.append(modeLabel, modeSelect);
    toolbar.appendChild(modeRow);

    // Use a single unified history key
    activeAgentId = '__guardian__';
  } else if (userAgents.length > 0) {
    // Classic mode: user-visible agent dropdown
    select = document.createElement('select');
    select.id = 'chat-agent-select';
    select.style.width = '100%';
    select.innerHTML = userAgents.map(a =>
      `<option value="${esc(a.id)}">${esc(a.name)}</option>`
    ).join('');
    toolbar.appendChild(select);
    activeAgentId = resolveInitialAgent(select, userAgents);
  } else {
    // No agents at all
    const noAgents = document.createElement('div');
    noAgents.style.cssText = 'font-size:0.7rem;color:var(--text-muted);';
    noAgents.textContent = 'No agents available';
    toolbar.appendChild(noAgents);
  }

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-secondary';
  resetBtn.textContent = 'Reset Chat';
  resetBtn.style.fontSize = '0.7rem';
  resetBtn.style.padding = '0.3rem 0.5rem';

  toolbar.appendChild(resetBtn);
  wrapper.appendChild(toolbar);

  // Chat history
  const history = document.createElement('div');
  history.className = 'chat-history';
  history.id = 'chat-history';
  history.style.fontSize = '0.75rem';

  wrapper.appendChild(history);

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Ask the agent...';
  input.id = 'chat-input';
  input.style.fontSize = '0.75rem';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-primary';
  sendBtn.textContent = 'Send';
  sendBtn.style.padding = '0.5rem 0.8rem';

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
    try {
      // For unified mode, reset the default agent's conversation
      const apiAgentId = resetId === '__guardian__' ? (chatAgents[0]?.id || 'default') : resetId;
      await api.resetConversation(apiAgentId, webUserId, 'web');
      chatHistoryByAgent.delete(resetId);
      renderHistory(history, resetId);
    } catch (err) {
      console.error('Reset failed', err);
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

    // Add user message
    chatHistory.push({ role: 'user', content: text });
    history.appendChild(createMessageEl('user', text));

    // Add thinking indicator
    const thinkingEl = createThinkingEl();
    history.appendChild(thinkingEl);
    history.scrollTop = history.scrollHeight;

    try {
      // In unified mode, don't send agentId — let tier routing decide
      const contextPrefix = `[Context: User is currently viewing the ${currentChatContext} panel] `;
      const agentId = hasInternalOnly ? undefined : (select?.value || undefined);

      // Try streaming first, fall back to regular send
      if (agentId) {
        try {
          const streamResult = await api.sendMessageStream(contextPrefix + text, agentId, webUserId, 'web');

          // If streaming worked, set up live rendering via SSE
          if (streamResult?.requestId) {
            const requestId = streamResult.requestId;
            let liveContent = '';
            let liveEl = null;

            const onToken = (data) => {
              if (data.requestId !== requestId) return;
              if (!liveEl) {
                thinkingEl.remove();
                liveEl = createMessageEl('agent', '');
                liveEl.classList.add('streaming');
                history.appendChild(liveEl);
              }
              liveContent += data.content || '';
              const contentEl = liveEl.querySelector('.chat-msg-content') || liveEl;
              contentEl.textContent = liveContent;
              history.scrollTop = history.scrollHeight;
            };

            const onToolCall = (data) => {
              if (data.requestId !== requestId) return;
              if (!liveEl) {
                thinkingEl.remove();
                liveEl = createMessageEl('agent', '');
                liveEl.classList.add('streaming');
                history.appendChild(liveEl);
              }
              const indicator = document.createElement('div');
              indicator.className = 'tool-indicator';
              indicator.textContent = `⚙ ${data.toolName || 'tool'}`;
              liveEl.appendChild(indicator);
            };

            const onDone = (data) => {
              if (data.requestId !== requestId) return;
              cleanup();
              if (liveEl) {
                liveEl.classList.remove('streaming');
                const contentEl = liveEl.querySelector('.chat-msg-content') || liveEl;
                contentEl.textContent = data.content || liveContent;
              } else {
                thinkingEl.remove();
                history.appendChild(createMessageEl('agent', data.content || ''));
              }
              chatHistory.push({ role: 'agent', content: data.content || liveContent });
            };

            const onError = (data) => {
              if (data.requestId !== requestId) return;
              cleanup();
              if (liveEl) liveEl.remove();
              thinkingEl.remove();
              history.appendChild(createMessageEl('error', data.error || 'Stream error'));
            };

            const cleanup = () => {
              offSSE('chat.token', onToken);
              offSSE('chat.tool_call', onToolCall);
              offSSE('chat.done', onDone);
              offSSE('chat.error', onError);
            };

            onSSE('chat.token', onToken);
            onSSE('chat.tool_call', onToolCall);
            onSSE('chat.done', onDone);
            onSSE('chat.error', onError);

            // If response already has content (non-streaming fallback), use it
            if (streamResult.content) {
              cleanup();
              thinkingEl.remove();
              chatHistory.push({ role: 'agent', content: streamResult.content });
              history.appendChild(createMessageEl('agent', streamResult.content));
            }
          } else {
            // No requestId — treat as regular response
            thinkingEl.remove();
            chatHistory.push({ role: 'agent', content: streamResult.content || '' });
            history.appendChild(createMessageEl('agent', streamResult.content || ''));
          }
        } catch {
          // Streaming failed — fall back to regular send
          const response = await api.sendMessage(contextPrefix + text, agentId, webUserId, 'web');
          thinkingEl.remove();
          chatHistory.push({ role: 'agent', content: response.content });
          history.appendChild(createMessageEl('agent', response.content));
        }
      } else {
        const response = await api.sendMessage(contextPrefix + text, agentId, webUserId, 'web');
        thinkingEl.remove();
        chatHistory.push({ role: 'agent', content: response.content });
        history.appendChild(createMessageEl('agent', response.content));
      }
    } catch (err) {
      thinkingEl.remove();
      const errorMsg = err.message === 'AUTH_FAILED' ? 'Auth failed' : (err.message || 'Error');
      history.appendChild(createMessageEl('error', errorMsg));
    }

    history.scrollTop = history.scrollHeight;
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  inputArea.append(input, sendBtn);
  wrapper.appendChild(inputArea);

  container.appendChild(wrapper);
  input.focus();
}

export function setChatContext(context) {
  currentChatContext = context;
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

function createThinkingEl() {
  const el = document.createElement('div');
  el.className = 'chat-message agent';
  el.innerHTML = '<div class="msg-body" style="font-style:italic;color:var(--text-muted)">Thinking...</div>';
  return el;
}

function createMessageEl(role, content) {
  const msg = document.createElement('div');
  msg.className = `chat-message ${role === 'error' ? 'agent' : role}`;
  msg.style.marginBottom = '0.5rem';
  msg.innerHTML = `<div class="msg-body" style="padding:0.5rem;font-size:0.75rem;${role === 'error' ? 'color:var(--error);' : ''}">${esc(content)}</div>`;
  return msg;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
