/**
 * Persistent Chat Panel — tier mode toggle, message history, text input.
 * Integrated into the right-hand sidebar.
 *
 * Approval buttons are rendered from structured metadata returned by the
 * agent (response.metadata.pendingApprovals), not from text parsing.
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

  // ── Helpers ──────────────────────────────────────────────────

  const getAgentId = () => hasInternalOnly ? undefined : (select?.value || undefined);
  const getContextPrefix = () => `[Context: User is currently viewing the ${currentChatContext} panel] `;

  /**
   * Handle approval button clicks: call the REST API directly, then send a
   * continuation message so the LLM can proceed with the original task.
   */
  const handleApproval = async (approvalIds, decision) => {
    const chatHistory = getHistory(hasInternalOnly ? '__guardian__' : (select?.value || ''));

    const results = [];
    const approvalResponses = [];
    for (const id of approvalIds) {
      try {
        const result = await api.decideToolApproval({ approvalId: id, decision, actor: 'web-user' });
        approvalResponses.push(result);
        results.push(result.success ? (result.message || `${decision}`) : `Failed: ${result.message || 'unknown error'}`);
      } catch (err) {
        approvalResponses.push({ success: false, message: err.message || 'unknown error', continueConversation: false });
        results.push(`Error: ${err.message || 'unknown'}`);
      }
    }

    const immediateMessages = approvalResponses
      .map((result) => result.displayMessage)
      .filter((value) => typeof value === 'string' && value.trim().length > 0);
    const continuedResponses = approvalResponses
      .map((result) => result.continuedResponse)
      .filter((value) => value && typeof value.content === 'string');

    if (continuedResponses.length > 0) {
      if (immediateMessages.length > 0) {
        addAgentMessage(immediateMessages.join('\n'));
      }
      for (const response of continuedResponses) {
        addAgentMessage(response.content, response.metadata?.pendingApprovals, response.metadata?.responseSource);
      }
      history.scrollTop = history.scrollHeight;
      return;
    }

    // Only continue when the backend confirms there is suspended chat context to resume.
    if (decision === 'approved' && approvalResponses.some((result) => result.continueConversation !== false)) {
      const thinkingEl = createThinkingEl();
      history.appendChild(thinkingEl);
      history.scrollTop = history.scrollHeight;

      try {
        const summary = results.join('; ');
        const allSucceeded = results.every(r => !r.startsWith('Failed:') && !r.startsWith('Error:'));
        const msg = getContextPrefix() + `[User approved the pending tool action(s). Result: ${summary}] ${allSucceeded ? 'Please continue with the original task.' : 'Some actions failed — adjust your approach accordingly.'}`;
        const response = await api.sendMessage(msg, getAgentId(), webUserId, 'web');
        thinkingEl.remove();
        addAgentMessage(response.content, response.metadata?.pendingApprovals, response.metadata?.responseSource);
      } catch (err) {
        thinkingEl.remove();
        history.appendChild(createMessageEl('error', err.message || 'Continuation failed'));
      }
      history.scrollTop = history.scrollHeight;
      return;
    }

    if (immediateMessages.length > 0) {
      addAgentMessage(immediateMessages.join('\n'));
      history.scrollTop = history.scrollHeight;
      return;
    }

    if (results.length > 0) {
      addAgentMessage(results.join('\n'));
      history.scrollTop = history.scrollHeight;
    }
  };

  /**
   * Append an agent message to the chat, with approval buttons when the
   * response includes structured pending approval data.
   */
  const addAgentMessage = (content, pendingApprovals, responseSource) => {
    const chatHistory = getHistory(hasInternalOnly ? '__guardian__' : (select?.value || ''));
    chatHistory.push({ role: 'agent', content, responseSource, pendingApprovals });
    history.appendChild(createMessageEl('agent', content, { pendingApprovals, responseSource, onApproval: handleApproval }));
  };

  // ── Send logic ──────────────────────────────────────────────

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
      const contextPrefix = getContextPrefix();
      const agentId = getAgentId();

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
              indicator.textContent = `\u2699 ${data.toolName || 'tool'}`;
              liveEl.appendChild(indicator);
            };

            const onDone = (data) => {
              if (data.requestId !== requestId) return;
              cleanup();
              const finalContent = data.content || liveContent;
              // Replace the streaming element with a final one that may include buttons
              if (liveEl) {
                liveEl.classList.remove('streaming');
                const replacement = createMessageEl('agent', finalContent, {
                  pendingApprovals: data.metadata?.pendingApprovals,
                  responseSource: data.metadata?.responseSource,
                  onApproval: handleApproval,
                });
                liveEl.replaceWith(replacement);
              } else {
                thinkingEl.remove();
                addAgentMessage(finalContent, data.metadata?.pendingApprovals, data.metadata?.responseSource);
              }
              chatHistory.push({ role: 'agent', content: finalContent, responseSource: data.metadata?.responseSource, pendingApprovals: data.metadata?.pendingApprovals });
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
              addAgentMessage(streamResult.content, streamResult.metadata?.pendingApprovals, streamResult.metadata?.responseSource);
            }
          } else {
            // No requestId — treat as regular response
            thinkingEl.remove();
            addAgentMessage(streamResult.content || '', streamResult.metadata?.pendingApprovals, streamResult.metadata?.responseSource);
          }
        } catch {
          // Streaming failed — fall back to regular send
          const response = await api.sendMessage(contextPrefix + text, agentId, webUserId, 'web');
          thinkingEl.remove();
          addAgentMessage(response.content, response.metadata?.pendingApprovals, response.metadata?.responseSource);
        }
      } else {
        const response = await api.sendMessage(contextPrefix + text, getAgentId(), webUserId, 'web');
        thinkingEl.remove();
        addAgentMessage(response.content, response.metadata?.pendingApprovals, response.metadata?.responseSource);
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

// ── Pure helpers (no closure dependencies) ──────────────────

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
    historyEl.appendChild(createMessageEl(msg.role, msg.content, {
      pendingApprovals: msg.pendingApprovals,
      responseSource: msg.responseSource,
    }));
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

function createThinkingEl() {
  const el = document.createElement('div');
  el.className = 'chat-message agent is-thinking';
  el.innerHTML = '<div class="msg-body"><div class="chat-thinking"><span class="chat-spinner" aria-hidden="true"></span><span>Thinking...</span></div></div>';
  return el;
}

/**
 * Create a chat message element.
 *
 * opts.pendingApprovals — structured array from response.metadata.pendingApprovals
 * opts.onApproval       — callback(ids[], decision) for button clicks
 */
function createMessageEl(role, content, opts) {
  const msg = document.createElement('div');
  msg.className = `chat-message ${role === 'error' ? 'agent' : role}`;
  msg.style.marginBottom = '0.5rem';

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.style.cssText = `padding:0.5rem;font-size:0.75rem;${role === 'error' ? 'color:var(--error);' : ''}`;

  const contentEl = document.createElement('div');
  contentEl.className = 'chat-msg-content';
  contentEl.style.whiteSpace = 'pre-wrap';
  contentEl.textContent = content;
  const sourceEl = buildSourceBadge(opts?.responseSource);
  if (sourceEl) {
    body.appendChild(sourceEl);
  }
  body.appendChild(contentEl);

  // Render approval buttons from structured metadata (not text parsing)
  const approvals = opts?.pendingApprovals;
  if (approvals?.length && opts?.onApproval) {
    body.appendChild(buildApprovalButtons(approvals, opts.onApproval));
  }

  msg.appendChild(body);
  return msg;
}

function buildSourceBadge(responseSource) {
  if (!responseSource || !responseSource.locality) return null;
  const badge = document.createElement('div');
  badge.className = 'chat-msg-source';
  badge.style.cssText = 'display:inline-flex;align-items:center;gap:0.35rem;margin-bottom:0.35rem;padding:0.15rem 0.4rem;border:1px solid var(--border);border-radius:999px;background:var(--bg-secondary);font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;';
  let label = responseSource.locality;
  if (responseSource.usedFallback) {
    label += ' fallback';
  }
  badge.textContent = label;
  if (responseSource.notice) {
    badge.title = responseSource.notice;
  }
  return badge;
}

/**
 * Build the approval button row for one or more pending actions.
 */
function buildApprovalButtons(approvals, onApproval) {
  const container = document.createElement('div');
  container.style.cssText = 'margin-top:0.5rem;padding:0.4rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);';

  const summary = document.createElement('div');
  summary.style.cssText = 'font-size:0.65rem;color:var(--text-muted);margin-bottom:0.4rem;';
  summary.textContent = approvals.length === 1
    ? 'Approval required for this action:'
    : `Approval required for these ${approvals.length} actions:`;
  container.appendChild(summary);

  const detailList = document.createElement('div');
  detailList.style.cssText = 'display:flex;flex-direction:column;gap:0.25rem;margin-bottom:0.45rem;';
  approvals.forEach((approval) => {
    const item = document.createElement('div');
    item.style.cssText = 'font-size:0.72rem;color:var(--text-primary);line-height:1.35;';
    item.textContent = approvals.length === 1
      ? describeApprovalAction(approval)
      : `• ${describeApprovalAction(approval)}`;
    detailList.appendChild(item);
  });
  container.appendChild(detailList);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:0.5rem;align-items:center;';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-primary';
  approveBtn.textContent = approvals.length > 1 ? `Approve All (${approvals.length})` : 'Approve';
  approveBtn.style.cssText = 'font-size:0.7rem;padding:0.3rem 0.7rem;';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn btn-secondary';
  denyBtn.textContent = 'Deny';
  denyBtn.style.cssText = 'font-size:0.7rem;padding:0.3rem 0.7rem;';

  const statusEl = document.createElement('span');
  statusEl.style.cssText = 'font-size:0.65rem;color:var(--text-muted);';

  const disable = () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    approveBtn.style.opacity = '0.5';
    denyBtn.style.opacity = '0.5';
  };

  approveBtn.addEventListener('click', async () => {
    disable();
    statusEl.textContent = 'Approving\u2026';
    await onApproval(approvals.map(a => a.id), 'approved');
    statusEl.textContent = 'Approved';
    statusEl.style.color = 'var(--success)';
  });

  denyBtn.addEventListener('click', async () => {
    disable();
    statusEl.textContent = 'Denying\u2026';
    await onApproval(approvals.map(a => a.id), 'denied');
    statusEl.textContent = 'Denied';
    statusEl.style.color = 'var(--error)';
  });

  btnRow.append(approveBtn, denyBtn, statusEl);
  container.appendChild(btnRow);
  return container;
}

function normalizeApprovalPreview(preview) {
  return String(preview || '').replace(/\s+/g, ' ').trim();
}

function parseApprovalPreview(preview) {
  const normalized = normalizeApprovalPreview(preview);
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function describePolicyApproval(preview) {
  const parsed = parseApprovalPreview(preview);
  if (!parsed) return null;
  const action = String(parsed.action || '').trim();
  const value = String(parsed.value || '').trim();
  if (!action || !value) return null;
  switch (action) {
    case 'add_path':
      return `Add ${value} to allowed paths`;
    case 'remove_path':
      return `Remove ${value} from allowed paths`;
    case 'add_domain':
      return `Add ${value} to allowed domains`;
    case 'remove_domain':
      return `Remove ${value} from allowed domains`;
    case 'add_command':
      return `Allow command ${value}`;
    case 'remove_command':
      return `Remove allowed command ${value}`;
    case 'set_tool_policy_auto':
      return `Auto-approve tool ${value}`;
    case 'set_tool_policy_manual':
      return `Require manual approval for tool ${value}`;
    case 'set_tool_policy_deny':
      return `Deny tool ${value}`;
    default:
      return null;
  }
}

function describeApprovalAction(approval) {
  const toolName = String(approval?.toolName || '').trim();
  const preview = normalizeApprovalPreview(approval?.argsPreview);

  if (toolName === 'update_tool_policy') {
    return describePolicyApproval(preview) || 'Apply policy update';
  }
  if (toolName === 'automation_save') {
    return preview ? `Save ${preview}` : 'Save automation';
  }
  if (toolName === 'automation_set_enabled') {
    return preview ? `Update ${preview}` : 'Update automation';
  }
  if (toolName === 'automation_run') {
    return preview ? `Run ${preview}` : 'Run automation';
  }
  if (toolName === 'automation_delete') {
    return preview ? `Delete ${preview}` : 'Delete automation';
  }
  if (toolName === 'task_create') {
    return preview ? `Create ${preview}` : 'Create scheduled automation';
  }
  if (toolName === 'task_update') {
    return preview ? `Update ${preview}` : 'Update scheduled automation';
  }
  if (toolName === 'workflow_upsert') {
    return preview ? `Save ${preview}` : 'Save workflow';
  }
  if (preview) {
    return `${toolName}: ${preview}`;
  }
  return `Run ${toolName}`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
