import { describe, expect, it } from 'vitest';

import {
  findCodeSessionById,
  formatChatCodeSessionOptionLabel,
  shouldShowChatCodeSessionControls,
  summarizeChatCodeSessionState,
} from '../web/public/js/chat-code-sessions.js';

describe('chat code session helpers', () => {
  const sessions = [
    {
      id: 'session-a',
      title: 'Workspace A',
      workspaceRoot: '/tmp/workspace-a',
    },
    {
      id: 'session-b',
      title: 'Workspace B',
      workspaceRoot: '/tmp/workspace-b',
    },
  ];

  it('formats coding workspace options with title and workspace root', () => {
    expect(formatChatCodeSessionOptionLabel(sessions[0])).toBe('Workspace A - /tmp/workspace-a');
  });

  it('finds the focused session from the registry', () => {
    expect(findCodeSessionById(sessions, 'session-b')).toEqual(sessions[1]);
    expect(findCodeSessionById(sessions, 'missing')).toBeNull();
  });

  it('summarizes the attached chat workspace state', () => {
    expect(summarizeChatCodeSessionState({
      sessions,
      currentSessionId: 'session-a',
    })).toEqual({
      badgeLabel: 'ATTACHED',
      badgeClassName: 'badge badge-info',
      summary: 'Workspace A',
      detail: '/tmp/workspace-a',
      currentSession: sessions[0],
      sessionCount: 2,
    });
  });

  it('summarizes the detached chat workspace state when sessions exist', () => {
    expect(summarizeChatCodeSessionState({
      sessions,
      currentSessionId: null,
    })).toEqual({
      badgeLabel: 'DETACHED',
      badgeClassName: 'badge badge-idle',
      summary: 'No coding workspace attached',
      detail: 'Select a workspace here or open Code to inspect session activity.',
      currentSession: null,
      sessionCount: 2,
    });
  });

  it('summarizes the empty registry state', () => {
    expect(summarizeChatCodeSessionState({
      sessions: [],
      currentSessionId: null,
    })).toEqual({
      badgeLabel: 'NONE',
      badgeClassName: 'badge badge-idle',
      summary: 'No coding workspaces yet',
      detail: 'Open Code to create the first coding workspace for Guardian chat.',
      currentSession: null,
      sessionCount: 0,
    });
  });

  it('keeps coding workspace controls off the Code route only', () => {
    expect(shouldShowChatCodeSessionControls('second-brain')).toBe(true);
    expect(shouldShowChatCodeSessionControls('code')).toBe(false);
    expect(shouldShowChatCodeSessionControls('second-brain', '#/code')).toBe(false);
  });
});
