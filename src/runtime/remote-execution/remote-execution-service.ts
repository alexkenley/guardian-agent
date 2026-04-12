import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import path from 'node:path';

import type {
  RemoteExecutionPreparedRequest,
  RemoteExecutionProvider,
  RemoteExecutionRunRequest,
  RemoteExecutionRunResult,
  RemoteExecutionServiceLike,
  RemoteExecutionStagedFile,
} from './types.js';

const REMOTE_WORKSPACE_ROOT = '/workspace';
const DEFAULT_MAX_STAGED_FILES = 2_000;
const DEFAULT_MAX_STAGED_BYTES = 25 * 1024 * 1024;
const ALWAYS_EXCLUDED_NAMES = new Set(['.git']);
const DEFAULT_EXCLUDED_NAMES = new Set([
  '.guardianagent',
  '.next',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

export interface RemoteExecutionServiceOptions {
  providers: RemoteExecutionProvider[];
  defaultMaxFiles?: number;
  defaultMaxBytes?: number;
}

interface PreparedWorkspace {
  workspaceRoot: string;
  cwd: string;
  stagedFiles: RemoteExecutionStagedFile[];
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toRemoteWorkspacePath(localPath: string, workspaceRoot: string): string {
  const relativePath = normalizeRemotePath(relative(workspaceRoot, localPath));
  return relativePath
    ? path.posix.join(REMOTE_WORKSPACE_ROOT, relativePath)
    : REMOTE_WORKSPACE_ROOT;
}

function isExcludedName(name: string, applyDefaultExcludes: boolean): boolean {
  if (ALWAYS_EXCLUDED_NAMES.has(name)) return true;
  return applyDefaultExcludes && DEFAULT_EXCLUDED_NAMES.has(name);
}

function sanitizeExecutableMode(mode: number): number | undefined {
  const normalized = mode & 0o777;
  return (normalized & 0o111) !== 0 ? normalized : undefined;
}

export class RemoteExecutionService implements RemoteExecutionServiceLike {
  private readonly providers = new Map<RemoteExecutionProvider['backendKind'], RemoteExecutionProvider>();
  private readonly defaultMaxFiles: number;
  private readonly defaultMaxBytes: number;

  constructor(options: RemoteExecutionServiceOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.backendKind, provider);
    }
    this.defaultMaxFiles = Math.max(50, options.defaultMaxFiles ?? DEFAULT_MAX_STAGED_FILES);
    this.defaultMaxBytes = Math.max(1_000_000, options.defaultMaxBytes ?? DEFAULT_MAX_STAGED_BYTES);
  }

  async runBoundedJob(request: RemoteExecutionRunRequest): Promise<RemoteExecutionRunResult> {
    const provider = this.providers.get(request.target.backendKind);
    if (!provider) {
      throw new Error(`No remote execution provider is registered for backend '${request.target.backendKind}'.`);
    }
    const prepared = await this.prepareRequest(request);
    return provider.run(prepared);
  }

  private async prepareRequest(request: RemoteExecutionRunRequest): Promise<RemoteExecutionPreparedRequest> {
    const workspace = await this.prepareWorkspace(request.workspace);
    return {
      ...request,
      workspaceRoot: workspace.workspaceRoot,
      cwd: workspace.cwd,
      stagedFiles: workspace.stagedFiles,
    };
  }

  private async prepareWorkspace(input: RemoteExecutionRunRequest['workspace']): Promise<PreparedWorkspace> {
    const workspaceRoot = resolve(input.workspaceRoot);
    const cwd = resolve(input.cwd);
    if (!isPathInsideRoot(cwd, workspaceRoot)) {
      throw new Error(`Remote execution cwd '${cwd}' is outside workspace root '${workspaceRoot}'.`);
    }

    const explicitIncludes = Array.isArray(input.includePaths)
      ? input.includePaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const maxFiles = Math.max(1, input.maxFiles ?? this.defaultMaxFiles);
    const maxBytes = Math.max(1_024, input.maxBytes ?? this.defaultMaxBytes);
    const stagedByRemotePath = new Map<string, RemoteExecutionStagedFile>();
    let stagedBytes = 0;

    const stageFile = async (filePath: string): Promise<void> => {
      const absolutePath = resolve(filePath);
      if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
        throw new Error(`Remote execution path '${absolutePath}' is outside workspace root '${workspaceRoot}'.`);
      }
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        return;
      }
      if (stats.isDirectory()) {
        return;
      }
      if (!stats.isFile()) {
        return;
      }
      const remotePath = toRemoteWorkspacePath(absolutePath, workspaceRoot);
      if (stagedByRemotePath.has(remotePath)) {
        return;
      }
      const content = await readFile(absolutePath);
      const nextBytes = stagedBytes + content.length;
      if (stagedByRemotePath.size + 1 > maxFiles) {
        throw new Error(
          `Remote execution staging exceeded the ${maxFiles}-file limit. Narrow the run with includePaths.`,
        );
      }
      if (nextBytes > maxBytes) {
        throw new Error(
          `Remote execution staging exceeded the ${(maxBytes / (1024 * 1024)).toFixed(1)} MB limit. Narrow the run with includePaths.`,
        );
      }
      stagedBytes = nextBytes;
      stagedByRemotePath.set(remotePath, {
        localPath: absolutePath,
        remotePath,
        content,
        mode: sanitizeExecutableMode(stats.mode),
      });
    };

    const walk = async (targetPath: string, applyDefaultExcludes: boolean): Promise<void> => {
      const absolutePath = resolve(targetPath);
      if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
        throw new Error(`Remote execution path '${absolutePath}' is outside workspace root '${workspaceRoot}'.`);
      }
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        return;
      }
      if (stats.isFile()) {
        await stageFile(absolutePath);
        return;
      }
      if (!stats.isDirectory()) {
        return;
      }
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (isExcludedName(entry.name, applyDefaultExcludes)) {
          continue;
        }
        await walk(resolve(absolutePath, entry.name), applyDefaultExcludes);
      }
    };

    if (explicitIncludes.length > 0) {
      for (const includePath of explicitIncludes) {
        const absolutePath = resolve(cwd, includePath);
        if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
          throw new Error(`Remote execution includePath '${includePath}' escapes workspace root '${workspaceRoot}'.`);
        }
        const topLevelName = basename(absolutePath);
        if (ALWAYS_EXCLUDED_NAMES.has(topLevelName)) {
          continue;
        }
        await walk(absolutePath, false);
      }
    } else {
      await walk(workspaceRoot, true);
    }

    return {
      workspaceRoot,
      cwd,
      stagedFiles: [...stagedByRemotePath.values()],
    };
  }
}
