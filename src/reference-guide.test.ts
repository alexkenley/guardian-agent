import { describe, expect, it } from 'vitest';
import { formatGuideForPrompt } from './reference-guide.js';

describe('reference-guide prompt formatter', () => {
  it('formats a prompt-safe product guide summary for app usage questions', () => {
    const formatted = formatGuideForPrompt('How do I create a routine in Second Brain?');

    expect(formatted).toContain('Use this Guardian product and operator guide only when the user asks how to use Guardian');
    expect(formatted).toContain('Second Brain');
    expect(formatted).toContain('Routines');
  });

  it('keeps GitHub setup guidance neutral for technical users', () => {
    const formatted = formatGuideForPrompt('How do I set up GitHub OAuth client ID and secret?');

    expect(formatted).toContain('GitHub Integration');
    expect(formatted).toContain('Guardian does not ship with a built-in organization or repository target');
    expect(formatted).toContain('Add a repository target only when you want issue reporting or repo-specific actions');
    expect(formatted).toContain('http://127.0.0.1:18434/callback');
    expect(formatted).toContain('Generate a new client secret');
    expect(formatted).not.toContain('Threat-Vector-Security');
  });
});
