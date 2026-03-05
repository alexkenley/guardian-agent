/**
 * Network traffic baseline + threat detection using connection metadata only.
 *
 * This service intentionally avoids packet payload capture and keeps only flow
 * metadata for anomaly/threat heuristics.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface TrafficConnectionSample {
  protocol: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state?: string;
  bytesIn?: number;
  bytesOut?: number;
  timestamp?: number;
}

export interface ConnectionFlow {
  id: string;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  protocol: 'tcp' | 'udp';
  state: string;
  bytesIn: number;
  bytesOut: number;
  startTime: number;
  endTime?: number;
  service?: string;
}

export type TrafficThreatType =
  | 'data_exfiltration'
  | 'port_scanning'
  | 'beaconing'
  | 'lateral_movement'
  | 'unusual_external';

export type TrafficThreatSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface TrafficThreat {
  id: string;
  type: TrafficThreatType;
  severity: TrafficThreatSeverity;
  timestamp: number;
  srcIp?: string;
  dstIp?: string;
  description: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
}

export interface TrafficThreatRuleConfig {
  dataExfiltration: {
    enabled: boolean;
    thresholdMB: number;
    windowMinutes: number;
  };
  portScanning: {
    enabled: boolean;
    portThreshold: number;
    windowSeconds: number;
  };
  beaconing: {
    enabled: boolean;
    minIntervals: number;
    tolerancePercent: number;
  };
}

export interface TrafficBaselineSnapshot {
  flowCount: number;
  retainedMs: number;
  sourceCount: number;
  knownExternalDestinationCount: number;
  lastUpdatedAt: number;
}

interface PersistedState {
  flowRetentionMs: number;
  flows: ConnectionFlow[];
  knownExternalDestinations: Record<string, string[]>;
  lastUpdatedAt: number;
}

const DEFAULT_PERSIST_PATH = resolve(homedir(), '.guardianagent', 'network-traffic.json');
const DEFAULT_FLOW_RETENTION_MS = 24 * 60 * 60 * 1000;

export class NetworkTrafficService {
  private readonly now: () => number;
  private readonly persistPath: string;
  private readonly flows: ConnectionFlow[] = [];
  private readonly knownExternalDestinations = new Map<string, Set<string>>();
  private flowRetentionMs: number;
  private lastUpdatedAt = 0;
  private readonly rules: TrafficThreatRuleConfig;

  constructor(opts?: {
    now?: () => number;
    persistPath?: string;
    flowRetentionMs?: number;
    rules?: Partial<TrafficThreatRuleConfig>;
  }) {
    this.now = opts?.now ?? Date.now;
    this.persistPath = opts?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.flowRetentionMs = Math.max(60_000, opts?.flowRetentionMs ?? DEFAULT_FLOW_RETENTION_MS);
    this.rules = {
      dataExfiltration: {
        enabled: opts?.rules?.dataExfiltration?.enabled ?? true,
        thresholdMB: Math.max(1, opts?.rules?.dataExfiltration?.thresholdMB ?? 100),
        windowMinutes: Math.max(1, opts?.rules?.dataExfiltration?.windowMinutes ?? 60),
      },
      portScanning: {
        enabled: opts?.rules?.portScanning?.enabled ?? true,
        portThreshold: Math.max(5, opts?.rules?.portScanning?.portThreshold ?? 20),
        windowSeconds: Math.max(10, opts?.rules?.portScanning?.windowSeconds ?? 60),
      },
      beaconing: {
        enabled: opts?.rules?.beaconing?.enabled ?? true,
        minIntervals: Math.max(2, opts?.rules?.beaconing?.minIntervals ?? 10),
        tolerancePercent: Math.max(1, opts?.rules?.beaconing?.tolerancePercent ?? 5),
      },
    };
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedState;
      this.flowRetentionMs = Math.max(60_000, data.flowRetentionMs ?? this.flowRetentionMs);
      this.lastUpdatedAt = data.lastUpdatedAt ?? 0;
      this.flows.length = 0;
      for (const flow of data.flows ?? []) {
        this.flows.push(flow);
      }
      this.knownExternalDestinations.clear();
      for (const [src, destinations] of Object.entries(data.knownExternalDestinations ?? {})) {
        this.knownExternalDestinations.set(src, new Set(destinations));
      }
      this.pruneOldFlows(this.now());
    } catch {
      // First run / no file.
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedState = {
      flowRetentionMs: this.flowRetentionMs,
      flows: this.flows.slice(-5000),
      knownExternalDestinations: Object.fromEntries(
        [...this.knownExternalDestinations.entries()].map(([src, destinations]) => [src, [...destinations].slice(-500)]),
      ),
      lastUpdatedAt: this.lastUpdatedAt,
    };
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  getSnapshot(): TrafficBaselineSnapshot {
    return {
      flowCount: this.flows.length,
      retainedMs: this.flowRetentionMs,
      sourceCount: this.knownExternalDestinations.size,
      knownExternalDestinationCount: [...this.knownExternalDestinations.values()].reduce((sum, set) => sum + set.size, 0),
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  listRecentFlows(opts?: { limit?: number; srcIp?: string }): ConnectionFlow[] {
    const limit = Math.max(1, opts?.limit ?? 200);
    const srcFilter = opts?.srcIp?.trim();
    return this.flows
      .filter((flow) => !srcFilter || flow.srcIp === srcFilter)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  ingestConnections(samples: TrafficConnectionSample[]): { flowCount: number; added: number; threats: TrafficThreat[] } {
    const now = this.now();
    const previouslyKnown = cloneKnownExternalDestinations(this.knownExternalDestinations);
    let added = 0;

    for (const sample of samples) {
      const flow = normalizeSample(sample, now);
      if (!flow) continue;
      this.flows.push(flow);
      added += 1;
      if (isExternalAddress(flow.dstIp)) {
        const known = this.knownExternalDestinations.get(flow.srcIp) ?? new Set<string>();
        known.add(flow.dstIp);
        this.knownExternalDestinations.set(flow.srcIp, known);
      }
    }

    this.pruneOldFlows(now);
    const threats = this.detectThreats(now, previouslyKnown);
    this.lastUpdatedAt = now;
    this.persist().catch(() => {});
    return { flowCount: this.flows.length, added, threats };
  }

  private pruneOldFlows(now: number): void {
    const cutoff = now - this.flowRetentionMs;
    let idx = 0;
    while (idx < this.flows.length && this.flows[idx].startTime < cutoff) idx += 1;
    if (idx > 0) this.flows.splice(0, idx);
  }

  private detectThreats(now: number, previouslyKnown: Map<string, Set<string>>): TrafficThreat[] {
    const threats: TrafficThreat[] = [];
    const dedupe = new Set<string>();

    const dataExfilWindowMs = this.rules.dataExfiltration.windowMinutes * 60_000;
    const dataExfilFlows = this.flows.filter((flow) =>
      flow.startTime >= now - dataExfilWindowMs && isExternalAddress(flow.dstIp),
    );
    if (this.rules.dataExfiltration.enabled) {
      const bytesBySrc = new Map<string, number>();
      for (const flow of dataExfilFlows) {
        if (isLoopbackAddress(flow.srcIp)) continue;
        bytesBySrc.set(flow.srcIp, (bytesBySrc.get(flow.srcIp) ?? 0) + Math.max(0, flow.bytesOut));
      }
      for (const [srcIp, bytesOut] of bytesBySrc) {
        const mb = bytesOut / (1024 * 1024);
        if (mb >= this.rules.dataExfiltration.thresholdMB) {
          const dedupeKey = `data_exfiltration:${srcIp}:${Math.floor(now / dataExfilWindowMs)}`;
          dedupe.add(dedupeKey);
          threats.push({
            id: randomUUID(),
            type: 'data_exfiltration',
            severity: 'critical',
            timestamp: now,
            srcIp,
            description: `Potential data exfiltration from ${srcIp}: ${mb.toFixed(1)} MB outbound in ${this.rules.dataExfiltration.windowMinutes}m`,
            dedupeKey,
            evidence: { srcIp, bytesOut, thresholdMB: this.rules.dataExfiltration.thresholdMB },
          });
        }
      }
    }

    const scanWindowMs = this.rules.portScanning.windowSeconds * 1000;
    const scanFlows = this.flows.filter((flow) => flow.startTime >= now - scanWindowMs);
    if (this.rules.portScanning.enabled) {
      const byPair = new Map<string, { srcIp: string; dstIp: string; ports: Set<number> }>();
      for (const flow of scanFlows) {
        if (flow.dstPort <= 0) continue;
        if (shouldIgnoreLocalSelfProbe(flow.srcIp, flow.dstIp)) continue;
        const key = `${flow.srcIp}|${flow.dstIp}`;
        const entry = byPair.get(key) ?? { srcIp: flow.srcIp, dstIp: flow.dstIp, ports: new Set<number>() };
        entry.ports.add(flow.dstPort);
        byPair.set(key, entry);
      }
      for (const entry of byPair.values()) {
        if (entry.ports.size >= this.rules.portScanning.portThreshold) {
          const dedupeKey = `port_scanning:${entry.srcIp}:${entry.dstIp}`;
          if (dedupe.has(dedupeKey)) continue;
          dedupe.add(dedupeKey);
          threats.push({
            id: randomUUID(),
            type: 'port_scanning',
            severity: 'high',
            timestamp: now,
            srcIp: entry.srcIp,
            dstIp: entry.dstIp,
            description: `Potential port scanning: ${entry.srcIp} touched ${entry.ports.size} ports on ${entry.dstIp} in ${this.rules.portScanning.windowSeconds}s`,
            dedupeKey,
            evidence: { srcIp: entry.srcIp, dstIp: entry.dstIp, ports: [...entry.ports].sort((a, b) => a - b) },
          });
        }
      }
    }

    if (this.rules.beaconing.enabled) {
      const byTarget = new Map<string, number[]>();
      for (const flow of this.flows) {
        if (shouldIgnoreLocalSelfProbe(flow.srcIp, flow.dstIp)) continue;
        const key = `${flow.srcIp}|${flow.dstIp}|${flow.dstPort}`;
        const list = byTarget.get(key) ?? [];
        list.push(flow.startTime);
        byTarget.set(key, list);
      }
      for (const [key, timestamps] of byTarget) {
        if (timestamps.length < this.rules.beaconing.minIntervals + 1) continue;
        timestamps.sort((a, b) => a - b);
        const intervals: number[] = [];
        for (let i = 1; i < timestamps.length; i += 1) {
          intervals.push(timestamps[i] - timestamps[i - 1]);
        }
        const recentIntervals = intervals.slice(-this.rules.beaconing.minIntervals);
        const avg = recentIntervals.reduce((sum, value) => sum + value, 0) / recentIntervals.length;
        if (!Number.isFinite(avg) || avg <= 0) continue;
        const tolerance = avg * (this.rules.beaconing.tolerancePercent / 100);
        const steady = recentIntervals.every((value) => Math.abs(value - avg) <= tolerance);
        if (!steady) continue;
        const [srcIp, dstIp, dstPortText] = key.split('|');
        const dedupeKey = `beaconing:${srcIp}:${dstIp}:${dstPortText}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);
        threats.push({
          id: randomUUID(),
          type: 'beaconing',
          severity: 'high',
          timestamp: now,
          srcIp,
          dstIp,
          description: `Potential beaconing: ${srcIp} -> ${dstIp}:${dstPortText} with regular interval ${(avg / 1000).toFixed(1)}s`,
          dedupeKey,
          evidence: { srcIp, dstIp, dstPort: Number(dstPortText), avgIntervalMs: Math.round(avg), intervals: recentIntervals },
        });
      }
    }

    const lateralGroups = new Map<string, { destinations: Set<string>; ports: Set<number> }>();
    for (const flow of scanFlows) {
      if (shouldIgnoreLocalSelfProbe(flow.srcIp, flow.dstIp)) continue;
      if (!isInternalAddress(flow.srcIp) || !isInternalAddress(flow.dstIp)) continue;
      const entry = lateralGroups.get(flow.srcIp) ?? { destinations: new Set<string>(), ports: new Set<number>() };
      entry.destinations.add(flow.dstIp);
      if (flow.dstPort > 0) entry.ports.add(flow.dstPort);
      lateralGroups.set(flow.srcIp, entry);
    }
    for (const [srcIp, entry] of lateralGroups) {
      if (entry.destinations.size >= 5 && entry.ports.size >= 10) {
        const dedupeKey = `lateral_movement:${srcIp}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);
        threats.push({
          id: randomUUID(),
          type: 'lateral_movement',
          severity: 'critical',
          timestamp: now,
          srcIp,
          description: `Potential lateral movement: ${srcIp} contacted ${entry.destinations.size} internal hosts over ${entry.ports.size} ports`,
          dedupeKey,
          evidence: { srcIp, destinations: [...entry.destinations], ports: [...entry.ports].sort((a, b) => a - b) },
        });
      }
    }

    for (const flow of dataExfilFlows) {
      if (shouldIgnoreLocalSelfProbe(flow.srcIp, flow.dstIp)) continue;
      if (!isExternalAddress(flow.dstIp)) continue;
      const knownBefore = previouslyKnown.get(flow.srcIp);
      if (knownBefore?.has(flow.dstIp)) continue;
      const dedupeKey = `unusual_external:${flow.srcIp}:${flow.dstIp}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);
      threats.push({
        id: randomUUID(),
        type: 'unusual_external',
        severity: 'medium',
        timestamp: now,
        srcIp: flow.srcIp,
        dstIp: flow.dstIp,
        description: `Unusual new external destination for ${flow.srcIp}: ${flow.dstIp}`,
        dedupeKey,
        evidence: { srcIp: flow.srcIp, dstIp: flow.dstIp, dstPort: flow.dstPort },
      });
    }

    return threats.slice(0, 200);
  }
}

function normalizeSample(sample: TrafficConnectionSample, now: number): ConnectionFlow | null {
  const srcIp = sanitizeIp(sample.localAddress);
  const dstIp = sanitizeIp(sample.remoteAddress);
  if (!srcIp || !dstIp) return null;
  if (dstIp === '0.0.0.0' || dstIp === '::' || dstIp === '*') return null;
  const proto = sample.protocol.toLowerCase().includes('udp') ? 'udp' : 'tcp';
  return {
    id: randomUUID(),
    srcIp,
    srcPort: normalizePort(sample.localPort),
    dstIp,
    dstPort: normalizePort(sample.remotePort),
    protocol: proto,
    state: sample.state ?? 'UNKNOWN',
    bytesIn: Math.max(0, Number(sample.bytesIn ?? 0) || 0),
    bytesOut: Math.max(0, Number(sample.bytesOut ?? 0) || 0),
    startTime: sample.timestamp ?? now,
  };
}

function normalizePort(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 0;
  return Math.floor(n);
}

function sanitizeIp(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  const withoutZone = trimmed.split('%')[0];
  if (withoutZone.startsWith('[') && withoutZone.endsWith(']')) {
    return withoutZone.slice(1, -1);
  }
  return withoutZone;
}

function cloneKnownExternalDestinations(
  source: Map<string, Set<string>>,
): Map<string, Set<string>> {
  return new Map<string, Set<string>>(
    [...source.entries()].map(([src, destinations]) => [src, new Set(destinations)]),
  );
}

function isInternalAddress(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value === 'localhost' || value === '::1' || value.startsWith('127.')) return true;
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;
  const m172 = value.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (value.startsWith('169.254.')) return true;
  if (value.startsWith('fe80:') || value.startsWith('fd') || value.startsWith('fc')) return true;
  return false;
}

function isExternalAddress(ip: string): boolean {
  return !isInternalAddress(ip);
}

function isLoopbackAddress(ip: string): boolean {
  const value = ip.toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function shouldIgnoreLocalSelfProbe(srcIp: string, dstIp: string): boolean {
  if (srcIp === dstIp) return true;
  return isLoopbackAddress(srcIp) && isLoopbackAddress(dstIp);
}
