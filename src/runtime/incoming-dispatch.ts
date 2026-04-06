import { randomUUID } from 'node:crypto';
import type { GuardianAgentConfig, RoutingTierMode } from '../config/types.js';
import { stripLeadingContextPrefix } from '../chat-agent-helpers.js';
import { SHARED_TIER_AGENT_STATE_ID } from './agent-state-context.js';
import type { CodeSessionStore } from './code-sessions.js';
import type { ConversationService } from './conversation.js';
import type { ContinuityThreadStore } from './continuity-threads.js';
import type { IdentityService } from './identity.js';
import {
  attachPreRoutedIntentGatewayMetadata,
  PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY,
  type IntentGateway,
  type IntentGatewayInput,
  type IntentGatewayRecord,
} from './intent-gateway.js';
import {
  attachSelectedExecutionProfileMetadata,
  selectExecutionProfile,
  type SelectedExecutionProfile,
} from './execution-profiles.js';
import type { IntentRoutingTraceLog, IntentRoutingTraceStage } from './intent-routing-trace.js';
import type { MessageRouter, RouteDecision } from './message-router.js';
import type { PendingActionStore } from './pending-actions.js';
import type { Runtime } from './runtime.js';

export interface IncomingDispatchMessage {
  content: string;
  userId?: string;
  surfaceId?: string;
  principalId?: string;
  principalRole?: import('../tools/types.js').PrincipalRole;
  channel?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface ParsedCodeRequestMetadata {
  workspaceRoot?: string;
  sessionId?: string;
  fileReferences?: unknown[];
}

export interface PreparedIncomingDispatch {
  requestId: string;
  decision: RouteDecision;
  gateway: IntentGatewayRecord | null;
  routedMessage: IncomingDispatchMessage;
}

export type PrepareIncomingDispatch = (
  channelDefault: string | undefined,
  msg: IncomingDispatchMessage,
) => Promise<PreparedIncomingDispatch>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createIncomingDispatchPreparer(args: {
  defaultAgentId: string;
  configRef: { current: GuardianAgentConfig };
  router: MessageRouter;
  routingIntentGateway: Pick<IntentGateway, 'classify'>;
  runtime: Pick<Runtime, 'getProvider'>;
  identity: Pick<IdentityService, 'resolveCanonicalUserId'>;
  conversations: Pick<ConversationService, 'getHistoryForContext'>;
  pendingActionStore: Pick<PendingActionStore, 'resolveActiveForSurface'>;
  continuityThreadStore: Pick<ContinuityThreadStore, 'get'>;
  codeSessionStore: Pick<CodeSessionStore, 'resolveForRequest'>;
  intentRoutingTrace: Pick<IntentRoutingTraceLog, 'record'>;
  enabledManagedProviders?: Set<string>;
  availableCodingBackends?: string[];
  resolveSharedStateAgentId: (preferredAgentId?: string) => string | undefined;
  findProviderByLocality: (config: GuardianAgentConfig, locality: 'local' | 'external') => string | null | undefined;
  getCodeSessionSurfaceId: (args: {
    surfaceId?: string;
    userId?: string;
    principalId?: string;
  }) => string;
  readMessageSurfaceId: (value: unknown) => string | undefined;
  readCodeRequestMetadata: (metadata: unknown) => ParsedCodeRequestMetadata | undefined;
  normalizeTierModeForRouter: (
    router: MessageRouter,
    config: GuardianAgentConfig,
    mode: RoutingTierMode | undefined,
  ) => RoutingTierMode;
  summarizePendingActionForGateway: (
    value: ReturnType<PendingActionStore['resolveActiveForSurface']>,
  ) => IntentGatewayInput['pendingAction'];
  summarizeContinuityThreadForGateway: (
    value: ReturnType<ContinuityThreadStore['get']>,
  ) => IntentGatewayInput['continuity'];
  now?: () => number;
}): PrepareIncomingDispatch {
  const now = args.now ?? Date.now;
  const availableCodingBackends = args.availableCodingBackends ?? ['codex', 'claude-code', 'gemini-cli', 'aider'];

  const resolveRoutingStateAgentId = (preferredAgentId?: string): string => (
    args.resolveSharedStateAgentId(preferredAgentId)
    ?? ((args.router.findAgentByRole('local') || args.router.findAgentByRole('external'))
      ? SHARED_TIER_AGENT_STATE_ID
      : (preferredAgentId ?? args.defaultAgentId))
  );

  const classifyIntentForRouting = async (
    msg: IncomingDispatchMessage,
    stateAgentId: string,
  ): Promise<IntentGatewayRecord | null> => {
    const normalizedContent = stripLeadingContextPrefix(msg.content);
    const channel = msg.channel?.trim() || 'web';
    const channelUserId = msg.userId?.trim() || `${channel}-user`;
    const canonicalUserId = args.identity.resolveCanonicalUserId(channel, channelUserId);
    const surfaceId = args.getCodeSessionSurfaceId({
      surfaceId: msg.surfaceId,
      userId: canonicalUserId,
    });
    const currentConfig = args.configRef.current;
    const primaryProviderName = args.findProviderByLocality(currentConfig, 'local')
      ?? currentConfig.defaultProvider
      ?? args.findProviderByLocality(currentConfig, 'external')
      ?? null;
    const fallbackProviderName = args.findProviderByLocality(currentConfig, 'external');
    const recentHistory = args.conversations.getHistoryForContext({
      agentId: stateAgentId,
      userId: canonicalUserId,
      channel,
    }, {
      query: normalizedContent,
    });
    const pendingAction = args.pendingActionStore.resolveActiveForSurface({
      agentId: stateAgentId,
      userId: canonicalUserId,
      channel,
      surfaceId,
    });
    const continuity = args.continuityThreadStore.get({
      assistantId: stateAgentId,
      userId: canonicalUserId,
    });
    const classifyWithProvider = async (providerName: string | null): Promise<IntentGatewayRecord | null> => {
      if (!providerName) return null;
      const provider = args.runtime.getProvider(providerName);
      if (!provider) return null;
      return args.routingIntentGateway.classify(
        {
          content: normalizedContent,
          channel,
          recentHistory,
          pendingAction: args.summarizePendingActionForGateway(pendingAction),
          continuity: args.summarizeContinuityThreadForGateway(continuity),
          enabledManagedProviders: args.enabledManagedProviders ? [...args.enabledManagedProviders] : [],
          availableCodingBackends,
        },
        (messages, options) => provider.chat(messages, options),
      );
    };

    const primary = await classifyWithProvider(primaryProviderName);
    if (primary?.available) {
      return primary;
    }
    if (!fallbackProviderName || fallbackProviderName === primaryProviderName) {
      return primary;
    }
    const fallback = await classifyWithProvider(fallbackProviderName);
    return fallback?.available ? fallback : (primary ?? fallback);
  };

  const recordIntentRoutingTrace = (
    stage: IntentRoutingTraceStage,
    input: {
      msg: IncomingDispatchMessage;
      requestId?: string;
      agentId?: string;
      details?: Record<string, unknown>;
      contentPreview?: string;
    },
  ): void => {
    const channel = input.msg.channel?.trim() || 'web';
    const channelUserId = input.msg.userId?.trim() || `${channel}-user`;
    const canonicalUserId = args.identity.resolveCanonicalUserId(channel, channelUserId);
    const continuity = args.summarizeContinuityThreadForGateway(
      args.continuityThreadStore.get(
        {
          assistantId: resolveRoutingStateAgentId(input.agentId),
          userId: canonicalUserId,
        },
        now(),
      ),
    );
    const details = {
      ...(continuity?.continuityKey ? { continuityKey: continuity.continuityKey } : {}),
      ...(continuity?.activeExecutionRefs?.length ? { activeExecutionRefs: continuity.activeExecutionRefs } : {}),
      ...(typeof continuity?.linkedSurfaceCount === 'number' ? { linkedSurfaceCount: continuity.linkedSurfaceCount } : {}),
      ...(input.details ?? {}),
    };
    args.intentRoutingTrace.record({
      stage,
      requestId: input.requestId,
      userId: input.msg.userId,
      channel: input.msg.channel,
      agentId: input.agentId,
      contentPreview: stripLeadingContextPrefix(input.contentPreview ?? input.msg.content),
      details: Object.keys(details).length > 0 ? details : undefined,
    });
  };

  const resolveAgentForIncomingMessage = async (
    channelDefault: string | undefined,
    msg: IncomingDispatchMessage,
    requestId?: string,
  ): Promise<{ decision: RouteDecision; gateway: IntentGatewayRecord | null }> => {
    const channel = msg.channel?.trim() || 'web';
    const channelUserId = msg.userId?.trim() || `${channel}-user`;
    const canonicalUserId = args.identity.resolveCanonicalUserId(channel, channelUserId);
    const requestedCodeContext = args.readCodeRequestMetadata(msg.metadata);
    const normalizedContent = stripLeadingContextPrefix(msg.content);
    const resolvedSurfaceId = args.getCodeSessionSurfaceId({
      surfaceId: msg.surfaceId ?? args.readMessageSurfaceId(msg.metadata),
      userId: canonicalUserId,
      principalId: msg.principalId,
    });
    const resolvedCodeSession = args.codeSessionStore.resolveForRequest({
      requestedSessionId: requestedCodeContext?.sessionId,
      userId: canonicalUserId,
      principalId: msg.principalId,
      channel,
      surfaceId: resolvedSurfaceId,
      touchAttachment: false,
    });
    const recordResolvedRoute = (
      decision: RouteDecision,
      gateway: IntentGatewayRecord | null,
      profile: SelectedExecutionProfile | null,
    ): void => {
      if (gateway) {
        recordIntentRoutingTrace('gateway_classified', {
          msg,
          requestId,
          details: {
            source: 'routing',
            mode: gateway.mode,
            available: gateway.available,
            route: gateway.decision.route,
            confidence: gateway.decision.confidence,
            operation: gateway.decision.operation,
            turnRelation: gateway.decision.turnRelation,
            resolution: gateway.decision.resolution,
            missingFields: gateway.decision.missingFields,
            executionClass: gateway.decision.executionClass,
            preferredTier: gateway.decision.preferredTier,
            requiresRepoGrounding: gateway.decision.requiresRepoGrounding,
            requiresToolSynthesis: gateway.decision.requiresToolSynthesis,
            expectedContextPressure: gateway.decision.expectedContextPressure,
            preferredAnswerPath: gateway.decision.preferredAnswerPath,
            emailProvider: gateway.decision.entities.emailProvider,
            codingBackend: gateway.decision.entities.codingBackend,
            latencyMs: gateway.latencyMs,
            model: gateway.model,
            rawResponsePreview: gateway.rawResponsePreview,
          },
        });
      }
      recordIntentRoutingTrace('tier_routing_decided', {
        msg,
        requestId,
        agentId: decision.agentId,
        details: {
          confidence: decision.confidence,
          reason: decision.reason,
          fallbackAgentId: decision.fallbackAgentId,
          complexityScore: decision.complexityScore,
          tier: decision.tier,
          route: gateway?.decision.route,
        },
      });
      if (profile) {
        recordIntentRoutingTrace('profile_selection_decided', {
          msg,
          requestId,
          agentId: decision.agentId,
          details: {
            route: gateway?.decision.route,
            providerName: profile.providerName,
            providerTier: profile.providerTier,
            providerLocality: profile.providerLocality,
            executionProfileId: profile.id,
            requestedTier: profile.requestedTier,
            reason: profile.reason,
            fallbackProviderOrder: profile.fallbackProviderOrder,
          },
        });
        recordIntentRoutingTrace('context_budget_decided', {
          msg,
          requestId,
          agentId: decision.agentId,
          details: {
            route: gateway?.decision.route,
            executionProfileId: profile.id,
            contextBudget: profile.contextBudget,
            toolContextMode: profile.toolContextMode,
            maxAdditionalSections: profile.maxAdditionalSections,
            maxRuntimeNotices: profile.maxRuntimeNotices,
            expectedContextPressure: profile.expectedContextPressure,
            preferredAnswerPath: profile.preferredAnswerPath,
          },
        });
      }
    };
    const selectProfileForResolvedRoute = (
      decision: RouteDecision,
      gateway: IntentGatewayRecord | null,
      tierMode: RoutingTierMode,
    ): SelectedExecutionProfile | null => {
      if (!gateway && !decision.tier) return null;
      return selectExecutionProfile({
        config: args.configRef.current,
        routeDecision: decision,
        gatewayDecision: gateway?.decision ?? null,
        mode: tierMode,
      });
    };
    if (resolvedCodeSession) {
      const pinnedAgentId = resolvedCodeSession.session.agentId?.trim();
      const localTierAgentId = args.router.findAgentByRole('local')?.id;
      const externalTierAgentId = args.router.findAgentByRole('external')?.id;
      const pinnedTierAgent = pinnedAgentId
        && (pinnedAgentId === localTierAgentId || pinnedAgentId === externalTierAgentId);
      if (pinnedAgentId && !pinnedTierAgent) {
        const decision = {
          agentId: pinnedAgentId,
          confidence: 'high' as const,
          reason: requestedCodeContext?.sessionId
            ? 'explicit coding session pinned to a specific agent'
            : 'attached coding session pinned to a specific agent',
        };
        recordResolvedRoute(decision, null, null);
        return {
          decision,
          gateway: null,
        };
      }
      const stateAgentId = resolveRoutingStateAgentId(channelDefault);
      const gateway = channelDefault
        ? null
        : await classifyIntentForRouting(msg, stateAgentId);
      const routingCfg = args.configRef.current.routing;
      const tierMode = args.normalizeTierModeForRouter(args.router, args.configRef.current, routingCfg?.tierMode);
      const threshold = routingCfg?.complexityThreshold ?? 0.5;
      const hasRoles = args.router.findAgentByRole('local') || args.router.findAgentByRole('external');
      const decision = channelDefault
        ? { agentId: channelDefault, confidence: 'high' as const, reason: 'channel default override' }
        : gateway?.available && hasRoles
          ? args.router.routeWithTierFromIntent(gateway.decision, normalizedContent, tierMode, threshold)
          : hasRoles
            ? args.router.routeWithTier(normalizedContent, tierMode, threshold)
            : args.router.route(normalizedContent);
      const profile = selectProfileForResolvedRoute(decision, gateway, tierMode);
      const resolvedDecision = {
        ...decision,
        reason: requestedCodeContext?.sessionId
          ? 'explicit attached coding session with gateway-first auto routing'
          : 'attached coding session with gateway-first auto routing',
      };
      recordResolvedRoute(resolvedDecision, gateway, profile);
      return {
        decision: resolvedDecision,
        gateway,
      };
    }
    if (requestedCodeContext?.workspaceRoot) {
      const decision = {
        agentId: args.router.findAgentByRole('local')?.id || channelDefault || args.defaultAgentId,
        confidence: 'high' as const,
        reason: 'code workspace context',
      };
      recordResolvedRoute(decision, null, null);
      return {
        decision,
        gateway: null,
      };
    }
    if (channelDefault) {
      const decision = {
        agentId: channelDefault,
        confidence: 'high' as const,
        reason: 'channel default override',
      };
      recordResolvedRoute(decision, null, null);
      return {
        decision,
        gateway: null,
      };
    }
    const routingCfg = args.configRef.current.routing;
    const tierMode = args.normalizeTierModeForRouter(args.router, args.configRef.current, routingCfg?.tierMode);
    const threshold = routingCfg?.complexityThreshold ?? 0.5;
    const hasRoles = args.router.findAgentByRole('local') || args.router.findAgentByRole('external');
    const stateAgentId = resolveRoutingStateAgentId(channelDefault);
    const gateway = await classifyIntentForRouting(msg, stateAgentId);
    const decision = gateway?.available && hasRoles
      ? args.router.routeWithTierFromIntent(gateway.decision, normalizedContent, tierMode, threshold)
      : hasRoles
        ? args.router.routeWithTier(normalizedContent, tierMode, threshold)
        : args.router.route(normalizedContent);
    const profile = selectProfileForResolvedRoute(decision, gateway, tierMode);
    recordResolvedRoute(decision, gateway, profile);
    return { decision, gateway };
  };

  return async (
    channelDefault: string | undefined,
    msg: IncomingDispatchMessage,
  ): Promise<PreparedIncomingDispatch> => {
    const requestId = msg.requestId?.trim() || randomUUID();
    recordIntentRoutingTrace('incoming_dispatch', {
      msg,
      requestId,
      details: {
        hasMetadata: !!msg.metadata,
        channelDefault,
      },
      contentPreview: stripLeadingContextPrefix(msg.content),
    });
    const routed = await resolveAgentForIncomingMessage(channelDefault, msg, requestId);
    const sanitizedMetadata = isRecord(msg.metadata)
      ? Object.fromEntries(
          Object.entries(msg.metadata).filter(([key]) => key !== PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY),
        )
      : msg.metadata;
    const selectedProfile = routed.gateway || routed.decision.tier
      ? selectExecutionProfile({
          config: args.configRef.current,
          routeDecision: routed.decision,
          gatewayDecision: routed.gateway?.decision ?? null,
          mode: args.normalizeTierModeForRouter(args.router, args.configRef.current, args.configRef.current.routing?.tierMode),
        })
      : null;
    const routedMetadata = attachSelectedExecutionProfileMetadata(
      routed.gateway
        ? attachPreRoutedIntentGatewayMetadata(sanitizedMetadata, routed.gateway)
        : sanitizedMetadata,
      selectedProfile,
    );
    if (routed.gateway) {
      recordIntentRoutingTrace('pre_routed_metadata_attached', {
        msg,
        requestId,
        agentId: routed.decision.agentId,
        details: {
          route: routed.gateway.decision.route,
          selectedAgentId: routed.decision.agentId,
          ...(selectedProfile
            ? {
                selectedProviderName: selectedProfile.providerName,
                selectedProviderTier: selectedProfile.providerTier,
                executionProfileId: selectedProfile.id,
              }
            : {}),
        },
      });
    }
    return {
      requestId,
      decision: routed.decision,
      gateway: routed.gateway,
      routedMessage: {
        content: msg.content,
        userId: msg.userId,
        surfaceId: msg.surfaceId,
        principalId: msg.principalId,
        principalRole: msg.principalRole,
        channel: msg.channel,
        metadata: routedMetadata,
        requestId,
      },
    };
  };
}
