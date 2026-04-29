import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { scanWriteContent } from '../../guardian/argument-sanitizer.js';
import type { ParsedCommand, ShellExecutionClass } from '../../guardian/shell-validator.js';
import type { CodingBackendService } from '../../runtime/coding-backend-service.js';
import type { CodeSessionStore } from '../../runtime/code-sessions.js';
import { buildCodingWorkflowPlan } from '../../runtime/coding-workflows.js';
import type { PackageInstallTrustService } from '../../runtime/package-install-trust-service.js';
import type { RemoteExecutionTargetDescriptor } from '../../runtime/remote-execution/policy.js';
import type {
  RemoteExecutionResolvedTarget,
  RemoteExecutionRunResult,
} from '../../runtime/remote-execution/types.js';
import type { JsDependencyMutationIntent, JsDependencySnapshot } from '../../runtime/workspace-dependency-ledger.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

type ShellExecMode = 'direct_exec' | 'shell_fallback';
type RemoteIsolationMode = 'local' | 'remote_if_available' | 'remote_required';

interface ShellCommandPlan {
  commands: ParsedCommand[];
  entryCommand: string;
  argv: string[];
  executionClass: ShellExecutionClass;
  requestedViaShell: boolean;
  execMode: ShellExecMode;
  resolvedExecutable?: string;
}

interface ShellCommandCheck {
  safe: boolean;
  reason?: string;
  plan?: ShellCommandPlan;
}

interface PendingJsDependencyTracking {
  intent: JsDependencyMutationIntent;
  before: JsDependencySnapshot | null;
  workspaceRoot: string;
  cwd: string;
}

interface CodingQualityCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'not_run';
  details: string;
}

interface CodingQualityReport {
  passed: boolean;
  checks: CodingQualityCheck[];
}

const SNAPSHOT_FREE_REMOTE_EXEC_COMMANDS = new Set([
  'pwd',
  'whoami',
  'id',
  'uname',
  'hostname',
  'date',
  'env',
  'printenv',
]);

const SNAPSHOT_FREE_VERSION_COMMANDS = new Set([
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'python',
  'python3',
  'pip',
  'pip3',
]);

type CodeSessionRecord = NonNullable<ReturnType<CodeSessionStore['getSession']>>;

interface CodingToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  requireStringAllowEmpty: (value: unknown, field: string) => string;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  cloudConfig?: import('../../config/types.js').AssistantCloudConfig;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  resolveAllowedPath: (inputPath: string, request?: Partial<ToolExecutionRequest>) => Promise<string>;
  getEffectiveWorkspaceRoot: (request?: Partial<ToolExecutionRequest>) => string;
  getCodeWorkspaceRoot: (request?: Partial<ToolExecutionRequest>) => string | undefined;
  buildCodeShellEnv: (workspaceRoot: string) => Record<string, string>;
  validateShellCommandForRequest: (
    command: string,
    request?: Partial<ToolExecutionRequest>,
    cwd?: string,
  ) => ShellCommandCheck;
  getDegradedPackageManagerBlockReason: (command: string) => string | null;
  finalizeShellCommandPlan: (
    plan: ShellCommandPlan,
    cwd: string,
    env?: Record<string, string>,
  ) => Promise<ShellCommandPlan>;
  prepareJsDependencyTracking: (
    commands: ParsedCommand[],
    cwd: string,
    request?: Partial<ToolExecutionRequest>,
  ) => PendingJsDependencyTracking | null;
  finalizeJsDependencyTracking: (tracking: PendingJsDependencyTracking | null, command: string) => void;
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
  sandboxExecFile: (
    file: string,
    argv: string[],
    profile: 'read-only' | 'workspace-write',
    opts?: {
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      env?: Record<string, string>;
      networkAccess?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  packageInstallTrust?: PackageInstallTrustService;
  codeSessionStore?: CodeSessionStore;
  codingBackendService?: CodingBackendService;
  getCodingBackendService?: () => CodingBackendService | undefined;
  listOwnedCodeSessions: (request?: Partial<ToolExecutionRequest>) => CodeSessionRecord[];
  summarizeCodeSession: (session: CodeSessionRecord) => Record<string, unknown>;
  getCodeSessionSurfaceId: (request?: Partial<ToolExecutionRequest>) => string;
  resolveOwnedCodeSessionTarget: (
    target: string,
    request?: Partial<ToolExecutionRequest>,
  ) => { session?: CodeSessionRecord; error?: string };
  getCurrentCodeSessionRecord: (request?: Partial<ToolExecutionRequest>) => CodeSessionRecord | null;
  getRemoteExecutionTargets?: () => RemoteExecutionTargetDescriptor[];
  resolveRemoteExecutionTarget?: (profileId?: string, command?: string, workspaceRoot?: string) => Promise<RemoteExecutionResolvedTarget | null>;
  runRemoteExecutionJob?: (input: {
    request?: Partial<ToolExecutionRequest>;
    profileId?: string;
    command: {
      requestedCommand: string;
      entryCommand: string;
      args: string[];
      execMode: 'direct_exec' | 'shell_fallback';
    };
    workspace: {
      workspaceRoot: string;
      cwd: string;
      stageWorkspace?: boolean;
      includePaths?: string[];
    };
    artifactPaths?: string[];
    timeoutMs?: number;
    vcpus?: number;
  }) => Promise<RemoteExecutionRunResult>;
}

function normalizeCodeText(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function resolveCodingBackendService(context: CodingToolRegistrarContext): CodingBackendService | undefined {
  return context.getCodingBackendService?.() ?? context.codingBackendService;
}

function buildNormalizedIndexMap(original: string): number[] {
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    if (original[i] === '\r' && original[i + 1] === '\n') continue;
    map.push(i);
  }
  map.push(original.length);
  return map;
}

function lineOffsets(value: string): number[] {
  const offsets = [0];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function normalizeLineRange(
  haystack: string,
  needle: string,
  normalizer: (value: string) => string,
): { start: number; end: number } | null {
  const haystackLines = haystack.split('\n');
  const needleLines = needle.split('\n');
  if (needleLines.length === 0 || haystackLines.length < needleLines.length) {
    return null;
  }

  const offsets = lineOffsets(haystack);
  const normalizedNeedle = normalizer(needle);
  for (let i = 0; i <= haystackLines.length - needleLines.length; i++) {
    const segment = haystackLines.slice(i, i + needleLines.length).join('\n');
    if (normalizer(segment) === normalizedNeedle) {
      const start = offsets[i] ?? 0;
      const end = i + needleLines.length < offsets.length
        ? offsets[i + needleLines.length] - 1
        : haystack.length;
      return { start, end };
    }
  }
  return null;
}

function findCodeEditRange(
  original: string,
  oldString: string,
): { start: number; end: number; strategy: string } | null {
  if (!oldString) return null;

  const exact = original.indexOf(oldString);
  if (exact >= 0) {
    return { start: exact, end: exact + oldString.length, strategy: 'exact' };
  }

  const normalizedOriginal = normalizeCodeText(original);
  const normalizedTarget = normalizeCodeText(oldString);
  const indexMap = buildNormalizedIndexMap(original);

  const normalizedExact = normalizedOriginal.indexOf(normalizedTarget);
  if (normalizedExact >= 0) {
    return {
      start: indexMap[normalizedExact] ?? 0,
      end: indexMap[normalizedExact + normalizedTarget.length] ?? original.length,
      strategy: 'line-ending-normalized',
    };
  }

  const trimmed = normalizeLineRange(
    normalizedOriginal,
    normalizedTarget,
    (value) => value.split('\n').map((line) => line.trim()).join('\n'),
  );
  if (trimmed) {
    return {
      start: indexMap[trimmed.start] ?? 0,
      end: indexMap[trimmed.end] ?? original.length,
      strategy: 'trimmed-lines',
    };
  }

  const indentInsensitive = normalizeLineRange(
    normalizedOriginal,
    normalizedTarget,
    (value) => value.split('\n').map((line) => line.trimStart()).join('\n'),
  );
  if (indentInsensitive) {
    return {
      start: indexMap[indentInsensitive.start] ?? 0,
      end: indexMap[indentInsensitive.end] ?? original.length,
      strategy: 'indentation-insensitive',
    };
  }

  const collapsedWhitespace = normalizeLineRange(
    normalizedOriginal,
    normalizedTarget,
    (value) => value.replace(/[ \t]+/g, ' ').trim(),
  );
  if (collapsedWhitespace) {
    return {
      start: indexMap[collapsedWhitespace.start] ?? 0,
      end: indexMap[collapsedWhitespace.end] ?? original.length,
      strategy: 'whitespace-collapsed',
    };
  }

  return null;
}

function collectDebugArtifactMatches(content: string): string[] {
  const patterns: Array<{ label: string; regex: RegExp }> = [
    { label: 'console.log', regex: /\bconsole\.log\s*\(/g },
    { label: 'debugger', regex: /\bdebugger\b/g },
    { label: 'print()', regex: /\bprint\s*\(/g },
    { label: 'dump()', regex: /\bdump\s*\(/g },
  ];
  const matches: string[] = [];
  for (const pattern of patterns) {
    if (pattern.regex.test(content)) matches.push(pattern.label);
  }
  return matches;
}

function collectIncompleteMarkers(content: string): string[] {
  const markers = ['TODO', 'FIXME', 'HACK', 'XXX'];
  return markers.filter((marker) => content.includes(marker));
}

function extractPatchTargets(patch: string): string[] {
  const targets = new Set<string>();
  for (const line of patch.split(/\r?\n/g)) {
    if (!line.startsWith('+++ ')) continue;
    const raw = line.slice(4).trim();
    if (!raw || raw === '/dev/null') continue;
    const normalized = raw.replace(/^[ab]\//, '').trim();
    if (normalized) targets.add(normalized);
  }
  return [...targets];
}

function truncateOutput(value: string): string {
  if (!value) return '';
  return value.length > 8000 ? `${value.slice(0, 8000)}\n...[truncated]` : value;
}

function normalizeRemoteIsolationMode(value: unknown): RemoteIsolationMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'remote_if_available' || normalized === 'remote_required') {
    return normalized;
  }
  return 'local';
}

function stringArrayArg(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
    : [];
}

function buildRemoteExecutionOutput(result: RemoteExecutionRunResult): Record<string, unknown> {
  return {
    backendKind: result.backendKind,
    profileId: result.profileId,
    profileName: result.profileName,
    sandboxId: result.sandboxId,
    leaseId: result.leaseId,
    leaseScope: result.leaseScope,
    leaseReused: result.leaseReused,
    leaseMode: result.leaseMode,
    healthState: result.healthState,
    healthReason: result.healthReason,
    routingReason: result.routingReason,
    command: result.requestedCommand,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    networkMode: result.networkMode,
    stagedFiles: result.stagedFiles,
    stagedBytes: result.stagedBytes,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr),
    artifactFiles: result.artifactFiles.map((artifact) => ({
      path: artifact.path,
      encoding: artifact.encoding,
      sizeBytes: artifact.sizeBytes,
      truncated: artifact.truncated,
      content: truncateOutput(artifact.content),
    })),
  };
}

function formatRemoteExecutionFailure(result: RemoteExecutionRunResult): string {
  const headline = result.status === 'timed_out'
    ? `Remote sandbox command timed out on '${result.profileName}'.`
    : `Remote sandbox command failed on '${result.profileName}'.`;
  const lines = [
    headline,
    `Command: ${result.requestedCommand}`,
  ];
  if (typeof result.exitCode === 'number') {
    lines.push(`Exit code: ${result.exitCode}`);
  }
  if (result.stderr.trim()) {
    lines.push(`stderr:\n${truncateOutput(result.stderr)}`);
  }
  if (result.stdout.trim()) {
    lines.push(`stdout:\n${truncateOutput(result.stdout)}`);
  }
  return lines.join('\n\n');
}

async function buildCodingQualityReportForFiles(
  context: Pick<CodingToolRegistrarContext, 'sandboxExec'>,
  paths: string[],
  cwd?: string,
): Promise<CodingQualityReport> {
  const checks: CodingQualityCheck[] = [];
  let largeChangeDetected = false;

  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf-8');
      const debugArtifacts = collectDebugArtifactMatches(content);
      const incompleteMarkers = collectIncompleteMarkers(content);
      const lineCount = content.split('\n').length;

      checks.push({
        name: `debug_artifacts:${path}`,
        status: debugArtifacts.length > 0 ? 'warn' : 'pass',
        details: debugArtifacts.length > 0
          ? `Detected debug-oriented patterns: ${debugArtifacts.join(', ')}.`
          : 'No obvious debug artifacts detected.',
      });
      checks.push({
        name: `incomplete_markers:${path}`,
        status: incompleteMarkers.length > 0 ? 'warn' : 'pass',
        details: incompleteMarkers.length > 0
          ? `Detected incomplete markers: ${incompleteMarkers.join(', ')}.`
          : 'No TODO/FIXME markers detected.',
      });
      if (lineCount > 500) {
        largeChangeDetected = true;
      }
    } catch {
      checks.push({
        name: `file_read:${path}`,
        status: 'warn',
        details: 'Unable to re-read file for quality inspection.',
      });
    }
  }

  checks.push({
    name: 'large_change',
    status: largeChangeDetected ? 'warn' : 'pass',
    details: largeChangeDetected
      ? 'At least one touched file exceeds 500 lines after the change. Review scope carefully.'
      : 'No large-file warning triggered.',
  });

  if (cwd) {
    try {
      const { stdout, stderr } = await context.sandboxExec('git diff --stat', 'read-only', {
        cwd,
        timeout: 15_000,
        maxBuffer: 200_000,
      });
      const diffSummary = truncateOutput(stdout || stderr || '').trim();
      checks.push({
        name: 'git_diff_stat',
        status: diffSummary ? 'pass' : 'not_run',
        details: diffSummary || 'git diff --stat returned no output.',
      });
    } catch {
      checks.push({
        name: 'git_diff_stat',
        status: 'not_run',
        details: 'git diff --stat unavailable for this workspace.',
      });
    }
  }

  return {
    passed: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

function shouldStageWorkspaceForRemoteCommand(
  plan: ShellCommandPlan,
  input: {
    includePaths?: string[];
    artifactPaths?: string[];
    stageWorkspace?: boolean;
  },
): boolean {
  if (input.stageWorkspace === false) return false;
  if (input.stageWorkspace === true) return true;
  if ((input.includePaths?.length ?? 0) > 0) return true;
  if ((input.artifactPaths?.length ?? 0) > 0) return true;

  const normalizedEntry = plan.entryCommand.trim().toLowerCase();
  if (SNAPSHOT_FREE_REMOTE_EXEC_COMMANDS.has(normalizedEntry)) {
    return false;
  }
  if (
    SNAPSHOT_FREE_VERSION_COMMANDS.has(normalizedEntry)
    && plan.argv.length > 0
    && plan.argv.every((arg) => {
      const normalizedArg = arg.trim();
      return normalizedArg === '-v' || normalizedArg === '--version';
    })
  ) {
    return false;
  }
  return true;
}

async function runRemoteCodingCommand(
  context: CodingToolRegistrarContext,
  input: {
    request: ToolExecutionRequest;
    command: string;
    cwd: string;
    profileId?: string;
    includePaths?: string[];
    artifactPaths?: string[];
    timeoutMs?: number;
    vcpus?: number;
    stageWorkspace?: boolean;
    installDependencies?: boolean;
  },
): Promise<
  | { success: false; error: string }
  | { success: true; result: RemoteExecutionRunResult; target: RemoteExecutionResolvedTarget }
> {
  if (!context.resolveRemoteExecutionTarget || !context.runRemoteExecutionJob) {
    return { success: false, error: 'Remote execution is not available in this Guardian runtime.' };
  }
  const shellCheck = context.validateShellCommandForRequest(input.command, input.request, input.cwd);
  if (!shellCheck.safe) {
    return { success: false, error: shellCheck.reason ?? `Command is not allowlisted: '${input.command}'.` };
  }
  if (!shellCheck.plan) {
    return { success: false, error: 'Command failed execution planning.' };
  }
  let target;
  try {
    target = await context.resolveRemoteExecutionTarget?.(input.profileId, input.command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/Host '([^']+)' is not in allowedDomains\./);
    const hint = match
      ? `\nHint: Use update_tool_policy with action "add_domain" and value "${match[1]}" to allow this host, then retry.`
      : '';
    return { success: false, error: `${message}${hint}` };
  }

  if (!target) {
    return {
      success: false,
      error: input.profileId?.trim()
        ? `Remote execution target '${input.profileId.trim()}' is not ready.`
        : 'No ready remote execution target is configured.',
    };
  }

  const workspaceRoot = context.getCodeWorkspaceRoot(input.request) ?? input.cwd;
  context.guardAction(input.request, 'execute_command', {
    command: input.command,
    cwd: input.cwd,
    remote: true,
    backendKind: target.backendKind,
    profileId: target.profileId,
    networkMode: target.networkMode,
  });
  const stageWorkspace = shouldStageWorkspaceForRemoteCommand(shellCheck.plan, input);

  const result = await context.runRemoteExecutionJob({
    request: input.request,
    profileId: input.profileId,
    command: input.installDependencies
      ? {
          requestedCommand: `[Install Dependencies] && ${input.command}`,
          entryCommand: 'bash',
          args: ['-lc', `if [ -f package-lock.json ]; then npm ci; elif [ -f yarn.lock ]; then yarn install; elif [ -f pnpm-lock.yaml ]; then pnpm install; elif [ -f package.json ]; then npm install; fi; ${input.command}`],
          execMode: 'shell_fallback',
        }
      : {
          requestedCommand: input.command,
          entryCommand: shellCheck.plan.entryCommand,
          args: shellCheck.plan.argv,
          execMode: shellCheck.plan.execMode,
        },
    workspace: {
      workspaceRoot,
      cwd: input.cwd,
      stageWorkspace,
      includePaths: input.includePaths,
    },
    artifactPaths: input.artifactPaths,
    timeoutMs: input.timeoutMs,
    vcpus: input.vcpus,
  });

  return {
    success: true,
    result,
    target,
  };
}

export function registerBuiltinCodingTools(context: CodingToolRegistrarContext): void {
  const {
    requireString,
    requireStringAllowEmpty,
    asString,
    asNumber,
    isRecord,
  } = context;

  context.registry.register(
    {
      name: 'package_install',
      description: 'Run a managed package install through Guardian\'s staged trust path. Supported in v1 for explicit public-registry npm/pnpm/yarn/bun add-style commands and pip install commands. Guardian stages the requested top-level artifacts, runs bounded static checks plus native AV when available, and only then proceeds with the install. Mutating — requires approval. Requires execute_commands capability.',
      shortDescription: 'Stage, review, and then run a managed package install.',
      risk: 'mutating',
      category: 'shell',
      examples: [
        { input: { command: 'npm install lodash' }, description: 'Stage and install a Node package through the managed trust path' },
        { input: { command: 'pip install requests', allowCaution: true }, description: 'Proceed with a managed pip install after accepting caution-level findings' },
      ],
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Package-manager command to run through the managed install path.' },
          cwd: { type: 'string', description: 'Optional working directory for the install command. Must resolve inside the active workspace or configured allowed paths.' },
          allowCaution: { type: 'boolean', description: 'Proceed when the staged review result is caution. Blocked findings still stop the install.' },
        },
        required: ['command'],
      },
    },
    async (args, request) => {
      const command = requireString(args.command, 'command').trim();
      const cwd = asString(args.cwd).trim() || undefined;
      const resolvedCwd = cwd ? await context.resolveAllowedPath(cwd, request) : context.getEffectiveWorkspaceRoot(request);

      // Automatic tier promotion if a remote execution target is available
      if (context.resolveRemoteExecutionTarget && context.runRemoteExecutionJob) {
        const remoteTarget = await context.resolveRemoteExecutionTarget(undefined, command, request.codeContext?.workspaceRoot);
        if (remoteTarget) {
          context.guardAction(request, 'execute_command', {
            command,
            cwd: resolvedCwd,
            managed: true,
            tool: 'package_install',
            remoteProfile: remoteTarget.profileId,
          });

          const remoteRun = await runRemoteCodingCommand(context, {
            request,
            command,
            cwd: resolvedCwd,
            profileId: remoteTarget.profileId,
            timeoutMs: 10 * 60_000,
          });

          if (!remoteRun.success) {
            return { success: false, error: remoteRun.error };
          }
          if (remoteRun.result.status !== 'succeeded') {
            return {
              success: false,
              error: formatRemoteExecutionFailure(remoteRun.result),
              output: buildRemoteExecutionOutput(remoteRun.result),
            };
          }
          
          const stdoutText = truncateOutput(remoteRun.result.stdout).trim();
          const stderrText = truncateOutput(remoteRun.result.stderr).trim();
          const outputPreview = stdoutText ? `STDOUT:\n${stdoutText}` : stderrText ? `STDERR:\n${stderrText}` : 'No output.';
          
          return {
            success: true,
            message: `Remote managed install completed on '${remoteRun.target.profileName}'. ${outputPreview}`,
            output: buildRemoteExecutionOutput(remoteRun.result),
          };
        }
      }

      if (!context.packageInstallTrust) {
        return { success: false, error: 'Managed package install trust is not available in this Guardian runtime.' };
      }
      const allowCaution = !!args.allowCaution;
      context.guardAction(request, 'execute_command', {
        command,
        cwd: resolvedCwd,
        managed: true,
        tool: 'package_install',
        allowCaution,
      });
      const result = await context.packageInstallTrust.runManagedInstall({
        command,
        cwd: resolvedCwd,
        allowCaution,
      });
      if (!result.success) {
        return {
          success: false,
          error: result.message,
        };
      }
      return {
        success: true,
        message: result.message,
        output: {
          status: result.status,
          alertId: result.alertId,
          event: result.event,
          message: result.message,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'shell_safe',
      description: 'Run an allowlisted shell command from the workspace root. Command prefix must match allowedCommands list. Max 60s timeout, 1MB output buffer. Security: command validated against allowlist before execution; simple direct-binary commands use structured direct exec when possible; inline interpreter eval, package launchers, and shell-expression launchers are blocked. Mutating — requires approval. Requires execute_commands capability.',
      shortDescription: 'Run an allowlisted shell command. Returns stdout, stderr, exit code.',
      risk: 'mutating',
      category: 'shell',
      examples: [
        { input: { command: 'git status' }, description: 'Check git repository status' },
        { input: { command: 'npm test', timeoutMs: 30000 }, description: 'Run tests with 30s timeout' },
      ],
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
          cwd: { type: 'string', description: 'Optional working directory inside allowed paths. Defaults to workspace root.' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (max 60000).' },
        },
        required: ['command'],
      },
    },
    async (args, request) => {
      const command = requireString(args.command, 'command').trim();
      const cwd = args.cwd
        ? await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request)
        : context.getEffectiveWorkspaceRoot(request);
      const shellCheck = context.validateShellCommandForRequest(command, request, cwd);
      if (!shellCheck.safe) {
        return {
          success: false,
          error: shellCheck.reason ?? `Command is not allowlisted: '${command}'.`,
        };
      }
      const degradedPackageManagerReason = context.getDegradedPackageManagerBlockReason(command);
      if (degradedPackageManagerReason) {
        return {
          success: false,
          error: degradedPackageManagerReason,
        };
      }
      if (!shellCheck.plan) {
        return {
          success: false,
          error: 'Command failed execution planning.',
        };
      }
      const timeoutMs = Math.max(500, Math.min(60_000, asNumber(args.timeoutMs, 15_000)));
      const env = context.getCodeWorkspaceRoot(request)
        ? context.buildCodeShellEnv(context.getEffectiveWorkspaceRoot(request))
        : undefined;
      const executionPlan = await context.finalizeShellCommandPlan(shellCheck.plan, cwd, env);
      const executionMetadata = {
        entryCommand: executionPlan.entryCommand,
        argv: executionPlan.argv,
        executionClass: executionPlan.executionClass,
        requestedViaShell: executionPlan.requestedViaShell,
        execMode: executionPlan.execMode,
        resolvedExecutable: executionPlan.resolvedExecutable,
      };
      const dependencyTracking = context.prepareJsDependencyTracking(shellCheck.plan.commands, cwd, request);
      context.guardAction(request, 'execute_command', {
        command,
        cwd,
        ...executionMetadata,
      });
      try {
        const { stdout, stderr } = executionPlan.execMode === 'direct_exec'
          ? await context.sandboxExecFile(
            executionPlan.resolvedExecutable ?? executionPlan.entryCommand,
            executionPlan.argv,
            'workspace-write',
            {
              cwd,
              timeout: timeoutMs,
              maxBuffer: 1_000_000,
              env,
            },
          )
          : await context.sandboxExec(command, 'workspace-write', {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 1_000_000,
            env,
          });
        context.finalizeJsDependencyTracking(dependencyTracking, command);
        return {
          success: true,
          output: {
            command,
            cwd,
            entryCommand: executionPlan.entryCommand,
            argv: executionPlan.argv,
            executionClass: executionPlan.executionClass,
            requestedViaShell: executionPlan.requestedViaShell,
            execMode: executionPlan.execMode,
            resolvedExecutable: executionPlan.resolvedExecutable,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Command failed: ${message}`,
        };
      }
    },
  );

  context.registry.register(
    {
      name: 'code_session_list',
      description: 'List backend-owned coding sessions for the current user. Use this when the user wants to continue, inspect, or compare existing coding work across web, CLI, or Telegram.',
      shortDescription: 'List the current user\'s backend-owned coding sessions.',
      risk: 'read_only',
      category: 'coding',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum sessions to return (default 20).' },
        },
      },
    },
    async (args, request) => {
      const sessions = context.listOwnedCodeSessions(request)
        .slice(0, Math.max(1, Math.min(50, asNumber(args.limit, 20))))
        .map((session) => context.summarizeCodeSession(session));
      return {
        success: true,
        output: { sessions },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_session_current',
      description: 'Show the current coding session for this user. Surfaces use the shared same-principal focus by default, so web, CLI, and Telegram stay aligned unless a request explicitly targets another session.',
      shortDescription: 'Show the current coding session for this user across chat surfaces.',
      risk: 'read_only',
      category: 'coding',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async (_args, request) => {
      if (!context.codeSessionStore) {
        return { success: false, error: 'Code session store is not available.' };
      }
      const explicitCurrentSession = context.getCurrentCodeSessionRecord(request);
      if (explicitCurrentSession) {
        return {
          success: true,
          output: {
            session: context.summarizeCodeSession(explicitCurrentSession),
            attached: true,
          },
        };
      }
      let userId = request.userId?.trim();
      if (userId?.startsWith('code-session:') || userId?.startsWith('delegated-task:') || userId?.startsWith('sched-task:')) {
        userId = request.principalId?.trim() ?? userId;
      }
      const channel = request.channel?.trim();
      if (!userId || !channel) {
        return { success: false, error: 'Current user context is unavailable.' };
      }
      const resolved = context.codeSessionStore.resolveForRequest({
        userId,
        principalId: request.principalId,
        channel,
        surfaceId: context.getCodeSessionSurfaceId(request),
        touchAttachment: false,
      });
      return {
        success: true,
        output: {
          session: resolved ? context.summarizeCodeSession(resolved.session) : null,
          attached: !!resolved,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_session_create',
      description: 'Create a backend-owned coding session for a workspace. Use this to start repo-scoped coding work that can later be resumed from other channels.',
      shortDescription: 'Create a backend-owned coding session for a workspace.',
      risk: 'read_only',
      category: 'coding',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Human-readable title for the coding session.' },
          workspaceRoot: { type: 'string', description: 'Workspace or repo root for the coding session.' },
          attach: { type: 'boolean', description: 'Attach the current chat surface to the new coding session.' },
        },
        required: ['title', 'workspaceRoot'],
      },
    },
    async (args, request) => {
      if (!context.codeSessionStore) {
        return { success: false, error: 'Code session store is not available.' };
      }
      let ownerUserId = request.userId?.trim();
      if (ownerUserId?.startsWith('code-session:') || ownerUserId?.startsWith('delegated-task:') || ownerUserId?.startsWith('sched-task:')) {
        ownerUserId = request.principalId?.trim() ?? ownerUserId;
      }
      const channel = request.channel?.trim();
      if (!ownerUserId || !channel) {
        return { success: false, error: 'Current user context is unavailable.' };
      }
      const session = context.codeSessionStore.createSession({
        ownerUserId,
        ownerPrincipalId: request.principalId,
        title: requireString(args.title, 'title'),
        workspaceRoot: requireString(args.workspaceRoot, 'workspaceRoot'),
      });
      if (args.attach !== false) {
        context.codeSessionStore.attachSession({
          sessionId: session.id,
          userId: ownerUserId,
          principalId: request.principalId,
          channel,
          surfaceId: context.getCodeSessionSurfaceId(request),
          mode: 'controller',
        });
      }
      return {
        success: true,
        output: {
          session: context.summarizeCodeSession(session),
          attached: args.attach !== false,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_session_attach',
      description: 'Attach this chat surface to an existing backend-owned coding session so later messages share that coding workspace and conversation context.',
      shortDescription: 'Attach this chat surface to an existing coding session.',
      risk: 'read_only',
      category: 'coding',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The code session target to attach to. This can be an id, title, or workspace path match.' },
        },
        required: ['sessionId'],
      },
    },
    async (args, request) => {
      if (!context.codeSessionStore) {
        return { success: false, error: 'Code session store is not available.' };
      }
      let ownerUserId = request.userId?.trim();
      if (ownerUserId?.startsWith('code-session:') || ownerUserId?.startsWith('delegated-task:') || ownerUserId?.startsWith('sched-task:')) {
        ownerUserId = request.principalId?.trim() ?? ownerUserId;
      }
      const channel = request.channel?.trim();
      if (!ownerUserId || !channel) {
        return { success: false, error: 'Current user context is unavailable.' };
      }
      const target = requireString(args.sessionId, 'sessionId').trim();
      const resolved = context.resolveOwnedCodeSessionTarget(target, request);
      if (!resolved.session) {
        return { success: false, error: resolved.error ?? `Code session '${target}' was not found for the current user.` };
      }
      const session = resolved.session;
      const attachment = context.codeSessionStore.attachSession({
        sessionId: session.id,
        userId: ownerUserId,
        principalId: request.principalId,
        channel,
        surfaceId: context.getCodeSessionSurfaceId(request),
        mode: 'controller',
      });
      return {
        success: true,
        output: {
          session: context.summarizeCodeSession(session),
          attachment,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_session_detach',
      description: 'Detach this chat surface from its current backend-owned coding session.',
      shortDescription: 'Detach this chat surface from the current coding session.',
      risk: 'read_only',
      category: 'coding',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async (_args, request) => {
      if (!context.codeSessionStore) {
        return { success: false, error: 'Code session store is not available.' };
      }
      let ownerUserId = request.userId?.trim();
      if (ownerUserId?.startsWith('code-session:') || ownerUserId?.startsWith('delegated-task:') || ownerUserId?.startsWith('sched-task:')) {
        ownerUserId = request.principalId?.trim() ?? ownerUserId;
      }
      const channel = request.channel?.trim();
      if (!ownerUserId || !channel) {
        return { success: false, error: 'Current user context is unavailable.' };
      }
      const detached = context.codeSessionStore.detachSession({
        userId: ownerUserId,
        principalId: request.principalId,
        channel,
        surfaceId: context.getCodeSessionSurfaceId(request),
      });
      return {
        success: true,
        output: { detached },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_symbol_search',
      description: 'Search code symbols, identifiers, or text patterns inside a project tree. Delegates to filesystem search with code-oriented defaults.',
      shortDescription: 'Search symbols or identifiers in source trees.',
      risk: 'read_only',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project or source root to search.' },
          query: { type: 'string', description: 'Symbol, identifier, or text to search for.' },
          mode: { type: 'string', description: "Search mode: 'name', 'content', or 'auto' (default: auto)." },
          maxResults: { type: 'number', description: 'Maximum matches to return (default 25).' },
        },
        required: ['query'],
      },
    },
    async (args, request) => {
      const delegate = context.registry.get('fs_search');
      if (!delegate) return { success: false, error: 'fs_search is not available' };
      return delegate.handler({
        path: asString(args.path, '.'),
        query: args.query,
        mode: asString(args.mode, 'auto'),
        maxResults: asNumber(args.maxResults, 25),
        maxDepth: 20,
        maxFiles: 25_000,
        maxFileBytes: 1_000_000,
      }, request);
    },
  );

  context.registry.register(
    {
      name: 'code_edit',
      description: 'Apply a targeted code edit using OpenDev-style progressive matching. Tries exact, line-ending-normalized, trimmed-line, indentation-insensitive, and whitespace-collapsed matching before failing.',
      shortDescription: 'Apply a targeted code edit with progressive block matching.',
      risk: 'mutating',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit.' },
          oldString: { type: 'string', description: 'Existing code block to replace.' },
          newString: { type: 'string', description: 'Replacement code block.' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const oldString = requireStringAllowEmpty(args.oldString, 'oldString');
      const newString = requireStringAllowEmpty(args.newString, 'newString');
      const safePath = await context.resolveAllowedPath(rawPath, request);
      const source = await readFile(safePath, 'utf-8');
      const match = findCodeEditRange(source, oldString);
      if (!match) {
        return {
          success: false,
          error: 'Unable to match oldString in target file after progressive code matching passes.',
        };
      }
      const next = source.slice(0, match.start) + newString + source.slice(match.end);
      const contentScan = scanWriteContent(next);
      if (contentScan.secrets.length > 0 || contentScan.pii.length > 0) {
        const findings = [
          ...new Set(contentScan.secrets.map((entry) => entry.pattern)),
          ...new Set(contentScan.pii.map((entry) => entry.label)),
        ];
        return {
          success: false,
          error: `Edited file rejected by security policy: ${findings.join(', ')}.`,
        };
      }
      context.guardAction(request, 'write_file', { path: rawPath, content: next });
      await writeFile(safePath, next, 'utf-8');
      const qualityReport = await buildCodingQualityReportForFiles(context, [safePath], dirname(safePath));
      return {
        success: true,
        output: {
          path: safePath,
          strategy: match.strategy,
          bytes: Buffer.byteLength(next, 'utf-8'),
          qualityReport,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_patch',
      description: 'Apply a unified diff patch inside the workspace. Validates patch target paths and uses git apply semantics when available.',
      shortDescription: 'Apply a unified diff patch in the workspace.',
      risk: 'mutating',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project root to apply the patch from. Defaults to workspace root.' },
          patch: { type: 'string', description: 'Unified diff patch to apply.' },
        },
        required: ['patch'],
      },
    },
    async (args, request) => {
      const patch = requireString(args.patch, 'patch');
      const cwd = args.cwd
        ? await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request)
        : context.getEffectiveWorkspaceRoot(request);
      const targets = extractPatchTargets(patch);
      if (targets.length === 0) {
        return { success: false, error: 'Patch did not contain any target files.' };
      }
      const resolvedTargets = await Promise.all(targets.map((target) => context.resolveAllowedPath(resolve(cwd, target), request)));
      context.guardAction(request, 'write_file', { cwd, files: targets, patch });

      const patchDir = resolve(context.getEffectiveWorkspaceRoot(request), '.guardianagent', 'tmp');
      await mkdir(patchDir, { recursive: true });
      const patchFile = resolve(patchDir, `patch-${randomUUID()}.diff`);
      await writeFile(patchFile, patch, 'utf-8');
      try {
        const env = context.getCodeWorkspaceRoot(request)
          ? context.buildCodeShellEnv(context.getEffectiveWorkspaceRoot(request))
          : undefined;
        await context.sandboxExecFile('git', ['apply', '--whitespace=nowarn', patchFile], 'workspace-write', {
          cwd,
          timeout: 30_000,
          maxBuffer: 500_000,
          env,
        });
      } catch (err) {
        return {
          success: false,
          error: `Patch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        await rm(patchFile, { force: true }).catch(() => undefined);
      }

      const qualityReport = await buildCodingQualityReportForFiles(context, resolvedTargets, cwd);
      return {
        success: true,
        output: {
          cwd,
          files: targets,
          qualityReport,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_create',
      description: 'Create a new source file inside the allowed workspace. Fails if the file already exists unless overwrite=true is provided.',
      shortDescription: 'Create a new source file in the workspace.',
      risk: 'mutating',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to create.' },
          content: { type: 'string', description: 'Initial file contents.' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing file.' },
        },
        required: ['path', 'content'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const overwrite = !!args.overwrite;
      const safePath = await context.resolveAllowedPath(rawPath, request);
      try {
        await stat(safePath);
        if (!overwrite) {
          return {
            success: false,
            error: 'Target file already exists. Pass overwrite=true to replace it.',
          };
        }
      } catch {
        // File does not exist yet.
      }

      const delegate = context.registry.get('fs_write');
      if (!delegate) return { success: false, error: 'fs_write is not available' };
      const result = await delegate.handler({
        path: rawPath,
        content: requireStringAllowEmpty(args.content, 'content'),
        append: false,
      }, request);
      if (!result.success) return result;
      const qualityReport = await buildCodingQualityReportForFiles(context, [safePath], dirname(safePath));
      return {
        ...result,
        output: {
          ...(isRecord(result.output) ? result.output : {}),
          qualityReport,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'code_plan',
      description: 'Generate a structured implementation plan for a coding task before making changes. Read-only helper for complex tasks.',
      shortDescription: 'Generate a structured coding plan.',
      risk: 'read_only',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task or coding objective to plan.' },
          cwd: { type: 'string', description: 'Project root or working directory.' },
          selectedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of files already identified as relevant.',
          },
        },
        required: ['task'],
      },
    },
    async (args, request) => {
      const task = requireString(args.task, 'task');
      const cwd = args.cwd
        ? await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request)
        : context.getEffectiveWorkspaceRoot(request);
      const selectedFiles = Array.isArray(args.selectedFiles)
        ? args.selectedFiles.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      return {
        success: true,
        output: buildCodingWorkflowPlan(task, cwd, selectedFiles, context.getRemoteExecutionTargets?.() ?? [], context.cloudConfig?.defaultRemoteExecutionTargetId),
      };
    },
  );

  context.registry.register(
    {
      name: 'code_remote_exec',
      description: 'Run one bounded repo command inside the configured remote sandbox instead of on the host. This is the explicit isolated execution lane for setup, install, build, test, scan, or other higher-risk repo work. IMPORTANT: Always report the exact stdout/stderr from the tool output to the user, do not infer the result from your arguments. IMPORTANT: If a command fails and requires an approval-gated follow-up (like fixing missing domains or installing packages), you MUST write a chat message explaining the failure and your plan BEFORE you attempt the fix.',
      shortDescription: 'Run a bounded coding command in the configured remote sandbox.',
      risk: 'mutating',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Allowlisted command to run in the remote sandbox.' },
          cwd: { type: 'string', description: 'Project root or working directory to stage and run from. Defaults to the current workspace root.' },
          profile: { type: 'string', description: 'Optional remote execution profile id. Omit it to use the configured default remote sandbox when one is set; otherwise the first ready target is used.' },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional relative paths from cwd to limit which files are staged into the sandbox.',
          },
          artifactPaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional file paths, relative to cwd, to read back from the remote sandbox after the command finishes.',
          },
          timeoutMs: { type: 'number', description: 'Remote execution timeout in milliseconds (max 900000).' },
          vcpus: { type: 'number', description: 'Optional vCPU override for the remote sandbox.' },
          verificationRun: { type: 'boolean', description: 'When true, treat a successful remote run as verification evidence for the workflow.' },
        },
        required: ['command'],
      },
    },
    async (args, request) => {
      const command = requireString(args.command, 'command').trim();
      const cwd = args.cwd
        ? await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request)
        : context.getEffectiveWorkspaceRoot(request);
      const remoteRun = await runRemoteCodingCommand(context, {
        request,
        command,
        cwd,
        profileId: asString(args.profile).trim() || undefined,
        includePaths: stringArrayArg(args.includePaths),
        artifactPaths: stringArrayArg(args.artifactPaths),
        timeoutMs: Math.max(1_000, Math.min(900_000, asNumber(args.timeoutMs, 300_000))),
        vcpus: args.vcpus === undefined ? undefined : Math.max(1, Math.min(8, asNumber(args.vcpus, 2))),
      });
        if (!remoteRun.success) {
          return { success: false, error: remoteRun.error };
        }
        if (remoteRun.result.status !== 'succeeded') {
          return {
            success: false,
            error: formatRemoteExecutionFailure(remoteRun.result),
            output: buildRemoteExecutionOutput(remoteRun.result),
          };
        }
      const verificationRun = args.verificationRun === true;
      const stdoutText = truncateOutput(remoteRun.result.stdout).trim();
      const stderrText = truncateOutput(remoteRun.result.stderr).trim();
      const outputPreview = stdoutText ? `STDOUT:\n${stdoutText}` : stderrText ? `STDERR:\n${stderrText}` : 'No output.';
      
      return {
        success: true,
        message: `Remote sandbox command completed on '${remoteRun.target.profileName}'. ${outputPreview}`,
        output: buildRemoteExecutionOutput(remoteRun.result),
        ...(verificationRun
          ? {
              verificationStatus: 'verified' as const,
              verificationEvidence: `Remote sandbox run succeeded on '${remoteRun.target.profileName}'.`,
            }
          : {}),
      };
    },
  );

  context.registry.register(
    {
      name: 'code_git_diff',
      description: 'Show git diff output for the current project or a specific file path. Executes from a validated working directory.',
      shortDescription: 'Show git diff for a project or file.',
      risk: 'read_only',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project root to run git diff from.' },
          path: { type: 'string', description: 'Optional path to limit diff to a file or directory.' },
          staged: { type: 'boolean', description: 'Use --staged when true.' },
        },
        required: ['cwd'],
      },
    },
    async (args, request) => {
      const cwd = await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request);
      const staged = !!args.staged;
      const timeoutMs = Math.max(500, Math.min(60_000, asNumber(args.timeoutMs, 15_000)));
      const gitArgs = ['diff'];
      if (staged) gitArgs.push('--staged');
      const maybePath = asString(args.path, '').trim();
      if (maybePath) {
        const resolvedPath = await context.resolveAllowedPath(resolve(cwd, maybePath), request);
        const relativePath = relative(cwd, resolvedPath).replace(/\\/g, '/');
        gitArgs.push('--', relativePath || '.');
      }
      try {
        const env = context.getCodeWorkspaceRoot(request)
          ? context.buildCodeShellEnv(context.getEffectiveWorkspaceRoot(request))
          : undefined;
        const { stdout, stderr } = await context.sandboxExecFile('git', gitArgs, 'read-only', {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
          env,
        });
        return {
          success: true,
          output: {
            command: ['git', ...gitArgs].join(' '),
            cwd,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `git diff failed: ${message}`,
        };
      }
    },
  );

  context.registry.register(
    {
      name: 'code_git_commit',
      description: 'Stage changes and create a git commit from a validated project directory. Mutating and approval-gated.',
      shortDescription: 'Stage changes and create a git commit.',
      risk: 'mutating',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project root to commit from.' },
          message: { type: 'string', description: 'Commit message.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional relative paths to stage. Defaults to all changes.',
          },
        },
        required: ['cwd', 'message'],
      },
    },
    async (args, request) => {
      const cwd = await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request);
      const message = requireString(args.message, 'message').trim();
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      if (!message) {
        return { success: false, error: 'Commit message is required.' };
      }
      for (const target of paths) {
        await context.resolveAllowedPath(resolve(cwd, target), request);
      }
      context.guardAction(request, 'execute_command', { command: 'git commit', cwd, message, paths });
      const relativePaths = paths.length > 0
        ? await Promise.all(paths.map(async (target) => {
            const resolvedPath = await context.resolveAllowedPath(resolve(cwd, target), request);
            return relative(cwd, resolvedPath).replace(/\\/g, '/') || '.';
          }))
        : [];
      try {
        const env = context.getCodeWorkspaceRoot(request)
          ? context.buildCodeShellEnv(context.getEffectiveWorkspaceRoot(request))
          : undefined;
        await context.sandboxExecFile('git', relativePaths.length > 0 ? ['add', '--', ...relativePaths] : ['add', '-A'], 'workspace-write', {
          cwd,
          timeout: 30_000,
          maxBuffer: 500_000,
          env,
        });
        const { stdout, stderr } = await context.sandboxExecFile('git', ['commit', '-m', message], 'workspace-write', {
          cwd,
          timeout: 30_000,
          maxBuffer: 500_000,
          env,
        });
        return {
          success: true,
          output: {
            cwd,
            message,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `git commit failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  );

  for (const toolName of ['code_test', 'code_build', 'code_lint'] as const) {
    const descriptions: Record<typeof toolName, { description: string; shortDescription: string }> = {
      code_test: {
        description: 'Run an allowlisted test command inside a validated project directory. IMPORTANT: If tests fail because dependencies are missing, you MUST write a chat message explaining that dependencies are missing BEFORE you attempt to run package_install or npm ci.',
        shortDescription: 'Run tests from a project directory.',
      },
      code_build: {
        description: 'Run an allowlisted build command inside a validated project directory. IMPORTANT: If the build fails because dependencies are missing, you MUST write a chat message explaining that dependencies are missing BEFORE you attempt to run package_install or npm ci.',
        shortDescription: 'Run a build command from a project directory.',
      },
      code_lint: {
        description: 'Run an allowlisted lint or static analysis command inside a validated project directory. IMPORTANT: If linting fails because dependencies are missing, you MUST write a chat message explaining that dependencies are missing BEFORE you attempt to run package_install or npm ci.',
        shortDescription: 'Run lint or static analysis from a project directory.',
      },
    };

    context.registry.register(
      {
        name: toolName,
        description: descriptions[toolName].description,
        shortDescription: descriptions[toolName].shortDescription,
        risk: 'mutating',
        category: 'coding',
        deferLoading: true,
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: toolName === 'code_build' ? 'Project root to run the build from.' : toolName === 'code_lint' ? 'Project root to run the command from.' : 'Project root to run tests from.' },
            command: { type: 'string', description: toolName === 'code_lint' ? 'Allowlisted lint command to execute.' : toolName === 'code_build' ? 'Allowlisted build command to execute.' : 'Allowlisted test command to execute.' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Local runs cap at 60000; remote runs cap at 900000.' },
            isolation: {
              type: 'string',
              description: "Execution lane: 'local' (default), 'remote_if_available', or 'remote_required'.",
            },
            remoteProfile: {
              type: 'string',
              description: 'Optional remote execution profile id when isolation uses the remote sandbox.',
            },
            includePaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional relative paths from cwd to limit which files are staged for a remote run.',
            },
            artifactPaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional file paths, relative to cwd, to read back after a remote run.',
            },
            vcpus: {
              type: 'number',
              description: 'Optional remote sandbox vCPU override when isolation uses the remote lane.',
            },
          },
          required: ['cwd', 'command'],
        },
      },
      async (args, request) => {
        let isolation = normalizeRemoteIsolationMode(args.isolation);
        const remoteProfile = asString(args.remoteProfile).trim() || undefined;
        const command = requireString(args.command, 'command');

        // Automatic tier promotion if a remote execution target is available
        const hasRemoteTarget = context.resolveRemoteExecutionTarget && (await context.resolveRemoteExecutionTarget(remoteProfile, command, request.codeContext?.workspaceRoot)) != null;
        if (isolation === 'local' && hasRemoteTarget && !args.isolation) {
          isolation = 'remote_if_available';
        }

        if (isolation !== 'local' && context.resolveRemoteExecutionTarget && context.runRemoteExecutionJob) {
          const remoteTarget = await context.resolveRemoteExecutionTarget(remoteProfile, command, request.codeContext?.workspaceRoot);
          if (remoteTarget) {
            const remoteRun = await runRemoteCodingCommand(context, {
              request,
              command,
              cwd: await context.resolveAllowedPath(requireString(args.cwd, 'cwd'), request),
              profileId: remoteTarget.profileId,
              includePaths: stringArrayArg(args.includePaths),
              artifactPaths: stringArrayArg(args.artifactPaths),
              timeoutMs: Math.max(1_000, Math.min(900_000, asNumber(args.timeoutMs, 300_000))),
              vcpus: args.vcpus === undefined ? undefined : Math.max(1, Math.min(8, asNumber(args.vcpus, 2))),
              installDependencies: true,
            });
            if (!remoteRun.success) {
              return { success: false, error: remoteRun.error };
            }
            if (remoteRun.result.status !== 'succeeded') {
              return {
                success: false,
                error: formatRemoteExecutionFailure(remoteRun.result),
                output: buildRemoteExecutionOutput(remoteRun.result),
              };
            }
            
            const stdoutText = truncateOutput(remoteRun.result.stdout).trim();
            const stderrText = truncateOutput(remoteRun.result.stderr).trim();
            const outputPreview = stdoutText ? `STDOUT:\n${stdoutText}` : stderrText ? `STDERR:\n${stderrText}` : 'No output.';

            return {
              success: true,
              message: `Remote sandbox ${toolName.slice(5)} run completed on '${remoteRun.target.profileName}'. ${outputPreview}`,
              output: buildRemoteExecutionOutput(remoteRun.result),
              verificationStatus: 'verified',
              verificationEvidence: `Remote ${toolName.slice(5)} run passed on '${remoteRun.target.profileName}'.`,
            };
          }
          if (isolation === 'remote_required' || remoteProfile) {
            return {
              success: false,
              error: remoteProfile
                ? `Remote execution target '${remoteProfile}' is not ready.`
                : 'No ready remote execution target is configured.',
            };
          }
        } else if (isolation === 'remote_required') {
          return { success: false, error: 'Remote execution is not available in this Guardian runtime.' };
        }

        const delegate = context.registry.get('shell_safe');
        if (!delegate) return { success: false, error: 'shell_safe is not available' };
        return delegate.handler({
          command: requireString(args.command, 'command'),
          cwd: requireString(args.cwd, 'cwd'),
          timeoutMs: asNumber(args.timeoutMs, 30_000),
        }, request);
      },
    );
  }

  context.registry.register(
    {
      name: 'coding_backend_list',
      description: 'List available external coding CLI backends (Claude Code, Codex, Gemini CLI, etc.) and their status.',
      shortDescription: 'List configured coding backends.',
      risk: 'read_only',
      category: 'coding',
      deferLoading: true,
      parameters: { type: 'object', properties: {} },
    },
    async () => {
      const codingBackendService = resolveCodingBackendService(context);
      if (!codingBackendService) {
        return { success: false, error: 'Coding backend orchestration is not enabled. Enable it in Configuration > Integrations > Coding Assistants.' };
      }
      const backends = codingBackendService.listBackends();
      return {
        success: true,
        output: {
          backends: backends.map((backend) => ({
            id: backend.id,
            name: backend.name,
            enabled: backend.enabled,
            command: backend.command,
            preset: backend.preset ?? false,
            installedVersion: backend.installedVersion,
            updateAvailable: backend.updateAvailable,
          })),
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'coding_backend_run',
      description: 'Launch an external coding CLI (Claude Code, Codex, Gemini CLI, etc.) to perform a coding task in the current workspace. Opens a visible terminal tab so the user can observe progress. Returns structured results when the CLI finishes. After the backend completes, verify the work using code_git_diff, code_test, or code_build.',
      shortDescription: 'Delegate a coding task to an external coding CLI.',
      risk: 'mutating',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The coding task to delegate to the external CLI.' },
          backend: { type: 'string', description: 'Backend id (e.g. claude-code, codex, gemini-cli). Uses the default backend if omitted.' },
        },
        required: ['task'],
      },
      examples: [
        { input: { task: 'Add unit tests for the auth module', backend: 'claude-code' }, description: 'Delegate test authoring to Claude Code' },
        { input: { task: 'Fix the TypeScript compilation errors in src/api/' }, description: 'Delegate bug fix to default backend' },
      ],
    },
    async (args, request) => {
      const codingBackendService = resolveCodingBackendService(context);
      if (!codingBackendService) {
        return { success: false, error: 'Coding backend orchestration is not enabled. Enable it in Configuration > Integrations > Coding Assistants.' };
      }
      const task = requireString(args.task, 'task');
      const backendId = typeof args.backend === 'string' ? args.backend.trim() : undefined;
      const codeSessionId = request.codeContext?.sessionId;
      if (!codeSessionId) {
        return { success: false, error: 'No active coding session. Create or attach to a coding session first.' };
      }
      const session = context.getCurrentCodeSessionRecord(request);
      const workspaceRoot = session?.resolvedRoot || session?.workspaceRoot;
      if (!workspaceRoot) {
        return { success: false, error: 'Could not determine workspace root for the current coding session.' };
      }
      const result = await codingBackendService.run({
        task,
        backendId,
        codeSessionId,
        workspaceRoot,
        requestId: request.requestId,
      });
      return {
        success: result.success,
        output: result,
      };
    },
  );

  context.registry.register(
    {
      name: 'coding_backend_status',
      description: 'Check the status of active or recent coding backend sessions in the current workspace.',
      shortDescription: 'Check status of coding backend sessions.',
      risk: 'read_only',
      category: 'coding',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Specific backend session id. Lists all recent if omitted.' },
        },
      },
    },
    async (args, request) => {
      const codingBackendService = resolveCodingBackendService(context);
      if (!codingBackendService) {
        return { success: false, error: 'Coding backend orchestration is not enabled.' };
      }
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : undefined;
      const codeSessionId = request.codeContext?.sessionId?.trim();
      const sessions = codingBackendService
        .getStatus(sessionId)
        .filter((session) => sessionId || !codeSessionId || session.codeSessionId === codeSessionId);
      return {
        success: true,
        output: { sessions },
      };
    },
  );
}
