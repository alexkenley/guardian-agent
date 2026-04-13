import { describe, expect, it } from 'vitest';

import { describeResponseSource } from '../../web/public/js/response-source.js';

describe('describeResponseSource', () => {
  it('infers managed-cloud tier labels from the provider name when providerTier is missing', () => {
    const source = describeResponseSource({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-coding',
      model: 'qwen3-coder-next',
    });

    expect(source.providerTier).toBe('managed_cloud');
    expect(source.label).toBe('managed cloud · ollama cloud · ollama-cloud-coding · qwen3-coder-next');
  });

  it('infers managed-cloud tier labels from the saved profile name when only the profile name is present', () => {
    const source = describeResponseSource({
      locality: 'external',
      providerProfileName: 'ollama-cloud',
    });

    expect(source.providerTier).toBe('managed_cloud');
    expect(source.label).toBe('managed cloud · ollama-cloud');
  });
});
