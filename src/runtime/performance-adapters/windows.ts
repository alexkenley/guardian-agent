import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import type { PerformanceProfileConfig } from '../../config/types.js';
import type { PerformanceCapabilities, PerformanceProcessSummary, PerformanceSnapshot } from '../../channels/web-types.js';
import type { PerformanceAdapter } from './types.js';

const execFile = promisify(execFileCallback);

interface CpuSample {
  idle: number;
  total: number;
}

function readCpuSample(): CpuSample {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }

  return { idle, total };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toProcessTargetId(pid: number): string {
  return `pid:${pid}`;
}

function sortProcesses(processes: PerformanceProcessSummary[]): PerformanceProcessSummary[] {
  return [...processes].sort((a, b) => {
    const cpuDelta = (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0);
    if (cpuDelta !== 0) return cpuDelta;
    return (b.memoryMb ?? 0) - (a.memoryMb ?? 0);
  });
}

async function readWindowsProcesses(): Promise<PerformanceProcessSummary[]> {
  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoProfile',
      '-Command',
      '$ErrorActionPreference = "Stop"; '
      + 'Get-Process | '
      + 'Select-Object '
      + '@{Name="pid";Expression={$_.Id}},'
      + '@{Name="name";Expression={$_.ProcessName}},'
      + '@{Name="memoryMb";Expression={[math]::Round($_.WorkingSet64 / 1MB, 2)}},'
      + '@{Name="cpuSec";Expression={if ($_.CPU -ne $null) {[math]::Round($_.CPU, 2)} else {$null}}},'
      + '@{Name="path";Expression={$_.Path}} '
      + '| ConvertTo-Json -Compress',
    ], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ pid?: number; name?: string; memoryMb?: number; cpuSec?: number; path?: string }> | { pid?: number; name?: string; memoryMb?: number; cpuSec?: number; path?: string };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((entry) => Number.isFinite(entry.pid) && typeof entry.name === 'string' && entry.name.trim())
      .map((entry) => ({
        targetId: toProcessTargetId(Number(entry.pid)),
        pid: Number(entry.pid),
        name: String(entry.name),
        cpuTimeSec: Number.isFinite(entry.cpuSec) ? round(Number(entry.cpuSec)) : undefined,
        memoryMb: Number.isFinite(entry.memoryMb) ? round(Number(entry.memoryMb)) : undefined,
        executablePath: typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

async function readWindowsDiskUsageMb(): Promise<{ freeMb: number; totalMb: number }> {
  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoProfile',
      '-Command',
      '$ErrorActionPreference = "Stop"; '
      + '$drives = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"; '
      + '[pscustomobject]@{'
      + 'freeMb=[math]::Round((($drives | Measure-Object -Property FreeSpace -Sum).Sum) / 1MB, 2);'
      + 'totalMb=[math]::Round((($drives | Measure-Object -Property Size -Sum).Sum) / 1MB, 2)'
      + '} | ConvertTo-Json -Compress',
    ], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as { freeMb?: number; totalMb?: number };
    return {
      freeMb: Number.isFinite(parsed.freeMb) ? Number(parsed.freeMb) : 0,
      totalMb: Number.isFinite(parsed.totalMb) ? Number(parsed.totalMb) : 0,
    };
  } catch {
    return { freeMb: 0, totalMb: 0 };
  }
}

export class WindowsPerformanceAdapter implements PerformanceAdapter {
  private previousCpuSample: CpuSample | null = null;

  getCapabilities(): PerformanceCapabilities {
    return {
      canManageProcesses: true,
      canManagePower: false,
      canRunCleanup: false,
      canProbeLatency: true,
      supportedActionIds: ['cleanup'],
    };
  }

  private readCpuPercent(): number {
    const sample = readCpuSample();
    if (!this.previousCpuSample) {
      this.previousCpuSample = sample;
      return 0;
    }

    const idleDelta = sample.idle - this.previousCpuSample.idle;
    const totalDelta = sample.total - this.previousCpuSample.total;
    this.previousCpuSample = sample;

    if (totalDelta <= 0) return 0;
    return round(Math.max(0, Math.min(100, (1 - (idleDelta / totalDelta)) * 100)));
  }

  async collectSnapshot(): Promise<PerformanceSnapshot> {
    const [processes, disk] = await Promise.all([
      this.listProcesses(),
      readWindowsDiskUsageMb(),
    ]);
    const totalMemoryMb = os.totalmem() / (1024 * 1024);
    const usedMemoryMb = totalMemoryMb - (os.freemem() / (1024 * 1024));
    return {
      cpuPercent: this.readCpuPercent(),
      memoryMb: round(usedMemoryMb),
      memoryTotalMb: round(totalMemoryMb),
      memoryPercent: totalMemoryMb > 0 ? round((usedMemoryMb / totalMemoryMb) * 100) : undefined,
      diskFreeMb: round(disk.freeMb),
      diskTotalMb: round(disk.totalMb),
      diskPercentFree: disk.totalMb > 0 ? round((disk.freeMb / disk.totalMb) * 100) : undefined,
      activeProfile: 'balanced',
      processCount: processes.length,
      topProcesses: sortProcesses(processes).slice(0, 5),
      sampledAt: Date.now(),
    };
  }

  async listProcesses(): Promise<PerformanceProcessSummary[]> {
    return sortProcesses(await readWindowsProcesses());
  }

  async terminateProcesses(processes: PerformanceProcessSummary[]): Promise<{ success: boolean; message: string }> {
    if (processes.length === 0) {
      return { success: false, message: 'No processes were selected.' };
    }

    const failed: string[] = [];
    for (const processInfo of processes) {
      try {
        await execFile('taskkill', ['/PID', String(processInfo.pid), '/T', '/F'], {
          windowsHide: true,
          maxBuffer: 512 * 1024,
        });
      } catch {
        failed.push(`${processInfo.name} (${processInfo.pid})`);
      }
    }

    if (failed.length > 0) {
      return {
        success: false,
        message: `Stopped ${processes.length - failed.length} process(es). Failed: ${failed.join(', ')}`,
      };
    }

    return {
      success: true,
      message: `Stopped ${processes.length} selected process(es).`,
    };
  }

  async runCleanupActions(actionIds: string[]): Promise<{ success: boolean; message: string }> {
    if (actionIds.length === 0) {
      return { success: true, message: 'No cleanup actions were selected.' };
    }
    return {
      success: false,
      message: 'Cleanup actions are not implemented yet in this build.',
    };
  }

  async applyProfile(_profile: PerformanceProfileConfig): Promise<{ success: boolean; message: string }> {
    return {
      success: true,
      message: 'Guardian switched profiles. Host power-mode changes are not implemented in this build.',
    };
  }
}
