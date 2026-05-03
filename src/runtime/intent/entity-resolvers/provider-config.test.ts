import { describe, expect, it } from 'vitest';
import { isExplicitProviderConfigRequest } from './provider-config.js';

describe('provider-config entity resolver', () => {
  it('detects explicit AI provider configuration requests', () => {
    expect(isExplicitProviderConfigRequest('List my configured AI providers.')).toBe(true);
    expect(isExplicitProviderConfigRequest('Show provider profiles and available models.')).toBe(true);
    expect(isExplicitProviderConfigRequest('Inspect the Ollama routing policy.')).toBe(true);
  });

  it('does not treat generic workspace provider wording as an AI provider request', () => {
    expect(isExplicitProviderConfigRequest(
      'Use Slack to list my channels. If Slack is not connected, just say so; do not use any other workspace provider.',
    )).toBe(false);
  });
});
