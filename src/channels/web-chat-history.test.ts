import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class StorageMock {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

describe('web chat history', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('sessionStorage', new StorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses one stable transcript key for the guardian chat surface', async () => {
    const { resolveChatHistoryKey } = await import('../../web/public/js/chat-history.js');
    expect(resolveChatHistoryKey('__guardian__')).toBe('__guardian__');
  });

  it('trims the base key and does not shard history by coding workspace', async () => {
    const { resolveChatHistoryKey } = await import('../../web/public/js/chat-history.js');
    expect(resolveChatHistoryKey('  __guardian__  ')).toBe('__guardian__');
    expect(resolveChatHistoryKey('relay')).toBe('relay');
  });

  it('returns an empty key for non-string input', async () => {
    const { resolveChatHistoryKey } = await import('../../web/public/js/chat-history.js');
    expect(resolveChatHistoryKey(null)).toBe('');
    expect(resolveChatHistoryKey(undefined)).toBe('');
  });

  it('persists chat history entries across module reloads', async () => {
    const first = await import('../../web/public/js/chat-history.js');
    first.appendChatHistoryEntry('__guardian__', {
      role: 'agent',
      content: 'Blocked on approval.',
      pendingAction: { id: 'pending-1' },
    });

    expect(first.getChatHistory('__guardian__')).toEqual([
      expect.objectContaining({
        role: 'agent',
        content: 'Blocked on approval.',
        pendingAction: { id: 'pending-1' },
      }),
    ]);

    vi.resetModules();

    const second = await import('../../web/public/js/chat-history.js');
    expect(second.getChatHistory('__guardian__')).toEqual([
      expect.objectContaining({
        role: 'agent',
        content: 'Blocked on approval.',
        pendingAction: { id: 'pending-1' },
      }),
    ]);
  });

  it('appends continued approval responses into the active chat history and emits an update event', async () => {
    const {
      CHAT_HISTORY_UPDATED_EVENT,
      appendContinuedResponseToActiveChatHistory,
      getChatHistory,
      setActiveChatHistoryKey,
    } = await import('../../web/public/js/chat-history.js');

    const seen: string[] = [];
    window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, (event: Event) => {
      const customEvent = event as CustomEvent<{ historyKey?: string }>;
      seen.push(String(customEvent.detail?.historyKey ?? ''));
    });

    setActiveChatHistoryKey('__guardian__');
    const historyKey = appendContinuedResponseToActiveChatHistory({
      content: 'Waiting for approval to write the file.',
      metadata: {
        pendingAction: { id: 'pending-2', blocker: { kind: 'approval' } },
        responseSource: { locality: 'external', providerName: 'ollama_cloud' },
      },
    });

    expect(historyKey).toBe('__guardian__');
    expect(getChatHistory('__guardian__')).toEqual([
      expect.objectContaining({
        role: 'agent',
        content: 'Waiting for approval to write the file.',
        pendingAction: { id: 'pending-2', blocker: { kind: 'approval' } },
        responseSource: { locality: 'external', providerName: 'ollama_cloud' },
      }),
    ]);
    expect(seen).toEqual(['__guardian__']);
  });

  it('deletes stored history and emits an update event', async () => {
    const {
      CHAT_HISTORY_UPDATED_EVENT,
      appendChatHistoryEntry,
      deleteChatHistory,
      getChatHistory,
    } = await import('../../web/public/js/chat-history.js');

    const seen: string[] = [];
    window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, (event: Event) => {
      const customEvent = event as CustomEvent<{ historyKey?: string }>;
      seen.push(String(customEvent.detail?.historyKey ?? ''));
    });

    appendChatHistoryEntry('__guardian__', { role: 'agent', content: 'Temporary entry.' }, { emit: false });
    deleteChatHistory('__guardian__');

    expect(getChatHistory('__guardian__')).toEqual([]);
    expect(seen).toEqual(['__guardian__']);
  });
});
