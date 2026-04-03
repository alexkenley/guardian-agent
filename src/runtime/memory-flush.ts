import type { MemoryEntry } from './agent-memory-store.js';
import type { ConversationKey, MemoryFlushPayload } from './conversation.js';

export interface MemoryFlushContinuityContext {
  continuityKey?: string;
  focusSummary?: string;
  lastActionableRequest?: string;
  activeExecutionRefs?: string[];
}

export interface MemoryFlushPendingActionContext {
  blockerKind?: string;
  prompt?: string;
  route?: string;
  operation?: string;
}

export interface MemoryFlushCodeSessionContext {
  codeSessionId: string;
  title?: string;
  focusSummary?: string;
  planSummary?: string;
  compactedSummary?: string;
  pendingApprovalCount?: number;
}

export interface BuildMemoryFlushEntryInput {
  key: ConversationKey;
  flush: MemoryFlushPayload;
  createdAt: string;
  maxEntryChars: number;
  continuity?: MemoryFlushContinuityContext | null;
  pendingAction?: MemoryFlushPendingActionContext | null;
  codeSession?: MemoryFlushCodeSessionContext | null;
}

export interface MemoryFlushMaintenanceMetadata {
  maintenance: {
    kind: 'memory_hygiene';
    maintenanceType: 'context_flush';
    artifact: 'memory_entry';
    bounded: true;
    scope: 'global' | 'code_session';
    sessionId: string;
    totalDroppedCount: number;
    newlyDroppedCount: number;
    continuityKey?: string;
    codeSessionId?: string;
    route?: string;
  };
}

export interface BuildMemoryFlushMaintenanceMetadataInput {
  key: ConversationKey;
  flush: MemoryFlushPayload;
  continuity?: MemoryFlushContinuityContext | null;
  pendingAction?: MemoryFlushPendingActionContext | null;
  codeSession?: MemoryFlushCodeSessionContext | null;
}

export function buildMemoryFlushMaintenanceMetadata(
  input: BuildMemoryFlushMaintenanceMetadataInput,
): MemoryFlushMaintenanceMetadata {
  return {
    maintenance: {
      kind: 'memory_hygiene',
      maintenanceType: 'context_flush',
      artifact: 'memory_entry',
      bounded: true,
      scope: input.codeSession?.codeSessionId ? 'code_session' : 'global',
      sessionId: input.flush.sessionId,
      totalDroppedCount: input.flush.totalDroppedCount,
      newlyDroppedCount: input.flush.newlyDroppedCount,
      ...(input.continuity?.continuityKey ? { continuityKey: input.continuity.continuityKey } : {}),
      ...(input.codeSession?.codeSessionId ? { codeSessionId: input.codeSession.codeSessionId } : {}),
      ...(input.pendingAction?.route ? { route: input.pendingAction.route } : {}),
    },
  };
}

export function describeMemoryFlushMaintenanceDetail(input: {
  scope: 'global' | 'code_session';
  newlyDroppedCount: number;
  summary?: string;
  codeSessionId?: string;
}): string {
  const subject = truncateInlineText(normalizeInlineText(input.summary) || 'context flush', 120);
  const scopeLabel = input.scope === 'code_session'
    ? `code session${input.codeSessionId ? ` ${input.codeSessionId}` : ''}`
    : 'global memory';
  return `Context flush persisted to ${scopeLabel}: ${subject} (${input.newlyDroppedCount} captured line${input.newlyDroppedCount === 1 ? '' : 's'}).`;
}

export function describeMemoryFlushSkipDetail(input: {
  scope: 'global' | 'code_session';
  reason: 'read_only' | 'empty_entry';
  codeSessionId?: string;
  newlyDroppedCount: number;
}): string {
  const scopeLabel = input.scope === 'code_session'
    ? `code session${input.codeSessionId ? ` ${input.codeSessionId}` : ''}`
    : 'global memory';
  const reasonText = input.reason === 'read_only'
    ? 'store is read-only'
    : 'no durable summary could be derived';
  return `Context flush skipped for ${scopeLabel}: ${reasonText} (${input.newlyDroppedCount} dropped line${input.newlyDroppedCount === 1 ? '' : 's'}).`;
}

export function describeMemoryFlushFailureDetail(input: {
  scope: 'global' | 'code_session';
  codeSessionId?: string;
  newlyDroppedCount: number;
}): string {
  const scopeLabel = input.scope === 'code_session'
    ? `code session${input.codeSessionId ? ` ${input.codeSessionId}` : ''}`
    : 'global memory';
  return `Context flush failed for ${scopeLabel} (${input.newlyDroppedCount} dropped line${input.newlyDroppedCount === 1 ? '' : 's'}).`;
}

export function inferMemoryFlushScope(codeSession?: MemoryFlushCodeSessionContext | null): 'global' | 'code_session' {
  return codeSession?.codeSessionId ? 'code_session' : 'global';
}

const MEMORY_FLUSH_SUMMARY_MAX_CHARS = 200;
const MIN_TRANSCRIPT_LINE_CHARS = 18;

function normalizeInlineText(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInlineText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const candidate = value.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${candidate}...`;
}

function findLatestUserRequest(payload: MemoryFlushPayload): string {
  for (let i = payload.droppedMessages.length - 1; i >= 0; i--) {
    const entry = payload.droppedMessages[i];
    if (entry.role !== 'user') continue;
    const normalized = normalizeInlineText(entry.content);
    if (normalized.length >= MIN_TRANSCRIPT_LINE_CHARS) return normalized;
  }
  return '';
}

function pushLine(lines: string[], line: string, state: { remaining: number }): boolean {
  if (!line.trim()) return true;
  const extraChars = lines.length > 0 ? 1 : 0;
  if (state.remaining < line.length + extraChars) return false;
  lines.push(line);
  state.remaining -= line.length + extraChars;
  return true;
}

function pushSection(
  lines: string[],
  title: string,
  body: string,
  state: { remaining: number },
  maxBodyChars: number = 320,
): void {
  const normalized = normalizeInlineText(body);
  if (!normalized) return;
  const available = Math.max(40, Math.min(maxBodyChars, state.remaining - title.length - 8));
  if (available < 24) return;
  pushLine(lines, `${title}:`, state);
  pushLine(lines, truncateInlineText(normalized, available), state);
}

function sanitizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function buildMemoryFlushEntry(input: BuildMemoryFlushEntryInput): MemoryEntry | null {
  const maxEntryChars = Math.max(200, input.maxEntryChars);
  const objective = normalizeInlineText(
    input.continuity?.lastActionableRequest
      || findLatestUserRequest(input.flush)
      || input.codeSession?.focusSummary,
  );
  const focusSummary = normalizeInlineText(input.continuity?.focusSummary || input.codeSession?.focusSummary);
  const blockerPrompt = normalizeInlineText(input.pendingAction?.prompt);
  const planSummary = normalizeInlineText(input.codeSession?.planSummary);
  const compactedSummary = normalizeInlineText(input.codeSession?.compactedSummary);

  const transcriptLines = input.flush.droppedMessages
    .map((message) => ({
      role: message.role,
      content: normalizeInlineText(message.content),
    }))
    .filter((message) => message.content.length >= MIN_TRANSCRIPT_LINE_CHARS);

  if (!objective && transcriptLines.length === 0 && !blockerPrompt && !focusSummary) {
    return null;
  }

  const lines: string[] = [];
  const state = { remaining: maxEntryChars };
  pushLine(lines, '## Context Flush', state);
  pushLine(lines, `date: ${input.createdAt}`, state);
  pushLine(lines, `conversationSessionId: ${input.flush.sessionId}`, state);
  pushLine(lines, `channel: ${input.key.channel}`, state);
  if (input.codeSession?.codeSessionId) {
    pushLine(lines, `codeSessionId: ${input.codeSession.codeSessionId}`, state);
  }
  if (input.continuity?.continuityKey) {
    pushLine(lines, `continuityKey: ${input.continuity.continuityKey}`, state);
  }

  pushSection(lines, 'objective', objective, state, 360);
  if (focusSummary && focusSummary !== objective) {
    pushSection(lines, 'focusSummary', focusSummary, state, 280);
  }

  if (blockerPrompt) {
    const blockerLines = [
      input.pendingAction?.blockerKind ? `kind: ${input.pendingAction.blockerKind}` : '',
      input.pendingAction?.route ? `route: ${input.pendingAction.route}` : '',
      input.pendingAction?.operation ? `operation: ${input.pendingAction.operation}` : '',
      `prompt: ${blockerPrompt}`,
    ].filter(Boolean).join(' | ');
    pushSection(lines, 'activeBlocker', blockerLines, state, 320);
  }

  if (input.codeSession) {
    const codeSessionSummary = [
      input.codeSession.title ? `title: ${input.codeSession.title}` : '',
      typeof input.codeSession.pendingApprovalCount === 'number'
        ? `pendingApprovals: ${input.codeSession.pendingApprovalCount}`
        : '',
      planSummary ? `plan: ${planSummary}` : '',
      compactedSummary ? `compacted: ${compactedSummary}` : '',
    ].filter(Boolean).join(' | ');
    pushSection(lines, 'codeSessionState', codeSessionSummary, state, 320);
  }

  if (transcriptLines.length > 0 && pushLine(lines, 'transcript:', state)) {
    for (const transcript of transcriptLines) {
      const prefix = `- [${transcript.role}] `;
      const available = state.remaining - prefix.length - 1;
      if (available < 24) break;
      if (!pushLine(lines, `${prefix}${truncateInlineText(transcript.content, available)}`, state)) {
        break;
      }
    }
  }

  const content = lines.join('\n').trim();
  if (!content) return null;

  const summarySubject = truncateInlineText(objective || focusSummary || transcriptLines[0]?.content || 'recent context', 110);
  const summaryParts = [
    `Context flush for ${summarySubject}`,
    blockerPrompt && input.pendingAction?.blockerKind ? `(blocker: ${input.pendingAction.blockerKind})` : '',
    `${input.flush.newlyDroppedCount} captured line${input.flush.newlyDroppedCount === 1 ? '' : 's'}`,
  ].filter(Boolean);

  const tags = new Set<string>([
    'context_flush',
    input.key.channel === 'code-session' ? 'code_session' : 'assistant_chat',
  ]);
  if (focusSummary || objective) tags.add('continuity');
  if (input.pendingAction?.blockerKind) tags.add(sanitizeTag(input.pendingAction.blockerKind));
  if (input.pendingAction?.route) tags.add(sanitizeTag(input.pendingAction.route));
  if (input.pendingAction?.operation) tags.add(sanitizeTag(input.pendingAction.operation));
  if (input.codeSession?.codeSessionId) tags.add('coding');

  return {
    content,
    summary: truncateInlineText(summaryParts.join(' '), MEMORY_FLUSH_SUMMARY_MAX_CHARS),
    createdAt: input.createdAt,
    category: 'Context Flushes',
    sourceType: 'system',
    trustLevel: 'trusted',
    status: 'active',
    createdByPrincipal: 'system:auto_flush',
    tags: [...tags],
    provenance: {
      sessionId: input.flush.sessionId,
    },
  };
}
