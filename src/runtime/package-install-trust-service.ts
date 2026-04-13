import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, win32 as winPath } from 'node:path';
import { writeSecureFile } from '../util/secure-fs.js';
import {
  acknowledgeSecurityAlert,
  ensureSecurityAlertLifecycle,
  listSecurityAlerts,
  reactivateSecurityAlert,
  resolveSecurityAlert,
  suppressSecurityAlert,
  type SecurityAlertLifecycle,
  type SecurityAlertListOptions,
  type SecurityAlertStateResult,
} from './security-alert-lifecycle.js';
import { PackageInstallNativeProtectionScanner } from './package-install-native-protection.js';
import { getGuardianBaseDir } from '../util/env.js';
import {
  buildManagedPackageInstallInvocation,
  buildManagedPackageStageInvocation,
  buildPackageInstallAssessment,
  formatPackageInstallTarget,
  inspectPackageInstallArtifact,
  parseManagedPackageInstallCommand,
  type ManagedPackageInstallPlan,
  type PackageInstallAssessment,
  type PackageInstallFinding,
  type PackageInstallInspectedArtifact,
  type PackageInstallNativeProtection,
  type PackageInstallTarget,
  type PackageInstallTrustReview,
  type PackageInstallTrustState,
} from './package-install-trust.js';

export interface PackageInstallCommandRunnerInput {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface PackageInstallCommandRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
}

export type PackageInstallCommandRunner = (
  input: PackageInstallCommandRunnerInput,
) => Promise<PackageInstallCommandRunnerResult>;

export interface PackageInstallSpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
}

interface PackageInstallSpawnPlanOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  pathExists?: (candidate: string) => Promise<boolean>;
}

export interface PackageInstallTrustAlert extends SecurityAlertLifecycle {
  id: string;
  type: 'package_install_blocked' | 'package_install_caution';
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: number;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  description: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
  subject: string;
}

export interface PackageInstallTrustEvent {
  id: string;
  createdAt: number;
  command: string;
  cwd?: string;
  ecosystem: ManagedPackageInstallPlan['ecosystem'];
  manager: ManagedPackageInstallPlan['manager'];
  packageSpecs: string[];
  installTarget: PackageInstallTarget;
  targetSummary: string;
  state: PackageInstallTrustState;
  summary: string;
  findings: PackageInstallFinding[];
  artifacts: PackageInstallInspectedArtifact[];
  limitations: string[];
  nativeProtection?: PackageInstallNativeProtection | null;
  review?: PackageInstallTrustReview;
  allowCaution: boolean;
  staged: boolean;
  installed: boolean;
  quarantineDir: string;
  stageCommand: string;
  installCommand?: string;
  installExitCode?: number | null;
  installStdout?: string;
  installStderr?: string;
  alertId?: string;
  assessmentFingerprint: string;
}

export interface PackageInstallManagedRunResult {
  success: boolean;
  status: 'installed' | 'blocked' | 'requires_review' | 'failed';
  message: string;
  event?: PackageInstallTrustEvent;
  alertId?: string;
}

interface PersistedPackageInstallTrustState {
  events?: PackageInstallTrustEvent[];
  alerts?: PackageInstallTrustAlert[];
}

export interface PackageInstallTrustServiceOptions {
  persistPath?: string;
  quarantineRoot?: string;
  now?: () => number;
  runner?: PackageInstallCommandRunner;
  nativeProtectionScanner?: PackageInstallNativeProtectionScanner;
  maxEvents?: number;
  maxAlerts?: number;
}

const DEFAULT_PERSIST_PATH = resolve(getGuardianBaseDir(), 'package-install-trust.json');
const DEFAULT_QUARANTINE_ROOT = resolve(getGuardianBaseDir(), 'package-quarantine');
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_MAX_ALERTS = 100;

export class PackageInstallTrustService {
  private readonly persistPath: string;
  private readonly quarantineRoot: string;
  private readonly now: () => number;
  private readonly runner: PackageInstallCommandRunner;
  private readonly nativeProtectionScanner?: PackageInstallNativeProtectionScanner;
  private readonly maxEvents: number;
  private readonly maxAlerts: number;
  private readonly alerts = new Map<string, PackageInstallTrustAlert>();
  private events: PackageInstallTrustEvent[] = [];

  constructor(options?: PackageInstallTrustServiceOptions) {
    this.persistPath = options?.persistPath ?? DEFAULT_PERSIST_PATH;
    this.quarantineRoot = options?.quarantineRoot ?? DEFAULT_QUARANTINE_ROOT;
    this.now = options?.now ?? Date.now;
    this.runner = options?.runner ?? defaultCommandRunner;
    this.nativeProtectionScanner = options?.nativeProtectionScanner;
    this.maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxAlerts = options?.maxAlerts ?? DEFAULT_MAX_ALERTS;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as PersistedPackageInstallTrustState;
      this.events = Array.isArray(data.events)
        ? data.events
          .filter((event): event is PackageInstallTrustEvent => !!event && typeof event === 'object')
          .slice(0, this.maxEvents)
        : [];
      this.alerts.clear();
      for (const alert of data.alerts ?? []) {
        this.alerts.set(alert.id, ensureSecurityAlertLifecycle(alert));
      }
    } catch {
      this.events = [];
      this.alerts.clear();
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedPackageInstallTrustState = {
      events: this.events.slice(0, this.maxEvents),
      alerts: [...this.alerts.values()].slice(0, this.maxAlerts),
    };
    await writeSecureFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  listEvents(limit = 20): PackageInstallTrustEvent[] {
    return this.events.slice(0, Math.max(1, Math.min(limit, this.maxEvents)));
  }

  listAlerts(opts?: SecurityAlertListOptions): PackageInstallTrustAlert[] {
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
    return {
      success: true,
      message: `Alert '${alertId}' suppressed until ${new Date(until).toISOString()}.`,
    };
  }

  async runManagedInstall(input: {
    command: string;
    cwd?: string;
    allowCaution?: boolean;
  }): Promise<PackageInstallManagedRunResult> {
    const planned = parseManagedPackageInstallCommand(input.command);
    if (!planned.success || !planned.plan) {
      return {
        success: false,
        status: 'failed',
        message: planned.error ?? 'Managed package install planning failed.',
      };
    }

    const plan = planned.plan;
    const createdAt = this.now();
    const eventId = randomUUID();
    const eventDir = join(this.quarantineRoot, eventId);
    const downloadDir = join(eventDir, 'downloads');
    const stageInvocation = buildManagedPackageStageInvocation(plan, downloadDir);

    const stagedFiles = await this.stageArtifacts(stageInvocation, downloadDir, input.cwd);
    if (!stagedFiles.success) {
      return {
        success: false,
        status: 'failed',
        message: stagedFiles.message,
      };
    }

    const inspectedArtifacts = await Promise.all(
      stagedFiles.files.map((filePath) => inspectPackageInstallArtifact(filePath, plan)),
    );
    const nativeProtection = this.nativeProtectionScanner
      ? await this.nativeProtectionScanner.scanPath(downloadDir).catch((error) => ({
        provider: 'native_av',
        status: 'error',
        summary: `Native AV scan failed: ${error instanceof Error ? error.message : String(error)}`,
        observedAt: this.now(),
      } satisfies PackageInstallNativeProtection))
      : null;
    const assessment = buildPackageInstallAssessment({
      plan,
      artifacts: inspectedArtifacts,
      nativeProtection,
    });

    const event = this.createEvent({
      id: eventId,
      createdAt,
      command: input.command.trim(),
      cwd: input.cwd?.trim() || undefined,
      plan,
      assessment,
      nativeProtection,
      allowCaution: input.allowCaution === true,
      quarantineDir: eventDir,
      stageCommand: stageInvocation.display,
    });

    if (assessment.state === 'blocked') {
      event.alertId = this.upsertAlertFromEvent(event, false);
      this.recordEvent(event);
      await this.persist();
      return {
        success: false,
        status: 'blocked',
        message: `${assessment.summary} Review security alerts for details.`,
        event,
        alertId: event.alertId,
      };
    }

    if (assessment.state === 'caution' && !event.allowCaution) {
      event.alertId = this.upsertAlertFromEvent(event, false);
      this.recordEvent(event);
      await this.persist();
      return {
        success: false,
        status: 'requires_review',
        message: `${assessment.summary} Re-run with allowCaution to proceed with this managed install.`,
        event,
        alertId: event.alertId,
      };
    }

    if (assessment.state === 'caution') {
      event.review = {
        acceptedAt: this.now(),
        actor: 'operator',
        reason: 'allowCaution was set for this managed package install.',
      };
      event.alertId = this.upsertAlertFromEvent(event, true);
    }

    const installInvocation = buildManagedPackageInstallInvocation(plan, stagedFiles.files);
    const installResult = await this.runner({
      command: installInvocation.command,
      args: installInvocation.args,
      cwd: input.cwd?.trim() || undefined,
      timeoutMs: 10 * 60_000,
    });
    event.installCommand = installInvocation.display;
    event.installExitCode = installResult.exitCode;
    event.installStdout = truncateOutput(installResult.stdout);
    event.installStderr = truncateOutput(installResult.stderr || installResult.errorMessage || '');
    event.installed = installResult.exitCode === 0;

    this.recordEvent(event);
    await this.persist();

    if (installResult.exitCode !== 0) {
      return {
        success: false,
        status: 'failed',
        message: buildInstallFailureMessage(installResult),
        event,
        alertId: event.alertId,
      };
    }

    return {
      success: true,
      status: 'installed',
      message: event.state === 'caution'
        ? `Managed install completed after caution acceptance: ${event.summary}`
        : 'Managed install completed after staged package review.',
      event,
      alertId: event.alertId,
    };
  }

  private createEvent(input: {
    id: string;
    createdAt: number;
    command: string;
    cwd?: string;
    plan: ManagedPackageInstallPlan;
    assessment: PackageInstallAssessment;
    nativeProtection?: PackageInstallNativeProtection | null;
    allowCaution: boolean;
    quarantineDir: string;
    stageCommand: string;
  }): PackageInstallTrustEvent {
    return {
      id: input.id,
      createdAt: input.createdAt,
      command: input.command,
      cwd: input.cwd,
      ecosystem: input.plan.ecosystem,
      manager: input.plan.manager,
      packageSpecs: [...input.plan.packageSpecs],
      installTarget: { ...input.plan.installTarget },
      targetSummary: formatPackageInstallTarget(input.plan.installTarget, input.cwd),
      state: input.assessment.state,
      summary: input.assessment.summary,
      findings: input.assessment.findings,
      artifacts: input.assessment.artifacts,
      limitations: input.assessment.limitations,
      nativeProtection: input.nativeProtection ?? null,
      allowCaution: input.allowCaution,
      staged: true,
      installed: false,
      quarantineDir: input.quarantineDir,
      stageCommand: input.stageCommand,
      assessmentFingerprint: input.assessment.fingerprint,
    };
  }

  private async stageArtifacts(
    invocation: { command: string; args: string[]; display: string },
    downloadDir: string,
    cwd?: string,
  ): Promise<{ success: boolean; message: string; files: string[] }> {
    await mkdir(downloadDir, { recursive: true });
    const stageResult = await this.runner({
      command: invocation.command,
      args: invocation.args,
      cwd,
      timeoutMs: 5 * 60_000,
    });
    if (stageResult.exitCode !== 0) {
      return {
        success: false,
        message: `Failed to stage package artifacts for review. ${buildInstallFailureMessage(stageResult)}`,
        files: [],
      };
    }

    const entries = await readdir(downloadDir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(downloadDir, entry.name))
      .filter((filePath) => isSupportedStagedArtifact(filePath));
    if (files.length === 0) {
      const fallbackFiles = entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(downloadDir, entry.name));
      if (fallbackFiles.length === 0) {
        return {
          success: false,
          message: 'The staging command completed but no package artifacts were downloaded for review.',
          files: [],
        };
      }
      return {
        success: true,
        message: 'Staging succeeded.',
        files: fallbackFiles,
      };
    }

    return {
      success: true,
      message: 'Staging succeeded.',
      files,
    };
  }

  private recordEvent(event: PackageInstallTrustEvent): void {
    this.events = [event, ...this.events.filter((candidate) => candidate.id !== event.id)].slice(0, this.maxEvents);
  }

  private upsertAlertFromEvent(event: PackageInstallTrustEvent, acknowledgeOnCreate: boolean): string {
    const type = event.state === 'blocked' ? 'package_install_blocked' : 'package_install_caution';
    const dedupeKey = `package_install:${type}:${event.assessmentFingerprint}:${event.packageSpecs.join(',')}:${event.targetSummary}`;
    const alertId = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24);
    const severity = inferAlertSeverity(event);
    const subject = event.packageSpecs.join(', ') || event.command;
    const description = event.summary;
    const evidence = {
      eventId: event.id,
      command: event.command,
      cwd: event.cwd,
      state: event.state,
      target: event.targetSummary,
      packageSpecs: event.packageSpecs,
      findings: event.findings.slice(0, 10),
      nativeProtection: event.nativeProtection ?? undefined,
      reviewAccepted: !!event.review,
      quarantineDir: event.quarantineDir,
    } satisfies Record<string, unknown>;
    const now = this.now();

    const existing = this.alerts.get(alertId);
    if (existing) {
      existing.type = type;
      existing.severity = severity;
      existing.timestamp = event.createdAt;
      existing.lastSeenAt = now;
      existing.occurrenceCount += 1;
      existing.description = description;
      existing.evidence = evidence;
      existing.subject = subject;
      if (acknowledgeOnCreate) {
        acknowledgeSecurityAlert(existing, now);
      } else if (existing.status !== 'active') {
        reactivateSecurityAlert(existing, now);
      }
      return alertId;
    }

    const alert = ensureSecurityAlertLifecycle({
      id: alertId,
      type,
      severity,
      timestamp: event.createdAt,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      description,
      dedupeKey,
      evidence,
      subject,
      acknowledged: false,
      status: 'active',
      lastStateChangedAt: now,
    } satisfies PackageInstallTrustAlert);

    if (acknowledgeOnCreate) {
      acknowledgeSecurityAlert(alert, now);
    }

    this.alerts.set(alert.id, alert);
    trimAlertMap(this.alerts, this.maxAlerts);
    return alert.id;
  }
}

function inferAlertSeverity(event: PackageInstallTrustEvent): PackageInstallTrustAlert['severity'] {
  if (event.nativeProtection?.status === 'detected') {
    return 'critical';
  }
  if (event.state === 'blocked') {
    return 'high';
  }
  if (event.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical')) {
    return 'high';
  }
  if (event.findings.some((finding) => finding.severity === 'medium')) {
    return 'medium';
  }
  return 'low';
}

function buildInstallFailureMessage(result: PackageInstallCommandRunnerResult): string {
  const detail = [
    result.errorMessage,
    result.stderr?.trim(),
    result.stdout?.trim(),
    typeof result.exitCode === 'number' ? `exit code ${result.exitCode}` : '',
  ].filter(Boolean)[0];
  return detail ? `Install command failed: ${detail}` : 'Install command failed.';
}

function truncateOutput(value: string, maxChars = 8_000): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n...[truncated]` : normalized;
}

function trimAlertMap(alerts: Map<string, PackageInstallTrustAlert>, maxAlerts: number): void {
  const ordered = [...alerts.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  for (const alert of ordered.slice(maxAlerts)) {
    alerts.delete(alert.id);
  }
}

function isSupportedStagedArtifact(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.tgz')
    || lower.endsWith('.tar.gz')
    || lower.endsWith('.tar')
    || lower.endsWith('.whl')
    || lower.endsWith('.zip');
}

export async function buildPackageInstallSpawnPlan(
  input: PackageInstallCommandRunnerInput,
  options?: PackageInstallSpawnPlanOptions,
): Promise<PackageInstallSpawnPlan> {
  const resolvedCommand = await resolvePackageInstallExecutable(input.command, input.env, input.cwd, options);
  return {
    command: resolvedCommand,
    args: [...input.args],
    shell: shouldUseWindowsShellForCommand(resolvedCommand, options?.platform),
  };
}

async function defaultCommandRunner(input: PackageInstallCommandRunnerInput): Promise<PackageInstallCommandRunnerResult> {
  const spawnPlan = await buildPackageInstallSpawnPlan(input);
  return await new Promise((resolveResult) => {
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: input.cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: spawnPlan.shell,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Math.max(1_000, input.timeoutMs ?? 300_000);
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        stdout,
        stderr,
        exitCode: null,
        errorCode: (error as NodeJS.ErrnoException).code,
        errorMessage: error.message,
      });
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}

async function resolvePackageInstallExecutable(
  command: string,
  env?: Record<string, string>,
  cwd?: string,
  options?: PackageInstallSpawnPlanOptions,
): Promise<string> {
  const trimmed = command.trim();
  if (!trimmed) return command;
  const platform = options?.platform ?? process.platform;
  if (platform !== 'win32') return trimmed;

  const pathExists = options?.pathExists ?? defaultPathExists;
  const searchDirs = getExecutableSearchDirectories(platform, env, options?.execPath ?? process.execPath);
  const pathLike = looksLikePathToken(trimmed);
  const candidates = pathLike
    ? buildPathLikeWindowsCandidates(trimmed, cwd, env)
    : buildCommandNameWindowsCandidates(trimmed, env);

  if (pathLike) {
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
    return trimmed;
  }

  for (const dir of searchDirs) {
    for (const candidateName of candidates) {
      const candidate = winPath.resolve(dir, candidateName);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return trimmed;
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function shouldUseWindowsShellForCommand(command: string, platform?: NodeJS.Platform): boolean {
  const effectivePlatform = platform ?? process.platform;
  return effectivePlatform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function getExecutableSearchDirectories(
  platform: NodeJS.Platform,
  env?: Record<string, string>,
  execPath?: string,
): string[] {
  const values = new Set<string>();
  const pathValue = env?.PATH ?? env?.Path ?? env?.path ?? process.env.PATH ?? process.env.Path ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  for (const entry of pathValue.split(pathDelimiter).map((value) => value.trim()).filter(Boolean)) {
    values.add(entry);
  }
  const execDir = execPath
    ? (platform === 'win32' ? winPath.dirname(execPath) : dirname(execPath))
    : '';
  if (execDir) {
    values.add(execDir);
  }
  return [...values];
}

function getWindowsPathExtensions(env?: Record<string, string>): string[] {
  const raw = env?.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const values = raw
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  return values.length > 0 ? values : ['.com', '.exe', '.bat', '.cmd'];
}

function buildPathLikeWindowsCandidates(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
): string[] {
  const normalized = winPath.isAbsolute(command)
    ? winPath.resolve(command)
    : winPath.resolve(cwd ?? process.cwd(), command);
  const values = new Set<string>([normalized]);
  if (!/\.[^\\/]+$/.test(normalized)) {
    for (const ext of getWindowsPathExtensions(env)) {
      values.add(`${normalized}${ext}`);
    }
  }
  return [...values];
}

function buildCommandNameWindowsCandidates(command: string, env?: Record<string, string>): string[] {
  const hasExtension = /\.[^\\/]+$/.test(command);
  const windowsExts = getWindowsPathExtensions(env);
  const values = new Set<string>();
  const fallbackNames = WINDOWS_COMMAND_FALLBACKS[command.trim().toLowerCase()] ?? [];
  for (const name of [command, ...fallbackNames]) {
    if (!name) continue;
    if (/\.[^\\/]+$/.test(name)) {
      values.add(name);
      continue;
    }
    if (hasExtension) {
      values.add(name);
      continue;
    }
    for (const ext of windowsExts) {
      values.add(`${name}${ext}`);
    }
  }
  return [...values];
}

function looksLikePathToken(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('.\\')
    || value.startsWith('./')
    || value.startsWith('..\\')
    || value.startsWith('../')
    || value.startsWith('\\')
    || value.startsWith('/');
}

const WINDOWS_COMMAND_FALLBACKS: Record<string, string[]> = {
  npm: ['npm.cmd', 'npm.exe', 'npm.bat'],
  pnpm: ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat'],
  yarn: ['yarn.cmd', 'yarn.exe', 'yarn.bat'],
  bun: ['bun.exe', 'bun.cmd'],
  pip: ['pip.exe', 'pip3.exe'],
  pip3: ['pip3.exe', 'pip.exe'],
  python: ['python.exe', 'py.exe'],
  python3: ['python3.exe', 'python.exe', 'py.exe'],
  py: ['py.exe'],
};
