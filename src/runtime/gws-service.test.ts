import { beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.fn();
const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: execMock,
  execFile: execFileMock,
}));

describe('GWSService', () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
  });

  it('surfaces JSON auth errors returned on stdout for non-zero exits', async () => {
    const error = Object.assign(new Error('Command failed'), {
      stdout: JSON.stringify({
        error: {
          code: 401,
          message: 'Access denied. No credentials provided.',
          reason: 'authError',
        },
      }),
      stderr: '',
    });
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(error);
    });
    execMock.mockImplementation((_command, _options, callback) => {
      callback(error);
    });

    const { GWSService } = await import('./gws-service.js');
    const service = new GWSService();
    const result = await service.execute({
      service: 'gmail',
      resource: 'users messages',
      method: 'list',
      params: { userId: 'me', maxResults: 10, q: 'is:unread' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Access denied. No credentials provided.');
    expect(result.data).toEqual({
      error: {
        code: 401,
        message: 'Access denied. No credentials provided.',
        reason: 'authError',
      },
    });
  });

  it('falls back to stderr text when the output is not JSON', async () => {
    const error = Object.assign(new Error('Command failed'), {
      stdout: '',
      stderr: 'plain stderr failure',
    });
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(error);
    });
    execMock.mockImplementation((_command, _options, callback) => {
      callback(error);
    });

    const { GWSService } = await import('./gws-service.js');
    const service = new GWSService();
    const result = await service.execute({
      service: 'gmail',
      resource: 'users messages',
      method: 'list',
      params: { userId: 'me' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('plain stderr failure');
  });

  it('quotes JSON params for the Windows shell path', async () => {
    const { buildShellCommand } = await import('./gws-service.js');

    const command = buildShellCommand(
      'gws',
      [
        'gmail',
        'users',
        'messages',
        'list',
        '--params',
        JSON.stringify({ userId: 'me', maxResults: 10, q: 'is:unread' }),
      ],
      'win32',
    );

    expect(command).toContain('--params "{""userId"":""me"",""maxResults"":10,""q"":""is:unread""}"');
  });
});
