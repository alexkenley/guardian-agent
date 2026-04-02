import { randomUUID } from 'node:crypto';
import type { GuardianAgentConfig } from '../config/types.js';
import type { AnalyticsService } from './analytics.js';
import type { CodeSessionStore, ResolvedCodeSessionContext } from './code-sessions.js';
import type { IdentityService } from './identity.js';
import {
  PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY,
  attachPreRoutedIntentGatewayMetadata,
  type IntentGatewayRecord,
} from './intent-gateway.js';
import type { IncomingDispatchMessage, ParsedCodeRequestMetadata } from './incoming-dispatch.js';
import type { IntentRoutingTraceLog } from './intent-routing-trace.js';
import type { MessageRouter, RouteDecision } from './message-router.js';
import { readResponseSourceMetadata } from './model-routing-ux.js';
import type { AssistantDispatchContext, AssistantOrchestrator } from './orchestrator.js';
import type { Runtime } from './runtime.js';

interface LoggerLike {
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
}

interface DispatchResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface DashboardDispatchInput {
  agentId: string;
  msg: IncomingDispatchMessage;
  routeDecision?: RouteDecision;
  options?: {
    priority?: 'high' | 'normal' | 'low';
    requestType?: string;
    requestId?: string;
  };
  resolvedCodeSession?: ResolvedCodeSessionContext | null;
  precomputedIntentGateway?: IntentGatewayRecord | null;
}

export type DashboardMessageDispatcher = (args: DashboardDispatchInput) => Promise<DispatchResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createDashboardMessageDispatcher(args: {
  configRef: { current: GuardianAgentConfig };
  orchestrator: Pick<AssistantOrchestrator, 'dispatch'>;
  runtime: Pick<Runtime, 'dispatchMessage'>;
  analytics: Pick<AnalyticsService, 'track'>;
  router: Pick<MessageRouter, 'findAgentByRole'>;
  identity: Pick<IdentityService, 'resolveCanonicalUserId'>;
  codeSessionStore: Pick<CodeSessionStore, 'resolveForRequest'>;
  intentRoutingTrace: Pick<IntentRoutingTraceLog, 'record'>;
  getCodeSessionSurfaceId: (args: {
    surfaceId?: string;
    userId?: string;
    principalId?: string;
  }) => string;
  readCodeRequestMetadata: (metadata: unknown) => ParsedCodeRequestMetadata | undefined;
  createStructuredRequestError: (message: string, statusCode: number, errorCode: string) => Error;
  log: LoggerLike;
  now?: () => number;
}): DashboardMessageDispatcher {
  const now = args.now ?? Date.now;

  return async ({
    agentId,
    msg,
    routeDecision,
    options,
    resolvedCodeSession,
    precomputedIntentGateway,
  }: DashboardDispatchInput): Promise<DispatchResponse> => {
    const channel = msg.channel?.trim() || 'web';
    const channelUserId = msg.userId?.trim() || `${channel}-user`;
    const canonicalUserId = args.identity.resolveCanonicalUserId(channel, channelUserId);
    const priority = options?.priority ?? 'high';
    const requestType = options?.requestType?.trim() || 'chat';
    const requestedCodeContext = args.readCodeRequestMetadata(msg.metadata);
    const surfaceId = args.getCodeSessionSurfaceId({
      surfaceId: msg.surfaceId,
      userId: canonicalUserId,
      principalId: msg.principalId,
    });

    let dispatchCodeSession = resolvedCodeSession ?? null;
    if (!dispatchCodeSession) {
      dispatchCodeSession = args.codeSessionStore.resolveForRequest({
        requestedSessionId: requestedCodeContext?.sessionId,
        userId: canonicalUserId,
        principalId: msg.principalId ?? canonicalUserId,
        channel,
        surfaceId,
        touchAttachment: false,
      });
      if (requestedCodeContext?.sessionId && !dispatchCodeSession) {
        args.log.warn(
          {
            sessionId: requestedCodeContext.sessionId,
            userId: canonicalUserId,
            channel,
          },
          'Code session pre-resolution failed at dispatch',
        );
        throw args.createStructuredRequestError(
          `Code session '${requestedCodeContext.sessionId}' is unavailable for this request.`,
          409,
          'CODE_SESSION_UNAVAILABLE',
        );
      }
    }

    const dispatchUserId = dispatchCodeSession?.session.conversationUserId ?? canonicalUserId;
    const dispatchChannel = dispatchCodeSession?.session.conversationChannel ?? channel;
    const sanitizedIncomingMetadata = isRecord(msg.metadata)
      ? Object.fromEntries(
          Object.entries(msg.metadata).filter(([key]) => key !== PRE_ROUTED_INTENT_GATEWAY_METADATA_KEY),
        )
      : msg.metadata;
    const existingCodeContext = isRecord(msg.metadata?.codeContext)
      ? msg.metadata.codeContext
      : undefined;
    const baseMetadata = dispatchCodeSession
      ? {
          ...(sanitizedIncomingMetadata ?? {}),
          codeContext: {
            ...(existingCodeContext ?? {}),
            sessionId: dispatchCodeSession.session.id,
            workspaceRoot: dispatchCodeSession.session.resolvedRoot,
          },
        }
      : sanitizedIncomingMetadata;
    const effectiveMetadata = precomputedIntentGateway
      ? attachPreRoutedIntentGatewayMetadata(baseMetadata, precomputedIntentGateway)
      : baseMetadata;

    args.analytics.track({
      type: 'message_sent',
      channel,
      canonicalUserId,
      channelUserId,
      agentId,
      metadata: routeDecision?.tier ? { tier: routeDecision.tier, complexity: String(routeDecision.complexityScore ?? '') } : undefined,
    });

    const requestedTier = routeDecision?.tier
      ?? (args.router.findAgentByRole('local')?.id === agentId
        ? 'local'
        : args.router.findAgentByRole('external')?.id === agentId
          ? 'external'
          : undefined);
    const mergeResponseSourceMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      const existingResponseSource = metadata?.responseSource && typeof metadata.responseSource === 'object'
        ? metadata.responseSource as Record<string, unknown>
        : undefined;
      const locality = existingResponseSource?.locality === 'local' || existingResponseSource?.locality === 'external'
        ? existingResponseSource.locality
        : undefined;
      const providerName = typeof existingResponseSource?.providerName === 'string'
        ? existingResponseSource.providerName
        : undefined;
      const mismatchNotice = requestedTier && locality && requestedTier !== locality
        ? `Requested ${requestedTier} route, final response came from ${locality}${providerName ? ` (${providerName})` : ''}.`
        : undefined;
      const mergedMetadata: Record<string, unknown> = {
        ...(metadata ?? {}),
        ...((requestedTier || mismatchNotice)
          ? {
              responseSource: {
                ...(existingResponseSource ?? {}),
                ...(requestedTier ? { tier: requestedTier } : {}),
                ...(mismatchNotice && !existingResponseSource?.notice ? { notice: mismatchNotice } : {}),
              },
            }
          : {}),
      };
      delete mergedMetadata.pendingApprovals;
      return Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined;
    };
    const readResponseSourceTraceDetails = (metadata: Record<string, unknown> | undefined): {
      title: string;
      detail?: string;
      durationMs?: number;
    } | null => {
      const source = readResponseSourceMetadata(metadata);
      if (!source) return null;
      const usageParts = source.usage
        ? [
            `${source.usage.totalTokens} tokens`,
            `${source.usage.promptTokens} prompt`,
            `${source.usage.completionTokens} completion`,
            ...(typeof source.usage.cacheReadTokens === 'number' ? [`${source.usage.cacheReadTokens} cache read`] : []),
            ...(typeof source.usage.cacheCreationTokens === 'number' ? [`${source.usage.cacheCreationTokens} cache write`] : []),
          ]
        : [];
      const detailParts = [
        source.providerName ? `provider=${source.providerName}` : undefined,
        source.model ? `model=${source.model}` : undefined,
        source.locality ? `locality=${source.locality}` : undefined,
        typeof source.durationMs === 'number' ? `duration=${source.durationMs}ms` : undefined,
        source.usedFallback ? 'fallback=true' : undefined,
        ...(usageParts.length > 0 ? [usageParts.join(' | ')] : []),
        source.notice?.trim() ? source.notice.trim() : undefined,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const titleParts = [
        source.providerName?.trim() || 'model',
        source.model?.trim() || '',
        source.usedFallback ? 'fallback' : '',
      ].filter(Boolean);
      return {
        title: titleParts.length > 0 ? `Model response: ${titleParts.join(' • ')}` : 'Model response',
        ...(detailParts.length > 0 ? { detail: detailParts.join('; ') } : {}),
        ...(typeof source.durationMs === 'number' ? { durationMs: source.durationMs } : {}),
      };
    };
    const readContextAssemblyTraceDetails = (metadata: Record<string, unknown> | undefined): {
      summary?: string;
      detail?: string;
      memoryScope?: string;
      knowledgeBaseLoaded?: boolean;
      codingMemoryLoaded?: boolean;
      codingMemoryChars?: number;
      knowledgeBaseQueryPreview?: string;
      continuityKey?: string;
      activeExecutionRefs?: string[];
      linkedSurfaceCount?: number;
      selectedMemoryEntryCount?: number;
      omittedMemoryEntryCount?: number;
      contextCompactionApplied?: boolean;
      contextCharsBeforeCompaction?: number;
      contextCharsAfterCompaction?: number;
      contextCompactionStages?: string[];
      compactedSummaryPreview?: string;
      selectedMemoryEntries?: Array<{
        scope?: 'global' | 'coding_session';
        category: string;
        createdAt: string;
        preview: string;
        renderMode: 'full' | 'summary';
        queryScore: number;
        isContextFlush: boolean;
        matchReasons?: string[];
      }>;
    } | null => {
      const contextAssembly = metadata?.contextAssembly;
      if (!contextAssembly || typeof contextAssembly !== 'object') {
        return null;
      }
      const record = contextAssembly as Record<string, unknown>;
      return {
        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
        ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
        ...(typeof record.memoryScope === 'string' ? { memoryScope: record.memoryScope } : {}),
        ...(typeof record.knowledgeBaseLoaded === 'boolean' ? { knowledgeBaseLoaded: record.knowledgeBaseLoaded } : {}),
        ...(typeof record.codingMemoryLoaded === 'boolean' ? { codingMemoryLoaded: record.codingMemoryLoaded } : {}),
        ...(typeof record.codingMemoryChars === 'number' ? { codingMemoryChars: record.codingMemoryChars } : {}),
        ...(typeof record.knowledgeBaseQueryPreview === 'string' ? { knowledgeBaseQueryPreview: record.knowledgeBaseQueryPreview } : {}),
        ...(typeof record.continuityKey === 'string' ? { continuityKey: record.continuityKey } : {}),
        ...(Array.isArray(record.activeExecutionRefs)
          ? {
              activeExecutionRefs: record.activeExecutionRefs
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                .slice(0, 6),
            }
          : {}),
        ...(typeof record.linkedSurfaceCount === 'number' ? { linkedSurfaceCount: record.linkedSurfaceCount } : {}),
        ...(typeof record.selectedMemoryEntryCount === 'number' ? { selectedMemoryEntryCount: record.selectedMemoryEntryCount } : {}),
        ...(typeof record.omittedMemoryEntryCount === 'number' ? { omittedMemoryEntryCount: record.omittedMemoryEntryCount } : {}),
        ...(record.contextCompactionApplied === true ? { contextCompactionApplied: true } : {}),
        ...(typeof record.contextCharsBeforeCompaction === 'number'
          ? { contextCharsBeforeCompaction: record.contextCharsBeforeCompaction }
          : {}),
        ...(typeof record.contextCharsAfterCompaction === 'number'
          ? { contextCharsAfterCompaction: record.contextCharsAfterCompaction }
          : {}),
        ...(Array.isArray(record.contextCompactionStages)
          ? {
              contextCompactionStages: record.contextCompactionStages
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                .slice(0, 4),
            }
          : {}),
        ...(typeof record.compactedSummaryPreview === 'string'
          ? { compactedSummaryPreview: record.compactedSummaryPreview }
          : {}),
        ...(Array.isArray(record.selectedMemoryEntries)
          ? {
              selectedMemoryEntries: record.selectedMemoryEntries
                .filter((entry): entry is {
                  scope?: 'global' | 'coding_session';
                  category: string;
                  createdAt: string;
                  preview: string;
                  renderMode: 'full' | 'summary';
                  queryScore: number;
                  isContextFlush: boolean;
                  matchReasons?: string[];
                } => {
                  return !!entry
                    && typeof entry === 'object'
                    && typeof (entry as Record<string, unknown>).category === 'string'
                    && typeof (entry as Record<string, unknown>).createdAt === 'string'
                    && typeof (entry as Record<string, unknown>).preview === 'string'
                    && ((entry as Record<string, unknown>).renderMode === 'full' || (entry as Record<string, unknown>).renderMode === 'summary')
                    && typeof (entry as Record<string, unknown>).queryScore === 'number';
                })
                .map((entry) => ({
                  ...(entry.scope === 'global' || entry.scope === 'coding_session' ? { scope: entry.scope } : {}),
                  category: entry.category,
                  createdAt: entry.createdAt,
                  preview: entry.preview,
                  renderMode: entry.renderMode,
                  queryScore: entry.queryScore,
                  isContextFlush: entry.isContextFlush,
                  ...(Array.isArray(entry.matchReasons)
                    ? {
                        matchReasons: entry.matchReasons
                          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                          .slice(0, 3),
                      }
                    : {}),
                }))
                .slice(0, 4),
            }
          : {}),
      };
    };
    const addContextAssemblyTraceNode = (
      dispatchCtx: AssistantDispatchContext,
      metadata: Record<string, unknown> | undefined,
      startedAt: number,
      completedAt: number,
    ): void => {
      const details = readContextAssemblyTraceDetails(metadata);
      if (!details) return;
      dispatchCtx.addNode({
        kind: 'compile',
        name: 'Assembled context',
        startedAt,
        completedAt,
        status: 'succeeded',
        metadata: {
          ...details,
          detail: details.detail ?? details.summary,
        },
      });
    };
    const addResponseSourceTraceNode = (
      dispatchCtx: AssistantDispatchContext,
      metadata: Record<string, unknown> | undefined,
      completedAt: number,
    ): void => {
      const details = readResponseSourceTraceDetails(metadata);
      if (!details) return;
      const durationMs = typeof details.durationMs === 'number' ? details.durationMs : 0;
      dispatchCtx.addNode({
        kind: 'provider_call',
        name: details.title,
        startedAt: Math.max(0, completedAt - durationMs),
        completedAt,
        status: 'succeeded',
        metadata: {
          ...(details.detail ? { detail: details.detail } : {}),
        },
      });
    };
    const readDelegatedHandoffTraceDetails = (metadata: Record<string, unknown> | undefined): {
      summary?: string;
      reportingMode?: 'inline_response' | 'held_for_approval' | 'status_only' | 'held_for_operator';
      unresolvedBlockerKind?: string;
      approvalCount?: number;
      nextAction?: string;
    } | null => {
      const delegatedHandoff = metadata?.delegatedHandoff;
      if (!delegatedHandoff || typeof delegatedHandoff !== 'object') {
        return null;
      }
      const record = delegatedHandoff as Record<string, unknown>;
      return {
        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
        ...(record.reportingMode === 'inline_response'
          || record.reportingMode === 'held_for_approval'
          || record.reportingMode === 'status_only'
          || record.reportingMode === 'held_for_operator'
          ? { reportingMode: record.reportingMode }
          : {}),
        ...(typeof record.unresolvedBlockerKind === 'string'
          ? { unresolvedBlockerKind: record.unresolvedBlockerKind }
          : {}),
        ...(typeof record.approvalCount === 'number' ? { approvalCount: record.approvalCount } : {}),
        ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
      };
    };
    const addDelegatedHandoffTraceNode = (
      dispatchCtx: AssistantDispatchContext,
      metadata: Record<string, unknown> | undefined,
      startedAt: number,
      completedAt: number,
    ): void => {
      const details = readDelegatedHandoffTraceDetails(metadata);
      if (!details) return;
      dispatchCtx.addNode({
        kind: 'handoff',
        name: 'Delegated follow-up',
        startedAt,
        completedAt,
        status: details.reportingMode === 'inline_response'
          ? 'succeeded'
          : 'blocked',
        metadata: {
          ...details,
          detail: details.nextAction ?? details.summary,
        },
      });
    };

    return args.orchestrator.dispatch(
      {
        requestId: options?.requestId,
        agentId,
        userId: dispatchUserId,
        channel: dispatchChannel,
        content: msg.content,
        priority,
        requestType,
      },
      async (dispatchCtx) => {
        const message = {
          id: randomUUID(),
          userId: canonicalUserId,
          surfaceId,
          principalId: msg.principalId ?? canonicalUserId,
          principalRole: msg.principalRole ?? 'owner',
          channel,
          content: msg.content,
          metadata: effectiveMetadata,
          timestamp: now(),
        };

        try {
          dispatchCtx.markStep('message_built', `messageId=${message.id}`);
          const response = await dispatchCtx.runStep(
            'runtime_dispatch_message',
            async () => args.runtime.dispatchMessage(agentId, message),
            `agent=${agentId}`,
          );
          args.analytics.track({
            type: 'message_success',
            channel,
            canonicalUserId,
            channelUserId,
            agentId,
          });
          const mergedMetadata = mergeResponseSourceMetadata(response.metadata);
          const responseSource = readResponseSourceMetadata(mergedMetadata);
          const traceCompletedAt = now();
          addResponseSourceTraceNode(dispatchCtx, mergedMetadata, traceCompletedAt);
          addContextAssemblyTraceNode(dispatchCtx, mergedMetadata, message.timestamp, traceCompletedAt);
          addDelegatedHandoffTraceNode(dispatchCtx, mergedMetadata, message.timestamp, traceCompletedAt);
          const contextAssembly = readContextAssemblyTraceDetails(mergedMetadata);
          const delegatedHandoff = readDelegatedHandoffTraceDetails(mergedMetadata);
          args.intentRoutingTrace.record({
            stage: 'dispatch_response',
            requestId: dispatchCtx.requestId,
            messageId: message.id,
            userId: canonicalUserId,
            channel,
            agentId,
            contentPreview: response.content,
            details: {
              selectedAgentId: agentId,
              fallbackUsed: false,
              requestedTier,
              routeReason: routeDecision?.reason,
              responseLocality: responseSource?.locality,
              responseProviderName: responseSource?.providerName,
              ...(contextAssembly?.summary ? { contextAssemblySummary: contextAssembly.summary } : {}),
              ...(contextAssembly?.memoryScope ? { memoryScope: contextAssembly.memoryScope } : {}),
              ...(typeof contextAssembly?.knowledgeBaseLoaded === 'boolean'
                ? { knowledgeBaseLoaded: contextAssembly.knowledgeBaseLoaded }
                : {}),
              ...(typeof contextAssembly?.codingMemoryLoaded === 'boolean'
                ? { codingMemoryLoaded: contextAssembly.codingMemoryLoaded }
                : {}),
              ...(typeof contextAssembly?.codingMemoryChars === 'number'
                ? { codingMemoryChars: contextAssembly.codingMemoryChars }
                : {}),
              ...(contextAssembly?.continuityKey ? { continuityKey: contextAssembly.continuityKey } : {}),
              ...(contextAssembly?.activeExecutionRefs?.length ? { activeExecutionRefs: contextAssembly.activeExecutionRefs } : {}),
              ...(typeof contextAssembly?.linkedSurfaceCount === 'number'
                ? { linkedSurfaceCount: contextAssembly.linkedSurfaceCount }
                : {}),
              ...(typeof contextAssembly?.selectedMemoryEntryCount === 'number'
                ? { selectedMemoryEntryCount: contextAssembly.selectedMemoryEntryCount }
                : {}),
              ...(typeof contextAssembly?.omittedMemoryEntryCount === 'number'
                ? { omittedMemoryEntryCount: contextAssembly.omittedMemoryEntryCount }
                : {}),
              ...(contextAssembly?.contextCompactionApplied ? { contextCompactionApplied: true } : {}),
              ...(typeof contextAssembly?.contextCharsBeforeCompaction === 'number'
                ? { contextCharsBeforeCompaction: contextAssembly.contextCharsBeforeCompaction }
                : {}),
              ...(typeof contextAssembly?.contextCharsAfterCompaction === 'number'
                ? { contextCharsAfterCompaction: contextAssembly.contextCharsAfterCompaction }
                : {}),
              ...(contextAssembly?.contextCompactionStages?.length
                ? { contextCompactionStages: contextAssembly.contextCompactionStages }
                : {}),
              pendingApprovals: Array.isArray((mergedMetadata?.pendingAction as { blocker?: { approvalSummaries?: unknown[] } } | undefined)?.blocker?.approvalSummaries)
                ? (mergedMetadata?.pendingAction as { blocker: { approvalSummaries: unknown[] } }).blocker.approvalSummaries.length
                : 0,
              ...(delegatedHandoff?.reportingMode ? { delegatedReportingMode: delegatedHandoff.reportingMode } : {}),
              ...(delegatedHandoff?.unresolvedBlockerKind ? { delegatedBlockerKind: delegatedHandoff.unresolvedBlockerKind } : {}),
              ...(typeof delegatedHandoff?.approvalCount === 'number' ? { delegatedApprovalCount: delegatedHandoff.approvalCount } : {}),
            },
          });
          return {
            ...response,
            metadata: mergedMetadata,
          };
        } catch (err) {
          const routingCfg = args.configRef.current.routing;
          const fallbackEnabled = routingCfg?.fallbackOnFailure !== false;
          const fallbackId = routeDecision?.fallbackAgentId;
          if (fallbackEnabled && fallbackId) {
            const messageText = err instanceof Error ? err.message : String(err);
            args.log.warn(
              { primaryAgent: agentId, fallbackAgent: fallbackId, error: messageText },
              'Primary agent failed — falling back to alternate tier',
            );
            args.analytics.track({
              type: 'message_error',
              channel,
              canonicalUserId,
              channelUserId,
              agentId,
              metadata: { error: messageText, fallbackAttempt: 'true' },
            });
            try {
              const fallbackResponse = await dispatchCtx.runStep(
                'runtime_dispatch_fallback',
                async () => args.runtime.dispatchMessage(fallbackId, message),
                `fallback_agent=${fallbackId}`,
              );
              args.analytics.track({
                type: 'message_success',
                channel,
                canonicalUserId,
                channelUserId,
                agentId: fallbackId,
                metadata: { fallback: 'true' },
              });
              const mergedMetadata = mergeResponseSourceMetadata({
                ...(fallbackResponse.metadata ?? {}),
                fallback: true,
                responseSource: {
                  ...((fallbackResponse.metadata?.responseSource && typeof fallbackResponse.metadata.responseSource === 'object')
                    ? fallbackResponse.metadata.responseSource as Record<string, unknown>
                    : {}),
                  usedFallback: true,
                },
              });
              const responseSource = readResponseSourceMetadata(mergedMetadata);
              const traceCompletedAt = now();
              addResponseSourceTraceNode(dispatchCtx, mergedMetadata, traceCompletedAt);
              addContextAssemblyTraceNode(dispatchCtx, mergedMetadata, message.timestamp, traceCompletedAt);
              addDelegatedHandoffTraceNode(dispatchCtx, mergedMetadata, message.timestamp, traceCompletedAt);
              const contextAssembly = readContextAssemblyTraceDetails(mergedMetadata);
              const delegatedHandoff = readDelegatedHandoffTraceDetails(mergedMetadata);
              args.intentRoutingTrace.record({
                stage: 'dispatch_response',
                requestId: dispatchCtx.requestId,
                messageId: message.id,
                userId: canonicalUserId,
                channel,
                agentId: fallbackId,
                contentPreview: fallbackResponse.content,
                details: {
                  selectedAgentId: fallbackId,
                  fallbackUsed: true,
                  primaryAgentId: agentId,
                  requestedTier,
                  routeReason: routeDecision?.reason,
                  responseLocality: responseSource?.locality,
                  responseProviderName: responseSource?.providerName,
                  ...(contextAssembly?.summary ? { contextAssemblySummary: contextAssembly.summary } : {}),
                  ...(contextAssembly?.memoryScope ? { memoryScope: contextAssembly.memoryScope } : {}),
                  ...(typeof contextAssembly?.knowledgeBaseLoaded === 'boolean'
                    ? { knowledgeBaseLoaded: contextAssembly.knowledgeBaseLoaded }
                    : {}),
                  ...(contextAssembly?.continuityKey ? { continuityKey: contextAssembly.continuityKey } : {}),
                  ...(contextAssembly?.activeExecutionRefs?.length ? { activeExecutionRefs: contextAssembly.activeExecutionRefs } : {}),
                  ...(typeof contextAssembly?.linkedSurfaceCount === 'number'
                    ? { linkedSurfaceCount: contextAssembly.linkedSurfaceCount }
                    : {}),
                  ...(typeof contextAssembly?.selectedMemoryEntryCount === 'number'
                    ? { selectedMemoryEntryCount: contextAssembly.selectedMemoryEntryCount }
                    : {}),
                  ...(typeof contextAssembly?.omittedMemoryEntryCount === 'number'
                    ? { omittedMemoryEntryCount: contextAssembly.omittedMemoryEntryCount }
                    : {}),
                  ...(contextAssembly?.contextCompactionApplied ? { contextCompactionApplied: true } : {}),
                  ...(typeof contextAssembly?.contextCharsBeforeCompaction === 'number'
                    ? { contextCharsBeforeCompaction: contextAssembly.contextCharsBeforeCompaction }
                    : {}),
                  ...(typeof contextAssembly?.contextCharsAfterCompaction === 'number'
                    ? { contextCharsAfterCompaction: contextAssembly.contextCharsAfterCompaction }
                    : {}),
                  ...(contextAssembly?.contextCompactionStages?.length
                    ? { contextCompactionStages: contextAssembly.contextCompactionStages }
                    : {}),
                  ...(delegatedHandoff?.reportingMode ? { delegatedReportingMode: delegatedHandoff.reportingMode } : {}),
                  ...(delegatedHandoff?.unresolvedBlockerKind ? { delegatedBlockerKind: delegatedHandoff.unresolvedBlockerKind } : {}),
                  ...(typeof delegatedHandoff?.approvalCount === 'number' ? { delegatedApprovalCount: delegatedHandoff.approvalCount } : {}),
                },
              });
              return {
                ...fallbackResponse,
                metadata: mergedMetadata,
              };
            } catch (fallbackErr) {
              args.log.error(
                { fallbackAgent: fallbackId, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
                'Fallback agent also failed — propagating original error',
              );
            }
          }

          const messageText = err instanceof Error ? err.message : String(err);
          args.analytics.track({
            type: 'message_error',
            channel,
            canonicalUserId,
            channelUserId,
            agentId,
            metadata: { error: messageText },
          });
          args.intentRoutingTrace.record({
            stage: 'dispatch_response',
            requestId: dispatchCtx.requestId,
            messageId: message.id,
            userId: canonicalUserId,
            channel,
            agentId,
            contentPreview: messageText,
            details: {
              selectedAgentId: agentId,
              fallbackUsed: false,
              requestedTier,
              routeReason: routeDecision?.reason,
              error: messageText,
            },
          });
          throw err;
        }
      },
    );
  };
}
