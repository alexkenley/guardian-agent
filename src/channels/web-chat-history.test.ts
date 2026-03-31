import { describe, expect, it } from 'vitest';

import { resolveChatHistoryKey } from '../../web/public/js/chat-history.js';

describe('resolveChatHistoryKey', () => {
  it('uses one stable transcript key for the guardian chat surface', () => {
    expect(resolveChatHistoryKey('__guardian__')).toBe('__guardian__');
  });

  it('trims the base key and does not shard history by coding workspace', () => {
    expect(resolveChatHistoryKey('  __guardian__  ')).toBe('__guardian__');
    expect(resolveChatHistoryKey('relay')).toBe('relay');
  });

  it('returns an empty key for non-string input', () => {
    expect(resolveChatHistoryKey(null)).toBe('');
    expect(resolveChatHistoryKey(undefined)).toBe('');
  });
});
