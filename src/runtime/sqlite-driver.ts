/**
 * Optional SQLite driver loader.
 *
 * Uses node:sqlite when available (Node builds that include it).
 * Returns null when unavailable so callers can fall back gracefully.
 */

import { createRequire } from 'node:module';

export interface SQLiteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
  enableDefensive?(enabled: boolean): void;
}

type SQLiteModule = {
  DatabaseSync: new (path: string, options?: unknown) => SQLiteDatabase;
};

let cachedModule: SQLiteModule | null | undefined;

function loadSQLiteModule(): SQLiteModule | null {
  if (cachedModule !== undefined) return cachedModule;

  try {
    const require = createRequire(import.meta.url);
    const mod = require('node:sqlite') as { DatabaseSync?: SQLiteModule['DatabaseSync'] };
    if (typeof mod.DatabaseSync !== 'function') {
      cachedModule = null;
      return null;
    }
    cachedModule = { DatabaseSync: mod.DatabaseSync };
    return cachedModule;
  } catch {
    cachedModule = null;
    return null;
  }
}

export function hasSQLiteDriver(): boolean {
  return loadSQLiteModule() !== null;
}

export function openSQLiteDatabase(
  path: string,
  options?: { enableForeignKeyConstraints?: boolean },
): SQLiteDatabase | null {
  const sqlite = loadSQLiteModule();
  if (!sqlite) return null;

  try {
    return new sqlite.DatabaseSync(path, options);
  } catch {
    return null;
  }
}
