/**
 * Audit log persistence — tamper-evident hash-chained JSONL storage.
 *
 * Each entry contains a SHA-256 hash computed over the event + previous hash,
 * forming a chain that detects any modification to historical entries.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { AuditEvent } from './audit-log.js';
import { createLogger } from '../util/logging.js';
import { appendSecureFile, mkdirSecure } from '../util/secure-fs.js';

import { getGuardianBaseDir } from '../util/env.js';

const log = createLogger('audit-persistence');

/** A single persisted audit entry with hash chain links. */
export interface PersistedAuditEntry {
  event: AuditEvent;
  previousHash: string;
  hash: string;
}

/** Result of a chain verification. */
export interface ChainVerifyResult {
  valid: boolean;
  totalEntries: number;
  brokenAt?: number;
}

const GENESIS_HASH = '0'.repeat(64);

/** Compute SHA-256 hash over event + previousHash. */
function computeHash(event: AuditEvent, previousHash: string): string {
  const payload = JSON.stringify({ event, previousHash });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Persistent audit log with SHA-256 hash chain.
 *
 * Appends entries to a JSONL file. Each entry references the hash of
 * the previous entry, forming a tamper-evident chain.
 */
export class AuditPersistence {
  private readonly auditDir: string;
  private readonly filePath: string;
  private lastHash: string = GENESIS_HASH;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(auditDir?: string) {
    this.auditDir = auditDir ?? join(getGuardianBaseDir(), 'audit');
    this.filePath = join(this.auditDir, 'audit.jsonl');
  }

  /** Initialize: ensure directory exists and recover lastHash from file. */
  async init(): Promise<void> {
    await mkdirSecure(this.auditDir);

    try {
      const stats = await stat(this.filePath);
      if (stats.size > 0) {
        this.lastHash = await this.recoverLastHash();
      }
    } catch {
      // File doesn't exist yet — start fresh
    }

    this.initialized = true;
    log.info({ filePath: this.filePath }, 'Audit persistence initialized');
  }

  /** Persist a single audit event to the hash chain. */
  async persist(event: AuditEvent): Promise<void> {
    if (!this.initialized) {
      throw new Error('AuditPersistence not initialized — call init() first');
    }

    // Serialize writes via chained promises
    this.writeQueue = this.writeQueue.then(async () => {
      const hash = computeHash(event, this.lastHash);
      const entry: PersistedAuditEntry = {
        event,
        previousHash: this.lastHash,
        hash,
      };

      await appendSecureFile(this.filePath, JSON.stringify(entry) + '\n');
      this.lastHash = hash;
    });

    await this.writeQueue;
  }

  /** Verify the entire hash chain. Returns validity and break point. */
  async verifyChain(): Promise<ChainVerifyResult> {
    let previousHash = GENESIS_HASH;
    let lineNumber = 0;

    try {
      await stat(this.filePath);
    } catch {
      return { valid: true, totalEntries: 0 };
    }

    const stream = createReadStream(this.filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        lineNumber++;
        let entry: PersistedAuditEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          return { valid: false, totalEntries: lineNumber, brokenAt: lineNumber };
        }

        if (entry.previousHash !== previousHash) {
          return { valid: false, totalEntries: lineNumber, brokenAt: lineNumber };
        }

        const expectedHash = computeHash(entry.event, entry.previousHash);
        if (entry.hash !== expectedHash) {
          return { valid: false, totalEntries: lineNumber, brokenAt: lineNumber };
        }

        previousHash = entry.hash;
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    return { valid: true, totalEntries: lineNumber };
  }

  /** Read the last N entries from the persistence file. */
  async readTail(count: number): Promise<PersistedAuditEntry[]> {
    try {
      await stat(this.filePath);
    } catch {
      return [];
    }

    const content = await readFile(this.filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-count);

    return tail.map((line) => JSON.parse(line) as PersistedAuditEntry);
  }

  /** Get the file path for external reference. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Recover the last hash from the final line of the file. */
  private async recoverLastHash(): Promise<string> {
    const content = await readFile(this.filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return GENESIS_HASH;

    const lastLine = lines[lines.length - 1];
    try {
      const entry: PersistedAuditEntry = JSON.parse(lastLine);
      return entry.hash;
    } catch {
      log.warn('Failed to parse last audit entry — starting fresh chain');
      return GENESIS_HASH;
    }
  }
}
