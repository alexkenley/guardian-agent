import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScheduledTaskService } from './scheduled-tasks.js';
import type { ScheduledTaskServiceDeps, ScheduledTaskCreateInput } from './scheduled-tasks.js';
import type { CronScheduler } from './scheduler.js';

// ─── Mocks ────────────────────────────────────────────────

function createMockScheduler(): CronScheduler {
  return {
    schedule: vi.fn(),
    unschedule: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getJobs: vi.fn().mockReturnValue([]),
    isRunning: vi.fn().mockReturnValue(true),
  } as unknown as CronScheduler;
}

function createMockToolExecutor() {
  return {
    runTool: vi.fn().mockResolvedValue({
      success: true,
      status: 'completed',
      jobId: 'job-1',
      message: 'Tool executed',
      output: { result: 'ok' },
    }),
  };
}

function createMockPlaybookExecutor() {
  return {
    runPlaybook: vi.fn().mockResolvedValue({
      success: true,
      status: 'succeeded',
      message: 'Playbook ran',
      run: {
        steps: [{
          toolName: 'net_arp_scan',
          status: 'succeeded',
          message: 'Step succeeded',
          durationMs: 42,
          output: { devices: [] },
        }],
      },
    }),
  };
}

function createMockAgentExecutor() {
  return {
    runAgentTask: vi.fn().mockResolvedValue({
      success: true,
      status: 'succeeded',
      message: 'Agent task completed',
      output: {
        content: 'Morning briefing ready',
        delivered: true,
      },
    }),
  };
}

function createMockDeviceInventory() {
  return {
    ingestPlaybookResults: vi.fn(),
  };
}

function createMockEventBus() {
  const typeHandlers = new Map<string, Array<(event: { type: string; [key: string]: unknown }) => void | Promise<void>>>();
  return {
    emit: vi.fn().mockImplementation(async (event: { type: string; [key: string]: unknown }) => {
      const handlers = typeHandlers.get(event.type) ?? [];
      await Promise.all(handlers.map((handler) => handler(event)));
      return true;
    }),
    subscribeByType: vi.fn().mockImplementation((eventType: string, handler: (event: { type: string; [key: string]: unknown }) => void | Promise<void>) => {
      const handlers = typeHandlers.get(eventType) ?? [];
      handlers.push(handler);
      typeHandlers.set(eventType, handlers);
    }),
    unsubscribeByType: vi.fn().mockImplementation((eventType: string, handler: (event: { type: string; [key: string]: unknown }) => void | Promise<void>) => {
      const handlers = typeHandlers.get(eventType) ?? [];
      typeHandlers.set(eventType, handlers.filter((candidate) => candidate !== handler));
    }),
  };
}

function createDeps(overrides?: Partial<ScheduledTaskServiceDeps>): ScheduledTaskServiceDeps {
  return {
    scheduler: createMockScheduler(),
    toolExecutor: createMockToolExecutor(),
    playbookExecutor: createMockPlaybookExecutor(),
    agentExecutor: createMockAgentExecutor(),
    deviceInventory: createMockDeviceInventory() as unknown as ScheduledTaskServiceDeps['deviceInventory'],
    eventBus: createMockEventBus() as unknown as ScheduledTaskServiceDeps['eventBus'],
    persistPath: '/tmp/test-scheduled-tasks.json',
    now: () => 1000000,
    ...overrides,
  };
}

const validInput: ScheduledTaskCreateInput = {
  name: 'Test Task',
  type: 'tool',
  target: 'net_arp_scan',
  cron: '*/30 * * * *',
  enabled: true,
};

// ─── Tests ────────────────────────────────────────────────

describe('ScheduledTaskService', () => {
  let service: ScheduledTaskService;
  let deps: ScheduledTaskServiceDeps;

  beforeEach(() => {
    deps = createDeps();
    service = new ScheduledTaskService(deps);
  });

  describe('create', () => {
    it('should create a task with valid input', () => {
      const result = service.create(validInput);
      expect(result.success).toBe(true);
      expect(result.task).toBeDefined();
      expect(result.task!.name).toBe('Test Task');
      expect(result.task!.type).toBe('tool');
      expect(result.task!.target).toBe('net_arp_scan');
      expect(result.task!.cron).toBe('*/30 * * * *');
      expect(result.task!.enabled).toBe(true);
      expect(result.task!.approvedByPrincipal).toBe('scheduled-system');
      expect(result.task!.approvalExpiresAt).toBeGreaterThan(result.task!.createdAt);
      expect(result.task!.scopeHash).toBeTruthy();
      expect(result.task!.runCount).toBe(0);
    });

    it('should register cron when enabled', () => {
      service.create(validInput);
      expect(deps.scheduler.schedule).toHaveBeenCalledTimes(1);
    });

    it('should not register cron when disabled', () => {
      service.create({ ...validInput, enabled: false });
      expect(deps.scheduler.schedule).not.toHaveBeenCalled();
    });

    it('should reject missing name', () => {
      const result = service.create({ ...validInput, name: '' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('name');
    });

    it('should reject invalid type', () => {
      const result = service.create({ ...validInput, type: 'invalid' as 'tool' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('type');
    });

    it('should create an agent task with prompt metadata', () => {
      const result = service.create({
        name: 'Morning Briefing',
        description: 'Summarize my morning priorities and blockers.',
        type: 'agent',
        target: 'default',
        prompt: 'Summarize my morning priorities.',
        channel: 'telegram',
        deliver: true,
        cron: '0 8 * * *',
      });
      expect(result.success).toBe(true);
      expect(result.task).toMatchObject({
        description: 'Summarize my morning priorities and blockers.',
        type: 'agent',
        target: 'default',
        prompt: 'Summarize my morning priorities.',
        channel: 'telegram',
        deliver: true,
      });
    });

    it('should reject agent tasks without a prompt', () => {
      const result = service.create({
        name: 'Broken Agent Task',
        type: 'agent',
        target: 'default',
        cron: '0 8 * * *',
      } as ScheduledTaskCreateInput);
      expect(result.success).toBe(false);
      expect(result.message).toContain('prompt');
    });

    it('should reject missing target', () => {
      const result = service.create({ ...validInput, target: '' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('target');
    });

    it('should reject missing cron when no event trigger is provided', () => {
      const result = service.create({ ...validInput, cron: '' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Either cron or eventTrigger');
    });

    it('should create an event-triggered task without cron', () => {
      const result = service.create({
        name: 'Beaconing Response',
        type: 'tool',
        target: 'host_monitor_check',
        eventTrigger: {
          eventType: 'security:network:threat',
          match: {
            'payload.type': 'beaconing',
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.task?.cron).toBeUndefined();
      expect(result.task?.eventTrigger).toMatchObject({
        eventType: 'security:network:threat',
      });
      expect(deps.scheduler.schedule).not.toHaveBeenCalled();
      expect((deps.eventBus as any).subscribeByType).toHaveBeenCalledWith('security:network:threat', expect.any(Function));
    });

    it('should clear preset linkage when create input no longer matches the preset target', () => {
      const result = service.create({ ...validInput, presetId: 'network-watch', target: 'sys_info' });
      expect(result.success).toBe(true);
      expect(result.task!.presetId).toBeUndefined();
    });
  });

  describe('list and get', () => {
    it('should list all tasks', () => {
      service.create({ ...validInput, name: 'A' });
      service.create({ ...validInput, name: 'B' });
      const tasks = service.list();
      expect(tasks).toHaveLength(2);
    });

    it('should get a task by id', () => {
      const result = service.create(validInput);
      const task = service.get(result.task!.id);
      expect(task).not.toBeNull();
      expect(task!.name).toBe('Test Task');
    });

    it('should return null for unknown id', () => {
      expect(service.get('nonexistent')).toBeNull();
    });
  });

  describe('update', () => {
    it('should update task name', () => {
      const { task } = service.create(validInput);
      const result = service.update(task!.id, { name: 'Updated' });
      expect(result.success).toBe(true);
      expect(service.get(task!.id)!.name).toBe('Updated');
    });

    it('should update task description without changing scope authority', () => {
      const { task } = service.create({
        name: 'Morning Briefing',
        description: 'First summary',
        type: 'agent',
        target: 'default',
        prompt: 'Summarize my morning priorities.',
        cron: '0 8 * * *',
      });
      const originalScopeHash = task!.scopeHash;

      const result = service.update(task!.id, { description: 'Updated summary' });

      expect(result.success).toBe(true);
      expect(service.get(task!.id)!.description).toBe('Updated summary');
      expect(service.get(task!.id)!.scopeHash).toBe(originalScopeHash);
    });

    it('should update task type and target', () => {
      const { task } = service.create(validInput);
      const result = service.update(task!.id, { type: 'playbook', target: 'home-network' });
      expect(result.success).toBe(true);
      expect(service.get(task!.id)!.type).toBe('playbook');
      expect(service.get(task!.id)!.target).toBe('home-network');
    });

    it('should re-register cron on cron change', () => {
      const { task } = service.create(validInput);
      vi.mocked(deps.scheduler.schedule).mockClear();
      service.update(task!.id, { cron: '0 * * * *' });
      expect(deps.scheduler.unschedule).toHaveBeenCalled();
      expect(deps.scheduler.schedule).toHaveBeenCalledTimes(1);
    });

    it('should unregister cron when disabled', () => {
      const { task } = service.create(validInput);
      service.update(task!.id, { enabled: false });
      expect(deps.scheduler.unschedule).toHaveBeenCalled();
    });

    it('should re-register cron when re-enabled', () => {
      const { task } = service.create({ ...validInput, enabled: false });
      vi.mocked(deps.scheduler.schedule).mockClear();
      service.update(task!.id, { enabled: true });
      expect(deps.scheduler.schedule).toHaveBeenCalledTimes(1);
    });

    it('should switch a task from cron to event trigger', () => {
      const { task } = service.create(validInput);
      vi.mocked(deps.scheduler.schedule).mockClear();

      const result = service.update(task!.id, {
        cron: '',
        eventTrigger: {
          eventType: 'security:alert',
          match: {
            'payload.sourceEventType': 'secret_detected',
          },
        },
      });

      expect(result.success).toBe(true);
      expect(service.get(task!.id)?.cron).toBeUndefined();
      expect(service.get(task!.id)?.eventTrigger?.eventType).toBe('security:alert');
      expect(deps.scheduler.unschedule).toHaveBeenCalled();
      expect((deps.eventBus as any).subscribeByType).toHaveBeenCalledWith('security:alert', expect.any(Function));
    });

    it('should clear preset linkage when a preset task changes target', () => {
      const { task } = service.installPreset('network-watch');
      const result = service.update(task!.id, { target: 'sys_info' });
      expect(result.success).toBe(true);
      expect(service.get(task!.id)!.presetId).toBeUndefined();
    });

    it('should return error for unknown id', () => {
      const result = service.update('nonexistent', { name: 'x' });
      expect(result.success).toBe(false);
    });

    it('should reject converting a task to agent without a prompt', () => {
      const { task } = service.create(validInput);
      const result = service.update(task!.id, { type: 'agent' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('prompt');
    });

    it('refreshes approval metadata when task scope changes', () => {
      const { task } = service.create({ ...validInput, principalId: 'principal-a' });
      const originalScopeHash = task!.scopeHash;
      const originalApprovalExpiresAt = task!.approvalExpiresAt;

      const result = service.update(task!.id, { args: { host: '192.168.1.5' } });

      expect(result.success).toBe(true);
      const updated = service.get(task!.id)!;
      expect(updated.scopeHash).not.toBe(originalScopeHash);
      expect(updated.approvalExpiresAt).toBeGreaterThanOrEqual(originalApprovalExpiresAt!);
      expect(updated.approvedByPrincipal).toBe('principal-a');
    });
  });

  describe('delete', () => {
    it('should delete a task and unschedule it', () => {
      const { task } = service.create(validInput);
      const result = service.delete(task!.id);
      expect(result.success).toBe(true);
      expect(service.get(task!.id)).toBeNull();
      expect(deps.scheduler.unschedule).toHaveBeenCalled();
    });

    it('should return error for unknown id', () => {
      const result = service.delete('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  describe('runNow', () => {
    it('should execute a tool task immediately', async () => {
      const { task } = service.create(validInput);
      const result = await service.runNow(task!.id);
      expect(result.success).toBe(true);
      expect(deps.toolExecutor.runTool).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'net_arp_scan',
          origin: 'web',
          bypassApprovals: true,
        }),
      );
      // Check task state updated
      const updated = service.get(task!.id);
      expect(updated!.runCount).toBe(1);
      expect(updated!.lastRunAt).toBeDefined();
      expect(updated!.lastRunStatus).toBe('succeeded');
    });

    it('should execute a playbook task immediately', async () => {
      const { task } = service.create({ ...validInput, type: 'playbook', target: 'home-network', principalId: 'principal-a' });
      const result = await service.runNow(task!.id);
      expect(result.success).toBe(true);
      expect(deps.playbookExecutor.runPlaybook).toHaveBeenCalledWith(
        expect.objectContaining({
          playbookId: 'home-network',
          origin: 'web',
          requestedBy: 'principal-a',
          bypassApprovals: true,
        }),
      );
    });

    it('should execute an agent task immediately', async () => {
      const { task } = service.create({
        name: 'Morning Briefing',
        type: 'agent',
        target: 'default',
        prompt: 'Summarize my morning priorities.',
        channel: 'cli',
        deliver: true,
        cron: '0 8 * * *',
      });
      const result = await service.runNow(task!.id);
      expect(result.success).toBe(true);
      expect(deps.agentExecutor?.runAgentTask).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'default',
          prompt: 'Summarize my morning priorities.',
          channel: 'cli',
          deliver: true,
        }),
      );
      const history = service.getHistory();
      expect(history[0].taskType).toBe('agent');
      expect(history[0].steps).toEqual([
        expect.objectContaining({
          toolName: 'agent:default',
          status: 'succeeded',
        }),
      ]);
    });

    it('should feed network tool results to device inventory', async () => {
      const toolExecutor = createMockToolExecutor();
      toolExecutor.runTool.mockResolvedValue({
        success: true,
        status: 'completed',
        jobId: 'j1',
        message: 'Done',
        output: { devices: [{ ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:ff' }] },
      });
      const localDeps = createDeps({ toolExecutor });
      const localService = new ScheduledTaskService(localDeps);
      const { task } = localService.create({ ...validInput, target: 'net_arp_scan' });
      await localService.runNow(task!.id);
      expect(localDeps.deviceInventory.ingestPlaybookResults).toHaveBeenCalled();
    });

    it('should trigger onNetworkScanComplete for inventory scan tools', async () => {
      const onNetworkScanComplete = vi.fn();
      const localDeps = createDeps({ onNetworkScanComplete });
      const localService = new ScheduledTaskService(localDeps);
      const { task } = localService.create({ ...validInput, target: 'net_arp_scan' });
      await localService.runNow(task!.id);
      expect(onNetworkScanComplete).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'tool', target: 'net_arp_scan' }),
      );
    });

    it('should trigger onNetworkScanComplete for threat analysis tools', async () => {
      const onNetworkScanComplete = vi.fn();
      const localDeps = createDeps({ onNetworkScanComplete });
      const localService = new ScheduledTaskService(localDeps);
      const { task } = localService.create({ ...validInput, target: 'net_threat_check' });
      await localService.runNow(task!.id);
      expect(onNetworkScanComplete).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'tool', target: 'net_threat_check' }),
      );
    });

    it('should feed playbook results to device inventory', async () => {
      const { task } = service.create({ ...validInput, type: 'playbook', target: 'home-network' });
      await service.runNow(task!.id);
      expect(deps.deviceInventory.ingestPlaybookResults).toHaveBeenCalled();
    });

    it('should trigger onNetworkScanComplete for playbooks with inventory scan steps', async () => {
      const onNetworkScanComplete = vi.fn();
      const localDeps = createDeps({ onNetworkScanComplete });
      const localService = new ScheduledTaskService(localDeps);
      const { task } = localService.create({ ...validInput, type: 'playbook', target: 'home-network' });
      await localService.runNow(task!.id);
      expect(onNetworkScanComplete).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'playbook', target: 'home-network' }),
      );
    });

    it('should emit completion event to EventBus', async () => {
      const { task } = service.create(validInput);
      await service.runNow(task!.id);
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'scheduled_task_completed',
          sourceAgentId: `sched-task:${task!.id}`,
          targetAgentId: '*',
        }),
      );
    });

    it('should emit custom event when configured', async () => {
      const { task } = service.create({ ...validInput, emitEvent: 'custom_event' });
      await service.runNow(task!.id);
      const calls = vi.mocked(deps.eventBus.emit).mock.calls;
      expect(calls.some(c => (c[0] as { type: string }).type === 'custom_event')).toBe(true);
    });

    it('runs event-triggered tasks when a matching event is emitted', async () => {
      const localDeps = createDeps();
      const localService = new ScheduledTaskService(localDeps);
      const { task } = localService.create({
        name: 'Secret Exposure Review',
        type: 'tool',
        target: 'security_containment_status',
        args: { profile: 'personal', currentMode: 'monitor' },
        eventTrigger: {
          eventType: 'security:alert',
          match: {
            'payload.sourceEventType': 'secret_detected',
          },
        },
      });

      await (localDeps.eventBus as any).emit({
        type: 'security:alert',
        sourceAgentId: 'notification-service',
        targetAgentId: '*',
        payload: {
          sourceEventType: 'secret_detected',
        },
        timestamp: 1_500,
      });
      await Promise.resolve();

      expect(localDeps.toolExecutor.runTool).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'security_containment_status',
        bypassApprovals: true,
      }));
      const history = localService.getHistory();
      expect(history[0]?.taskId).toBe(task!.id);
      expect(history[0]?.events?.[0]).toMatchObject({
        type: 'run_created',
        metadata: expect.objectContaining({
          triggerKind: 'event',
          triggerEventType: 'security:alert',
        }),
      });
      const completionCall = vi.mocked(localDeps.eventBus.emit).mock.calls.find((call) => (call[0] as { type: string }).type === 'scheduled_task_completed');
      expect(completionCall?.[0]).toMatchObject({
        payload: expect.objectContaining({
          triggerKind: 'event',
          triggerEventType: 'security:alert',
        }),
      });
    });

    it('should handle execution error gracefully', async () => {
      const toolExecutor = createMockToolExecutor();
      toolExecutor.runTool.mockRejectedValue(new Error('Boom'));
      const localDeps = createDeps({ toolExecutor });
      const localService = new ScheduledTaskService(localDeps);
      const { task } = localService.create(validInput);
      const result = await localService.runNow(task!.id);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Boom');
    });

    it('blocks execution when approval has expired', async () => {
      const { task } = service.create({ ...validInput, approvalExpiresAt: 999999 });
      const result = await service.runNow(task!.id);

      expect(result.success).toBe(false);
      expect(result.message).toContain('approval has expired');
      expect(deps.toolExecutor.runTool).not.toHaveBeenCalled();
    });

    it('auto-pauses after repeated failures', async () => {
      const toolExecutor = createMockToolExecutor();
      toolExecutor.runTool.mockResolvedValue({
        success: false,
        status: 'failed',
        message: 'Nope',
      });
      const localService = new ScheduledTaskService(createDeps({ toolExecutor }));
      const { task } = localService.create(validInput);

      await localService.runNow(task!.id);
      await localService.runNow(task!.id);
      const third = await localService.runNow(task!.id);

      expect(third.success).toBe(false);
      expect(localService.get(task!.id)?.enabled).toBe(false);
      expect(localService.get(task!.id)?.autoPausedReason).toContain('Consecutive failure threshold');
    });

    it('blocks overlapping runs for the same scheduled task', async () => {
      let resolveRun: ((value: unknown) => void) | undefined;
      const toolExecutor = {
        runTool: vi.fn().mockImplementation(() => new Promise((resolve) => {
          resolveRun = resolve;
        })),
      };
      const localService = new ScheduledTaskService(createDeps({
        toolExecutor: toolExecutor as unknown as ScheduledTaskServiceDeps['toolExecutor'],
      }));
      const { task } = localService.create(validInput);

      const firstRun = localService.runNow(task!.id);
      await Promise.resolve();
      const secondRun = await localService.runNow(task!.id);

      expect(secondRun.success).toBe(false);
      expect(secondRun.message).toContain('active run in progress');

      resolveRun?.({
        success: true,
        status: 'completed',
        message: 'Tool executed',
        output: { result: 'ok' },
      });
      await firstRun;
    });

    it('should return error for unknown id', async () => {
      const result = await service.runNow('nonexistent');
      expect(result.success).toBe(false);
    });

    it('should disable a run-once task after its first execution', async () => {
      const { task } = service.create({ ...validInput, runOnce: true });
      const result = await service.runNow(task!.id);
      expect(result.success).toBe(true);
      expect(service.get(task!.id)?.enabled).toBe(false);
      expect(service.get(task!.id)?.lastRunMessage).toContain('One-shot task disabled after execution.');
      expect(deps.scheduler.unschedule).toHaveBeenCalled();
    });

    it('should record run in history', async () => {
      const { task } = service.create(validInput);
      await service.runNow(task!.id);
      const history = service.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBeTruthy();
      expect(history[0].taskId).toBe(task!.id);
      expect(history[0].taskType).toBe('tool');
      expect(history[0].target).toBe('net_arp_scan');
      expect(history[0].status).toBe('succeeded');
      expect(history[0].steps).toEqual([
        expect.objectContaining({
          toolName: 'net_arp_scan',
          status: 'succeeded',
          output: { result: 'ok' },
        }),
      ]);
    });

    it('should keep playbook step output in history', async () => {
      const { task } = service.create({ ...validInput, type: 'playbook', target: 'home-network' });
      await service.runNow(task!.id);
      const history = service.getHistory();
      expect(history[0].taskType).toBe('playbook');
      expect(history[0].steps).toEqual([
        expect.objectContaining({
          toolName: 'net_arp_scan',
          status: 'succeeded',
          output: { devices: [] },
        }),
      ]);
    });
  });

  describe('presets', () => {
    it('should return built-in presets', () => {
      const presets = service.getPresets();
      expect(presets.length).toBeGreaterThanOrEqual(3);
      expect(presets.find(p => p.id === 'network-watch')).toBeDefined();
      expect(presets.find(p => p.id === 'system-health')).toBeDefined();
      expect(presets.find(p => p.id === 'full-network-discovery')).toBeDefined();
      expect(presets.find(p => p.id === 'host-security-baseline')).toBeDefined();
      expect(presets.find(p => p.id === 'anomaly-response-triage')).toBeDefined();
      expect(presets.find(p => p.id === 'host-monitor-watch')).toBeDefined();
      expect(presets.find(p => p.id === 'firewall-posture-watch')).toBeDefined();
      expect(presets.find(p => p.id === 'gateway-firewall-watch')).toBeDefined();
      expect(presets.find(p => p.id === 'gateway-firewall-posture')).toBeDefined();
    });

    it('should install a preset as disabled by default', () => {
      const result = service.installPreset('network-watch');
      expect(result.success).toBe(true);
      expect(result.task).toBeDefined();
      expect(result.task!.name).toBe('Network Watch');
      expect(result.task!.target).toBe('net_arp_scan');
      expect(result.task!.presetId).toBe('network-watch');
      expect(result.task!.enabled).toBe(false);
    });

    it('should reject unknown preset', () => {
      const result = service.installPreset('nonexistent');
      expect(result.success).toBe(false);
    });

    it('should reject duplicate preset installation', () => {
      service.installPreset('network-watch');
      const result = service.installPreset('network-watch');
      expect(result.success).toBe(false);
      expect(result.message).toContain('already installed');
    });
  });

  describe('migratePlaybookSchedules', () => {
    it('should migrate enabled playbooks with schedules', () => {
      const playbooks = [
        { id: 'pb-1', name: 'Test Playbook', enabled: true, schedule: '0 * * * *' },
        { id: 'pb-2', name: 'Disabled', enabled: false, schedule: '0 * * * *' },
        { id: 'pb-3', name: 'No Schedule', enabled: true },
      ];
      const count = service.migratePlaybookSchedules(playbooks);
      expect(count).toBe(1);
      const tasks = service.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe('playbook');
      expect(tasks[0].target).toBe('pb-1');
    });

    it('should skip already migrated playbooks', () => {
      service.create({ name: 'Existing', type: 'playbook', target: 'pb-1', cron: '0 * * * *' });
      const playbooks = [
        { id: 'pb-1', name: 'Test', enabled: true, schedule: '0 * * * *' },
      ];
      const count = service.migratePlaybookSchedules(playbooks);
      expect(count).toBe(0);
    });
  });
});
