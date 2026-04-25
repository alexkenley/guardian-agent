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
  enrichIntentGatewayRecordWithContentPlan,
  PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY,
  type IntentGateway,
  type IntentGatewayInput,
  type IntentGatewayRecord,
} from './intent-gateway.js';
import {
  attachSelectedExecutionProfileMetadata,
  findProviderByTier,
  selectExecutionProfile,
  type SelectedExecutionProfile,
} from './execution-profiles.js';
import { attachExecutionIdentityMetadata } from './execution-identity.js';
import { shouldAttachCodeSessionForRequest } from './code-session-request-scope.js';
import {
  readChatProviderSelectionMetadata,
  type RequestedChatProviderSelection,
} from './chat-provider-selection.js';
import { resolveConfiguredAgentId as resolveConfiguredAgentIdAlias } from './agent-target-resolution.js';
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
  executionId: string;
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
  resolveConfiguredAgentId?: (agentId?: string) => string | undefined;
  findProviderByLocality: (config: GuardianAgentConfig, locality: 'local' | 'external') => string | null | undefined;
  getCodeSessionSurfaceId: (args: {
    channel?: string;
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
  const resolveConfiguredAgentId = args.resolveConfiguredAgentId ?? ((agentId?: string) => (
    resolveConfiguredAgentIdAlias(agentId, {
      defaultAgentId: args.defaultAgentId,
      router: args.router,
    })
  ));

  const listClassifierProvidersForMode = (
    config: GuardianAgentConfig,
    mode: RoutingTierMode,
  ): string[] => {
    if (mode === 'local-only') {
      const local = findProviderByTier(config, 'local');
      return local
        ? [local]
        : [
            findProviderByTier(config, 'managed_cloud'),
            findProviderByTier(config, 'frontier'),
          ].filter((value): value is string => Boolean(value));
    }
    if (mode === 'managed-cloud-only') {
      const managedCloud = findProviderByTier(config, 'managed_cloud');
      return managedCloud
        ? ([
            managedCloud,
            findProviderByTier(config, 'frontier'),
          ].filter((value): value is string => Boolean(value)))
        : ([
            findProviderByTier(config, 'frontier'),
            findProviderByTier(config, 'local'),
          ].filter((value): value is string => Boolean(value)));
    }
    if (mode === 'frontier-only') {
      const frontier = findProviderByTier(config, 'frontier');
      return frontier
        ? ([
            frontier,
            findProviderByTier(config, 'managed_cloud'),
          ].filter((value): value is string => Boolean(value)))
        : ([
            findProviderByTier(config, 'managed_cloud'),
            findProviderByTier(config, 'local'),
          ].filter((value): value is string => Boolean(value)));
    }
    return [
      args.findProviderByLocality(config, 'external'),
      args.findProviderByLocality(config, 'local')
        ?? config.defaultProvider
        ?? null,
    ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  };

  const resolveRoutingStateAgentId = (preferredAgentId?: string): string => (
    args.resolveSharedStateAgentId(preferredAgentId)
    ?? ((args.router.findAgentByRole('local') || args.router.findAgentByRole('external'))
      ? SHARED_TIER_AGENT_STATE_ID
      : (preferredAgentId ?? args.defaultAgentId))
  );

  const classifyIntentForRouting = async (
    msg: IncomingDispatchMessage,
    stateAgentId: string,
    requestedProviderName?: string,
  ): Promise<IntentGatewayRecord | null> => {
    const normalizedContent = stripLeadingContextPrefix(msg.content);
    const channel = msg.channel?.trim() || 'web';
    const channelUserId = msg.userId?.trim() || `${channel}-user`;
    const canonicalUserId = args.identity.resolveCanonicalUserId(channel, channelUserId);
    const surfaceId = args.getCodeSessionSurfaceId({
      channel,
      surfaceId: msg.surfaceId,
      userId: canonicalUserId,
    });
    const currentConfig = args.configRef.current;
    const routingMode = args.normalizeTierModeForRouter(
      args.router,
      currentConfig,
      currentConfig.routing?.tierMode,
    );
    const classifierProviders = requestedProviderName?.trim()
      ? [requestedProviderName.trim()]
      : listClassifierProvidersForMode(currentConfig, routingMode);
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
    const recentHistory = args.conversations.getHistoryForContext({
      agentId: stateAgentId,
      userId: canonicalUserId,
      channel,
    });
    const classifyWithProvider = async (providerName: string | null): Promise<IntentGatewayRecord | null> => {
      if (!providerName) return null;
      const provider = args.runtime.getProvider(providerName);
      if (!provider) return null;
      const classified = await args.routingIntentGateway.classify(
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
      return enrichIntentGatewayRecordWithContentPlan(classified, normalizedContent);
    };

    let lastResult: IntentGatewayRecord | null = null;
    for (const providerName of classifierProviders) {
      lastResult = await classifyWithProvider(providerName);
      if (lastResult?.available) {
        return lastResult;
      }
    }
    return lastResult;
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
    const resolvedChannelDefault = resolveConfiguredAgentId(channelDefault);
    const channel = msg.channel?.trim() || 'web';
    const channelUserId = msg.userId?.trim() || `${channel}-user`;
    const canonicalUserId = args.identity.resolveCanonicalUserId(channel, channelUserId);
    const requestedCodeContext = args.readCodeRequestMetadata(msg.metadata);
    const normalizedContent = stripLeadingContextPrefix(msg.content);
    const requestedChatProvider = readChatProviderSelectionMetadata(msg.metadata, args.configRef.current);
    const routingCfg = args.configRef.current.routing;
    const tierMode = args.normalizeTierModeForRouter(args.router, args.configRef.current, routingCfg?.tierMode);
    const threshold = routingCfg?.complexityThreshold ?? 0.5;
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
    let classifiedGatewayPromise: Promise<IntentGatewayRecord | null> | null = null;
    const getGateway = (options: { force?: boolean } = {}): Promise<IntentGatewayRecord | null> => {
      if (resolvedChannelDefault && options.force !== true) {
        return Promise.resolve(null);
      }
      if (!classifiedGatewayPromise) {
        classifiedGatewayPromise = classifyIntentForRouting(
          msg,
          resolveRoutingStateAgentId(resolvedChannelDefault),
          requestedChatProvider?.providerName,
        );
      }
      return classifiedGatewayPromise;
    };
    const recordResolvedRoute = (
      decision: RouteDecision,
      gateway: IntentGatewayRecord | null,
      profile: SelectedExecutionProfile | null,
    ): void => {
      const selectedProviderModel = profile
        ? (
            args.configRef.current.llm[profile.providerName]?.model?.trim()
            || args.configRef.current.llm[profile.providerType]?.model?.trim()
            || undefined
          )
        : undefined;
      if (gateway) {
        recordIntentRoutingTrace('gateway_classified', {
          msg,
          requestId,
          details: {
            source: 'routing',
            mode: gateway.mode,
            available: gateway.available,
            promptProfile: gateway.promptProfile,
            route: gateway.decision.route,
            confidence: gateway.decision.confidence,
            operation: gateway.decision.operation,
            turnRelation: gateway.decision.turnRelation,
            resolution: gateway.decision.resolution,
            missingFields: gateway.decision.missingFields,
            plannedStepKinds: gateway.decision.plannedSteps?.map((step) => step.kind),
            executionClass: gateway.decision.executionClass,
            preferredTier: gateway.decision.preferredTier,
            requiresRepoGrounding: gateway.decision.requiresRepoGrounding,
            requiresToolSynthesis: gateway.decision.requiresToolSynthesis,
            expectedContextPressure: gateway.decision.expectedContextPressure,
            simpleVsComplex: gateway.decision.simpleVsComplex,
            preferredAnswerPath: gateway.decision.preferredAnswerPath,
            routeSource: gateway.decision.provenance?.route,
            operationSource: gateway.decision.provenance?.operation,
            workloadSources: gateway.decision.provenance
              ? {
                  executionClass: gateway.decision.provenance.executionClass,
                  preferredTier: gateway.decision.provenance.preferredTier,
                  requiresRepoGrounding: gateway.decision.provenance.requiresRepoGrounding,
                  requiresToolSynthesis: gateway.decision.provenance.requiresToolSynthesis,
                  expectedContextPressure: gateway.decision.provenance.expectedContextPressure,
                  preferredAnswerPath: gateway.decision.provenance.preferredAnswerPath,
                  simpleVsComplex: gateway.decision.provenance.simpleVsComplex,
                }
              : undefined,
            entitySources: gateway.decision.provenance?.entities,
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
          ...(requestedChatProvider?.providerName ? { requestedProviderName: requestedChatProvider.providerName } : {}),
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
            providerType: profile.providerType,
            ...(profile.providerName !== profile.providerType
              ? { providerProfileName: profile.providerName }
              : {}),
            ...(selectedProviderModel ? { providerModel: selectedProviderModel } : {}),
            providerTier: profile.providerTier,
            providerLocality: profile.providerLocality,
            executionProfileId: profile.id,
            requestedTier: profile.requestedTier,
            ...(profile.routingMode ? { routingMode: profile.routingMode } : {}),
            ...(profile.selectionSource ? { selectionSource: profile.selectionSource } : {}),
            reason: profile.reason,
            fallbackProviderOrder: profile.fallbackProviderOrder,
            ...(requestedChatProvider?.providerName ? { requestedProviderName: requestedChatProvider.providerName } : {}),
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
      currentTierMode: RoutingTierMode,
      forcedProviderName?: string,
    ): SelectedExecutionProfile | null => {
      if (!gateway && !decision.tier && !forcedProviderName) return null;
      return selectExecutionProfile({
        config: args.configRef.current,
        routeDecision: decision,
        gatewayDecision: gateway?.decision ?? null,
        mode: currentTierMode,
        forcedProviderName,
      });
    };
    const resolveForcedProviderDecision = (
      selection: RequestedChatProviderSelection | null,
    ): RouteDecision | null => {
      if (!selection?.providerName || !selection.providerLocality) return null;
      const localAgent = args.router.findAgentByRole('local');
      const externalAgent = args.router.findAgentByRole('external');
      if (selection.providerLocality === 'local') {
        if (localAgent) {
          return {
            agentId: localAgent.id,
            confidence: 'high',
            reason: `request-scoped provider override: ${selection.providerName}`,
            tier: 'local',
          };
        }
        if (externalAgent) {
          return {
            agentId: externalAgent.id,
            confidence: 'medium',
            reason: `request-scoped provider override: ${selection.providerName}; local lane unavailable, using external lane`,
            tier: 'local',
          };
        }
      }
      if (externalAgent) {
        return {
          agentId: externalAgent.id,
          confidence: 'high',
          reason: `request-scoped provider override: ${selection.providerName}`,
          tier: 'external',
        };
      }
      if (localAgent) {
        return {
          agentId: localAgent.id,
          confidence: 'medium',
          reason: `request-scoped provider override: ${selection.providerName}; external lane unavailable, using local lane`,
          tier: 'external',
        };
      }
      return null;
    };
    if (resolvedCodeSession) {
      const gateway = await getGateway({ force: true });
      const shouldApplyCodeSession = shouldAttachCodeSessionForRequest({
        content: normalizedContent,
        channel,
        surfaceId: resolvedSurfaceId,
        requestedCodeContext,
        resolvedCodeSession,
        gatewayDecision: gateway?.decision ?? null,
      });
      if (shouldApplyCodeSession) {
        const hasRoles = args.router.findAgentByRole('local') || args.router.findAgentByRole('external');
        const decision = resolvedChannelDefault
          ? { agentId: resolvedChannelDefault, confidence: 'high' as const, reason: 'channel default override' }
          : gateway && hasRoles
            ? args.router.routeWithTierFromIntent(gateway.decision, normalizedContent, tierMode, threshold)
            : hasRoles
              ? args.router.routeWithTier(normalizedContent, tierMode, threshold)
              : args.router.route(normalizedContent);
        const profile = selectProfileForResolvedRoute(
          decision,
          gateway,
          tierMode,
          requestedChatProvider?.providerName,
        );
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
    }
    if (requestedCodeContext?.workspaceRoot) {
      const gateway = await getGateway({ force: true });
      const hasRoles = args.router.findAgentByRole('local') || args.router.findAgentByRole('external');
      const decision = resolvedChannelDefault
        ? { agentId: resolvedChannelDefault, confidence: 'high' as const, reason: 'channel default override' }
        : gateway && hasRoles
          ? args.router.routeWithTierFromIntent(gateway.decision, normalizedContent, tierMode, threshold)
          : hasRoles
            ? args.router.routeWithTier(normalizedContent, tierMode, threshold)
            : args.router.route(normalizedContent);
      const profile = selectProfileForResolvedRoute(
        decision,
        gateway,
        tierMode,
        requestedChatProvider?.providerName,
      );
      const resolvedDecision = {
        ...decision,
        reason: 'code workspace context with gateway-first auto routing',
      };
      recordResolvedRoute(resolvedDecision, gateway, profile);
      return {
        decision: resolvedDecision,
        gateway,
      };
    }
    if (resolvedChannelDefault) {
      const decision = {
        agentId: resolvedChannelDefault,
        confidence: 'high' as const,
        reason: 'channel default override',
      };
      const profile = selectProfileForResolvedRoute(
        decision,
        null,
        tierMode,
        requestedChatProvider?.providerName,
      );
      recordResolvedRoute(decision, null, profile);
      return {
        decision,
        gateway: null,
      };
    }
    const hasRoles = args.router.findAgentByRole('local') || args.router.findAgentByRole('external');
    const gateway = await getGateway();
    const forcedDecision = resolveForcedProviderDecision(requestedChatProvider);
    const decision = forcedDecision
      ?? (gateway && hasRoles
        ? args.router.routeWithTierFromIntent(gateway.decision, normalizedContent, tierMode, threshold)
        : hasRoles
          ? args.router.routeWithTier(normalizedContent, tierMode, threshold)
          : args.router.route(normalizedContent));
    const profile = selectProfileForResolvedRoute(
      decision,
      gateway,
      tierMode,
      requestedChatProvider?.providerName,
    );
    recordResolvedRoute(decision, gateway, profile);
    return { decision, gateway };
  };

  return async (
    channelDefault: string | undefined,
    msg: IncomingDispatchMessage,
  ): Promise<PreparedIncomingDispatch> => {
    const requestId = msg.requestId?.trim() || randomUUID();
    const executionId = requestId;
    const requestedChatProvider = readChatProviderSelectionMetadata(msg.metadata, args.configRef.current);
    const resolvedChannelDefault = resolveConfiguredAgentId(channelDefault);
    recordIntentRoutingTrace('incoming_dispatch', {
      msg,
      requestId,
      details: {
        hasMetadata: !!msg.metadata,
        ...(resolvedChannelDefault ? { channelDefault: resolvedChannelDefault } : {}),
        ...(channelDefault && channelDefault !== resolvedChannelDefault
          ? { configuredChannelDefault: channelDefault }
          : {}),
        ...(requestedChatProvider?.providerName ? { requestedProviderName: requestedChatProvider.providerName } : {}),
      },
      contentPreview: stripLeadingContextPrefix(msg.content),
    });
    const routed = await resolveAgentForIncomingMessage(resolvedChannelDefault, msg, requestId);
    const sanitizedMetadata = isRecord(msg.metadata)
      ? Object.fromEntries(
          Object.entries(msg.metadata).filter(([key]) => key !== PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY),
        )
      : msg.metadata;
    const selectedProfile = routed.gateway || routed.decision.tier || requestedChatProvider
      ? selectExecutionProfile({
          config: args.configRef.current,
          routeDecision: routed.decision,
          gatewayDecision: routed.gateway?.decision ?? null,
          mode: args.normalizeTierModeForRouter(args.router, args.configRef.current, args.configRef.current.routing?.tierMode),
          forcedProviderName: requestedChatProvider?.providerName,
        })
      : null;
    const routedMetadata = attachSelectedExecutionProfileMetadata(
      attachExecutionIdentityMetadata(
        routed.gateway
          ? attachPreRoutedIntentGatewayMetadata(sanitizedMetadata, routed.gateway)
          : sanitizedMetadata,
        { executionId, rootExecutionId: executionId },
      ),
      selectedProfile,
    );
    if (routed.gateway) {
      recordIntentRoutingTrace('pre_routed_metadata_attached', {
        msg,
        requestId,
        agentId: routed.decision.agentId,
        details: {
          route: routed.gateway.decision.route,
          plannedStepKinds: routed.gateway.decision.plannedSteps?.map((step) => step.kind),
          selectedAgentId: routed.decision.agentId,
          ...(selectedProfile
            ? {
                selectedProviderName: selectedProfile.providerName,
                selectedProviderType: selectedProfile.providerType,
                ...(selectedProfile.providerName !== selectedProfile.providerType
                  ? { selectedProviderProfileName: selectedProfile.providerName }
                  : {}),
                ...(args.configRef.current.llm[selectedProfile.providerName]?.model?.trim()
                  || args.configRef.current.llm[selectedProfile.providerType]?.model?.trim()
                  ? {
                      selectedProviderModel: args.configRef.current.llm[selectedProfile.providerName]?.model?.trim()
                        || args.configRef.current.llm[selectedProfile.providerType]?.model?.trim(),
                    }
                  : {}),
                selectedProviderTier: selectedProfile.providerTier,
                executionProfileId: selectedProfile.id,
                ...(requestedChatProvider?.providerName ? { requestedProviderName: requestedChatProvider.providerName } : {}),
              }
            : {}),
        },
      });
    }
    return {
      requestId,
      executionId,
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
