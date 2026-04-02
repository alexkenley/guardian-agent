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

type DashboardRuntimeCallbacks = Pick<
  DashboardCallbacks,
  | 'onSSESubscribe'
  | 'onDispatch'
  | 'onStreamDispatch'
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
  identity: Pick<IdentityService, 'resolveCanonicalUserId'>;
  analytics: Pick<AnalyticsService, 'track'>;
  orchestrator: Pick<AssistantOrchestrator, 'dispatch'>;
  now?: () => number;
  createRequestId?: () => string;
}

function toDirectDispatchMessage(
  msg: Parameters<NonNullable<DashboardCallbacks['onStreamDispatch']>>[1],
) {
  return {
    content: msg.content,
    userId: msg.userId,
    surfaceId: msg.surfaceId,
    principalId: msg.principalId,
    principalRole: msg.principalRole,
    channel: msg.channel,
    metadata: msg.metadata,
  };
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
        agentId,
        msg,
        routeDecision,
        options: dispatchOptions,
        precomputedIntentGateway,
      })
    ),

    onStreamDispatch: async (agentId, msg, emitSSE) => {
      const requestId = msg.requestId?.trim() || createRequestId();
      emitSSE({
        type: 'chat.thinking',
        data: {
          requestId,
          runId: requestId,
        },
      });

      try {
        const prepared = agentId?.trim()
          ? {
              decision: undefined,
              gateway: null,
              routedMessage: toDirectDispatchMessage(msg),
            }
          : await options.prepareIncomingDispatch(options.configRef.current.channels.web?.defaultAgent, msg);
        const resolvedAgentId = agentId?.trim()
          || prepared.decision?.agentId
          || options.configRef.current.channels.web?.defaultAgent
          || options.configRef.current.agents[0]?.id
          || 'default';
        const response = await options.dispatchDashboardMessage({
          agentId: resolvedAgentId,
          msg: prepared.routedMessage,
          routeDecision: prepared.decision,
          precomputedIntentGateway: prepared.gateway,
          options: {
            priority: 'high',
            requestType: 'chat',
            requestId,
          },
        });
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
      }
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
