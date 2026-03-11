import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AssistantHostMonitoringConfig, HostMonitorSeverity } from '../config/types.js';

const execFile = promisify(execFileCb);

export type HostMonitorAlertType =
  | 'suspicious_process'
  | 'persistence_change'
  | 'sensitive_path_change'
  | 'new_external_destination'
  | 'new_listening_port';

export interface HostMonitorAlert {
  id: string;
  type: HostMonitorAlertType;
  severity: HostMonitorSeverity;
  timestamp: number;
  description: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
  acknowledged: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
}

export interface HostMonitorSnapshot {
  processCount: number;
  suspiciousProcesses: Array<{ pid: number; name: string }>;
  persistenceEntryCount: number;
  watchedPathCount: number;
  knownExternalDestinationCount: number;
  listeningPortCount: number;
}

export interface HostMonitorStatus {
  platform: NodeJS.Platform;
  enabled: boolean;
  baselineReady: boolean;
  lastUpdatedAt: number;
  snapshot: HostMonitorSnapshot;
  activeAlertCount: number;
  bySeverity: Record<HostMonitorSeverity, number>;
}

export interface HostMonitorReport {
  timestamp: number;
  baselineReady: boolean;
  snapshot: HostMonitorSnapshot;
  alerts: HostMonitorAlert[];
}

interface PersistedState {
  baselineReady: boolean;
  lastUpdatedAt: number;
  persistenceEntries: string[];
  sensitiveFingerprints: Record<string, string>;
  knownExternalDestinations: string[];
  knownListeningPorts: number[];
  alerts: HostMonitorAlert[];
}

type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<string>;

const DEFAULT_PERSIST_PATH = resolve(homedir(), '.guardianagent', 'host-monitor.json');
const WINDOWS_RUN_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
];
const HIGH_RISK_WINDOWS_PROCESSES = new Set([
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'bitsadmin.exe',
  'certutil.exe',
  'psexec.exe',
]);
const HIGH_RISK_PORTS = new Set([22, 23, 445, 1433, 3306, 3389, 5432, 5900, 6379]);

export interface HostMonitoringServiceOptions {
  config: AssistantHostMonitoringConfig;
  persistPath?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  runner?: CommandRunner;
}

export class HostMonitoringService {
  private readonly config: AssistantHostMonitoringConfig;
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly runner: CommandRunner;
  private baselineReady = false;
  private lastUpdatedAt = 0;
  private persistenceEntries = new Set<string>();
  private sensitiveFingerprints = new Map<string, string>();
  private knownExternalDestinations = new Set<string>();
  private knownListeningPorts = new Set<number>();
  private readonly alerts = new Map<string, HostMonitorAlert>();
  private lastSnapshot: HostMonitorSnapshot = {
    processCount: 0,
    suspiciousProcesses: [],
    persistenceEntryCount: 0,
    watchedPathCount: 0,
    knownExternalDestinationCount: 0,
    listeningPortCount: 0,
  };

  constructor(options: HostMonitoringServiceOptions) {
    this.config = options.config;
    this.persistPath = options.persistPath ?? DEFAULT_PERSIST_PATH;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? homedir();
    this.runner = options.runner ?? defaultRunner;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as PersistedState;
      this.baselineReady = !!data.baselineReady;
      this.lastUpdatedAt = data.lastUpdatedAt ?? 0;
      this.persistenceEntries = new Set(data.persistenceEntries ?? []);
      this.sensitiveFingerprints = new Map(Object.entries(data.sensitiveFingerprints ?? {}));
      this.knownExternalDestinations = new Set(data.knownExternalDestinations ?? []);
      this.knownListeningPorts = new Set((data.knownListeningPorts ?? []).map(Number).filter((p) => Number.isFinite(p)));
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
      persistenceEntries: [...this.persistenceEntries].sort(),
      sensitiveFingerprints: Object.fromEntries([...this.sensitiveFingerprints.entries()].sort(([a], [b]) => a.localeCompare(b))),
      knownExternalDestinations: [...this.knownExternalDestinations].sort(),
      knownListeningPorts: [...this.knownListeningPorts].sort((a, b) => a - b),
      alerts: [...this.alerts.values()],
    };
    await mkdir(dirname(this.persistPath), { recursive: true });
    await writeFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  getStatus(): HostMonitorStatus {
    const alerts = this.listAlerts();
    return {
      platform: this.platform,
      enabled: this.config.enabled,
      baselineReady: this.baselineReady,
      lastUpdatedAt: this.lastUpdatedAt,
      snapshot: { ...this.lastSnapshot, suspiciousProcesses: [...this.lastSnapshot.suspiciousProcesses] },
      activeAlertCount: alerts.length,
      bySeverity: {
        low: alerts.filter((a) => a.severity === 'low').length,
        medium: alerts.filter((a) => a.severity === 'medium').length,
        high: alerts.filter((a) => a.severity === 'high').length,
        critical: alerts.filter((a) => a.severity === 'critical').length,
      },
    };
  }

  listAlerts(opts?: { includeAcknowledged?: boolean; limit?: number }): HostMonitorAlert[] {
    const includeAcknowledged = !!opts?.includeAcknowledged;
    const limit = Math.max(1, opts?.limit ?? 100);
    return [...this.alerts.values()]
      .filter((alert) => includeAcknowledged || !alert.acknowledged)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit);
  }

  acknowledgeAlert(alertId: string): { success: boolean; message: string } {
    const alert = this.alerts.get(alertId);
    if (!alert) return { success: false, message: `Alert '${alertId}' not found.` };
    alert.acknowledged = true;
    this.persist().catch(() => {});
    return { success: true, message: `Alert '${alertId}' acknowledged.` };
  }

  async runCheck(): Promise<HostMonitorReport> {
    const timestamp = this.now();
    const processes = this.config.monitorProcesses ? await this.collectProcesses() : [];
    const suspiciousProcesses = processes.filter((proc) => this.isSuspiciousProcess(proc.name));

    const persistenceEntries = this.config.monitorPersistence ? await this.collectPersistenceEntries() : [];
    const sensitiveFingerprints = this.config.monitorSensitivePaths ? await this.collectSensitiveFingerprints() : new Map<string, string>();
    const networkState = this.config.monitorNetwork ? await this.collectNetworkState() : { externalDestinations: [] as string[], listeningPorts: [] as number[] };

    const snapshot: HostMonitorSnapshot = {
      processCount: processes.length,
      suspiciousProcesses,
      persistenceEntryCount: persistenceEntries.length,
      watchedPathCount: sensitiveFingerprints.size,
      knownExternalDestinationCount: networkState.externalDestinations.length,
      listeningPortCount: networkState.listeningPorts.length,
    };

    const anomalies: Array<Omit<HostMonitorAlert, 'id' | 'acknowledged' | 'firstSeenAt' | 'lastSeenAt' | 'occurrenceCount'>> = [];

    for (const proc of suspiciousProcesses) {
      anomalies.push({
        type: 'suspicious_process',
        severity: this.processSeverity(proc.name),
        timestamp,
        description: `Suspicious process detected: ${proc.name} (PID ${proc.pid})`,
        dedupeKey: `suspicious_process:${proc.name}:${proc.pid}`,
        evidence: proc,
      });
    }

    if (this.baselineReady) {
      for (const entry of persistenceEntries) {
        if (!this.persistenceEntries.has(entry)) {
          anomalies.push({
            type: 'persistence_change',
            severity: persistenceSeverity(entry, this.platform),
            timestamp,
            description: `New persistence entry detected: ${entry}`,
            dedupeKey: `persistence_change:${entry}`,
            evidence: { entry },
          });
        }
      }

      for (const [pathKey, fingerprint] of sensitiveFingerprints.entries()) {
        const previous = this.sensitiveFingerprints.get(pathKey);
        if (previous !== undefined && previous !== fingerprint) {
          anomalies.push({
            type: 'sensitive_path_change',
            severity: sensitivePathSeverity(pathKey),
            timestamp,
            description: `Sensitive path changed: ${pathKey}`,
            dedupeKey: `sensitive_path_change:${pathKey}`,
            evidence: { path: pathKey },
          });
        }
      }

      for (const remote of networkState.externalDestinations) {
        if (!this.knownExternalDestinations.has(remote)) {
          anomalies.push({
            type: 'new_external_destination',
            severity: 'medium',
            timestamp,
            description: `New external destination observed: ${remote}`,
            dedupeKey: `new_external_destination:${remote}`,
            evidence: { remoteAddress: remote },
          });
        }
      }

      for (const port of networkState.listeningPorts) {
        if (!this.knownListeningPorts.has(port)) {
          anomalies.push({
            type: 'new_listening_port',
            severity: HIGH_RISK_PORTS.has(port) ? 'high' : 'medium',
            timestamp,
            description: `New listening port observed: ${port}`,
            dedupeKey: `new_listening_port:${port}`,
            evidence: { port },
          });
        }
      }
    }

    const alerts = this.recordAlerts(anomalies, timestamp);
    this.persistenceEntries = new Set(persistenceEntries);
    this.sensitiveFingerprints = sensitiveFingerprints;
    this.knownExternalDestinations = new Set(networkState.externalDestinations);
    this.knownListeningPorts = new Set(networkState.listeningPorts);
    this.baselineReady = true;
    this.lastUpdatedAt = timestamp;
    this.lastSnapshot = snapshot;
    this.persist().catch(() => {});

    return { timestamp, baselineReady: this.baselineReady, snapshot, alerts };
  }

  shouldBlockAction(action: { type: string; toolName: string }): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };
    const activeAlerts = this.listAlerts({ limit: 50 });
    const critical = activeAlerts.filter((alert) => alert.severity === 'critical');
    const high = activeAlerts.filter((alert) => alert.severity === 'high');
    const sensitiveActionTypes = new Set([
      'execute_command',
      'write_file',
      'http_request',
      'network_probe',
      'send_email',
      'draft_email',
      'write_calendar',
      'write_drive',
      'write_docs',
      'write_sheets',
      'mcp_tool',
    ]);

    if (critical.length > 0 && sensitiveActionTypes.has(action.type)) {
      return {
        allowed: false,
        reason: `Blocked by host monitoring: ${critical[0].description}`,
      };
    }
    if (high.length >= 2 && (action.type === 'execute_command' || action.type === 'http_request' || action.type === 'network_probe')) {
      return {
        allowed: false,
        reason: `Blocked by host monitoring: ${high.length} active high-severity host alerts require operator review.`,
      };
    }
    return { allowed: true };
  }

  private recordAlerts(
    input: Array<Omit<HostMonitorAlert, 'id' | 'acknowledged' | 'firstSeenAt' | 'lastSeenAt' | 'occurrenceCount'>>,
    now: number,
  ): HostMonitorAlert[] {
    const emitted: HostMonitorAlert[] = [];
    for (const item of input) {
      const existing = [...this.alerts.values()].find((alert) => alert.dedupeKey === item.dedupeKey);
      if (existing) {
        if ((now - existing.lastSeenAt) < this.config.dedupeWindowMs) {
          existing.lastSeenAt = now;
          existing.occurrenceCount += 1;
          continue;
        }
        existing.lastSeenAt = now;
        existing.timestamp = now;
        existing.severity = item.severity;
        existing.description = item.description;
        existing.evidence = item.evidence;
        existing.occurrenceCount += 1;
        existing.acknowledged = false;
        emitted.push(existing);
        continue;
      }

      const created: HostMonitorAlert = {
        id: randomUUID(),
        type: item.type,
        severity: item.severity,
        timestamp: item.timestamp,
        description: item.description,
        dedupeKey: item.dedupeKey,
        evidence: item.evidence,
        acknowledged: false,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
      };
      this.alerts.set(created.id, created);
      emitted.push(created);
    }
    return emitted;
  }

  private async collectProcesses(): Promise<Array<{ pid: number; name: string }>> {
    if (this.platform === 'win32') {
      const stdout = await this.runner('tasklist', ['/FO', 'CSV', '/NH'], 10_000);
      return stdout.split('\n')
        .filter((line) => line.trim())
        .map((line) => parseCsvRow(line))
        .filter((row) => row.length >= 2)
        .map((row) => ({ pid: Number.parseInt(row[1] ?? '0', 10) || 0, name: (row[0] ?? '').trim() }))
        .filter((proc) => proc.pid > 0 && proc.name);
    }
    const stdout = await this.runner('ps', ['-axo', 'pid=,comm='], 10_000);
    return stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number.parseInt(match[1], 10), name: basename(match[2].trim()) };
      })
      .filter((proc): proc is { pid: number; name: string } => proc !== null);
  }

  private async collectPersistenceEntries(): Promise<string[]> {
    if (this.platform === 'win32') {
      const entries: string[] = [];
      for (const key of WINDOWS_RUN_KEYS) {
        try {
          const stdout = await this.runner('reg', ['query', key], 8_000);
          entries.push(...parseWindowsRunKey(stdout, key));
        } catch {
          // best effort
        }
      }
      try {
        const stdout = await this.runner('schtasks', ['/Query', '/FO', 'CSV'], 12_000);
        entries.push(...parseWindowsScheduledTasks(stdout).map((task) => `schtasks:${task}`));
      } catch {
        // best effort
      }
      for (const startupDir of windowsStartupDirs(this.homeDir)) {
        entries.push(...await listDirectoryEntries(startupDir, 'startup'));
      }
      return uniqueSorted(entries);
    }

    const entries: string[] = [];
    if (this.platform === 'linux') {
      entries.push(...await listDirectoryEntries(join(this.homeDir, '.config', 'autostart'), 'autostart'));
      entries.push(...await listDirectoryEntries(join(this.homeDir, '.config', 'systemd', 'user'), 'systemd-user'));
      entries.push(...await listDirectoryEntries('/etc/systemd/system', 'systemd-system'));
    } else if (this.platform === 'darwin') {
      entries.push(...await listDirectoryEntries(join(this.homeDir, 'Library', 'LaunchAgents'), 'launchagents-user'));
      entries.push(...await listDirectoryEntries('/Library/LaunchAgents', 'launchagents-system'));
      entries.push(...await listDirectoryEntries('/Library/LaunchDaemons', 'launchdaemons-system'));
    }
    try {
      const stdout = await this.runner('crontab', ['-l'], 5_000);
      entries.push(...stdout.split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => `crontab:${line}`));
    } catch {
      // fine if no crontab
    }
    return uniqueSorted(entries);
  }

  private async collectSensitiveFingerprints(): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    for (const rawPath of this.config.sensitivePaths) {
      const expanded = expandHomePath(rawPath, this.homeDir);
      if (!expanded) continue;
      try {
        const info = await stat(expanded);
        if (info.isFile()) {
          results.set(expanded, `file:${info.size}:${Math.round(info.mtimeMs)}`);
          continue;
        }
        if (info.isDirectory()) {
          const children = await readdir(expanded, { withFileTypes: true });
          const sampleEntries = children
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 100);
          const sample = (await Promise.all(sampleEntries.map(async (entry) => {
            const childPath = join(expanded, entry.name);
            try {
              const childInfo = await stat(childPath);
              return `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}:${childInfo.size}:${Math.round(childInfo.mtimeMs)}`;
            } catch {
              return `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}:missing`;
            }
          }))).join('|');
          results.set(expanded, `dir:${children.length}:${Math.round(info.mtimeMs)}:${sample}`);
        }
      } catch {
        // ignore missing paths
      }
    }
    return results;
  }

  private async collectNetworkState(): Promise<{ externalDestinations: string[]; listeningPorts: number[] }> {
    const externalDestinations = new Set<string>();
    const listeningPorts = new Set<number>();

    if (this.platform === 'linux') {
      try {
        const stdout = await this.runner('ss', ['-tun'], 8_000);
        for (const conn of parseSsConnections(stdout)) {
          if (conn.listening) listeningPorts.add(conn.localPort);
          if (isExternalAddress(conn.remoteAddress)) externalDestinations.add(conn.remoteAddress);
        }
        return {
          externalDestinations: [...externalDestinations].sort(),
          listeningPorts: [...listeningPorts].sort((a, b) => a - b),
        };
      } catch {
        // fall back to netstat below
      }
    }

    try {
      const stdout = await this.runner('netstat', ['-an'], 8_000);
      for (const conn of parseNetstatConnections(stdout)) {
        if (conn.listening) listeningPorts.add(conn.localPort);
        if (isExternalAddress(conn.remoteAddress)) externalDestinations.add(conn.remoteAddress);
      }
    } catch {
      // ignore
    }

    return {
      externalDestinations: [...externalDestinations].sort(),
      listeningPorts: [...listeningPorts].sort((a, b) => a - b),
    };
  }

  private isSuspiciousProcess(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return this.config.suspiciousProcessNames.some((candidate) => candidate.trim().toLowerCase() === normalized);
  }

  private processSeverity(name: string): HostMonitorSeverity {
    const normalized = name.trim().toLowerCase();
    if (HIGH_RISK_WINDOWS_PROCESSES.has(normalized)) return 'high';
    if (normalized === 'osascript' || normalized === 'launchctl') return 'high';
    return 'medium';
  }
}

async function defaultRunner(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return stdout;
}

function parseCsvRow(line: string): string[] {
  const cleaned = line.trim();
  if (!cleaned) return [];
  return cleaned
    .replace(/^"/, '')
    .replace(/"$/, '')
    .split('","')
    .map((part) => part.replace(/^"|"$/g, ''));
}

function parseWindowsRunKey(stdout: string, key: string): string[] {
  return stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('HKEY_'))
    .map((line) => line.split(/\s{2,}/))
    .filter((parts) => parts.length >= 3)
    .map((parts) => `${key}:${parts[0]}=${parts.slice(2).join(' ')}`);
}

function parseWindowsScheduledTasks(stdout: string): string[] {
  return stdout.split('\n')
    .slice(1)
    .map((line) => parseCsvRow(line))
    .filter((row) => row.length > 0)
    .map((row) => row[0]?.trim())
    .filter((value): value is string => !!value);
}

async function listDirectoryEntries(dirPath: string, prefix: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .map((entry) => `${prefix}:${dirPath}:${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort();
  } catch {
    return [];
  }
}

function windowsStartupDirs(homeDir: string): string[] {
  const roaming = join(homeDir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const programData = (process.env.ProgramData ?? '').trim();
  const common = [join(programData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp')];
  return [roaming, ...common];
}

function expandHomePath(input: string, homeDir: string): string {
  return resolve(input.replace(/\{HOME}/g, homeDir).replace(/^~(?=$|[\\/])/, homeDir));
}

function parseNetstatConnections(stdout: string): Array<{ remoteAddress: string; localPort: number; listening: boolean }> {
  const results: Array<{ remoteAddress: string; localPort: number; listening: boolean }> = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!/^(tcp|udp)/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const hasQueueColumns = parts.length >= 6;
    const local = splitAddress(parts[hasQueueColumns ? 3 : 1] ?? '');
    const remote = splitAddress(parts[hasQueueColumns ? 4 : 2] ?? '');
    const state = (parts[hasQueueColumns ? 5 : 3] ?? '').toUpperCase();
    results.push({
      remoteAddress: remote.host,
      localPort: local.port,
      listening: state === 'LISTEN' || state === 'LISTENING',
    });
  }
  return results;
}

function parseSsConnections(stdout: string): Array<{ remoteAddress: string; localPort: number; listening: boolean }> {
  const results: Array<{ remoteAddress: string; localPort: number; listening: boolean }> = [];
  for (const raw of stdout.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const state = (parts[0] ?? '').toUpperCase();
    const local = splitAddress(parts[3] ?? '');
    const remote = splitAddress(parts[4] ?? '');
    results.push({
      remoteAddress: remote.host,
      localPort: local.port,
      listening: state === 'LISTEN',
    });
  }
  return results;
}

function splitAddress(raw: string): { host: string; port: number } {
  const normalized = raw.replace(/^\[([^\]]+)]:(\d+)$/, '$1:$2');
  const idx = normalized.lastIndexOf(':');
  if (idx <= 0) return { host: normalized, port: 0 };
  return {
    host: normalized.slice(0, idx).replace(/^\[|\]$/g, ''),
    port: Number.parseInt(normalized.slice(idx + 1), 10) || 0,
  };
}

function isExternalAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === '*' || normalized === '0.0.0.0' || normalized === '::') return false;
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') return false;
  if (/^10\./.test(normalized)) return false;
  if (/^192\.168\./.test(normalized)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return false;
  if (/^169\.254\./.test(normalized)) return false;
  if (/^fe80:/i.test(normalized)) return false;
  if (/^(fc|fd)/i.test(normalized)) return false;
  return true;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function persistenceSeverity(entry: string, platform: NodeJS.Platform): HostMonitorSeverity {
  if (platform === 'win32' && (entry.startsWith('schtasks:') || entry.includes('\\Run'))) return 'critical';
  if (entry.includes('LaunchDaemon') || entry.includes('systemd-system')) return 'high';
  return 'high';
}

function sensitivePathSeverity(pathKey: string): HostMonitorSeverity {
  const normalized = pathKey.toLowerCase();
  if (normalized.includes('.ssh') || normalized.includes('.aws') || normalized.includes('gcloud') || normalized.includes('.azure') || normalized.includes('.kube')) {
    return 'high';
  }
  return 'medium';
}
