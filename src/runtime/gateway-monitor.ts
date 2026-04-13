import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AssistantGatewayMonitoringConfig, HostMonitorSeverity } from '../config/types.js';
import { writeSecureFile } from '../util/secure-fs.js';
import { getGuardianBaseDir } from '../util/env.js';
import {
  acknowledgeSecurityAlert,
  ensureSecurityAlertLifecycle,
  isSecurityAlertSuppressed,
  listSecurityAlerts,
  reactivateSecurityAlert,
  resolveSecurityAlert,
  suppressSecurityAlert,
  type SecurityAlertLifecycle,
  type SecurityAlertListOptions,
  type SecurityAlertStateResult,
} from './security-alert-lifecycle.js';

const execFile = promisify(execFileCb);

export type GatewayAlertType =
  | 'gateway_firewall_disabled'
  | 'gateway_firewall_change'
  | 'gateway_port_forward_change'
  | 'gateway_admin_change'
  | 'gateway_monitor_error';

export interface GatewayFirewallCollectorState {
  displayName?: string;
  provider?: string;
  available?: boolean;
  firewallEnabled?: boolean | null;
  ruleCount?: number;
  wanDefaultAction?: string;
  portForwards?: string[];
  adminUsers?: string[];
  idsEnabled?: boolean | null;
  firmwareVersion?: string;
  summary?: string;
  fingerprint?: string;
}

export interface GatewayMonitorTargetStatus {
  id: string;
  displayName: string;
  provider: string;
  available: boolean;
  firewallEnabled: boolean | null;
  ruleCount: number;
  wanDefaultAction: string;
  portForwardCount: number;
  adminUserCount: number;
  firmwareVersion?: string;
  lastCheckedAt: number;
  summary: string;
}

export interface GatewayMonitorAlert {
  id: string;
  targetId: string;
  targetName: string;
  provider: string;
  type: GatewayAlertType;
  severity: HostMonitorSeverity;
  timestamp: number;
  description: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  acknowledged: boolean;
  status: SecurityAlertLifecycle['status'];
  lastStateChangedAt: number;
  suppressedUntil?: number;
  suppressionReason?: string;
  resolvedAt?: number;
  resolutionReason?: string;
}

export interface GatewayMonitorStatus {
  enabled: boolean;
  baselineReady: boolean;
  lastUpdatedAt: number;
  monitorCount: number;
  availableGatewayCount: number;
  gateways: GatewayMonitorTargetStatus[];
  activeAlertCount: number;
  bySeverity: Record<HostMonitorSeverity, number>;
}

export interface GatewayMonitorReport {
  timestamp: number;
  baselineReady: boolean;
  gateways: GatewayMonitorTargetStatus[];
  alerts: GatewayMonitorAlert[];
}

interface PersistedGatewayTargetState {
  id: string;
  displayName: string;
  provider: string;
  available: boolean;
  firewallEnabled: boolean | null;
  ruleCount: number;
  wanDefaultAction: string;
  portForwards: string[];
  adminUsers: string[];
  idsEnabled: boolean | null;
  firmwareVersion?: string;
  fingerprint: string;
  summary: string;
  lastCheckedAt: number;
}

interface PersistedState {
  baselineReady: boolean;
  lastUpdatedAt: number;
  targets: PersistedGatewayTargetState[];
  alerts: GatewayMonitorAlert[];
}

type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<string>;

const DEFAULT_PERSIST_PATH = resolve(getGuardianBaseDir(), 'gateway-monitor.json');

export interface GatewayMonitoringServiceOptions {
  config: AssistantGatewayMonitoringConfig;
  persistPath?: string;
  now?: () => number;
  runner?: CommandRunner;
}

export class GatewayFirewallMonitoringService {
  private readonly config: AssistantGatewayMonitoringConfig;
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly runner: CommandRunner;
  private baselineReady = false;
  private lastUpdatedAt = 0;
  private readonly targets = new Map<string, PersistedGatewayTargetState>();
  private readonly alerts = new Map<string, GatewayMonitorAlert>();
  private lastGateways: GatewayMonitorTargetStatus[] = [];

  constructor(options: GatewayMonitoringServiceOptions) {
    this.config = options.config;
    this.persistPath = options.persistPath ?? DEFAULT_PERSIST_PATH;
    this.now = options.now ?? Date.now;
    this.runner = options.runner ?? defaultRunner;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as PersistedState;
      this.baselineReady = !!data.baselineReady;
      this.lastUpdatedAt = data.lastUpdatedAt ?? 0;
      this.targets.clear();
      for (const target of data.targets ?? []) {
        this.targets.set(target.id, {
          ...target,
          portForwards: uniqueSortedStrings(target.portForwards ?? []),
          adminUsers: uniqueSortedStrings(target.adminUsers ?? []),
        });
      }
      this.alerts.clear();
      for (const alert of data.alerts ?? []) {
        this.alerts.set(alert.id, alert);
      }
    } catch {
      // first run
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedState = {
      baselineReady: this.baselineReady,
      lastUpdatedAt: this.lastUpdatedAt,
      targets: [...this.targets.values()].sort((a, b) => a.id.localeCompare(b.id)),
      alerts: [...this.alerts.values()],
    };
    await writeSecureFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  getStatus(): GatewayMonitorStatus {
    const alerts = this.listAlerts();
    return {
      enabled: this.config.enabled,
      baselineReady: this.baselineReady,
      lastUpdatedAt: this.lastUpdatedAt,
      monitorCount: this.config.monitors.filter((m) => m.enabled).length,
      availableGatewayCount: this.lastGateways.filter((g) => g.available).length,
      gateways: [...this.lastGateways],
      activeAlertCount: alerts.length,
      bySeverity: {
        low: alerts.filter((a) => a.severity === 'low').length,
        medium: alerts.filter((a) => a.severity === 'medium').length,
        high: alerts.filter((a) => a.severity === 'high').length,
        critical: alerts.filter((a) => a.severity === 'critical').length,
      },
    };
  }

  listAlerts(opts?: SecurityAlertListOptions): GatewayMonitorAlert[] {
    return listSecurityAlerts(this.alerts.values(), this.now(), opts);
  }

  acknowledgeAlert(alertId: string): SecurityAlertStateResult {
    const alert = this.alerts.get(alertId);
    if (!alert) return { success: false, message: `Alert '${alertId}' not found.` };
    acknowledgeSecurityAlert(alert, this.now());
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' acknowledged.` };
  }

  resolveAlert(alertId: string, reason?: string): SecurityAlertStateResult {
    const alert = this.alerts.get(alertId);
    if (!alert) return { success: false, message: `Alert '${alertId}' not found.` };
    resolveSecurityAlert(alert, this.now(), reason);
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' resolved.` };
  }

  suppressAlert(alertId: string, until: number, reason?: string): SecurityAlertStateResult {
    const alert = this.alerts.get(alertId);
    if (!alert) return { success: false, message: `Alert '${alertId}' not found.` };
    if (!Number.isFinite(until) || until <= this.now()) {
      return { success: false, message: 'suppressedUntil must be a future timestamp.' };
    }
    suppressSecurityAlert(alert, this.now(), until, reason);
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' suppressed until ${new Date(until).toISOString()}.` };
  }

  async runCheck(): Promise<GatewayMonitorReport> {
    const timestamp = this.now();
    const alertsInput: Array<Omit<
      GatewayMonitorAlert,
      'id'
      | 'acknowledged'
      | 'status'
      | 'lastStateChangedAt'
      | 'suppressedUntil'
      | 'suppressionReason'
      | 'resolvedAt'
      | 'resolutionReason'
      | 'firstSeenAt'
      | 'lastSeenAt'
      | 'occurrenceCount'
    >> = [];
    const gatewayStatuses: GatewayMonitorTargetStatus[] = [];

    for (const monitor of this.config.monitors.filter((item) => item.enabled)) {
      try {
        const nextState = await this.collectState(monitor.id);
        const status = toTargetStatus(monitor.id, nextState, timestamp);
        gatewayStatuses.push(status);

        if (nextState.available && nextState.firewallEnabled === false) {
          alertsInput.push({
            targetId: monitor.id,
            targetName: status.displayName,
            provider: status.provider,
            type: 'gateway_firewall_disabled',
            severity: gatewayFirewallDisabledSeverity(status),
            timestamp,
            description: `Gateway firewall disabled or relaxed on ${status.displayName}: ${status.summary}`,
            dedupeKey: `gateway_firewall_disabled:${monitor.id}:${status.summary}`,
            evidence: {
              gatewayId: monitor.id,
              provider: status.provider,
              firewallEnabled: status.firewallEnabled,
              wanDefaultAction: status.wanDefaultAction,
              summary: status.summary,
            },
          });
        }

        const previous = this.targets.get(monitor.id);
        if (previous) {
          if (nextState.fingerprint !== previous.fingerprint) {
            alertsInput.push({
              targetId: monitor.id,
              targetName: status.displayName,
              provider: status.provider,
              type: 'gateway_firewall_change',
              severity: 'medium',
              timestamp,
              description: `Gateway firewall configuration changed on ${status.displayName}: ${status.summary}`,
              dedupeKey: `gateway_firewall_change:${monitor.id}:${nextState.fingerprint}`,
              evidence: {
                gatewayId: monitor.id,
                provider: status.provider,
                ruleCount: status.ruleCount,
                wanDefaultAction: status.wanDefaultAction,
                summary: status.summary,
              },
            });
          }

          const portForwardDiff = diffStringSets(previous.portForwards, nextState.portForwards);
          if (portForwardDiff.added.length > 0 || portForwardDiff.removed.length > 0) {
            alertsInput.push({
              targetId: monitor.id,
              targetName: status.displayName,
              provider: status.provider,
              type: 'gateway_port_forward_change',
              severity: 'high',
              timestamp,
              description: `Gateway port forwards changed on ${status.displayName}`,
              dedupeKey: `gateway_port_forward_change:${monitor.id}:${hashText(JSON.stringify(portForwardDiff))}`,
              evidence: {
                gatewayId: monitor.id,
                provider: status.provider,
                added: portForwardDiff.added,
                removed: portForwardDiff.removed,
              },
            });
          }

          const adminDiff = diffStringSets(previous.adminUsers, nextState.adminUsers);
          if (adminDiff.added.length > 0 || adminDiff.removed.length > 0) {
            alertsInput.push({
              targetId: monitor.id,
              targetName: status.displayName,
              provider: status.provider,
              type: 'gateway_admin_change',
              severity: 'high',
              timestamp,
              description: `Gateway admin users changed on ${status.displayName}`,
              dedupeKey: `gateway_admin_change:${monitor.id}:${hashText(JSON.stringify(adminDiff))}`,
              evidence: {
                gatewayId: monitor.id,
                provider: status.provider,
                added: adminDiff.added,
                removed: adminDiff.removed,
              },
            });
          }
        }

        this.targets.set(monitor.id, nextState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        gatewayStatuses.push({
          id: monitor.id,
          displayName: monitor.displayName,
          provider: monitor.provider,
          available: false,
          firewallEnabled: null,
          ruleCount: 0,
          wanDefaultAction: 'unknown',
          portForwardCount: 0,
          adminUserCount: 0,
          lastCheckedAt: timestamp,
          summary: message,
        });
        alertsInput.push({
          targetId: monitor.id,
          targetName: monitor.displayName,
          provider: monitor.provider,
          type: 'gateway_monitor_error',
          severity: 'medium',
          timestamp,
          description: `Gateway monitor check failed for ${monitor.displayName}: ${message}`,
          dedupeKey: `gateway_monitor_error:${monitor.id}:${message}`,
          evidence: {
            gatewayId: monitor.id,
            provider: monitor.provider,
            error: message,
          },
        });
      }
    }

    const alerts = this.recordAlerts(alertsInput, timestamp);
    this.baselineReady = this.baselineReady || gatewayStatuses.length > 0;
    this.lastUpdatedAt = timestamp;
    this.lastGateways = gatewayStatuses.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.persist().catch(() => {});

    return {
      timestamp,
      baselineReady: this.baselineReady,
      gateways: [...this.lastGateways],
      alerts,
    };
  }

  shouldBlockAction(action: { type: string; toolName: string }): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };
    const activeAlerts = this.listAlerts({ limit: 50 });
    const critical = activeAlerts.filter((alert) => alert.severity === 'critical');
    const high = activeAlerts.filter((alert) => alert.severity === 'high');
    const sensitiveActionTypes = new Set([
      'execute_command',
      'http_request',
      'network_probe',
      'send_email',
      'draft_email',
      'mcp_tool',
      'write_drive',
      'write_docs',
      'write_sheets',
      'write_calendar',
    ]);
    if (critical.length > 0 && sensitiveActionTypes.has(action.type)) {
      return {
        allowed: false,
        reason: `Blocked by gateway monitoring: ${critical[0].description}`,
      };
    }
    if (high.length >= 2 && (action.type === 'execute_command' || action.type === 'http_request' || action.type === 'network_probe')) {
      return {
        allowed: false,
        reason: `Blocked by gateway monitoring: ${high.length} active high-severity gateway alerts require operator review.`,
      };
    }
    return { allowed: true };
  }

  private async collectState(targetId: string): Promise<PersistedGatewayTargetState> {
    const target = this.config.monitors.find((item) => item.id === targetId && item.enabled);
    if (!target) throw new Error(`Gateway monitor '${targetId}' is not enabled.`);
    const stdout = await this.runner(target.command, target.args, target.timeoutMs);
    const parsed = JSON.parse(stdout) as GatewayFirewallCollectorState;
    return normalizeCollectorState(target, parsed, this.now());
  }

  private recordAlerts(
    input: Array<Omit<
      GatewayMonitorAlert,
      'id'
      | 'acknowledged'
      | 'status'
      | 'lastStateChangedAt'
      | 'suppressedUntil'
      | 'suppressionReason'
      | 'resolvedAt'
      | 'resolutionReason'
      | 'firstSeenAt'
      | 'lastSeenAt'
      | 'occurrenceCount'
    >>,
    now: number,
  ): GatewayMonitorAlert[] {
    const emitted: GatewayMonitorAlert[] = [];
    for (const item of input) {
      const existing = [...this.alerts.values()].find((alert) => alert.dedupeKey === item.dedupeKey);
      if (existing) {
        ensureSecurityAlertLifecycle(existing);
        const previousLastSeenAt = existing.lastSeenAt;
        const withinWindow = (now - previousLastSeenAt) < this.config.dedupeWindowMs;
        existing.lastSeenAt = now;
        existing.occurrenceCount += 1;
        existing.timestamp = now;
        existing.severity = item.severity;
        existing.description = item.description;
        existing.evidence = item.evidence;
        if (existing.status === 'resolved') {
          reactivateSecurityAlert(existing, now);
          emitted.push(existing);
          continue;
        }
        if (isSecurityAlertSuppressed(existing, now)) {
          continue;
        }
        if (withinWindow) {
          continue;
        }
        reactivateSecurityAlert(existing, now);
        emitted.push(existing);
        continue;
      }
      const created: GatewayMonitorAlert = {
        id: randomUUID(),
        ...item,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        acknowledged: false,
        status: 'active',
        lastStateChangedAt: now,
      };
      this.alerts.set(created.id, created);
      emitted.push(created);
    }
    return emitted;
  }
}

async function defaultRunner(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFile(command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

function normalizeCollectorState(
  target: AssistantGatewayMonitoringConfig['monitors'][number],
  parsed: GatewayFirewallCollectorState,
  now: number,
): PersistedGatewayTargetState {
  const portForwards = uniqueSortedStrings(parsed.portForwards ?? []);
  const adminUsers = uniqueSortedStrings(parsed.adminUsers ?? []);
  const normalized = {
    provider: parsed.provider?.trim() || target.provider,
    firewallEnabled: parsed.firewallEnabled ?? null,
    ruleCount: Math.max(0, Number(parsed.ruleCount ?? 0) || 0),
    wanDefaultAction: (parsed.wanDefaultAction?.trim() || 'unknown').toLowerCase(),
    portForwards,
    adminUsers,
    idsEnabled: parsed.idsEnabled ?? null,
    firmwareVersion: parsed.firmwareVersion?.trim() || undefined,
    available: parsed.available !== false,
    summary: parsed.summary?.trim() || buildSummary(parsed, portForwards.length, adminUsers.length),
  };
  const fingerprint = parsed.fingerprint?.trim() || hashText(JSON.stringify({
    provider: normalized.provider,
    firewallEnabled: normalized.firewallEnabled,
    ruleCount: normalized.ruleCount,
    wanDefaultAction: normalized.wanDefaultAction,
    portForwards,
    adminUsers,
    idsEnabled: normalized.idsEnabled,
    firmwareVersion: normalized.firmwareVersion,
  }));
  return {
    id: target.id,
    displayName: parsed.displayName?.trim() || target.displayName,
    provider: normalized.provider,
    available: normalized.available,
    firewallEnabled: normalized.firewallEnabled,
    ruleCount: normalized.ruleCount,
    wanDefaultAction: normalized.wanDefaultAction,
    portForwards,
    adminUsers,
    idsEnabled: normalized.idsEnabled,
    firmwareVersion: normalized.firmwareVersion,
    fingerprint,
    summary: normalized.summary,
    lastCheckedAt: now,
  };
}

function buildSummary(parsed: GatewayFirewallCollectorState, portForwardCount: number, adminUserCount: number): string {
  const enabled = parsed.firewallEnabled === true ? 'enabled' : parsed.firewallEnabled === false ? 'disabled' : 'unknown';
  const wanDefaultAction = parsed.wanDefaultAction?.trim() || 'unknown';
  const ruleCount = Math.max(0, Number(parsed.ruleCount ?? 0) || 0);
  return `Firewall ${enabled}; WAN default ${wanDefaultAction}; rules ${ruleCount}; port forwards ${portForwardCount}; admins ${adminUserCount}`;
}

function toTargetStatus(targetId: string, state: PersistedGatewayTargetState, now: number): GatewayMonitorTargetStatus {
  return {
    id: targetId,
    displayName: state.displayName,
    provider: state.provider,
    available: state.available,
    firewallEnabled: state.firewallEnabled,
    ruleCount: state.ruleCount,
    wanDefaultAction: state.wanDefaultAction,
    portForwardCount: state.portForwards.length,
    adminUserCount: state.adminUsers.length,
    firmwareVersion: state.firmwareVersion,
    lastCheckedAt: state.lastCheckedAt || now,
    summary: state.summary,
  };
}

function gatewayFirewallDisabledSeverity(status: GatewayMonitorTargetStatus): HostMonitorSeverity {
  if (status.provider === 'opnsense' || status.provider === 'pfsense' || status.provider === 'unifi') {
    return 'critical';
  }
  return 'high';
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function diffStringSets(previous: string[], next: string[]): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: next.filter((value) => !before.has(value)),
    removed: previous.filter((value) => !after.has(value)),
  };
}

function hashText(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
