import { describe, expect, it, vi } from 'vitest';

import { VercelSandboxClient } from './vercel-sandbox-client.js';

describe('VercelSandboxClient', () => {
  it('skips known Vercel base directories when ensuring nested paths', async () => {
    const client = new VercelSandboxClient();
    const session = {
      sandboxId: 'sandbox_123',
      mkDir: vi.fn(async () => undefined),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };

    await client.ensureDirectories(session, [
      '/vercel/sandbox/src/index.ts',
      '/vercel/sandbox/scripts/run.sh',
    ]);

    expect(session.mkDir).toHaveBeenCalledTimes(2);
    expect(session.mkDir).toHaveBeenNthCalledWith(1, '/vercel/sandbox/src');
    expect(session.mkDir).toHaveBeenNthCalledWith(2, '/vercel/sandbox/scripts');
  });

  it('ignores already-existing nested directories', async () => {
    const client = new VercelSandboxClient();
    const session = {
      sandboxId: 'sandbox_456',
      mkDir: vi.fn(async (directory: string) => {
        if (directory === '/vercel/sandbox/src') {
          throw new Error('File exists');
        }
      }),
      writeFiles: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      readFileToBuffer: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };

    await expect(client.ensureDirectories(session, [
      '/vercel/sandbox/src/nested/index.ts',
    ])).resolves.toBeUndefined();

    expect(session.mkDir).toHaveBeenCalledTimes(2);
    expect(session.mkDir).toHaveBeenNthCalledWith(1, '/vercel/sandbox/src');
    expect(session.mkDir).toHaveBeenNthCalledWith(2, '/vercel/sandbox/src/nested');
  });
});
