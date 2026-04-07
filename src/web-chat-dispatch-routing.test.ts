import { describe, expect, it } from 'vitest';

import { resolveChatDispatchAgentId } from '../web/public/js/chat-dispatch-routing.js';

describe('resolveChatDispatchAgentId', () => {
  it('keeps unified routing on the shared dispatch path in internal-only mode', () => {
    expect(resolveChatDispatchAgentId({
      hasInternalOnly: true,
      selectedAgentId: 'external',
    })).toBeUndefined();
  });

  it('preserves explicit agent selection in classic multi-agent mode', () => {
    expect(resolveChatDispatchAgentId({
      hasInternalOnly: false,
      selectedAgentId: 'external',
    })).toBe('external');
  });

  it('returns undefined when no classic agent is selected', () => {
    expect(resolveChatDispatchAgentId({
      hasInternalOnly: false,
      selectedAgentId: '   ',
    })).toBeUndefined();
  });
});
