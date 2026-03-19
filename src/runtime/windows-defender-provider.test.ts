import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WindowsDefenderProvider } from './windows-defender-provider.js';

function makePersistPath(): string {
  return join(tmpdir(), `guardianagent-windows-defender-${randomUUID()}.json`);
}

describe('WindowsDefenderProvider', () => {
  it('reports unsupported status on non-Windows platforms', async () => {
    const provider = new WindowsDefenderProvider({
      platform: 'linux',
      persistPath: makePersistPath(),
      now: () => 1_000,
    });

    const status = await provider.refreshStatus();

    expect(status.supported).toBe(false);
    expect(status.available).toBe(false);
    expect(status.summary).toContain('only available on Windows hosts');
    expect(provider.listAlerts()).toEqual([]);
  });

  it('parses Windows Defender health and threat detections from PowerShell output', async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const script = args[args.length - 1] ?? '';
      if (script.includes('Get-MpComputerStatus')) {
        return JSON.stringify({
          AntivirusEnabled: true,
          RealTimeProtectionEnabled: true,
          BehaviorMonitorEnabled: true,
          AntivirusSignatureAge: 96,
          QuickScanAge: 12,
          FullScanAge: 168,
          AntivirusSignatureVersion: '1.2.3.4',
          AMEngineVersion: '5.6.7.8',
        });
      }
      if (script.includes('Get-MpPreference')) {
        return JSON.stringify({ EnableControlledFolderAccess: 0 });
      }
      if (script.includes('Get-NetFirewallProfile')) {
        return JSON.stringify([
          { Name: 'Domain', Enabled: true },
          { Name: 'Private', Enabled: false },
        ]);
      }
      if (script.includes('Get-MpThreatDetection')) {
        return JSON.stringify([{
          InitialDetectionTime: '2026-03-19T08:30:00Z',
          ThreatName: 'TestThreat',
          Resources: ['C:\\temp\\bad.exe'],
          ActionSuccess: true,
          SeverityID: 4,
          ThreatID: 77,
        }]);
      }
      throw new Error(`Unexpected script: ${script}`);
    });

    const provider = new WindowsDefenderProvider({
      platform: 'win32',
      persistPath: makePersistPath(),
      now: () => 2_000,
      runner,
    });

    const status = await provider.refreshStatus();
    const alerts = provider.listAlerts({ includeAcknowledged: true, includeInactive: true });

    expect(status.supported).toBe(true);
    expect(status.available).toBe(true);
    expect(status.signatureAgeHours).toBe(96);
    expect(status.controlledFolderAccessEnabled).toBe(false);
    expect(status.firewallEnabled).toBe(false);
    expect(status.activeAlertCount).toBe(4);
    expect(status.summary).toContain('1 detection');
    expect(alerts.map((alert) => alert.type)).toEqual(expect.arrayContaining([
      'defender_signatures_stale',
      'defender_controlled_folder_access_disabled',
      'defender_firewall_profile_disabled',
      'defender_threat_detected',
    ]));
    expect(alerts.find((alert) => alert.type === 'defender_threat_detected')?.evidence).toMatchObject({
      threatName: 'TestThreat',
      resources: ['C:\\temp\\bad.exe'],
    });
  });

  it('treats Defender as inactive without alerting when a third-party antivirus is registered', async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const script = args[args.length - 1] ?? '';
      if (script.includes('Get-MpComputerStatus')) {
        throw new Error('Command failed: powershell.exe -NoProfile -Command Get-MpComputerStatus | ConvertTo-Json -Compress\n0x800106ba');
      }
      if (script.includes('root/SecurityCenter2') && script.includes('AntiVirusProduct')) {
        return JSON.stringify([{ displayName: 'Malwarebytes' }]);
      }
      throw new Error(`Unexpected script: ${script}`);
    });

    const provider = new WindowsDefenderProvider({
      platform: 'win32',
      persistPath: makePersistPath(),
      now: () => 3_000,
      runner,
    });

    const status = await provider.refreshStatus();

    expect(status.supported).toBe(true);
    expect(status.available).toBe(false);
    expect(status.inactiveReason).toBe('third_party_antivirus');
    expect(status.thirdPartyProviders).toEqual(['Malwarebytes']);
    expect(status.summary).toContain('another antivirus is registered: Malwarebytes');
    expect(provider.listAlerts()).toEqual([]);
  });

  it('requests scans and signature updates via PowerShell on Windows', async () => {
    const runner = vi.fn(async () => '');
    const provider = new WindowsDefenderProvider({
      platform: 'win32',
      persistPath: makePersistPath(),
      runner,
    });

    await expect(provider.runScan({ type: 'quick' })).resolves.toMatchObject({ success: true });
    await expect(provider.runScan({ type: 'custom', path: 'C:\\temp' })).resolves.toMatchObject({ success: true });
    await expect(provider.updateSignatures()).resolves.toMatchObject({ success: true });

    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Start-MpScan -ScanType QuickScan'],
      20_000,
    );
    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', "Start-MpScan -ScanType CustomScan -ScanPath 'C:\\temp'"],
      20_000,
    );
    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Update-MpSignature'],
      20_000,
    );
  });
});
