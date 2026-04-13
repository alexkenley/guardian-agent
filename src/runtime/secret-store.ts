import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { getGuardianBaseDir } from '../util/env.js';

type EncryptedSecretRecord = {
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: number;
};

type SecretStoreFile = {
  version: 1;
  secrets: Record<string, EncryptedSecretRecord>;
};

export interface SecretResolver {
  get(secretId: string): string | undefined;
}

export interface LocalSecretStoreOptions {
  baseDir?: string;
  dataPath?: string;
  keyPath?: string;
  now?: () => number;
}

const DEFAULT_BASE_DIR = getGuardianBaseDir();
export class LocalSecretStore implements SecretResolver {
  private readonly dataPath: string;
  private readonly keyPath: string;
  private readonly now: () => number;

  constructor(options: LocalSecretStoreOptions = {}) {
    const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
    this.dataPath = options.dataPath ?? join(baseDir, 'secrets.enc.json');
    this.keyPath = options.keyPath ?? join(baseDir, 'secrets.key');
    this.now = options.now ?? Date.now;
  }

  get(secretId: string): string | undefined {
    const normalized = secretId.trim();
    if (!normalized) return undefined;
    const record = this.readStore().secrets[normalized];
    if (!record) return undefined;
    return this.decrypt(record);
  }

  set(secretId: string, value: string): void {
    const normalized = secretId.trim();
    if (!normalized) {
      throw new Error('secretId is required');
    }
    const store = this.readStore();
    store.secrets[normalized] = this.encrypt(value);
    this.writeStore(store);
  }

  delete(secretId: string): void {
    const normalized = secretId.trim();
    if (!normalized) return;
    const store = this.readStore();
    if (!store.secrets[normalized]) return;
    delete store.secrets[normalized];
    this.writeStore(store);
  }

  has(secretId: string): boolean {
    const normalized = secretId.trim();
    if (!normalized) return false;
    return Object.prototype.hasOwnProperty.call(this.readStore().secrets, normalized);
  }

  private readStore(): SecretStoreFile {
    this.ensureStorage();
    if (!existsSync(this.dataPath)) {
      return { version: 1, secrets: {} };
    }
    const raw = readFileSync(this.dataPath, 'utf-8').trim();
    if (!raw) return { version: 1, secrets: {} };
    const parsed = JSON.parse(raw) as Partial<SecretStoreFile>;
    return {
      version: 1,
      secrets: typeof parsed.secrets === 'object' && parsed.secrets ? parsed.secrets : {},
    };
  }

  private writeStore(store: SecretStoreFile): void {
    this.ensureStorage();
    writeFileSync(this.dataPath, JSON.stringify(store, null, 2), 'utf-8');
    this.hardenPath(this.dataPath, false);
  }

  private ensureStorage(): void {
    const baseDir = dirname(this.dataPath);
    mkdirSync(baseDir, { recursive: true });
    this.hardenPath(baseDir, true);
    if (!existsSync(this.keyPath)) {
      const key = randomBytes(32).toString('base64');
      writeFileSync(this.keyPath, key, 'utf-8');
      this.hardenPath(this.keyPath, false);
    } else {
      this.hardenPath(this.keyPath, false);
    }
  }

  private loadKey(): Buffer {
    this.ensureStorage();
    const encoded = readFileSync(this.keyPath, 'utf-8').trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32) {
      throw new Error('Local secret store key must be 32 bytes');
    }
    return key;
  }

  private encrypt(value: string): EncryptedSecretRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      updatedAt: this.now(),
    };
  }

  private decrypt(record: EncryptedSecretRecord): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.loadKey(),
      Buffer.from(record.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf-8');
  }

  private hardenPath(path: string, isDir: boolean): void {
    try {
      chmodSync(path, isDir ? 0o700 : 0o600);
    } catch {
      // Best-effort only. Windows and some filesystems may not support POSIX modes.
    }
  }
}
