import { describe, expect, it } from 'vitest';

import {
  buildCodeSessionPortfolioAdditionalSection,
  normalizeReferencedCodeSessionIds,
} from './code-session-portfolio.js';

const CURRENT_SESSION = {
  id: 'current-session',
  title: 'Guardian Agent',
  resolvedRoot: '/mnt/s/Development/GuardianAgent',
  workState: {
    focusSummary: 'Finish the multi-workspace uplift.',
    workspaceProfile: { summary: 'Guardian Agent app.' },
    workspaceTrust: { state: 'trusted' },
    workspaceTrustReview: null,
  },
} as const;

const REFERENCED_SESSION = {
  id: 'referenced-session',
  title: 'Tactical Game',
  resolvedRoot: '/mnt/s/Development/TacticalGame',
  workState: {
    focusSummary: 'Compare repo structure only.',
    workspaceProfile: { summary: 'Game client workspace.' },
    workspaceTrust: { state: 'caution' },
    workspaceTrustReview: null,
  },
} as const;

describe('code session portfolio helpers', () => {
  it('normalizes referenced session ids against the available registry and current session', () => {
    expect(normalizeReferencedCodeSessionIds({
      referencedSessionIds: ['referenced-session', 'current-session', 'missing', 'referenced-session'],
      availableSessions: [CURRENT_SESSION, REFERENCED_SESSION],
      currentSessionId: 'current-session',
    })).toEqual(['referenced-session']);
  });

  it('builds a bounded prompt section for referenced workspaces', () => {
    expect(buildCodeSessionPortfolioAdditionalSection({
      currentSession: CURRENT_SESSION as never,
      referencedSessions: [REFERENCED_SESSION as never],
    })).toContain('referencedWorkspaceCount: 1');
    expect(buildCodeSessionPortfolioAdditionalSection({
      currentSession: CURRENT_SESSION as never,
      referencedSessions: [REFERENCED_SESSION as never],
    })).toContain('Tactical Game');
    expect(buildCodeSessionPortfolioAdditionalSection({
      currentSession: CURRENT_SESSION as never,
      referencedSessions: [REFERENCED_SESSION as never],
    })).toContain('Do not edit files');
  });
});
