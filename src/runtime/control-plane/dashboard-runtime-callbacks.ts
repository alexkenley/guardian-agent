import { randomUUID } from 'node:crypto';

import type { UserMessage } from '../../agent/types.js';
import type { DashboardCallbacks } from '../../channels/web-types.js';
import type { GuardianAgentConfig } from '../../config/types.js';
import { buildQuickActionPrompt } from '../../quick-actions.js';
import type { AnalyticsService } from '../analytics.js';
import type { IdentityService } from '../identity.js';
import type { AgentEvent } from '../../queue/event-bus.js';
import type { AssistantOrchestrator } from '../orchestrator.js';
import { notificationDestinationEnabled } from '../notifications.js';
import type { RunTimelineStore } from '../run-timeline.js';
import type { Runtime } from '../runtime.js';
import type { SecurityActivityLogService } from '../security-activity-log.js';
import type { PrepareIncomingDispatch } from '../incoming-dispatch.js';
import type { DashboardMessageDispatcher } from '../dashboard-dispatch.js';
import {
  isReservedAgentAlias,
  resolveConfiguredAgentId as resolveConfiguredAgentIdAlias,
} from '../agent-target-resolution.js';

type DashboardRuntimeCallbacks = Pick<
  DashboardCallbacks,
  | 'onSSESubscribe'
  | 'onDispatch'
  | 'onStreamDispatch'
  | 'onStreamCancel'
  | 'onQuickActionRun'
>;

type PreparedIncomingDispatchResult = Pick<
  Awaited<ReturnType<PrepareIncomingDispatch>>,
  'decision' | 'gateway' | 'routedMessage'
>;

interface DashboardRuntimeCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  runtime: Pick<Runtime, 'auditLog' | 'eventBus' | 'watchdog' | 'dispatchMessage'>;
  securityActivityLog: Pick<SecurityActivityLogService, 'addListener'>;
  runTimeline: Pick<RunTimelineStore, 'subscribe'>;
  agentDashboard: Pick<DashboardCallbacks, 'onAgents'>;
  dispatchDashboardMessage: DashboardMessageDispatcher;
  prepareIncomingDispatch: (
    channelDefault: string | undefined,
    msg: Parameters<NonNullable<DashboardCallbacks['onStreamDispatch']>>[1],
  ) => Promise<PreparedIncomingDispatchResult>;
  resolveConfiguredAgentId?: (agentId?: string) => string | undefined;
  identity: Pick<IdentityService, 'resolveCanonicalUserId'>;
  analytics: Pick<AnalyticsService, 'track'>;
  orchestrator: Pick<AssistantOrchestrator, 'dispatch' | 'cancelSession'>;
  now?: () => number;
  createRequestId?: () => string;
}

interface ActiveStreamDispatch {
  requestId: string;
  channel: string;
  canonicalUserId: string;
  agentId: string;
  emitSSE: Parameters<NonNullable<DashboardCallbacks['onStreamDispatch']>>[2];
  canceled: boolean;
  cancelMessage: string;
  abortController?: AbortController;
}

async function prepareExplicitAgentDispatch(
  prepareIncomingDispatch: DashboardRuntimeCallbackOptions['prepareIncomingDispatch'],
  msg: Parameters<NonNullable<DashboardCallbacks['onStreamDispatch']>>[1],
): Promise<PreparedIncomingDispatchResult> {
  return prepareIncomingDispatch(undefined, msg);
}

function readStructuredRequestError(err: unknown): { error: string; errorCode?: string } | null {
  if (!(err instanceof Error) || typeof (err as { statusCode?: unknown }).statusCode !== 'number') {
    return null;
  }
  const errorWithCode = err as unknown as { errorCode?: unknown };
  return {
    error: err.message || 'Stream dispatch failed',
    ...(typeof errorWithCode.errorCode === 'string'
      ? { errorCode: errorWithCode.errorCode }
      : {}),
  };
}

export function createDashboardRuntimeCallbacks(
  options: DashboardRuntimeCallbackOptions,
): DashboardRuntimeCallbacks {
  const now = options.now ?? Date.now;
  const createRequestId = options.createRequestId ?? randomUUID;
  const resolveConfiguredAgentId = options.resolveConfiguredAgentId ?? ((agentId?: string) => (
    resolveConfiguredAgentIdAlias(agentId, {
      defaultAgentId: options.configRef.current.agents[0]?.id ?? 'default',
      router: {
        findAgentByRole: () => undefined,
      },
    })
  ));
  const activeStreamDispatches = new Map<string, ActiveStreamDispatch>();
  const CANCELED_ERROR_CODE = 'REQUEST_CANCELED';
  const REQUEST_NOT_ACTIVE_ERROR_CODE = 'REQUEST_NOT_ACTIVE';
  const DEFAULT_CANCEL_MESSAGE = 'Request canceled by operator.';

  const resolveDispatchTargetAgentId = (agentId: string | undefined): string | undefined => {
    const trimmed = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
    if (!trimmed) return undefined;
    const resolved = resolveConfiguredAgentId(trimmed);
    if (resolved) return resolved;
    return isReservedAgentAlias(trimmed) ? undefined : trimmed;
  };

  const buildCanceledResult = (
    requestId: string,
    cancelMessage: string,
  ): {
    requestId: string;
    runId: string;
    content: string;
    error: string;
    errorCode: string;
  } => ({
    requestId,
    runId: requestId,
    content: '',
    error: cancelMessage,
    errorCode: CANCELED_ERROR_CODE,
  });

  const emitCanceledEvent = (active: ActiveStreamDispatch): void => {
    active.emitSSE({
      type: 'chat.error',
      data: {
        requestId: active.requestId,
        runId: active.requestId,
        error: active.cancelMessage,
        errorCode: CANCELED_ERROR_CODE,
      },
    });
  };

  return {
    onSSESubscribe: (listener) => {
      const cleanups: Array<() => void> = [];

      const unsubAudit = options.runtime.auditLog.addListener((event) => {
        listener({ type: 'audit', data: event });
      });
      cleanups.push(unsubAudit);

      const onSecurityAlert = (event: AgentEvent): void => {
        if (!notificationDestinationEnabled(options.configRef.current.assistant.notifications, 'web')) {
          return;
        }
        listener({ type: 'security.alert', data: event.payload });
      };
      options.runtime.eventBus.subscribeByType('security:alert', onSecurityAlert);
      cleanups.push(() => options.runtime.eventBus.unsubscribeByType('security:alert', onSecurityAlert));

      const unsubSecurityTriage = options.securityActivityLog.addListener((entry) => {
        listener({ type: 'security.triage', data: entry });
      });
      cleanups.push(unsubSecurityTriage);

      const unsubRunTimeline = options.runTimeline.subscribe((detail) => {
        listener({ type: 'run.timeline', data: detail });
      });
      cleanups.push(unsubRunTimeline);

      const metricsInterval = setInterval(() => {
        listener({
          type: 'metrics',
          data: {
            agents: options.agentDashboard.onAgents?.() ?? [],
            eventBusPending: options.runtime.eventBus.pending,
            timestamp: now(),
          },
        });
      }, 5_000);
      cleanups.push(() => clearInterval(metricsInterval));

      const watchdogInterval = setInterval(() => {
        listener({
          type: 'watchdog',
          data: {
            results: options.runtime.watchdog.check(),
            timestamp: now(),
          },
        });
      }, 10_000);
      cleanups.push(() => clearInterval(watchdogInterval));

      return () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    },

    onDispatch: async (agentId, msg, routeDecision, dispatchOptions, precomputedIntentGateway) => (
      options.dispatchDashboardMessage({
        agentId: resolveDispatchTargetAgentId(agentId)
          ?? resolveDispatchTargetAgentId(options.configRef.current.channels.web?.defaultAgent)
          ?? options.configRef.current.agents[0]?.id
          ?? 'default',
        msg,
        routeDecision,
        options: dispatchOptions,
        precomputedIntentGateway,
      })
    ),

    onStreamDispatch: async (agentId, msg, emitSSE) => {
      const explicitAgentId = resolveDispatchTargetAgentId(agentId);
      const configuredWebDefaultAgentId = resolveDispatchTargetAgentId(options.configRef.current.channels.web?.defaultAgent);
      const requestId = msg.requestId?.trim() || createRequestId();
      const channel = msg.channel?.trim() || 'web';
      const channelUserId = msg.userId?.trim() || `${channel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(channel, channelUserId);
      const active: ActiveStreamDispatch = {
        requestId,
        channel,
        canonicalUserId,
        agentId: agentId?.trim() || '',
        emitSSE,
        canceled: false,
        cancelMessage: DEFAULT_CANCEL_MESSAGE,
      };
      activeStreamDispatches.set(requestId, active);
      emitSSE({
        type: 'chat.thinking',
        data: {
          requestId,
          runId: requestId,
        },
      });

      try {
        const prepared = explicitAgentId
          ? await prepareExplicitAgentDispatch(options.prepareIncomingDispatch, msg)
          : await options.prepareIncomingDispatch(configuredWebDefaultAgentId, msg);
        const resolvedAgentId = explicitAgentId
          || prepared.decision?.agentId
          || configuredWebDefaultAgentId
          || options.configRef.current.agents[0]?.id
          || 'default';
        active.agentId = resolvedAgentId;
        const response = await options.dispatchDashboardMessage({
          agentId: resolvedAgentId,
          msg: prepared.routedMessage,
          routeDecision: prepared.decision,
          precomputedIntentGateway: prepared.gateway,
          options: {
            priority: 'high',
            requestType: 'chat',
            requestId,
            abortSignal: active.abortController?.signal,
          },
        });
        if (active.canceled) {
          return buildCanceledResult(requestId, active.cancelMessage);
        }
        emitSSE({
          type: 'chat.done',
          data: {
            requestId,
            runId: requestId,
            content: response.content,
            metadata: response.metadata,
          },
        });
        return {
          requestId,
          runId: requestId,
          content: response.content,
          metadata: response.metadata,
        };
      } catch (err) {
        if (active.canceled) {
          return buildCanceledResult(requestId, active.cancelMessage);
        }
        const requestError = readStructuredRequestError(err);
        const error = requestError?.error ?? (err instanceof Error ? err.message : String(err));
        emitSSE({
          type: 'chat.error',
          data: {
            requestId,
            runId: requestId,
            error,
            ...(requestError?.errorCode ? { errorCode: requestError.errorCode } : {}),
          },
        });
        return {
          requestId,
          runId: requestId,
          content: '',
          error,
          ...(requestError?.errorCode ? { errorCode: requestError.errorCode } : {}),
        };
      } finally {
        activeStreamDispatches.delete(requestId);
      }
    },

    onStreamCancel: async ({ requestId, userId, channel, agentId, reason }) => {
      const trimmedRequestId = requestId?.trim() || '';
      if (!trimmedRequestId) {
        return {
          success: false,
          canceled: false,
          message: 'requestId is required.',
          requestId: '',
          runId: '',
          errorCode: REQUEST_NOT_ACTIVE_ERROR_CODE,
        };
      }

      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const active = activeStreamDispatches.get(trimmedRequestId);
      if (!active) {
        return {
          success: false,
          canceled: false,
          message: `Request '${trimmedRequestId}' is no longer active.`,
          requestId: trimmedRequestId,
          runId: trimmedRequestId,
          errorCode: REQUEST_NOT_ACTIVE_ERROR_CODE,
        };
      }

      if (active.channel !== resolvedChannel || active.canonicalUserId !== canonicalUserId) {
        return {
          success: false,
          canceled: false,
          message: `Request '${trimmedRequestId}' is not active for this user/channel.`,
          requestId: trimmedRequestId,
          runId: trimmedRequestId,
          errorCode: REQUEST_NOT_ACTIVE_ERROR_CODE,
        };
      }

      const requestedAgentId = agentId?.trim() || '';
      if (requestedAgentId && active.agentId && requestedAgentId !== active.agentId) {
        return {
          success: false,
          canceled: false,
          message: `Request '${trimmedRequestId}' is not active for agent '${requestedAgentId}'.`,
          requestId: trimmedRequestId,
          runId: trimmedRequestId,
          errorCode: REQUEST_NOT_ACTIVE_ERROR_CODE,
        };
      }

      if (!active.canceled) {
        active.canceled = true;
        active.cancelMessage = reason?.trim() || DEFAULT_CANCEL_MESSAGE;
        active.abortController?.abort(new Error(active.cancelMessage));
        options.orchestrator.cancelSession(
          {
            userId: active.canonicalUserId,
            channel: active.channel,
            agentId: active.agentId || requestedAgentId || 'default',
          },
          active.cancelMessage
        );
        emitCanceledEvent(active);
        options.analytics.track({
          type: 'message_canceled',
          channel: resolvedChannel,
          canonicalUserId,
          channelUserId,
          agentId: active.agentId || requestedAgentId || 'default',
          metadata: {
            requestId: trimmedRequestId,
          },
        });
      }

      return {
        success: true,
        canceled: true,
        message: active.cancelMessage,
        requestId: trimmedRequestId,
        runId: trimmedRequestId,
        errorCode: CANCELED_ERROR_CODE,
      };
    },

    onQuickActionRun: async ({ actionId, details, agentId, userId, channel }) => {
      const canonicalUserId = options.identity.resolveCanonicalUserId(channel, userId);
      const built = buildQuickActionPrompt(options.configRef.current.assistant.quickActions, actionId, details);
      if (!built) {
        throw new Error(`Unknown quick action '${actionId}'`);
      }
      options.analytics.track({
        type: 'quick_action_triggered',
        channel,
        canonicalUserId,
        channelUserId: userId,
        agentId,
        metadata: { actionId },
      });
      return options.orchestrator.dispatch(
        {
          agentId,
          userId: canonicalUserId,
          channel,
          content: built.prompt,
          priority: 'high',
          requestType: 'quick_action',
        },
        async (dispatchCtx) => {
          const message: UserMessage = {
            id: createRequestId(),
            userId: canonicalUserId,
            channel,
            content: built.prompt,
            timestamp: now(),
          };
          dispatchCtx.markStep('quick_action_prompt_built', `action=${actionId}`);
          return dispatchCtx.runStep(
            'runtime_dispatch_message',
            async () => options.runtime.dispatchMessage(agentId, message),
            `agent=${agentId}`,
          );
        },
      );
    },
  };
}
