import { stat, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendSecureFile, mkdirSecure } from '../util/secure-fs.js';
import { createLogger } from '../util/logging.js';
import { intentRoutingTraceEntryMatchesContextFilters } from './trace-context-filters.js';

import { getGuardianBaseDir } from '../util/env.js';

const log = createLogger('intent-routing-trace');

const DEFAULT_TRACE_DIR = join(getGuardianBaseDir(), 'routing');
const DEFAULT_TRACE_FILE = 'intent-routing.jsonl';
const DEFAULT_MAX_FILE_SIZE_BYTES = 5_000_000;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_PREVIEW_CHARS = 220;

export type IntentRoutingTraceStage =
  | 'incoming_dispatch'
  | 'gateway_classified'
  | 'clarification_requested'
  | 'tier_routing_decided'
  | 'profile_selection_decided'
  | 'context_budget_decided'
  | 'pre_routed_metadata_attached'
  | 'delegated_worker_started'
  | 'delegated_worker_running'
  | 'delegated_worker_retrying'
  | 'delegated_worker_completed'
  | 'delegated_worker_failed'
  | 'direct_candidates_evaluated'
  | 'direct_tool_call_started'
  | 'direct_tool_call_completed'
  | 'direct_intent_response'
  | 'dispatch_response'
  | 'approval_decision_resolved'
  | 'approval_continuation_resolved';

export interface IntentRoutingTraceEntry {
  id: string;
  timestamp: number;
  stage: IntentRoutingTraceStage;
  requestId?: string;
  messageId?: string;
  userId?: string;
  channel?: string;
  agentId?: string;
  contentPreview?: string;
  details?: Record<string, unknown>;
}

export interface IntentRoutingTraceStatus {
  enabled: boolean;
  filePath: string;
  lastError?: string;
}

export interface IntentRoutingTraceOptions {
  enabled?: boolean;
  directory?: string;
  maxFileSizeBytes?: number;
  maxFiles?: number;
  previewChars?: number;
}

export interface IntentRoutingTraceListOptions {
  limit?: number;
  continuityKey?: string;
  activeExecutionRef?: string;
  executionId?: string;
  rootExecutionId?: string;
  taskExecutionId?: string;
  pendingActionId?: string;
  codeSessionId?: string;
  stage?: IntentRoutingTraceStage;
  channel?: string;
  agentId?: string;
  userId?: string;
  requestId?: string;
}

let nextTraceId = 1;

function createTraceId(now: number): string {
  return `route-${now}-${nextTraceId++}`;
}

function previewText(value: string | undefined, previewChars: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= previewChars) return trimmed;
  return `${trimmed.slice(0, previewChars - 1)}…`;
}

export class IntentRoutingTraceLog {
  private readonly enabled: boolean;
  private readonly traceDir: string;
  private readonly filePath: string;
  private readonly maxFileSizeBytes: number;
  private readonly maxFiles: number;
  private readonly previewChars: number;
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastError?: string;

  constructor(options: IntentRoutingTraceOptions = {}) {
    this.enabled = options.enabled !== false;
    this.traceDir = options.directory?.trim() || DEFAULT_TRACE_DIR;
    this.filePath = join(this.traceDir, DEFAULT_TRACE_FILE);
    this.maxFileSizeBytes = Math.max(1_024, options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES);
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.previewChars = Math.max(60, options.previewChars ?? DEFAULT_PREVIEW_CHARS);
  }

  async init(): Promise<void> {
    if (!this.enabled || this.initialized) return;
    await mkdirSecure(this.traceDir);
    this.initialized = true;
    log.info(
      {
        filePath: this.filePath,
        maxFileSizeBytes: this.maxFileSizeBytes,
        maxFiles: this.maxFiles,
      },
      'Intent routing trace initialized',
    );
  }

  record(input: Omit<IntentRoutingTraceEntry, 'id' | 'timestamp' | 'contentPreview'> & { contentPreview?: string }): void {
    if (!this.enabled) return;
    const now = Date.now();
    const entry: IntentRoutingTraceEntry = {
      ...input,
      id: createTraceId(now),
      timestamp: now,
      contentPreview: previewText(input.contentPreview, this.previewChars),
    };
    const line = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.initialized) {
          await this.init();
        }
        await this.rotateIfNeeded(Buffer.byteLength(line));
        await appendSecureFile(this.filePath, line);
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        log.warn({ err: this.lastError }, 'Failed to persist intent routing trace');
      });
  }

  async readTail(count: number): Promise<IntentRoutingTraceEntry[]> {
    if (!this.enabled || count <= 0) return [];
    const entries = await this.readAllEntries();
    return entries.slice(-count);
  }

  async listRecent(options: IntentRoutingTraceListOptions = {}): Promise<IntentRoutingTraceEntry[]> {
    if (!this.enabled) return [];
    const limit = Math.max(1, options.limit ?? 20);
    const entries = await this.readAllEntries();
    return entries
      .filter((entry) => {
        if (options.stage && entry.stage !== options.stage) return false;
        if (options.channel && entry.channel !== options.channel) return false;
        if (options.agentId && entry.agentId !== options.agentId) return false;
        if (options.userId && entry.userId !== options.userId) return false;
        if (options.requestId && entry.requestId !== options.requestId) return false;
        if (!intentRoutingTraceEntryMatchesContextFilters(entry, options)) return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  private async readAllEntries(): Promise<IntentRoutingTraceEntry[]> {
    if (!this.enabled) return [];
    const files: string[] = [];
    for (let index = this.maxFiles - 1; index >= 0; index--) {
      const path = this.tracePathForIndex(index);
      try {
        await stat(path);
        files.push(path);
      } catch {
        // ignore missing files
      }
    }

    const entries: IntentRoutingTraceEntry[] = [];
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line) as IntentRoutingTraceEntry);
          } catch {
            // ignore malformed entries in tail reads
          }
        }
      } catch {
        // ignore read failures for tail inspection
      }
    }
    return entries;
  }

  getStatus(): IntentRoutingTraceStatus {
    return {
      enabled: this.enabled,
      filePath: this.filePath,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    try {
      const current = await stat(this.filePath);
      if ((current.size + incomingBytes) <= this.maxFileSizeBytes) {
        return;
      }
    } catch {
      return;
    }

    if (this.maxFiles <= 1) {
      await rm(this.filePath, { force: true });
      return;
    }

    const oldestPath = this.tracePathForIndex(this.maxFiles - 1);
    await rm(oldestPath, { force: true });

    for (let index = this.maxFiles - 2; index >= 0; index--) {
      const from = this.tracePathForIndex(index);
      const to = this.tracePathForIndex(index + 1);
      try {
        await rename(from, to);
      } catch {
        // ignore gaps in the rotation set
      }
    }
  }

  private tracePathForIndex(index: number): string {
    if (index <= 0) return this.filePath;
    return `${this.filePath}.${index}`;
  }
}
