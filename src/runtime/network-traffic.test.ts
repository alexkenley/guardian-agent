import { describe, expect, it } from 'vitest';
import { NetworkTrafficService, type TrafficConnectionSample } from './network-traffic.js';

function sample(input: Partial<TrafficConnectionSample> = {}): TrafficConnectionSample {
  return {
    protocol: input.protocol ?? 'tcp',
    localAddress: input.localAddress ?? '192.168.1.10',
    localPort: input.localPort ?? 51000,
    remoteAddress: input.remoteAddress ?? '93.184.216.34',
    remotePort: input.remotePort ?? 443,
    state: input.state ?? 'ESTABLISHED',
    bytesIn: input.bytesIn,
    bytesOut: input.bytesOut,
    timestamp: input.timestamp,
  };
}

describe('NetworkTrafficService', () => {
  it('tracks unusual external destinations per source', () => {
    let t = 1_000_000;
    const svc = new NetworkTrafficService({
      now: () => t,
      persistPath: '/tmp/network-traffic-test-1.json',
    });
    const first = svc.ingestConnections([sample({ remoteAddress: '93.184.216.34' })]);
    expect(first.threats.some((threat) => threat.type === 'unusual_external')).toBe(true);
    t += 1000;
    const second = svc.ingestConnections([sample({ remoteAddress: '93.184.216.34' })]);
    expect(second.threats.some((threat) => threat.type === 'unusual_external')).toBe(false);
  });

  it('detects potential port scanning', () => {
    let t = 1_000_000;
    const svc = new NetworkTrafficService({
      now: () => t,
      persistPath: '/tmp/network-traffic-test-2.json',
      rules: {
        portScanning: {
          enabled: true,
          portThreshold: 5,
          windowSeconds: 60,
        },
      },
    });
    const flows: TrafficConnectionSample[] = [];
    for (let i = 1; i <= 6; i += 1) {
      flows.push(sample({
        remoteAddress: '192.168.1.50',
        remotePort: 1000 + i,
      }));
    }
    const result = svc.ingestConnections(flows);
    expect(result.threats.some((threat) => threat.type === 'port_scanning')).toBe(true);
  });

  it('does not flag loopback self-traffic as port scanning', () => {
    let t = 1_000_000;
    const svc = new NetworkTrafficService({
      now: () => t,
      persistPath: '/tmp/network-traffic-test-4.json',
      rules: {
        portScanning: {
          enabled: true,
          portThreshold: 10,
          windowSeconds: 60,
        },
      },
    });
    const flows: TrafficConnectionSample[] = [];
    for (let i = 0; i < 39; i += 1) {
      flows.push(sample({
        localAddress: '::1',
        remoteAddress: '::1',
        localPort: 40000 + i,
        remotePort: 1000 + i,
      }));
    }
    const result = svc.ingestConnections(flows);
    expect(result.threats.some((threat) => threat.type === 'port_scanning')).toBe(false);
  });

  it('detects beaconing intervals', () => {
    let t = 1_000_000;
    const svc = new NetworkTrafficService({
      now: () => t,
      persistPath: '/tmp/network-traffic-test-3.json',
      rules: {
        beaconing: {
          enabled: true,
          minIntervals: 3,
          tolerancePercent: 10,
        },
      },
    });
    const flows: TrafficConnectionSample[] = [];
    for (let i = 0; i < 4; i += 1) {
      flows.push(sample({
        timestamp: t + (i * 10_000),
        remoteAddress: '198.51.100.1',
        remotePort: 8443,
      }));
    }
    const result = svc.ingestConnections(flows);
    expect(result.threats.some((threat) => threat.type === 'beaconing')).toBe(true);
  });
});
