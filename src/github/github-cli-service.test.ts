import { describe, expect, it } from 'vitest';
import { GitHubCliService } from './github-cli-service.js';

function createExec(responses: Array<{ stdout?: string; stderr?: string; code?: number }>) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFile = async (file: string, args: string[]) => {
    calls.push({ file, args });
    const response = responses.shift() ?? {};
    if (response.code && response.code !== 0) {
      const err = new Error('failed') as Error & { code: number; stdout: string; stderr: string };
      err.code = response.code;
      err.stdout = response.stdout ?? '';
      err.stderr = response.stderr ?? '';
      throw err;
    }
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  };
  return { execFile, calls };
}

describe('GitHubCliService', () => {
  it('reports authenticated repository access through gh', async () => {
    const { execFile, calls } = createExec([
      { stdout: 'gh version 2.70.0\n' },
      { stdout: 'Logged in to github.com\n' },
      { stdout: '{"nameWithOwner":"example-org/example-repo","url":"https://github.com/example-org/example-repo"}' },
    ]);
    const service = new GitHubCliService({
      enabled: true,
      mode: 'cli',
      defaultOwner: 'example-org',
      defaultRepo: 'example-repo',
    }, { execFile });

    const status = await service.status();

    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.repositoryAccessible).toBe(true);
    expect(status.defaultRepository).toBe('example-org/example-repo');
    expect(status.repositoryUrl).toBe('https://github.com/example-org/example-repo');
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'status', '--hostname', 'github.com'],
      ['repo', 'view', 'example-org/example-repo', '--json', 'nameWithOwner,url'],
    ]);
  });

  it('does not invent a default repository when none is configured', async () => {
    const { execFile, calls } = createExec([
      { stdout: 'gh version 2.70.0\n' },
      { stdout: 'Logged in to github.com\n' },
    ]);
    const service = new GitHubCliService(undefined, { execFile });

    const status = await service.status();

    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.repositoryAccessible).toBe(false);
    expect(status.repositoryConfigured).toBe(false);
    expect(status.defaultRepository).toBeUndefined();
    expect(status.message).toContain('GitHub CLI is authenticated');
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['auth', 'status', '--hostname', 'github.com'],
    ]);
  });

  it('reports unauthenticated gh without throwing', async () => {
    const { execFile } = createExec([
      { stdout: 'gh version 2.70.0\n' },
      { stderr: 'You are not logged into any GitHub hosts.', code: 1 },
    ]);
    const service = new GitHubCliService({
      enabled: true,
      mode: 'cli',
      defaultOwner: 'example-org',
      defaultRepo: 'example-repo',
    }, { execFile });

    const status = await service.status();

    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.repositoryAccessible).toBe(false);
    expect(status.message).toContain('gh auth login');
  });

  it('creates issues with explicit argument arrays', async () => {
    const { execFile, calls } = createExec([
      { stdout: 'https://github.com/example-org/example-repo/issues/123\n' },
    ]);
    const service = new GitHubCliService({
      enabled: true,
      mode: 'cli',
      defaultOwner: 'example-org',
      defaultRepo: 'example-repo',
    }, { execFile });

    const result = await service.createIssue({
      title: '[Diagnostics] Bad route',
      body: 'Redacted body',
      labels: ['diagnostics', 'user-reported'],
    });

    expect(result.url).toBe('https://github.com/example-org/example-repo/issues/123');
    expect(result.number).toBe(123);
    expect(calls[0].file).toBe('gh');
    expect(calls[0].args).toEqual([
      'issue',
      'create',
      '--repo',
      'example-org/example-repo',
      '--title',
      '[Diagnostics] Bad route',
      '--body',
      'Redacted body',
      '--label',
      'diagnostics',
      '--label',
      'user-reported',
    ]);
  });
});
