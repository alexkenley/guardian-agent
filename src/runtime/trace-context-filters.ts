import type { AssistantDispatchTrace } from './orchestrator.js';
import type { IntentRoutingTraceEntry } from './intent-routing-trace.js';
import type { DashboardRunDetail } from './run-timeline.js';

export interface TraceContextFilterInput {
  continuityKey?: string;
  activeExecutionRef?: string;
}

interface NormalizedTraceContextFilters {
  continuityKey?: string;
  activeExecutionRef?: string;
}

function extractContextFiltersFromDetails(details: Record<string, unknown> | undefined): {
  continuityKey?: string;
  activeExecutionRefs?: string[];
} {
  if (!details) return {};
  const activeExecutionRefs = Array.isArray(details.activeExecutionRefs)
    ? details.activeExecutionRefs
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  return {
    ...(typeof details.continuityKey === 'string' && details.continuityKey.trim()
      ? { continuityKey: details.continuityKey.trim() }
      : {}),
    ...(activeExecutionRefs.length > 0 ? { activeExecutionRefs } : {}),
  };
}

function normalizeFilterValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeFilters(filters: TraceContextFilterInput): NormalizedTraceContextFilters {
  return {
    ...(normalizeFilterValue(filters.continuityKey) ? { continuityKey: normalizeFilterValue(filters.continuityKey) } : {}),
    ...(normalizeFilterValue(filters.activeExecutionRef)
      ? { activeExecutionRef: normalizeFilterValue(filters.activeExecutionRef)!.toLowerCase() }
      : {}),
  };
}

export function extractTraceContextFiltersFromTrace(trace: Pick<AssistantDispatchTrace, 'nodes'>): Array<{
  continuityKey?: string;
  activeExecutionRefs?: string[];
}> {
  const nodes = Array.isArray(trace.nodes) ? trace.nodes : [];
  return nodes
    .filter((node) => node?.kind === 'compile' && node?.name === 'Assembled context' && node.metadata && typeof node.metadata === 'object')
    .map((node) => {
      const metadata = node.metadata as Record<string, unknown>;
      const activeExecutionRefs = Array.isArray(metadata.activeExecutionRefs)
        ? metadata.activeExecutionRefs
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
        : [];
      return {
        ...(typeof metadata.continuityKey === 'string' && metadata.continuityKey.trim()
          ? { continuityKey: metadata.continuityKey.trim() }
          : {}),
        ...(activeExecutionRefs.length > 0 ? { activeExecutionRefs } : {}),
      };
    });
}

export function assistantTraceMatchesContextFilters(
  trace: Pick<AssistantDispatchTrace, 'nodes'>,
  filters: TraceContextFilterInput,
): boolean {
  const normalized = normalizeFilters(filters);
  if (!normalized.continuityKey && !normalized.activeExecutionRef) return true;
  const contexts = extractTraceContextFiltersFromTrace(trace);
  if (contexts.length === 0) return false;
  return contexts.some((context) => {
    if (normalized.continuityKey && context.continuityKey !== normalized.continuityKey) {
      return false;
    }
    if (normalized.activeExecutionRef) {
      const refs = Array.isArray(context.activeExecutionRefs) ? context.activeExecutionRefs : [];
      if (!refs.some((ref) => ref.toLowerCase().includes(normalized.activeExecutionRef!))) {
        return false;
      }
    }
    return true;
  });
}

export function runDetailMatchesContextFilters(
  detail: DashboardRunDetail,
  filters: TraceContextFilterInput,
): boolean {
  const normalized = normalizeFilters(filters);
  if (!normalized.continuityKey && !normalized.activeExecutionRef) return true;
  const items = Array.isArray(detail.items) ? detail.items : [];
  return items.some((item) => {
    const context = item.contextAssembly;
    if (!context) return false;
    if (normalized.continuityKey && context.continuityKey !== normalized.continuityKey) {
      return false;
    }
    if (normalized.activeExecutionRef) {
      const refs = Array.isArray(context.activeExecutionRefs) ? context.activeExecutionRefs : [];
      if (!refs.some((ref) => ref.toLowerCase().includes(normalized.activeExecutionRef!))) {
        return false;
      }
    }
    return true;
  });
}

export function extractTraceContextFiltersFromIntentRoutingEntry(
  entry: Pick<IntentRoutingTraceEntry, 'details'>,
): {
  continuityKey?: string;
  activeExecutionRefs?: string[];
} {
  return extractContextFiltersFromDetails(
    entry.details && typeof entry.details === 'object'
      ? entry.details as Record<string, unknown>
      : undefined,
  );
}

export function intentRoutingTraceEntryMatchesContextFilters(
  entry: Pick<IntentRoutingTraceEntry, 'details'>,
  filters: TraceContextFilterInput,
): boolean {
  const normalized = normalizeFilters(filters);
  if (!normalized.continuityKey && !normalized.activeExecutionRef) return true;
  const context = extractTraceContextFiltersFromIntentRoutingEntry(entry);
  if (normalized.continuityKey && context.continuityKey !== normalized.continuityKey) {
    return false;
  }
  if (normalized.activeExecutionRef) {
    const refs = Array.isArray(context.activeExecutionRefs) ? context.activeExecutionRefs : [];
    if (!refs.some((ref) => ref.toLowerCase().includes(normalized.activeExecutionRef!))) {
      return false;
    }
  }
  return true;
}
