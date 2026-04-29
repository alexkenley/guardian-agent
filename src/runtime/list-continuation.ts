import type { ContinuityThreadContinuationState, ContinuityThreadRecord } from './continuity-threads.js';
import type { IntentGatewayDecision } from './intent-gateway.js';

export interface PagedListWindow {
  offset: number;
  limit: number;
  total: number;
}

export type PagedListContinuationRoute = 'automation_control' | 'browser_task' | 'email_task';

const DEFAULT_PAGE_SIZE = 20;

export function buildPagedListContinuationState(
  kind: string,
  window: PagedListWindow,
): ContinuityThreadContinuationState {
  return {
    kind,
    payload: {
      offset: Math.max(0, Math.floor(window.offset)),
      limit: Math.max(0, Math.floor(window.limit)),
      total: Math.max(0, Math.floor(window.total)),
    },
  };
}

export function readPagedListContinuationState(
  continuityThread: ContinuityThreadRecord | null | undefined,
  kind: string,
): PagedListWindow | null {
  const state = continuityThread?.continuationState;
  if (!state || state.kind !== kind) return null;
  const offset = asNonNegativeInteger(state.payload.offset);
  const limit = asNonNegativeInteger(state.payload.limit);
  const total = asNonNegativeInteger(state.payload.total);
  if (offset === null || limit === null || total === null) return null;
  return { offset, limit, total };
}

export function resolvePagedListWindow(input: {
  continuityThread?: ContinuityThreadRecord | null;
  continuationKind: string;
  content: string;
  total: number;
  turnRelation?: IntentGatewayDecision['turnRelation'];
  defaultPageSize?: number;
}): PagedListWindow {
  const total = Math.max(0, Math.floor(input.total));
  const pageSize = Math.max(1, Math.floor(input.defaultPageSize ?? DEFAULT_PAGE_SIZE));
  const prior = readPagedListContinuationState(input.continuityThread, input.continuationKind);
  if (!prior || !hasPagedListFollowUpRequest(input.content, input.turnRelation)) {
    return {
      offset: 0,
      limit: Math.min(pageSize, total),
      total,
    };
  }

  const nextOffset = Math.min(total, prior.offset + Math.max(0, prior.limit));
  if (nextOffset >= total) {
    return {
      offset: total,
      limit: 0,
      total,
    };
  }

  const remaining = total - nextOffset;
  if (wantsRemainingItems(input.content)) {
    return {
      offset: nextOffset,
      limit: remaining,
      total,
    };
  }

  const requestedCount = readRequestedAdditionalCount(input.content);
  return {
    offset: nextOffset,
    limit: Math.min(requestedCount ?? Math.max(prior.limit, pageSize), remaining),
    total,
  };
}

export function hasPagedListFollowUpRequest(
  content: string,
  _turnRelation: IntentGatewayDecision['turnRelation'] | undefined,
): boolean {
  return /\b(additional|more|remaining|next)\b/i.test(content)
    || /\brest\b/.test(content)
    || /\bother\s+\d{1,3}\b/i.test(content)
    || /\bother\s+(?:items|results|entries|messages|emails|automations|links|pages)\b/i.test(content);
}

export function resolvePagedListContinuationRoute(input: {
  continuationStateKind?: string | null;
  content: string;
  turnRelation?: IntentGatewayDecision['turnRelation'];
}): PagedListContinuationRoute | null {
  if (!hasPagedListFollowUpRequest(input.content, input.turnRelation)) return null;
  switch (input.continuationStateKind) {
    case 'automation_catalog_list':
      return 'automation_control';
    case 'browser_links_list':
      return 'browser_task';
    case 'gmail_unread_list':
    case 'gmail_recent_senders_list':
    case 'gmail_recent_summary_list':
    case 'm365_unread_list':
    case 'm365_recent_senders_list':
    case 'm365_recent_summary_list':
      return 'email_task';
    default:
      return null;
  }
}

function wantsRemainingItems(content: string): boolean {
  return /\b(remaining|all remaining|all the remaining|all the rest)\b/i.test(content)
    || /\brest\b/.test(content);
}

function readRequestedAdditionalCount(content: string): number | undefined {
  const match = content.match(/\b(?:additional|next|more)\s+(\d{1,3})\b/i)
    ?? content.match(/\b(\d{1,3})\s+(?:more|additional)\b/i)
    ?? content.match(/\blist\s+the\s+additional\s+(\d{1,3})\b/i)
    ?? content.match(/\b(?:show|list)\s+the\s+other\s+(\d{1,3})\b/i)
    ?? content.match(/\bother\s+(\d{1,3})\b/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function asNonNegativeInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}
