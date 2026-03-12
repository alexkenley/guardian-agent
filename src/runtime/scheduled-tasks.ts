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
import type { AutomationOutputHandlingConfig } from '../config/types.js';
import type { AuditLog } from '../guardian/audit-log.js';
import type { CronScheduler } from './scheduler.js';
import type { EventBus, AgentEvent } from '../queue/event-bus.js';
import type { DeviceInventoryService } from './device-inventory.js';
import { promoteAutomationFindings, type AutomationPromotedFindingRef } from './automation-output.js';
const log = createLogger('scheduled-tasks');

// ─── Types ────────────────────────────────────────────────

export type ScheduledTaskStatus = 'succeeded' | 'failed' | 'pending_approval';

export interface ScheduledTaskDefinition {
  id: string;
  name: string;
  type: 'tool' | 'playbook';
  target: string;
  presetId?: string;
  args?: Record<string, unknown>;
  cron: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastRunStatus?: ScheduledTaskStatus;
  lastRunMessage?: string;
  runCount: number;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface ScheduledTaskCreateInput {
  name: string;
  type: 'tool' | 'playbook';
  target: string;
  presetId?: string;
  args?: Record<string, unknown>;
  cron: string;
  enabled?: boolean;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface ScheduledTaskUpdateInput {
  name?: string;
  type?: 'tool' | 'playbook';
  target?: string;
  args?: Record<string, unknown>;
  cron?: string;
  enabled?: boolean;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface ScheduledTaskRunResult {
  success: boolean;
  status: ScheduledTaskStatus;
  message: string;
  durationMs: number;
  output?: unknown;
  outputHandling?: AutomationOutputHandlingConfig;
  promotedFindings?: AutomationPromotedFindingRef[];
  steps?: Array<{
    stepId?: string;
    toolName: string;
    status: ScheduledTaskStatus;
    message: string;
    durationMs: number;
    output?: unknown;
  }>;
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
  outputHandling?: AutomationOutputHandlingConfig;
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
    run: {
      outputHandling?: AutomationOutputHandlingConfig;
      promotedFindings?: AutomationPromotedFindingRef[];
      steps: Array<{
        stepId?: string;
        toolName: string;
        status?: string;
        message?: string;
        durationMs?: number;
        output?: unknown;
      }>;
    };
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
    id: 'network-anomaly-guard',
    name: 'Network Anomaly Guard',
    description: 'Run baseline anomaly detection every 15 minutes',
    type: 'tool',
    target: 'net_anomaly_check',
    args: {},
    cron: '*/15 * * * *',
    emitEvent: 'network_anomaly_checked',
  },
  {
    id: 'network-threat-summary',
    name: 'Network Threat Summary',
    description: 'Generate active network threat summary every 30 minutes',
    type: 'tool',
    target: 'net_threat_summary',
    args: { limit: 50 },
    cron: '*/30 * * * *',
    emitEvent: 'network_threat_summary_generated',
  },
  {
    id: 'network-baseline-status',
    name: 'Network Baseline Status',
    description: 'Capture network baseline status every 6 hours',
    type: 'tool',
    target: 'net_baseline',
    args: {},
    cron: '0 */6 * * *',
    emitEvent: 'network_baseline_checked',
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
    description: 'Run network-discovery workflow every 6 hours',
    type: 'playbook',
    target: 'network-discovery',
    cron: '0 */6 * * *',
    emitEvent: 'network_discovery_completed',
  },
  {
    id: 'resource-monitor',
    name: 'Resource Monitor',
    description: 'Check CPU, memory, and disk usage every 15 minutes',
    type: 'tool',
    target: 'sys_resources',
    args: {},
    cron: '*/15 * * * *',
    emitEvent: 'resource_check_completed',
  },
  {
    id: 'process-watch',
    name: 'Process Watch',
    description: 'List top 20 processes by CPU every hour',
    type: 'tool',
    target: 'sys_processes',
    args: { sortBy: 'cpu', limit: 20 },
    cron: '0 * * * *',
    emitEvent: 'process_watch_completed',
  },
  {
    id: 'service-check',
    name: 'Service Check',
    description: 'Check running services every 2 hours',
    type: 'tool',
    target: 'sys_services',
    args: {},
    cron: '0 */2 * * *',
    emitEvent: 'service_check_completed',
  },
  {
    id: 'connection-audit',
    name: 'Connection Audit',
    description: 'Audit active network connections every 30 minutes',
    type: 'tool',
    target: 'net_connections',
    args: {},
    cron: '*/30 * * * *',
    emitEvent: 'connection_audit_completed',
  },
  {
    id: 'network-fingerprint-scan',
    name: 'Network Fingerprint Scan',
    description: 'Fingerprint local gateway services every 6 hours',
    type: 'tool',
    target: 'net_fingerprint',
    args: { host: '192.168.1.1', portScan: true },
    cron: '0 */6 * * *',
    emitEvent: 'network_fingerprint_completed',
  },
  {
    id: 'traffic-threat-check',
    name: 'Traffic Threat Check',
    description: 'Evaluate traffic threat rules every 15 minutes',
    type: 'tool',
    target: 'net_threat_check',
    args: { refresh: true },
    cron: '*/15 * * * *',
    emitEvent: 'traffic_threat_check_completed',
  },
  {
    id: 'wifi-scan',
    name: 'WiFi Scan',
    description: 'Scan nearby WiFi networks every 30 minutes',
    type: 'tool',
    target: 'net_wifi_scan',
    args: { force: true },
    cron: '*/30 * * * *',
    emitEvent: 'wifi_scan_completed',
  },
  {
    id: 'dns-health-check',
    name: 'DNS Health Check',
    description: 'Verify DNS resolution every hour',
    type: 'tool',
    target: 'net_dns_lookup',
    args: { target: 'google.com', type: 'A' },
    cron: '0 * * * *',
    emitEvent: 'dns_health_checked',
  },
  {
    id: 'gateway-ping',
    name: 'Gateway Ping',
    description: 'Ping default gateway every 10 minutes',
    type: 'tool',
    target: 'net_ping',
    args: { host: '192.168.1.1', count: 3 },
    cron: '*/10 * * * *',
    emitEvent: 'gateway_ping_completed',
  },
  {
    id: 'localhost-port-scan',
    name: 'Localhost Port Scan',
    description: 'Scan common ports on localhost every 4 hours',
    type: 'tool',
    target: 'net_port_check',
    args: { host: 'localhost', ports: [22, 80, 443, 3306, 5432, 8080, 8443] },
    cron: '0 */4 * * *',
    emitEvent: 'port_scan_completed',
  },
  {
    id: 'threat-intel-scan',
    name: 'Threat Intel Scan',
    description: 'Run threat intelligence scan every 12 hours',
    type: 'tool',
    target: 'intel_scan',
    args: {},
    cron: '0 */12 * * *',
    emitEvent: 'threat_intel_scanned',
  },
  {
    id: 'host-security-baseline',
    name: 'Host Security Baseline',
    description: 'Run the built-in workstation security baseline playbook every 6 hours',
    type: 'playbook',
    target: 'host-security-baseline',
    cron: '0 */6 * * *',
    emitEvent: 'host_security_baseline_completed',
  },
  {
    id: 'anomaly-response-triage',
    name: 'Anomaly Response Triage',
    description: 'Run anomaly triage every 30 minutes for suspicious workstation/network activity',
    type: 'playbook',
    target: 'anomaly-response-triage',
    cron: '*/30 * * * *',
    emitEvent: 'anomaly_response_triage_completed',
  },
  {
    id: 'host-monitor-watch',
    name: 'Host Monitor Watch',
    description: 'Run an immediate host workstation monitoring check every 15 minutes',
    type: 'tool',
    target: 'host_monitor_check',
    args: {},
    cron: '*/15 * * * *',
    emitEvent: 'host_monitor_checked',
  },
  {
    id: 'firewall-posture-watch',
    name: 'Firewall Posture Watch',
    description: 'Capture host firewall posture and active firewall alerts every hour',
    type: 'tool',
    target: 'host_monitor_status',
    args: { limit: 25 },
    cron: '0 * * * *',
    emitEvent: 'host_firewall_posture_checked',
  },
  {
    id: 'gateway-firewall-watch',
    name: 'Gateway Firewall Watch',
    description: 'Run a gateway firewall drift check every 20 minutes',
    type: 'tool',
    target: 'gateway_firewall_check',
    args: {},
    cron: '*/20 * * * *',
    emitEvent: 'gateway_firewall_checked',
  },
  {
    id: 'gateway-firewall-posture',
    name: 'Gateway Firewall Posture',
    description: 'Capture current gateway firewall posture and recent perimeter alerts every 2 hours',
    type: 'tool',
    target: 'gateway_firewall_status',
    args: { limit: 25 },
    cron: '0 */2 * * *',
    emitEvent: 'gateway_firewall_posture_checked',
  },
  {
    id: 'knowledge-base-check',
    name: 'Knowledge Base Check',
    description: 'Review agent knowledge base daily at 6 AM',
    type: 'tool',
    target: 'memory_recall',
    args: {},
    cron: '0 6 * * *',
    emitEvent: 'knowledge_base_checked',
  },
  {
    id: 'daily-system-report',
    name: 'Daily System Report',
    description: 'Collect system info daily at midnight',
    type: 'tool',
    target: 'sys_info',
    args: {},
    cron: '0 0 * * *',
    emitEvent: 'daily_report_completed',
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
  auditLog?: AuditLog;
  onNetworkScanComplete?: (meta: {
    source: 'tool' | 'playbook';
    taskId: string;
    taskName: string;
    target: string;
  }) => void | Promise<void>;
  resolvePlaybookOutputHandling?: (playbookId: string) => AutomationOutputHandlingConfig | undefined;
  persistPath?: string;
  now?: () => number;
}

export interface ScheduledTaskHistoryEntry {
  id: string;
  taskId: string;
  taskName: string;
  taskType: 'tool' | 'playbook';
  target: string;
  timestamp: number;
  status: ScheduledTaskStatus;
  durationMs: number;
  message: string;
  output?: unknown;
  outputHandling?: AutomationOutputHandlingConfig;
  promotedFindings?: AutomationPromotedFindingRef[];
  steps?: ScheduledTaskRunResult['steps'];
}

export class ScheduledTaskService {
  private readonly tasks = new Map<string, ScheduledTaskDefinition>();
  private readonly scheduler: CronScheduler;
  private readonly toolExecutor: ScheduledTaskToolExecutor;
  private readonly playbookExecutor: ScheduledTaskPlaybookExecutor;
  private readonly deviceInventory: DeviceInventoryService;
  private readonly eventBus: EventBus;
  private readonly auditLog?: AuditLog;
  private readonly onNetworkScanComplete?: ScheduledTaskServiceDeps['onNetworkScanComplete'];
  private readonly resolvePlaybookOutputHandling?: ScheduledTaskServiceDeps['resolvePlaybookOutputHandling'];
  private readonly persistPath: string;
  private readonly now: () => number;
  /** Run history — kept in memory, most recent first. */
  private readonly history: ScheduledTaskHistoryEntry[] = [];
  private readonly maxHistory = 100;

  constructor(deps: ScheduledTaskServiceDeps) {
    this.scheduler = deps.scheduler;
    this.toolExecutor = deps.toolExecutor;
    this.playbookExecutor = deps.playbookExecutor;
    this.deviceInventory = deps.deviceInventory;
    this.eventBus = deps.eventBus;
    this.auditLog = deps.auditLog;
    this.onNetworkScanComplete = deps.onNetworkScanComplete;
    this.resolvePlaybookOutputHandling = deps.resolvePlaybookOutputHandling;
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
      presetId: input.presetId?.trim() || undefined,
      args: input.args,
      cron: input.cron.trim(),
      enabled: input.enabled !== false,
      createdAt: this.now(),
      runCount: 0,
      emitEvent: input.emitEvent?.trim() || undefined,
      outputHandling: this.resolveOutputHandling(input),
    };

    if (task.presetId) {
      const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === task.presetId);
      if (!preset || task.type !== preset.type || task.target !== preset.target) {
        task.presetId = undefined;
      }
    }

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

    if (input.name !== undefined) {
      if (!input.name.trim()) return { success: false, message: 'name is required' };
      task.name = input.name.trim();
    }
    if (input.type !== undefined) {
      if (input.type !== 'tool' && input.type !== 'playbook') {
        return { success: false, message: "type must be 'tool' or 'playbook'" };
      }
      task.type = input.type;
    }
    if (input.target !== undefined) {
      if (!input.target.trim()) return { success: false, message: 'target is required' };
      task.target = input.target.trim();
    }
    if (input.args !== undefined) task.args = input.args;
    if (input.cron !== undefined) task.cron = input.cron.trim();
    if (input.enabled !== undefined) task.enabled = input.enabled;
    if (input.emitEvent !== undefined) task.emitEvent = input.emitEvent?.trim() || undefined;
    if (input.outputHandling !== undefined) task.outputHandling = input.outputHandling;

    if (task.presetId) {
      const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === task.presetId);
      if (preset && (task.type !== preset.type || task.target !== preset.target)) {
        task.presetId = undefined;
      }
    }

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

  getHistory(): ScheduledTaskHistoryEntry[] {
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
    result.outputHandling = result.outputHandling ?? task.outputHandling;
    result.promotedFindings = this.promoteRunFindings(task, result);

    // Record history
    this.history.unshift({
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      taskType: task.type,
      target: task.target,
      timestamp: task.lastRunAt,
      status: result.status,
      durationMs: result.durationMs,
      message: result.message,
      output: result.output,
      outputHandling: result.outputHandling,
      promotedFindings: result.promotedFindings?.map((finding) => ({ ...finding })),
      steps: result.steps?.map((step) => ({ ...step })),
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
      const updatedInventory = this.feedDeviceInventory(task.target, toolResult.output);
      if (updatedInventory || isNetworkAnalysisTriggerTool(task.target)) {
        this.onNetworkScanComplete?.({
          source: 'tool',
          taskId: task.id,
          taskName: task.name,
          target: task.target,
        });
      }
    }

    return {
      success: toolResult.success,
      status,
      message: toolResult.message,
      durationMs: 0,
      output: toolResult.output,
      outputHandling: task.outputHandling,
      steps: [{
        stepId: `${task.id}-step-1`,
        toolName: task.target,
        status,
        message: toolResult.message,
        durationMs: 0,
        output: toolResult.output,
      }],
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
      const touchedNetworkAnalysis = pbResult.run.steps.some((step) => isNetworkAnalysisTriggerTool(step.toolName));
      if (touchedNetworkAnalysis) {
        this.onNetworkScanComplete?.({
          source: 'playbook',
          taskId: task.id,
          taskName: task.name,
          target: task.target,
        });
      }
    }

    return {
      success: pbResult.success,
      status,
      message: pbResult.message,
      durationMs: 0,
      outputHandling: task.outputHandling ?? pbResult.run?.outputHandling,
      promotedFindings: pbResult.run?.promotedFindings?.map((finding) => ({ ...finding })),
      steps: (pbResult.run?.steps ?? []).map((step) => ({
        stepId: step.stepId,
        toolName: step.toolName,
        status: normalizeStepStatus(step.status),
        message: step.message ?? '',
        durationMs: step.durationMs ?? 0,
        output: step.output,
      })),
    };
  }

  private feedDeviceInventory(toolName: string, output: unknown): boolean {
    // Wrap single tool output as a playbook step for device inventory ingestion
    if (isInventoryScanTool(toolName)) {
      this.deviceInventory.ingestPlaybookResults([{ toolName, output }]);
      return true;
    }
    return false;
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
        promotedFindings: result.promotedFindings,
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

  private resolveOutputHandling(
    input: Pick<ScheduledTaskCreateInput, 'type' | 'target' | 'outputHandling'>,
  ): AutomationOutputHandlingConfig | undefined {
    if (input.outputHandling) return input.outputHandling;
    if (input.type === 'playbook') {
      return this.resolvePlaybookOutputHandling?.(input.target);
    }
    return undefined;
  }

  private promoteRunFindings(
    task: ScheduledTaskDefinition,
    result: ScheduledTaskRunResult,
  ): AutomationPromotedFindingRef[] {
    if (result.promotedFindings?.length) {
      return result.promotedFindings;
    }
    if (!this.auditLog) return [];
    return promoteAutomationFindings(this.auditLog, {
      automationId: task.target,
      automationName: task.name,
      runId: `${task.id}:${task.lastRunAt ?? this.now()}`,
      status: result.status,
      message: result.message,
      steps: result.steps,
      outputHandling: result.outputHandling ?? task.outputHandling,
      origin: 'scheduled-task',
      agentId: `sched-task:${task.id}`,
      emittedEvent: task.emitEvent,
      target: task.target,
      taskId: task.id,
    });
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
      if (
        task.presetId === preset.id
        || (task.name === preset.name && task.target === preset.target && task.type === preset.type)
      ) {
        return { success: false, message: `Preset '${preset.name}' is already installed` };
      }
    }

    return this.create({
      name: preset.name,
      type: preset.type,
      target: preset.target,
      presetId: preset.id,
      args: preset.args,
      cron: preset.cron,
      enabled: false,
      emitEvent: preset.emitEvent,
    });
  }

  autoInstallAllPresets(): number {
    let installed = 0;
    for (const preset of BUILT_IN_PRESETS) {
      const result = this.installPreset(preset.id);
      if (result.success) installed++;
    }
    if (installed > 0) {
      log.info({ installed, total: BUILT_IN_PRESETS.length }, 'Auto-installed preset scheduled tasks');
    }
    return installed;
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

function isInventoryScanTool(toolName: string): boolean {
  return toolName === 'net_arp_scan' || toolName === 'net_port_check' || toolName === 'net_dns_lookup';
}

function isNetworkAnalysisTriggerTool(toolName: string): boolean {
  return isInventoryScanTool(toolName)
    || toolName === 'net_anomaly_check'
    || toolName === 'net_traffic_baseline'
    || toolName === 'net_threat_check'
    || toolName === 'net_connections';
}

function normalizeStepStatus(status: string | undefined): ScheduledTaskStatus {
  if (status === 'pending_approval') {
    return 'pending_approval';
  }
  return status === 'succeeded' ? 'succeeded' : 'failed';
}
