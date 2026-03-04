import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor.js';
import { validateHostParam } from './executor.js';
import type { ToolExecutionRequest } from './types.js';

function makeExecutor() {
  return new ToolExecutor({
    enabled: true,
    workspaceRoot: process.cwd(),
    policyMode: 'autonomous',
    allowedPaths: ['.'],
    allowedCommands: [],
    allowedDomains: [],
  });
}

function makeRequest(toolName: string, args: Record<string, unknown> = {}): ToolExecutionRequest {
  return {
    toolName,
    args,
    origin: 'web' as const,
    agentId: 'test-agent',
    userId: 'test-user',
    channel: 'test',
  };
}

describe('Network & System Tools', () => {
  describe('Tool registration', () => {
    it('registers all 11 network/system tools', () => {
      const executor = makeExecutor();
      const defs = executor.listToolDefinitions();
      const names = defs.map((d) => d.name);
      expect(names).toContain('net_ping');
      expect(names).toContain('net_arp_scan');
      expect(names).toContain('net_port_check');
      expect(names).toContain('net_interfaces');
      expect(names).toContain('net_connections');
      expect(names).toContain('net_dns_lookup');
      expect(names).toContain('net_traceroute');
      expect(names).toContain('sys_info');
      expect(names).toContain('sys_resources');
      expect(names).toContain('sys_processes');
      expect(names).toContain('sys_services');
    });

    it('all network/system tools are classified as read_only', () => {
      const executor = makeExecutor();
      const defs = executor.listToolDefinitions();
      const netSysTools = defs.filter((d) => d.name.startsWith('net_') || d.name.startsWith('sys_'));
      expect(netSysTools.length).toBe(11);
      for (const tool of netSysTools) {
        expect(tool.risk).toBe('read_only');
      }
    });
  });

  describe('net_interfaces', () => {
    it('returns structured interface data', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_interfaces'));
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      const output = result.output as { interfaces: Array<{ name: string; mac: string; addresses: unknown[] }> };
      expect(Array.isArray(output.interfaces)).toBe(true);
      expect(output.interfaces.length).toBeGreaterThan(0);
      // Every interface should have a name and addresses array
      for (const iface of output.interfaces) {
        expect(typeof iface.name).toBe('string');
        expect(Array.isArray(iface.addresses)).toBe(true);
      }
    });
  });

  describe('sys_info', () => {
    it('returns expected OS fields', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('sys_info'));
      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(typeof output.hostname).toBe('string');
      expect(typeof output.platform).toBe('string');
      expect(typeof output.arch).toBe('string');
      expect(typeof output.uptime).toBe('number');
      expect(typeof output.cpuCount).toBe('number');
      expect(typeof output.totalMemoryMB).toBe('number');
      expect(output.cpuCount).toBeGreaterThan(0);
      expect(output.totalMemoryMB).toBeGreaterThan(0);
    });
  });

  describe('sys_resources', () => {
    it('returns memory, cpu, and disk info', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('sys_resources'));
      expect(result.success).toBe(true);
      const output = result.output as { memory: Record<string, number>; cpu: Record<string, number>; disks: unknown[] };
      expect(output.memory.totalMB).toBeGreaterThan(0);
      expect(output.memory.freeMB).toBeGreaterThanOrEqual(0);
      expect(typeof output.memory.usedPercent).toBe('number');
      expect(output.cpu.cores).toBeGreaterThan(0);
      expect(typeof output.cpu.loadAvg1m).toBe('number');
    });
  });

  describe('net_ping', () => {
    it('successfully pings localhost', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_ping', { host: '127.0.0.1', count: 2 }));
      expect(result.success).toBe(true);
      const output = result.output as { host: string; reachable: boolean };
      expect(output.host).toBe('127.0.0.1');
      expect(output.reachable).toBe(true);
    });

    it('blocks external host', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_ping', { host: '8.8.8.8' }));
      expect(result.success).toBe(false);
      expect(result.message).toContain('private/local network');
    });
  });

  describe('net_port_check', () => {
    it('returns open:false for a known-closed port on localhost', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_port_check', {
        host: '127.0.0.1',
        ports: [59999],
      }));
      expect(result.success).toBe(true);
      const output = result.output as { host: string; results: Array<{ port: number; open: boolean }> };
      expect(output.results).toHaveLength(1);
      expect(output.results[0].port).toBe(59999);
      expect(output.results[0].open).toBe(false);
    });

    it('blocks external host for port scanning', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_port_check', {
        host: '93.184.216.34',
        ports: [80],
      }));
      expect(result.success).toBe(false);
      expect(result.message).toContain('private/local network');
    });
  });

  describe('net_traceroute', () => {
    it('blocks external host', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_traceroute', { host: '1.1.1.1' }));
      expect(result.success).toBe(false);
      expect(result.message).toContain('private/local network');
    });
  });

  describe('Host injection protection', () => {
    it('blocks command injection in host parameter', () => {
      expect(() => validateHostParam('127.0.0.1; rm -rf /')).toThrow('disallowed characters');
      expect(() => validateHostParam('host`whoami`')).toThrow('disallowed characters');
      expect(() => validateHostParam('$(evil)')).toThrow('disallowed characters');
      expect(() => validateHostParam('host | cat /etc/passwd')).toThrow('disallowed characters');
      expect(() => validateHostParam('')).toThrow('Invalid host');
    });

    it('allows valid hostnames and IPs', () => {
      expect(validateHostParam('192.168.1.1')).toBe('192.168.1.1');
      expect(validateHostParam('localhost')).toBe('localhost');
      expect(validateHostParam('myrouter.local')).toBe('myrouter.local');
      expect(validateHostParam('10.0.0.1')).toBe('10.0.0.1');
    });
  });

  describe('net_dns_lookup', () => {
    it('returns structured output with target and type fields', async () => {
      const executor = makeExecutor();
      // Use reverse lookup on loopback which works reliably everywhere
      const result = await executor.runTool(makeRequest('net_dns_lookup', { target: '127.0.0.1', type: 'PTR' }));
      // PTR for 127.0.0.1 may succeed or fail depending on system config,
      // but the tool should always return structured output with correct fields
      const output = result.output as { target?: string; type?: string } | undefined;
      if (result.success) {
        expect(output?.target).toBe('127.0.0.1');
        expect(output?.type).toBe('PTR');
      } else {
        // On systems where PTR fails, verify it returns a sensible error
        expect(result.message).toContain('DNS lookup failed');
      }
    });

    it('rejects invalid record types', async () => {
      const executor = makeExecutor();
      const result = await executor.runTool(makeRequest('net_dns_lookup', { target: 'localhost', type: 'INVALID' }));
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported record type');
    });
  });
});

describe('inferCapability mapping', () => {
  it('maps net_ tools to network.read', async () => {
    // We test this indirectly via the ConnectorPlaybookService
    // by importing the inferCapability-using code
    const { ConnectorPlaybookService } = await import('../runtime/connectors.js');
    const service = new ConnectorPlaybookService({
      config: {
        enabled: true,
        executionMode: 'direct_execute',
        maxConnectorCallsPerRun: 10,
        packs: [{
          id: 'net-pack',
          name: 'Network',
          enabled: true,
          allowedCapabilities: ['network.read'],
          allowedHosts: [],
          allowedPaths: [],
          allowedCommands: [],
          authMode: 'none',
          requireHumanApprovalForWrites: false,
        }],
        playbooks: {
          definitions: [{
            id: 'net-test',
            name: 'Net Test',
            enabled: true,
            mode: 'sequential',
            steps: [{
              id: 'step1',
              packId: 'net-pack',
              toolName: 'net_interfaces',
              args: {},
            }],
          }],
          enabled: true,
          maxSteps: 10,
          maxParallelSteps: 1,
          defaultStepTimeoutMs: 5000,
          requireSignedDefinitions: false,
          requireDryRunOnFirstExecution: false,
        },
        studio: { enabled: false, mode: 'read_only', requirePrivilegedTicket: false },
      },
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'test', message: 'ok', output: {} }),
    });

    const result = await service.runPlaybook({
      playbookId: 'net-test',
      origin: 'web',
    });
    // If capability was wrong, the step would fail with "Capability not allowed"
    expect(result.success).toBe(true);
  });

  it('blocks net_ tool when only system.read is allowed', async () => {
    const { ConnectorPlaybookService } = await import('../runtime/connectors.js');
    const service = new ConnectorPlaybookService({
      config: {
        enabled: true,
        executionMode: 'direct_execute',
        maxConnectorCallsPerRun: 10,
        packs: [{
          id: 'sys-pack',
          name: 'System Only',
          enabled: true,
          allowedCapabilities: ['system.read'],
          allowedHosts: [],
          allowedPaths: [],
          allowedCommands: [],
          authMode: 'none',
          requireHumanApprovalForWrites: false,
        }],
        playbooks: {
          definitions: [{
            id: 'bad-net',
            name: 'Bad Net',
            enabled: true,
            mode: 'sequential',
            steps: [{
              id: 'step1',
              packId: 'sys-pack',
              toolName: 'net_ping',
              args: { host: '127.0.0.1' },
            }],
          }],
          enabled: true,
          maxSteps: 10,
          maxParallelSteps: 1,
          defaultStepTimeoutMs: 5000,
          requireSignedDefinitions: false,
          requireDryRunOnFirstExecution: false,
        },
        studio: { enabled: false, mode: 'read_only', requirePrivilegedTicket: false },
      },
      runTool: async () => ({ success: true, status: 'succeeded', jobId: 'test', message: 'ok' }),
    });

    const result = await service.runPlaybook({
      playbookId: 'bad-net',
      origin: 'web',
    });
    // net_ping → network.read, but pack only allows system.read → should fail
    expect(result.success).toBe(false);
    expect(result.run.steps[0]?.message).toContain('not allowed');
  });
});
