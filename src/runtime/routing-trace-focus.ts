import type { IntentRoutingTraceEntry } from './intent-routing-trace.js';
import type { DashboardRunDetail, DashboardRunTimelineItem } from './run-timeline.js';

export interface RoutingTraceFocusItem {
  itemId: string;
  title: string;
  nodeId?: string;
}

function nonEmptyText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function listTimelineItems(run: DashboardRunDetail | null | undefined): DashboardRunTimelineItem[] {
  return Array.isArray(run?.items)
    ? run.items.filter((item): item is DashboardRunTimelineItem => !!item && typeof item.id === 'string' && item.id.trim().length > 0)
    : [];
}

function reverseFindItem(
  items: DashboardRunTimelineItem[],
  predicate: (item: DashboardRunTimelineItem) => boolean,
): DashboardRunTimelineItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (predicate(item)) return item;
  }
  return null;
}

function itemMatchesTool(item: DashboardRunTimelineItem, toolName: string | undefined): boolean {
  if (!toolName) return true;
  return nonEmptyText(item.toolName) === toolName;
}

function toFocusItem(item: DashboardRunTimelineItem | null): RoutingTraceFocusItem | null {
  if (!item) return null;
  const itemId = nonEmptyText(item.id);
  const title = nonEmptyText(item.title) ?? nonEmptyText(item.type) ?? 'Event';
  if (!itemId) return null;
  return {
    itemId,
    title,
    ...(nonEmptyText(item.nodeId) ? { nodeId: item.nodeId } : {}),
  };
}

export function pickRoutingTraceFocusItem(
  entry: Pick<IntentRoutingTraceEntry, 'stage' | 'details'>,
  run: DashboardRunDetail | null | undefined,
): RoutingTraceFocusItem | null {
  const items = listTimelineItems(run);
  if (items.length === 0) return null;

  const details = entry.details && typeof entry.details === 'object'
    ? entry.details as Record<string, unknown>
    : {};
  const toolName = nonEmptyText(typeof details.toolName === 'string' ? details.toolName : undefined);

  const latestItem = items[items.length - 1] ?? null;
  const contextItem = reverseFindItem(
    items,
    (item) => item.title === 'Assembled context' || !!item.contextAssembly,
  );
  const approvalItem = reverseFindItem(items, (item) => item.type === 'approval_requested');
  const startedToolItem = reverseFindItem(
    items,
    (item) => item.type === 'tool_call_started' && itemMatchesTool(item, toolName),
  ) ?? reverseFindItem(items, (item) => item.type === 'tool_call_started');
  const completedToolItem = reverseFindItem(
    items,
    (item) => item.type === 'tool_call_completed' && itemMatchesTool(item, toolName),
  ) ?? reverseFindItem(items, (item) => item.type === 'tool_call_completed');
  const preparedItem = items.find((item) => item.title === 'Prepared request') ?? null;
  const startedItem = items.find((item) => item.type === 'run_started') ?? null;

  switch (entry.stage) {
    case 'incoming_dispatch':
      return toFocusItem(preparedItem ?? startedItem ?? contextItem ?? latestItem);
    case 'gateway_classified':
    case 'tier_routing_decided':
    case 'profile_selection_decided':
    case 'context_budget_decided':
    case 'pre_routed_metadata_attached':
    case 'dispatch_response':
      return toFocusItem(contextItem ?? preparedItem ?? startedItem ?? latestItem);
    case 'clarification_requested':
      return toFocusItem(approvalItem ?? contextItem ?? latestItem);
    case 'direct_tool_call_started':
      return toFocusItem(startedToolItem ?? contextItem ?? latestItem);
    case 'direct_tool_call_completed':
      return toFocusItem(completedToolItem ?? approvalItem ?? contextItem ?? latestItem);
    case 'direct_intent_response':
      return toFocusItem(contextItem ?? latestItem);
    default:
      return toFocusItem(contextItem ?? latestItem);
  }
}
