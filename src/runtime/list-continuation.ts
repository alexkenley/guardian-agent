import type { ContinuityThreadContinuationState, ContinuityThreadRecord } from './continuity-threads.js';
import type { IntentGatewayDecision } from './intent-gateway.js';

export interface PagedListWindow {
  offset: number;
  limit: number;
  total: number;
}

export type PagedListContinuationRoute = 'automation_control' | 'browser_task' | 'email_task';

const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_VERBOSE_LIST_CHAR_BUDGET = 6000;

export function resolveListLimitWithinCharacterBudget<T>(
  items: readonly T[],
  input: {
    header?: string;
    renderItem: (item: T, index: number) => string;
    footerForRemaining?: (remaining: number) => string;
    maxChars?: number;
    minItems?: number;
    maxItems?: number;
  },
): number {
  const total = items.length;
  if (total <= 0) return 0;
  const maxChars = Math.max(1, Math.floor(input.maxChars ?? DEFAULT_VERBOSE_LIST_CHAR_BUDGET));
  const maxItems = Math.max(1, Math.min(total, Math.floor(input.maxItems ?? total)));
  const minItems = Math.max(1, Math.min(maxItems, Math.floor(input.minItems ?? 1)));
  const selectedLines = input.header?.trim() ? [input.header.trim()] : [];
  let accepted = 0;

  for (let index = 0; index < maxItems; index += 1) {
    const itemLine = input.renderItem(items[index] as T, index);
    const remaining = total - (index + 1);
    const footerLine = remaining > 0 ? input.footerForRemaining?.(remaining) : undefined;
    const projected = [
      ...selectedLines,
      itemLine,
      ...(footerLine ? [footerLine] : []),
    ].join('\n');
    if (projected.length > maxChars && accepted >= minItems) {
      break;
    }
    selectedLines.push(itemLine);
    accepted += 1;
  }

  return Math.max(minItems, accepted);
}

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
  turnRelation: IntentGatewayDecision['turnRelation'] | undefined,
): boolean {
  const text = content.trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, ' ');
  const wordCount = compact.split(/\s+/).filter(Boolean).length;
  if (turnRelation === 'follow_up'
    && wordCount <= 4
    && /\b(?:more|next|rest|remaining|additional)\b/i.test(compact)) {
    return true;
  }
  return /\b(?:next|another)\s+(?:page|items?|results?|entries|messages?|emails?|automations?|links?|pages?)\b/i.test(compact)
    || /\b(?:show|list|display|get|give)\b[\s\S]{0,80}\b(?:additional|more|remaining|next|rest)\b/i.test(compact)
    || /\bother\s+\d{1,3}\b/i.test(compact)
    || /\bother\s+(?:items|results|entries|messages|emails|automations|links|pages)\b/i.test(compact);
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
