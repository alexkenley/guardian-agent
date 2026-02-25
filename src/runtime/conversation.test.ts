import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConversationService } from './conversation.js';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    rmSync(file, { force: true });
  }
});

function makeService() {
  const path = join(tmpdir(), `guardianagent-convo-${randomUUID()}.sqlite`);
  createdFiles.push(path);
  return new ConversationService({
    enabled: true,
    sqlitePath: path,
    maxTurns: 4,
    maxMessageChars: 1000,
    maxContextChars: 5000,
    retentionDays: 30,
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
});
