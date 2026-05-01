import { stat, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendSecureFile, mkdirSecure } from '../util/secure-fs.js';
import { createLogger } from '../util/logging.js';
import { isSensitiveKeyName, normalizeSensitiveKeyName, redactSensitiveText } from '../util/crypto-guardrails.js';
import { intentRoutingTraceEntryMatchesContextFilters } from './trace-context-filters.js';

import { getGuardianBaseDir } from '../util/env.js';

const log = createLogger('intent-routing-trace');

const DEFAULT_TRACE_DIR = join(getGuardianBaseDir(), 'routing');
const DEFAULT_TRACE_FILE = 'intent-routing.jsonl';
const DEFAULT_MAX_FILE_SIZE_BYTES = 5_000_000;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_PREVIEW_CHARS = 220;
const TRACE_REDACTED_VALUE = '[REDACTED]';
const TRACE_REDACTED_PAYLOAD_REASON = 'trace_payload_redacted';
const TRACE_MAX_SANITIZE_DEPTH = 12;
const TRACE_RAW_PAYLOAD_KEYS = new Set([
  'attachment',
  'attachments',
  'body',
  'content',
  'data',
  'email',
  'emails',
  'event',
  'events',
  'html',
  'item',
  'items',
  'message',
  'messages',
  'output',
  'payload',
  'rawoutput',
  'rawpayload',
  'rawresponse',
  'rawresult',
  'record',
  'records',
  'response',
  'result',
  'rows',
  'stderr',
  'stdout',
  'text',
  'tooloutput',
  'toolresult',
]);
const TRACE_SENSITIVE_KEY_PATTERN = /(?:apikey|apitoken|authorization|bearer|clientsecret|cookie|credential|jwt|passphrase|password|privatekey|refreshtoken|secret|sessionid|token)/;
const TRACE_SAFE_CORRELATION_KEYS = new Set([
  'activeexecutionrefs',
  'agentid',
  'approvalid',
  'approvalids',
  'codesessionid',
  'continuitykey',
  'executionid',
  'messageid',
  'pendingactionid',
  'requestid',
  'rootexecutionid',
  'taskexecutionid',
  'taskrunid',
  'userid',
  'workerid',
]);

export type IntentRoutingTraceStage =
  | 'incoming_dispatch'
  | 'gateway_classified'
  | 'gateway_classification_failed'
  | 'gateway_classification_skipped'
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
  | 'delegated_worker_contract_reconciled'
  | 'delegated_job_wait_expired'
  | 'delegated_tool_call_started'
  | 'delegated_tool_call_completed'
  | 'delegated_interruption_requested'
  | 'delegated_interruption_resolved'
  | 'delegated_claim_emitted'
  | 'delegated_verification_decided'
  | 'direct_candidates_evaluated'
  | 'direct_tool_call_started'
  | 'direct_tool_call_completed'
  | 'direct_intent_response'
  | 'dispatch_response'
  | 'approval_decision_resolved'
  | 'approval_continuation_resolved'
  | 'direct_reasoning_started'
  | 'direct_reasoning_llm_call_started'
  | 'direct_reasoning_llm_call_completed'
  | 'direct_reasoning_tool_call'
  | 'direct_reasoning_evidence_required_retry'
  | 'direct_reasoning_evidence_hydration'
  | 'direct_reasoning_synthesis_reserved'
  | 'direct_reasoning_synthesis_started'
  | 'direct_reasoning_synthesis_coverage_revision'
  | 'direct_reasoning_synthesis_completed'
  | 'direct_reasoning_synthesis_rejected'
  | 'direct_reasoning_completed'
  | 'direct_reasoning_failed'
  | 'recovery_advisor_started'
  | 'recovery_advisor_completed'
  | 'recovery_advisor_rejected';

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
  const trimmed = redactSensitiveTraceText(value).replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= previewChars) return trimmed;
  return `${trimmed.slice(0, previewChars - 1)}…`;
}

function redactSensitiveTraceText(value: string): string {
  return redactSensitiveText(value, TRACE_REDACTED_VALUE);
}

function isTraceSensitiveKey(key: string): boolean {
  const normalized = normalizeSensitiveKeyName(key);
  if (TRACE_SAFE_CORRELATION_KEYS.has(normalized)) return false;
  return isSensitiveKeyName(key) || TRACE_SENSITIVE_KEY_PATTERN.test(normalized);
}

function isTraceRawPayloadKey(key: string): boolean {
  return TRACE_RAW_PAYLOAD_KEYS.has(normalizeSensitiveKeyName(key));
}

function summarizeRedactedTracePayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      redacted: true,
      reason: TRACE_REDACTED_PAYLOAD_REASON,
      valueType: 'array',
      itemCount: value.length,
    };
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return {
      redacted: true,
      reason: TRACE_REDACTED_PAYLOAD_REASON,
      valueType: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 12).map((key) => isTraceSensitiveKey(key) ? TRACE_REDACTED_VALUE : redactSensitiveTraceText(key)),
    };
  }
  if (typeof value === 'string') {
    return {
      redacted: true,
      reason: TRACE_REDACTED_PAYLOAD_REASON,
      valueType: 'string',
      length: value.length,
    };
  }
  return {
    redacted: true,
    reason: TRACE_REDACTED_PAYLOAD_REASON,
    valueType: value === null ? 'null' : typeof value,
  };
}

function sanitizeTraceValue(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
  if (key && isTraceSensitiveKey(key)) {
    return TRACE_REDACTED_VALUE;
  }
  if (key && isTraceRawPayloadKey(key)) {
    return summarizeRedactedTracePayload(value);
  }
  if (typeof value === 'string') {
    return redactSensitiveTraceText(value);
  }
  if (Array.isArray(value)) {
    if (depth >= TRACE_MAX_SANITIZE_DEPTH) {
      return { redacted: true, reason: 'trace_depth_limit', valueType: 'array', itemCount: value.length };
    }
    return value.map((item) => sanitizeTraceValue(item, undefined, depth + 1, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      return { redacted: true, reason: 'trace_cycle' };
    }
    if (depth >= TRACE_MAX_SANITIZE_DEPTH) {
      return {
        redacted: true,
        reason: 'trace_depth_limit',
        valueType: 'object',
        keyCount: Object.keys(value as Record<string, unknown>).length,
      };
    }
    seen.add(value);
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[childKey] = sanitizeTraceValue(childValue, childKey, depth + 1, seen);
    }
    seen.delete(value);
    return sanitized;
  }
  return value;
}

function sanitizeTraceDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const sanitized = sanitizeTraceValue(details, undefined, 0, new WeakSet<object>());
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : undefined;
}

function sanitizeTraceEntry(entry: IntentRoutingTraceEntry, previewChars: number): IntentRoutingTraceEntry {
  return {
    ...entry,
    contentPreview: previewText(entry.contentPreview, previewChars),
    details: sanitizeTraceDetails(entry.details),
  };
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
      details: sanitizeTraceDetails(input.details),
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
            entries.push(sanitizeTraceEntry(JSON.parse(line) as IntentRoutingTraceEntry, this.previewChars));
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
