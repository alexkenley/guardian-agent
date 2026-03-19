import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostMonitoringService } from './host-monitor.js';
import type { AssistantHostMonitoringConfig } from '../config/types.js';

type RunnerMap = Record<string, string | Error>;

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<AssistantHostMonitoringConfig> = {}): AssistantHostMonitoringConfig {
  return {
    enabled: true,
    scanIntervalSec: 300,
    dedupeWindowMs: 30_000,
    monitorProcesses: true,
    monitorPersistence: true,
    monitorSensitivePaths: true,
    monitorNetwork: true,
    monitorFirewall: true,
    sensitivePaths: [],
    suspiciousProcessNames: ['wscript.exe', 'mshta.exe', 'osascript', 'nc'],
    ...overrides,
  };
}

function makeRunner(outputs: RunnerMap) {
  return async (command: string, args: string[]): Promise<string> => {
    const key = [command, ...args].join(' ');
    const result = outputs[key];
    if (result instanceof Error) throw result;
    return result ?? '';
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-host-monitor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe('HostMonitoringService', () => {
  it('detects suspicious Windows processes immediately', async () => {
    const dir = await makeTempDir();
    const service = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath: join(dir, 'host-monitor.json'),
      runner: makeRunner({
        'tasklist /FO CSV /NH': '"wscript.exe","4242","Console","1","9,128 K"\n"explorer.exe","1200","Console","1","55,000 K"',
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
        'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
        'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
        'schtasks /Query /FO CSV': '"TaskName","Next Run Time"\n',
        'netstat -an': '',
        'netsh advfirewall show allprofiles state': [
          'Domain Profile Settings:',
          'State                                 ON',
          'Private Profile Settings:',
          'State                                 ON',
          'Public Profile Settings:',
          'State                                 ON',
        ].join('\n'),
        'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\nRule Name: Allow HTTPS\n',
      }),
    });

    const report = await service.runCheck();

    expect(report.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'suspicious_process', severity: 'high' }),
    ]));
    expect(service.getStatus().snapshot.suspiciousProcesses).toEqual([{ pid: 4242, name: 'wscript.exe' }]);
  });

  it('detects new Windows persistence entries after baseline', async () => {
    const dir = await makeTempDir();
    const persistPath = join(dir, 'host-monitor.json');
    const baselineRunner = makeRunner({
      'tasklist /FO CSV /NH': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'schtasks /Query /FO CSV': '"TaskName","Next Run Time"\n',
      'netstat -an': '',
      'netsh advfirewall show allprofiles state': [
        'Domain Profile Settings:',
        'State                                 ON',
        'Private Profile Settings:',
        'State                                 ON',
        'Public Profile Settings:',
        'State                                 ON',
      ].join('\n'),
      'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\nRule Name: Allow HTTPS\n',
    });
    const driftRunner = makeRunner({
      'tasklist /FO CSV /NH': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\n    EvilAgent    REG_SZ    C:\\Users\\alex\\AppData\\evil.exe\n',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'schtasks /Query /FO CSV': '"TaskName","Next Run Time"\n',
      'netstat -an': '',
      'netsh advfirewall show allprofiles state': [
        'Domain Profile Settings:',
        'State                                 ON',
        'Private Profile Settings:',
        'State                                 ON',
        'Public Profile Settings:',
        'State                                 ON',
      ].join('\n'),
      'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\nRule Name: Allow HTTPS\n',
    });

    const baselineService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath,
      runner: baselineRunner,
    });
    await baselineService.runCheck();
    await baselineService.persist();

    const service = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath,
      runner: driftRunner,
    });
    await service.load();
    const report = await service.runCheck();

    expect(report.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'persistence_change', severity: 'critical' }),
    ]));
  });

  it('ignores built-in Windows Defender scheduled tasks when persistence drifts', async () => {
    const dir = await makeTempDir();
    const persistPath = join(dir, 'host-monitor.json');
    const baselineRunner = makeRunner({
      'tasklist /FO CSV /NH': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'schtasks /Query /FO CSV': '"TaskName","Next Run Time"\n',
      'netstat -an': '',
      'netsh advfirewall show allprofiles state': [
        'Domain Profile Settings:',
        'State                                 ON',
        'Private Profile Settings:',
        'State                                 ON',
        'Public Profile Settings:',
        'State                                 ON',
      ].join('\n'),
      'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\nRule Name: Allow HTTPS\n',
    });
    const driftRunner = makeRunner({
      'tasklist /FO CSV /NH': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
      'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
      'schtasks /Query /FO CSV': [
        '"TaskName","Next Run Time"',
        '"\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan","N/A"',
      ].join('\n'),
      'netstat -an': '',
      'netsh advfirewall show allprofiles state': [
        'Domain Profile Settings:',
        'State                                 ON',
        'Private Profile Settings:',
        'State                                 ON',
        'Public Profile Settings:',
        'State                                 ON',
      ].join('\n'),
      'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\nRule Name: Allow HTTPS\n',
    });

    const baselineService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath,
      runner: baselineRunner,
    });
    await baselineService.runCheck();
    await baselineService.persist();

    const service = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath,
      runner: driftRunner,
    });
    await service.load();
    const report = await service.runCheck();

    expect(report.alerts.find((alert) => alert.type === 'persistence_change')).toBeUndefined();
  });

  it('blocks risky actions when multiple high-severity host alerts are active', async () => {
    const dir = await makeTempDir();
    const sshDir = join(dir, '.ssh');
    await mkdir(sshDir, { recursive: true });
    await writeFile(join(sshDir, 'config'), 'Host baseline\n', 'utf8');

    const baselineService = new HostMonitoringService({
      config: makeConfig({
        sensitivePaths: [sshDir],
        suspiciousProcessNames: ['wscript.exe'],
      }),
      platform: 'linux',
      homeDir: dir,
      persistPath: join(dir, 'host-monitor.json'),
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await baselineService.runCheck();
    await baselineService.persist();

    await writeFile(join(sshDir, 'config'), 'Host changed\n  User root\n', 'utf8');

    const service = new HostMonitoringService({
      config: makeConfig({
        sensitivePaths: [sshDir],
        suspiciousProcessNames: ['wscript.exe'],
      }),
      platform: 'linux',
      homeDir: dir,
      persistPath: join(dir, 'host-monitor.json'),
      runner: makeRunner({
        'ps -axo pid=,comm=': '4242 /usr/bin/wscript.exe\n',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await service.load();
    await service.runCheck();

    expect(service.shouldBlockAction({ type: 'execute_command', toolName: 'shell_safe' })).toEqual({
      allowed: false,
      reason: expect.stringContaining('2 active high-severity host alerts'),
    });
  });

  it('parses Linux netstat fallback output for new ports and external destinations', async () => {
    const dir = await makeTempDir();
    const persistPath = join(dir, 'host-monitor.json');

    const baselineService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'linux',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await baselineService.runCheck();
    await baselineService.persist();

    const service = new HostMonitoringService({
      config: makeConfig(),
      platform: 'linux',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': new Error('ss unavailable'),
        'netstat -an': [
          'tcp        0      0 0.0.0.0:3389            0.0.0.0:*               LISTEN',
          'tcp        0      0 192.168.1.20:51514      203.0.113.10:443        ESTABLISHED',
        ].join('\n'),
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await service.load();
    const report = await service.runCheck();

    expect(report.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'new_listening_port', severity: 'high' }),
      expect.objectContaining({ type: 'new_external_destination', severity: 'low' }),
    ]));
  });

  it('auto-resolves transient host alerts when the condition disappears', async () => {
    const dir = await makeTempDir();
    const persistPath = join(dir, 'host-monitor.json');

    const baselineService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'linux',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await baselineService.runCheck();
    await baselineService.persist();

    const driftService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'linux',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': new Error('ss unavailable'),
        'netstat -an': 'tcp        0      0 192.168.1.20:51514      203.0.113.10:443        ESTABLISHED',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await driftService.load();
    const driftReport = await driftService.runCheck();
    expect(driftReport.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'new_external_destination', severity: 'low' }),
    ]));
    await driftService.persist();

    const clearedService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'linux',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await clearedService.load();
    await clearedService.runCheck();

    expect(clearedService.listAlerts()).toEqual([]);
    expect(clearedService.listAlerts({ includeInactive: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'new_external_destination',
        status: 'resolved',
        resolutionReason: 'Condition no longer present in the latest host monitor check.',
      }),
    ]));
  });

  it('detects Windows firewall disablement and rule drift', async () => {
    const dir = await makeTempDir();
    const persistPath = join(dir, 'host-monitor.json');

    const baselineService = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'tasklist /FO CSV /NH': '',
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
        'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
        'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
        'schtasks /Query /FO CSV': '"TaskName","Next Run Time"\n',
        'netstat -an': '',
        'netsh advfirewall show allprofiles state': [
          'Domain Profile Settings:',
          'State                                 ON',
          'Private Profile Settings:',
          'State                                 ON',
          'Public Profile Settings:',
          'State                                 ON',
        ].join('\n'),
        'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\nRule Name: Allow HTTPS\n',
      }),
    });
    await baselineService.runCheck();
    await baselineService.persist();

    const service = new HostMonitoringService({
      config: makeConfig(),
      platform: 'win32',
      homeDir: dir,
      persistPath,
      runner: makeRunner({
        'tasklist /FO CSV /NH': '',
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
        'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': '',
        'reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce': '',
        'schtasks /Query /FO CSV': '"TaskName","Next Run Time"\n',
        'netstat -an': '',
        'netsh advfirewall show allprofiles state': [
          'Domain Profile Settings:',
          'State                                 OFF',
          'Private Profile Settings:',
          'State                                 OFF',
          'Public Profile Settings:',
          'State                                 OFF',
        ].join('\n'),
        'netsh advfirewall firewall show rule name=all': 'Rule Name: Allow DNS\n',
      }),
    });
    await service.load();
    const report = await service.runCheck();

    expect(report.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'firewall_disabled', severity: 'critical' }),
      expect.objectContaining({ type: 'firewall_change', severity: 'high' }),
    ]));
    expect(report.snapshot.firewallBackend).toBe('windows-advfirewall');
    expect(report.snapshot.firewallEnabled).toBe(false);
  });

  it('downgrades Guardian state directory churn to low severity', async () => {
    const dir = await makeTempDir();
    const guardianDir = join(dir, '.guardianagent');
    await mkdir(guardianDir, { recursive: true });
    await writeFile(join(guardianDir, 'state.json'), '{"status":"baseline"}\n', 'utf8');

    const baselineService = new HostMonitoringService({
      config: makeConfig({
        sensitivePaths: [guardianDir],
      }),
      platform: 'linux',
      homeDir: dir,
      persistPath: join(dir, 'host-monitor.json'),
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await baselineService.runCheck();
    await baselineService.persist();

    await writeFile(join(guardianDir, 'state.json'), '{"status":"updated"}\n', 'utf8');

    const service = new HostMonitoringService({
      config: makeConfig({
        sensitivePaths: [guardianDir],
      }),
      platform: 'linux',
      homeDir: dir,
      persistPath: join(dir, 'host-monitor.json'),
      runner: makeRunner({
        'ps -axo pid=,comm=': '',
        'crontab -l': '',
        'ss -tun': '',
        'ufw status verbose': 'Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n',
      }),
    });
    await service.load();
    const report = await service.runCheck();

    expect(report.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'sensitive_path_change', severity: 'low' }),
    ]));
  });
});
