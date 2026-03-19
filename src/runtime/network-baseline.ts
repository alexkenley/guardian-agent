/**
 * Network baseline and anomaly detection service.
 *
 * Maintains a simple baseline over discovered devices and emits deduplicated
 * anomaly alerts for security monitoring and operations workflows.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DiscoveredDevice } from './device-inventory.js';
import type { DeviceType } from './network-intelligence.js';
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

export type NetworkAnomalySeverity = 'low' | 'medium' | 'high' | 'critical';
export type NetworkAnomalyType =
  | 'new_device'
  | 'port_change'
  | 'mass_port_open'
  | 'arp_conflict'
  | 'unusual_service'
  | 'device_gone'
  | 'data_exfiltration'
  | 'port_scanning'
  | 'beaconing'
  | 'lateral_movement'
  | 'unusual_external';

export interface NetworkAnomalyRuleConfig {
  enabled: boolean;
  severity: NetworkAnomalySeverity;
}

export interface BaselineDevice {
  mac: string;
  lastIp: string;
  hostname: string | null;
  vendor?: string;
  deviceType?: DeviceType;
  lastPorts: number[];
  firstSeenAt: number;
  lastSeenAt: number;
  missingScans: number;
}

export interface NetworkAnomaly {
  id: string;
  type: NetworkAnomalyType;
  severity: NetworkAnomalySeverity;
  timestamp: number;
  mac?: string;
  ip?: string;
  description: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
}

export interface NetworkAlert extends NetworkAnomaly {
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

export interface NetworkBaselineSnapshot {
  snapshotCount: number;
  minSnapshotsForBaseline: number;
  baselineReady: boolean;
  lastUpdatedAt: number;
  knownDevices: BaselineDevice[];
}

export interface NetworkAnomalyReport {
  timestamp: number;
  baselineReady: boolean;
  snapshotCount: number;
  anomalies: NetworkAnomaly[];
  riskScore: number;
}

interface PersistedState {
  snapshotCount: number;
  minSnapshotsForBaseline: number;
  dedupeWindowMs: number;
  lastUpdatedAt: number;
  knownDevices: BaselineDevice[];
  alerts: NetworkAlert[];
}

const DEFAULT_PERSIST_PATH = resolve(homedir(), '.guardianagent', 'network-baseline.json');
const DEFAULT_DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MIN_SNAPSHOTS = 3;

function severityWeight(severity: NetworkAnomalySeverity): number {
  switch (severity) {
    case 'critical': return 45;
    case 'high': return 30;
    case 'medium': return 15;
    default: return 5;
  }
}

function normalizePorts(ports: number[]): number[] {
  return [...new Set((ports ?? []).map(Number).filter((p) => Number.isFinite(p) && p > 0))]
    .sort((a, b) => a - b);
}

function diffPorts(a: number[], b: number[]): { added: number[]; removed: number[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    added: b.filter((p) => !setA.has(p)),
    removed: a.filter((p) => !setB.has(p)),
  };
}

export class NetworkBaselineService {
  private readonly now: () => number;
  private readonly persistPath: string;
  private readonly knownDevices = new Map<string, BaselineDevice>();
  private readonly alerts = new Map<string, NetworkAlert>();
  private snapshotCount = 0;
  private minSnapshotsForBaseline: number;
  private dedupeWindowMs: number;
  private lastUpdatedAt = 0;
  private readonly rules: Record<NetworkAnomalyType, NetworkAnomalyRuleConfig>;

  constructor(opts?: {
    now?: () => number;
    persistPath?: string;
    minSnapshotsForBaseline?: number;
    dedupeWindowMs?: number;
    rules?: Partial<Record<NetworkAnomalyType, Partial<NetworkAnomalyRuleConfig>>>;
  }) {
    this.now = opts?.now ?? Date.now;
    this.persistPath = opts?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.minSnapshotsForBaseline = Math.max(1, opts?.minSnapshotsForBaseline ?? DEFAULT_MIN_SNAPSHOTS);
    this.dedupeWindowMs = Math.max(1_000, opts?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS);
    const defaultRules: Record<NetworkAnomalyType, NetworkAnomalyRuleConfig> = {
      new_device: { enabled: true, severity: 'medium' },
      port_change: { enabled: true, severity: 'low' },
      mass_port_open: { enabled: true, severity: 'high' },
      arp_conflict: { enabled: true, severity: 'critical' },
      unusual_service: { enabled: true, severity: 'medium' },
      device_gone: { enabled: true, severity: 'low' },
      data_exfiltration: { enabled: true, severity: 'critical' },
      port_scanning: { enabled: true, severity: 'high' },
      beaconing: { enabled: true, severity: 'high' },
      lateral_movement: { enabled: true, severity: 'critical' },
      unusual_external: { enabled: true, severity: 'medium' },
    };
    this.rules = { ...defaultRules };
    if (opts?.rules) {
      for (const [type, override] of Object.entries(opts.rules) as Array<[NetworkAnomalyType, Partial<NetworkAnomalyRuleConfig>]>) {
        this.rules[type] = {
          enabled: override.enabled ?? this.rules[type].enabled,
          severity: override.severity ?? this.rules[type].severity,
        };
      }
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedState;
      this.snapshotCount = Math.max(0, data.snapshotCount ?? 0);
      this.minSnapshotsForBaseline = Math.max(1, data.minSnapshotsForBaseline ?? this.minSnapshotsForBaseline);
      this.dedupeWindowMs = Math.max(1_000, data.dedupeWindowMs ?? this.dedupeWindowMs);
      this.lastUpdatedAt = data.lastUpdatedAt ?? 0;
      this.knownDevices.clear();
      for (const device of data.knownDevices ?? []) {
        if (!device.mac) continue;
        this.knownDevices.set(device.mac.toLowerCase(), {
          ...device,
          mac: device.mac.toLowerCase(),
          lastPorts: normalizePorts(device.lastPorts),
          missingScans: Math.max(0, device.missingScans ?? 0),
        });
      }
      this.alerts.clear();
      for (const alert of data.alerts ?? []) {
        this.alerts.set(alert.id, alert);
      }
    } catch {
      // First run / missing file.
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedState = {
      snapshotCount: this.snapshotCount,
      minSnapshotsForBaseline: this.minSnapshotsForBaseline,
      dedupeWindowMs: this.dedupeWindowMs,
      lastUpdatedAt: this.lastUpdatedAt,
      knownDevices: [...this.knownDevices.values()],
      alerts: [...this.alerts.values()],
    };
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  getSnapshot(): NetworkBaselineSnapshot {
    return {
      snapshotCount: this.snapshotCount,
      minSnapshotsForBaseline: this.minSnapshotsForBaseline,
      baselineReady: this.snapshotCount >= this.minSnapshotsForBaseline,
      lastUpdatedAt: this.lastUpdatedAt,
      knownDevices: [...this.knownDevices.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    };
  }

  listAlerts(opts?: SecurityAlertListOptions): NetworkAlert[] {
    return listSecurityAlerts(this.alerts.values(), this.now(), opts);
  }

  acknowledgeAlert(alertId: string): SecurityAlertStateResult {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      return { success: false, message: `Alert '${alertId}' not found.` };
    }
    acknowledgeSecurityAlert(alert, this.now());
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' acknowledged.` };
  }

  resolveAlert(alertId: string, reason?: string): SecurityAlertStateResult {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      return { success: false, message: `Alert '${alertId}' not found.` };
    }
    resolveSecurityAlert(alert, this.now(), reason);
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' resolved.` };
  }

  suppressAlert(alertId: string, until: number, reason?: string): SecurityAlertStateResult {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      return { success: false, message: `Alert '${alertId}' not found.` };
    }
    if (!Number.isFinite(until) || until <= this.now()) {
      return { success: false, message: 'suppressedUntil must be a future timestamp.' };
    }
    suppressSecurityAlert(alert, this.now(), until, reason);
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' suppressed until ${new Date(until).toISOString()}.` };
  }

  /**
   * Record externally produced threats (e.g., traffic-analysis rules) using
   * the same dedupe/acknowledgement lifecycle as baseline anomalies.
   */
  recordExternalThreats(input: Array<{
    type: NetworkAnomalyType;
    severity?: NetworkAnomalySeverity;
    timestamp?: number;
    mac?: string;
    ip?: string;
    description: string;
    dedupeKey?: string;
    evidence?: Record<string, unknown>;
  }>): NetworkAnomaly[] {
    if (input.length === 0) return [];
    const now = this.now();
    const anomalies: NetworkAnomaly[] = [];
    for (const item of input) {
      const rule = this.rules[item.type];
      if (!rule?.enabled) continue;
      anomalies.push({
        id: randomUUID(),
        type: item.type,
        severity: item.severity ?? rule.severity,
        timestamp: item.timestamp ?? now,
        mac: item.mac,
        ip: item.ip,
        description: item.description,
        dedupeKey: item.dedupeKey ?? `${item.type}:${item.mac ?? item.ip ?? 'global'}`,
        evidence: item.evidence ?? {},
      });
    }
    if (anomalies.length === 0) return [];
    this.lastUpdatedAt = now;
    const emitted = this.recordAnomalies(anomalies, now);
    this.persist().catch(() => {});
    return emitted;
  }

  runSnapshot(devices: DiscoveredDevice[]): NetworkAnomalyReport {
    const now = this.now();
    const anomalies: NetworkAnomaly[] = [];
    const baselineReadyBefore = this.snapshotCount >= this.minSnapshotsForBaseline;

    const currentByMac = new Map<string, DiscoveredDevice>();
    const ipToMacs = new Map<string, Set<string>>();
    for (const raw of devices) {
      const mac = raw.mac.toLowerCase();
      currentByMac.set(mac, raw);
      const ipKey = raw.ip;
      const set = ipToMacs.get(ipKey) ?? new Set<string>();
      set.add(mac);
      ipToMacs.set(ipKey, set);
    }

    // ARP/IP conflicts: multiple MACs claiming the same IP in one snapshot.
    for (const [ip, macs] of ipToMacs) {
      if (macs.size > 1 && this.rules.arp_conflict.enabled) {
        const severity = this.rules.arp_conflict.severity;
        anomalies.push({
          id: randomUUID(),
          type: 'arp_conflict',
          severity,
          timestamp: now,
          ip,
          description: `ARP conflict: ${macs.size} devices claim IP ${ip}`,
          dedupeKey: `arp_conflict:${ip}`,
          evidence: { ip, macs: [...macs] },
        });
      }
    }

    // Per-device comparisons.
    for (const [mac, device] of currentByMac) {
      const existing = this.knownDevices.get(mac);
      const currentPorts = normalizePorts(device.openPorts);

      if (!existing) {
        if (baselineReadyBefore && this.rules.new_device.enabled) {
          anomalies.push({
            id: randomUUID(),
            type: 'new_device',
            severity: device.trusted ? 'low' : this.rules.new_device.severity,
            timestamp: now,
            mac,
            ip: device.ip,
            description: `New device detected: ${device.ip} (${mac})`,
            dedupeKey: `new_device:${mac}`,
            evidence: {
              ip: device.ip,
              mac,
              vendor: device.vendor,
              deviceType: device.deviceType,
            },
          });
        }

        this.knownDevices.set(mac, {
          mac,
          lastIp: device.ip,
          hostname: device.hostname,
          vendor: device.vendor,
          deviceType: device.deviceType,
          lastPorts: currentPorts,
          firstSeenAt: now,
          lastSeenAt: now,
          missingScans: 0,
        });
        continue;
      }

      if (baselineReadyBefore) {
        const delta = diffPorts(existing.lastPorts, currentPorts);
        const changedCount = delta.added.length + delta.removed.length;
        if (changedCount > 0 && this.rules.port_change.enabled) {
          const severity: NetworkAnomalySeverity = changedCount >= 6
            ? 'high'
            : changedCount >= 3
              ? 'medium'
              : this.rules.port_change.severity;
          anomalies.push({
            id: randomUUID(),
            type: 'port_change',
            severity,
            timestamp: now,
            mac,
            ip: device.ip,
            description: `Port profile changed for ${device.ip}: +${delta.added.length}/-${delta.removed.length}`,
            dedupeKey: `port_change:${mac}:${delta.added.join(',')}:${delta.removed.join(',')}`,
            evidence: {
              previous: existing.lastPorts,
              current: currentPorts,
              added: delta.added,
              removed: delta.removed,
            },
          });
        }

        if (delta.added.length >= 6 && this.rules.mass_port_open.enabled) {
          anomalies.push({
            id: randomUUID(),
            type: 'mass_port_open',
            severity: this.rules.mass_port_open.severity,
            timestamp: now,
            mac,
            ip: device.ip,
            description: `Mass port exposure on ${device.ip}: ${delta.added.length} newly open ports`,
            dedupeKey: `mass_port_open:${mac}:${delta.added.join(',')}`,
            evidence: {
              added: delta.added,
              previous: existing.lastPorts,
              current: currentPorts,
            },
          });
        }

        const unusual = detectUnusualService(device.deviceType, currentPorts);
        if (unusual.length > 0 && this.rules.unusual_service.enabled) {
          anomalies.push({
            id: randomUUID(),
            type: 'unusual_service',
            severity: this.rules.unusual_service.severity,
            timestamp: now,
            mac,
            ip: device.ip,
            description: `Unusual service profile for ${device.ip} (${device.deviceType ?? 'unknown'})`,
            dedupeKey: `unusual_service:${mac}:${unusual.join(',')}`,
            evidence: { deviceType: device.deviceType, unusualPorts: unusual, ports: currentPorts },
          });
        }
      }

      existing.lastIp = device.ip;
      existing.hostname = device.hostname;
      existing.vendor = device.vendor;
      existing.deviceType = device.deviceType;
      existing.lastPorts = currentPorts;
      existing.lastSeenAt = now;
      existing.missingScans = 0;
    }

    // Missing devices.
    for (const known of this.knownDevices.values()) {
      if (currentByMac.has(known.mac)) continue;
      known.missingScans += 1;
      if (baselineReadyBefore && known.missingScans >= 2 && this.rules.device_gone.enabled) {
        anomalies.push({
          id: randomUUID(),
          type: 'device_gone',
          severity: this.rules.device_gone.severity,
          timestamp: now,
          mac: known.mac,
          ip: known.lastIp,
          description: `Known device missing for ${known.missingScans} snapshots: ${known.lastIp} (${known.mac})`,
          dedupeKey: `device_gone:${known.mac}`,
          evidence: {
            mac: known.mac,
            ip: known.lastIp,
            missingScans: known.missingScans,
            lastSeenAt: known.lastSeenAt,
          },
        });
      }
    }

    this.snapshotCount += 1;
    this.lastUpdatedAt = now;

    const emitted = this.recordAnomalies(anomalies, now);
    const riskScore = Math.min(100, emitted.reduce((sum, a) => sum + severityWeight(a.severity), 0));
    this.persist().catch(() => {});

    return {
      timestamp: now,
      baselineReady: this.snapshotCount >= this.minSnapshotsForBaseline,
      snapshotCount: this.snapshotCount,
      anomalies: emitted,
      riskScore,
    };
  }

  private recordAnomalies(anomalies: NetworkAnomaly[], now: number): NetworkAnomaly[] {
    const emitted: NetworkAnomaly[] = [];

    for (const anomaly of anomalies) {
      const existing = [...this.alerts.values()].find((a) => a.dedupeKey === anomaly.dedupeKey);
      if (existing) {
        ensureSecurityAlertLifecycle(existing);
        const previousLastSeenAt = existing.lastSeenAt;
        const withinWindow = now - previousLastSeenAt < this.dedupeWindowMs;
        existing.lastSeenAt = now;
        existing.occurrenceCount += 1;
        existing.timestamp = anomaly.timestamp;
        existing.severity = anomaly.severity;
        existing.description = anomaly.description;
        existing.evidence = anomaly.evidence;
        existing.ip = anomaly.ip;
        existing.mac = anomaly.mac;
        if (existing.status === 'resolved') {
          reactivateSecurityAlert(existing, now);
          emitted.push({
            ...existing,
            id: existing.id,
            type: existing.type,
            severity: existing.severity,
            timestamp: existing.timestamp,
            mac: existing.mac,
            ip: existing.ip,
            description: existing.description,
            dedupeKey: existing.dedupeKey,
            evidence: existing.evidence,
          });
          continue;
        }
        if (!withinWindow) {
          // Re-emit after dedupe window expiry.
          if (isSecurityAlertSuppressed(existing, now)) {
            continue;
          }
          reactivateSecurityAlert(existing, now);
          emitted.push({
            ...existing,
            id: existing.id,
          });
        }
        continue;
      }

      this.alerts.set(anomaly.id, {
        ...anomaly,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        acknowledged: false,
        status: 'active',
        lastStateChangedAt: now,
      });
      emitted.push(anomaly);
    }

    // Bound alert history size.
    const maxAlerts = 500;
    if (this.alerts.size > maxAlerts) {
      const ids = [...this.alerts.values()]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(maxAlerts)
        .map((a) => a.id);
      for (const id of ids) this.alerts.delete(id);
    }

    return emitted;
  }
}

function detectUnusualService(deviceType: DeviceType | undefined, ports: number[]): number[] {
  if (!deviceType || deviceType === 'unknown') return [];
  const set = new Set(ports);

  if (deviceType === 'printer') {
    return [22, 23, 3389, 5432].filter((p) => set.has(p));
  }
  if (deviceType === 'camera') {
    return [22, 445, 3389].filter((p) => set.has(p));
  }
  if (deviceType === 'phone' || deviceType === 'tablet') {
    return ports.length > 3 ? ports.slice(0, 3) : [];
  }
  if (deviceType === 'iot') {
    return [445, 3389, 5432, 3306].filter((p) => set.has(p));
  }
  return [];
}
