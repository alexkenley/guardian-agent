import { describe, expect, it } from 'vitest';

import {
  isViewingSession,
  resolveWorkbenchActiveSessionId,
} from '../web/public/js/code-session-workbench.js';

describe('code session workbench helpers', () => {
  it('treats a different active and attached session as viewing mode', () => {
    expect(isViewingSession('session-a', 'session-b')).toBe(true);
    expect(isViewingSession('session-a', 'session-a')).toBe(false);
    expect(isViewingSession(null, 'session-a')).toBe(false);
  });

  it('follows the current attached session across refresh by default', () => {
    expect(resolveWorkbenchActiveSessionId({
      sessionIds: ['session-a', 'session-b'],
      previousActiveSessionId: 'session-b',
      previousAttachedSessionId: 'session-a',
      serverCurrentSessionId: 'session-a',
    })).toBe('session-a');
  });

  it('falls back to the server current session when not viewing another session', () => {
    expect(resolveWorkbenchActiveSessionId({
      sessionIds: ['session-a', 'session-b'],
      previousActiveSessionId: 'session-a',
      previousAttachedSessionId: 'session-a',
      serverCurrentSessionId: 'session-b',
    })).toBe('session-b');
  });

  it('uses the preferred deep-linked session when one is requested', () => {
    expect(resolveWorkbenchActiveSessionId({
      sessionIds: ['session-a', 'session-b'],
      previousActiveSessionId: 'session-a',
      previousAttachedSessionId: 'session-a',
      serverCurrentSessionId: 'session-a',
      preferredCurrentSessionId: 'session-b',
    })).toBe('session-b');
  });
});
