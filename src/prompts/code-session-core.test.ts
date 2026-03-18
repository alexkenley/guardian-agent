import { describe, expect, it } from 'vitest';
import { CODE_SESSION_CORE_SYSTEM_PROMPT, composeCodeSessionSystemPrompt } from './code-session-core.js';

describe('code-session-core prompt', () => {
  it('returns the standalone coding-session prompt', () => {
    expect(composeCodeSessionSystemPrompt()).toBe(CODE_SESSION_CORE_SYSTEM_PROMPT);
  });

  it('does not inherit Guardian host identity text', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).not.toContain('You are Guardian Agent');
    expect(prompt).not.toContain('Guardian global memory');
    expect(prompt).not.toContain('broader Guardian tools');
    expect(prompt).not.toContain("assistant's global memory");
    expect(prompt).not.toContain('host-application context');
  });

  it('treats ambiguous references as the attached workspace by default', () => {
    const prompt = composeCodeSessionSystemPrompt();
    expect(prompt).toContain('"this app"');
    expect(prompt).toContain('refer to the attached workspace');
  });
});
