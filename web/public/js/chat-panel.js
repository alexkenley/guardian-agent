/**
 * Persistent Chat Panel — agent selector, message history, text input.
 * Integrated into the right-hand sidebar.
 */

import { api } from './api.js';
import { applyInputTooltips } from './tooltip.js';

const chatHistoryByAgent = new Map();
const ACTIVE_AGENT_KEY = 'guardianagent_active_agent';
const WEB_USER_KEY = 'guardianagent_web_user';
let currentChatContext = 'dashboard';

export async function initChatPanel(container) {
  container.innerHTML = '<div class="loading">Loading Chat...</div>';

  let agents = [];
  try {
    agents = await api.agents().catch(() => []);
  } catch {
    // Continue with empty list
  }

  const chatAgents = agents.filter((a) => a.canChat !== false);
  const webUserId = resolveWebUserId();

  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-container';
  wrapper.style.height = '100%';
  wrapper.style.padding = '1rem';

  // Header
  const header = document.createElement('div');
  header.style.marginBottom = '1rem';
  header.innerHTML = '<h3 style="font-size:0.9rem;color:var(--accent);">Assistant</h3>';
  wrapper.appendChild(header);

  // Toolbar with agent selector
  const toolbar = document.createElement('div');
  toolbar.className = 'chat-toolbar';
  toolbar.style.flexDirection = 'column';
  toolbar.style.alignItems = 'stretch';
  toolbar.style.gap = '0.5rem';

  const select = document.createElement('select');
  select.id = 'chat-agent-select';
  select.style.width = '100%';
  if (chatAgents.length === 0) {
    select.innerHTML = '<option value="">No agents available</option>';
  } else {
    select.innerHTML = chatAgents.map(a =>
      `<option value="${esc(a.id)}">${esc(a.name)}</option>`
    ).join('');
  }

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-secondary';
  resetBtn.textContent = 'Reset Chat';
  resetBtn.style.fontSize = '0.7rem';
  resetBtn.style.padding = '0.3rem 0.5rem';

  toolbar.append(select, resetBtn);
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

  const initialAgent = resolveInitialAgent(select, chatAgents);
  renderHistory(history, initialAgent);

  select.addEventListener('change', () => {
    const selected = select.value;
    if (selected) {
      sessionStorage.setItem(ACTIVE_AGENT_KEY, selected);
    }
    renderHistory(history, selected);
  });

  resetBtn.addEventListener('click', async () => {
    const agentId = select.value;
    if (!agentId) return;
    try {
      await api.resetConversation(agentId, webUserId, 'web');
      chatHistoryByAgent.delete(agentId);
      renderHistory(history, agentId);
    } catch (err) {
      console.error('Reset failed', err);
    }
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;

    const agentId = select.value;
    if (!agentId) return;

    const chatHistory = getHistory(agentId);

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
      // Prepend context to the message so the agent knows what the user is looking at
      const contextPrefix = `[Context: User is currently viewing the ${currentChatContext} panel] `;
      const response = await api.sendMessage(contextPrefix + text, agentId, webUserId, 'web');
      
      thinkingEl.remove();
      chatHistory.push({ role: 'agent', content: response.content });
      history.appendChild(createMessageEl('agent', response.content));
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
