import { describe, expect, it } from 'vitest';

import { coalescePackageInstallToolCalls } from './package-install-tool-coalescing.js';

describe('coalescePackageInstallToolCalls', () => {
  it('merges same-round package installs with the same cwd and install options', () => {
    const coalesced = coalescePackageInstallToolCalls([
      {
        id: 'call-1',
        name: 'package_install',
        arguments: JSON.stringify({ command: 'npm install -D typescript', cwd: 'S:\\Development\\MusicApp' }),
      },
      {
        id: 'call-2',
        name: 'package_install',
        arguments: JSON.stringify({ command: 'npm install -D tsx', cwd: 'S:\\Development\\MusicApp' }),
      },
      {
        id: 'call-3',
        name: 'package_install',
        arguments: JSON.stringify({ command: 'npm install -D @types/node', cwd: 'S:\\Development\\MusicApp' }),
      },
    ]);

    expect(coalesced).toHaveLength(1);
    expect(coalesced?.[0]?.id).toBe('call-1');
    expect(JSON.parse(coalesced?.[0]?.arguments ?? '{}')).toEqual({
      command: 'npm install -D typescript tsx @types/node',
      cwd: 'S:\\Development\\MusicApp',
    });
  });

  it('keeps installs separate when caution policy or targets differ', () => {
    const coalesced = coalescePackageInstallToolCalls([
      {
        id: 'call-1',
        name: 'package_install',
        arguments: JSON.stringify({ command: 'npm install express', cwd: 'S:\\Development\\MusicApp' }),
      },
      {
        id: 'call-2',
        name: 'package_install',
        arguments: JSON.stringify({ command: 'npm install zod', cwd: 'S:\\Development\\MusicApp', allowCaution: true }),
      },
    ]);

    expect(coalesced).toHaveLength(2);
  });
});
