/**
 * Persistent Chat Panel — provider selector, message history, text input.
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
import { buildApprovalContinuationSummaryPart, decideChatApproval } from './chat-approval.js';
import { resolveChatDispatchAgentId } from './chat-dispatch-routing.js';
import {
  CHAT_HISTORY_UPDATED_EVENT,
  commitChatHistory,
  deleteChatHistory,
  getChatHistory,
  listChatHistoryKeys,
  resolveChatHistoryKey,
  setActiveChatHistoryKey,
} from './chat-history.js';
import {
  getChatProviderAgentId,
  getChatProviderOptions,
  normalizeChatProviderSelection,
  shouldRefreshChatProviderOptions,
  shouldUseChatProviderSelector,
} from './chat-mode-selector.js';
import { createClientRequestId } from './chat-request-id.js';
import { renderLinkedText } from './chat-linkify.js';
import { matchesRunTimelineRequest } from './chat-run-tracking.js';
import {
  findTargetCodeSession,
  normalizeCodeSessionId,
} from './chat-code-sessions.js';
import {
  canClearPendingActionFromChat,
  describePendingActionClearLabel,
  shouldHydratePendingActionFromStore,
} from './chat-pending-actions.js';
import { createResponseSourceBadge } from './response-source.js';
import { applyInputTooltips } from './tooltip.js';

const ACTIVE_AGENT_KEY = 'guardianagent_active_agent';
const CHAT_PROVIDER_SELECTION_KEY = 'guardianagent_chat_provider_selection';
const CHAT_PROVIDER_SELECTION_METADATA_KEY = '__guardian_chat_provider_selection';
const CHAT_ACTIVE_REQUEST_KEY = 'guardianagent_chat_active_request';
const WEB_USER_KEY = 'guardianagent_web_user';
const GUARDIAN_CHAT_SURFACE_ID = 'web-guardian-chat';
const CHAT_PENDING_CLEARED_EVENT = 'guardian:chat-pending-cleared';
const CODE_SESSIONS_CHANGED_EVENT = 'guardian:code-sessions-changed';
const CODE_SESSION_FOCUS_CHANGED_EVENT = 'guardian:code-session-focus-changed';
const PROVIDER_PROFILES_CHANGED_EVENT = 'guardian:providers-changed';
const INTENT_GATEWAY_MISSING_SUMMARY = 'No classification summary provided.';
const CHAT_LIVE_ACTIVITY_VISIBLE_ITEMS = 2;
const CHAT_PERSISTED_ACTIVITY_VISIBLE_ITEMS = 2;
let currentChatContext = 'second-brain';
let refreshVisiblePendingAction = null;
let refreshCodeSessionsPromise = null;
let refreshChatPanelChrome = null;
let activeChatIndicator = null;
let activeRequestController = null;
let externalPendingClearHandler = null;
let clearPendingUiHandler = null;

function persistActiveRequest(request) {
  if (!request || typeof request !== 'object') return;
  const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
  if (!requestId) return;
  const payload = {
    requestId,
    agentId: typeof request.agentId === 'string' ? request.agentId.trim() : '',
    userId: typeof request.userId === 'string' ? request.userId.trim() : '',
    channel: typeof request.channel === 'string' ? request.channel.trim() : '',
    createdAt: Date.now(),
  };
  sessionStorage.setItem(CHAT_ACTIVE_REQUEST_KEY, JSON.stringify(payload));
}

function readPersistedActiveRequest() {
  const raw = sessionStorage.getItem(CHAT_ACTIVE_REQUEST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const requestId = typeof parsed.requestId === 'string' ? parsed.requestId.trim() : '';
    if (!requestId) return null;
    return {
      requestId,
      agentId: typeof parsed.agentId === 'string' && parsed.agentId.trim() ? parsed.agentId.trim() : undefined,
      userId: typeof parsed.userId === 'string' && parsed.userId.trim() ? parsed.userId.trim() : undefined,
      channel: typeof parsed.channel === 'string' && parsed.channel.trim() ? parsed.channel.trim() : undefined,
    };
  } catch {
    return null;
  }
}

function clearPersistedActiveRequest(requestId) {
  const active = readPersistedActiveRequest();
  if (!active) {
    sessionStorage.removeItem(CHAT_ACTIVE_REQUEST_KEY);
    return;
  }
  if (!requestId || active.requestId === requestId) {
    sessionStorage.removeItem(CHAT_ACTIVE_REQUEST_KEY);
  }
}

function clearActiveChatIndicator() {
  if (activeChatIndicator?.element?.isConnected) {
    activeChatIndicator.element.remove();
  }
  activeChatIndicator = null;
}

function setActiveChatIndicator(state) {
  clearActiveChatIndicator();
  activeChatIndicator = state;
}

function updateActiveChatIndicatorLabel(label) {
  if (!activeChatIndicator) return;
  activeChatIndicator.label = String(label || 'Working…');
  if (activeChatIndicator.element?.isConnected) {
    setThinkingLabel(activeChatIndicator.element, activeChatIndicator.label);
  }
}

function updateActiveChatIndicatorTimeline(run) {
  if (!activeChatIndicator || !run?.summary) return;
  activeChatIndicator.timeline = run;
  if (activeChatIndicator.element?.isConnected) {
    updateThinkingEl(activeChatIndicator.element, run);
  }
}

function syncActiveChatIndicator(historyEl, agentId) {
  if (!historyEl || !activeChatIndicator || activeChatIndicator.historyKey !== agentId) return;
  if (activeChatIndicator.element?.isConnected && activeChatIndicator.element.parentElement === historyEl) {
    return;
  }
  const nextEl = createThinkingEl(activeChatIndicator.label);
  if (activeChatIndicator.timeline) {
    updateThinkingEl(nextEl, activeChatIndicator.timeline);
  }
  historyEl.appendChild(nextEl);
  activeChatIndicator.element = nextEl;
  historyEl.scrollTop = historyEl.scrollHeight;
}

function isCodeSessionInvalidation(payload) {
  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  return topics.includes('code-sessions');
}

export async function initChatPanel(container) {
  container.innerHTML = '<div class="loading">Loading Chat...</div>';

  let agents = [];
  let routingState = null;
  let codeSessionsState = { sessions: [], currentSessionId: null, referencedSessionIds: [], targetSessionId: null };
  const webUserId = resolveWebUserId();
  try {
    [agents, routingState, codeSessionsState] = await Promise.all([
      api.agents().catch(() => []),
      api.routingMode().catch(() => null),
      api.codeSessions({
        userId: webUserId,
        channel: 'web',
        surfaceId: GUARDIAN_CHAT_SURFACE_ID,
      }).catch(() => ({ sessions: [], currentSessionId: null, referencedSessionIds: [], targetSessionId: null })),
    ]);
  } catch {
    // Continue with empty
  }

  let chatAgents = agents.filter((a) => a.canChat !== false);
  let userAgents = chatAgents.filter((a) => !a.internal);
  let useProviderSelector = shouldUseChatProviderSelector(chatAgents, routingState);
  let knownCodeSessions = Array.isArray(codeSessionsState?.sessions) ? codeSessionsState.sessions : [];
  let currentCodeSessionId = typeof codeSessionsState?.currentSessionId === 'string'
    ? codeSessionsState.currentSessionId
    : null;
  let targetCodeSessionId = normalizeCodeSessionId(codeSessionsState?.targetSessionId);

  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-container';
  wrapper.style.height = '100%';
  wrapper.style.padding = '0';

  // Header
  const header = document.createElement('div');
  header.className = 'chat-panel-header';
  header.innerHTML = `
    <div class="chat-panel-header__brand">
      <span class="chat-panel-header__mark" aria-hidden="true"></span>
      <div class="chat-panel-header__copy">
        <div class="chat-panel-header__eyebrow">Persistent Chat Rail</div>
        <h3 class="chat-panel-header__title">Assistant</h3>
      </div>
    </div>
    <div class="chat-panel-header__meta">Request-scoped provider</div>
  `;
  wrapper.appendChild(header);

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'chat-toolbar';

  const primaryControls = document.createElement('div');
  primaryControls.style.cssText = 'display:flex;align-items:center;gap:0.5rem;width:100%;min-width:0;';
  toolbar.appendChild(primaryControls);

  const selectorSlot = document.createElement('div');
  selectorSlot.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex:1 1 auto;min-width:0;';
  primaryControls.appendChild(selectorSlot);

  // Agent selector OR provider selector
  let select = null;
  let providerSelect = null;
  let activeAgentId = null;
  let approvalHandler = null;

  let history = null;

  const getHistoryKey = () => {
    const baseKey = useProviderSelector ? '__guardian__' : (select?.value || '');
    return resolveChatHistoryKey(baseKey);
  };

  const renderSelectorControls = () => {
    selectorSlot.innerHTML = '';
    select = null;
    providerSelect = null;

    if (useProviderSelector) {
      const providerRow = document.createElement('div');
      providerRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex:1 1 auto;min-width:0;';

      const providerLabel = document.createElement('span');
      providerLabel.style.cssText = 'font-size:0.7rem;color:var(--text-muted);';
      providerLabel.textContent = 'Provider:';

      providerSelect = document.createElement('select');
      providerSelect.id = 'chat-provider-select';
      providerSelect.style.cssText = 'font-size:0.7rem;flex:1 1 auto;min-width:10rem;max-width:none;';
      providerSelect.innerHTML = getChatProviderOptions(routingState).map((option) => (
        `<option value="${esc(option.value)}">${esc(option.label)}</option>`
      )).join('');

      const currentSelection = normalizeChatProviderSelection(
        sessionStorage.getItem(CHAT_PROVIDER_SELECTION_KEY) ?? providerSelect.value ?? 'auto',
        routingState,
      );
      providerSelect.value = currentSelection;
      sessionStorage.setItem(CHAT_PROVIDER_SELECTION_KEY, currentSelection);

      providerSelect.addEventListener('change', () => {
        const nextSelection = normalizeChatProviderSelection(providerSelect.value, routingState);
        providerSelect.value = nextSelection;
        sessionStorage.setItem(CHAT_PROVIDER_SELECTION_KEY, nextSelection);
      });

      providerRow.append(providerLabel, providerSelect);
      selectorSlot.appendChild(providerRow);
      activeAgentId = '__guardian__';
      return;
    }

    if (userAgents.length > 0) {
      select = document.createElement('select');
      select.id = 'chat-agent-select';
      select.style.cssText = 'min-width:10rem;flex:1 1 auto;';
      select.innerHTML = userAgents.map((agent) =>
        `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`
      ).join('');
      selectorSlot.appendChild(select);
      activeAgentId = resolveInitialAgent(select, userAgents);
      select.addEventListener('change', () => {
        const selected = select.value;
        if (selected) {
          sessionStorage.setItem(ACTIVE_AGENT_KEY, selected);
          activeAgentId = selected;
        }
        if (history) {
          renderHistory(history, getHistoryKey() || selected, approvalHandler);
          refreshVisiblePendingAction?.();
        }
      });
      return;
    }

    const noAgents = document.createElement('div');
    noAgents.style.cssText = 'font-size:0.7rem;color:var(--text-muted);flex:1 1 auto;';
    noAgents.textContent = 'No agents available';
    selectorSlot.appendChild(noAgents);
    activeAgentId = null;
  };

  renderSelectorControls();

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-secondary';
  resetBtn.textContent = 'Reset Chat';
  resetBtn.style.cssText = 'font-size:0.7rem;padding:0.3rem 0.5rem;flex:0 0 auto;white-space:nowrap;';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn btn-secondary';
  stopBtn.textContent = 'Stop';
  stopBtn.disabled = true;
  stopBtn.style.cssText = 'font-size:0.7rem;padding:0.3rem 0.5rem;flex:0 0 auto;white-space:nowrap;';

  primaryControls.appendChild(stopBtn);
  primaryControls.appendChild(resetBtn);

  const refreshCodeSessions = async () => {
    if (refreshCodeSessionsPromise) {
      return refreshCodeSessionsPromise;
    }
    refreshCodeSessionsPromise = api.codeSessions({
      userId: webUserId,
      channel: 'web',
      surfaceId: GUARDIAN_CHAT_SURFACE_ID,
    }).catch(() => ({ sessions: [], currentSessionId: null, referencedSessionIds: [], targetSessionId: null }));
    const result = await refreshCodeSessionsPromise;
    refreshCodeSessionsPromise = null;
    knownCodeSessions = Array.isArray(result?.sessions) ? result.sessions : [];
    currentCodeSessionId = normalizeCodeSessionId(result?.currentSessionId);
    targetCodeSessionId = normalizeCodeSessionId(result?.targetSessionId);
    if (history) {
      renderHistory(history, getHistoryKey(), approvalHandler);
      refreshVisiblePendingAction?.();
    }
    return result;
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

  const refreshProviderSelectorChrome = async () => {
    const previousHistoryKey = getHistoryKey() || activeAgentId;
    try {
      const [nextAgents, nextRoutingState] = await Promise.all([
        api.agents().catch(() => agents),
        api.routingMode().catch(() => routingState),
      ]);
      agents = Array.isArray(nextAgents) ? nextAgents : agents;
      routingState = nextRoutingState || routingState;
      chatAgents = agents.filter((agent) => agent?.canChat !== false);
      userAgents = chatAgents.filter((agent) => !agent.internal);
      useProviderSelector = shouldUseChatProviderSelector(chatAgents, routingState);
      renderSelectorControls();
      if (history) {
        const nextHistoryKey = getHistoryKey() || activeAgentId;
        if (nextHistoryKey !== previousHistoryKey) {
          renderHistory(history, nextHistoryKey, approvalHandler);
          refreshVisiblePendingAction?.();
        }
      }
    } catch {
      // Keep the current selector state when refresh fails.
    }
  };

  window.addEventListener(PROVIDER_PROFILES_CHANGED_EVENT, () => {
    void refreshProviderSelectorChrome();
  });

  onSSE('ui.invalidate', (payload) => {
    if (isCodeSessionInvalidation(payload)) {
      void refreshCodeSessions();
    }
    if (shouldRefreshChatProviderOptions(payload)) {
      void refreshProviderSelectorChrome();
    }
  });
  window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, (event) => {
    const updatedHistoryKey = resolveChatHistoryKey(event?.detail?.historyKey);
    const visibleHistoryKey = getHistoryKey() || activeAgentId;
    if (!updatedHistoryKey || updatedHistoryKey !== visibleHistoryKey || !history) return;
    renderHistory(history, visibleHistoryKey, approvalHandler);
    refreshVisiblePendingAction?.();
  });

  wrapper.appendChild(toolbar);
  refreshChatPanelChrome = () => {
    void refreshProviderSelectorChrome();
  };

  // Chat history
  history = document.createElement('div');
  history.className = 'chat-history';
  history.id = 'chat-history';
  history.style.fontSize = '0.75rem';

  wrapper.appendChild(history);

  if (externalPendingClearHandler) {
    window.removeEventListener(CHAT_PENDING_CLEARED_EVENT, externalPendingClearHandler);
  }
  externalPendingClearHandler = () => {
    clearPendingUiState();
    renderHistory(history, getHistoryKey() || activeAgentId, approvalHandler);
    refreshVisiblePendingAction?.();
  };
  window.addEventListener(CHAT_PENDING_CLEARED_EVENT, externalPendingClearHandler);

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';

  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = 'Message Guardian - security-first, sandboxed tooling';
  input.id = 'chat-input';
  input.style.fontSize = '0.75rem';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-primary';
  sendBtn.textContent = 'Send';
  sendBtn.style.padding = '0.5rem 0.8rem';

  renderHistory(history, getHistoryKey() || activeAgentId, approvalHandler);

  // ── Helpers ──────────────────────────────────────────────────

  const getAgentId = () => resolveChatDispatchAgentId({
    hasInternalOnly: useProviderSelector,
    selectedAgentId: select?.value,
  });
  const getMessageMetadata = () => {
    const providerName = normalizeChatProviderSelection(providerSelect?.value || 'auto', routingState);
    const metadata = {};
    if (providerName !== 'auto') {
      metadata[CHAT_PROVIDER_SELECTION_METADATA_KEY] = {
        providerName,
      };
    }
    const targetSession = findTargetCodeSession(knownCodeSessions, targetCodeSessionId, currentCodeSessionId);
    const workspaceRoot = targetSession?.resolvedRoot || targetSession?.workspaceRoot || '';
    if (targetSession?.id && workspaceRoot) {
      metadata.codeContext = {
        sessionId: targetSession.id,
        workspaceRoot,
      };
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  };
  const getContextPrefix = () => `[Context: User is currently viewing the ${currentChatContext} panel] `;

  const restoreInput = () => {
    input.disabled = false;
    sendBtn.disabled = false;
    autoResizeChatInput(input);
    input.focus();
  };

  const setActiveRequest = (controller) => {
    activeRequestController = controller;
    stopBtn.disabled = !activeRequestController;
  };
  setActiveRequest(null);

  const cancelActiveRequest = async (reason = 'Request canceled by operator.') => {
    const active = activeRequestController;
    if (!active || !active.requestId) return false;

    setActiveRequest(null);
    clearPersistedActiveRequest(active.requestId);
    try {
      active.cancelLocal?.(reason);
    } catch (err) {
      console.warn('Local request cancel cleanup failed', err);
    }

    try {
      await api.cancelMessage(active.requestId, webUserId, 'web', active.agentId, reason);
    } catch (err) {
      console.warn('Remote request cancel failed', err);
    }
    return true;
  };

  stopBtn.addEventListener('click', async () => {
    await cancelActiveRequest('Request canceled by operator.');
  });

  const cancelRecoveredRequestOnLoad = async () => {
    const recovered = readPersistedActiveRequest();
    if (!recovered?.requestId) return;
    clearPersistedActiveRequest(recovered.requestId);
    try {
      await api.cancelMessage(
        recovered.requestId,
        recovered.userId || webUserId,
        recovered.channel || 'web',
        recovered.agentId,
        'Page reloaded; canceled previous in-flight request.',
      );
    } catch (err) {
      console.warn('Failed to cancel recovered in-flight request', err);
    }
  };
  void cancelRecoveredRequestOnLoad();

  resetBtn.addEventListener('click', async () => {
    const resetId = getHistoryKey();
    if (!resetId) return;
    await cancelActiveRequest('Chat reset requested by operator.');
    try {
      const apiAgentId = (useProviderSelector ? '__guardian__' : (select?.value || '')) === '__guardian__'
        ? (getChatProviderAgentId(chatAgents, routingState, providerSelect?.value) || chatAgents[0]?.id || 'default')
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
      deleteChatHistory(resetId);
      renderHistory(history, resetId, approvalHandler);
      refreshVisiblePendingAction?.();
    } catch (err) {
      console.error('Reset failed', err);
    }
  });

  const beginApprovalProgress = (tracking) => {
    const sessionId = typeof tracking?.codeSessionId === 'string' && tracking.codeSessionId.trim()
      ? tracking.codeSessionId.trim()
      : '';
    const requestId = typeof tracking?.requestId === 'string' && tracking.requestId.trim()
      ? tracking.requestId.trim()
      : '';
    if (!history) {
      return {
        setLabel: () => {},
        finish: () => {},
      };
    }

    input.disabled = true;
    sendBtn.disabled = true;

    const historyKey = getHistoryKey();
    const thinkingEl = createThinkingEl('Continuing after approval…');
    history.appendChild(thinkingEl);
    setActiveChatIndicator({
      historyKey,
      label: 'Continuing after approval…',
      timeline: null,
      element: thinkingEl,
    });
    history.scrollTop = history.scrollHeight;

    const onRunTimeline = (data) => {
      const matches = matchesRunTimelineRequest(data, {
        ...(requestId ? { requestId } : {}),
        ...(requestId ? { executionId: requestId } : {}),
        ...(sessionId ? { codeSessionId: sessionId } : {}),
      });
      if (!matches) return;
      updateActiveChatIndicatorTimeline(data);
      history.scrollTop = history.scrollHeight;
    };

    if (sessionId || requestId) {
      onSSE('run.timeline', onRunTimeline);
    }

    return {
      setLabel: (label) => updateActiveChatIndicatorLabel(label),
      finish: () => {
        if (sessionId || requestId) {
          offSSE('run.timeline', onRunTimeline);
        }
        clearActiveChatIndicator();
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
    const knownApprovals = chatHistory
      .filter((entry) => entry?.pendingAction)
      .flatMap((entry) => extractPendingActionApprovals(entry.pendingAction));
    const approvalLookup = new Map(knownApprovals.map((approval) => [approval.id, approval]));
    const focusedSessionId = currentCodeSessionId;
    const continuationRequestId = decision === 'approved' ? createClientRequestId() : '';
    const progress = decision === 'approved'
      ? beginApprovalProgress(resolveApprovalProgressTracking(
        knownApprovals.filter((approval) => approvalIds.includes(approval.id)),
        focusedSessionId,
        continuationRequestId,
      ))
      : null;

    try {
      const results = [];
      const approvalResponses = [];
      for (const id of approvalIds) {
        const approval = approvalLookup.get(id);
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
          results.push(buildApprovalContinuationSummaryPart(result, approval, decision));
        } catch (err) {
          approvalResponses.push({
            success: false,
            message: err.message || 'unknown error',
            continueConversation: false,
            transportError: true,
          });
          results.push(`Error: ${(approval?.toolName || 'tool')}: ${err.message || 'unknown'}`);
        }
      }

      const immediateMessages = approvalResponses
        .map((result) => result.displayMessage)
        .filter((value) => typeof value === 'string' && value.trim().length > 0);
      const continuedResponses = approvalResponses
        .map((result) => result.continuedResponse)
        .filter((value) => value && typeof value.content === 'string');
      const allSucceeded = approvalResponses.every((result) => result?.success !== false);
      const hasTransportFailures = approvalResponses.some((result) => result?.transportError === true);

      if (continuedResponses.length > 0) {
        let activitySummary = captureActiveChatActivitySummary();
        if (hasTransportFailures) {
          markApprovalUiError(approvalIds, results.join('; '));
        } else {
          markApprovalUiResolved(approvalIds, decision);
        }
        if (immediateMessages.length > 0) {
          addAgentMessage(immediateMessages.join('\n'));
        }
        for (const response of continuedResponses) {
          addAgentMessage(
            response.content,
            response.metadata?.pendingAction,
            response.metadata?.responseSource,
            activitySummary,
            response.metadata,
          );
          activitySummary = null;
        }
        history.scrollTop = history.scrollHeight;
        return;
      }

      // Only continue when the backend confirms there is suspended chat context to resume.
      const hasExplicitContinuationDirective = approvalResponses.some(
        (result) => result.continuedResponse || result.continueConversation !== undefined,
      );
      const needsSyntheticContinuation = decision === 'approved'
        && (
          approvalResponses.some((result) => result.continueConversation === true)
          || (!hasExplicitContinuationDirective && allSucceeded)
        );
      if (needsSyntheticContinuation) {
        progress?.setLabel('Finalizing response…');

        try {
          const summary = results.join('; ');
          const msg = getContextPrefix() + `[User approved the pending tool action(s). Result: ${summary}] ${allSucceeded ? 'Please continue with the current request only. Do not resume older unrelated pending tasks.' : 'Some actions failed — adjust your approach accordingly. Focus only on the current request.'}`;
          const metadata = getMessageMetadata();
          const response = await api.sendMessage(
            msg,
            getAgentId(),
            webUserId,
            'web',
            metadata,
            GUARDIAN_CHAT_SURFACE_ID,
            continuationRequestId,
          );
          if (hasTransportFailures) {
            markApprovalUiError(approvalIds, summary);
          } else {
            markApprovalUiResolved(approvalIds, decision);
          }
          addAgentMessage(
            response.content,
            response.metadata?.pendingAction,
            response.metadata?.responseSource,
            captureActiveChatActivitySummary(),
            response.metadata,
          );
        } catch (err) {
          if (hasTransportFailures) {
            markApprovalUiError(approvalIds, err instanceof Error ? err.message : String(err));
          } else {
            markApprovalUiResolved(approvalIds, decision);
          }
          history.appendChild(createMessageEl('error', err.message || 'Continuation failed'));
        }
        history.scrollTop = history.scrollHeight;
        return;
      }

      if (immediateMessages.length > 0) {
        if (hasTransportFailures) {
          markApprovalUiError(approvalIds, results.join('; '));
        } else {
          markApprovalUiResolved(approvalIds, decision);
        }
        addAgentMessage(immediateMessages.join('\n'));
        history.scrollTop = history.scrollHeight;
        return;
      }

      if (results.length > 0) {
        if (hasTransportFailures) {
          markApprovalUiError(approvalIds, results.join('; '));
        } else {
          markApprovalUiResolved(approvalIds, decision);
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
  const handleClearPending = async () => {
    await api.resetPendingAction(webUserId, 'web', GUARDIAN_CHAT_SURFACE_ID);
    window.dispatchEvent(new CustomEvent(CHAT_PENDING_CLEARED_EVENT));
  };
  approvalHandler = handleApproval;
  clearPendingUiHandler = handleClearPending;
  renderHistory(history, getHistoryKey() || activeAgentId, approvalHandler);

  /**
   * Append an agent message to the chat, with approval buttons when the
   * response includes structured pending approval data.
   */
  const addAgentMessage = (content, pendingAction, responseSource, activitySummary = null, metadata = null) => {
    const historyKey = getHistoryKey();
    const normalizedActivitySummary = mergeResponseActivitySummary(activitySummary, metadata);
    const chatHistory = getHistory(historyKey);
    const removedSynthetic = removeSyntheticPendingActionEntries(chatHistory);
    chatHistory.push({ role: 'agent', content, responseSource, pendingAction, activitySummary: normalizedActivitySummary });
    commitChatHistory(historyKey, { emit: false });
    if (removedSynthetic) {
      renderHistory(history, getHistoryKey(), approvalHandler);
      return;
    }
    history.appendChild(createMessageEl('agent', content, {
      pendingAction,
      responseSource,
      activitySummary: normalizedActivitySummary,
      onApproval: handleApproval,
      onClearPending: handleClearPending,
    }));
  };

  const resolvePendingActionForDisplay = async (metadata, options = {}) => {
    const direct = metadata?.pendingAction;
    if (direct && typeof direct === 'object') return direct;
    if (!shouldHydratePendingActionFromStore(metadata, options)) {
      return undefined;
    }
    try {
      const current = await api.currentPendingAction(webUserId, 'web', GUARDIAN_CHAT_SURFACE_ID);
      return current?.pendingAction && typeof current.pendingAction === 'object'
        ? current.pendingAction
        : undefined;
    } catch {
      return undefined;
    }
  };

  const ensureVisiblePendingAction = async () => {
    const historyKey = getHistoryKey();
    if (!historyKey || !history || activeChatIndicator) return;
    const chatHistory = getHistory(historyKey);
    const pendingAction = await resolvePendingActionForDisplay(undefined, { source: 'hydrate' });
    if (syncSyntheticPendingActionEntry(chatHistory, pendingAction)) {
      commitChatHistory(historyKey, { emit: false });
      renderHistory(history, historyKey, approvalHandler);
    }
  };
  refreshVisiblePendingAction = () => {
    void ensureVisiblePendingAction();
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
    commitChatHistory(historyKey, { emit: false });
    history.appendChild(createMessageEl('user', text));

    // Add thinking indicator
    const thinkingEl = createThinkingEl();
    history.appendChild(thinkingEl);
    setActiveChatIndicator({
      historyKey,
      label: 'Starting…',
      timeline: null,
      element: thinkingEl,
    });
    history.scrollTop = history.scrollHeight;

    try {
      const contextPrefix = getContextPrefix();
      const agentId = getAgentId();
      const requestId = createClientRequestId();
      const attachedSessionIdAtSend = currentCodeSessionId;
      const requestedCodeSessionId = targetCodeSessionId || currentCodeSessionId;
      let cleanedUp = false;
      let finalised = false;
      const clearActiveRequestIfCurrent = () => {
        if (activeRequestController?.requestId === requestId) {
          setActiveRequest(null);
        }
        clearPersistedActiveRequest(requestId);
      };

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        offSSE('run.timeline', onRunTimeline);
        offSSE('chat.done', onDone);
        offSSE('chat.error', onError);
      };

      const notifyTouchedCodeSessions = (metadata = null) => {
        const nextSessionId = normalizeCodeSessionId(metadata?.codeSessionId);
        const focusChanged = metadata?.codeSessionFocusChanged === true
          || metadata?.codeSessionDetached === true
          || (!attachedSessionIdAtSend && !!nextSessionId);
        if (focusChanged) {
          notifyCodeSessionFocus(nextSessionId);
        }
        const touchedSessionIds = new Set(
          [attachedSessionIdAtSend, requestedCodeSessionId, nextSessionId]
            .map((value) => normalizeCodeSessionId(value))
            .filter(Boolean),
        );
        if (focusChanged && touchedSessionIds.size === 0) {
          notifyCodeSessionsChanged({
            sessionId: nextSessionId,
            targetSessionId: targetCodeSessionId,
            surfaceId: GUARDIAN_CHAT_SURFACE_ID,
          });
          return;
        }
        for (const sessionId of touchedSessionIds) {
          notifyCodeSessionsChanged({
            sessionId,
            targetSessionId: targetCodeSessionId,
            surfaceId: GUARDIAN_CHAT_SURFACE_ID,
          });
        }
      };

      const finalizeSuccess = (data) => {
        if (finalised) return;
        finalised = true;
        cleanup();
        clearActiveRequestIfCurrent();
        const activitySummary = captureActiveChatActivitySummary({ forcePersist: true });
        clearActiveChatIndicator();
        restoreInput();
        Promise.resolve(resolvePendingActionForDisplay(data?.metadata, { source: 'response' }))
          .then((pendingAction) => {
            addAgentMessage(data.content || '', pendingAction, data.metadata?.responseSource, activitySummary, data.metadata);
            notifyTouchedCodeSessions(data?.metadata);
            history.scrollTop = history.scrollHeight;
          })
          .catch(() => {
            addAgentMessage(data.content || '', data.metadata?.pendingAction, data.metadata?.responseSource, activitySummary, data.metadata);
          });
      };

      const finalizeError = (message) => {
        if (finalised) return;
        finalised = true;
        cleanup();
        clearActiveRequestIfCurrent();
        const activitySummary = captureActiveChatActivitySummary();
        clearActiveChatIndicator();
        restoreInput();
        history.appendChild(createMessageEl('error', message || 'Stream error', { activitySummary }));
      };

      const onRunTimeline = (data) => {
        if (!matchesRunTimelineRequest(data, {
          requestId,
          executionId: requestId,
          codeSessionId: requestedCodeSessionId,
        })) {
          return;
        }
        updateActiveChatIndicatorTimeline(data);
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

      setActiveRequest({
        requestId,
        agentId,
        cancelLocal: () => {
          if (finalised) return;
          finalised = true;
          cleanup();
          clearActiveChatIndicator();
          restoreInput();
        },
      });
      persistActiveRequest({ requestId, agentId, userId: webUserId, channel: 'web' });

      try {
        const metadata = getMessageMetadata();
        const streamResult = await api.sendMessageStream(
          contextPrefix + text,
          agentId,
          webUserId,
          'web',
          metadata,
          requestId,
          GUARDIAN_CHAT_SURFACE_ID,
        );

        if (streamResult?.error) {
          finalizeError(streamResult.error);
        } else if (streamResult?.content) {
          finalizeSuccess(streamResult);
        }
      } catch {
        if (finalised) {
          return;
        }
        cleanup();
        const metadata = getMessageMetadata();
        const response = await api.sendMessage(
          contextPrefix + text,
          agentId,
          webUserId,
          'web',
          metadata,
          GUARDIAN_CHAT_SURFACE_ID,
          requestId,
        );
        clearActiveRequestIfCurrent();
        const activitySummary = captureActiveChatActivitySummary();
        clearActiveChatIndicator();
        addAgentMessage(response.content, response.metadata?.pendingAction, response.metadata?.responseSource, activitySummary, response.metadata);
        notifyTouchedCodeSessions(response?.metadata);
      }
    } catch (err) {
      setActiveRequest(null);
      clearPersistedActiveRequest();
      const activitySummary = captureActiveChatActivitySummary({ forcePersist: true });
      clearActiveChatIndicator();
      const errorMsg = err.message === 'AUTH_FAILED' ? 'Auth failed' : (err.message || 'Error');
      history.appendChild(createMessageEl('error', errorMsg, { activitySummary }));
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

  const composeMeta = document.createElement('div');
  composeMeta.className = 'chat-compose-meta';
  composeMeta.innerHTML = `
    <span class="chat-compose-meta__hint">Enter to send · Shift+Enter for newline</span>
    <span class="chat-compose-meta__context" data-role="context">request-scoped</span>
  `;
  wrapper.appendChild(composeMeta);

  inputArea.append(input, sendBtn);
  wrapper.appendChild(inputArea);

  const admissionBar = document.createElement('div');
  admissionBar.className = 'chat-admission-bar';
  admissionBar.setAttribute('aria-label', 'Guardian runtime pipeline');
  admissionBar.innerHTML = `
    <span class="chat-admission-bar__step"><span class="chat-admission-bar__dot"></span>Admission</span>
    <span class="chat-admission-bar__sep">›</span>
    <span class="chat-admission-bar__step"><span class="chat-admission-bar__dot"></span>Sandbox</span>
    <span class="chat-admission-bar__sep">›</span>
    <span class="chat-admission-bar__step"><span class="chat-admission-bar__dot"></span>Guardian</span>
    <span class="chat-admission-bar__sep">›</span>
    <span class="chat-admission-bar__step"><span class="chat-admission-bar__dot"></span>Output</span>
    <span class="chat-admission-bar__sep">›</span>
    <span class="chat-admission-bar__step"><span class="chat-admission-bar__dot"></span>Sentinel</span>
  `;
  wrapper.appendChild(admissionBar);

  container.appendChild(wrapper);
  autoResizeChatInput(input);
  input.focus();
  refreshVisiblePendingAction?.();
}

export function setChatContext(context) {
  currentChatContext = context;
  refreshChatPanelChrome?.();
  refreshVisiblePendingAction?.();
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
  return getChatHistory(resolveChatHistoryKey(agentId));
}

function normalizePendingActionId(pendingAction) {
  return typeof pendingAction?.id === 'string' ? pendingAction.id.trim() : '';
}

function isSyntheticPendingActionEntry(entry) {
  return entry?.syntheticPendingAction === true;
}

function removeSyntheticPendingActionEntries(chatHistory, keepPendingId = '') {
  let changed = false;
  for (let index = chatHistory.length - 1; index >= 0; index -= 1) {
    const entry = chatHistory[index];
    if (!isSyntheticPendingActionEntry(entry)) continue;
    const entryPendingId = normalizePendingActionId(entry.pendingAction);
    if (keepPendingId && entryPendingId === keepPendingId) {
      continue;
    }
    chatHistory.splice(index, 1);
    changed = true;
  }
  return changed;
}

function normalizePendingActionPromptForDisplay(pendingAction) {
  const rawPrompt = typeof pendingAction?.blocker?.prompt === 'string'
    ? pendingAction.blocker.prompt.trim()
    : '';
  if (rawPrompt && rawPrompt !== INTENT_GATEWAY_MISSING_SUMMARY) {
    return rawPrompt;
  }
  return summarizePendingActionBlocker(String(pendingAction?.blocker?.kind || '').trim());
}

function syncSyntheticPendingActionEntry(chatHistory, pendingAction) {
  const pendingId = normalizePendingActionId(pendingAction);
  let changed = removeSyntheticPendingActionEntries(chatHistory, pendingId);
  if (!pendingId || !pendingAction || typeof pendingAction !== 'object') {
    return changed;
  }

  const realEntryPresent = chatHistory.some((entry) => (
    !isSyntheticPendingActionEntry(entry)
    && normalizePendingActionId(entry?.pendingAction) === pendingId
  ));
  if (realEntryPresent) {
    const removedSameId = removeSyntheticPendingActionEntries(chatHistory);
    return changed || removedSameId;
  }

  const prompt = normalizePendingActionPromptForDisplay(pendingAction);
  const syntheticIndex = chatHistory.findIndex((entry) => (
    isSyntheticPendingActionEntry(entry)
    && normalizePendingActionId(entry.pendingAction) === pendingId
  ));
  if (syntheticIndex >= 0) {
    const existing = chatHistory[syntheticIndex];
    const promptChanged = existing.content !== prompt;
    const statusChanged = JSON.stringify(existing.pendingAction) !== JSON.stringify(pendingAction);
    if (promptChanged || statusChanged) {
      chatHistory[syntheticIndex] = {
        ...existing,
        role: 'agent',
        content: prompt,
        pendingAction,
        syntheticPendingAction: true,
      };
      changed = true;
    }
    return changed;
  }

  chatHistory.push({
    role: 'agent',
    content: prompt,
    pendingAction,
    syntheticPendingAction: true,
  });
  return true;
}

function clearPendingActionUiEntries(chatHistory) {
  let changed = removeSyntheticPendingActionEntries(chatHistory);
  for (const entry of chatHistory) {
    if (!entry?.pendingAction) {
      continue;
    }
    entry.pendingAction = undefined;
    changed = true;
  }
  return changed;
}

function clearPendingUiState() {
  for (const historyKey of listChatHistoryKeys()) {
    const chatHistory = getHistory(historyKey);
    clearPendingActionUiEntries(chatHistory);
    commitChatHistory(historyKey, { emit: false });
  }
}

function renderHistory(historyEl, agentId, onApproval) {
  historyEl.innerHTML = '';
  if (!agentId) return;
  setActiveChatHistoryKey(agentId);
  const chatHistory = getHistory(agentId);
  for (const msg of chatHistory) {
    historyEl.appendChild(createMessageEl(msg.role, msg.content, {
      pendingAction: msg.pendingAction,
      syntheticPendingAction: msg.syntheticPendingAction === true,
      responseSource: msg.responseSource,
      activitySummary: msg.activitySummary,
      onApproval,
      onClearPending: clearPendingUiHandler,
    }));
  }
  syncActiveChatIndicator(historyEl, agentId);
  historyEl.scrollTop = historyEl.scrollHeight;
}

function createThinkingEl(initialLabel = 'Starting…') {
  const el = document.createElement('div');
  el.className = 'chat-message agent is-thinking';
  el.innerHTML = `
    <div class="msg-header">Guardian</div>
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

function createLiveActivityItemEl(item, options = {}) {
  const itemEl = document.createElement('div');
  itemEl.className = `chat-live-activity__item ${options.trailing ? 'chat-live-activity__item--trail' : 'chat-live-activity__item--current'}`;

  const titleEl = document.createElement('div');
  titleEl.className = 'chat-live-activity__title';
  titleEl.textContent = String(item?.title || '').trim();
  itemEl.appendChild(titleEl);

  const detail = String(item?.detail || '').trim();
  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'chat-live-activity__detail';
    detailEl.textContent = detail;
    itemEl.appendChild(detailEl);
  }

  return itemEl;
}

function renderLiveActivityEl(activityEl, activitySummary) {
  if (!activityEl) return;
  const items = Array.isArray(activitySummary?.items)
    ? activitySummary.items.filter((item) => String(item?.title || '').trim())
    : [];
  const visibleItems = items.slice(-CHAT_LIVE_ACTIVITY_VISIBLE_ITEMS);
  activityEl.replaceChildren();
  if (visibleItems.length === 0) {
    activityEl.hidden = true;
    return;
  }
  activityEl.hidden = false;
  visibleItems.forEach((item, index) => {
    activityEl.appendChild(createLiveActivityItemEl(item, {
      trailing: index < visibleItems.length - 1,
    }));
  });
}

function shouldPersistActivitySummaryForStatus(status) {
  return status === 'awaiting_approval'
    || status === 'verification_pending'
    || status === 'blocked'
    || status === 'failed'
    || status === 'interrupted';
}

function normalizeActivitySummaryItems(items, maxItems) {
  return Array.isArray(items)
    ? items
      .filter((item) => String(item?.title || '').trim())
      .map((item) => ({
        title: String(item.title || '').trim(),
        detail: String(item.detail || '').trim(),
      }))
      .slice(-maxItems)
    : [];
}

function buildPersistedActivitySummary(activitySummary) {
  if (!activitySummary || activitySummary.persistent !== true) {
    return null;
  }
  const items = normalizeActivitySummaryItems(activitySummary.items, CHAT_PERSISTED_ACTIVITY_VISIBLE_ITEMS);
  if (items.length === 0) return null;
  return {
    label: String(activitySummary.label || '').trim(),
    items,
  };
}

function createPersistedLiveActivityEl(activitySummary) {
  const persisted = buildPersistedActivitySummary(activitySummary);
  const items = persisted?.items ?? [];
  if (items.length === 0) return null;

  const container = document.createElement('div');
  container.className = 'chat-live-activity chat-live-activity--persisted';

  for (const item of items) {
    container.appendChild(createLiveActivityItemEl(item));
  }

  return container;
}

function captureActiveChatActivitySummary(options = {}) {
  if (!activeChatIndicator?.timeline) return null;
  const run = activeChatIndicator.timeline;
  const summary = summarizeTimelineRun(run);
  const items = normalizeActivitySummaryItems(summary?.items, CHAT_PERSISTED_ACTIVITY_VISIBLE_ITEMS);
  if (items.length === 0) return null;
  const status = String(run?.summary?.status || '').trim();
  const persistent = options.forcePersist === true || shouldPersistActivitySummaryForStatus(status);
  if (!persistent) return null;
  return {
    label: String(summary?.label || '').trim(),
    items,
    persistent: true,
  };
}

function mergeResponseActivitySummary(activitySummary, metadata) {
  const semanticItem = buildSemanticResponseActivityItem(metadata);
  if (!semanticItem) return activitySummary;
  const items = Array.isArray(activitySummary?.items)
    ? activitySummary.items
      .filter((item) => String(item?.title || '').trim())
      .map((item) => ({
        title: String(item.title || '').trim(),
        detail: String(item.detail || '').trim(),
      }))
    : [];
  while (items.length > 0 && isTerminalSummaryLabel(items[items.length - 1]?.title)) {
    items.pop();
  }
  items.push(semanticItem);
  return {
    label: semanticItem.title,
    items,
  };
}

function buildSemanticResponseActivityItem(metadata) {
  const planner = metadata?.plannerExecution;
  if (planner && typeof planner === 'object') {
    const status = String(planner.status || '').trim();
    if (status === 'failed') {
      const failedNodes = Array.isArray(planner.failedNodes) ? planner.failedNodes : [];
      const firstDetail = typeof failedNodes[0]?.detail === 'string'
        ? failedNodes[0].detail.trim()
        : '';
      return {
        title: 'Failed',
        detail: firstDetail || 'Planner execution failed.',
      };
    }
    if (status === 'unsupported_actions') {
      return {
        title: 'Blocked',
        detail: 'Planner execution was blocked because the plan used unsupported actions.',
      };
    }
  }

  const pendingAction = metadata?.pendingAction;
  const pendingStatus = String(pendingAction?.status || '').trim();
  if (pendingAction && (pendingStatus === 'pending' || pendingStatus === 'resolving' || pendingStatus === 'running')) {
    const blockerKind = String(pendingAction?.blocker?.kind || '').trim();
    const prompt = String(pendingAction?.blocker?.prompt || '').trim();
    return {
      title: 'Blocked',
      detail: prompt || summarizePendingActionBlocker(blockerKind),
    };
  }

  return null;
}

function summarizePendingActionBlocker(blockerKind) {
  switch (blockerKind) {
    case 'approval':
      return 'Waiting for approval.';
    case 'clarification':
      return 'Waiting for clarification.';
    case 'workspace_switch':
      return 'Waiting for workspace switch.';
    case 'auth':
      return 'Waiting for authentication.';
    case 'policy':
      return 'Waiting for policy approval.';
    case 'missing_context':
      return 'Waiting for required context.';
    default:
      return 'Waiting for input.';
  }
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

  const summary = summarizeTimelineRun(run, { suppressTerminalStatus: true });
  labelEl.textContent = summary.label;
  renderLiveActivityEl(activityEl, summary);
}

function summarizeTimelineRun(run, options = {}) {
  const suppressTerminalStatus = options?.suppressTerminalStatus === true;
  const status = String(run?.summary?.status || '').trim();
  const liveSummary = run?.liveSummary;
  let liveSummaryItems = normalizeActivitySummaryItems(liveSummary?.items, CHAT_LIVE_ACTIVITY_VISIBLE_ITEMS);
  const liveSummaryLabel = String(liveSummary?.label || '').trim();
  if (suppressTerminalStatus && (status === 'completed' || status === 'failed')) {
    liveSummaryItems = liveSummaryItems.filter((item) => !isPrematureTerminalLiveSummaryItem(item, status));
  }
  if (liveSummaryItems.length > 0 || liveSummaryLabel) {
    return {
      label: liveSummaryItems[liveSummaryItems.length - 1]?.title
        || (suppressTerminalStatus && isTerminalTimelineStatus(status) ? 'Finalizing…' : liveSummaryLabel || 'Working…'),
      items: liveSummaryItems,
    };
  }

  const items = Array.isArray(run?.items) ? run.items : [];
  const recentItems = [];
  let lastKey = '';
  for (let index = items.length - 1; index >= 0 && recentItems.length < CHAT_LIVE_ACTIVITY_VISIBLE_ITEMS; index -= 1) {
    const item = items[index];
    if (!isMeaningfulLiveItem(item)) continue;
    const normalized = {
      title: String(item?.title || '').trim(),
      detail: String(item?.detail || '').trim(),
    };
    if (!normalized.title) continue;
    const key = `${normalized.title}\n${normalized.detail}`;
    if (key === lastKey) continue;
    recentItems.unshift(normalized);
    lastKey = key;
  }
  if (isTerminalTimelineStatus(status)) {
    while (recentItems.length > 0 && isGenericWorkingTimelineItem(recentItems[recentItems.length - 1])) {
      recentItems.pop();
    }
    if (suppressTerminalStatus && (status === 'completed' || status === 'failed')) {
      while (recentItems.length > 0 && isPrematureTerminalLiveSummaryItem(recentItems[recentItems.length - 1], status)) {
        recentItems.pop();
      }
    }
    if (recentItems.length === 0) {
      recentItems.push({
        title: suppressTerminalStatus && (status === 'completed' || status === 'failed')
          ? 'Finalizing…'
          : humanizeTimelineStatus(status),
        detail: '',
      });
    } else if (status === 'completed') {
      const completedLabel = humanizeTimelineStatus(status);
      if (!suppressTerminalStatus && recentItems[recentItems.length - 1]?.title !== completedLabel) {
        recentItems.push({
          title: completedLabel,
          detail: '',
        });
      }
    }
  }
  const latestItem = recentItems[recentItems.length - 1];
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
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return 'Working…';
  }
}

function isTerminalTimelineStatus(status) {
  return status === 'completed'
    || status === 'failed'
    || status === 'blocked'
    || status === 'awaiting_approval'
    || status === 'verification_pending';
}

function isGenericWorkingTimelineItem(item) {
  const title = String(item?.title || '').trim().toLowerCase();
  return title === 'agent is working' || title === 'working…' || title === 'working...';
}

function isTerminalSummaryLabel(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return normalized === 'completed' || normalized === 'failed' || normalized === 'blocked';
}

function isPrematureTerminalLiveSummaryItem(item, status) {
  const normalizedTitle = String(item?.title || '').trim().toLowerCase();
  if (!normalizedTitle) return false;
  if (normalizedTitle === humanizeTimelineStatus(status).toLowerCase()) return true;
  if (status === 'completed') {
    return normalizedTitle.endsWith(' completed');
  }
  if (status === 'failed') {
    return normalizedTitle.endsWith(' failed');
  }
  return false;
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
 * opts.pendingAction  — structured object from response.metadata.pendingAction
 * opts.onApproval     — callback(ids[], decision) for button clicks
 * opts.onClearPending — callback() for clearing a blocking pending request
 */
function createMessageEl(role, content, opts) {
  const msg = document.createElement('div');
  const normalizedRole = role === 'error' ? 'agent is-error' : role;
  msg.className = `chat-message ${normalizedRole}`;

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.textContent = role === 'user'
    ? 'You'
    : role === 'error'
      ? 'Guardian error'
      : 'Guardian';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const contentEl = document.createElement('div');
  contentEl.className = 'chat-msg-content';
  contentEl.style.whiteSpace = 'pre-wrap';
  renderLinkedText(contentEl, content);
  const sourceEl = role === 'user' ? null : buildSourceBadge(opts?.responseSource);
  if (sourceEl) {
    body.appendChild(sourceEl);
  }
  body.appendChild(contentEl);

  const activityEl = role === 'user' ? null : createPersistedLiveActivityEl(opts?.activitySummary);
  if (activityEl) {
    body.appendChild(activityEl);
  }

  // Render approval buttons from structured metadata (not text parsing)
  const approvals = extractPendingActionApprovals(opts?.pendingAction);
  if (approvals?.length && opts?.onApproval) {
    body.appendChild(buildApprovalButtons(approvals, opts.onApproval));
  } else if (canClearPendingActionFromChat(opts?.pendingAction, {
    syntheticPendingAction: opts?.syntheticPendingAction === true,
  }) && opts?.onClearPending) {
    body.appendChild(buildPendingActionClearControls(opts.pendingAction, opts.onClearPending));
  }

  msg.appendChild(header);
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
      actionLabel: typeof approval.actionLabel === 'string' ? approval.actionLabel : '',
      requestId: typeof approval.requestId === 'string' ? approval.requestId : '',
      codeSessionId: typeof approval.codeSessionId === 'string' ? approval.codeSessionId : '',
    }));
}

function resolveApprovalProgressTracking(approvals, fallbackCodeSessionId, fallbackRequestId) {
  const codeSessionId = approvals
    .map((approval) => typeof approval?.codeSessionId === 'string' ? approval.codeSessionId.trim() : '')
    .find(Boolean)
    || (typeof fallbackCodeSessionId === 'string' ? fallbackCodeSessionId.trim() : '');
  const requestId = approvals
    .map((approval) => typeof approval?.requestId === 'string' ? approval.requestId.trim() : '')
    .find(Boolean)
    || (typeof fallbackRequestId === 'string' ? fallbackRequestId.trim() : '');
  return {
    ...(requestId ? { requestId } : {}),
    ...(codeSessionId ? { codeSessionId } : {}),
  };
}

function buildSourceBadge(responseSource) {
  return createResponseSourceBadge(responseSource);
}

/**
 * Build the approval button row for one or more pending actions.
 */
function buildApprovalButtons(approvals, onApproval) {
  const container = document.createElement('div');
  container.className = 'chat-approval-card';
  const approvalIds = approvals.map((approval) => approval.id);
  const uiState = getApprovalUiGroupState(approvalIds);

  const summary = document.createElement('div');
  summary.className = 'chat-approval-card__summary';
  summary.textContent = describeApprovalGroupHeader(approvals);
  container.appendChild(summary);

  const detailList = document.createElement('div');
  detailList.className = 'chat-approval-card__list';
  describeApprovalActionList(approvals).forEach((description) => {
    const item = document.createElement('div');
    item.className = 'chat-approval-card__item';
    item.textContent = approvals.length === 1
      ? description
      : `• ${description}`;
    detailList.appendChild(item);
  });
  container.appendChild(detailList);

  const btnRow = document.createElement('div');
  btnRow.className = 'chat-approval-card__actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-primary';
  approveBtn.textContent = approvals.length > 1 ? `Approve All (${approvals.length})` : 'Approve';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn btn-danger';
  denyBtn.textContent = 'Deny';

  const statusEl = document.createElement('span');
  statusEl.className = 'chat-approval-card__status';

  const applyUiState = (state) => {
    if (!state) return false;
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    statusEl.className = 'chat-approval-card__status';
    if (state.status === 'processing') {
      statusEl.textContent = state.message || (state.decision === 'denied' ? 'Denying…' : 'Approving…');
      return true;
    }
    if (state.status === 'approved') {
      statusEl.textContent = state.message || 'Approved';
      statusEl.classList.add('is-success');
      return true;
    }
    if (state.status === 'denied') {
      statusEl.textContent = state.message || 'Denied';
      statusEl.classList.add('is-error');
      return true;
    }
    if (state.status === 'error') {
      approveBtn.disabled = false;
      denyBtn.disabled = false;
      statusEl.textContent = state.message || 'Approval update failed';
      statusEl.classList.add('is-error');
      return true;
    }
    return false;
  };

  const disable = () => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
  };

  approveBtn.addEventListener('click', async () => {
    const approvalIds = approvals.map((approval) => approval.id);
    disable();
    statusEl.textContent = 'Approving\u2026';
    statusEl.className = 'chat-approval-card__status';
    await onApproval(approvalIds, 'approved');
    applyUiState(getApprovalUiGroupState(approvalIds));
  });

  denyBtn.addEventListener('click', async () => {
    const approvalIds = approvals.map((approval) => approval.id);
    disable();
    statusEl.textContent = 'Denying\u2026';
    statusEl.className = 'chat-approval-card__status';
    await onApproval(approvalIds, 'denied');
    applyUiState(getApprovalUiGroupState(approvalIds));
  });

  btnRow.append(approveBtn, denyBtn, statusEl);
  applyUiState(uiState);
  container.appendChild(btnRow);
  return container;
}

function buildPendingActionClearControls(pendingAction, onClearPending) {
  const container = document.createElement('div');
  container.className = 'chat-pending-clear';

  const summary = document.createElement('div');
  summary.className = 'chat-pending-clear__summary';
  summary.textContent = 'This request is blocking the chat. Clear it if you want to move on.';
  container.appendChild(summary);

  const btnRow = document.createElement('div');
  btnRow.className = 'chat-pending-clear__actions';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-secondary';
  clearBtn.textContent = describePendingActionClearLabel(pendingAction);

  const statusEl = document.createElement('span');
  statusEl.className = 'chat-pending-clear__status';

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    statusEl.textContent = 'Clearing…';
    statusEl.className = 'chat-pending-clear__status';
    try {
      await onClearPending();
      statusEl.textContent = 'Cleared';
      statusEl.classList.add('is-success');
    } catch (error) {
      clearBtn.disabled = false;
      statusEl.textContent = error instanceof Error && error.message
        ? error.message
        : 'Failed to clear blocked request';
      statusEl.classList.add('is-error');
    }
  });

  btnRow.append(clearBtn, statusEl);
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

function basenameApprovalPath(path) {
  const normalized = String(path || '').trim();
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]+/g).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function isWeakApprovalActionLabel(label) {
  const normalized = String(label || '').trim();
  return !normalized
    || /\{\s*"/.test(normalized)
    || /^run\s+[a-z0-9 _-]+\s+-\s+/i.test(normalized)
    || normalized.length > 140;
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

function describeCodeCreateApproval(preview) {
  const parsed = parseApprovalPreview(preview);
  const path = String(parsed?.path || '').trim();
  if (!path) return null;
  return `Create ${basenameApprovalPath(path) || path}`;
}

function describeFilesystemMkdirApproval(preview) {
  const parsed = parseApprovalPreview(preview);
  const path = String(parsed?.path || '').trim();
  if (!path) return null;
  return `Create directory ${path}`;
}

function describePackageInstallApproval(preview) {
  const parsed = parseApprovalPreview(preview);
  if (!parsed) return null;
  const command = String(parsed.command || '').trim();
  const cwd = String(parsed.cwd || '').trim();
  if (!command) return cwd ? `Install packages in ${cwd}` : 'Install packages';
  const packages = command
    .replace(/^\s*(?:npm|pnpm|yarn|bun)\s+(?:install|add)\s+/i, '')
    .split(/\s+/g)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('-'));
  const packageList = packages.length > 0 ? packages.slice(0, 5).join(', ') : '';
  const moreSuffix = packages.length > 5 ? `, +${packages.length - 5} more` : '';
  const cwdSuffix = cwd ? ` in ${cwd}` : '';
  return packageList
    ? `Install packages${cwdSuffix}: ${packageList}${moreSuffix}`
    : `Run package install${cwdSuffix}`;
}

function describeApprovalAction(approval) {
  if (approval?.actionLabel && !isWeakApprovalActionLabel(approval.actionLabel)) {
    return sentenceCaseApprovalPreview(approval.actionLabel);
  }
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
  if (toolName === 'code_create') {
    return describeCodeCreateApproval(preview) || 'Create file';
  }
  if (toolName === 'fs_mkdir') {
    return describeFilesystemMkdirApproval(preview) || 'Create directory';
  }
  if (toolName === 'package_install') {
    return describePackageInstallApproval(preview) || 'Install packages';
  }
  if (preview) {
    return `${toolName}: ${preview}`;
  }
  return `Run ${toolName}`;
}

function describeApprovalGroupHeader(approvals) {
  if (
    approvals.length > 1
    && approvals.every((approval) => String(approval?.toolName || '').trim() === 'code_create')
  ) {
    return `Approval required to create ${approvals.length} files:`;
  }
  if (
    approvals.length > 1
    && approvals.every((approval) => String(approval?.toolName || '').trim() === 'fs_mkdir')
  ) {
    return `Approval required to create ${approvals.length} directories:`;
  }
  return approvals.length === 1
    ? 'Approval required for this action:'
    : `Approval required for these ${approvals.length} actions:`;
}

function describeApprovalActionList(approvals) {
  const counts = new Map();
  approvals.forEach((approval) => {
    const description = describeApprovalAction(approval);
    counts.set(description, (counts.get(description) || 0) + 1);
  });
  return [...counts.entries()].map(([description, count]) => (
    count > 1 ? `${description} (${count} duplicate requests)` : description
  ));
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
