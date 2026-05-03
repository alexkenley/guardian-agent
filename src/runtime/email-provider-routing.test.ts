import { describe, expect, it } from 'vitest';
import {
  applyContextualEmailProviderHint,
  getAmbiguousEmailProviderClarification,
} from './email-provider-routing.js';

const BOTH_MAIL_PROVIDERS = new Set(['gws', 'm365']);

describe('email-provider-routing', () => {
  it('asks for clarification on generic inbox reads when both mail providers are enabled', () => {
    expect(getAmbiguousEmailProviderClarification('Check my email.', BOTH_MAIL_PROVIDERS))
      .toContain('Which one do you want me to use?');
  });

  it('asks for clarification on generic compose requests when both mail providers are enabled', () => {
    expect(getAmbiguousEmailProviderClarification('Draft an email to alex@example.com.', BOTH_MAIL_PROVIDERS))
      .toContain('Google Workspace');
  });

  it('does not ask for clarification when Gmail is explicit', () => {
    expect(getAmbiguousEmailProviderClarification('Check my Gmail inbox.', BOTH_MAIL_PROVIDERS)).toBeNull();
  });

  it('does not ask for clarification when Outlook is explicit', () => {
    expect(getAmbiguousEmailProviderClarification('Check my Outlook email.', BOTH_MAIL_PROVIDERS)).toBeNull();
  });

  it('does not ask for clarification when only one mail provider is enabled', () => {
    expect(getAmbiguousEmailProviderClarification('Check my email.', new Set(['gws']))).toBeNull();
  });

  it('ignores general informational email questions', () => {
    expect(getAmbiguousEmailProviderClarification('Explain email authentication headers.', BOTH_MAIL_PROVIDERS)).toBeNull();
  });

  it('inherits the previously selected Outlook provider for mailbox follow-ups', () => {
    expect(applyContextualEmailProviderHint(
      'Check that it is in the drafts.',
      [
        { role: 'assistant', content: 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?' },
        { role: 'user', content: 'Use Outlook.' },
      ],
      BOTH_MAIL_PROVIDERS,
    )).toBe('Outlook / Microsoft 365 follow-up: Check that it is in the drafts.');
  });

  it('inherits the previously selected Gmail provider for mailbox follow-ups', () => {
    expect(applyContextualEmailProviderHint(
      'Open the drafts folder.',
      [
        { role: 'user', content: 'Draft a Gmail email to alex@example.com.' },
      ],
      BOTH_MAIL_PROVIDERS,
    )).toBe('Gmail / Google Workspace follow-up: Open the drafts folder.');
  });

  it('does not inherit stale provider context for fresh generic mailbox reads', () => {
    expect(applyContextualEmailProviderHint(
      'Check my email.',
      [
        { role: 'user', content: 'Check my Gmail inbox.' },
      ],
      BOTH_MAIL_PROVIDERS,
    )).toBe('Check my email.');
  });

  it('does not rewrite follow-ups when no prior provider is visible', () => {
    expect(applyContextualEmailProviderHint(
      'Check that it is in the drafts.',
      [],
      BOTH_MAIL_PROVIDERS,
    )).toBe('Check that it is in the drafts.');
  });
});
