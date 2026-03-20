import { describe, expect, it, vi } from 'vitest';
import { CodeWorkspaceNativeProtectionScanner } from './code-workspace-native-protection.js';

describe('CodeWorkspaceNativeProtectionScanner', () => {
  it('requests Windows Defender custom scans using host-style paths', async () => {
    const runScan = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
    const refreshStatus = vi.fn()
      .mockResolvedValue({ supported: true, available: true, summary: 'ok' })
      .mockResolvedValue({ supported: true, available: true, summary: 'ok' });
    const listAlerts = vi.fn().mockReturnValue([]);

    const scanner = new CodeWorkspaceNativeProtectionScanner({
      platform: 'win32',
      now: () => 1_000,
      windowsDefender: {
        runScan,
        refreshStatus,
        getStatus: () => ({ supported: true, available: true, summary: 'ok' }),
        listAlerts,
      } as any,
    });

    const result = await scanner.scanWorkspace('/mnt/s/Development/TestRepo');

    expect(runScan).toHaveBeenCalledWith({ type: 'custom', path: 'S:\\Development\\TestRepo' });
    expect(result.status).toBe('clean');
    expect(result.provider).toBe('windows_defender');
  });

  it('surfaces Windows Defender detections that match the workspace path', async () => {
    const scanner = new CodeWorkspaceNativeProtectionScanner({
      platform: 'win32',
      now: () => 2_000,
      windowsDefender: {
        runScan: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
        refreshStatus: vi.fn().mockResolvedValue({ supported: true, available: true, summary: 'ok' }),
        getStatus: () => ({ supported: true, available: true, summary: 'ok' }),
        listAlerts: () => [{
          type: 'defender_threat_detected',
          description: 'Windows Defender detected TestThreat.',
          evidence: {
            threatName: 'TestThreat',
            resources: ['S:\\Development\\TestRepo\\bad.exe'],
          },
        }],
      } as any,
    });

    const result = await scanner.scanWorkspace('/mnt/s/Development/TestRepo');

    expect(result.status).toBe('detected');
    expect(result.details).toEqual(expect.arrayContaining(['TestThreat (S:\\Development\\TestRepo\\bad.exe)']));
  });

  it('parses ClamAV detections on Unix-like hosts', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: '/tmp/repo/bad.exe: Win.Test.EICAR_HDB-1 FOUND\n',
      stderr: '',
      exitCode: 1,
    });

    const scanner = new CodeWorkspaceNativeProtectionScanner({
      platform: 'linux',
      now: () => 3_000,
      runner,
    });

    const result = await scanner.scanWorkspace('/tmp/repo');

    expect(result.status).toBe('detected');
    expect(result.provider).toBe('clamav');
    expect(result.details).toEqual(['Win.Test.EICAR_HDB-1 (/tmp/repo/bad.exe)']);
  });

  it('reports Unix scanners as unavailable when neither clamdscan nor clamscan is installed', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: null,
        errorCode: 'ENOENT',
        errorMessage: 'spawn clamdscan ENOENT',
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: null,
        errorCode: 'ENOENT',
        errorMessage: 'spawn clamscan ENOENT',
      });

    const scanner = new CodeWorkspaceNativeProtectionScanner({
      platform: 'linux',
      now: () => 4_000,
      runner,
    });

    const result = await scanner.scanWorkspace('/tmp/repo');

    expect(result.status).toBe('unavailable');
    expect(result.summary).toMatch(/Install clamdscan or clamscan/i);
  });
});

