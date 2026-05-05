import type { CodingBackendConfig, CodingBackendsConfig } from '../config/types.js';
import type { CodingBackendTerminalControl } from '../channels/web-types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Final assistant answer captured separately from the raw terminal transcript. */
  assistantResponse?: string;
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
const WORKSPACE_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
const MAX_WORKSPACE_INSTRUCTION_CHARS = 16_000;

/** Strip ANSI escape codes from terminal output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[@-~]/g, '');
}

/** Shell-quote a string for POSIX shells. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function toWslPath(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '/';
  if (normalized.startsWith('/')) {
    return normalized.replace(/\\/g, '/');
  }
  const driveMatch = normalized.replace(/\//g, '\\').match(/^([A-Za-z]):\\(.*)$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
  }
  return normalized.replace(/\\/g, '/');
}

function toShellVisiblePath(value: string, shell: string): string {
  if (process.platform !== 'win32') {
    return value;
  }
  if (shell === 'wsl' || shell === 'wsl-login') {
    return toWslPath(value);
  }
  if (shell === 'git-bash') {
    return value.replace(/\\/g, '/');
  }
  return value;
}

interface BuildCommandOptions {
  assistantResponseArgs?: string;
}

/** Build the full CLI command from config and task. */
function buildCommand(
  backend: CodingBackendConfig,
  task: string,
  cwd: string,
  options: BuildCommandOptions = {},
): string {
  const quotedTask = shellQuote(task);
  const args = backend.args
    .map((arg) => arg
      .replace(/\{\{task\}\}/g, quotedTask)
      .replace(/\{\{cwd\}\}/g, shellQuote(cwd))
      .replace(/\{\{assistant_response_args\}\}/g, options.assistantResponseArgs?.trim() || '')
      .trim())
    .filter(Boolean);
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

async function readWorkspaceInstructionFile(workspaceRoot: string): Promise<{ fileName: string; content: string } | null> {
  const root = workspaceRoot.trim();
  if (!root) return null;
  for (const fileName of WORKSPACE_INSTRUCTION_FILES) {
    try {
      const content = (await readFile(join(root, fileName), 'utf8')).trim();
      if (!content) continue;
      return {
        fileName,
        content: truncateText(content, MAX_WORKSPACE_INSTRUCTION_CHARS),
      };
    } catch {
      // Try the next supported workspace instruction file.
    }
  }
  return null;
}

function buildTaskWithWorkspaceInstructions(
  task: string,
  instructions: { fileName: string; content: string } | null,
): string {
  if (!instructions) return task;
  return [
    `Workspace instructions loaded from ${instructions.fileName}. Follow these instructions for this run:`,
    '',
    instructions.content,
    '',
    'User task:',
    task,
  ].join('\n');
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
  assistantResponseCapture?: AssistantResponseCapture | null;
  progressSequence: number;
  lastProgressDetail?: string;
  lastProgressAt?: number;
  unsubscribeOutput: () => void;
  unsubscribeExit: () => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  resolve?: (result: CodingBackendRunResult) => void;
}

interface AssistantResponseCapture {
  directory: string;
  hostPath: string;
  shellPath: string;
}

function backendSupportsAssistantResponseCapture(backend: CodingBackendConfig): boolean {
  return backend.args.some((arg) => arg.includes('{{assistant_response_args}}'));
}

/**
 * Extract the final assistant reply from a raw coding-backend terminal transcript.
 * Used as a fallback when the CLI's `--output-last-message` capture file is unavailable
 * (path translation, permissions, version drift). Backend-specific because each CLI
 * prints its final answer in a different format.
 */
function extractAssistantResponseFromOutput(backendId: string, output: string): string | undefined {
  const text = output.replace(/\r+/g, '\n');
  if (!text.trim()) return undefined;

  // Codex `exec` prints the answer between a `codex` marker line and a trailing
  // `tokens used <n>` summary line. Allow surrounding whitespace.
  if (backendId === 'codex') {
    const matches = [...text.matchAll(/(^|\n)\s*codex\s*\n([\s\S]*?)(?=\n\s*tokens\s+used\b|$)/gi)];
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      const body = stripTrailingShellNoise(last[2] ?? '');
      if (body) return body;
    }
    return undefined;
  }

  // Aider interleaves tool logs, diffs, and assistant prose. Its own summaries
  // come between `> <task>` and either `Tokens:` or `Applied edit` / final prompt.
  if (backendId === 'aider') {
    const tokenCutoff = text.search(/\n\s*Tokens:\s*/i);
    const trimmed = tokenCutoff >= 0 ? text.slice(0, tokenCutoff) : text;
    const afterPrompt = trimmed.match(/\n>\s+[\s\S]*?\n([\s\S]*)$/);
    const candidate = afterPrompt ? afterPrompt[1] : trimmed;
    const cleaned = stripTrailingShellNoise(stripLeadingCommandEcho(candidate));
    return cleaned || undefined;
  }

  // Claude Code (`--print`) and Gemini CLI print the assistant reply directly.
  // Strip the shell wrapper (command echo + trailing `exit` / bash prompt) and
  // return the remainder verbatim.
  if (backendId === 'claude-code' || backendId === 'gemini-cli') {
    const cleaned = stripTrailingShellNoise(stripLeadingCommandEcho(text));
    return cleaned || undefined;
  }

  // Unknown / user-configured backend: best-effort wrapper strip.
  const cleaned = stripTrailingShellNoise(stripLeadingCommandEcho(text));
  return cleaned || undefined;
}

/**
 * Remove the leading command-echo line(s) produced by the PTY shell. Drops any
 * prompt + command lines until the first line that looks like CLI output.
 */
function stripLeadingCommandEcho(text: string): string {
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (/^(bash|sh|zsh|wsl)[\w.\-]*\$/.test(line)) { index += 1; continue; }
    if (/^[\w.\-]+@[\w.\-]+:[^$]*\$/.test(line)) { index += 1; continue; }
    if (/^(codex|claude|gemini|aider)\s+/.test(line)) { index += 1; continue; }
    break;
  }
  return lines.slice(index).join('\n').trim();
}

/**
 * Remove the trailing `exit` line, bash prompts left behind by the PTY shell,
 * and any `[output truncated]` marker appended by buffer capping.
 */
function stripTrailingShellNoise(text: string): string {
  let current = text.replace(/\n\[output truncated\]\s*$/i, '');
  const prune = /\n\s*(?:(?:bash|sh|zsh|wsl)[\w.\-]*\$[^\n]*|exit|logout|[\w.\-]+@[\w.\-]+:[^\n]*\$[^\n]*)\s*$/i;
  while (prune.test(current)) {
    current = current.replace(prune, '');
  }
  return current.trim();
}

async function createAssistantResponseCapture(shell: string): Promise<AssistantResponseCapture | null> {
  try {
    const directory = await mkdtemp(join(tmpdir(), 'guardianagent-coding-backend-'));
    const hostPath = join(directory, 'assistant-response.txt');
    return {
      directory,
      hostPath,
      shellPath: toShellVisiblePath(hostPath, shell),
    };
  } catch (error) {
    log.warn({ error }, 'Could not prepare assistant response capture for coding backend run');
    return null;
  }
}

async function readAssistantResponseCapture(capture?: AssistantResponseCapture | null): Promise<string | undefined> {
  if (!capture) return undefined;
  try {
    const text = (await readFile(capture.hostPath, 'utf8')).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

async function cleanupAssistantResponseCapture(capture?: AssistantResponseCapture | null): Promise<void> {
  if (!capture) return;
  try {
    await rm(capture.directory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures for temp capture directories.
  }
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
    if (!this.config.enabled) {
      return null;
    }
    const id = backendId || this.config.defaultBackend;
    if (!id) {
      // Use first enabled configured backend.
      const first = this.config.backends.find((b) => b.enabled);
      if (first) return this.mergeWithPreset(first);
      return null;
    }
    const configured = this.config.backends.find((b) => b.id === id);
    if (configured) return this.mergeWithPreset(configured);
    return null;
  }

  listEnabledBackendIds(): string[] {
    if (!this.config.enabled) return [];
    return this.config.backends
      .filter((backend) => backend.enabled)
      .map((backend) => backend.id);
  }

  getRunPrerequisiteError(params: {
    backendId?: string;
    codeSessionId?: string;
    workspaceRoot?: string;
  }): string | null {
    if (!this.config.enabled) {
      return 'Coding backend orchestration is not enabled. Enable it in Configuration > Integrations > Coding Assistants.';
    }

    if (!params.codeSessionId?.trim()) {
      return 'No active coding session. Create or attach to a coding session first.';
    }

    if (!params.workspaceRoot?.trim()) {
      return 'Could not determine workspace root for the current coding session.';
    }

    const requestedBackendId = params.backendId?.trim();
    if (!requestedBackendId) {
      if (this.resolveBackend()) {
        return null;
      }
      return 'No enabled coding backends are configured. Enable Codex, Claude Code, Gemini CLI, or Aider in Configuration > Integrations > Coding Assistants.';
    }

    const configured = this.config.backends.find((backend) => backend.id === requestedBackendId);
    if (!configured) {
      const preset = CODING_BACKEND_PRESETS.find((candidate) => candidate.id === requestedBackendId);
      if (preset) {
        return `Coding backend '${preset.name}' is not enabled. Enable it in Configuration > Integrations > Coding Assistants.`;
      }
      const available = this.listEnabledBackendIds();
      return `Coding backend '${requestedBackendId}' is not configured. Available: ${available.join(', ') || 'none'}. Add backends in Configuration > Integrations > Coding Assistants.`;
    }

    if (!configured.enabled) {
      const merged = this.mergeWithPreset(configured);
      return `Coding backend '${merged.name}' is disabled. Enable it in Configuration > Integrations > Coding Assistants.`;
    }

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
    const prerequisiteError = this.getRunPrerequisiteError(params);
    if (prerequisiteError) {
      const requestedBackendId = params.backendId?.trim();
      const configured = requestedBackendId
        ? this.config.backends.find((backend) => backend.id === requestedBackendId)
        : undefined;
      const preset = requestedBackendId
        ? CODING_BACKEND_PRESETS.find((candidate) => candidate.id === requestedBackendId)
        : undefined;
      const backendName = configured
        ? this.mergeWithPreset(configured).name
        : preset?.name ?? requestedBackendId ?? 'Unknown';
      return {
        success: false,
        backendId: requestedBackendId || 'unknown',
        backendName,
        task: params.task,
        status: 'failed',
        durationMs: 0,
        output: prerequisiteError,
        terminalTabId: '',
      };
    }

    const backend = this.resolveBackend(params.backendId);
    if (!backend) {
      const available = this.listEnabledBackendIds();
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
    const timeoutMs = backend.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const shell = backend.shell || (process.platform === 'win32' ? 'wsl' : 'bash');
    const workspaceInstructions = await readWorkspaceInstructionFile(params.workspaceRoot);
    const task = buildTaskWithWorkspaceInstructions(params.task, workspaceInstructions);
    const assistantResponseCapture = backendSupportsAssistantResponseCapture(backend)
      ? await createAssistantResponseCapture(shell)
      : null;
    const assistantResponseArgs = assistantResponseCapture
      ? `--output-last-message ${shellQuote(assistantResponseCapture.shellPath)}`
      : '';
    const command = buildCommand(backend, task, params.workspaceRoot, { assistantResponseArgs });
    const requestId = params.requestId?.trim() || undefined;
    const runId = requestId || `code-session:${params.codeSessionId}:backend:${sessionId}`;

    log.info({
      backendId: backend.id,
      sessionId,
      task: params.task.slice(0, 100),
      workspaceInstructionFile: workspaceInstructions?.fileName,
    }, 'Launching coding backend');

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
      const complete = async (status: 'succeeded' | 'failed' | 'timed_out', exitCode?: number) => {
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
        let assistantResponse: string | undefined;
        try {
          assistantResponse = await readAssistantResponseCapture(entry.assistantResponseCapture);
        } finally {
          await cleanupAssistantResponseCapture(entry.assistantResponseCapture);
        }
        if (!assistantResponse) {
          assistantResponse = extractAssistantResponseFromOutput(backend.id, cleaned);
        }

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
          ...(assistantResponse ? { assistantResponse } : {}),
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
        void complete(exitCode === 0 ? 'succeeded' : 'failed', exitCode);
      });

      const timeoutHandle = setTimeout(() => {
        log.warn({ backendId: backend.id, sessionId, timeoutMs }, 'Coding backend timed out');
        this.terminalControl.closeTerminal(terminalId);
        void complete('timed_out');
      }, timeoutMs);

      this.activeSessions.set(sessionId, {
        session,
        runId,
        ...(requestId ? { requestId } : {}),
        command,
        outputBuffer: '',
        assistantResponseCapture,
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
