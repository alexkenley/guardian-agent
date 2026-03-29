import { describe, expect, it } from 'vitest';
import { resolveCodeSessionTarget } from './code-session-targets.js';

describe('resolveCodeSessionTarget', () => {
  const sessions = [
    {
      id: 'da47084e-7fde-4638-b77c-3f0bbb5c3684',
      title: 'Guardian Agent',
      workspaceRoot: 'S:\\Development\\GuardianAgent',
      resolvedRoot: 'S:\\Development\\GuardianAgent',
    },
    {
      id: 'c7633f8f-d504-448e-b688-1dc63d154791',
      title: 'TempInstallTest',
      workspaceRoot: 'S:\\Development\\GuardianAgent\\tmp\\guardian-ui-package-test',
      resolvedRoot: 'S:\\Development\\GuardianAgent\\tmp\\guardian-ui-package-test',
    },
  ];

  it('matches natural workspace phrasing against the saved session title', () => {
    const resolved = resolveCodeSessionTarget('Guardian agent workspace', sessions);
    expect(resolved.session?.title).toBe('Guardian Agent');
  });

  it('ignores filler words like "the" when matching a session target', () => {
    const resolved = resolveCodeSessionTarget('the Guardian agent workspace', sessions);
    expect(resolved.session?.title).toBe('Guardian Agent');
  });
});
