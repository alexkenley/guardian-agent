import { describe, expect, it } from 'vitest';
import { applyCredentialRefInput } from './credential-ref-input.js';

describe('applyCredentialRefInput', () => {
  it('keeps an auto-created local credential ref when a new inline secret was provided', () => {
    const target: Record<string, unknown> = {
      braveCredentialRef: 'search.brave.local',
    };

    applyCredentialRefInput(target, 'braveCredentialRef', '', true);

    expect(target.braveCredentialRef).toBe('search.brave.local');
  });

  it('clears the credential ref when the UI explicitly disables it without a replacement secret', () => {
    const target: Record<string, unknown> = {
      braveCredentialRef: 'search.brave.local',
    };

    applyCredentialRefInput(target, 'braveCredentialRef', '', false);

    expect(target.braveCredentialRef).toBeUndefined();
  });

  it('accepts an explicit env-backed credential ref selection', () => {
    const target: Record<string, unknown> = {};

    applyCredentialRefInput(target, 'braveCredentialRef', 'search.brave.primary', false);

    expect(target.braveCredentialRef).toBe('search.brave.primary');
  });
});
