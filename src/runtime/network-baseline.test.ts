import { describe, expect, it } from 'vitest';
import { NetworkBaselineService } from './network-baseline.js';
import type { DiscoveredDevice } from './device-inventory.js';

function device(input: Partial<DiscoveredDevice> & { ip: string; mac: string }): DiscoveredDevice {
  const now = Date.now();
  return {
    ip: input.ip,
    mac: input.mac.toLowerCase(),
    hostname: input.hostname ?? null,
    openPorts: input.openPorts ?? [],
    firstSeen: input.firstSeen ?? now,
    lastSeen: input.lastSeen ?? now,
    status: input.status ?? 'online',
    vendor: input.vendor,
    deviceType: input.deviceType,
    deviceTypeConfidence: input.deviceTypeConfidence,
    services: input.services,
    userLabel: input.userLabel,
    trusted: input.trusted,
  };
}

describe('NetworkBaselineService', () => {
  it('learns baseline before emitting anomalies', () => {
    let t = 1_000_000;
    const svc = new NetworkBaselineService({
      now: () => t,
      minSnapshotsForBaseline: 2,
      persistPath: '/tmp/network-baseline-test-1.json',
    });
    const d1 = device({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01', openPorts: [80, 443] });
    const first = svc.runSnapshot([d1]);
    expect(first.anomalies).toHaveLength(0);
    expect(first.baselineReady).toBe(false);
    t += 1000;
    const second = svc.runSnapshot([d1]);
    expect(second.baselineReady).toBe(true);
    expect(second.anomalies).toHaveLength(0);
  });

  it('emits new_device once baseline is ready', () => {
    let t = 1_000_000;
    const svc = new NetworkBaselineService({
      now: () => t,
      minSnapshotsForBaseline: 1,
      persistPath: '/tmp/network-baseline-test-2.json',
    });
    const d1 = device({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01' });
    svc.runSnapshot([d1]); // learn
    t += 1000;
    const d2 = device({ ip: '192.168.1.20', mac: 'aa:bb:cc:dd:ee:02' });
    const report = svc.runSnapshot([d1, d2]);
    expect(report.anomalies.some((a) => a.type === 'new_device')).toBe(true);
  });

  it('detects port changes', () => {
    let t = 1_000_000;
    const svc = new NetworkBaselineService({
      now: () => t,
      minSnapshotsForBaseline: 1,
      persistPath: '/tmp/network-baseline-test-3.json',
    });
    const d1 = device({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01', openPorts: [80] });
    svc.runSnapshot([d1]);
    t += 1000;
    const changed = device({ ...d1, openPorts: [80, 443, 22] });
    const report = svc.runSnapshot([changed]);
    expect(report.anomalies.some((a) => a.type === 'port_change')).toBe(true);
  });

  it('detects arp conflicts', () => {
    const svc = new NetworkBaselineService({
      now: () => 1_000_000,
      minSnapshotsForBaseline: 1,
      persistPath: '/tmp/network-baseline-test-4.json',
    });
    const report = svc.runSnapshot([
      device({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01' }),
      device({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:02' }),
    ]);
    expect(report.anomalies.some((a) => a.type === 'arp_conflict')).toBe(true);
  });

  it('supports acknowledging alerts', () => {
    let t = 1_000_000;
    const svc = new NetworkBaselineService({
      now: () => t,
      minSnapshotsForBaseline: 1,
      persistPath: '/tmp/network-baseline-test-5.json',
      dedupeWindowMs: 1,
    });
    const d1 = device({ ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01', openPorts: [80] });
    svc.runSnapshot([d1]);
    t += 10;
    const changed = device({ ...d1, openPorts: [80, 443] });
    const report = svc.runSnapshot([changed]);
    const alert = svc.listAlerts({ includeAcknowledged: true })[0];
    expect(report.anomalies.length).toBeGreaterThan(0);
    const result = svc.acknowledgeAlert(alert.id);
    expect(result.success).toBe(true);
    expect(svc.listAlerts().length).toBe(0);
  });
});

