/**
 * Scheduled Tasks Service — unified CRUD scheduling for tools and playbooks.
 *
 * Any tool or playbook can be scheduled to run at intervals or specific times.
 * Results trigger events on the EventBus and feed into DeviceInventoryService.
 * Definitions are persisted to ~/.guardianagent/scheduled-tasks.json.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createLogger } from '../util/logging.js';
import type { CronScheduler } from './scheduler.js';
import type { EventBus, AgentEvent } from '../queue/event-bus.js';
import type { DeviceInventoryService } from './device-inventory.js';
const log = createLogger('scheduled-tasks');

// ─── Types ────────────────────────────────────────────────

export type ScheduledTaskStatus = 'succeeded' | 'failed' | 'pending_approval';

export interface ScheduledTaskDefinition {
  id: string;
  name: string;
  type: 'tool' | 'playbook';
  target: string;
  args?: Record<string, unknown>;
  cron: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastRunStatus?: ScheduledTaskStatus;
  lastRunMessage?: string;
  runCount: number;
  emitEvent?: string;
}

export interface ScheduledTaskCreateInput {
  name: string;
  type: 'tool' | 'playbook';
  target: string;
  args?: Record<string, unknown>;
  cron: string;
  enabled?: boolean;
  emitEvent?: string;
}

export interface ScheduledTaskUpdateInput {
  name?: string;
  args?: Record<string, unknown>;
  cron?: string;
  enabled?: boolean;
  emitEvent?: string;
}

export interface ScheduledTaskRunResult {
  success: boolean;
  status: ScheduledTaskStatus;
  message: string;
  durationMs: number;
  output?: unknown;
}

export interface ScheduledTaskPreset {
  id: string;
  name: string;
  description: string;
  type: 'tool' | 'playbook';
  target: string;
  args?: Record<string, unknown>;
  cron: string;
  emitEvent?: string;
}

/** Tool executor interface — matches ToolExecutor.runTool signature. */
export interface ScheduledTaskToolExecutor {
  runTool(request: {
    toolName: string;
    args: Record<string, unknown>;
    origin: 'assistant' | 'cli' | 'web';
    agentId?: string;
  }): Promise<{ success: boolean; status: string; message: string; output?: unknown }>;
}

/** Playbook executor interface — matches ConnectorPlaybookService.runPlaybook signature. */
export interface ScheduledTaskPlaybookExecutor {
  runPlaybook(input: {
    playbookId: string;
    origin: 'assistant' | 'cli' | 'web';
    requestedBy?: string;
  }): Promise<{
    success: boolean;
    status: string;
    message: string;
    run: { steps: Array<{ toolName: string; output?: unknown }> };
  }>;
}

// ─── Built-in Presets ─────────────────────────────────────

const BUILT_IN_PRESETS: ScheduledTaskPreset[] = [
  {
    id: 'network-watch',
    name: 'Network Watch',
    description: 'ARP scan every 30 minutes to discover network devices',
    type: 'tool',
    target: 'net_arp_scan',
    args: {},
    cron: '*/30 * * * *',
    emitEvent: 'network_scan_completed',
  },
  {
    id: 'system-health',
    name: 'System Health Check',
    description: 'Run uptime check every hour',
    type: 'tool',
    target: 'shell_safe',
    args: { command: 'uptime' },
    cron: '0 * * * *',
    emitEvent: 'system_health_checked',
  },
  {
    id: 'full-network-discovery',
    name: 'Full Network Discovery',
    description: 'Run home-network playbook every 6 hours',
    type: 'playbook',
    target: 'home-network',
    cron: '0 */6 * * *',
    emitEvent: 'network_discovery_completed',
  },
];

// ─── Service ──────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = resolve(homedir(), '.guardianagent', 'scheduled-tasks.json');

export interface ScheduledTaskServiceDeps {
  scheduler: CronScheduler;
  toolExecutor: ScheduledTaskToolExecutor;
  playbookExecutor: ScheduledTaskPlaybookExecutor;
  deviceInventory: DeviceInventoryService;
  eventBus: EventBus;
  persistPath?: string;
  now?: () => number;
}

export class ScheduledTaskService {
  private readonly tasks = new Map<string, ScheduledTaskDefinition>();
  private readonly scheduler: CronScheduler;
  private readonly toolExecutor: ScheduledTaskToolExecutor;
  private readonly playbookExecutor: ScheduledTaskPlaybookExecutor;
  private readonly deviceInventory: DeviceInventoryService;
  private readonly eventBus: EventBus;
  private readonly persistPath: string;
  private readonly now: () => number;
  /** Run history — kept in memory, most recent first. */
  private readonly history: Array<{
    taskId: string;
    taskName: string;
    timestamp: number;
    status: ScheduledTaskStatus;
    durationMs: number;
    message: string;
  }> = [];
  private readonly maxHistory = 100;

  constructor(deps: ScheduledTaskServiceDeps) {
    this.scheduler = deps.scheduler;
    this.toolExecutor = deps.toolExecutor;
    this.playbookExecutor = deps.playbookExecutor;
    this.deviceInventory = deps.deviceInventory;
    this.eventBus = deps.eventBus;
    this.persistPath = deps.persistPath ?? DEFAULT_PERSIST_PATH;
    this.now = deps.now ?? Date.now;
  }

  // ─── Persistence ──────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as ScheduledTaskDefinition[];
      if (Array.isArray(data)) {
        for (const task of data) {
          if (task.id) {
            this.tasks.set(task.id, task);
            if (task.enabled) {
              this.registerCron(task);
            }
          }
        }
        log.info({ count: this.tasks.size }, 'Loaded scheduled tasks');
      }
    } catch {
      // No existing file — that's fine
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const data = Array.from(this.tasks.values());
      await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Best effort
    }
  }

  // ─── CRUD ─────────────────────────────────────────────

  create(input: ScheduledTaskCreateInput): { success: boolean; message: string; task?: ScheduledTaskDefinition } {
    if (!input.name?.trim()) {
      return { success: false, message: 'name is required' };
    }
    if (!input.type || (input.type !== 'tool' && input.type !== 'playbook')) {
      return { success: false, message: "type must be 'tool' or 'playbook'" };
    }
    if (!input.target?.trim()) {
      return { success: false, message: 'target is required' };
    }
    if (!input.cron?.trim()) {
      return { success: false, message: 'cron is required' };
    }

    const task: ScheduledTaskDefinition = {
      id: randomUUID(),
      name: input.name.trim(),
      type: input.type,
      target: input.target.trim(),
      args: input.args,
      cron: input.cron.trim(),
      enabled: input.enabled !== false,
      createdAt: this.now(),
      runCount: 0,
      emitEvent: input.emitEvent?.trim() || undefined,
    };

    this.tasks.set(task.id, task);

    if (task.enabled) {
      try {
        this.registerCron(task);
      } catch (err) {
        this.tasks.delete(task.id);
        return { success: false, message: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    this.persist().catch(() => {});
    log.info({ taskId: task.id, name: task.name, cron: task.cron }, 'Scheduled task created');
    return { success: true, message: `Task '${task.name}' created`, task };
  }

  update(id: string, input: ScheduledTaskUpdateInput): { success: boolean; message: string } {
    const task = this.tasks.get(id);
    if (!task) {
      return { success: false, message: 'Task not found' };
    }

    const cronChanged = input.cron !== undefined && input.cron !== task.cron;
    const enableChanged = input.enabled !== undefined && input.enabled !== task.enabled;

    if (input.name !== undefined) task.name = input.name.trim();
    if (input.args !== undefined) task.args = input.args;
    if (input.cron !== undefined) task.cron = input.cron.trim();
    if (input.enabled !== undefined) task.enabled = input.enabled;
    if (input.emitEvent !== undefined) task.emitEvent = input.emitEvent?.trim() || undefined;

    // Re-register cron if expression changed or enabled state changed
    if (cronChanged || enableChanged) {
      this.unregisterCron(task);
      if (task.enabled) {
        try {
          this.registerCron(task);
        } catch (err) {
          return { success: false, message: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }

    this.persist().catch(() => {});
    log.info({ taskId: id, name: task.name }, 'Scheduled task updated');
    return { success: true, message: `Task '${task.name}' updated` };
  }

  delete(id: string): { success: boolean; message: string } {
    const task = this.tasks.get(id);
    if (!task) {
      return { success: false, message: 'Task not found' };
    }

    this.unregisterCron(task);
    this.tasks.delete(id);
    this.persist().catch(() => {});
    log.info({ taskId: id, name: task.name }, 'Scheduled task deleted');
    return { success: true, message: `Task '${task.name}' deleted` };
  }

  list(): ScheduledTaskDefinition[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ScheduledTaskDefinition | null {
    return this.tasks.get(id) ?? null;
  }

  getHistory(): typeof this.history {
    return this.history.slice(0, this.maxHistory);
  }

  // ─── Execution ────────────────────────────────────────

  async runNow(id: string): Promise<{ success: boolean; message: string }> {
    const task = this.tasks.get(id);
    if (!task) {
      return { success: false, message: 'Task not found' };
    }

    log.info({ taskId: id, name: task.name }, 'Manual run triggered');
    const result = await this.executeTask(task);
    return { success: result.success, message: result.message };
  }

  private async executeTask(task: ScheduledTaskDefinition): Promise<ScheduledTaskRunResult> {
    const start = this.now();
    let result: ScheduledTaskRunResult;

    try {
      if (task.type === 'tool') {
        result = await this.executeTool(task);
      } else {
        result = await this.executePlaybook(task);
      }
    } catch (err) {
      const durationMs = this.now() - start;
      result = {
        success: false,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }

    result.durationMs = this.now() - start;

    // Update task state
    task.lastRunAt = this.now();
    task.lastRunStatus = result.status;
    task.lastRunMessage = result.message;
    task.runCount++;

    // Record history
    this.history.unshift({
      taskId: task.id,
      taskName: task.name,
      timestamp: task.lastRunAt,
      status: result.status,
      durationMs: result.durationMs,
      message: result.message,
    });
    if (this.history.length > this.maxHistory) {
      this.history.length = this.maxHistory;
    }

    // Emit events
    this.emitCompletionEvent(task, result);

    this.persist().catch(() => {});
    return result;
  }

  private async executeTool(task: ScheduledTaskDefinition): Promise<ScheduledTaskRunResult> {
    const toolResult = await this.toolExecutor.runTool({
      toolName: task.target,
      args: task.args ?? {},
      origin: 'web',
      agentId: `sched-task:${task.id}`,
    });

    const status: ScheduledTaskStatus = toolResult.status === 'pending_approval'
      ? 'pending_approval'
      : toolResult.success ? 'succeeded' : 'failed';

    // Feed network tool results to device inventory
    if (toolResult.success && toolResult.output) {
      this.feedDeviceInventory(task.target, toolResult.output);
    }

    return {
      success: toolResult.success,
      status,
      message: toolResult.message,
      durationMs: 0,
      output: toolResult.output,
    };
  }

  private async executePlaybook(task: ScheduledTaskDefinition): Promise<ScheduledTaskRunResult> {
    const pbResult = await this.playbookExecutor.runPlaybook({
      playbookId: task.target,
      origin: 'web',
      requestedBy: 'scheduled-tasks',
    });

    const status: ScheduledTaskStatus = pbResult.status === 'awaiting_approval'
      ? 'pending_approval'
      : pbResult.success ? 'succeeded' : 'failed';

    // Feed playbook results to device inventory
    if (pbResult.run?.steps) {
      this.deviceInventory.ingestPlaybookResults(pbResult.run.steps);
    }

    return {
      success: pbResult.success,
      status,
      message: pbResult.message,
      durationMs: 0,
    };
  }

  private feedDeviceInventory(toolName: string, output: unknown): void {
    // Wrap single tool output as a playbook step for device inventory ingestion
    const networkTools = ['net_arp_scan', 'net_port_check', 'net_dns_lookup'];
    if (networkTools.includes(toolName)) {
      this.deviceInventory.ingestPlaybookResults([{ toolName, output }]);
    }
  }

  private emitCompletionEvent(task: ScheduledTaskDefinition, result: ScheduledTaskRunResult): void {
    const baseEvent: AgentEvent = {
      type: 'scheduled_task_completed',
      sourceAgentId: `sched-task:${task.id}`,
      targetAgentId: '*',
      payload: {
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
        target: task.target,
        status: result.status,
        message: result.message,
        durationMs: result.durationMs,
      },
      timestamp: this.now(),
    };
    this.eventBus.emit(baseEvent).catch(() => {});

    // Emit custom event if configured
    if (task.emitEvent) {
      const customEvent: AgentEvent = {
        ...baseEvent,
        type: task.emitEvent,
      };
      this.eventBus.emit(customEvent).catch(() => {});
    }
  }

  // ─── Cron Registration ────────────────────────────────

  private cronKey(task: ScheduledTaskDefinition): string {
    return `sched-task:${task.id}`;
  }

  private registerCron(task: ScheduledTaskDefinition): void {
    const agentId = this.cronKey(task);
    this.scheduler.schedule(agentId, task.cron, async () => {
      log.info({ taskId: task.id, name: task.name }, 'Scheduled task triggered');
      await this.executeTask(task);
    });
  }

  private unregisterCron(task: ScheduledTaskDefinition): void {
    const agentId = this.cronKey(task);
    this.scheduler.unschedule(agentId);
  }

  // ─── Presets ──────────────────────────────────────────

  getPresets(): ScheduledTaskPreset[] {
    return BUILT_IN_PRESETS;
  }

  installPreset(presetId: string): { success: boolean; message: string; task?: ScheduledTaskDefinition } {
    const preset = BUILT_IN_PRESETS.find(p => p.id === presetId);
    if (!preset) {
      return { success: false, message: `Preset '${presetId}' not found` };
    }

    // Check if preset is already installed
    for (const task of this.tasks.values()) {
      if (task.name === preset.name && task.target === preset.target) {
        return { success: false, message: `Preset '${preset.name}' is already installed` };
      }
    }

    return this.create({
      name: preset.name,
      type: preset.type,
      target: preset.target,
      args: preset.args,
      cron: preset.cron,
      enabled: true,
      emitEvent: preset.emitEvent,
    });
  }

  // ─── Migration ────────────────────────────────────────

  /**
   * Migrate hardcoded playbook schedules from bootstrap.
   * Called once during startup to convert existing scheduled playbooks
   * into ScheduledTaskService entries.
   */
  migratePlaybookSchedules(playbooks: Array<{ id: string; name: string; enabled: boolean; schedule?: string }>): number {
    let migrated = 0;
    for (const pb of playbooks) {
      if (!pb.enabled || !pb.schedule) continue;

      // Check if already migrated
      let alreadyExists = false;
      for (const task of this.tasks.values()) {
        if (task.type === 'playbook' && task.target === pb.id) {
          alreadyExists = true;
          break;
        }
      }
      if (alreadyExists) continue;

      const result = this.create({
        name: `${pb.name} (migrated)`,
        type: 'playbook',
        target: pb.id,
        cron: pb.schedule,
        enabled: true,
      });

      if (result.success) migrated++;
    }

    if (migrated > 0) {
      log.info({ migrated }, 'Migrated playbook schedules to ScheduledTaskService');
    }
    return migrated;
  }
}
