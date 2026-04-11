import { describe, expect, it } from 'vitest';

import { canTestProviderConnection } from '../web/public/js/provider-editor-state.js';

describe('provider editor state', () => {
  it('allows connection tests only for saved provider profiles', () => {
    expect(canTestProviderConnection('xai-main', 'xai-main')).toBe(true);
    expect(canTestProviderConnection(null, 'xai-main')).toBe(false);
    expect(canTestProviderConnection('xai-main', 'xai-draft')).toBe(false);
    expect(canTestProviderConnection('   ', 'xai-main')).toBe(false);
  });
});
