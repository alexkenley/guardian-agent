import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../../config/types.js';
import { createGwsCliProbe } from './provider-runtime-adapters.js';

function createConfig(): GuardianAgentConfig {
  return structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
}

describe('createGwsCliProbe', () => {
  it('reports installed and authenticated when the CLI returns auth status', async () => {
    const log = { debug: vi.fn() };
    const execFileAsync = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'gws 1.2.3\n' })
      .mockResolvedValueOnce({ stdout: '{"auth_method":"oauth"}' });
    const probe = createGwsCliProbe(log, execFileAsync);

    await expect(probe(createConfig())).resolves.toEqual({
      installed: true,
      version: 'gws 1.2.3',
      authenticated: true,
      authMethod: 'oauth',
    });
    expect(execFileAsync).toHaveBeenNthCalledWith(1, 'gws', ['--version'], expect.any(Object));
    expect(execFileAsync).toHaveBeenNthCalledWith(2, 'gws', ['auth', 'status'], expect.any(Object));
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('falls back to installed but unauthenticated when auth status fails', async () => {
    const log = { debug: vi.fn() };
    const execFileAsync = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'gws 1.2.3\n' })
      .mockRejectedValueOnce(new Error('status failed'));
    const probe = createGwsCliProbe(log, execFileAsync);

    await expect(probe(createConfig())).resolves.toEqual({
      installed: true,
      version: 'gws 1.2.3',
      authenticated: false,
    });
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'gws', err: expect.any(Error) }),
      'GWS auth status check failed, reporting as not authenticated',
    );
  });

  it('reports not installed when the version probe fails', async () => {
    const log = { debug: vi.fn() };
    const execFileAsync = vi.fn().mockRejectedValueOnce(new Error('not found'));
    const config = createConfig();
    config.assistant.tools.mcp = {
      ...(config.assistant.tools.mcp ?? {}),
      managedProviders: {
        ...(config.assistant.tools.mcp?.managedProviders ?? {}),
        gws: {
          enabled: true,
          command: 'custom-gws',
        },
      },
    };
    const probe = createGwsCliProbe(log, execFileAsync);

    await expect(probe(config)).resolves.toEqual({
      installed: false,
      authenticated: false,
    });
    expect(execFileAsync).toHaveBeenCalledWith('custom-gws', ['--version'], expect.any(Object));
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'custom-gws', err: expect.any(Error) }),
      'GWS CLI not found or version check failed',
    );
  });
});
