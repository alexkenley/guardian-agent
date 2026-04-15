const CHAT_HISTORY_STORAGE_KEY = 'guardianagent_chat_history_v1';
const ACTIVE_CHAT_HISTORY_KEY = 'guardianagent_chat_active_history_v1';
export const CHAT_HISTORY_UPDATED_EVENT = 'guardian:chat-history-updated';

const chatHistoryByKey = new Map();
let cacheLoaded = false;

function canUseSessionStorage() {
  return typeof sessionStorage !== 'undefined' && sessionStorage !== null;
}

function readStoredHistoryMap() {
  if (!canUseSessionStorage()) return {};
  const raw = sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ensureChatHistoryCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const stored = readStoredHistoryMap();
  for (const [rawKey, rawEntries] of Object.entries(stored)) {
    const historyKey = resolveChatHistoryKey(rawKey);
    if (!historyKey || !Array.isArray(rawEntries)) continue;
    chatHistoryByKey.set(historyKey, rawEntries.filter((entry) => entry && typeof entry === 'object'));
  }
}

function persistChatHistoryCache() {
  if (!canUseSessionStorage()) return;
  const payload = {};
  for (const [historyKey, entries] of chatHistoryByKey.entries()) {
    if (!historyKey || !Array.isArray(entries) || entries.length === 0) continue;
    payload[historyKey] = entries;
  }
  try {
    sessionStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures; the in-memory cache remains authoritative for the current page.
  }
}

function emitChatHistoryUpdated(historyKey) {
  if (!historyKey || typeof CustomEvent === 'undefined' || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHAT_HISTORY_UPDATED_EVENT, {
    detail: { historyKey },
  }));
}

export function resolveChatHistoryKey(baseKey) {
  return typeof baseKey === 'string' ? baseKey.trim() : '';
}

export function getChatHistory(historyKey) {
  const normalizedKey = resolveChatHistoryKey(historyKey);
  if (!normalizedKey) return [];
  ensureChatHistoryCacheLoaded();
  if (!chatHistoryByKey.has(normalizedKey)) {
    chatHistoryByKey.set(normalizedKey, []);
  }
  return chatHistoryByKey.get(normalizedKey);
}

export function listChatHistoryKeys() {
  ensureChatHistoryCacheLoaded();
  return [...chatHistoryByKey.keys()];
}

export function commitChatHistory(historyKey, options = {}) {
  const normalizedKey = resolveChatHistoryKey(historyKey);
  if (!normalizedKey) return;
  ensureChatHistoryCacheLoaded();
  const emit = options.emit !== false;
  persistChatHistoryCache();
  if (emit) {
    emitChatHistoryUpdated(normalizedKey);
  }
}

export function deleteChatHistory(historyKey, options = {}) {
  const normalizedKey = resolveChatHistoryKey(historyKey);
  if (!normalizedKey) return;
  ensureChatHistoryCacheLoaded();
  if (!chatHistoryByKey.delete(normalizedKey)) return;
  const emit = options.emit !== false;
  persistChatHistoryCache();
  if (emit) {
    emitChatHistoryUpdated(normalizedKey);
  }
}

export function appendChatHistoryEntry(historyKey, entry, options = {}) {
  const normalizedKey = resolveChatHistoryKey(historyKey);
  if (!normalizedKey || !entry || typeof entry !== 'object') return null;
  const history = getChatHistory(normalizedKey);
  const nextEntry = {
    ...entry,
  };
  history.push(nextEntry);
  commitChatHistory(normalizedKey, options);
  return nextEntry;
}

export function setActiveChatHistoryKey(historyKey) {
  const normalizedKey = resolveChatHistoryKey(historyKey);
  if (!canUseSessionStorage()) return normalizedKey;
  try {
    if (normalizedKey) {
      sessionStorage.setItem(ACTIVE_CHAT_HISTORY_KEY, normalizedKey);
    } else {
      sessionStorage.removeItem(ACTIVE_CHAT_HISTORY_KEY);
    }
  } catch {
    // Ignore storage failures; callers can still continue with the returned key.
  }
  return normalizedKey;
}

export function getActiveChatHistoryKey() {
  if (!canUseSessionStorage()) return '';
  try {
    return resolveChatHistoryKey(sessionStorage.getItem(ACTIVE_CHAT_HISTORY_KEY));
  } catch {
    return '';
  }
}

export function appendContinuedResponseToActiveChatHistory(response, options = {}) {
  if (!response || typeof response.content !== 'string' || response.content.trim().length === 0) {
    return '';
  }
  const preferredKey = resolveChatHistoryKey(options.historyKey);
  const historyKey = preferredKey || getActiveChatHistoryKey() || '__guardian__';
  appendChatHistoryEntry(historyKey, {
    role: 'agent',
    content: response.content,
    responseSource: response.metadata?.responseSource,
    pendingAction: response.metadata?.pendingAction,
    activitySummary: null,
  }, options);
  return historyKey;
}
