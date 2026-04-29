import type { AssistantDispatchTrace } from './orchestrator.js';
import type { IntentRoutingTraceEntry } from './intent-routing-trace.js';
import type { DashboardRunDetail } from './run-timeline.js';

export interface TraceContextFilterInput {
  continuityKey?: string;
  activeExecutionRef?: string;
  executionId?: string;
  rootExecutionId?: string;
  taskExecutionId?: string;
  pendingActionId?: string;
  codeSessionId?: string;
}

interface NormalizedTraceContextFilters {
  continuityKey?: string;
  activeExecutionRef?: string;
  executionId?: string;
  rootExecutionId?: string;
  taskExecutionId?: string;
  pendingActionId?: string;
  codeSessionId?: string;
}

interface ExtractedTraceContextFilters {
  continuityKey?: string;
  activeExecutionRefs?: string[];
  executionId?: string;
  rootExecutionId?: string;
  taskExecutionId?: string;
  pendingActionId?: string;
  codeSessionId?: string;
}

function readOptionalTraceString(details: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!details) return undefined;
  const value = details[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractContextFiltersFromDetails(details: Record<string, unknown> | undefined): ExtractedTraceContextFilters {
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
    ...(readOptionalTraceString(details, 'executionId') ? { executionId: readOptionalTraceString(details, 'executionId') } : {}),
    ...(readOptionalTraceString(details, 'rootExecutionId') ? { rootExecutionId: readOptionalTraceString(details, 'rootExecutionId') } : {}),
    ...(readOptionalTraceString(details, 'taskExecutionId') ? { taskExecutionId: readOptionalTraceString(details, 'taskExecutionId') } : {}),
    ...(readOptionalTraceString(details, 'pendingActionId') ? { pendingActionId: readOptionalTraceString(details, 'pendingActionId') } : {}),
    ...(readOptionalTraceString(details, 'codeSessionId') ? { codeSessionId: readOptionalTraceString(details, 'codeSessionId') } : {}),
  };
}

function extractContextFiltersFromRunSummary(detail: DashboardRunDetail): ExtractedTraceContextFilters {
  const summary = detail.summary;
  return {
    ...(typeof summary.executionId === 'string' && summary.executionId.trim() ? { executionId: summary.executionId.trim() } : {}),
    ...(typeof summary.rootExecutionId === 'string' && summary.rootExecutionId.trim() ? { rootExecutionId: summary.rootExecutionId.trim() } : {}),
    ...(typeof summary.codeSessionId === 'string' && summary.codeSessionId.trim() ? { codeSessionId: summary.codeSessionId.trim() } : {}),
  };
}

function mergeContextWithRunSummary(
  context: ExtractedTraceContextFilters,
  summary: ExtractedTraceContextFilters,
): ExtractedTraceContextFilters {
  return {
    ...context,
    ...(context.executionId ? {} : summary.executionId ? { executionId: summary.executionId } : {}),
    ...(context.rootExecutionId ? {} : summary.rootExecutionId ? { rootExecutionId: summary.rootExecutionId } : {}),
    ...(context.codeSessionId ? {} : summary.codeSessionId ? { codeSessionId: summary.codeSessionId } : {}),
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
    ...(normalizeFilterValue(filters.executionId)
      ? { executionId: normalizeFilterValue(filters.executionId)!.toLowerCase() }
      : {}),
    ...(normalizeFilterValue(filters.rootExecutionId)
      ? { rootExecutionId: normalizeFilterValue(filters.rootExecutionId)!.toLowerCase() }
      : {}),
    ...(normalizeFilterValue(filters.taskExecutionId)
      ? { taskExecutionId: normalizeFilterValue(filters.taskExecutionId)!.toLowerCase() }
      : {}),
    ...(normalizeFilterValue(filters.pendingActionId)
      ? { pendingActionId: normalizeFilterValue(filters.pendingActionId)!.toLowerCase() }
      : {}),
    ...(normalizeFilterValue(filters.codeSessionId)
      ? { codeSessionId: normalizeFilterValue(filters.codeSessionId)!.toLowerCase() }
      : {}),
  };
}

function matchesPartialValue(candidate: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!candidate) return false;
  return candidate.toLowerCase().includes(filter);
}

function hasAnyContextFilter(filters: NormalizedTraceContextFilters): boolean {
  return Boolean(
    filters.continuityKey
    || filters.activeExecutionRef
    || filters.executionId
    || filters.rootExecutionId
    || filters.taskExecutionId
    || filters.pendingActionId
    || filters.codeSessionId,
  );
}

function matchesExtractedContext(
  context: ExtractedTraceContextFilters,
  filters: NormalizedTraceContextFilters,
): boolean {
  if (filters.continuityKey && context.continuityKey !== filters.continuityKey) {
    return false;
  }
  if (filters.activeExecutionRef) {
    const refs = Array.isArray(context.activeExecutionRefs) ? context.activeExecutionRefs : [];
    if (!refs.some((ref) => ref.toLowerCase().includes(filters.activeExecutionRef!))) {
      return false;
    }
  }
  if (!matchesPartialValue(context.executionId, filters.executionId)) return false;
  if (!matchesPartialValue(context.rootExecutionId, filters.rootExecutionId)) return false;
  if (!matchesPartialValue(context.taskExecutionId, filters.taskExecutionId)) return false;
  if (!matchesPartialValue(context.pendingActionId, filters.pendingActionId)) return false;
  if (!matchesPartialValue(context.codeSessionId, filters.codeSessionId)) return false;
  return true;
}

export function extractTraceContextFiltersFromTrace(trace: Pick<AssistantDispatchTrace, 'nodes'>): ExtractedTraceContextFilters[] {
  const nodes = Array.isArray(trace.nodes) ? trace.nodes : [];
  return nodes
    .filter((node) => node?.kind === 'compile' && node?.name === 'Assembled context' && node.metadata && typeof node.metadata === 'object')
    .map((node) => extractContextFiltersFromDetails(node.metadata as Record<string, unknown>));
}

export function assistantTraceMatchesContextFilters(
  trace: Pick<AssistantDispatchTrace, 'nodes'>,
  filters: TraceContextFilterInput,
): boolean {
  const normalized = normalizeFilters(filters);
  if (!hasAnyContextFilter(normalized)) return true;
  const contexts = extractTraceContextFiltersFromTrace(trace);
  if (contexts.length === 0) return false;
  return contexts.some((context) => matchesExtractedContext(context, normalized));
}

export function runDetailMatchesContextFilters(
  detail: DashboardRunDetail,
  filters: TraceContextFilterInput,
): boolean {
  const normalized = normalizeFilters(filters);
  if (!hasAnyContextFilter(normalized)) return true;
  const summaryContext = extractContextFiltersFromRunSummary(detail);
  const items = Array.isArray(detail.items) ? detail.items : [];
  if (items.length === 0) {
    return matchesExtractedContext(summaryContext, normalized);
  }
  return items.some((item) => {
    const context = item.contextAssembly;
    if (!context) return matchesExtractedContext(summaryContext, normalized);
    return matchesExtractedContext(
      mergeContextWithRunSummary(
        extractContextFiltersFromDetails(context as unknown as Record<string, unknown>),
        summaryContext,
      ),
      normalized,
    );
  });
}

export function extractTraceContextFiltersFromIntentRoutingEntry(
  entry: Pick<IntentRoutingTraceEntry, 'details'>,
): ExtractedTraceContextFilters {
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
  if (!hasAnyContextFilter(normalized)) return true;
  return matchesExtractedContext(extractTraceContextFiltersFromIntentRoutingEntry(entry), normalized);
}
