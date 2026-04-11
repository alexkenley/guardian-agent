import { describe, expect, it } from 'vitest';

import { sortConfiguredProviders } from '../web/public/js/provider-order.js';

describe('sortConfiguredProviders', () => {
  it('orders configured providers by local, managed cloud, then frontier', () => {
    const entries = [
      { name: 'z-frontier', provider: 'openai', locality: 'external', tier: 'frontier' },
      { name: 'b-managed', provider: 'ollama_cloud', locality: 'external', tier: 'managed_cloud' },
      { name: 'a-local', provider: 'ollama', locality: 'local', tier: 'local' },
      { name: 'a-frontier', provider: 'anthropic', locality: 'external', tier: 'frontier' },
      { name: 'a-managed', provider: 'ollama_cloud', locality: 'external', tier: 'managed_cloud' },
    ];

    expect(sortConfiguredProviders(entries).map((entry) => entry.name)).toEqual([
      'a-local',
      'a-managed',
      'b-managed',
      'a-frontier',
      'z-frontier',
    ]);
  });

  it('treats local locality as the highest-priority group even when tier metadata is missing', () => {
    const entries = [
      { name: 'frontier', provider: 'openai', locality: 'external', tier: 'frontier' },
      { name: 'local-runtime', provider: 'ollama', locality: 'local' },
    ];

    expect(sortConfiguredProviders(entries).map((entry) => entry.name)).toEqual([
      'local-runtime',
      'frontier',
    ]);
  });
});
