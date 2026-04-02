/**
 * Persistent Chat Panel — tier mode toggle, message history, text input.
 * Integrated into the right-hand sidebar.
 *
 * Approval buttons are rendered from structured metadata returned by the
 * agent (response.metadata.pendingAction), not from text parsing.
 */

import { api } from './api.js';
import { onSSE, offSSE } from './app.js';
import {
  getApprovalUiGroupState,
  markApprovalUiError,
  markApprovalUiProcessing,
  markApprovalUiResolved,
} from './approval-ui-state.js';
import { decideChatApproval } from './chat-approval.js';
import { resolveChatHistoryKey } from './chat-history.js';
import { createResponseSourceBadge } from './response-source.js';
import { applyInputTooltips } from './tooltip.js';

const chatHistoryByAgent = new Map();
const ACTIVE_AGENT_KEY = 'guardianagent_active_agent';
const TIER_MODE_KEY = 'guardianagent_tier_mode';
const WEB_USER_KEY = 'guardianagent_web_user';
const GUARDIAN_CHAT_SURFACE_ID = 'web-guardian-chat';
const CODE_SESSIONS_CHANGED_EVENT = 'guardian:code-sessions-changed';
const CODE_SESSION_FOCUS_CHANGED_EVENT = 'guardian:code-session-focus-changed';
let currentChatContext = 'dashboard';
let refreshCurrentCodeSessions = null;
let refreshCodeSessionsPromise = null;

export async function initChatPanel(container) {
  container.innerHTML = '<div class="loading">Loading Chat...</div>';

  let agents = [];
  let routingMode = null;
  let codeSessionsState = { sessions: [], currentSessionId: null };
  const webUserId = resolveWebUserId();
  try {
    [agents, routingMode, codeSessionsState] = await Promise.all([
      api.agents().catch(() => []),
      api.routingMode().catch(() => null),
      api.codeSessions({
        userId: webUserId,
        channel: 'web',
        surfaceId: GUARDIAN_CHAT_SURFACE_ID,
      }).catch(() => ({ sessions: [], currentSessionId: null })),
    ]);
  } catch {
    // Continue with empty
  }

  const chatAgents = agents.filter((a) => a.canChat !== false);
  const userAgents = chatAgents.filter((a) => !a.internal);
  const hasInternalOnly = userAgents.length === 0 && hasTierRoutingAgents(chatAgents);
  let knownCodeSessions = Array.isArray(codeSessionsState?.sessions) ? codeSessionsState.sessions : [];
  let currentCodeSessionId = typeof codeSessionsState?.currentSessionId === 'string'
    ? codeSessionsState.currentSessionId
    : null;

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
  toolbar.style.flexWrap = 'wrap';
  toolbar.style.gap = '0.5rem';

  // Agent selector OR mode toggle
  let select = null;
  let modeSelect = null;
  let activeAgentId = null;
  let approvalHandler = null;

  if (hasInternalOnly) {
    // Unified mode: show tier mode toggle instead of agent dropdown
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';

    const modeLabel = document.createElement('span');
    modeLabel.style.cssText = 'font-size:0.7rem;color:var(--text-muted);';
    modeLabel.textContent = 'Mode:';

    modeSelect = document.createElement('select');
    modeSelect.id = 'chat-mode-select';
    modeSelect.style.cssText = 'font-size:0.7rem;';
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

    modeRow.append(modeLabel, modeSelect);
    toolbar.appendChild(modeRow);

    // Use a single unified history key
    activeAgentId = '__guardian__';
  } else if (userAgents.length > 0) {
    // Classic mode: user-visible agent dropdown
    select = document.createElement('select');
    select.id = 'chat-agent-select';
    select.style.minWidth = '10rem';
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

  let history = null;

  const getHistoryKey = () => {
    const baseKey = hasInternalOnly ? '__guardian__' : (select?.value || '');
    return resolveChatHistoryKey(baseKey);
  };

  const refreshCodeSessions = async () => {
    if (refreshCodeSessionsPromise) {
      return refreshCodeSessionsPromise;
    }
    refreshCodeSessionsPromise = api.codeSessions({
      userId: webUserId,
      channel: 'web',
      surfaceId: GUARDIAN_CHAT_SURFACE_ID,
    }).catch(() => ({ sessions: [], currentSessionId: null }));
    const result = await refreshCodeSessionsPromise;
    refreshCodeSessionsPromise = null;
    knownCodeSessions = Array.isArray(result?.sessions) ? result.sessions : [];
    currentCodeSessionId = normalizeCodeSessionId(result?.currentSessionId);
    if (history) {
      renderHistory(history, getHistoryKey(), approvalHandler);
    }
    return result;
  };

  refreshCurrentCodeSessions = () => {
    void refreshCodeSessions();
  };

  const notifyCodeSessionsChanged = (detail = {}) => {
    window.dispatchEvent(new CustomEvent(CODE_SESSIONS_CHANGED_EVENT, { detail }));
  };

  const notifyCodeSessionFocus = (sessionId) => {
    window.dispatchEvent(new CustomEvent(CODE_SESSION_FOCUS_CHANGED_EVENT, {
      detail: { sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null },
    }));
  };

  window.addEventListener(CODE_SESSIONS_CHANGED_EVENT, (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail?.surfaceId && detail.surfaceId !== GUARDIAN_CHAT_SURFACE_ID) return;
    void refreshCodeSessions();
  });

  window.addEventListener(CODE_SESSION_FOCUS_CHANGED_EVENT, (event) => {
    const sessionId = event instanceof CustomEvent ? event.detail?.sessionId : null;
    currentCodeSessionId = normalizeCodeSessionId(sessionId);
    void refreshCodeSessions();
  });

  wrapper.appendChild(toolbar);

  // Chat history
  history = document.createElement('div');
  history.className = 'chat-history';
  history.id = 'chat-history';
  history.style.fontSize = '0.75rem';

  wrapper.appendChild(history);

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';

  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = 'Ask the agent...';
  input.id = 'chat-input';
  input.style.fontSize = '0.75rem';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-primary';
  sendBtn.textContent = 'Send';
  sendBtn.style.padding = '0.5rem 0.8rem';

  renderHistory(history, getHistoryKey() || activeAgentId, approvalHandler);

  if (select) {
    select.addEventListener('change', () => {
      const selected = select.value;
      if (selected) {
        sessionStorage.setItem(ACTIVE_AGENT_KEY, selected);
        activeAgentId = selected;
      }
      renderHistory(history, getHistoryKey() || selected, approvalHandler);
    });
  }

  resetBtn.addEventListener('click', async () => {
    const resetId = getHistoryKey();
    if (!resetId) return;
    try {
      const apiAgentId = (hasInternalOnly ? '__guardian__' : (select?.value || '')) === '__guardian__'
        ? (getRoutingModeAgentId(chatAgents, modeSelect?.value) || chatAgents[0]?.id || 'default')
        : (select?.value || '');
      if (currentCodeSessionId) {
        await api.codeSessionResetConversation(currentCodeSessionId, {
          userId: webUserId,
          channel: 'web',
          surfaceId: GUARDIAN_CHAT_SURFACE_ID,
        });
      } else {
        await api.resetConversation(apiAgentId, webUserId, 'web');
      }
      chatHistoryByAgent.delete(resetId);
      renderHistory(history, resetId, approvalHandler);
    } catch (err) {
      console.error('Reset failed', err);
    }
  });

  // ── Helpers ──────────────────────────────────────────────────

  const getAgentId = () => (
    hasInternalOnly
      ? getRoutingModeAgentId(chatAgents, modeSelect?.value)
      : (select?.value || undefined)
  );
  const getContextPrefix = () => `[Context: User is currently viewing the ${currentChatContext} panel] `;

  const restoreInput = () => {
    input.disabled = false;
    sendBtn.disabled = false;
    autoResizeChatInput(input);
    input.focus();
  };

  const beginApprovalProgress = (sessionId) => {
    if (!history) {
      return {
        setLabel: () => {},
        finish: () => {},
      };
    }

    input.disabled = true;
    sendBtn.disabled = true;

    const thinkingEl = createThinkingEl('Continuing after approval…');
    history.appendChild(thinkingEl);
    history.scrollTop = history.scrollHeight;

    const onRunTimeline = (data) => {
      if (!sessionId || data?.summary?.codeSessionId !== sessionId) return;
      updateThinkingEl(thinkingEl, data);
      history.scrollTop = history.scrollHeight;
    };

    if (sessionId) {
      onSSE('run.timeline', onRunTimeline);
    }

    return {
      setLabel: (label) => setThinkingLabel(thinkingEl, label),
      finish: () => {
        if (sessionId) {
          offSSE('run.timeline', onRunTimeline);
        }
        thinkingEl.remove();
        restoreInput();
      },
    };
  };

  /**
   * Handle approval button clicks: call the REST API directly, then send a
   * continuation message so the LLM can proceed with the original task.
   */
  const handleApproval = async (approvalIds, decision) => {
    markApprovalUiProcessing(approvalIds, decision);
    const historyKey = getHistoryKey();
    const chatHistory = getHistory(historyKey);
    const focusedSessionId = currentCodeSessionId;
    const progress = decision === 'approved' ? beginApprovalProgress(focusedSessionId) : null;

    try {
      const results = [];
      const approvalResponses = [];
      for (const id of approvalIds) {
        try {
          const result = await decideChatApproval({
            apiClient: api,
            approvalId: id,
            decision,
            webUserId,
            focusedSessionId,
            surfaceId: GUARDIAN_CHAT_SURFACE_ID,
          });
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
      const allSucceeded = approvalResponses.every((result) => result?.success !== false);

      if (continuedResponses.length > 0) {
        if (allSucceeded) {
          markApprovalUiResolved(approvalIds, decision);
        } else {
          markApprovalUiError(approvalIds, results.join('; '));
        }
        if (immediateMessages.length > 0) {
          addAgentMessage(immediateMessages.join('\n'));
        }
        for (const response of continuedResponses) {
          addAgentMessage(response.content, response.metadata?.pendingAction, response.metadata?.responseSource);
        }
        history.scrollTop = history.scrollHeight;
        return;
      }

      // Only continue when the backend confirms there is suspended chat context to resume.
      if (decision === 'approved' && approvalResponses.some((result) => result.continueConversation !== false)) {
        progress?.setLabel('Finalizing response…');

        try {
          const summary = results.join('; ');
          const msg = getContextPrefix() + `[User approved the pending tool action(s). Result: ${summary}] ${allSucceeded ? 'Please continue with the current request only. Do not resume older unrelated pending tasks.' : 'Some actions failed — adjust your approach accordingly. Focus only on the current request.'}`;
          const response = await api.sendMessage(
            msg,
            getAgentId(),
            webUserId,
            'web',
            undefined,
            GUARDIAN_CHAT_SURFACE_ID,
          );
          if (allSucceeded) {
            markApprovalUiResolved(approvalIds, decision);
          } else {
            markApprovalUiError(approvalIds, summary);
          }
          addAgentMessage(response.content, response.metadata?.pendingAction, response.metadata?.responseSource);
        } catch (err) {
          markApprovalUiError(approvalIds, err instanceof Error ? err.message : String(err));
          history.appendChild(createMessageEl('error', err.message || 'Continuation failed'));
        }
        history.scrollTop = history.scrollHeight;
        return;
      }

      if (immediateMessages.length > 0) {
        if (allSucceeded) {
          markApprovalUiResolved(approvalIds, decision);
        } else {
          markApprovalUiError(approvalIds, results.join('; '));
        }
        addAgentMessage(immediateMessages.join('\n'));
        history.scrollTop = history.scrollHeight;
        return;
      }

      if (results.length > 0) {
        if (allSucceeded) {
          markApprovalUiResolved(approvalIds, decision);
        } else {
          markApprovalUiError(approvalIds, results.join('; '));
        }
        addAgentMessage(results.join('\n'));
        history.scrollTop = history.scrollHeight;
        return;
      }

      markApprovalUiError(approvalIds);
    } finally {
      progress?.finish();
    }
  };
  approvalHandler = handleApproval;
  renderHistory(history, getHistoryKey() || activeAgentId, approvalHandler);

  /**
   * Append an agent message to the chat, with approval buttons when the
   * response includes structured pending approval data.
   */
  const addAgentMessage = (content, pendingAction, responseSource) => {
    const chatHistory = getHistory(getHistoryKey());
    chatHistory.push({ role: 'agent', content, responseSource, pendingAction });
    history.appendChild(createMessageEl('agent', content, { pendingAction, responseSource, onApproval: handleApproval }));
  };

  const resolvePendingActionForDisplay = async (metadata) => {
    const direct = metadata?.pendingAction;
    return direct && typeof direct === 'object' ? direct : undefined;
  };

  // ── Send logic ──────────────────────────────────────────────

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;

    const historyKey = getHistoryKey();
    if (!historyKey) return;

    const chatHistory = getHistory(historyKey);

    input.value = '';
    autoResizeChatInput(input);
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
      const requestId = createClientRequestId();
      const focusedSessionId = currentCodeSessionId;
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
        restoreInput();
        Promise.resolve(resolvePendingActionForDisplay(data?.metadata))
          .then((pendingAction) => {
            addAgentMessage(data.content || '', pendingAction, data.metadata?.responseSource);
            const focusChanged = data?.metadata?.codeSessionFocusChanged === true
              || data?.metadata?.codeSessionDetached === true
              || (!focusedSessionId && typeof data?.metadata?.codeSessionId === 'string');
            if (focusChanged) {
              const nextSessionId = normalizeCodeSessionId(data?.metadata?.codeSessionId);
              notifyCodeSessionFocus(nextSessionId);
              notifyCodeSessionsChanged({
                sessionId: nextSessionId,
                surfaceId: GUARDIAN_CHAT_SURFACE_ID,
              });
            }
            if (focusedSessionId) {
              notifyCodeSessionsChanged({
                sessionId: focusedSessionId,
                surfaceId: GUARDIAN_CHAT_SURFACE_ID,
              });
            }
            history.scrollTop = history.scrollHeight;
          })
          .catch(() => {
            addAgentMessage(data.content || '', data.metadata?.pendingAction, data.metadata?.responseSource);
          });
      };

      const finalizeError = (message) => {
        if (finalised) return;
        finalised = true;
        cleanup();
        thinkingEl.remove();
        restoreInput();
        history.appendChild(createMessageEl('error', message || 'Stream error'));
      };

      const onRunTimeline = (data) => {
        if (focusedSessionId) {
          if (data?.summary?.codeSessionId !== focusedSessionId) return;
        } else if (data?.summary?.runId !== requestId) {
          return;
        }
        updateThinkingEl(thinkingEl, data);
        history.scrollTop = history.scrollHeight;
      };

      const onDone = (data) => {
        if (data?.requestId !== requestId) return;
        finalizeSuccess(data);
      };

      const onError = (data) => {
        if (data?.requestId !== requestId) return;
        finalizeError(data.error || 'Stream error');
      };

      onSSE('run.timeline', onRunTimeline);
      onSSE('chat.done', onDone);
      onSSE('chat.error', onError);

      try {
        const streamResult = await api.sendMessageStream(
          contextPrefix + text,
          agentId,
          webUserId,
          'web',
          undefined,
          requestId,
          GUARDIAN_CHAT_SURFACE_ID,
        );

        if (streamResult?.error) {
          finalizeError(streamResult.error);
        } else if (streamResult?.content) {
          finalizeSuccess(streamResult);
        }
      } catch {
        cleanup();
        const response = await api.sendMessage(
          contextPrefix + text,
          agentId,
          webUserId,
          'web',
          undefined,
          GUARDIAN_CHAT_SURFACE_ID,
        );
        thinkingEl.remove();
        addAgentMessage(response.content, response.metadata?.pendingAction, response.metadata?.responseSource);
      }
    } catch (err) {
      thinkingEl.remove();
      const errorMsg = err.message === 'AUTH_FAILED' ? 'Auth failed' : (err.message || 'Error');
      history.appendChild(createMessageEl('error', errorMsg));
    }

    history.scrollTop = history.scrollHeight;
    restoreInput();
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    autoResizeChatInput(input);
  });

  inputArea.append(input, sendBtn);
  wrapper.appendChild(inputArea);

  container.appendChild(wrapper);
  autoResizeChatInput(input);
  input.focus();
}

export function setChatContext(context) {
  currentChatContext = context;
  if (refreshCurrentCodeSessions) {
    refreshCurrentCodeSessions();
  }
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

function normalizeCodeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getHistory(agentId) {
  if (!chatHistoryByAgent.has(agentId)) {
    chatHistoryByAgent.set(agentId, []);
  }
  return chatHistoryByAgent.get(agentId);
}

function renderHistory(historyEl, agentId, onApproval) {
  historyEl.innerHTML = '';
  if (!agentId) return;
  const chatHistory = getHistory(agentId);
  for (const msg of chatHistory) {
    historyEl.appendChild(createMessageEl(msg.role, msg.content, {
      pendingAction: msg.pendingAction,
      responseSource: msg.responseSource,
      onApproval,
    }));
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

function createThinkingEl(initialLabel = 'Starting…') {
  const el = document.createElement('div');
  el.className = 'chat-message agent is-thinking';
  el.innerHTML = `
    <div class="msg-body">
      <div class="chat-thinking">
        <span class="chat-spinner" aria-hidden="true"></span>
        <span class="chat-thinking__label">${esc(initialLabel)}</span>
      </div>
      <div class="chat-live-activity" hidden></div>
    </div>
  `;
  return el;
}

function setThinkingLabel(el, label) {
  const labelEl = el?.querySelector?.('.chat-thinking__label');
  if (labelEl) {
    labelEl.textContent = String(label || 'Working…');
  }
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
  const status = String(run?.summary?.status || '').trim();
  if (latestItem) {
    return {
      label: latestItem.title,
      items: recentItems,
    };
  }
  return {
    label: humanizeTimelineStatus(status),
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

/**
 * Create a chat message element.
 *
 * opts.pendingAction — structured object from response.metadata.pendingAction
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
  const sourceEl = role === 'user' ? null : buildSourceBadge(opts?.responseSource);
  if (sourceEl) {
    body.appendChild(sourceEl);
  }
  body.appendChild(contentEl);

  // Render approval buttons from structured metadata (not text parsing)
  const approvals = extractPendingActionApprovals(opts?.pendingAction);
  if (approvals?.length && opts?.onApproval) {
    body.appendChild(buildApprovalButtons(approvals, opts.onApproval));
  }

  msg.appendChild(body);
  return msg;
}

function extractPendingActionApprovals(pendingAction) {
  if (!pendingAction || typeof pendingAction !== 'object') return [];
  const blocker = pendingAction.blocker;
  if (!blocker || typeof blocker !== 'object' || blocker.kind !== 'approval') return [];
  if (!Array.isArray(blocker.approvalSummaries)) return [];
  return blocker.approvalSummaries
    .filter((approval) => approval && typeof approval === 'object' && typeof approval.id === 'string' && typeof approval.toolName === 'string')
    .map((approval) => ({
      id: approval.id,
      toolName: approval.toolName,
      argsPreview: typeof approval.argsPreview === 'string' ? approval.argsPreview : '',
    }));
}

function buildSourceBadge(responseSource) {
  return createResponseSourceBadge(responseSource);
}

/**
 * Build the approval button row for one or more pending actions.
 */
function buildApprovalButtons(approvals, onApproval) {
  const container = document.createElement('div');
  container.style.cssText = 'margin-top:0.5rem;padding:0.4rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);';
  const approvalIds = approvals.map((approval) => approval.id);
  const uiState = getApprovalUiGroupState(approvalIds);

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

  const applyUiState = (state) => {
    if (!state) return false;
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    approveBtn.style.opacity = '0.5';
    denyBtn.style.opacity = '0.5';
    if (state.status === 'processing') {
      statusEl.textContent = state.message || (state.decision === 'denied' ? 'Denying…' : 'Approving…');
      statusEl.style.color = 'var(--text-muted)';
      return true;
    }
    if (state.status === 'approved') {
      statusEl.textContent = state.message || 'Approved';
      statusEl.style.color = 'var(--success)';
      return true;
    }
    if (state.status === 'denied') {
      statusEl.textContent = state.message || 'Denied';
      statusEl.style.color = 'var(--error)';
      return true;
    }
    if (state.status === 'error') {
      approveBtn.disabled = false;
      denyBtn.disabled = false;
      approveBtn.style.opacity = '1';
      denyBtn.style.opacity = '1';
      statusEl.textContent = state.message || 'Approval update failed';
      statusEl.style.color = 'var(--error)';
      return true;
    }
    return false;
  };

  const disable = () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    approveBtn.style.opacity = '0.5';
    denyBtn.style.opacity = '0.5';
  };

  approveBtn.addEventListener('click', async () => {
    const approvalIds = approvals.map((approval) => approval.id);
    disable();
    statusEl.textContent = 'Approving\u2026';
    statusEl.style.color = 'var(--text-muted)';
    await onApproval(approvalIds, 'approved');
    applyUiState(getApprovalUiGroupState(approvalIds));
  });

  denyBtn.addEventListener('click', async () => {
    const approvalIds = approvals.map((approval) => approval.id);
    disable();
    statusEl.textContent = 'Denying\u2026';
    statusEl.style.color = 'var(--text-muted)';
    await onApproval(approvalIds, 'denied');
    applyUiState(getApprovalUiGroupState(approvalIds));
  });

  btnRow.append(approveBtn, denyBtn, statusEl);
  applyUiState(uiState);
  container.appendChild(btnRow);
  return container;
}

function autoResizeChatInput(input) {
  if (!(input instanceof HTMLTextAreaElement)) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
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
    return preview ? sentenceCaseApprovalPreview(preview) : 'Save automation';
  }
  if (toolName === 'automation_set_enabled') {
    return preview ? sentenceCaseApprovalPreview(preview) : 'Update automation';
  }
  if (toolName === 'automation_run') {
    return preview ? sentenceCaseApprovalPreview(preview) : 'Run automation';
  }
  if (toolName === 'automation_delete') {
    return preview ? sentenceCaseApprovalPreview(preview) : 'Delete automation';
  }
  if (preview) {
    return `${toolName}: ${preview}`;
  }
  return `Run ${toolName}`;
}

function sentenceCaseApprovalPreview(preview) {
  const normalized = String(preview || '').trim();
  if (!normalized) return '';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
