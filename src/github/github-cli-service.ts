import { execFile as execFileCallback, spawn } from 'node:child_process';

import type {
  GitHubCommandResult,
  GitHubAuthStartResult,
  GitHubConfig,
  GitHubIssueCreateInput,
  GitHubIssueCreateResult,
  GitHubServiceLike,
  GitHubStatusResult,
} from './types.js';

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const DEFAULT_GITHUB_CONFIG: Required<Pick<GitHubConfig, 'enabled' | 'mode' | 'cliPath' | 'timeoutMs'>> & {
  allowIssueCreation: boolean;
  allowPullRequestCreation: boolean;
} = {
  enabled: true,
  mode: 'cli',
  cliPath: 'gh',
  timeoutMs: 30_000,
  allowIssueCreation: true,
  allowPullRequestCreation: false,
};

const MAX_LABELS = 10;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 60_000;
const GITHUB_AUTH_ARGS = ['auth', 'login', '--web', '--clipboard', '--hostname', 'github.com', '--git-protocol', 'https'];

function defaultExecFile(
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer };
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function asText(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value ?? '';
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function validateRepositoryPart(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required.`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`${field} may only contain letters, numbers, dot, underscore, or dash.`);
  }
  return trimmed;
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  const normalized = labels
    .map((label) => cleanText(label))
    .filter(Boolean)
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, MAX_LABELS);
  return normalized;
}

function parseIssueUrl(output: string): { url: string; number?: number } {
  const url = output
    .split(/\s+/)
    .map((part) => part.trim())
    .find((part) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/i.test(part));
  if (!url) {
    throw new Error('GitHub did not return a created issue URL.');
  }
  const issueNumber = Number.parseInt(url.slice(url.lastIndexOf('/') + 1), 10);
  return {
    url,
    ...(Number.isFinite(issueNumber) ? { number: issueNumber } : {}),
  };
}

function summarizeGhError(error: unknown): string {
  const err = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer };
  if (err?.code === 'ENOENT') return 'GitHub is not set up on this machine. Install GitHub CLI (`gh`) and sign in, then try again.';
  const stderr = cleanText(asText(err?.stderr));
  const stdout = cleanText(asText(err?.stdout));
  const message = cleanText(err instanceof Error ? err.message : String(error));
  return stderr || stdout || message || 'GitHub command failed.';
}

export class GitHubCliService implements GitHubServiceLike {
  private readonly config: GitHubConfig;
  private readonly execFile: ExecFileLike;

  constructor(config?: GitHubConfig, options?: { execFile?: ExecFileLike }) {
    this.config = {
      ...DEFAULT_GITHUB_CONFIG,
      ...(config ?? {}),
    };
    this.execFile = options?.execFile ?? defaultExecFile;
  }

  private get cliPath(): string {
    return this.config.cliPath?.trim() || DEFAULT_GITHUB_CONFIG.cliPath;
  }

  private get timeoutMs(): number {
    return typeof this.config.timeoutMs === 'number' && this.config.timeoutMs >= 1000
      ? this.config.timeoutMs
      : DEFAULT_GITHUB_CONFIG.timeoutMs;
  }

  private resolveRepository(owner?: string, repo?: string): { owner: string; repo: string; fullName: string } {
    const resolvedOwner = validateRepositoryPart(owner || this.config.defaultOwner || '', 'owner');
    const resolvedRepo = validateRepositoryPart(repo || this.config.defaultRepo || '', 'repo');
    return {
      owner: resolvedOwner,
      repo: resolvedRepo,
      fullName: `${resolvedOwner}/${resolvedRepo}`,
    };
  }

  private tryResolveRepository(owner?: string, repo?: string): { owner: string; repo: string; fullName: string } | null {
    try {
      return this.resolveRepository(owner, repo);
    } catch {
      return null;
    }
  }

  private async gh(args: string[]): Promise<GitHubCommandResult> {
    try {
      const result = await this.execFile(this.cliPath, args, {
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 1_000_000,
      });
      return {
        exitCode: 0,
        stdout: asText(result.stdout),
        stderr: asText(result.stderr),
      };
    } catch (error) {
      const err = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer };
      if (err.code === 'ENOENT') {
        throw error;
      }
      return {
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: asText(err.stdout),
        stderr: asText(err.stderr),
      };
    }
  }

  async status(owner?: string, repo?: string): Promise<GitHubStatusResult> {
    const repository = this.tryResolveRepository(owner, repo);
    const base = {
      enabled: this.config.enabled !== false,
      mode: this.config.mode ?? 'cli',
      cliPath: this.cliPath,
      repositoryConfigured: !!repository,
      ...(repository ? { defaultRepository: repository.fullName } : {}),
    };

    if (this.config.enabled === false) {
      return {
        ...base,
        installed: false,
        authenticated: false,
        repositoryAccessible: false,
        message: 'GitHub integration is disabled in assistant.tools.github.',
      };
    }

    if ((this.config.mode ?? 'cli') !== 'cli') {
      return {
        ...base,
        installed: false,
        authenticated: false,
        repositoryAccessible: false,
        message: `GitHub mode '${this.config.mode}' is not implemented yet. Use mode 'cli'.`,
      };
    }
    let version: string | undefined;
    try {
      const versionResult = await this.gh(['--version']);
      if (versionResult.exitCode !== 0) {
        return {
          ...base,
          installed: false,
          authenticated: false,
          repositoryAccessible: false,
          message: summarizeGhError({ stderr: versionResult.stderr, stdout: versionResult.stdout }),
        };
      }
      version = versionResult.stdout.split(/\r?\n/)[0]?.trim();
    } catch (error) {
      return {
        ...base,
        installed: false,
        authenticated: false,
        repositoryAccessible: false,
        message: summarizeGhError(error),
      };
    }

    const auth = await this.gh(['auth', 'status', '--hostname', 'github.com']);
    if (auth.exitCode !== 0) {
      return {
        ...base,
        installed: true,
        authenticated: false,
        repositoryAccessible: false,
        ...(version ? { version } : {}),
        message: 'GitHub is not authenticated on this machine. Run `gh auth login`, then try again.',
      };
    }

    if (!repository) {
      return {
        ...base,
        installed: true,
        authenticated: true,
        repositoryAccessible: false,
        ...(version ? { version } : {}),
        message: 'GitHub CLI is authenticated. Add an owner and repository only when you want issue reporting or repo workflow actions.',
      };
    }

    const repoView = await this.gh(['repo', 'view', repository.fullName, '--json', 'nameWithOwner,url']);
    if (repoView.exitCode !== 0) {
      return {
        ...base,
        installed: true,
        authenticated: true,
        repositoryAccessible: false,
        ...(version ? { version } : {}),
        message: summarizeGhError({ stderr: repoView.stderr, stdout: repoView.stdout }),
      };
    }

    let repositoryUrl: string | undefined;
    try {
      const parsed = JSON.parse(repoView.stdout) as { url?: string };
      repositoryUrl = typeof parsed.url === 'string' ? parsed.url : undefined;
    } catch {
      repositoryUrl = undefined;
    }

    return {
      ...base,
      installed: true,
      authenticated: true,
      repositoryAccessible: true,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(version ? { version } : {}),
      message: `GitHub is connected and can access ${repository.fullName}.`,
    };
  }

  async createIssue(input: GitHubIssueCreateInput): Promise<GitHubIssueCreateResult> {
    if (this.config.enabled === false) {
      throw new Error('GitHub integration is disabled in assistant.tools.github.');
    }
    if ((this.config.mode ?? 'cli') !== 'cli') {
      throw new Error(`GitHub mode '${this.config.mode}' is not implemented yet. Use mode 'cli'.`);
    }
    if (this.config.allowIssueCreation === false) {
      throw new Error('GitHub issue creation is disabled in assistant.tools.github.allowIssueCreation.');
    }

    const repository = this.resolveRepository(input.owner, input.repo);
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new Error('title is required.');
    if (!body) throw new Error('body is required.');
    if (title.length > MAX_TITLE_LENGTH) throw new Error(`title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
    if (body.length > MAX_BODY_LENGTH) throw new Error(`body must be ${MAX_BODY_LENGTH} characters or fewer.`);

    const labels = normalizeLabels(input.labels);
    const args = ['issue', 'create', '--repo', repository.fullName, '--title', title, '--body', body];
    for (const label of labels) {
      args.push('--label', label);
    }

    const result = await this.gh(args);
    if (result.exitCode !== 0) {
      throw new Error(summarizeGhError({ stderr: result.stderr, stdout: result.stdout }));
    }

    const created = parseIssueUrl(result.stdout);
    return {
      owner: repository.owner,
      repo: repository.repo,
      url: created.url,
      ...(created.number ? { number: created.number } : {}),
      title,
      labels,
    };
  }

  async startAuth(): Promise<GitHubAuthStartResult> {
    const status = await this.status();
    if (status.authenticated) {
      return {
        success: true,
        authUrl: '',
        state: '',
        message: 'GitHub is already connected.',
      };
    }
    if (!status.installed) {
      return {
        success: false,
        authUrl: '',
        state: '',
        message: status.message,
      };
    }

    try {
      const child = spawn(this.cliPath, GITHUB_AUTH_ARGS, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return {
        success: true,
        authUrl: '',
        state: '',
        message: 'GitHub sign-in started in your browser. Complete the browser flow, then refresh status.',
      };
    } catch (error) {
      return {
        success: false,
        authUrl: '',
        state: '',
        message: summarizeGhError(error),
      };
    }
  }
}
