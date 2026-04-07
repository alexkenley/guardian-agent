import { describe, expect, it } from 'vitest';

import { persistRoutingTierModeInRawConfig } from './routing-mode-persistence.js';

describe('persistRoutingTierModeInRawConfig', () => {
  it('creates the routing block when it is missing', () => {
    expect(persistRoutingTierModeInRawConfig({}, 'managed-cloud-only')).toEqual({
      routing: {
        tierMode: 'managed-cloud-only',
      },
    });
  });

  it('preserves existing routing fields while updating tierMode', () => {
    expect(persistRoutingTierModeInRawConfig({
      routing: {
        strategy: 'keyword',
        complexityThreshold: 0.75,
        tierMode: 'auto',
      },
    }, 'frontier-only')).toEqual({
      routing: {
        strategy: 'keyword',
        complexityThreshold: 0.75,
        tierMode: 'frontier-only',
      },
    });
  });
});
