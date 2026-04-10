import { describe, expect, it } from 'vitest';

import {
  isReferencedSession,
  normalizeReferencedSessionIds,
  normalizeTargetSessionId,
} from '../web/public/js/code-session-portfolio.js';

describe('web code session portfolio helpers', () => {
  const sessions = [
    { id: 'session-a' },
    { id: 'session-b' },
  ];

  it('normalizes referenced sessions against the available registry', () => {
    expect(normalizeReferencedSessionIds({
      referencedSessionIds: ['session-b', 'session-a', 'session-b', 'missing'],
      sessions,
      currentSessionId: 'session-a',
    })).toEqual(['session-b']);
  });

  it('treats only non-current normalized sessions as referenced', () => {
    expect(isReferencedSession('session-b', ['session-b'], 'session-a')).toBe(true);
    expect(isReferencedSession('session-a', ['session-a'], 'session-a')).toBe(false);
  });

  it('normalizes explicit target sessions against the current workspace and registry', () => {
    expect(normalizeTargetSessionId({
      targetSessionId: 'session-b',
      sessions,
      currentSessionId: 'session-a',
    })).toBe('session-b');
    expect(normalizeTargetSessionId({
      targetSessionId: 'session-a',
      sessions,
      currentSessionId: 'session-a',
    })).toBeNull();
    expect(normalizeTargetSessionId({
      targetSessionId: 'missing',
      sessions,
      currentSessionId: 'session-a',
    })).toBeNull();
  });
});
