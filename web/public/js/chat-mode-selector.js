export function getRoutingLaneAgents(agents) {
  const chatAgents = Array.isArray(agents) ? agents.filter((agent) => agent?.canChat !== false) : [];
  return {
    local: chatAgents.find((agent) => agent.routingRole === 'local') || null,
    external: chatAgents.find((agent) => agent.routingRole === 'external') || null,
  };
}

function getAvailableChatProviderOptions(routingState) {
  const options = Array.isArray(routingState?.providerOptions) ? routingState.providerOptions : [];
  if (options.length > 0) {
    return options.filter((option) => typeof option?.value === 'string' && option.value.trim());
  }
  return [{ value: 'auto', label: 'Automatic' }];
}

export function shouldUseChatProviderSelector(agents, routingState) {
  const chatAgents = Array.isArray(agents) ? agents.filter((agent) => agent?.canChat !== false) : [];
  const userAgents = chatAgents.filter((agent) => agent?.internal !== true);
  if (userAgents.length > 1) {
    return false;
  }
  return getAvailableChatProviderOptions(routingState)
    .filter((option) => option.value !== 'auto')
    .length > 1;
}

export function getChatProviderOptions(routingState) {
  return getAvailableChatProviderOptions(routingState);
}

export function shouldRefreshChatProviderOptions(payload) {
  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  return topics.includes('providers') || topics.includes('config');
}

export function normalizeChatProviderSelection(value, routingState) {
  const available = new Set(getAvailableChatProviderOptions(routingState).map((option) => option.value));
  return available.has(value) ? value : 'auto';
}

export function getChatProviderAgentId(agents, routingState, selection) {
  const { local, external } = getRoutingLaneAgents(agents);
  const selectedOption = getAvailableChatProviderOptions(routingState)
    .find((option) => option.value === selection);
  if (selectedOption?.providerLocality === 'local') return local?.id || external?.id;
  if (selectedOption?.providerLocality === 'external') return external?.id || local?.id;
  return local?.id || external?.id;
}
