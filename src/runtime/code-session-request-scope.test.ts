import { describe, expect, it } from 'vitest';

import { shouldAttachCodeSessionForRequest } from './code-session-request-scope.js';

describe('shouldAttachCodeSessionForRequest', () => {
  const sharedSession = {
    session: {
      resolvedRoot: 'S:\\Development\\GuardianAgent',
    },
    attachment: {
      channel: 'web',
      surfaceId: 'code-panel',
    },
  };

  it('rejects shared code-session context for non-code requests that target an external path', () => {
    expect(shouldAttachCodeSessionForRequest({
      content: 'Create the directory D:\\Temp\\guardian-phase1-test\\phase1-fresh-a.',
      channel: 'web',
      surfaceId: 'second-brain',
      resolvedCodeSession: sharedSession,
      gatewayDecision: {
        route: 'filesystem_task',
        requiresRepoGrounding: false,
      },
    })).toBe(false);
  });

  it('keeps shared code-session context for repo-grounded requests on another surface', () => {
    expect(shouldAttachCodeSessionForRequest({
      content: 'Inspect src/runtime/incoming-dispatch.ts and summarize the routing logic.',
      channel: 'web',
      surfaceId: 'second-brain',
      resolvedCodeSession: sharedSession,
      gatewayDecision: {
        route: 'coding_task',
        requiresRepoGrounding: true,
      },
    })).toBe(true);
  });

  it('keeps local surface attachments even for non-code requests', () => {
    expect(shouldAttachCodeSessionForRequest({
      content: 'hello',
      channel: 'web',
      surfaceId: 'code-panel',
      resolvedCodeSession: sharedSession,
      gatewayDecision: {
        route: 'general_assistant',
        requiresRepoGrounding: false,
      },
    })).toBe(true);
  });
});
