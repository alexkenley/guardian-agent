import type { AgentInstance } from '../../agent/types.js';
import type { DashboardAgentInfo, DashboardCallbacks } from '../../channels/web-types.js';
import type { GuardianAgentConfig, LLMConfig } from '../../config/types.js';
import type { MessageRouter } from '../message-router.js';

type AgentDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onAgents'
  | 'onAgentDetail'
>;

interface AgentDashboardCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  runtimeRegistry: {
    getAll(): AgentInstance[];
    get(agentId: string): AgentInstance | undefined;
  };
  router: Pick<MessageRouter, 'findAgentByRole'>;
  getProviderLocality: (llmCfg: Pick<LLMConfig, 'provider' | 'baseUrl'> | undefined) => 'local' | 'external' | undefined;
  internalAgentIds?: ReadonlySet<string>;
}

export function createAgentDashboardCallbacks(
  options: AgentDashboardCallbackOptions,
): AgentDashboardCallbacks {
  const getRoutingRole = (agentId: string): 'local' | 'external' | undefined => {
    if (options.router.findAgentByRole('local')?.id === agentId) {
      return 'local';
    }
    if (options.router.findAgentByRole('external')?.id === agentId) {
      return 'external';
    }
    return undefined;
  };

  const isInternalDashboardAgent = (agentId: string): boolean => (
    options.internalAgentIds?.has(agentId) === true || getRoutingRole(agentId) !== undefined
  );

  const toDashboardAgentInfo = (inst: AgentInstance): DashboardAgentInfo => {
    const providerName = inst.definition.providerName ?? options.configRef.current.defaultProvider;
    const providerConfig = options.configRef.current.llm[providerName];
    const routingRole = getRoutingRole(inst.agent.id);
    const providerLocality = options.getProviderLocality(providerConfig);
    return {
      id: inst.agent.id,
      name: inst.agent.name,
      state: inst.state,
      canChat: inst.agent.capabilities.handleMessages,
      internal: isInternalDashboardAgent(inst.agent.id),
      ...(routingRole ? { routingRole } : {}),
      capabilities: inst.definition.grantedCapabilities,
      provider: providerName,
      providerType: providerConfig?.provider,
      providerModel: providerConfig?.model,
      ...(providerLocality ? { providerLocality } : {}),
      schedule: inst.definition.schedule,
      lastActivityMs: inst.lastActivityMs,
      consecutiveErrors: inst.consecutiveErrors,
    };
  };

  return {
    onAgents: (): DashboardAgentInfo[] => (
      options.runtimeRegistry.getAll().map((inst) => toDashboardAgentInfo(inst))
    ),

    onAgentDetail: (id) => {
      const inst = options.runtimeRegistry.get(id);
      if (!inst) return null;
      return {
        ...toDashboardAgentInfo(inst),
        resourceLimits: { ...inst.definition.resourceLimits },
      };
    },
  };
}
