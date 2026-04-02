import { randomUUID } from 'node:crypto';
import type { AgentResponse, UserMessage } from '../agent/types.js';
import type { CLIChannel } from '../channels/cli.js';
import type { TelegramChannel } from '../channels/telegram.js';
import type { WebChannel } from '../channels/web.js';
import type { DashboardCallbacks, DashboardProviderInfo } from '../channels/web-types.js';
import type { GuardianAgentConfig } from '../config/types.js';
import type { AssistantJobTracker } from '../runtime/assistant-jobs.js';
import type { ConnectorPlaybookService } from '../runtime/connectors.js';
import { NotificationService } from '../runtime/notifications.js';
import type { Runtime } from '../runtime/runtime.js';
import type { ScheduledTaskService } from '../runtime/scheduled-tasks.js';

interface LoggerLike {
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
}

async function sendToConfiguredTelegramChats(
  telegramChannel: Pick<TelegramChannel, 'send'> | null,
  chatIds: readonly number[],
  text: string,
): Promise<void> {
  if (!telegramChannel || chatIds.length === 0) {
    throw new Error('Telegram delivery is not configured.');
  }
  for (const chatId of chatIds) {
    await telegramChannel.send(String(chatId), text);
  }
}

async function sendTelegramNotificationIfConfigured(
  telegramChannel: Pick<TelegramChannel, 'send'> | null,
  chatIds: readonly number[],
  text: string,
): Promise<void> {
  if (!telegramChannel || chatIds.length === 0) {
    return;
  }
  for (const chatId of chatIds) {
    await telegramChannel.send(String(chatId), text);
  }
}

export function wireScheduledAgentExecutor(args: {
  scheduledTasks: Pick<ScheduledTaskService, 'setAgentExecutor'>;
  jobTracker: Pick<AssistantJobTracker, 'run'>;
  dashboardCallbacks: DashboardCallbacks;
  configRef: { current: GuardianAgentConfig };
  defaultAgentId: string;
  getCliChannel: () => Pick<CLIChannel, 'send'> | null;
  getTelegramChannel: () => Pick<TelegramChannel, 'send'> | null;
  getWebChannel: () => Pick<WebChannel, 'send'> | null;
}): void {
  args.scheduledTasks.setAgentExecutor({
    runAgentTask: async (input) => {
      const requestedAgentId = input.agentId.trim();
      const resolvedAgentId = requestedAgentId === 'default' ? args.defaultAgentId : requestedAgentId;
      const channel = normalizeScheduledDeliveryChannel(input.channel?.trim() || 'scheduled');
      const userId = input.userId?.trim() || args.configRef.current.assistant.identity.primaryUserId;
      const shouldDeliver = input.deliver ?? channel !== 'scheduled';

      const response = await args.jobTracker.run(
        {
          type: 'scheduled-agent-task',
          source: 'scheduled',
          detail: input.taskName,
          metadata: {
            taskId: input.taskId,
            agentId: resolvedAgentId,
            channel,
          },
        },
        async () => {
          if (!args.dashboardCallbacks.onDispatch) {
            throw new Error('Assistant dispatch is not available.');
          }
          return args.dashboardCallbacks.onDispatch(
            resolvedAgentId,
            {
              content: input.prompt,
              userId,
              principalId: input.principalId ?? userId,
              principalRole: input.principalRole ?? 'owner',
              channel,
            },
            undefined,
            { priority: 'normal', requestType: 'scheduled_task' },
          );
        },
      );

      const deliveryText = `Scheduled assistant report: ${input.taskName}\n\n${response.content}`.trim();
      let deliveryMessage = 'Agent task completed.';
      const deliveryMeta: Record<string, unknown> = {
        attempted: false,
        delivered: false,
        channel,
      };

      if (shouldDeliver) {
        deliveryMeta.attempted = true;
        try {
          if (channel === 'cli') {
            const cliChannel = args.getCliChannel();
            if (!cliChannel) throw new Error('CLI channel is not available.');
            await cliChannel.send(args.configRef.current.assistant.identity.primaryUserId, deliveryText);
          } else if (channel === 'telegram') {
            await sendToConfiguredTelegramChats(
              args.getTelegramChannel(),
              args.configRef.current.channels.telegram?.allowedChatIds ?? [],
              deliveryText,
            );
          } else if (channel === 'web') {
            const webChannel = args.getWebChannel();
            if (!webChannel) throw new Error('Web channel is not available.');
            await webChannel.send(args.configRef.current.assistant.identity.primaryUserId, deliveryText);
          } else {
            throw new Error(`Channel '${channel}' does not support scheduled delivery.`);
          }
          deliveryMeta.delivered = true;
          deliveryMessage = `Agent task completed and delivered to ${channel}.`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deliveryMeta.error = message;
          deliveryMessage = `Agent task completed, but delivery failed: ${message}`;
        }
      }

      return {
        success: true,
        status: 'succeeded',
        message: deliveryMessage,
        output: {
          content: response.content,
          metadata: response.metadata,
          delivery: deliveryMeta,
        },
      };
    },
  });
}

function normalizeScheduledDeliveryChannel(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) return 'scheduled';
  if (normalized === 'code-session') return 'web';
  return normalized;
}

export function createRuntimeNotificationService(args: {
  configRef: { current: GuardianAgentConfig };
  runtime: Pick<Runtime, 'auditLog' | 'eventBus'>;
  getCliChannel: () => Pick<CLIChannel, 'send'> | null;
  getTelegramChannel: () => Pick<TelegramChannel, 'send'> | null;
}): NotificationService {
  return new NotificationService({
    getConfig: () => args.configRef.current.assistant.notifications,
    auditLog: args.runtime.auditLog,
    eventBus: args.runtime.eventBus,
    senders: {
      sendCli: async (text: string) => {
        const cliChannel = args.getCliChannel();
        if (!cliChannel) return;
        await cliChannel.send(args.configRef.current.assistant.identity.primaryUserId, text);
      },
      sendTelegram: async (text: string) => {
        await sendTelegramNotificationIfConfigured(
          args.getTelegramChannel(),
          args.configRef.current.channels.telegram?.allowedChatIds ?? [],
          text,
        );
      },
    },
  });
}

export async function startRuntimeSupportServices(args: {
  notificationService: Pick<NotificationService, 'start'>;
  runtime: Pick<Runtime, 'start'>;
  config: GuardianAgentConfig;
  configRef: { current: GuardianAgentConfig };
  runHostMonitoring: (source: string) => Promise<unknown>;
  runGatewayMonitoring: (source: string) => Promise<unknown>;
  connectors: Pick<ConnectorPlaybookService, 'getState'>;
  scheduledTasks: Pick<ScheduledTaskService, 'migratePlaybookSchedules'>;
  log: LoggerLike;
}): Promise<{
  hostMonitorInterval: ReturnType<typeof setInterval> | null;
  gatewayMonitorInterval: ReturnType<typeof setInterval> | null;
}> {
  args.notificationService.start();
  await args.runtime.start();

  let hostMonitorInterval: ReturnType<typeof setInterval> | null = null;
  let gatewayMonitorInterval: ReturnType<typeof setInterval> | null = null;

  if (args.config.assistant.hostMonitoring.enabled) {
    await args.runHostMonitoring('startup').catch((err) => {
      args.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Initial host monitoring check failed');
    });
    hostMonitorInterval = setInterval(() => {
      args.runHostMonitoring('interval').catch((err) => {
        args.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Host monitoring interval check failed');
      });
    }, Math.max(10, args.configRef.current.assistant.hostMonitoring.scanIntervalSec) * 1000);
  }

  if (args.config.assistant.gatewayMonitoring.enabled) {
    await args.runGatewayMonitoring('startup').catch((err) => {
      args.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Initial gateway monitoring check failed');
    });
    gatewayMonitorInterval = setInterval(() => {
      args.runGatewayMonitoring('interval').catch((err) => {
        args.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Gateway monitoring interval check failed');
      });
    }, Math.max(10, args.configRef.current.assistant.gatewayMonitoring.scanIntervalSec) * 1000);
  }

  const playbookDefs = args.connectors.getState().playbooks;
  const migrated = args.scheduledTasks.migratePlaybookSchedules(playbookDefs);
  if (migrated > 0) {
    args.log.info({ migrated }, 'Migrated playbook schedules to ScheduledTaskService');
  }

  return {
    hostMonitorInterval,
    gatewayMonitorInterval,
  };
}

export async function runCliPostStart(args: {
  cliChannel: Pick<CLIChannel, 'postStart'> | null;
  dashboardCallbacks: DashboardCallbacks;
  config: GuardianAgentConfig;
  runtime: Pick<Runtime, 'dispatchMessage'>;
  defaultAgentId: string;
}): Promise<void> {
  if (!args.cliChannel) return;

  const providers = args.dashboardCallbacks.onProvidersStatus
    ? await args.dashboardCallbacks.onProvidersStatus()
    : [];
  const providerReady = providers.some(
    (provider: DashboardProviderInfo) => provider.name === args.config.defaultProvider && provider.connected,
  );

  args.cliChannel.postStart({
    providerReady,
    onGreeting: async () => {
      try {
        const response: AgentResponse = await args.runtime.dispatchMessage(
          args.defaultAgentId,
          {
            id: randomUUID(),
            userId: 'system',
            channel: 'cli',
            content: 'You have just started up. Greet the user briefly — one short sentence to let them know you are online and ready.',
            timestamp: Date.now(),
          } as UserMessage,
        );
        return response.content;
      } catch {
        return 'Guardian Agent is online and ready.';
      }
    },
    onSetupApply: args.dashboardCallbacks.onSetupApply!,
  });
}
