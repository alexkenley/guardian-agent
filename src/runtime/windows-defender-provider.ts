import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HostMonitorSeverity } from '../config/types.js';
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

export type WindowsDefenderAlertType =
  | 'defender_threat_detected'
  | 'defender_realtime_protection_disabled'
  | 'defender_antivirus_disabled'
  | 'defender_signatures_stale'
  | 'defender_controlled_folder_access_disabled'
  | 'defender_firewall_profile_disabled'
  | 'defender_status_unavailable';

export interface WindowsDefenderAlert {
  id: string;
  type: WindowsDefenderAlertType;
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

export interface WindowsDefenderProviderStatus {
  platform: NodeJS.Platform;
  supported: boolean;
  available: boolean;
  provider: 'windows_defender';
  inactiveReason?: 'third_party_antivirus' | 'query_failed';
  thirdPartyProviders?: string[];
  lastUpdatedAt: number;
  antivirusEnabled: boolean | null;
  realtimeProtectionEnabled: boolean | null;
  behaviorMonitorEnabled: boolean | null;
  controlledFolderAccessEnabled: boolean | null;
  firewallEnabled: boolean | null;
  signatureVersion?: string;
  engineVersion?: string;
  signatureAgeHours?: number | null;
  quickScanAgeHours?: number | null;
  fullScanAgeHours?: number | null;
  activeAlertCount: number;
  bySeverity: Record<HostMonitorSeverity, number>;
  summary: string;
}

interface PersistedState {
  status: WindowsDefenderProviderStatus;
  alerts: WindowsDefenderAlert[];
}

type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<string>;

const DEFAULT_PERSIST_PATH = resolve(getGuardianBaseDir(), 'windows-defender-provider.json');

export interface WindowsDefenderProviderOptions {
  persistPath?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
}

export class WindowsDefenderProvider {
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly runner: CommandRunner;
  private readonly alerts = new Map<string, WindowsDefenderAlert>();
  private status: WindowsDefenderProviderStatus;

  constructor(options?: WindowsDefenderProviderOptions) {
    this.persistPath = options?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.now = options?.now ?? Date.now;
    this.platform = options?.platform ?? process.platform;
    this.runner = options?.runner ?? defaultRunner;
    this.status = createDefaultStatus(this.platform);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as PersistedState;
      this.status = data.status ?? createDefaultStatus(this.platform);
      this.alerts.clear();
      for (const alert of data.alerts ?? []) {
        this.alerts.set(alert.id, ensureSecurityAlertLifecycle(alert));
      }
    } catch {
      // first run
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedState = {
      status: this.getStatus(),
      alerts: [...this.alerts.values()],
    };
    await writeSecureFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  getStatus(): WindowsDefenderProviderStatus {
    const alerts = this.listAlerts();
    return {
      ...this.status,
      activeAlertCount: alerts.length,
      bySeverity: {
        low: alerts.filter((alert) => alert.severity === 'low').length,
        medium: alerts.filter((alert) => alert.severity === 'medium').length,
        high: alerts.filter((alert) => alert.severity === 'high').length,
        critical: alerts.filter((alert) => alert.severity === 'critical').length,
      },
    };
  }

  listAlerts(opts?: SecurityAlertListOptions): WindowsDefenderAlert[] {
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

  async refreshStatus(): Promise<WindowsDefenderProviderStatus> {
    const timestamp = this.now();
    if (this.platform !== 'win32') {
      this.status = {
        ...createDefaultStatus(this.platform),
        lastUpdatedAt: timestamp,
        summary: 'Windows Defender is only available on Windows hosts.',
      };
      await this.persist().catch(() => {});
      return this.getStatus();
    }

    try {
      const [statusRaw, preferenceRaw, firewallRaw, detectionsRaw] = await Promise.all([
        this.runPowerShell('Get-MpComputerStatus | ConvertTo-Json -Compress'),
        this.runPowerShell('Get-MpPreference | Select-Object EnableControlledFolderAccess | ConvertTo-Json -Compress'),
        this.runPowerShell('Get-NetFirewallProfile | Select-Object Name,Enabled | ConvertTo-Json -Compress'),
        this.runPowerShell('Get-MpThreatDetection | Select-Object InitialDetectionTime,ThreatName,Resources,ActionSuccess,SeverityID,ThreatID | ConvertTo-Json -Compress').catch(() => ''),
      ]);

      const status = parseJsonRecord(statusRaw);
      const preference = parseJsonRecord(preferenceRaw);
      const firewallProfiles = parseJsonArray(firewallRaw);
      const detections = parseJsonArray(detectionsRaw);

      const signatureAgeHours = coerceNumber(status.AntivirusSignatureAge);
      const quickScanAgeHours = coerceNumber(status.QuickScanAge);
      const fullScanAgeHours = coerceNumber(status.FullScanAge);
      const controlledFolderAccessEnabled = normalizeControlledFolderAccess(preference.EnableControlledFolderAccess);
      const firewallEnabled = firewallProfiles.length > 0
        ? firewallProfiles.every((profile) => profile.Enabled === true)
        : null;

      const alertInputs: Array<Omit<
        WindowsDefenderAlert,
        'id'
        | 'firstSeenAt'
        | 'lastSeenAt'
        | 'occurrenceCount'
        | 'acknowledged'
        | 'status'
        | 'lastStateChangedAt'
        | 'suppressedUntil'
        | 'suppressionReason'
        | 'resolvedAt'
        | 'resolutionReason'
      >> = [];

      if (status.RealTimeProtectionEnabled === false) {
        alertInputs.push({
          type: 'defender_realtime_protection_disabled',
          severity: 'high',
          timestamp,
          description: 'Windows Defender real-time protection is disabled.',
          dedupeKey: 'defender_realtime_protection_disabled',
          evidence: {},
        });
      }
      if (status.AntivirusEnabled === false) {
        alertInputs.push({
          type: 'defender_antivirus_disabled',
          severity: 'critical',
          timestamp,
          description: 'Windows Defender antivirus engine is disabled.',
          dedupeKey: 'defender_antivirus_disabled',
          evidence: {},
        });
      }
      if (typeof signatureAgeHours === 'number' && signatureAgeHours >= 72) {
        alertInputs.push({
          type: 'defender_signatures_stale',
          severity: signatureAgeHours >= 168 ? 'high' : 'medium',
          timestamp,
          description: `Windows Defender signatures are ${Math.round(signatureAgeHours)} hours old.`,
          dedupeKey: `defender_signatures_stale:${Math.round(signatureAgeHours / 24)}`,
          evidence: { signatureAgeHours },
        });
      }
      if (controlledFolderAccessEnabled === false) {
        alertInputs.push({
          type: 'defender_controlled_folder_access_disabled',
          severity: 'medium',
          timestamp,
          description: 'Controlled Folder Access is disabled.',
          dedupeKey: 'defender_controlled_folder_access_disabled',
          evidence: {},
        });
      }
      for (const profile of firewallProfiles.filter((item) => item.Name && item.Enabled === false)) {
        alertInputs.push({
          type: 'defender_firewall_profile_disabled',
          severity: 'high',
          timestamp,
          description: `Windows firewall profile '${String(profile.Name)}' is disabled.`,
          dedupeKey: `defender_firewall_profile_disabled:${String(profile.Name).toLowerCase()}`,
          evidence: { profile: profile.Name },
        });
      }
      for (const detection of detections) {
        const threatName = asString(detection.ThreatName).trim() || 'Unknown threat';
        const resources = Array.isArray(detection.Resources) ? detection.Resources : [];
        const threatId = asString(detection.ThreatID).trim() || hashText(JSON.stringify(detection));
        const severity = mapDefenderSeverity(coerceNumber(detection.SeverityID));
        alertInputs.push({
          type: 'defender_threat_detected',
          severity,
          timestamp: parseDefenderTime(detection.InitialDetectionTime) ?? timestamp,
          description: `Windows Defender detected '${threatName}'.`,
          dedupeKey: `defender_threat_detected:${threatId}:${hashText(JSON.stringify(resources))}`,
          evidence: {
            threatName,
            threatId,
            severityId: coerceNumber(detection.SeverityID),
            resources,
            actionSuccess: detection.ActionSuccess,
          },
        });
      }

      this.recordAlerts(alertInputs, timestamp);
      this.status = {
        platform: this.platform,
        supported: true,
        available: true,
        provider: 'windows_defender',
        lastUpdatedAt: timestamp,
        antivirusEnabled: normalizeNullableBoolean(status.AntivirusEnabled),
        realtimeProtectionEnabled: normalizeNullableBoolean(status.RealTimeProtectionEnabled),
        behaviorMonitorEnabled: normalizeNullableBoolean(status.BehaviorMonitorEnabled),
        controlledFolderAccessEnabled,
        firewallEnabled,
        signatureVersion: asString(status.AntivirusSignatureVersion).trim() || undefined,
        engineVersion: asString(status.AMEngineVersion).trim() || undefined,
        signatureAgeHours,
        quickScanAgeHours,
        fullScanAgeHours,
        activeAlertCount: 0,
        bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
        summary: buildSummary({
          realtimeProtectionEnabled: normalizeNullableBoolean(status.RealTimeProtectionEnabled),
          antivirusEnabled: normalizeNullableBoolean(status.AntivirusEnabled),
          firewallEnabled,
          controlledFolderAccessEnabled,
          detectionCount: detections.length,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const thirdPartyProviders = isDefenderServiceDisabledError(message)
        ? await this.listThirdPartyAntivirusProviders().catch(() => [])
        : [];

      if (thirdPartyProviders.length > 0) {
        this.resolveInactiveProviderAlerts(timestamp);
        this.status = {
          ...createDefaultStatus(this.platform),
          supported: true,
          available: false,
          inactiveReason: 'third_party_antivirus',
          thirdPartyProviders,
          lastUpdatedAt: timestamp,
          antivirusEnabled: false,
          realtimeProtectionEnabled: false,
          behaviorMonitorEnabled: false,
          summary: `Windows Defender is inactive because another antivirus is registered: ${thirdPartyProviders.join(', ')}.`,
        };
        await this.persist().catch(() => {});
        return this.getStatus();
      }

      this.recordAlerts([{
        type: 'defender_status_unavailable',
        severity: 'medium',
        timestamp,
        description: `Windows Defender status query failed: ${message}`,
        dedupeKey: `defender_status_unavailable:${hashText(message)}`,
        evidence: { error: message },
      }], timestamp);
      this.status = {
        ...createDefaultStatus(this.platform),
        supported: true,
        available: false,
        inactiveReason: 'query_failed',
        lastUpdatedAt: timestamp,
        summary: `Windows Defender status query failed: ${message}`,
      };
    }

    await this.persist().catch(() => {});
    return this.getStatus();
  }

  async runScan(input: { type: 'quick' | 'full' | 'custom'; path?: string }): Promise<{ success: boolean; message: string }> {
    if (this.platform !== 'win32') {
      return { success: false, message: 'Windows Defender scans are only available on Windows hosts.' };
    }
    const command = input.type === 'quick'
      ? `$ProgressPreference = 'SilentlyContinue'; Start-MpScan -ScanType QuickScan`
      : input.type === 'full'
        ? `$ProgressPreference = 'SilentlyContinue'; Start-MpScan -ScanType FullScan`
        : `$ProgressPreference = 'SilentlyContinue'; Start-MpScan -ScanType CustomScan -ScanPath ${escapePowerShellString(input.path ?? '')}`;
    await this.runPowerShell(command);
    return { success: true, message: `Windows Defender ${input.type} scan requested.` };
  }

  async updateSignatures(): Promise<{ success: boolean; message: string }> {
    if (this.platform !== 'win32') {
      return { success: false, message: 'Windows Defender signature updates are only available on Windows hosts.' };
    }
    await this.runPowerShell(`$ProgressPreference = 'SilentlyContinue'; Update-MpSignature`);
    return { success: true, message: 'Windows Defender signature update requested.' };
  }

  private async runPowerShell(script: string): Promise<string> {
    return await this.runner('powershell.exe', ['-NoProfile', '-Command', script], 20_000);
  }

  private async listThirdPartyAntivirusProviders(): Promise<string[]> {
    if (this.platform !== 'win32') return [];
    const raw = await this.runPowerShell(
      'Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct '
      + '| Select-Object displayName '
      + '| ConvertTo-Json -Compress',
    );
    const providers = parseJsonArray(raw)
      .map((item) => asString(item.displayName).trim())
      .filter(Boolean)
      .filter((name, index, values) => values.indexOf(name) === index);
    return providers.filter((name) => !isMicrosoftAntivirusProvider(name));
  }

  private resolveInactiveProviderAlerts(now: number): void {
    for (const alert of this.alerts.values()) {
      if (!INACTIVE_PROVIDER_ALERT_TYPES.has(alert.type)) continue;
      resolveSecurityAlert(
        alert,
        now,
        'Windows Defender is inactive because a third-party antivirus provider is registered.',
      );
    }
  }

  private recordAlerts(
    input: Array<Omit<
      WindowsDefenderAlert,
      'id'
      | 'firstSeenAt'
      | 'lastSeenAt'
      | 'occurrenceCount'
      | 'acknowledged'
      | 'status'
      | 'lastStateChangedAt'
      | 'suppressedUntil'
      | 'suppressionReason'
      | 'resolvedAt'
      | 'resolutionReason'
    >>,
    now: number,
  ): WindowsDefenderAlert[] {
    const emitted: WindowsDefenderAlert[] = [];
    for (const item of input) {
      const existing = [...this.alerts.values()].find((alert) => alert.dedupeKey === item.dedupeKey);
      if (existing) {
        ensureSecurityAlertLifecycle(existing);
        existing.lastSeenAt = now;
        existing.occurrenceCount += 1;
        existing.timestamp = item.timestamp;
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
        reactivateSecurityAlert(existing, now);
        emitted.push(existing);
        continue;
      }
      const created: WindowsDefenderAlert = {
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

async function defaultRunner(command: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFile(command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

function createDefaultStatus(platform: NodeJS.Platform): WindowsDefenderProviderStatus {
  return {
    platform,
    supported: platform === 'win32',
    available: false,
    provider: 'windows_defender',
    lastUpdatedAt: 0,
    antivirusEnabled: null,
    realtimeProtectionEnabled: null,
    behaviorMonitorEnabled: null,
    controlledFolderAccessEnabled: null,
    firewallEnabled: null,
    activeAlertCount: 0,
    bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    summary: platform === 'win32'
      ? 'Windows Defender status has not been queried yet.'
      : 'Windows Defender is only available on Windows hosts.',
  };
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  if (parsed && typeof parsed === 'object') {
    return [parsed as Record<string, unknown>];
  }
  return [];
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeControlledFolderAccess(value: unknown): boolean | null {
  const numeric = coerceNumber(value);
  if (numeric === 1) return true;
  if (numeric === 0) return false;
  return null;
}

function coerceNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseDefenderTime(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const raw = asString(value).trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapDefenderSeverity(severityId: number | null): HostMonitorSeverity {
  if (severityId === null) return 'medium';
  if (severityId >= 5) return 'critical';
  if (severityId >= 4) return 'high';
  if (severityId >= 2) return 'medium';
  return 'low';
}

function buildSummary(input: {
  realtimeProtectionEnabled: boolean | null;
  antivirusEnabled: boolean | null;
  firewallEnabled: boolean | null;
  controlledFolderAccessEnabled: boolean | null;
  detectionCount: number;
}): string {
  const parts = [
    `AV ${formatEnabled(input.antivirusEnabled)}`,
    `real-time ${formatEnabled(input.realtimeProtectionEnabled)}`,
    `firewall ${formatEnabled(input.firewallEnabled)}`,
    `CFA ${formatEnabled(input.controlledFolderAccessEnabled)}`,
    `${input.detectionCount} detection${input.detectionCount === 1 ? '' : 's'}`,
  ];
  return parts.join(' • ');
}

function formatEnabled(value: boolean | null): string {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'unknown';
}

const INACTIVE_PROVIDER_ALERT_TYPES = new Set<WindowsDefenderAlertType>([
  'defender_status_unavailable',
  'defender_antivirus_disabled',
  'defender_realtime_protection_disabled',
  'defender_signatures_stale',
  'defender_controlled_folder_access_disabled',
]);

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isDefenderServiceDisabledError(message: string): boolean {
  return /\b0x800106ba\b/i.test(message) || /800106BA/.test(message);
}

function isMicrosoftAntivirusProvider(name: string): boolean {
  return /\b(microsoft|windows)\s+defender\b/i.test(name);
}

function escapePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
