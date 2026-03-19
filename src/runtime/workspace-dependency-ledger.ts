import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ParsedCommand } from '../guardian/shell-validator.js';

type JsPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
type JsDependencyBucket = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
type DependencyRecordStatus = 'active' | 'partial' | 'stale';

const JS_DEPENDENCY_BUCKETS: JsDependencyBucket[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const JS_LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const;
const GLOBAL_INSTALL_FLAGS = new Set(['-g', '--global', '--location=global']);

export interface JsDependencyMutationIntent {
  manager: JsPackageManager;
  subcommand: string;
  requestedPackages: string[];
}

export interface JsDependencySnapshot {
  workspaceRoot: string;
  packageRoot: string;
  packageJsonPath: string;
  packageJsonHash: string | null;
  dependencies: Record<JsDependencyBucket, Record<string, string>>;
  lockfileHashes: Record<string, string | null>;
}

export interface JsDependencyChange {
  bucket: JsDependencyBucket;
  name: string;
  version: string;
  previousVersion?: string;
}

export interface JsDependencySnapshotDiff {
  added: JsDependencyChange[];
  updated: JsDependencyChange[];
  removed: JsDependencyChange[];
  changedFiles: string[];
}

export interface WorkspaceDependencyLedgerRecord {
  id: string;
  createdAt: string;
  manager: JsPackageManager;
  subcommand: string;
  command: string;
  workspaceRoot: string;
  cwdRelative: string;
  packageRootRelative: string;
  requestedPackages: string[];
  added: JsDependencyChange[];
  updated: JsDependencyChange[];
  removed: JsDependencyChange[];
  changedFiles: string[];
}

interface WorkspaceDependencyLedgerFile {
  version: 1;
  entries: WorkspaceDependencyLedgerRecord[];
}

const EMPTY_LEDGER: WorkspaceDependencyLedgerFile = { version: 1, entries: [] };

export function detectJsDependencyMutationIntent(command: ParsedCommand): JsDependencyMutationIntent | null {
  const manager = normalizeCommandName(command.command);
  if (!isJsPackageManager(manager)) return null;
  if (command.args.some((arg) => GLOBAL_INSTALL_FLAGS.has(arg.toLowerCase()))) {
    return null;
  }

  const subcommand = command.args[0]?.toLowerCase() ?? '';
  const requestedPackages = extractRequestedPackages(command.args.slice(1));

  switch (manager) {
    case 'npm':
      if (!['install', 'i', 'add', 'uninstall', 'remove', 'rm'].includes(subcommand)) return null;
      break;
    case 'pnpm':
      if (!['add', 'install', 'remove', 'rm'].includes(subcommand)) return null;
      break;
    case 'yarn':
      if (!['add', 'remove'].includes(subcommand)) return null;
      break;
    case 'bun':
      if (!['add', 'remove'].includes(subcommand)) return null;
      break;
    default:
      return null;
  }

  return {
    manager,
    subcommand,
    requestedPackages,
  };
}

export function captureJsDependencySnapshot(workspaceRoot: string, cwd: string): JsDependencySnapshot | null {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const resolvedCwd = resolve(cwd);
  const packageRoot = findNearestPackageRoot(resolvedWorkspaceRoot, resolvedCwd);
  if (!packageRoot) return null;

  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJsonRaw = safeReadText(packageJsonPath);
  const packageJsonHash = packageJsonRaw !== null ? hashContent(packageJsonRaw) : null;
  const packageJson = parsePackageJson(packageJsonRaw);

  const lockfileHashes = Object.fromEntries(
    JS_LOCKFILES.map((filename) => {
      const absolute = join(packageRoot, filename);
      const content = safeReadBinary(absolute);
      return [filename, content ? hashBuffer(content) : null];
    }),
  ) as Record<string, string | null>;

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    packageRoot,
    packageJsonPath,
    packageJsonHash,
    dependencies: packageJson,
    lockfileHashes,
  };
}

export function diffJsDependencySnapshots(
  before: JsDependencySnapshot | null,
  after: JsDependencySnapshot | null,
): JsDependencySnapshotDiff | null {
  if (!before && !after) return null;
  if (!after) return null;

  const added: JsDependencyChange[] = [];
  const updated: JsDependencyChange[] = [];
  const removed: JsDependencyChange[] = [];
  const changedFiles = new Set<string>();

  if (!before || before.packageJsonHash !== after.packageJsonHash) {
    changedFiles.add('package.json');
  }

  for (const filename of Object.keys(after.lockfileHashes)) {
    const beforeHash = before?.lockfileHashes[filename] ?? null;
    const afterHash = after.lockfileHashes[filename] ?? null;
    if (beforeHash !== afterHash) {
      changedFiles.add(filename);
    }
  }

  for (const bucket of JS_DEPENDENCY_BUCKETS) {
    const beforeDeps = before?.dependencies[bucket] ?? {};
    const afterDeps = after.dependencies[bucket];

    for (const [name, version] of Object.entries(afterDeps)) {
      if (!(name in beforeDeps)) {
        added.push({ bucket, name, version });
        continue;
      }
      if (beforeDeps[name] !== version) {
        updated.push({ bucket, name, version, previousVersion: beforeDeps[name] });
      }
    }

    for (const [name, version] of Object.entries(beforeDeps)) {
      if (!(name in afterDeps)) {
        removed.push({ bucket, name, version });
      }
    }
  }

  if (added.length === 0 && updated.length === 0 && removed.length === 0) {
    return null;
  }

  return {
    added,
    updated,
    removed,
    changedFiles: [...changedFiles].sort(),
  };
}

export class WorkspaceDependencyLedger {
  private readonly workspaceRoot: string;
  private readonly ledgerPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.ledgerPath = join(this.workspaceRoot, '.guardianagent', 'dependency-awareness.json');
  }

  recordMutation(input: {
    intent: JsDependencyMutationIntent;
    command: string;
    cwd: string;
    before: JsDependencySnapshot | null;
    after: JsDependencySnapshot;
    diff: JsDependencySnapshotDiff;
    now?: () => number;
  }): WorkspaceDependencyLedgerRecord {
    const now = input.now ?? Date.now;
    const ledger = this.readLedger();
    const record: WorkspaceDependencyLedgerRecord = {
      id: randomUUID(),
      createdAt: new Date(now()).toISOString(),
      manager: input.intent.manager,
      subcommand: input.intent.subcommand,
      command: input.command.trim(),
      workspaceRoot: this.workspaceRoot,
      cwdRelative: toWorkspaceRelative(this.workspaceRoot, input.cwd),
      packageRootRelative: toWorkspaceRelative(this.workspaceRoot, input.after.packageRoot),
      requestedPackages: [...input.intent.requestedPackages],
      added: [...input.diff.added],
      updated: [...input.diff.updated],
      removed: [...input.diff.removed],
      changedFiles: [...input.diff.changedFiles],
    };
    ledger.entries.push(record);
    this.writeLedger(ledger);
    return record;
  }

  listEntries(limit = 50): WorkspaceDependencyLedgerRecord[] {
    return this.readLedger().entries
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(1, limit));
  }

  buildPromptLines(limit = 2): string[] {
    const activeEntries = this.listEntries(20)
      .map((entry) => ({ entry, status: this.getEntryStatus(entry) }))
      .filter((item) => item.status !== 'stale')
      .slice(0, Math.max(1, limit));

    if (activeEntries.length === 0) return [];

    const lines = [
      'Workspace dependency awareness: recent JS package changes were recorded for this workspace. Treat packages listed below as available only while they remain in the current workspace manifests.',
    ];

    for (const { entry, status } of activeEntries) {
      const changeParts: string[] = [];
      if (entry.added.length > 0) {
        changeParts.push(`added ${formatDependencyChanges(entry.added)}`);
      }
      if (entry.updated.length > 0) {
        changeParts.push(`updated ${formatDependencyChanges(entry.updated)}`);
      }
      if (entry.removed.length > 0) {
        changeParts.push(`removed ${formatDependencyChanges(entry.removed)}`);
      }
      if (entry.changedFiles.length > 0) {
        changeParts.push(`files ${entry.changedFiles.join(', ')}`);
      }

      const statusLabel = status === 'partial' ? 'partially present' : 'present';
      const cwdLabel = entry.cwdRelative || '.';
      lines.push(`- ${entry.createdAt.slice(0, 10)} ${entry.manager} ${entry.subcommand} in ${cwdLabel}: ${changeParts.join('; ')} (${statusLabel})`);
    }

    return lines;
  }

  private getEntryStatus(entry: WorkspaceDependencyLedgerRecord): DependencyRecordStatus {
    const packageRoot = resolve(this.workspaceRoot, entry.packageRootRelative || '.');
    const snapshot = captureJsDependencySnapshot(this.workspaceRoot, packageRoot);
    if (!snapshot) return 'stale';

    let totalChecks = 0;
    let matchedChecks = 0;

    for (const change of entry.added) {
      totalChecks += 1;
      if (snapshot.dependencies[change.bucket][change.name] === change.version) {
        matchedChecks += 1;
      }
    }
    for (const change of entry.updated) {
      totalChecks += 1;
      if (snapshot.dependencies[change.bucket][change.name] === change.version) {
        matchedChecks += 1;
      }
    }
    for (const change of entry.removed) {
      totalChecks += 1;
      if (!(change.name in snapshot.dependencies[change.bucket])) {
        matchedChecks += 1;
      }
    }

    if (totalChecks === 0 || matchedChecks === 0) return 'stale';
    if (matchedChecks === totalChecks) return 'active';
    return 'partial';
  }

  private readLedger(): WorkspaceDependencyLedgerFile {
    if (!existsSync(this.ledgerPath)) {
      return { ...EMPTY_LEDGER, entries: [] };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.ledgerPath, 'utf-8')) as Partial<WorkspaceDependencyLedgerFile>;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      return { ...EMPTY_LEDGER, entries: [] };
    }
  }

  private writeLedger(ledger: WorkspaceDependencyLedgerFile): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8');
  }
}

function isJsPackageManager(value: string): value is JsPackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun';
}

function normalizeCommandName(command: string): string {
  const trimmed = command.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return basename.toLowerCase().replace(/(?:\.cmd|\.exe|\.bat)$/i, '');
}

function extractRequestedPackages(args: string[]): string[] {
  return args.filter((arg) => arg.trim() && !arg.startsWith('-'));
}

function toWorkspaceRelative(workspaceRoot: string, value: string): string {
  const normalized = relative(workspaceRoot, resolve(value)).replace(/\\/g, '/');
  return normalized || '.';
}

function findNearestPackageRoot(workspaceRoot: string, cwd: string): string | null {
  let current = resolve(cwd);
  const root = resolve(workspaceRoot);

  if (!isPathInside(current, root)) {
    current = root;
  }

  while (true) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    if (current === root) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current || !isPathInside(parent, root)) {
      return null;
    }
    current = parent;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function safeReadBinary(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function parsePackageJson(raw: string | null): Record<JsDependencyBucket, Record<string, string>> {
  const empty = emptyDependencies();
  if (!raw) return empty;

  try {
    const parsed = JSON.parse(raw) as Partial<Record<JsDependencyBucket, Record<string, string>>>;
    for (const bucket of JS_DEPENDENCY_BUCKETS) {
      const value = parsed[bucket];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        empty[bucket] = Object.fromEntries(
          Object.entries(value)
            .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
        );
      }
    }
  } catch {
    return empty;
  }

  return empty;
}

function emptyDependencies(): Record<JsDependencyBucket, Record<string, string>> {
  return {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
  };
}

function formatDependencyChanges(changes: JsDependencyChange[]): string {
  const values = changes.map((change) => {
    const bucketLabel = change.bucket === 'dependencies' ? '' : ` [${change.bucket}]`;
    if (change.previousVersion) {
      return `${change.name}@${change.previousVersion} -> ${change.version}${bucketLabel}`;
    }
    return `${change.name}@${change.version}${bucketLabel}`;
  });
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} (+${values.length - 3} more)`;
}
