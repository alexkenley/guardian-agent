import { describe, expect, it } from 'vitest';
import { composeGuardianSystemPrompt, GUARDIAN_CORE_SYSTEM_PROMPT } from './guardian-core.js';

describe('guardian-core prompt', () => {
  it('returns core prompt when no custom prompt is provided', () => {
    expect(composeGuardianSystemPrompt()).toBe(GUARDIAN_CORE_SYSTEM_PROMPT);
  });

  it('prepends core prompt before custom role instructions', () => {
    const combined = composeGuardianSystemPrompt('You specialize in software engineering tasks.');
    expect(combined).toContain('You are Guardian Agent, a security-first personal assistant.');
    expect(combined).toContain('Additional role instructions:');
    expect(combined).toContain('You specialize in software engineering tasks.');
  });

  it('injects soul guidance without replacing runtime safety precedence', () => {
    const combined = composeGuardianSystemPrompt(undefined, 'Act calm and methodical.');
    expect(combined).toContain('SOUL profile (identity/intent guidance):');
    expect(combined).toContain('Act calm and methodical.');
    expect(combined).toContain('must never override non-negotiable Guardian safety rules');
  });
});
