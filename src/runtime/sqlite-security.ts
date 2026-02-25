/**
 * SQLite protection and health monitoring helpers.
 */

import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SQLiteDatabase } from './sqlite-driver.js';

export interface SQLiteSecurityEvent {
  service: 'conversation' | 'analytics';
  severity: 'info' | 'warn';
  code: 'permissions_hardened' | 'permissions_check_failed' | 'integrity_check_failed' | 'integrity_ok' | 'driver_unavailable';
  message: string;
  details?: Record<string, unknown>;
}

export interface SQLiteSecurityMonitorOptions {
  service: 'conversation' | 'analytics';
  db: SQLiteDatabase;
  sqlitePath: string;
  onEvent?: (event: SQLiteSecurityEvent) => void;
  now?: () => number;
  checkIntervalMs?: number;
}

export class SQLiteSecurityMonitor {
  private readonly service: 'conversation' | 'analytics';
  private readonly db: SQLiteDatabase;
  private readonly sqlitePath: string;
  private readonly onEvent?: (event: SQLiteSecurityEvent) => void;
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private nextCheckAt = 0;

  constructor(options: SQLiteSecurityMonitorOptions) {
    this.service = options.service;
    this.db = options.db;
    this.sqlitePath = options.sqlitePath;
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.checkIntervalMs = options.checkIntervalMs ?? 60 * 60 * 1000;
  }

  initialize(): void {
    this.enforcePermissions();
    this.enableDefensivePragmas();
    this.runIntegrityCheck();
  }

  maybeCheck(): void {
    const now = this.now();
    if (now < this.nextCheckAt) return;
    this.nextCheckAt = now + this.checkIntervalMs;
    this.enforcePermissions();
    this.runIntegrityCheck();
  }

  private enforcePermissions(): void {
    const targets = [
      { path: dirname(this.sqlitePath), mode: 0o700, isDir: true },
      { path: this.sqlitePath, mode: 0o600, isDir: false },
    ];

    for (const target of targets) {
      try {
        if (!existsSync(target.path)) continue;
        const stats = statSync(target.path);
        if (target.isDir && !stats.isDirectory()) continue;
        if (!target.isDir && !stats.isFile()) continue;

        const currentMode = stats.mode & 0o777;
        const tooOpen = (currentMode & 0o077) !== 0;
        if (tooOpen || currentMode !== target.mode) {
          chmodSync(target.path, target.mode);
          this.emit({
            service: this.service,
            severity: 'info',
            code: 'permissions_hardened',
            message: `Hardened ${target.isDir ? 'directory' : 'database'} permissions`,
            details: {
              path: target.path,
              previousMode: modeString(currentMode),
              appliedMode: modeString(target.mode),
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({
          service: this.service,
          severity: 'warn',
          code: 'permissions_check_failed',
          message: 'Failed to verify or harden SQLite permissions',
          details: { path: target.path, error: message },
        });
      }
    }
  }

  private enableDefensivePragmas(): void {
    try {
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.db.exec('PRAGMA synchronous=NORMAL;');
      this.db.exec('PRAGMA trusted_schema=OFF;');
      try {
        this.db.enableDefensive?.(true);
      } catch {
        // Some Node/SQLite builds may not support defensive mode yet.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        service: this.service,
        severity: 'warn',
        code: 'integrity_check_failed',
        message: 'Failed to apply defensive SQLite pragmas',
        details: { error: message },
      });
    }
  }

  private runIntegrityCheck(): void {
    try {
      const row = this.db.prepare('PRAGMA quick_check;').get() as Record<string, unknown> | undefined;
      const values = row ? Object.values(row) : [];
      const first = values[0];
      const ok = typeof first === 'string' && first.toLowerCase() === 'ok';
      if (!ok) {
        this.emit({
          service: this.service,
          severity: 'warn',
          code: 'integrity_check_failed',
          message: 'SQLite integrity quick_check did not return ok',
          details: { result: first ?? null },
        });
        return;
      }

      this.emit({
        service: this.service,
        severity: 'info',
        code: 'integrity_ok',
        message: 'SQLite integrity quick_check passed',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        service: this.service,
        severity: 'warn',
        code: 'integrity_check_failed',
        message: 'SQLite integrity quick_check failed to execute',
        details: { error: message },
      });
    }
  }

  private emit(event: SQLiteSecurityEvent): void {
    this.onEvent?.(event);
  }
}

function modeString(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
