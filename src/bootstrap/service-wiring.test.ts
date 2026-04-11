import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import {
  createRuntimeNotificationService,
  runCliPostStart,
  startRuntimeSupportServices,
  wireScheduledAgentExecutor,
} from './service-wiring.js';

describe('service wiring helpers', () => {
  it('wires scheduled agent delivery through the configured CLI channel', async () => {
    let executor: { runAgentTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined;
    const scheduledTasks = {
      setAgentExecutor(value: unknown) {
        executor = value as typeof executor;
      },
    };
    const jobTracker = {
      run: vi.fn(async (_input, handler: () => Promise<unknown>) => handler()),
    };
    const dashboardCallbacks = {
      onDispatch: vi.fn(async () => ({ content: 'Scheduled task complete.', metadata: { ok: true } })),
    };
    const cliChannel = {
      send: vi.fn(async () => {}),
    };
    const configRef = {
      current: structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig,
    };

    wireScheduledAgentExecutor({
      scheduledTasks,
      jobTracker,
      dashboardCallbacks,
      configRef,
      defaultAgentId: 'default-agent',
      getCliChannel: () => cliChannel,
      getTelegramChannel: () => null,
      getWebChannel: () => null,
    });

    const result = await executor!.runAgentTask({
      agentId: 'default',
      prompt: 'Run the report',
      taskId: 'task-1',
      taskName: 'Daily Report',
      channel: 'cli',
    });

    expect(dashboardCallbacks.onDispatch).toHaveBeenCalled();
    expect(cliChannel.send).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      status: 'succeeded',
      output: {
        delivery: {
          attempted: true,
          delivered: true,
          channel: 'cli',
        },
      },
    });
  });

  it('maps scheduled code-session delivery onto the web channel', async () => {
    let executor: { runAgentTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined;
    const scheduledTasks = {
      setAgentExecutor(value: unknown) {
        executor = value as typeof executor;
      },
    };
    const jobTracker = {
      run: vi.fn(async (_input, handler: () => Promise<unknown>) => handler()),
    };
    const dashboardCallbacks = {
      onDispatch: vi.fn(async () => ({ content: 'Scheduled task complete.', metadata: { ok: true } })),
    };
    const webChannel = {
      send: vi.fn(async () => {}),
    };
    const configRef = {
      current: structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig,
    };

    wireScheduledAgentExecutor({
      scheduledTasks,
      jobTracker,
      dashboardCallbacks,
      configRef,
      defaultAgentId: 'default-agent',
      getCliChannel: () => null,
      getTelegramChannel: () => null,
      getWebChannel: () => webChannel,
    });

    const result = await executor!.runAgentTask({
      agentId: 'default',
      prompt: 'Run the report',
      taskId: 'task-1',
      taskName: 'Daily Report',
      channel: 'code-session',
      deliver: true,
    });

    expect(dashboardCallbacks.onDispatch).toHaveBeenCalledWith(
      'default-agent',
      expect.objectContaining({ channel: 'web' }),
      undefined,
      { priority: 'normal', requestType: 'scheduled_task' },
    );
    expect(webChannel.send).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      status: 'succeeded',
      output: {
        delivery: {
          attempted: true,
          delivered: true,
          channel: 'web',
        },
      },
    });
  });

  it('uses the scheduled telegram user id when no telegram allowlist exists', async () => {
    let executor: { runAgentTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined;
    const scheduledTasks = {
      setAgentExecutor(value: unknown) {
        executor = value as typeof executor;
      },
    };
    const jobTracker = {
      run: vi.fn(async (_input, handler: () => Promise<unknown>) => handler()),
    };
    const dashboardCallbacks = {
      onDispatch: vi.fn(async () => ({ content: 'Scheduled task complete.', metadata: { ok: true } })),
    };
    const telegramChannel = {
      send: vi.fn(async () => {}),
      getKnownChatIds: vi.fn(() => []),
    };
    const configRef = {
      current: structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig,
    };
    configRef.current.channels.telegram = {
      ...(configRef.current.channels.telegram ?? {}),
      allowedChatIds: [],
    } as never;

    wireScheduledAgentExecutor({
      scheduledTasks,
      jobTracker,
      dashboardCallbacks,
      configRef,
      defaultAgentId: 'default-agent',
      getCliChannel: () => null,
      getTelegramChannel: () => telegramChannel,
      getWebChannel: () => null,
    });

    const result = await executor!.runAgentTask({
      agentId: 'default',
      prompt: 'Run the report',
      taskId: 'task-1',
      taskName: 'Daily Report',
      channel: 'telegram',
      userId: '555',
      deliver: true,
    });

    expect(telegramChannel.send).toHaveBeenCalledOnce();
    expect(telegramChannel.send).toHaveBeenCalledWith('555', expect.stringContaining('Scheduled assistant report: Daily Report'));
    expect(result).toMatchObject({
      success: true,
      status: 'succeeded',
      output: {
        delivery: {
          attempted: true,
          delivered: true,
          channel: 'telegram',
        },
      },
    });
  });

  it('starts runtime support services and returns monitoring interval handles', async () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.assistant.hostMonitoring.enabled = true;
    config.assistant.hostMonitoring.scanIntervalSec = 10;
    config.assistant.gatewayMonitoring.enabled = true;
    config.assistant.gatewayMonitoring.scanIntervalSec = 10;
    const configRef = { current: config };
    const notificationService = { start: vi.fn() };
    const runtime = { start: vi.fn(async () => {}) };
    const runHostMonitoring = vi.fn(async () => ({}));
    const runGatewayMonitoring = vi.fn(async () => ({}));
    const connectors = { getState: () => ({ playbooks: [] }) };
    const scheduledTasks = { migratePlaybookSchedules: vi.fn(() => 0) };
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await startRuntimeSupportServices({
      notificationService,
      runtime,
      config,
      configRef,
      runHostMonitoring,
      runGatewayMonitoring,
      connectors,
      scheduledTasks,
      log,
    });

    expect(notificationService.start).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runHostMonitoring).toHaveBeenCalledWith('startup');
    expect(runGatewayMonitoring).toHaveBeenCalledWith('startup');
    expect(result.hostMonitorInterval).not.toBeNull();
    expect(result.gatewayMonitorInterval).not.toBeNull();

    if (result.hostMonitorInterval) clearInterval(result.hostMonitorInterval);
    if (result.gatewayMonitorInterval) clearInterval(result.gatewayMonitorInterval);
  });

  it('runs CLI post-start with provider readiness and greeting dispatch', async () => {
    const cliChannel = {
      postStart: vi.fn(),
    };
    const dashboardCallbacks = {
      onProvidersStatus: vi.fn(async () => [{ name: 'ollama', connected: true }]),
      onSetupApply: vi.fn(async () => ({ success: true, message: 'ok' })),
    };
    const runtime = {
      dispatchMessage: vi.fn(async () => ({ content: 'Ready.' })),
    };
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.defaultProvider = 'ollama';

    await runCliPostStart({
      cliChannel,
      dashboardCallbacks,
      config,
      runtime,
      defaultAgentId: 'default-agent',
    });

    expect(cliChannel.postStart).toHaveBeenCalledOnce();
    const args = cliChannel.postStart.mock.calls[0][0];
    expect(args.providerReady).toBe(true);
    await expect(args.onGreeting()).resolves.toBe('Ready.');
  });

  it('keeps telegram notifications as a no-op when telegram is not configured', async () => {
    const configRef = {
      current: structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig,
    };
    configRef.current.channels.telegram = undefined;
    const notificationService = createRuntimeNotificationService({
      configRef,
      runtime: {
        auditLog: {} as never,
        eventBus: {} as never,
      },
      getCliChannel: () => null,
      getTelegramChannel: () => null,
    });

    const sendTelegram = (
      notificationService as unknown as { senders: { sendTelegram?: (text: string) => Promise<void> } }
    ).senders.sendTelegram;

    await expect(sendTelegram?.('test message')).resolves.toBeUndefined();
  });

  it('falls back to known telegram chats for runtime notifications when no allowlist exists', async () => {
    const configRef = {
      current: structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig,
    };
    configRef.current.channels.telegram = {
      ...(configRef.current.channels.telegram ?? {}),
      allowedChatIds: [],
    } as never;
    const telegramChannel = {
      send: vi.fn(async () => {}),
      getKnownChatIds: vi.fn(() => [777]),
    };
    const notificationService = createRuntimeNotificationService({
      configRef,
      runtime: {
        auditLog: {} as never,
        eventBus: {} as never,
      },
      getCliChannel: () => null,
      getTelegramChannel: () => telegramChannel,
    });

    const sendTelegram = (
      notificationService as unknown as { senders: { sendTelegram?: (text: string) => Promise<void> } }
    ).senders.sendTelegram;

    await sendTelegram?.('test message');

    expect(telegramChannel.send).toHaveBeenCalledWith('777', 'test message');
  });
});
