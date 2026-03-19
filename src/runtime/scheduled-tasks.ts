/**
 * Scheduled Tasks Service — unified CRUD scheduling for tools, playbooks, and agent turns.
 *
 * Any tool, playbook, or assistant turn can be scheduled to run at intervals or specific times.
 * Results trigger events on the EventBus and feed into DeviceInventoryService.
 * Definitions are persisted to ~/.guardianagent/scheduled-tasks.json.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import { createRunEvent, type OrchestrationRunEvent } from './run-events.js';
const log = createLogger('scheduled-tasks');

// ─── Types ────────────────────────────────────────────────

export type ScheduledTaskStatus = 'succeeded' | 'failed' | 'pending_approval';
export type ScheduledTaskType = 'tool' | 'playbook' | 'agent';

export interface ScheduledTaskEventTrigger {
  eventType: string;
  sourceAgentId?: string;
  targetAgentId?: string;
  match?: Record<string, string | number | boolean>;
}

export interface ScheduledTaskDefinition {
  id: string;
  name: string;
  description?: string;
  type: ScheduledTaskType;
  target: string;
  presetId?: string;
  args?: Record<string, unknown>;
  prompt?: string;
  channel?: string;
  userId?: string;
  principalId?: string;
  principalRole?: import('../tools/types.js').PrincipalRole;
  deliver?: boolean;
  runOnce?: boolean;
  cron?: string;
  eventTrigger?: ScheduledTaskEventTrigger;
  enabled: boolean;
  createdAt: number;
  approvalExpiresAt?: number;
  lastApprovedAt?: number;
  approvedByPrincipal?: string;
  scopeHash: string;
  maxRunsPerWindow: number;
  dailySpendCap: number;
  providerSpendCap: number;
  consecutiveFailureCount: number;
  consecutiveDeniedCount: number;
  autoPausedReason?: string;
  lastRunAt?: number;
  lastRunStatus?: ScheduledTaskStatus;
  lastRunMessage?: string;
  runCount: number;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface ScheduledTaskCreateInput {
  name: string;
  description?: string;
  type: ScheduledTaskType;
  target: string;
  presetId?: string;
  args?: Record<string, unknown>;
  prompt?: string;
  channel?: string;
  userId?: string;
  principalId?: string;
  principalRole?: import('../tools/types.js').PrincipalRole;
  deliver?: boolean;
  runOnce?: boolean;
  cron?: string;
  eventTrigger?: ScheduledTaskEventTrigger;
  enabled?: boolean;
  approvalExpiresAt?: number;
  maxRunsPerWindow?: number;
  dailySpendCap?: number;
  providerSpendCap?: number;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface ScheduledTaskUpdateInput {
  name?: string;
  description?: string;
  type?: ScheduledTaskType;
  target?: string;
  args?: Record<string, unknown>;
  prompt?: string;
  channel?: string;
  userId?: string;
  principalId?: string;
  principalRole?: import('../tools/types.js').PrincipalRole;
  deliver?: boolean;
  runOnce?: boolean;
  cron?: string;
  eventTrigger?: ScheduledTaskEventTrigger;
  enabled?: boolean;
  approvalExpiresAt?: number;
  maxRunsPerWindow?: number;
  dailySpendCap?: number;
  providerSpendCap?: number;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface ScheduledTaskRunResult {
  runId?: string;
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
  events?: OrchestrationRunEvent[];
}

export interface ScheduledTaskPreset {
  id: string;
  name: string;
  description: string;
  type: ScheduledTaskType;
  target: string;
  args?: Record<string, unknown>;
  prompt?: string;
  channel?: string;
  userId?: string;
  deliver?: boolean;
  runOnce?: boolean;
  cron?: string;
  eventTrigger?: ScheduledTaskEventTrigger;
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
    userId?: string;
    principalId?: string;
    principalRole?: import('../tools/types.js').PrincipalRole;
    channel?: string;
    scheduleId?: string;
    bypassApprovals?: boolean;
  }): Promise<{ success: boolean; status: string; jobId?: string; approvalId?: string; message: string; output?: unknown }>;
}

/** Playbook executor interface — matches ConnectorPlaybookService.runPlaybook signature. */
export interface ScheduledTaskPlaybookExecutor {
  runPlaybook(input: {
    playbookId: string;
    origin: 'assistant' | 'cli' | 'web';
    requestedBy?: string;
    principalId?: string;
    scheduleId?: string;
    bypassApprovals?: boolean;
  }): Promise<{
    success: boolean;
    status: string;
    message: string;
    run: {
      runId?: string;
      graphId?: string;
      events?: OrchestrationRunEvent[];
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

export interface ScheduledTaskAgentExecutor {
  runAgentTask(input: {
    agentId: string;
    prompt: string;
    taskId: string;
    taskName: string;
    userId?: string;
    principalId?: string;
    principalRole?: import('../tools/types.js').PrincipalRole;
    channel?: string;
    deliver?: boolean;
  }): Promise<{
    success: boolean;
    status: ScheduledTaskStatus;
    message: string;
    output?: unknown;
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
  {
    id: 'beaconing-response-triage',
    name: 'Beaconing Response Triage',
    description: 'When beaconing is detected, run an immediate host re-check to capture fresh workstation evidence.',
    type: 'tool',
    target: 'host_monitor_check',
    args: {},
    eventTrigger: {
      eventType: 'security:network:threat',
      match: {
        'payload.type': 'beaconing',
      },
    },
    emitEvent: 'beaconing_response_triage_completed',
  },
  {
    id: 'port-scan-perimeter-triage',
    name: 'Port Scan Perimeter Triage',
    description: 'When active port-scanning pressure is detected, run a gateway firewall drift check for perimeter context.',
    type: 'tool',
    target: 'gateway_firewall_check',
    args: {},
    eventTrigger: {
      eventType: 'security:network:threat',
      match: {
        'payload.type': 'port_scanning',
      },
    },
    emitEvent: 'port_scan_perimeter_triage_completed',
  },
  {
    id: 'secret-exposure-containment-review',
    name: 'Secret Exposure Containment Review',
    description: 'When secret exposure is notified, snapshot the effective containment posture for operator review.',
    type: 'tool',
    target: 'security_containment_status',
    args: {
      profile: 'personal',
      currentMode: 'monitor',
    },
    eventTrigger: {
      eventType: 'security:alert',
      match: {
        'payload.sourceEventType': 'secret_detected',
      },
    },
    emitEvent: 'secret_exposure_containment_review_completed',
  },
  {
    id: 'browser-denial-containment-review',
    name: 'Browser Denial Containment Review',
    description: 'When a risky browser or tool action is denied, snapshot containment posture so operators can review escalation advice quickly.',
    type: 'tool',
    target: 'security_containment_status',
    args: {
      profile: 'personal',
      currentMode: 'monitor',
    },
    eventTrigger: {
      eventType: 'security:alert',
      match: {
        'payload.sourceEventType': 'action_denied',
      },
    },
    emitEvent: 'browser_denial_containment_review_completed',
  },
];

// ─── Service ──────────────────────────────────────────────

const DEFAULT_PERSIST_PATH = resolve(homedir(), '.guardianagent', 'scheduled-tasks.json');
const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RUNS_PER_WINDOW = 288;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_SPEND_CAP = 250_000;
const DEFAULT_PROVIDER_SPEND_CAP = 125_000;
const AUTO_PAUSE_FAILURE_THRESHOLD = 3;
const AUTO_PAUSE_DENIAL_THRESHOLD = 3;
const MAX_CHAIN_HOPS = 1;

export interface ScheduledTaskServiceDeps {
  scheduler: CronScheduler;
  toolExecutor: ScheduledTaskToolExecutor;
  playbookExecutor: ScheduledTaskPlaybookExecutor;
  agentExecutor?: ScheduledTaskAgentExecutor;
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

interface ScheduledTaskBudgetRecord {
  taskId: string;
  providerKey: string;
  timestamp: number;
  totalTokens: number;
}

export interface ScheduledTaskHistoryEntry {
  id: string;
  runId?: string;
  taskId: string;
  taskName: string;
  taskType: ScheduledTaskType;
  target: string;
  timestamp: number;
  status: ScheduledTaskStatus;
  durationMs: number;
  message: string;
  output?: unknown;
  outputHandling?: AutomationOutputHandlingConfig;
  promotedFindings?: AutomationPromotedFindingRef[];
  steps?: ScheduledTaskRunResult['steps'];
  events?: OrchestrationRunEvent[];
}

interface ScheduledTaskTriggerContext {
  kind: 'manual' | 'cron' | 'event';
  event?: AgentEvent;
}

export class ScheduledTaskService {
  private readonly tasks = new Map<string, ScheduledTaskDefinition>();
  private readonly scheduler: CronScheduler;
  private readonly toolExecutor: ScheduledTaskToolExecutor;
  private readonly playbookExecutor: ScheduledTaskPlaybookExecutor;
  private agentExecutor?: ScheduledTaskAgentExecutor;
  private readonly deviceInventory: DeviceInventoryService;
  private readonly eventBus: EventBus;
  private readonly auditLog?: AuditLog;
  private readonly onNetworkScanComplete?: ScheduledTaskServiceDeps['onNetworkScanComplete'];
  private readonly resolvePlaybookOutputHandling?: ScheduledTaskServiceDeps['resolvePlaybookOutputHandling'];
  private readonly persistPath: string;
  private readonly now: () => number;
  /** Run history — kept in memory, most recent first. */
  private readonly history: ScheduledTaskHistoryEntry[] = [];
  private readonly budgetHistory: ScheduledTaskBudgetRecord[] = [];
  private readonly activeRuns = new Map<string, string>();
  private readonly eventSubscriptions = new Map<string, () => void>();
  private readonly maxHistory = 100;

  constructor(deps: ScheduledTaskServiceDeps) {
    this.scheduler = deps.scheduler;
    this.toolExecutor = deps.toolExecutor;
    this.playbookExecutor = deps.playbookExecutor;
    this.agentExecutor = deps.agentExecutor;
    this.deviceInventory = deps.deviceInventory;
    this.eventBus = deps.eventBus;
    this.auditLog = deps.auditLog;
    this.onNetworkScanComplete = deps.onNetworkScanComplete;
    this.resolvePlaybookOutputHandling = deps.resolvePlaybookOutputHandling;
    this.persistPath = deps.persistPath ?? DEFAULT_PERSIST_PATH;
    this.now = deps.now ?? Date.now;
  }

  setAgentExecutor(agentExecutor: ScheduledTaskAgentExecutor | undefined): void {
    this.agentExecutor = agentExecutor;
  }

  private computeScopeHash(task: Pick<
    ScheduledTaskDefinition,
    'type' | 'target' | 'args' | 'prompt' | 'channel' | 'deliver' | 'runOnce' | 'cron' | 'eventTrigger' | 'emitEvent'
  >): string {
    const normalized = JSON.stringify({
      type: task.type,
      target: task.target,
      args: task.args ?? null,
      prompt: task.prompt ?? null,
      channel: task.channel ?? null,
      deliver: task.deliver ?? false,
      runOnce: task.runOnce === true,
      cron: task.cron ?? null,
      eventTrigger: normalizeEventTrigger(task.eventTrigger) ?? null,
      emitEvent: task.emitEvent ?? null,
    });
    return createHash('sha256').update(normalized).digest('hex');
  }

  private normalizePersistedTask(task: ScheduledTaskDefinition): ScheduledTaskDefinition {
    const normalized: ScheduledTaskDefinition = {
      ...task,
      description: task.description?.trim() || undefined,
      principalRole: task.principalRole ?? 'owner',
      cron: task.cron?.trim() || undefined,
      eventTrigger: normalizeEventTrigger(task.eventTrigger),
      scopeHash: task.scopeHash || this.computeScopeHash(task),
      maxRunsPerWindow: task.maxRunsPerWindow ?? DEFAULT_MAX_RUNS_PER_WINDOW,
      dailySpendCap: task.dailySpendCap ?? DEFAULT_DAILY_SPEND_CAP,
      providerSpendCap: task.providerSpendCap ?? DEFAULT_PROVIDER_SPEND_CAP,
      consecutiveFailureCount: task.consecutiveFailureCount ?? 0,
      consecutiveDeniedCount: task.consecutiveDeniedCount ?? 0,
    };

    if (!normalized.approvalExpiresAt && normalized.lastApprovedAt) {
      normalized.approvalExpiresAt = normalized.lastApprovedAt + DEFAULT_APPROVAL_TTL_MS;
    }

    if (!normalized.lastApprovedAt && normalized.approvedByPrincipal) {
      normalized.lastApprovedAt = normalized.createdAt;
    }

    return normalized;
  }

  private applyApproval(task: ScheduledTaskDefinition, principalId?: string, principalRole?: import('../tools/types.js').PrincipalRole, approvalExpiresAt?: number): void {
    task.principalId = principalId?.trim() || task.principalId;
    task.principalRole = principalRole ?? task.principalRole ?? 'owner';
    task.approvedByPrincipal = principalId?.trim() || task.approvedByPrincipal || task.userId || 'scheduled-system';
    task.lastApprovedAt = this.now();
    task.approvalExpiresAt = approvalExpiresAt ?? (task.lastApprovedAt + DEFAULT_APPROVAL_TTL_MS);
    task.scopeHash = this.computeScopeHash(task);
    task.autoPausedReason = undefined;
  }

  private pauseTask(task: ScheduledTaskDefinition, reason: string): void {
    task.enabled = false;
    task.autoPausedReason = reason;
    this.unregisterTaskTrigger(task);
  }

  private isScopeDrifted(task: ScheduledTaskDefinition): boolean {
    return task.scopeHash !== this.computeScopeHash(task);
  }

  private getRunsInWindow(taskId: string, windowMs = DEFAULT_WINDOW_MS): number {
    const cutoff = this.now() - windowMs;
    return this.history.filter((entry) => entry.taskId === taskId && entry.timestamp >= cutoff).length;
  }

  private pruneBudgetHistory(): void {
    const cutoff = this.now() - DEFAULT_WINDOW_MS;
    while (this.budgetHistory.length > 0 && this.budgetHistory[this.budgetHistory.length - 1]!.timestamp < cutoff) {
      this.budgetHistory.pop();
    }
  }

  private recordBudgetUsage(taskId: string, providerKey: string, totalTokens: number): void {
    this.pruneBudgetHistory();
    this.budgetHistory.unshift({
      taskId,
      providerKey,
      timestamp: this.now(),
      totalTokens,
    });
  }

  private getDailySpend(taskId: string): number {
    this.pruneBudgetHistory();
    return this.budgetHistory
      .filter((entry) => entry.taskId === taskId)
      .reduce((sum, entry) => sum + entry.totalTokens, 0);
  }

  private getDailyProviderSpend(taskId: string, providerKey: string): number {
    this.pruneBudgetHistory();
    return this.budgetHistory
      .filter((entry) => entry.taskId === taskId && entry.providerKey === providerKey)
      .reduce((sum, entry) => sum + entry.totalTokens, 0);
  }

  private extractUsageTokens(output: unknown): { totalTokens: number; providerKey: string } {
    const base = { totalTokens: 0, providerKey: 'default' };
    if (!output || typeof output !== 'object') return base;
    const record = output as Record<string, unknown>;
    const usage = typeof record.usage === 'object' && record.usage ? record.usage as Record<string, unknown> : null;
    const totalTokens = usage && typeof usage.totalTokens === 'number' ? usage.totalTokens : 0;
    const providerKey = typeof record.provider === 'string' && record.provider.trim()
      ? record.provider.trim()
      : typeof record.providerName === 'string' && record.providerName.trim()
        ? record.providerName.trim()
        : 'default';
    return { totalTokens, providerKey };
  }

  private preflightExecution(task: ScheduledTaskDefinition): { allowed: boolean; result?: ScheduledTaskRunResult } {
    const activeRunId = this.activeRuns.get(task.id);
    if (activeRunId) {
      return {
        allowed: false,
        result: {
          success: false,
          status: 'failed',
          message: `Task already has an active run in progress (${activeRunId}).`,
          durationMs: 0,
        },
      };
    }

    if (task.autoPausedReason) {
      return {
        allowed: false,
        result: {
          success: false,
          status: 'failed',
          message: `Task auto-paused: ${task.autoPausedReason}`,
          durationMs: 0,
        },
      };
    }

    if (this.isScopeDrifted(task)) {
      task.approvalExpiresAt = undefined;
      return {
        allowed: false,
        result: {
          success: false,
          status: 'failed',
          message: 'Task scope changed and requires re-approval before it can run again.',
          durationMs: 0,
        },
      };
    }

    if (!task.approvalExpiresAt || task.approvalExpiresAt <= this.now()) {
      return {
        allowed: false,
        result: {
          success: false,
          status: 'failed',
          message: 'Task approval has expired and must be renewed before execution.',
          durationMs: 0,
        },
      };
    }

    if (this.getRunsInWindow(task.id) >= task.maxRunsPerWindow) {
      this.pauseTask(task, `Run window limit exceeded (${task.maxRunsPerWindow} executions per day).`);
      return {
        allowed: false,
        result: {
          success: false,
          status: 'failed',
          message: task.autoPausedReason ?? 'Task paused after exceeding its run budget.',
          durationMs: 0,
        },
      };
    }

    if (this.getDailySpend(task.id) >= task.dailySpendCap) {
      this.pauseTask(task, `Daily token budget exceeded (${task.dailySpendCap}).`);
      return {
        allowed: false,
        result: {
          success: false,
          status: 'failed',
          message: task.autoPausedReason ?? 'Task paused after exceeding its daily token budget.',
          durationMs: 0,
        },
      };
    }

    return { allowed: true };
  }

  // ─── Persistence ──────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as ScheduledTaskDefinition[];
      if (Array.isArray(data)) {
        for (const task of data) {
          if (task.id) {
            const normalized = this.normalizePersistedTask(task);
            this.tasks.set(normalized.id, normalized);
            if (normalized.enabled) {
              this.registerTaskTrigger(normalized);
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
    if (!input.type || !isScheduledTaskType(input.type)) {
      return { success: false, message: "type must be 'tool', 'playbook', or 'agent'" };
    }
    if (!input.target?.trim()) {
      return { success: false, message: 'target is required' };
    }
    if (input.type === 'agent' && !input.prompt?.trim()) {
      return { success: false, message: 'prompt is required for agent tasks' };
    }
    const cron = input.cron?.trim() || undefined;
    const eventTrigger = normalizeEventTrigger(input.eventTrigger);
    if (!cron && !eventTrigger) {
      return { success: false, message: 'Either cron or eventTrigger is required' };
    }
    if (cron && eventTrigger) {
      return { success: false, message: 'Provide either cron or eventTrigger, not both' };
    }

    const task: ScheduledTaskDefinition = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      type: input.type,
      target: input.target.trim(),
      presetId: input.presetId?.trim() || undefined,
      args: input.args,
      prompt: input.prompt?.trim() || undefined,
      channel: input.channel?.trim() || undefined,
      userId: input.userId?.trim() || undefined,
      principalId: input.principalId?.trim() || input.userId?.trim() || undefined,
      principalRole: input.principalRole ?? 'owner',
      deliver: input.deliver,
      runOnce: input.runOnce === true,
      cron,
      eventTrigger,
      enabled: input.enabled !== false,
      createdAt: this.now(),
      approvalExpiresAt: input.approvalExpiresAt,
      scopeHash: '',
      maxRunsPerWindow: input.maxRunsPerWindow ?? DEFAULT_MAX_RUNS_PER_WINDOW,
      dailySpendCap: input.dailySpendCap ?? DEFAULT_DAILY_SPEND_CAP,
      providerSpendCap: input.providerSpendCap ?? DEFAULT_PROVIDER_SPEND_CAP,
      consecutiveFailureCount: 0,
      consecutiveDeniedCount: 0,
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

    this.applyApproval(task, task.principalId, task.principalRole, input.approvalExpiresAt);

    this.tasks.set(task.id, task);

    if (task.enabled) {
      try {
        this.registerTaskTrigger(task);
      } catch (err) {
        this.tasks.delete(task.id);
        return { success: false, message: `Invalid task trigger: ${err instanceof Error ? err.message : String(err)}` };
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

    const previousScopeHash = task.scopeHash;
    const nextCron = input.cron !== undefined ? input.cron.trim() : task.cron;
    const nextEventTrigger = input.eventTrigger !== undefined ? normalizeEventTrigger(input.eventTrigger) : task.eventTrigger;
    const cronChanged = input.cron !== undefined && nextCron !== task.cron;
    const eventTriggerChanged = input.eventTrigger !== undefined && JSON.stringify(nextEventTrigger ?? null) !== JSON.stringify(task.eventTrigger ?? null);
    const enableChanged = input.enabled !== undefined && input.enabled !== task.enabled;

    if (input.name !== undefined) {
      if (!input.name.trim()) return { success: false, message: 'name is required' };
      task.name = input.name.trim();
    }
    if (input.description !== undefined) task.description = input.description?.trim() || undefined;
    if (input.type !== undefined) {
      if (!isScheduledTaskType(input.type)) {
        return { success: false, message: "type must be 'tool', 'playbook', or 'agent'" };
      }
      task.type = input.type;
    }
    if (input.target !== undefined) {
      if (!input.target.trim()) return { success: false, message: 'target is required' };
      task.target = input.target.trim();
    }
    if (input.args !== undefined) task.args = input.args;
    if (input.prompt !== undefined) task.prompt = input.prompt?.trim() || undefined;
    if (input.channel !== undefined) task.channel = input.channel?.trim() || undefined;
    if (input.userId !== undefined) task.userId = input.userId?.trim() || undefined;
    if (input.principalId !== undefined) task.principalId = input.principalId?.trim() || undefined;
    if (input.principalRole !== undefined) task.principalRole = input.principalRole;
    if (input.deliver !== undefined) task.deliver = input.deliver;
    if (input.runOnce !== undefined) task.runOnce = input.runOnce === true;
    if (input.cron !== undefined) task.cron = nextCron || undefined;
    if (input.eventTrigger !== undefined) task.eventTrigger = nextEventTrigger;
    if (input.enabled !== undefined) task.enabled = input.enabled;
    if (input.maxRunsPerWindow !== undefined) task.maxRunsPerWindow = Math.max(1, input.maxRunsPerWindow);
    if (input.dailySpendCap !== undefined) task.dailySpendCap = Math.max(0, input.dailySpendCap);
    if (input.providerSpendCap !== undefined) task.providerSpendCap = Math.max(0, input.providerSpendCap);
    if (input.emitEvent !== undefined) task.emitEvent = input.emitEvent?.trim() || undefined;
    if (input.outputHandling !== undefined) task.outputHandling = input.outputHandling;

    if (task.type === 'agent' && !task.prompt?.trim()) {
      return { success: false, message: 'prompt is required for agent tasks' };
    }
    if (!task.cron && !task.eventTrigger) {
      return { success: false, message: 'Either cron or eventTrigger is required' };
    }
    if (task.cron && task.eventTrigger) {
      return { success: false, message: 'Provide either cron or eventTrigger, not both' };
    }
    if (task.type !== 'agent') {
      task.prompt = undefined;
      task.channel = undefined;
      task.userId = undefined;
      task.deliver = undefined;
    }

    if (task.presetId) {
      const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === task.presetId);
      if (preset && (task.type !== preset.type || task.target !== preset.target)) {
        task.presetId = undefined;
      }
    }

    const nextScopeHash = this.computeScopeHash(task);
    const scopeChanged = nextScopeHash !== previousScopeHash;
    if (scopeChanged || input.approvalExpiresAt !== undefined) {
      this.applyApproval(task, task.principalId, task.principalRole, input.approvalExpiresAt);
    }

    // Re-register cron if expression changed or enabled state changed
    if (cronChanged || eventTriggerChanged || enableChanged) {
      this.unregisterTaskTrigger(task);
      if (task.enabled) {
        try {
          this.registerTaskTrigger(task);
        } catch (err) {
          return { success: false, message: `Invalid task trigger: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }

    if (!task.enabled) {
      task.autoPausedReason = task.autoPausedReason ?? undefined;
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

    this.unregisterTaskTrigger(task);
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
    const result = await this.executeTask(task, { kind: 'manual' });
    return { success: result.success, message: result.message };
  }

  private async executeTask(task: ScheduledTaskDefinition, triggerContext: ScheduledTaskTriggerContext = { kind: 'cron' }): Promise<ScheduledTaskRunResult> {
    const start = this.now();
    const runId = randomUUID();
    const events: OrchestrationRunEvent[] = [
      createRunEvent(runId, 'run_created', start, {
        message: `Scheduled task '${task.name}' started via ${triggerContext.kind}.`,
        metadata: {
          taskId: task.id,
          taskType: task.type,
          target: task.target,
          triggerKind: triggerContext.kind,
          triggerEventType: triggerContext.event?.type,
          triggerSourceAgentId: triggerContext.event?.sourceAgentId,
        },
      }),
    ];
    let result: ScheduledTaskRunResult;

    const preflight = this.preflightExecution(task);
    if (!preflight.allowed) {
      result = preflight.result!;
      result.runId = runId;
      result.events = [
        ...events,
        createRunEvent(runId, 'run_failed', this.now(), {
          message: result.message,
          metadata: { preflightBlocked: true },
        }),
      ];
      task.lastRunAt = this.now();
      task.lastRunStatus = result.status;
      task.lastRunMessage = result.message;
      this.persist().catch(() => {});
      return result;
    }

    this.activeRuns.set(task.id, runId);

    try {
      if (task.type === 'tool') {
        result = await this.executeTool(task, runId, events);
      } else if (task.type === 'playbook') {
        result = await this.executePlaybook(task, runId, events);
      } else {
        result = await this.executeAgent(task, runId, events);
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
    result.runId = result.runId ?? runId;
    result.events = result.events ?? [
      ...events,
      createRunEvent(runId, result.success ? 'run_completed' : result.status === 'pending_approval' ? 'run_interrupted' : 'run_failed', this.now(), {
        message: result.message,
      }),
    ];

    // Update task state
    task.lastRunAt = this.now();
    task.lastRunStatus = result.status;
    task.lastRunMessage = result.message;
    task.runCount++;
    if (result.status === 'pending_approval') {
      task.consecutiveDeniedCount++;
      task.consecutiveFailureCount = 0;
    } else if (result.success) {
      task.consecutiveFailureCount = 0;
      task.consecutiveDeniedCount = 0;
    } else {
      task.consecutiveFailureCount++;
      task.consecutiveDeniedCount = 0;
    }
    result.outputHandling = result.outputHandling ?? task.outputHandling;
    result.promotedFindings = this.promoteRunFindings(task, result);

    const usage = this.extractUsageTokens(result.output);
    if (usage.totalTokens > 0) {
      this.recordBudgetUsage(task.id, usage.providerKey, usage.totalTokens);
      if (this.getDailyProviderSpend(task.id, usage.providerKey) > task.providerSpendCap) {
        this.pauseTask(task, `Provider token budget exceeded for ${usage.providerKey} (${task.providerSpendCap}).`);
        task.lastRunMessage = `${result.message}${result.message.endsWith('.') ? '' : '.'} ${task.autoPausedReason}`;
        result.message = task.lastRunMessage;
      }
    }

    if (task.consecutiveFailureCount >= AUTO_PAUSE_FAILURE_THRESHOLD) {
      this.pauseTask(task, `Consecutive failure threshold reached (${task.consecutiveFailureCount}).`);
      task.lastRunMessage = `${result.message}${result.message.endsWith('.') ? '' : '.'} ${task.autoPausedReason}`;
      result.message = task.lastRunMessage;
    } else if (task.consecutiveDeniedCount >= AUTO_PAUSE_DENIAL_THRESHOLD) {
      this.pauseTask(task, `Consecutive approval denials threshold reached (${task.consecutiveDeniedCount}).`);
      task.lastRunMessage = `${result.message}${result.message.endsWith('.') ? '' : '.'} ${task.autoPausedReason}`;
      result.message = task.lastRunMessage;
    }

    if (task.runOnce) {
      task.enabled = false;
      this.unregisterTaskTrigger(task);
      task.lastRunMessage = `${result.message}${result.message.endsWith('.') ? '' : '.'} One-shot task disabled after execution.`;
      result.message = task.lastRunMessage;
    }

    // Record history
    this.history.unshift({
      id: randomUUID(),
      runId: result.runId,
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
      events: result.events?.map((event) => ({ ...event })),
    });
    if (this.history.length > this.maxHistory) {
      this.history.length = this.maxHistory;
    }

    // Emit events
    this.emitCompletionEvent(task, result, triggerContext);

    this.persist().catch(() => {});
    this.activeRuns.delete(task.id);
    return result;
  }

  private async executeTool(task: ScheduledTaskDefinition, runId: string, events: OrchestrationRunEvent[]): Promise<ScheduledTaskRunResult> {
    const chainId = `sched:${task.id}:${this.now()}`;
    const nodeId = `${task.id}:tool`;
    events.push(createRunEvent(runId, 'node_started', this.now(), {
      nodeId,
      message: `Executing scheduled tool '${task.target}'.`,
    }));
    const toolResult = await this.toolExecutor.runTool({
      toolName: task.target,
      args: task.args ?? {},
      origin: 'web',
      agentId: `sched-task:${task.id}`,
      userId: task.userId,
      principalId: task.approvedByPrincipal ?? task.principalId,
      principalRole: task.principalRole,
      channel: task.channel ?? 'scheduled',
      scheduleId: chainId,
      bypassApprovals: true,
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

    events.push(createRunEvent(runId, status === 'pending_approval' ? 'approval_requested' : 'node_completed', this.now(), {
      nodeId,
      message: toolResult.message,
      metadata: { status, approvalId: toolResult.approvalId },
    }));

    return {
      runId,
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
      events: events.map((event) => ({ ...event })),
    };
  }

  private async executePlaybook(task: ScheduledTaskDefinition, runId: string, events: OrchestrationRunEvent[]): Promise<ScheduledTaskRunResult> {
    const chainId = `sched:${task.id}:${this.now()}`;
    const pbResult = await this.playbookExecutor.runPlaybook({
      playbookId: task.target,
      origin: 'web',
      requestedBy: task.approvedByPrincipal ?? task.principalId ?? 'scheduled-tasks',
      principalId: task.approvedByPrincipal ?? task.principalId,
      scheduleId: chainId,
      bypassApprovals: true,
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

    events.push(...(pbResult.run.events ?? []).map((event) => ({
      ...event,
      parentRunId: event.parentRunId ?? runId,
    })));

    return {
      runId: pbResult.run.runId || runId,
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
      events: events.map((event) => ({ ...event })),
    };
  }

  private async executeAgent(task: ScheduledTaskDefinition, runId: string, events: OrchestrationRunEvent[]): Promise<ScheduledTaskRunResult> {
    if (!this.agentExecutor) {
      return {
        runId,
        success: false,
        status: 'failed',
        message: 'Agent task execution is not available.',
        durationMs: 0,
        events: events.map((event) => ({ ...event })),
      };
    }
    if (!task.prompt?.trim()) {
      return {
        runId,
        success: false,
        status: 'failed',
        message: 'Agent task is missing a prompt.',
        durationMs: 0,
        events: events.map((event) => ({ ...event })),
      };
    }

    const nodeId = `${task.id}:agent`;
    events.push(createRunEvent(runId, 'node_started', this.now(), {
      nodeId,
      message: `Executing scheduled assistant task '${task.name}'.`,
    }));
    const agentResult = await this.agentExecutor.runAgentTask({
      agentId: task.target,
      prompt: task.prompt,
      taskId: task.id,
      taskName: task.name,
      userId: task.userId,
      principalId: task.approvedByPrincipal ?? task.principalId,
      principalRole: task.principalRole,
      channel: task.channel,
      deliver: task.deliver,
    });

    events.push(createRunEvent(runId, agentResult.status === 'pending_approval' ? 'approval_requested' : 'node_completed', this.now(), {
      nodeId,
      message: agentResult.message,
      metadata: { status: agentResult.status },
    }));

    return {
      runId,
      success: agentResult.success,
      status: agentResult.status,
      message: agentResult.message,
      durationMs: 0,
      output: agentResult.output,
      outputHandling: task.outputHandling,
      steps: [{
        stepId: `${task.id}-step-1`,
        toolName: `agent:${task.target}`,
        status: agentResult.status,
        message: agentResult.message,
        durationMs: 0,
        output: agentResult.output,
      }],
      events: events.map((event) => ({ ...event })),
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

  private emitCompletionEvent(task: ScheduledTaskDefinition, result: ScheduledTaskRunResult, triggerContext: ScheduledTaskTriggerContext): void {
    const chainId = `sched:${task.id}:${task.lastRunAt ?? this.now()}`;
    const baseEvent: AgentEvent = {
      type: 'scheduled_task_completed',
      sourceAgentId: `sched-task:${task.id}`,
      targetAgentId: '*',
      payload: {
        taskId: task.id,
        taskName: task.name,
        runId: result.runId,
        taskType: task.type,
        target: task.target,
        status: result.status,
        message: result.message,
        durationMs: result.durationMs,
        promotedFindings: result.promotedFindings,
        causalChainId: chainId,
        triggerKind: triggerContext.kind,
        triggerEventType: triggerContext.event?.type,
        triggerSourceAgentId: triggerContext.event?.sourceAgentId,
        hopCount: MAX_CHAIN_HOPS,
        approvedByPrincipal: task.approvedByPrincipal,
        approvalExpiresAt: task.approvalExpiresAt,
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

  private registerTaskTrigger(task: ScheduledTaskDefinition): void {
    if (task.cron) {
      this.registerCron(task);
      return;
    }
    if (task.eventTrigger) {
      this.registerEventTrigger(task);
      return;
    }
    throw new Error('Task has no cron or event trigger.');
  }

  private unregisterTaskTrigger(task: ScheduledTaskDefinition): void {
    this.unregisterCron(task);
    this.unregisterEventTrigger(task);
  }

  private registerCron(task: ScheduledTaskDefinition): void {
    if (!task.cron) {
      throw new Error('Task cron expression is missing.');
    }
    const agentId = this.cronKey(task);
    this.scheduler.schedule(agentId, task.cron, async () => {
      log.info({ taskId: task.id, name: task.name }, 'Scheduled task triggered');
      await this.executeTask(task, { kind: 'cron' });
    });
  }

  private unregisterCron(task: ScheduledTaskDefinition): void {
    const agentId = this.cronKey(task);
    this.scheduler.unschedule(agentId);
  }

  private registerEventTrigger(task: ScheduledTaskDefinition): void {
    const trigger = task.eventTrigger;
    if (!trigger?.eventType) {
      throw new Error('Task event trigger is missing eventType.');
    }
    this.unregisterEventTrigger(task);
    const handler = (event: AgentEvent): void => {
      if (!task.enabled || !task.eventTrigger) return;
      if (!matchesScheduledTaskEventTrigger(event, task.eventTrigger)) return;
      log.info({ taskId: task.id, name: task.name, eventType: event.type }, 'Event-triggered scheduled task fired');
      void this.executeTask(task, { kind: 'event', event }).catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), taskId: task.id, eventType: event.type }, 'Event-triggered scheduled task failed');
      });
    };
    this.eventBus.subscribeByType(trigger.eventType, handler);
    this.eventSubscriptions.set(task.id, () => {
      this.eventBus.unsubscribeByType(trigger.eventType, handler);
    });
  }

  private unregisterEventTrigger(task: ScheduledTaskDefinition): void {
    const unsubscribe = this.eventSubscriptions.get(task.id);
    if (!unsubscribe) return;
    unsubscribe();
    this.eventSubscriptions.delete(task.id);
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
      runOnce: preset.runOnce,
      cron: preset.cron,
      eventTrigger: preset.eventTrigger,
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

function normalizeEventTrigger(trigger: ScheduledTaskEventTrigger | undefined): ScheduledTaskEventTrigger | undefined {
  if (!trigger) return undefined;
  const eventType = trigger.eventType?.trim();
  if (!eventType) return undefined;
  const normalizedMatchEntries = Object.entries(trigger.match ?? {})
    .filter(([key, value]) => key.trim() && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => [key.trim(), value] as const);
  return {
    eventType,
    sourceAgentId: trigger.sourceAgentId?.trim() || undefined,
    targetAgentId: trigger.targetAgentId?.trim() || undefined,
    match: normalizedMatchEntries.length > 0 ? Object.fromEntries(normalizedMatchEntries) : undefined,
  };
}

function matchesScheduledTaskEventTrigger(event: AgentEvent, trigger: ScheduledTaskEventTrigger): boolean {
  if (event.type !== trigger.eventType) return false;
  if (trigger.sourceAgentId && event.sourceAgentId !== trigger.sourceAgentId) return false;
  if (trigger.targetAgentId && event.targetAgentId !== trigger.targetAgentId) return false;
  if (!trigger.match || Object.keys(trigger.match).length === 0) return true;
  return Object.entries(trigger.match).every(([path, expected]) => valuesEqual(resolveScheduledTaskEventField(event, path), expected));
}

function resolveScheduledTaskEventField(event: AgentEvent, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return undefined;
  let current: unknown;
  if (parts[0] === 'payload') {
    current = event.payload;
    parts.shift();
  } else {
    current = event as unknown;
  }
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function valuesEqual(actual: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && actual === expected;
  }
  if (typeof expected === 'boolean') {
    return typeof actual === 'boolean' && actual === expected;
  }
  return String(actual ?? '').trim() === expected;
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

function isScheduledTaskType(value: string): value is ScheduledTaskType {
  return value === 'tool' || value === 'playbook' || value === 'agent';
}
