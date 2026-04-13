import { describe, expect, it } from 'vitest';
import { resolveCodingBackendSessionTarget } from './coding-backend-session-target.js';

const SESSIONS = [
  {
    id: 'guardian',
    title: 'Guardian Agent',
    workspaceRoot: 'S:\\Development\\GuardianAgent',
    resolvedRoot: '/mnt/s/Development/GuardianAgent',
  },
  {
    id: 'tactical',
    title: 'Test Tactical Game App',
    workspaceRoot: 'S:\\Development\\TestApp',
    resolvedRoot: '/mnt/s/Development/TestApp',
  },
] as const;

describe('resolveCodingBackendSessionTarget', () => {
  it('returns none when no session target was mentioned', () => {
    expect(resolveCodingBackendSessionTarget({
      sessions: [...SESSIONS],
      currentSessionId: 'guardian',
    })).toEqual({
      status: 'none',
      currentSession: SESSIONS[0],
    });
  });

  it('returns current when the mentioned workspace matches the current attachment', () => {
    expect(resolveCodingBackendSessionTarget({
      sessions: [...SESSIONS],
      currentSessionId: 'guardian',
      requestedSessionTarget: 'Guardian Agent workspace',
    })).toEqual({
      status: 'current',
      currentSession: SESSIONS[0],
      targetSession: SESSIONS[0],
    });
  });

  it('returns current when the mentioned workspace matches the current attachment even if there are multiple ambiguous sessions', () => {
    expect(resolveCodingBackendSessionTarget({
      sessions: [
        ...SESSIONS,
        {
          id: 'guardian-old',
          title: 'Guardian Agent Old',
          workspaceRoot: 'S:\\Development\\GuardianAgent',
          resolvedRoot: '/mnt/s/Development/GuardianAgent',
        }
      ],
      currentSessionId: 'guardian',
      requestedSessionTarget: 'Guardian Agent workspace',
    })).toEqual({
      status: 'current',
      currentSession: SESSIONS[0],
      targetSession: SESSIONS[0],
    });
  });

  it('treats generic "current attached" targets as referring to the current attachment', () => {
    expect(resolveCodingBackendSessionTarget({
      sessions: [...SESSIONS],
      currentSessionId: 'guardian',
      requestedSessionTarget: 'current attached',
    })).toEqual({
      status: 'none',
      currentSession: SESSIONS[0],
    });
  });

  it('requires a switch when the mentioned workspace differs from the current attachment', () => {
    expect(resolveCodingBackendSessionTarget({
      sessions: [...SESSIONS],
      currentSessionId: 'guardian',
      requestedSessionTarget: 'Test Tactical Game App',
    })).toEqual({
      status: 'switch_required',
      currentSession: SESSIONS[0],
      targetSession: SESSIONS[1],
      requestedSessionTarget: 'Test Tactical Game App',
    });
  });

  it('returns unresolved when the mentioned workspace cannot be matched', () => {
    expect(resolveCodingBackendSessionTarget({
      sessions: [...SESSIONS],
      currentSessionId: 'guardian',
      requestedSessionTarget: 'Unknown Workspace',
    })).toEqual({
      status: 'target_unresolved',
      currentSession: SESSIONS[0],
      requestedSessionTarget: 'Unknown Workspace',
      error: 'No coding session matched "Unknown Workspace".',
    });
  });
});
