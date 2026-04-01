import { isIP } from 'node:net';
import type { AssistantNetworkConfig } from '../../config/types.js';
import type { DeviceInventoryService } from '../../runtime/device-inventory.js';
import type { NetworkBaselineService } from '../../runtime/network-baseline.js';
import { parseBanner, inferServiceFromPort } from '../../runtime/network-fingerprinting.js';
import { classifyDevice, lookupOuiVendor } from '../../runtime/network-intelligence.js';
import type { NetworkTrafficService, TrafficConnectionSample } from '../../runtime/network-traffic.js';
import { parseAirportWifi, parseNetshWifi, parseNmcliWifi, correlateWifiClients } from '../../runtime/network-wifi.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface NetworkSystemToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  sandboxExec: (
    command: string,
    profile: 'read-only' | 'workspace-write',
    opts?: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      env?: Record<string, string>;
      networkAccess?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  networkConfig: AssistantNetworkConfig;
  deviceInventory?: DeviceInventoryService;
  networkBaseline?: NetworkBaselineService;
  networkTraffic?: NetworkTrafficService;
}

type ConnectionProfile = AssistantNetworkConfig['connections'][number];

type LocalConnection = {
  protocol: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  process: string | null;
};

type InterfaceAddress = {
  address: string;
  family: string | number;
  netmask: string;
  internal: boolean;
  mac: string;
};

type InterfaceMap = Record<string, InterfaceAddress[]>;

/**
 * Validate and sanitize a host parameter to prevent command injection.
 * Allows hostnames, IPv4, and IPv6 addresses only.
 */
export function validateHostParam(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 253) throw new Error('Invalid host: empty or too long.');
  const candidate = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (isIP(candidate)) return candidate;
  if (isValidHostname(candidate)) return candidate;
  throw new Error('Invalid host: must be a hostname or IP address.');
}

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split('.');
  return labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function sanitizeInterfaceName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error('Interface name cannot be empty.');
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error('Interface name contains invalid characters.');
  }
  return value;
}

function sanitizeSshUser(user: string): string {
  const value = user.trim();
  if (!value) throw new Error('SSH username cannot be empty.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error('SSH username contains invalid characters.');
  }
  return value;
}

function prefixLengthToNetmask(family: 'IPv4' | 'IPv6', prefix: number): string {
  if (family === 'IPv4') {
    const clamped = Math.max(0, Math.min(32, prefix));
    const octets = [0, 0, 0, 0];
    for (let index = 0; index < 4; index += 1) {
      const remaining = Math.max(0, Math.min(8, clamped - (index * 8)));
      octets[index] = remaining === 0 ? 0 : (0xff << (8 - remaining)) & 0xff;
    }
    return octets.join('.');
  }
  return `/${Math.max(0, Math.min(128, prefix))}`;
}

function buildLoopbackInterfacesFallback(): InterfaceMap {
  return {
    lo: [
      {
        address: '127.0.0.1',
        family: 'IPv4',
        netmask: '255.0.0.0',
        internal: true,
        mac: '00:00:00:00:00:00',
      },
      {
        address: '::1',
        family: 'IPv6',
        netmask: '/128',
        internal: true,
        mac: '00:00:00:00:00:00',
      },
    ],
  };
}

async function loadNetworkInterfaces(context: NetworkSystemToolRegistrarContext): Promise<InterfaceMap> {
  try {
    const { networkInterfaces } = await import('node:os');
    return (networkInterfaces() ?? {}) as InterfaceMap;
  } catch {
    if (process.platform !== 'linux') {
      return buildLoopbackInterfacesFallback();
    }
  }

  try {
    const [addrResult, linkResult] = await Promise.all([
      context.sandboxExec('ip -o addr show', 'read-only', { timeout: 10_000 }),
      context.sandboxExec('ip -o link show', 'read-only', { timeout: 10_000 }),
    ]);

    const macByInterface = new Map<string, string>();
    for (const line of linkResult.stdout.split('\n')) {
      const match = line.match(/^\d+:\s+([^:]+):.*link\/\w+\s+([0-9a-f:]{17})/i);
      if (!match) continue;
      macByInterface.set(match[1], match[2].toLowerCase());
    }

    const interfaces: InterfaceMap = {};
    for (const line of addrResult.stdout.split('\n')) {
      const match = line.match(/^\d+:\s+(\S+)\s+(inet6?)\s+([0-9a-fA-F:.]+)\/(\d+)/);
      if (!match) continue;
      const name = match[1];
      const family = match[2] === 'inet6' ? 'IPv6' : 'IPv4';
      const address = match[3];
      const prefixLength = Number.parseInt(match[4] ?? '', 10);
      const internal = name === 'lo' || name === 'lo0' || isLoopbackTarget(address);
      const mac = macByInterface.get(name) ?? '00:00:00:00:00:00';
      const entry: InterfaceAddress = {
        address,
        family,
        netmask: prefixLengthToNetmask(family, Number.isFinite(prefixLength) ? prefixLength : 0),
        internal,
        mac,
      };
      interfaces[name] ??= [];
      interfaces[name].push(entry);
    }

    return Object.keys(interfaces).length > 0 ? interfaces : buildLoopbackInterfacesFallback();
  } catch {
    return buildLoopbackInterfacesFallback();
  }
}

function isLocalNetworkTarget(host: string): boolean {
  const h = host.toLowerCase().trim();

  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;

  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (h.startsWith('fe80:')) return true;
  if (h.startsWith('fd') || h.startsWith('fc')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;

  return false;
}

function isLoopbackTarget(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (h === 'localhost' || h === '::1') return true;
  if (h.endsWith('.localhost')) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

function isPingPermissionDenied(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('operation not permitted')
    || lower.includes('permission denied')
    || lower.includes('lacking privilege')
    || lower.includes('raw socket');
}

function requireLocalNetwork(host: string): void {
  if (!isLocalNetworkTarget(host)) {
    throw new Error(
      `Host '${host}' is not a private/local network address. ` +
      'Network probing tools are restricted to local networks only ' +
      '(10.x, 172.16-31.x, 192.168.x, localhost, *.local) ' +
      'to avoid triggering external IDS/IPS alerts.',
    );
  }
}

const COMMON_PORTS: Record<number, string> = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns',
  80: 'http', 110: 'pop3', 143: 'imap', 443: 'https', 445: 'smb',
  993: 'imaps', 995: 'pop3s', 1433: 'mssql', 1521: 'oracle',
  3306: 'mysql', 3389: 'rdp', 5432: 'postgresql', 5900: 'vnc',
  6379: 'redis', 8080: 'http-alt', 8443: 'https-alt', 8888: 'http-alt',
  9090: 'prometheus', 27017: 'mongodb',
};

async function checkTcpPort(host: string, port: number, timeoutMs: number): Promise<{ port: number; open: boolean; service: string | null }> {
  const { Socket } = await import('node:net');
  return new Promise((resolve) => {
    const socket = new Socket();
    let resolved = false;
    const done = (open: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ port, open, service: open ? (COMMON_PORTS[port] ?? null) : null });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, host);
  });
}

function toTrafficSample(connection: LocalConnection): TrafficConnectionSample {
  return {
    protocol: connection.protocol,
    localAddress: connection.localAddress,
    localPort: connection.localPort,
    remoteAddress: connection.remoteAddress,
    remotePort: connection.remotePort,
    state: connection.state,
  };
}

async function grabPortBanner(host: string, port: number, timeoutMs: number): Promise<string | null> {
  const isHttp = port === 80 || port === 8080 || port === 8000;
  const isHttps = port === 443 || port === 8443;
  if (isHttps) {
    const tls = await import('node:tls');
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        rejectUnauthorized: false,
      });
      let resolved = false;
      let data = '';
      const done = (value: string | null): void => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.on('secureConnect', () => {
        socket.write(`HEAD / HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      socket.on('data', (chunk: Buffer | string) => {
        data += chunk.toString('utf-8');
        if (data.length > 8192) done(data.slice(0, 8192));
      });
      socket.on('end', () => done(data || null));
      socket.on('timeout', () => done(data || null));
      socket.on('error', (err) => reject(err));
    });
  }

  const { Socket } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let resolved = false;
    let data = '';
    const done = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      if (isHttp) {
        socket.write(`HEAD / HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on('data', (chunk: Buffer | string) => {
      data += chunk.toString('utf-8');
      if (data.length > 8192) done(data.slice(0, 8192));
    });
    socket.on('end', () => done(data || null));
    socket.on('timeout', () => done(data || null));
    socket.on('error', (err) => reject(err));
    socket.connect(port, host);
  });
}

function parsePingOutput(stdout: string, host: string): {
  host: string;
  reachable: boolean;
  packetsSent: number;
  packetsReceived: number;
  packetLossPercent: number;
  rttAvgMs: number | null;
} {
  const lossMatch = stdout.match(/(\d+)%\s*(?:packet\s*)?loss/i);
  const packetLoss = lossMatch ? parseInt(lossMatch[1], 10) : 100;
  const sentMatch = stdout.match(/(\d+)\s*(?:packets?\s*)?(?:transmitted|sent)/i);
  const recvMatch = stdout.match(/(\d+)\s*(?:packets?\s*)?received/i);
  const rttMatch = stdout.match(/(?:avg|average)[^=]*=\s*([\d.]+)/i)
    || stdout.match(/\d+\.\d+\/([\d.]+)\/\d+\.\d+/);
  return {
    host,
    reachable: packetLoss < 100,
    packetsSent: sentMatch ? parseInt(sentMatch[1], 10) : 0,
    packetsReceived: recvMatch ? parseInt(recvMatch[1], 10) : 0,
    packetLossPercent: packetLoss,
    rttAvgMs: rttMatch ? parseFloat(rttMatch[1]) : null,
  };
}

function parseArpLinux(stdout: string): Array<{ ip: string; mac: string; state: string }> {
  return stdout.split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const ip = parts[0] ?? '';
      const llIdx = parts.indexOf('lladdr');
      const mac = llIdx >= 0 ? (parts[llIdx + 1] ?? 'unknown') : 'unknown';
      const state = parts[parts.length - 1] ?? 'unknown';
      return { ip, mac, state };
    })
    .filter((device) => device.ip && device.ip !== 'Destination');
}

function parseArpWindows(stdout: string): Array<{ ip: string; mac: string; state: string }> {
  return stdout.split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.trim().match(/^\s*(?:\?\s+\()?(\d+\.\d+\.\d+\.\d+)\)?\s+(?:at\s+)?([0-9a-fA-F:.-]+)\s+(.*)$/);
      if (!match) return null;
      return { ip: match[1], mac: match[2], state: match[3]?.trim() || 'unknown' };
    })
    .filter((device): device is { ip: string; mac: string; state: string } => device !== null);
}

function parseSsLinux(stdout: string, stateFilter: string): LocalConnection[] {
  const lines = stdout.split('\n').slice(1).filter((line) => line.trim());
  const results: LocalConnection[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const proto = parts[0];
    const state = parts[1];
    const local = parts[4] ?? '';
    const remote = parts[5] ?? '';
    const procInfo = parts.slice(6).join(' ');
    if (stateFilter && state.toUpperCase() !== stateFilter) continue;
    const [localAddr, localPort] = splitAddress(local);
    const [remoteAddr, remotePort] = splitAddress(remote);
    results.push({
      protocol: proto,
      localAddress: localAddr,
      localPort: parseInt(localPort, 10) || 0,
      remoteAddress: remoteAddr,
      remotePort: parseInt(remotePort, 10) || 0,
      state,
      process: procInfo || null,
    });
  }
  return results.slice(0, 200);
}

function parseNetstatWindows(stdout: string, stateFilter: string): LocalConnection[] {
  const lines = stdout.split('\n').filter((line) => /^\s*(TCP|UDP)/i.test(line));
  const results: LocalConnection[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const proto = parts[0];
    const local = parts[1] ?? '';
    const remote = parts[2] ?? '';
    const state = parts[3] ?? '';
    if (stateFilter && state.toUpperCase() !== stateFilter) continue;
    const [localAddr, localPort] = splitAddress(local);
    const [remoteAddr, remotePort] = splitAddress(remote);
    results.push({
      protocol: proto,
      localAddress: localAddr,
      localPort: parseInt(localPort, 10) || 0,
      remoteAddress: remoteAddr,
      remotePort: parseInt(remotePort, 10) || 0,
      state,
      process: null,
    });
  }
  return results.slice(0, 200);
}

function splitAddress(addrPort: string): [string, string] {
  const bracketMatch = addrPort.match(/^\[([^\]]+)]:(\d+)$/);
  if (bracketMatch) return [bracketMatch[1], bracketMatch[2]];
  const lastColon = addrPort.lastIndexOf(':');
  if (lastColon <= 0) return [addrPort, '0'];
  return [addrPort.slice(0, lastColon), addrPort.slice(lastColon + 1)];
}

function parseTracerouteOutput(stdout: string): Array<{ hop: number; ip: string | null; hostname: string | null; rttMs: number | null }> {
  const lines = stdout.split('\n').filter((line) => line.trim());
  const hops: Array<{ hop: number; ip: string | null; hostname: string | null; rttMs: number | null }> = [];
  for (const line of lines) {
    const hopMatch = line.match(/^\s*(\d+)\s+/);
    if (!hopMatch) continue;
    const hop = parseInt(hopMatch[1], 10);
    const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    const rttMatch = line.match(/([\d.]+)\s*ms/);
    const hostMatch = line.match(/\s+([a-zA-Z][\w.-]+)\s+\(/);
    hops.push({
      hop,
      ip: ipMatch ? ipMatch[1] : null,
      hostname: hostMatch ? hostMatch[1] : null,
      rttMs: rttMatch ? parseFloat(rttMatch[1]) : null,
    });
  }
  return hops;
}

function parseDiskLinux(stdout: string): Array<{ filesystem: string; sizeMB: number; usedMB: number; availableMB: number; usedPercent: number; mount: string }> {
  return stdout.split('\n').slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      return {
        filesystem: parts[0],
        sizeMB: parseInt(parts[1], 10) || 0,
        usedMB: parseInt(parts[2], 10) || 0,
        availableMB: parseInt(parts[3], 10) || 0,
        usedPercent: parseInt(parts[4], 10) || 0,
        mount: parts[5],
      };
    })
    .filter((disk): disk is NonNullable<typeof disk> => disk !== null);
}

function parseDiskWindows(stdout: string): Array<{ filesystem: string; sizeMB: number; usedMB: number; availableMB: number; usedPercent: number; mount: string }> {
  return stdout.split('\n')
    .filter((line) => line.includes(',') && !line.startsWith('Node'))
    .map((line) => {
      const parts = line.trim().split(',');
      if (parts.length < 3) return null;
      const caption = parts[1]?.trim() ?? '';
      const freeSpace = parseInt(parts[2]?.trim() ?? '0', 10);
      const size = parseInt(parts[3]?.trim() ?? '0', 10);
      if (!size) return null;
      const sizeMB = Math.round(size / 1_048_576);
      const freeMB = Math.round(freeSpace / 1_048_576);
      const usedMB = sizeMB - freeMB;
      return {
        filesystem: caption,
        sizeMB,
        usedMB,
        availableMB: freeMB,
        usedPercent: sizeMB > 0 ? Math.round((usedMB / sizeMB) * 100) : 0,
        mount: caption,
      };
    })
    .filter((disk): disk is NonNullable<typeof disk> => disk !== null);
}

function parsePsLinux(stdout: string, limit: number): Array<{ pid: number; user: string; cpuPercent: number; memoryPercent: number; command: string }> {
  return stdout.split('\n').slice(1)
    .filter((line) => line.trim())
    .slice(0, limit)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) return null;
      return {
        pid: parseInt(parts[1], 10),
        user: parts[0],
        cpuPercent: parseFloat(parts[2]) || 0,
        memoryPercent: parseFloat(parts[3]) || 0,
        command: parts.slice(10).join(' '),
      };
    })
    .filter((processEntry): processEntry is NonNullable<typeof processEntry> => processEntry !== null);
}

function parseTasklistWindows(stdout: string, limit: number): Array<{ pid: number; user: string; cpuPercent: number; memoryPercent: number; command: string }> {
  return stdout.split('\n')
    .filter((line) => line.trim())
    .slice(0, limit)
    .map((line) => {
      const parts = line.replace(/"/g, '').split(',');
      if (parts.length < 2) return null;
      return {
        pid: parseInt(parts[1]?.trim() ?? '0', 10),
        user: 'N/A',
        cpuPercent: 0,
        memoryPercent: 0,
        command: parts[0]?.trim() ?? '',
      };
    })
    .filter((processEntry): processEntry is NonNullable<typeof processEntry> => processEntry !== null);
}

function parseLaunchctlOutput(stdout: string, filter: string): Array<{ name: string; active: string; sub: string; description: string }> {
  const normalizedFilter = filter.toLowerCase();
  return stdout.split('\n')
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.trim().split('\t');
      if (parts.length < 3) return null;
      const pid = parts[0]?.trim() ?? '-';
      const status = parts[1]?.trim() ?? '0';
      const label = parts[2]?.trim() ?? '';
      if (!label) return null;
      if (normalizedFilter && !label.toLowerCase().includes(normalizedFilter)) return null;
      return {
        name: label,
        active: pid !== '-' ? 'active' : 'inactive',
        sub: pid !== '-' ? `running (PID ${pid})` : `exit code ${status}`,
        description: label,
      };
    })
    .filter((service): service is NonNullable<typeof service> => service !== null);
}

function parseSystemctlOutput(stdout: string, filter: string): Array<{ name: string; active: string; sub: string; description: string }> {
  const normalizedFilter = filter.toLowerCase();
  return stdout.split('\n')
    .filter((line) => line.includes('.service'))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return null;
      const name = parts[0]?.replace('.service', '') ?? '';
      if (normalizedFilter && !name.toLowerCase().includes(normalizedFilter)) return null;
      return {
        name,
        active: parts[2] ?? 'unknown',
        sub: parts[3] ?? 'unknown',
        description: parts.slice(4).join(' '),
      };
    })
    .filter((service): service is NonNullable<typeof service> => service !== null);
}

function getConnectionProfile(context: NetworkSystemToolRegistrarContext, connectionId: string): ConnectionProfile | undefined {
  const id = connectionId.trim();
  if (!id) return undefined;
  return context.networkConfig.connections.find((connection) => connection.id === id);
}

async function collectLocalConnections(
  context: NetworkSystemToolRegistrarContext,
  stateFilter: string,
): Promise<LocalConnection[]> {
  const platform = process.platform;
  if (platform === 'linux') {
    try {
      const { stdout } = await context.sandboxExec('ss -tunap', 'read-only', { networkAccess: true, timeout: 10_000 });
      return parseSsLinux(stdout, stateFilter);
    } catch {
      const { stdout } = await context.sandboxExec('netstat -an', 'read-only', { networkAccess: true, timeout: 10_000 });
      return parseNetstatWindows(stdout, stateFilter);
    }
  }
  const { stdout } = await context.sandboxExec('netstat -an', 'read-only', { networkAccess: true, timeout: 10_000 });
  return parseNetstatWindows(stdout, stateFilter);
}

export function registerBuiltinNetworkSystemTools(context: NetworkSystemToolRegistrarContext): void {
  const { requireString, asString, asNumber } = context;

  context.registry.register(
    {
      name: 'net_ping',
      description: 'Ping a host to check reachability and measure latency. Returns packet loss and RTT stats. Security: restricted to private/local network addresses only (RFC1918, link-local, localhost) to prevent external reconnaissance. Requires network_access capability.',
      shortDescription: 'Ping a host to check reachability and measure latency.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host or IP to ping (private/local networks only).' },
          count: { type: 'number', description: 'Number of pings (1-10, default 4).' },
        },
        required: ['host'],
      },
    },
    async (args, request) => {
      const host = validateHostParam(requireString(args.host, 'host'));
      requireLocalNetwork(host);
      const count = Math.max(1, Math.min(10, asNumber(args.count, 4)));
      context.guardAction(request, 'network_probe', { host, count });
      const isWsl = process.platform === 'win32' && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
      const effectivePlatform = isWsl ? 'linux' : process.platform;
      let cmd: string;
      if (effectivePlatform === 'win32') {
        cmd = `ping -n ${count} ${host}`;
      } else if (effectivePlatform === 'darwin') {
        cmd = `ping -c ${count} -W 3000 ${host}`;
      } else {
        cmd = `ping -c ${count} -W 3 ${host}`;
      }
      try {
        const { stdout } = await context.sandboxExec(cmd, 'read-only', { networkAccess: true, timeout: 30_000 });
        const parsed = parsePingOutput(stdout, host);
        return { success: true, output: parsed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('100% packet loss') || message.includes('100.0% packet loss')) {
          return { success: true, output: { host, reachable: false, packetsSent: count, packetsReceived: 0, packetLossPercent: 100, rttAvgMs: null } };
        }
        if (isLoopbackTarget(host) && isPingPermissionDenied(message)) {
          return {
            success: true,
            output: {
              host,
              reachable: true,
              packetsSent: count,
              packetsReceived: count,
              packetLossPercent: 0,
              rttAvgMs: null,
              method: 'loopback_fallback',
            },
          };
        }
        return { success: false, error: `Ping failed: ${message}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'net_arp_scan',
      description: 'Discover devices on the local network via ARP table. Uses ip neigh (Linux) or arp -a (macOS/Windows). Returns IP, MAC, and state for each neighbor. Security: local-only — reads system ARP cache. Requires network_access capability.',
      shortDescription: 'Discover devices on the local network. Returns IP, MAC, and state.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          connectionId: { type: 'string', description: 'Optional assistant.network.connections id to scope scan behavior.' },
        },
      },
    },
    async (args, request) => {
      const connectionId = asString(args.connectionId).trim();
      const connection = connectionId ? getConnectionProfile(context, connectionId) : undefined;
      if (connectionId && !connection) {
        return { success: false, error: `Unknown network connection profile '${connectionId}'.` };
      }
      context.guardAction(request, 'network_probe', { action: 'arp_scan', connectionId: connectionId || undefined });

      if (connection?.type === 'remote') {
        if (!connection.host) {
          return { success: false, error: `Connection '${connection.id}' is remote but host is not configured.` };
        }
        const host = validateHostParam(connection.host);
        const sshUser = connection.sshUser ? sanitizeSshUser(connection.sshUser) : '';
        const sshTarget = `${sshUser ? `${sshUser}@` : ''}${host}`;
        const remoteCommand = (connection.remoteScanCommand?.trim() || 'ip neigh show')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\$/g, '\\$')
          .replace(/`/g, '\\`')
          .replace(/!/g, '\\!');
        try {
          const { stdout } = await context.sandboxExec(
            `ssh -o BatchMode=yes -o ConnectTimeout=8 ${sshTarget} "${remoteCommand}"`,
            'read-only',
            { networkAccess: true, timeout: 30_000 },
          );
          const parsed = parseArpLinux(stdout);
          return {
            success: true,
            output: {
              connectionId: connection.id,
              connectionType: connection.type,
              devices: parsed.length > 0 ? parsed : parseArpWindows(stdout),
            },
          };
        } catch (err) {
          return { success: false, error: `Remote ARP scan failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      const isLinux = process.platform === 'linux';
      if (isLinux) {
        try {
          const iface = connection?.interface ? sanitizeInterfaceName(connection.interface) : '';
          const cmd = iface ? `ip neigh show dev ${iface}` : 'ip neigh show';
          const { stdout } = await context.sandboxExec(cmd, 'read-only', { networkAccess: true, timeout: 10_000 });
          return {
            success: true,
            output: {
              connectionId: connection?.id ?? null,
              connectionType: connection?.type ?? 'lan',
              devices: parseArpLinux(stdout),
            },
          };
        } catch {
          try {
            const { stdout } = await context.sandboxExec('arp -a', 'read-only', { networkAccess: true, timeout: 10_000 });
            return {
              success: true,
              output: {
                connectionId: connection?.id ?? null,
                connectionType: connection?.type ?? 'lan',
                devices: parseArpWindows(stdout),
              },
            };
          } catch (err2) {
            return { success: false, error: `ARP scan failed: ${err2 instanceof Error ? err2.message : String(err2)}` };
          }
        }
      }

      try {
        const { stdout } = await context.sandboxExec('arp -a', 'read-only', { networkAccess: true, timeout: 10_000 });
        return {
          success: true,
          output: {
            connectionId: connection?.id ?? null,
            connectionType: connection?.type ?? (process.platform === 'darwin' ? 'wifi' : 'lan'),
            devices: parseArpWindows(stdout),
          },
        };
      } catch (err) {
        return { success: false, error: `ARP scan failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'net_port_check',
      description: 'Check if TCP ports are open on a host. Tests up to 20 ports with 3s timeout each. Security: restricted to private/local network addresses only (RFC1918, link-local, localhost). Requires network_access capability.',
      shortDescription: 'Check if TCP ports are open on a host.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host or IP to check (private/local networks only).' },
          ports: { type: 'array', items: { type: 'number' }, description: 'Ports to check (max 20).' },
        },
        required: ['host', 'ports'],
      },
    },
    async (args, request) => {
      const host = validateHostParam(requireString(args.host, 'host'));
      requireLocalNetwork(host);
      const rawPorts = Array.isArray(args.ports) ? args.ports : [];
      const ports = rawPorts.slice(0, 20).map(Number).filter((port) => port > 0 && port <= 65535);
      if (ports.length === 0) return { success: false, error: 'No valid ports specified.' };
      context.guardAction(request, 'network_probe', { host, ports });
      const results = await Promise.all(ports.map((port) => checkTcpPort(host, port, 3000)));
      return { success: true, output: { host, results } };
    },
  );

  context.registry.register(
    {
      name: 'net_interfaces',
      description: 'List network interfaces with IP addresses, MAC addresses, and netmasks. Read-only — reads from OS network stack. Requires network_access capability.',
      shortDescription: 'List network interfaces with IPs and MAC addresses.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'network_probe', { action: 'list_interfaces' });
      const ifaces = await loadNetworkInterfaces(context);
      const interfaces = Object.entries(ifaces)
        .filter(([, addrs]) => addrs != null)
        .map(([name, addrs]) => ({
          name,
          mac: addrs![0]?.mac ?? 'unknown',
          addresses: addrs!.map((addr) => ({
            address: addr.address,
            family: addr.family,
            netmask: addr.netmask,
            internal: addr.internal,
          })),
        }));
      return { success: true, output: { interfaces } };
    },
  );

  context.registry.register(
    {
      name: 'net_connections',
      description: 'List active network connections on this machine. Uses ss (Linux) or netstat -an (macOS/Windows). Optional state filter (ESTABLISHED, LISTEN, etc.). Read-only — reads from OS network stack. Requires network_access capability.',
      shortDescription: 'List active network connections on this machine.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Optional filter: ESTABLISHED, LISTEN, TIME_WAIT, etc.' },
        },
      },
    },
    async (args, request) => {
      const stateFilter = asString(args.state).toUpperCase().trim();
      context.guardAction(request, 'network_probe', { action: 'list_connections', state: stateFilter || undefined });
      try {
        const connections = await collectLocalConnections(context, stateFilter);
        let ingest: ReturnType<NetworkTrafficService['ingestConnections']> | undefined;
        if (context.networkTraffic && context.networkConfig.trafficAnalysis.enabled) {
          ingest = context.networkTraffic.ingestConnections(
            connections.map((connection) => toTrafficSample(connection)),
          );
          if (ingest.threats.length > 0 && context.networkBaseline) {
            context.networkBaseline.recordExternalThreats(
              ingest.threats.map((threat) => ({
                type: threat.type,
                severity: threat.severity,
                timestamp: threat.timestamp,
                ip: threat.srcIp,
                description: threat.description,
                dedupeKey: threat.dedupeKey,
                evidence: threat.evidence,
              })),
            );
          }
        }
        return { success: true, output: { connections, ingest } };
      } catch (err) {
        return { success: false, error: `Connections query failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'net_dns_lookup',
      description: 'Resolve hostname to IPs or reverse-lookup an IP. Supports A, AAAA, MX, and PTR record types. Uses system DNS resolver. Requires network_access capability.',
      shortDescription: 'Resolve hostname to IPs or reverse-lookup an IP.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Hostname or IP to resolve.' },
          type: { type: 'string', description: 'Record type: A, AAAA, MX, PTR (default: A).' },
        },
        required: ['target'],
      },
    },
    async (args, request) => {
      const target = validateHostParam(requireString(args.target, 'target'));
      const recordType = asString(args.type, 'A').toUpperCase();
      if (!['A', 'AAAA', 'MX', 'PTR'].includes(recordType)) {
        return { success: false, error: 'Unsupported record type. Use A, AAAA, MX, or PTR.' };
      }
      context.guardAction(request, 'network_probe', { target, type: recordType });
      const dns = await import('node:dns');
      const dnsPromises = dns.promises;

      const resolverConfigs: Array<string[] | null> = [null, ['8.8.8.8', '1.1.1.1']];
      for (const servers of resolverConfigs) {
        const resolver = new dnsPromises.Resolver();
        if (servers) resolver.setServers(servers);
        try {
          let records: string[];
          switch (recordType) {
            case 'AAAA':
              records = await resolver.resolve6(target);
              break;
            case 'MX':
              records = (await resolver.resolveMx(target)).map((record) => `${record.priority} ${record.exchange}`);
              break;
            case 'PTR':
              records = await resolver.reverse(target);
              break;
            default:
              records = await resolver.resolve4(target);
              break;
          }
          return { success: true, output: { target, type: recordType, records, ...(servers ? { resolver: 'fallback' } : {}) } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (servers || (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEOUT') && !msg.includes('EAI_AGAIN'))) {
            return { success: false, error: `DNS lookup failed: ${msg}` };
          }
        }
      }
      return { success: false, error: 'DNS lookup failed: all resolvers exhausted' };
    },
  );

  context.registry.register(
    {
      name: 'net_traceroute',
      description: 'Trace route to a host showing each network hop. Max 30 hops with 2s timeout per hop. Security: restricted to private/local network addresses only (RFC1918, link-local, localhost). Requires network_access capability.',
      shortDescription: 'Trace route to a host showing each network hop.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host or IP to trace (private/local networks only).' },
          maxHops: { type: 'number', description: 'Maximum hops (1-30, default 15).' },
        },
        required: ['host'],
      },
    },
    async (args, request) => {
      const host = validateHostParam(requireString(args.host, 'host'));
      requireLocalNetwork(host);
      const maxHops = Math.max(1, Math.min(30, asNumber(args.maxHops, 15)));
      context.guardAction(request, 'network_probe', { host, maxHops });
      const isWin = process.platform === 'win32';
      const cmd = isWin ? `tracert -h ${maxHops} -w 2000 ${host}` : `traceroute -m ${maxHops} -w 2 ${host}`;
      try {
        const { stdout } = await context.sandboxExec(cmd, 'read-only', { networkAccess: true, timeout: 60_000 });
        const hops = parseTracerouteOutput(stdout);
        return { success: true, output: { host, hops } };
      } catch (err) {
        return { success: false, error: `Traceroute failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'net_oui_lookup',
      description: 'Look up MAC vendor from OUI prefix. Returns vendor if known from bundled lookup table. Read-only.',
      shortDescription: 'Look up MAC address vendor from OUI prefix.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          mac: { type: 'string', description: 'MAC address (e.g. aa:bb:cc:dd:ee:ff).' },
        },
        required: ['mac'],
      },
    },
    async (args, request) => {
      const mac = requireString(args.mac, 'mac').trim();
      context.guardAction(request, 'network_probe', { action: 'oui_lookup', mac });
      return {
        success: true,
        output: {
          mac,
          vendor: lookupOuiVendor(mac) ?? null,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_classify',
      description: 'Classify discovered devices by type using vendor, hostname, and open-port heuristics. Read-only.',
      shortDescription: 'Classify devices by type using vendor, hostname, and ports.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          mac: { type: 'string', description: 'Optional MAC filter.' },
          ip: { type: 'string', description: 'Optional IP filter.' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'network_probe', { action: 'classify' });
      if (!context.deviceInventory) {
        return { success: false, error: 'Device inventory service is not available.' };
      }
      const macFilter = asString(args.mac).trim().toLowerCase();
      const ipFilter = asString(args.ip).trim();
      const devices = context.deviceInventory.listDevices().filter((device) => {
        if (macFilter && device.mac.toLowerCase() !== macFilter) return false;
        if (ipFilter && device.ip !== ipFilter) return false;
        return true;
      });
      const classified = devices.map((device) => {
        const vendor = device.vendor ?? lookupOuiVendor(device.mac);
        const classification = classifyDevice({
          vendor,
          hostname: device.hostname,
          openPorts: device.openPorts,
        });
        return {
          ip: device.ip,
          mac: device.mac,
          hostname: device.hostname,
          vendor,
          deviceType: classification.deviceType,
          confidence: classification.confidence,
          matchedSignals: classification.matchedSignals,
          openPorts: device.openPorts,
        };
      });
      return {
        success: true,
        output: {
          count: classified.length,
          devices: classified,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_banner_grab',
      description: 'Grab service banners from open ports on a local/private-network host. Protocol-aware for HTTP/SSH/SMTP/FTP with configurable timeout and concurrency. Requires network_access capability.',
      shortDescription: 'Grab service banners from open ports on a device.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host or IP to fingerprint (private/local only).' },
          ports: { type: 'array', items: { type: 'number' }, description: 'Optional explicit ports (max 50).' },
        },
        required: ['host'],
      },
    },
    async (args, request) => {
      if (!context.networkConfig.fingerprinting.enabled) {
        return { success: false, error: 'Network fingerprinting is disabled in configuration.' };
      }
      const host = validateHostParam(requireString(args.host, 'host'));
      requireLocalNetwork(host);
      context.guardAction(request, 'network_probe', { action: 'banner_grab', host });

      const explicitPorts = Array.isArray(args.ports)
        ? args.ports.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 65535)
        : [];
      let ports = explicitPorts.slice(0, 50);
      if (ports.length === 0 && context.deviceInventory) {
        const device = context.deviceInventory.listDevices().find((entry) => entry.ip === host);
        if (device) ports = device.openPorts.slice(0, 50);
      }
      if (ports.length === 0) {
        ports = [21, 22, 25, 53, 80, 110, 143, 443, 445, 554, 631, 3306, 5432, 8080, 8443];
      }
      ports = [...new Set(ports)].sort((a, b) => a - b);

      const timeoutMs = Math.max(500, context.networkConfig.fingerprinting.bannerTimeout);
      const maxConcurrent = Math.max(1, context.networkConfig.fingerprinting.maxConcurrentPerDevice);
      const queue = [...ports];
      const fingerprints: ReturnType<typeof parseBanner>[] = [];
      const failures: Array<{ port: number; error: string }> = [];

      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          const port = queue.shift();
          if (port === undefined) return;
          try {
            const banner = await grabPortBanner(host, port, timeoutMs);
            if (banner) {
              fingerprints.push(parseBanner(port, banner));
            } else {
              fingerprints.push({
                port,
                service: inferServiceFromPort(port),
                banner: '',
              });
            }
          } catch (err) {
            failures.push({ port, error: err instanceof Error ? err.message : String(err) });
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(maxConcurrent, ports.length) }, () => worker()),
      );

      if (context.deviceInventory) {
        context.deviceInventory.updateDeviceByIp(host, { fingerprints });
      }

      return {
        success: true,
        output: {
          host,
          portsScanned: ports.length,
          fingerprints: fingerprints.sort((a, b) => a.port - b.port),
          failures,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_fingerprint',
      description: 'Run full device fingerprinting (OUI vendor + optional port check + banner grab + classification). Requires network_access capability.',
      shortDescription: 'Run full device fingerprinting with OUI and banner analysis.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host/IP to fingerprint (private/local only).' },
          mac: { type: 'string', description: 'Optional MAC to look up from device inventory.' },
          ports: { type: 'array', items: { type: 'number' }, description: 'Optional explicit ports to probe.' },
          portScan: { type: 'boolean', description: 'Run port scan if open ports are unknown (default true).' },
        },
      },
    },
    async (args, request) => {
      if (!context.networkConfig.fingerprinting.enabled) {
        return { success: false, error: 'Network fingerprinting is disabled in configuration.' };
      }
      context.guardAction(request, 'network_probe', { action: 'fingerprint' });
      const macFilter = asString(args.mac).trim().toLowerCase();
      let host = asString(args.host).trim();
      let inventoryDevice: ReturnType<DeviceInventoryService['listDevices']>[number] | undefined;
      if (!host && macFilter && context.deviceInventory) {
        inventoryDevice = context.deviceInventory.listDevices().find((entry) => entry.mac === macFilter);
        host = inventoryDevice?.ip ?? '';
      }
      if (!host) {
        return { success: false, error: 'host is required (or provide mac with a matching inventory device).' };
      }
      host = validateHostParam(host);
      requireLocalNetwork(host);

      let openPorts = Array.isArray(args.ports)
        ? args.ports.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 65535)
        : [];

      if (openPorts.length === 0) {
        if (!inventoryDevice && context.deviceInventory) {
          inventoryDevice = context.deviceInventory.listDevices().find((entry) => entry.ip === host);
        }
        if (inventoryDevice?.openPorts.length) {
          openPorts = inventoryDevice.openPorts.slice();
        }
      }

      const shouldPortScan = args.portScan !== false;
      if (openPorts.length === 0 && shouldPortScan) {
        const candidatePorts = [21, 22, 23, 25, 53, 80, 110, 139, 143, 443, 445, 515, 554, 631, 2049, 3306, 3389, 5432, 8080, 8443, 9100];
        const portResults = await Promise.all(candidatePorts.map((port) => checkTcpPort(host, port, 1500)));
        openPorts = portResults.filter((entry) => entry.open).map((entry) => entry.port);
      }
      openPorts = [...new Set(openPorts)].sort((a, b) => a - b);

      const timeoutMs = Math.max(500, context.networkConfig.fingerprinting.bannerTimeout);
      const maxConcurrent = Math.max(1, context.networkConfig.fingerprinting.maxConcurrentPerDevice);
      const queue = [...openPorts];
      const fingerprints: ReturnType<typeof parseBanner>[] = [];
      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          const port = queue.shift();
          if (port === undefined) return;
          const banner = await grabPortBanner(host, port, timeoutMs).catch(() => null);
          if (banner) {
            fingerprints.push(parseBanner(port, banner));
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(maxConcurrent, Math.max(1, openPorts.length)) }, () => worker()),
      );

      const vendor = inventoryDevice?.vendor ?? (macFilter ? lookupOuiVendor(macFilter) : undefined);
      const classification = classifyDevice({
        vendor,
        hostname: inventoryDevice?.hostname ?? null,
        openPorts,
      });

      if (context.deviceInventory) {
        context.deviceInventory.updateDeviceByIp(host, {
          openPorts,
          vendor,
          fingerprints,
        });
      }

      return {
        success: true,
        output: {
          host,
          mac: inventoryDevice?.mac ?? (macFilter || null),
          vendor: vendor ?? null,
          openPorts,
          fingerprints: fingerprints.sort((a, b) => a.port - b.port),
          classification: {
            deviceType: classification.deviceType,
            confidence: classification.confidence,
            matchedSignals: classification.matchedSignals,
          },
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_wifi_scan',
      description: 'Scan nearby WiFi networks (SSID/BSSID/signal/security). Uses nmcli (Linux), airport (macOS), or netsh (Windows). Requires network_access capability.',
      shortDescription: 'Scan nearby WiFi networks. Returns SSID, signal, security.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Optional platform override: auto, linux, macos, windows.' },
          force: { type: 'boolean', description: 'Run even if assistant.network.wifi.enabled is false.' },
          connectionId: { type: 'string', description: 'Optional assistant.network.connections id (must be wifi or auto-compatible).' },
        },
      },
    },
    async (args, request) => {
      const force = !!args.force;
      if (!force && !context.networkConfig.wifi.enabled) {
        return { success: false, error: 'WiFi monitoring is disabled in configuration (assistant.network.wifi.enabled=false).' };
      }
      context.guardAction(request, 'network_probe', { action: 'wifi_scan' });
      const connectionId = asString(args.connectionId).trim();
      const connection = connectionId ? getConnectionProfile(context, connectionId) : undefined;
      if (connectionId && !connection) {
        return { success: false, error: `Unknown network connection profile '${connectionId}'.` };
      }
      if (connection && connection.type !== 'wifi') {
        return { success: false, error: `Connection '${connection.id}' is type '${connection.type}', expected 'wifi'.` };
      }
      const override = asString(args.platform).trim().toLowerCase();
      const resolvedPlatform = override || context.networkConfig.wifi.platform;
      const platform = resolvedPlatform === 'auto'
        ? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux')
        : resolvedPlatform;

      try {
        if (platform === 'linux') {
          const { stdout } = await context.sandboxExec(
            'nmcli -t -f SSID,BSSID,SIGNAL,CHAN,SECURITY dev wifi list',
            'read-only',
            { networkAccess: true, timeout: 20_000 },
          );
          let networks = parseNmcliWifi(stdout);
          if (connection?.ssid) {
            networks = networks.filter((network) => network.ssid === connection.ssid);
          }
          return { success: true, output: { platform, connectionId: connection?.id ?? null, count: networks.length, networks } };
        }
        if (platform === 'macos') {
          const { stdout } = await context.sandboxExec(
            '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s',
            'read-only',
            { networkAccess: true, timeout: 20_000 },
          );
          let networks = parseAirportWifi(stdout);
          if (connection?.ssid) {
            networks = networks.filter((network) => network.ssid === connection.ssid);
          }
          return { success: true, output: { platform, connectionId: connection?.id ?? null, count: networks.length, networks } };
        }
        const { stdout } = await context.sandboxExec(
          'netsh.exe wlan show networks mode=bssid',
          'read-only',
          { networkAccess: true, timeout: 20_000 },
        );
        let networks = parseNetshWifi(stdout);
        if (connection?.ssid) {
          networks = networks.filter((network) => network.ssid === connection.ssid);
        }
        return { success: true, output: { platform: 'windows', connectionId: connection?.id ?? null, count: networks.length, networks } };
      } catch (err) {
        return { success: false, error: `WiFi scan failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'net_wifi_clients',
      description: 'List likely WiFi clients by correlating ARP-neighbor observations with discovered devices. Requires network_access capability.',
      shortDescription: 'List WiFi clients by correlating ARP and interface data.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Run even if assistant.network.wifi.enabled is false.' },
        },
      },
    },
    async (args, request) => {
      const force = !!args.force;
      if (!force && !context.networkConfig.wifi.enabled) {
        return { success: false, error: 'WiFi monitoring is disabled in configuration (assistant.network.wifi.enabled=false).' };
      }
      context.guardAction(request, 'network_probe', { action: 'wifi_clients' });
      const platform = process.platform;
      let arpRows: Array<{ ip: string; mac: string; state: string }> = [];
      try {
        if (platform === 'linux') {
          try {
            const { stdout } = await context.sandboxExec('ip neigh show', 'read-only', { networkAccess: true, timeout: 10_000 });
            arpRows = parseArpLinux(stdout);
          } catch {
            const { stdout } = await context.sandboxExec('arp -a', 'read-only', { networkAccess: true, timeout: 10_000 });
            arpRows = parseArpWindows(stdout);
          }
        } else {
          const { stdout } = await context.sandboxExec('arp -a', 'read-only', { networkAccess: true, timeout: 10_000 });
          arpRows = parseArpWindows(stdout);
        }
      } catch (err) {
        return { success: false, error: `WiFi client enumeration failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const devices = context.deviceInventory?.listDevices() ?? [];
      const byMac = new Map(devices.map((device) => [device.mac.toLowerCase(), device]));
      const clients = arpRows
        .filter((row) => row.mac && row.mac !== 'unknown')
        .map((row) => {
          const known = byMac.get(row.mac.toLowerCase());
          return {
            ip: row.ip,
            mac: row.mac.toLowerCase(),
            state: row.state,
            hostname: known?.hostname ?? null,
            vendor: known?.vendor ?? lookupOuiVendor(row.mac),
            deviceType: known?.deviceType ?? null,
            trusted: known?.trusted ?? false,
          };
        });

      return {
        success: true,
        output: {
          count: clients.length,
          clients,
          correlatedKnownDevices: correlateWifiClients(devices),
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_connection_profiles',
      description: 'List configured assistant.network connection profiles with interface/host health hints.',
      shortDescription: 'List configured network connection profiles.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'network_probe', { action: 'connection_profiles' });
      const ifaces = await loadNetworkInterfaces(context);
      const profiles = context.networkConfig.connections.map((connection) => {
        const iface = connection.interface ? ifaces[connection.interface] : undefined;
        return {
          ...connection,
          interfacePresent: connection.interface ? Boolean(iface && iface.length > 0) : undefined,
          interfaceAddresses: iface
            ? iface.map((entry) => ({ address: entry.address, family: entry.family, internal: entry.internal }))
            : [],
        };
      });
      return {
        success: true,
        output: {
          count: profiles.length,
          profiles,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_traffic_baseline',
      description: 'Build/query traffic baseline from local connection metadata. Optional refresh runs a live connection capture first. Requires network_access capability.',
      shortDescription: 'Build or query traffic baseline from local connections.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Capture current connections before returning baseline snapshot.' },
          state: { type: 'string', description: 'Optional connection state filter for refresh capture.' },
          limitFlows: { type: 'number', description: 'Recent flow sample size (default 100).' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'network_probe', { action: 'traffic_baseline' });
      if (!context.networkTraffic) {
        return { success: false, error: 'Network traffic service is not available.' };
      }

      const refresh = args.refresh !== false;
      let ingest: { flowCount: number; added: number; threats: unknown[] } | null = null;
      if (refresh) {
        const stateFilter = asString(args.state).toUpperCase().trim();
        const connections = await collectLocalConnections(context, stateFilter);
        ingest = context.networkTraffic.ingestConnections(
          connections.map((connection) => toTrafficSample(connection)),
        );
      }

      const limit = Math.max(1, Math.min(500, asNumber(args.limitFlows, 100)));
      return {
        success: true,
        output: {
          snapshot: context.networkTraffic.getSnapshot(),
          ingest,
          recentFlows: context.networkTraffic.listRecentFlows({ limit }),
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_threat_check',
      description: 'Run traffic-based threat detection rules (exfiltration, scanning, beaconing, lateral movement, unusual external). Optional refresh captures live connections first. Requires network_access capability.',
      shortDescription: 'Run traffic-based threat detection rules.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Capture current local connections before analysis (default true).' },
          state: { type: 'string', description: 'Optional connection state filter for refresh capture.' },
          includeLow: { type: 'boolean', description: 'Include low-severity findings in output.' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'network_probe', { action: 'threat_check' });
      if (!context.networkTraffic) {
        return { success: false, error: 'Network traffic service is not available.' };
      }

      const refresh = args.refresh !== false;
      let ingestResult: { flowCount: number; added: number; threats: ReturnType<NetworkTrafficService['ingestConnections']>['threats'] } | null = null;
      if (refresh) {
        const stateFilter = asString(args.state).toUpperCase().trim();
        const connections = await collectLocalConnections(context, stateFilter);
        ingestResult = context.networkTraffic.ingestConnections(
          connections.map((connection) => toTrafficSample(connection)),
        );
      }

      let threats = ingestResult?.threats ?? [];
      if (!args.includeLow) {
        threats = threats.filter((threat) => threat.severity !== 'low');
      }

      let emittedAlerts: unknown[] = [];
      if (threats.length > 0 && context.networkBaseline) {
        emittedAlerts = context.networkBaseline.recordExternalThreats(
          threats.map((threat) => ({
            type: threat.type,
            severity: threat.severity,
            timestamp: threat.timestamp,
            ip: threat.srcIp,
            description: threat.description,
            dedupeKey: threat.dedupeKey,
            evidence: threat.evidence,
          })),
        );
      }

      return {
        success: true,
        output: {
          snapshot: context.networkTraffic.getSnapshot(),
          threats,
          threatCount: threats.length,
          emittedAlerts,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_baseline',
      description: 'Get network baseline status and device profile summary. Read-only.',
      shortDescription: 'Get network baseline status and device profile summary.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          includeDevices: { type: 'boolean', description: 'Include known device records in response.' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'network_probe', { action: 'baseline_status' });
      if (!context.networkConfig.baseline.enabled) {
        return { success: false, error: 'Network baseline monitoring is disabled in configuration.' };
      }
      if (!context.networkBaseline) {
        return { success: false, error: 'Network baseline service is not available.' };
      }
      const includeDevices = !!args.includeDevices;
      const snapshot = context.networkBaseline.getSnapshot();
      return {
        success: true,
        output: {
          snapshotCount: snapshot.snapshotCount,
          minSnapshotsForBaseline: snapshot.minSnapshotsForBaseline,
          baselineReady: snapshot.baselineReady,
          lastUpdatedAt: snapshot.lastUpdatedAt,
          knownDeviceCount: snapshot.knownDevices.length,
          knownDevices: includeDevices ? snapshot.knownDevices : undefined,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'net_anomaly_check',
      description: 'Run anomaly detection against current discovered devices and update network alert state. Read-only.',
      shortDescription: 'Run anomaly detection against current device inventory.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      context.guardAction(request, 'network_probe', { action: 'anomaly_check' });
      if (!context.networkConfig.baseline.enabled) {
        return { success: false, error: 'Network baseline monitoring is disabled in configuration.' };
      }
      if (!context.networkBaseline || !context.deviceInventory) {
        return { success: false, error: 'Network baseline or device inventory service is not available.' };
      }
      const report = context.networkBaseline.runSnapshot(context.deviceInventory.listDevices());
      return { success: true, output: report };
    },
  );

  context.registry.register(
    {
      name: 'net_threat_summary',
      description: 'Summarize active network alerts and baseline readiness. Read-only.',
      shortDescription: 'Summarize active network alerts and baseline readiness.',
      risk: 'read_only',
      category: 'network',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          includeAcknowledged: { type: 'boolean', description: 'Include acknowledged alerts.' },
          limit: { type: 'number', description: 'Maximum alerts to return (default 50).' },
        },
      },
    },
    async (args, request) => {
      context.guardAction(request, 'network_probe', { action: 'threat_summary' });
      if (!context.networkConfig.baseline.enabled) {
        return { success: false, error: 'Network baseline monitoring is disabled in configuration.' };
      }
      if (!context.networkBaseline) {
        return { success: false, error: 'Network baseline service is not available.' };
      }
      const includeAcknowledged = !!args.includeAcknowledged;
      const limit = Math.max(1, Math.min(200, asNumber(args.limit, 50)));
      const alerts = context.networkBaseline.listAlerts({ includeAcknowledged, limit });
      const bySeverity = {
        low: alerts.filter((alert) => alert.severity === 'low').length,
        medium: alerts.filter((alert) => alert.severity === 'medium').length,
        high: alerts.filter((alert) => alert.severity === 'high').length,
        critical: alerts.filter((alert) => alert.severity === 'critical').length,
      };
      const baseline = context.networkBaseline.getSnapshot();
      return {
        success: true,
        output: {
          baselineReady: baseline.baselineReady,
          snapshotCount: baseline.snapshotCount,
          activeAlertCount: alerts.length,
          bySeverity,
          alerts,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'sys_info',
      description: 'Get OS info, hostname, uptime, architecture, CPU count, and total memory. Read-only — reads from OS APIs, no network calls.',
      shortDescription: 'Get OS info, hostname, uptime, and CPU details.',
      risk: 'read_only',
      category: 'system',
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      const os = await import('node:os');
      context.guardAction(request, 'system_info', { action: 'sys_info' });
      return {
        success: true,
        output: {
          hostname: os.hostname(),
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          uptime: os.uptime(),
          type: os.type(),
          cpuCount: os.cpus().length,
          totalMemoryMB: Math.round(os.totalmem() / 1_048_576),
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'sys_resources',
      description: 'Get current CPU load averages, memory usage, and disk usage. Uses df (Linux/macOS) or wmic (Windows) for disk info. Read-only — no network calls.',
      shortDescription: 'Get current CPU load, memory usage, and disk space.',
      risk: 'read_only',
      category: 'system',
      parameters: { type: 'object', properties: {} },
    },
    async (_args, request) => {
      const os = await import('node:os');
      context.guardAction(request, 'system_info', { action: 'sys_resources' });
      const totalMB = Math.round(os.totalmem() / 1_048_576);
      const freeMB = Math.round(os.freemem() / 1_048_576);
      const [loadAvg1m, loadAvg5m, loadAvg15m] = os.loadavg();
      const memory = { totalMB, freeMB, usedPercent: Math.round(((totalMB - freeMB) / totalMB) * 100) };
      const cpu = { loadAvg1m: +loadAvg1m.toFixed(2), loadAvg5m: +loadAvg5m.toFixed(2), loadAvg15m: +loadAvg15m.toFixed(2), cores: os.cpus().length };

      let disks: Array<{ filesystem: string; sizeMB: number; usedMB: number; availableMB: number; usedPercent: number; mount: string }> = [];
      try {
        if (process.platform === 'win32') {
          const { stdout } = await context.sandboxExec('wmic logicaldisk get size,freespace,caption /format:csv', 'read-only', { timeout: 10_000 });
          disks = parseDiskWindows(stdout);
        } else {
          const { stdout } = await context.sandboxExec('df -Pm', 'read-only', { timeout: 10_000 });
          disks = parseDiskLinux(stdout);
        }
      } catch {
        // Disk info is best-effort.
      }

      return { success: true, output: { memory, cpu, disks } };
    },
  );

  context.registry.register(
    {
      name: 'sys_processes',
      description: 'List top processes sorted by CPU or memory usage. Returns up to 50 processes with PID, CPU%, MEM%, and command. Read-only — no network calls.',
      shortDescription: 'List top processes sorted by CPU or memory usage.',
      risk: 'read_only',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          sortBy: { type: 'string', description: 'Sort by: cpu or memory (default: cpu).' },
          limit: { type: 'number', description: 'Max processes to return (1-50, default 20).' },
        },
      },
    },
    async (args, request) => {
      const sortBy = asString(args.sortBy, 'cpu').toLowerCase() === 'memory' ? 'memory' : 'cpu';
      const limit = Math.max(1, Math.min(50, asNumber(args.limit, 20)));
      context.guardAction(request, 'system_info', { action: 'sys_processes', sortBy, limit });
      const platform = process.platform;
      try {
        if (platform === 'win32') {
          const { stdout } = await context.sandboxExec('tasklist /FO CSV /NH', 'read-only', { timeout: 10_000 });
          const processes = parseTasklistWindows(stdout, limit);
          return { success: true, output: { processes } };
        }
        if (platform === 'darwin') {
          const flag = sortBy === 'memory' ? '-m' : '-r';
          const { stdout } = await context.sandboxExec(`ps aux ${flag}`, 'read-only', { timeout: 10_000 });
          const processes = parsePsLinux(stdout, limit);
          return { success: true, output: { processes } };
        }
        const sortFlag = sortBy === 'memory' ? '-%mem' : '-%cpu';
        const { stdout } = await context.sandboxExec(`ps aux --sort=${sortFlag}`, 'read-only', { timeout: 10_000 });
        const processes = parsePsLinux(stdout, limit);
        return { success: true, output: { processes } };
      } catch (err) {
        return { success: false, error: `Process listing failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );

  context.registry.register(
    {
      name: 'sys_services',
      description: 'List services and their status. Uses systemctl on Linux, launchctl on macOS. Optional name filter. Not available on Windows. Read-only — no network calls.',
      shortDescription: 'List services and their status.',
      risk: 'read_only',
      category: 'system',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional filter string for service names.' },
        },
      },
    },
    async (args, request) => {
      const platform = process.platform;
      if (platform === 'win32') {
        return { success: false, error: 'sys_services is not available on Windows. Use sys_processes instead.' };
      }
      const filter = asString(args.filter).trim();
      context.guardAction(request, 'system_info', { action: 'sys_services', filter: filter || undefined });

      if (platform === 'darwin') {
        try {
          const { stdout } = await context.sandboxExec('launchctl list', 'read-only', { timeout: 10_000 });
          const services = parseLaunchctlOutput(stdout, filter);
          return { success: true, output: { services } };
        } catch (err) {
          return { success: false, error: `Service listing failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      try {
        const { stdout } = await context.sandboxExec(
          'systemctl list-units --type=service --all --no-pager --plain',
          'read-only',
          { timeout: 10_000 },
        );
        const services = parseSystemctlOutput(stdout, filter);
        return { success: true, output: { services } };
      } catch (err) {
        return { success: false, error: `Service listing failed (systemd may not be available): ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  );
}
