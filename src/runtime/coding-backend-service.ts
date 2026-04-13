import type { CodingBackendConfig, CodingBackendsConfig } from '../config/types.js';
import type { CodingBackendTerminalControl } from '../channels/web-types.js';
import { CODING_BACKEND_PRESETS } from './coding-backend-presets.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('coding-backend');

/** Structured result from a coding backend run. */
export interface CodingBackendRunResult {
  success: boolean;
  backendId: string;
  backendName: string;
  task: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  exitCode?: number;
  durationMs: number;
  /** Cleaned output with ANSI codes stripped, truncated. */
  output: string;
  terminalTabId: string;
}

/** Active or completed backend session. */
export interface CodingBackendSession {
  id: string;
  backendId: string;
  backendName: string;
  codeSessionId: string;
  terminalId: string;
  task: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out';
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  durationMs?: number;
}

export interface CodingBackendServiceOptions {
  config: CodingBackendsConfig;
  terminalControl: CodingBackendTerminalControl;
}

export type CodingBackendProgressKind =
  | 'started'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'timed_out';

export interface CodingBackendProgressEvent {
  id: string;
  kind: CodingBackendProgressKind;
  runId: string;
  requestId?: string;
  codeSessionId: string;
  sessionId: string;
  terminalId: string;
  backendId: string;
  backendName: string;
  task: string;
  timestamp: number;
  detail?: string;
  exitCode?: number;
}

export type CodingBackendProgressListener = (event: CodingBackendProgressEvent) => void;

const MAX_OUTPUT_BYTES = 1_048_576; // 1MB
const MAX_TOOL_OUTPUT_CHARS = 8000;
const MAX_PROGRESS_DETAIL_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 min
const OUTPUT_PROGRESS_THROTTLE_MS = 1_200;

/** Strip ANSI escape codes from terminal output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[@-~]/g, '');
}

/** Shell-quote a string for POSIX shells. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Build the full CLI command from config and task. */
function buildCommand(backend: CodingBackendConfig, task: string, cwd: string): string {
  const quotedTask = shellQuote(task);
  const args = backend.args.map((arg) =>
    arg.replace(/\{\{task\}\}/g, quotedTask).replace(/\{\{cwd\}\}/g, shellQuote(cwd)),
  );
  // If args already contain the quoted task (from template), join directly.
  // Otherwise the task was interpolated into the args already.
  return [backend.command, ...args].join(' ');
}

/** Build the shell input written into the terminal PTY. */
function buildTerminalInput(backend: CodingBackendConfig, command: string): string {
  if (backend.nonInteractive === false) {
    return `${command}\n`;
  }
  // Coding backends run inside an interactive shell PTY so append exit for
  // one-shot runs; otherwise the shell stays open and the tool never resolves.
  return `${command}\nexit\n`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function extractProgressDetail(output: string, command: string): string | undefined {
  const normalizedCommand = command.trim();
  const lines = stripAnsi(output)
    .replace(/\r+/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (normalizedCommand && line === normalizedCommand) continue;
    if (line.toLowerCase() === 'exit') continue;
    return truncateText(line, MAX_PROGRESS_DETAIL_CHARS);
  }
  return undefined;
}

function summarizeCompletionDetail(
  status: 'succeeded' | 'failed' | 'timed_out',
  output: string,
  command: string,
  exitCode?: number,
): string | undefined {
  const detail = extractProgressDetail(output, command);
  if (detail) return detail;
  if (status === 'timed_out') {
    return 'The delegated coding assistant did not finish before the timeout.';
  }
  if (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0) {
    return `Exited with code ${exitCode}.`;
  }
  return undefined;
}

interface ActiveCodingBackendSession {
  session: CodingBackendSession;
  runId: string;
  requestId?: string;
  command: string;
  outputBuffer: string;
  progressSequence: number;
  lastProgressDetail?: string;
  lastProgressAt?: number;
  unsubscribeOutput: () => void;
  unsubscribeExit: () => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  resolve?: (result: CodingBackendRunResult) => void;
}

export class CodingBackendService {
  private config: CodingBackendsConfig;
  private readonly terminalControl: CodingBackendTerminalControl;
  private readonly activeSessions = new Map<string, ActiveCodingBackendSession>();
  private readonly recentSessions: CodingBackendSession[] = [];
  private readonly progressListeners = new Set<CodingBackendProgressListener>();
  private sessionCounter = 0;

  constructor(options: CodingBackendServiceOptions) {
    this.config = options.config;
    this.terminalControl = options.terminalControl;
  }

  /** List available backends (config + presets merged). */
  listBackends(): Array<CodingBackendConfig & { preset?: boolean }> {
    const configuredIds = new Set(this.config.backends.map((b) => b.id));
    const backends: Array<CodingBackendConfig & { preset?: boolean }> = [];

    for (const backend of this.config.backends) {
      const preset = CODING_BACKEND_PRESETS.find((p) => p.id === backend.id);
      backends.push({
        ...preset,
        ...backend,
        preset: !!preset,
      } as CodingBackendConfig & { preset?: boolean });
    }

    // Also list known presets that aren't configured yet (as disabled)
    for (const preset of CODING_BACKEND_PRESETS) {
      if (!configuredIds.has(preset.id)) {
        backends.push({
          ...preset,
          enabled: false,
          preset: true,
        });
      }
    }

    return backends;
  }

  /** Resolve backend config by id, falling back to defaults and presets. */
  resolveBackend(backendId?: string): CodingBackendConfig | null {
    const id = backendId || this.config.defaultBackend;
    if (!id) {
      // Use first enabled backend
      const first = this.config.backends.find((b) => b.enabled);
      if (first) return this.mergeWithPreset(first);
      return null;
    }
    const configured = this.config.backends.find((b) => b.id === id);
    if (configured) return this.mergeWithPreset(configured);
    // Check presets
    const preset = CODING_BACKEND_PRESETS.find((p) => p.id === id);
    if (preset) return { ...preset, enabled: true };
    return null;
  }

  private mergeWithPreset(config: CodingBackendConfig): CodingBackendConfig {
    const preset = CODING_BACKEND_PRESETS.find((p) => p.id === config.id);
    if (!preset) return config;
    return {
      ...preset,
      enabled: config.enabled,
      ...(config.shell ? { shell: config.shell } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...(typeof config.timeoutMs === 'number' ? { timeoutMs: config.timeoutMs } : {}),
      ...(typeof config.nonInteractive === 'boolean' ? { nonInteractive: config.nonInteractive } : {}),
      ...(typeof config.lastVersionCheck === 'number' ? { lastVersionCheck: config.lastVersionCheck } : {}),
      ...(typeof config.installedVersion === 'string' ? { installedVersion: config.installedVersion } : {}),
      ...(typeof config.updateAvailable === 'boolean' ? { updateAvailable: config.updateAvailable } : {}),
    };
  }

  subscribeProgress(listener: CodingBackendProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  public recordExternalProgress(runId: string, codeSessionId: string, backendName: string, task: string, message: string): void {
    const event: CodingBackendProgressEvent = {
      id: `progress-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'progress',
      runId,
      requestId: runId,
      codeSessionId,
      sessionId: `ext-${runId}`,
      terminalId: 'none',
      backendId: 'remote-sandbox',
      backendName,
      task,
      timestamp: Date.now(),
      detail: message,
    };
    for (const listener of this.progressListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitProgress(entry: ActiveCodingBackendSession, kind: CodingBackendProgressKind, timestamp: number, input: {
    detail?: string;
    exitCode?: number;
  } = {}): void {
    const event: CodingBackendProgressEvent = {
      id: `coding-backend:${entry.session.id}:${++entry.progressSequence}`,
      kind,
      runId: entry.runId,
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      codeSessionId: entry.session.codeSessionId,
      sessionId: entry.session.id,
      terminalId: entry.session.terminalId,
      backendId: entry.session.backendId,
      backendName: entry.session.backendName,
      task: entry.session.task,
      timestamp,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(typeof input.exitCode === 'number' ? { exitCode: input.exitCode } : {}),
    };
    for (const listener of this.progressListeners) {
      listener({ ...event });
    }
  }

  private maybeEmitOutputProgress(entry: ActiveCodingBackendSession): void {
    const now = Date.now();
    if (entry.lastProgressAt && now - entry.lastProgressAt < OUTPUT_PROGRESS_THROTTLE_MS) {
      return;
    }
    const detail = extractProgressDetail(entry.outputBuffer, entry.command);
    if (!detail || detail === entry.lastProgressDetail) return;
    entry.lastProgressDetail = detail;
    entry.lastProgressAt = now;
    this.emitProgress(entry, 'progress', now, { detail });
  }

  /** Launch a backend to run a task. Returns when the CLI completes or times out. */
  async run(params: {
    task: string;
    backendId?: string;
    codeSessionId: string;
    workspaceRoot: string;
    requestId?: string;
  }): Promise<CodingBackendRunResult> {
    const backend = this.resolveBackend(params.backendId);
    if (!backend) {
      const available = this.config.backends.filter((b) => b.enabled).map((b) => b.id);
      return {
        success: false,
        backendId: params.backendId || 'unknown',
        backendName: 'Unknown',
        task: params.task,
        status: 'failed',
        durationMs: 0,
        output: `Coding backend '${params.backendId || 'default'}' is not configured. Available: ${available.join(', ') || 'none'}. Add backends in Configuration > Integrations > Coding Assistants.`,
        terminalTabId: '',
      };
    }
    if (!backend.enabled) {
      return {
        success: false,
        backendId: backend.id,
        backendName: backend.name,
        task: params.task,
        status: 'failed',
        durationMs: 0,
        output: `Coding backend '${backend.name}' is disabled. Enable it in Configuration > Integrations > Coding Assistants.`,
        terminalTabId: '',
      };
    }

    // Check concurrent session limit
    const activeForSession = [...this.activeSessions.values()]
      .filter((s) => s.session.codeSessionId === params.codeSessionId);
    const maxConcurrent = this.config.maxConcurrentSessions ?? 2;
    if (activeForSession.length >= maxConcurrent) {
      return {
        success: false,
        backendId: backend.id,
        backendName: backend.name,
        task: params.task,
        status: 'failed',
        durationMs: 0,
        output: `Maximum concurrent coding backend sessions (${maxConcurrent}) reached for this workspace. Wait for an active session to complete.`,
        terminalTabId: '',
      };
    }

    const sessionId = `cb-${++this.sessionCounter}-${Date.now()}`;
    const command = buildCommand(backend, params.task, params.workspaceRoot);
    const timeoutMs = backend.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const shell = backend.shell || (process.platform === 'win32' ? 'wsl' : 'bash');
    const requestId = params.requestId?.trim() || undefined;
    const runId = requestId || `code-session:${params.codeSessionId}:backend:${sessionId}`;

    log.info({ backendId: backend.id, sessionId, task: params.task.slice(0, 100) }, 'Launching coding backend');

    // Open terminal
    const { terminalId } = await this.terminalControl.openTerminal({
      codeSessionId: params.codeSessionId,
      shell,
      cwd: params.workspaceRoot,
      name: `[${backend.name}] ${params.task.slice(0, 40)}...`,
    });

    const startedAt = Date.now();
    const session: CodingBackendSession = {
      id: sessionId,
      backendId: backend.id,
      backendName: backend.name,
      codeSessionId: params.codeSessionId,
      terminalId,
      task: params.task,
      status: 'running',
      startedAt,
    };

    return new Promise<CodingBackendRunResult>((resolve) => {
      const complete = (status: 'succeeded' | 'failed' | 'timed_out', exitCode?: number) => {
        const entry = this.activeSessions.get(sessionId);
        if (!entry) return; // already completed
        if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
        entry.unsubscribeOutput();
        entry.unsubscribeExit();
        this.activeSessions.delete(sessionId);

        const durationMs = Date.now() - startedAt;
        session.status = status;
        session.completedAt = Date.now();
        session.exitCode = exitCode;
        session.durationMs = durationMs;

        this.recentSessions.unshift(session);
        if (this.recentSessions.length > 50) this.recentSessions.length = 50;

        const cleaned = stripAnsi(entry.outputBuffer).trim();
        const truncated = cleaned.length > MAX_TOOL_OUTPUT_CHARS
          ? cleaned.slice(-MAX_TOOL_OUTPUT_CHARS) + '\n[output truncated]'
          : cleaned;

        log.info({ backendId: backend.id, sessionId, status, exitCode, durationMs }, 'Coding backend completed');

        this.emitProgress(entry, status === 'succeeded' ? 'completed' : status, session.completedAt, {
          detail: summarizeCompletionDetail(status, entry.outputBuffer, entry.command, exitCode),
          ...(typeof exitCode === 'number' ? { exitCode } : {}),
        });

        resolve({
          success: status === 'succeeded',
          backendId: backend.id,
          backendName: backend.name,
          task: params.task,
          status,
          exitCode,
          durationMs,
          output: truncated || `(no output captured)`,
          terminalTabId: terminalId,
        });
      };

      const unsubscribeOutput = this.terminalControl.onTerminalOutput(terminalId, (data) => {
        const entry = this.activeSessions.get(sessionId);
        if (!entry) return;
        entry.outputBuffer += data;
        // Cap buffer size
        if (entry.outputBuffer.length > MAX_OUTPUT_BYTES) {
          entry.outputBuffer = entry.outputBuffer.slice(-MAX_OUTPUT_BYTES);
        }
        this.maybeEmitOutputProgress(entry);
      });

      const unsubscribeExit = this.terminalControl.onTerminalExit(terminalId, (exitCode) => {
        complete(exitCode === 0 ? 'succeeded' : 'failed', exitCode);
      });

      const timeoutHandle = setTimeout(() => {
        log.warn({ backendId: backend.id, sessionId, timeoutMs }, 'Coding backend timed out');
        this.terminalControl.closeTerminal(terminalId);
        complete('timed_out');
      }, timeoutMs);

      this.activeSessions.set(sessionId, {
        session,
        runId,
        ...(requestId ? { requestId } : {}),
        command,
        outputBuffer: '',
        progressSequence: 0,
        unsubscribeOutput,
        unsubscribeExit,
        timeoutHandle,
        resolve,
      });

      const entry = this.activeSessions.get(sessionId);
      if (entry) {
        this.emitProgress(entry, 'started', startedAt, {
          detail: truncateText(params.task.trim(), MAX_PROGRESS_DETAIL_CHARS),
        });
      }

      // Write the command to the terminal and close one-shot shells afterwards.
      this.terminalControl.writeTerminalInput(terminalId, buildTerminalInput(backend, command));
    });
  }

  /** Get status of active and recent backend sessions. */
  getStatus(sessionId?: string): CodingBackendSession[] {
    const active = [...this.activeSessions.values()].map((entry) => entry.session);
    const all = [...active, ...this.recentSessions];
    if (sessionId) {
      return all.filter((s) => s.id === sessionId);
    }
    return all.slice(0, 20);
  }

  /** Update config at runtime (hot-reload from UI). */
  updateConfig(config: CodingBackendsConfig): void {
    this.config = config;
  }

  /** Clean up all active sessions on shutdown. */
  dispose(): void {
    for (const [, entry] of this.activeSessions) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.unsubscribeOutput();
      entry.unsubscribeExit();
      this.terminalControl.closeTerminal(entry.session.terminalId);
    }
    this.activeSessions.clear();
    this.progressListeners.clear();
  }
}
