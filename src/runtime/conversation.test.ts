import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConversationService, type ConversationKey } from './conversation.js';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    rmSync(file, { force: true });
  }
});

function makeService(overrides?: Partial<ConstructorParameters<typeof ConversationService>[0]>) {
  const path = join(tmpdir(), `guardianagent-convo-${randomUUID()}.sqlite`);
  createdFiles.push(path);
  return new ConversationService({
    enabled: true,
    sqlitePath: path,
    maxTurns: 4,
    maxMessageChars: 1000,
    maxContextChars: 5000,
    retentionDays: 30,
    ...overrides,
  });
}

describe('ConversationService', () => {
  it('should persist turns and include history in built messages', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    service.recordTurn(key, 'hello', 'hi there');
    const messages = service.buildMessages(key, 'system prompt', 'follow-up');

    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toBe('hello');
    expect(messages[2].content).toBe('hi there');
    expect(messages[3].content).toBe('follow-up');
    service.close();
  });

  it('should list sessions and allow switching active session', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    service.recordTurn(key, 'message 1', 'reply 1');
    const first = service.getActiveSessionId(key);
    const second = service.rotateSession(key);
    service.recordTurn(key, 'message 2', 'reply 2');

    const sessions = service.listSessions('u1', 'web', 'assistant');
    expect(sessions.length).toBe(2);
    expect(sessions.some((s) => s.sessionId === second && s.isActive)).toBe(true);

    const switched = service.setActiveSession(key, first);
    expect(switched).toBe(true);
    const afterSwitch = service.listSessions('u1', 'web', 'assistant');
    expect(afterSwitch.some((s) => s.sessionId === first && s.isActive)).toBe(true);
    service.close();
  });

  it('should reset active conversation and start a new session', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    service.recordTurn(key, 'hello', 'hi');
    const before = service.getActiveSessionId(key);
    const removed = service.resetConversation(key);
    const after = service.getActiveSessionId(key);

    expect(removed).toBe(true);
    expect(after).not.toBe(before);
    service.close();
  });

  it('should preserve assistant response source metadata in session history', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    service.recordTurn(key, 'hello', 'hi there', {
      assistantResponseSource: {
        locality: 'external',
        providerName: 'anthropic',
        tier: 'external',
        usedFallback: true,
        notice: 'Retried on external.',
      },
    });

    const history = service.getSessionHistory(key);

    expect(history).toHaveLength(2);
    expect(history[0].responseSource).toBeUndefined();
    expect(history[1].responseSource).toEqual({
      locality: 'external',
      providerName: 'anthropic',
      tier: 'external',
      usedFallback: true,
      notice: 'Retried on external.',
    });
    service.close();
  });
});

describe('ConversationService FTS5 Search', () => {
  it('should search messages using full-text search', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    service.recordTurn(key, 'What is the capital of France?', 'The capital of France is Paris.');
    service.recordTurn(key, 'Tell me about TypeScript', 'TypeScript is a typed superset of JavaScript.');
    service.recordTurn(key, 'How is the weather?', 'I cannot check the weather in real time.');

    const results = service.searchMessages('capital France');
    if (service.hasFTS) {
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes('Paris'))).toBe(true);
    }
    service.close();
  });

  it('should filter search by userId', () => {
    const service = makeService();
    const key1 = { agentId: 'assistant', userId: 'alice', channel: 'web' };
    const key2 = { agentId: 'assistant', userId: 'bob', channel: 'web' };

    service.recordTurn(key1, 'Alice likes cats', 'Noted about cats.');
    service.recordTurn(key2, 'Bob likes dogs', 'Noted about dogs.');

    const results = service.searchMessages('likes', { userId: 'alice' });
    if (service.hasFTS) {
      expect(results.every((r) => r.userId === 'alice')).toBe(true);
    }
    service.close();
  });

  it('should return empty for non-matching queries', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    service.recordTurn(key, 'hello', 'world');
    const results = service.searchMessages('zyxwvutsrqp');
    expect(results).toHaveLength(0);
    service.close();
  });

  it('should respect limit parameter', () => {
    const service = makeService();
    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    for (let i = 0; i < 10; i++) {
      service.recordTurn(key, `test message ${i}`, `test reply ${i}`);
    }

    const results = service.searchMessages('test', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
    service.close();
  });

  it('should report hasFTS status', () => {
    const service = makeService();
    // On Node.js with SQLite support, FTS5 should be available
    expect(typeof service.hasFTS).toBe('boolean');
    service.close();
  });
});

describe('ConversationService Memory Flush', () => {
  it('should call onMemoryFlush when messages are dropped from context', () => {
    const flushedMessages: Array<{ key: ConversationKey; count: number }> = [];

    const service = makeService({
      maxContextChars: 100, // Very small to force trimming
      onMemoryFlush: (key, dropped) => {
        flushedMessages.push({ key, count: dropped.length });
      },
    });

    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };

    // Record enough turns to exceed maxContextChars
    service.recordTurn(key, 'First message with some substantial content about important things', 'First reply with equally substantial content about the topic');
    service.recordTurn(key, 'Second message with more substantial content', 'Second reply with more information');
    service.recordTurn(key, 'Third message about something new', 'Third reply with details');

    // Building messages should trigger flush for dropped messages
    service.buildMessages(key, 'system', 'new question');

    // At least one flush should have happened since context is small
    expect(flushedMessages.length).toBeGreaterThanOrEqual(1);
    if (flushedMessages.length > 0) {
      expect(flushedMessages[0].key.agentId).toBe('assistant');
      expect(flushedMessages[0].count).toBeGreaterThan(0);
    }
    service.close();
  });

  it('should not call onMemoryFlush when all messages fit in context', () => {
    let flushCalled = false;

    const service = makeService({
      maxContextChars: 50000, // Very large
      onMemoryFlush: () => {
        flushCalled = true;
      },
    });

    const key = { agentId: 'assistant', userId: 'u1', channel: 'web' };
    service.recordTurn(key, 'short', 'reply');
    service.buildMessages(key, 'system', 'question');

    expect(flushCalled).toBe(false);
    service.close();
  });
});
