import { describe, expect, it } from 'vitest';

import {
  getChatProviderAgentId,
  getChatProviderOptions,
  normalizeChatProviderSelection,
  shouldRefreshChatProviderOptions,
  shouldUseChatProviderSelector,
} from '../web/public/js/chat-mode-selector.js';

describe('chat provider selector', () => {
  it('uses the provider selector when one visible Guardian agent sits above tier-routing lanes', () => {
    const agents = [
      { id: 'default', name: 'Guardian Agent', canChat: true, internal: false },
      { id: 'local-lane', name: 'Local Lane', canChat: true, internal: true, routingRole: 'local' },
      { id: 'external-lane', name: 'External Lane', canChat: true, internal: true, routingRole: 'external' },
    ];
    const routingState = {
      providerOptions: [
        { value: 'auto', label: 'Automatic' },
        { value: 'ollama', label: 'Ollama (local)', providerLocality: 'local' },
        { value: 'ollama-cloud-direct', label: 'ollama-cloud-direct (managed cloud)', providerLocality: 'external' },
        { value: 'openai', label: 'OpenAI (frontier)', providerLocality: 'external' },
      ],
    };

    expect(shouldUseChatProviderSelector(agents, routingState)).toBe(true);
    expect(getChatProviderOptions(routingState)).toEqual(routingState.providerOptions);
    expect(normalizeChatProviderSelection('ollama-cloud-direct', routingState)).toBe('ollama-cloud-direct');
    expect(getChatProviderAgentId(agents, routingState, 'ollama')).toBe('local-lane');
    expect(getChatProviderAgentId(agents, routingState, 'openai')).toBe('external-lane');
  });

  it('keeps the classic agent dropdown when there are multiple visible chat agents', () => {
    const agents = [
      { id: 'default', name: 'Guardian Agent', canChat: true, internal: false },
      { id: 'research', name: 'Research Agent', canChat: true, internal: false },
      { id: 'local-lane', name: 'Local Lane', canChat: true, internal: true, routingRole: 'local' },
      { id: 'external-lane', name: 'External Lane', canChat: true, internal: true, routingRole: 'external' },
    ];
    const routingState = {
      providerOptions: [
        { value: 'auto', label: 'Automatic' },
        { value: 'ollama', label: 'Ollama (local)', providerLocality: 'local' },
        { value: 'openai', label: 'OpenAI (frontier)', providerLocality: 'external' },
      ],
    };

    expect(shouldUseChatProviderSelector(agents, routingState)).toBe(false);
  });

  it('normalizes invalid selections back to automatic', () => {
    const agents = [
      { id: 'default', name: 'Guardian Agent', canChat: true, internal: false },
    ];
    const routingState = {
      providerOptions: [
        { value: 'auto', label: 'Automatic' },
        { value: 'ollama', label: 'Ollama (local)', providerLocality: 'local' },
        { value: 'openai', label: 'OpenAI (frontier)', providerLocality: 'external' },
      ],
    };

    expect(shouldUseChatProviderSelector(agents, routingState)).toBe(true);
    expect(normalizeChatProviderSelection('missing-provider', routingState)).toBe('auto');
  });

  it('refreshes provider options when config or provider invalidations arrive', () => {
    expect(shouldRefreshChatProviderOptions({ topics: ['providers'] })).toBe(true);
    expect(shouldRefreshChatProviderOptions({ topics: ['config'] })).toBe(true);
    expect(shouldRefreshChatProviderOptions({ topics: ['tools'] })).toBe(false);
  });
});
