import type { AgentContext, UserMessage } from '../agent/types.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { IntentGatewayDecision } from './intent-gateway.js';
import { isExplicitAutomationOutputRequest } from './intent/entity-resolvers/automation.js';
import type { AutomationSaveInput } from './automation-save.js';
import {
  parseAutomationSchedule,
  type AutomationScheduleSpec,
} from './automation-authoring.js';
import type {
  AssistantConnectorPlaybookDefinition,
  AssistantConnectorPlaybookStepDefinition,
  AutomationOutputHandlingConfig,
} from '../config/types.js';
import type { ScheduledTaskDefinition } from './scheduled-tasks.js';
import {
  resolveSavedAutomationCatalogEntry,
  type SavedAutomationCatalogEntry,
  type SavedAutomationCatalogSelection,
} from './automation-catalog.js';
import { extractAutomationListEntries } from './automation-tool-results.js';
import type { ContinuityThreadRecord } from './continuity-threads.js';
import {
  buildPagedListContinuationState,
  DEFAULT_VERBOSE_LIST_CHAR_BUDGET,
  resolveListLimitWithinCharacterBudget,
  resolvePagedListWindow,
  type PagedListWindow,
} from './list-continuation.js';

export interface AutomationControlPendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
  actionLabel?: string;
}

export interface AutomationControlPreRouteResult {
  content: string;
  metadata?: {
    pendingAction?: Record<string, unknown>;
    clarification?: Record<string, unknown>;
    continuationState?: Record<string, unknown> | null;
  };
}

type AutomationControlToolName =
  | 'automation_list'
  | 'automation_save'
  | 'automation_set_enabled'
  | 'automation_run'
  | 'automation_delete';

interface AutomationControlPreRouteParams {
  agentId: string;
  message: UserMessage;
  continuityThread?: ContinuityThreadRecord | null;
  checkAction?: AgentContext['checkAction'];
  executeTool: (
    toolName: AutomationControlToolName,
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ) => Promise<Record<string, unknown>>;
  trackPendingApproval?: (approvalId: string) => void;
  onPendingApproval?: (input: { approvalId: string; approved: string; denied: string }) => void;
  formatPendingApprovalPrompt?: (ids: string[]) => string;
  resolvePendingApprovalMetadata?: (ids: string[], fallback: AutomationControlPendingApprovalMetadata[]) => AutomationControlPendingApprovalMetadata[];
}

interface AutomationControlIntent {
  operation: 'delete' | 'toggle' | 'run' | 'inspect' | 'read' | 'clone' | 'update' | 'unknown';
  automationName?: string;
  newAutomationName?: string;
  readView?: 'catalog' | 'count';
  enabled?: boolean;
  turnRelation?: IntentGatewayDecision['turnRelation'];
}

interface AutomationCatalogLookupResult {
  entries: SavedAutomationCatalogEntry[];
  error?: string;
}

interface AutomationScheduleChange {
  enabled: boolean;
  cron?: string;
  runOnce?: boolean;
  label?: string;
}

interface AutomationControlUpdateRequest {
  nextName?: string;
  schedule?: AutomationScheduleChange;
  needsScheduleClarification?: boolean;
}

const AUTOMATION_CATALOG_CONTINUATION_KIND = 'automation_catalog_list';

export async function tryAutomationControlPreRoute(
  params: AutomationControlPreRouteParams,
  options?: { intentDecision?: IntentGatewayDecision | null },
): Promise<AutomationControlPreRouteResult | null> {
  if (isExplicitAutomationOutputRequest(params.message.content)) {
    return null;
  }
  const intent = resolveAutomationControlIntent(
    params.message.content,
    options?.intentDecision,
  );
  if (!intent || intent.operation === 'clone' || intent.operation === 'unknown') return null;

  const toolRequest = toolRequestFor(params);
  const catalogLookup = await listAutomationCatalog(params.executeTool, toolRequest);
  const catalog = catalogLookup.entries;
  const resolvedSelection = intent.automationName
    ? resolveSavedAutomationCatalogEntry(catalog, intent.automationName)
    : null;
  const selection = resolvedSelection && (resolvedSelection.matchType !== 'closest'
    || intent.operation === 'inspect'
    || intent.operation === 'read'
    || intent.operation === 'run')
    ? resolvedSelection
    : null;
  const recentFollowUpSelection = !selection
    ? resolveRecentFollowUpAutomationSelection(catalog, intent, params.message.content)
    : null;
  const selected = selection?.entry ?? recentFollowUpSelection?.entry ?? null;
  const selectionLead = buildAutomationSelectionLead(
    selection,
    recentFollowUpSelection,
    intent.automationName,
  );

  if (intent.operation === 'inspect' || intent.operation === 'read') {
    const listWindow = !selected && intent.readView !== 'count'
      ? resolveAutomationCatalogListWindow(catalog, params.continuityThread, intent, params.message.content)
      : null;
    const result = withAutomationCatalogContinuation(
      {
        content: renderAutomationInspectCopy(
          catalog,
          selected,
          catalogLookup.error,
          selection,
          intent.automationName,
          intent.readView,
          listWindow ?? undefined,
        ),
      },
      listWindow
        ? buildAutomationCatalogContinuationState(listWindow)
        : null,
    );
    return selectionLead
      ? {
          ...result,
          content: `${selectionLead}\n\n${result.content}`,
        }
      : result;
  }

  if (!intent.automationName && !recentFollowUpSelection) {
    return buildAutomationClarificationResult(
      'Tell me which automation you want to inspect, run, rename, enable, disable, or edit.',
      {
        field: 'automation_name',
        route: 'automation_control',
        operation: intent.operation,
        summary: 'Select the saved automation to update or control.',
        missingFields: ['automation_name'],
        entities: buildAutomationControlIntentEntities(intent),
      },
    );
  }

  if (!selected) {
    return {
      content: `I could not find an automation named '${intent.automationName}'.`,
    };
  }

  switch (intent.operation) {
    case 'run':
      return withAutomationSelectionLead(
        withAutomationCatalogContinuation(
          await runAutomationEntry(params, toolRequest, selected, selection, intent.automationName),
          null,
        ),
        selectionLead,
      );
    case 'update':
      return withAutomationSelectionLead(
        withAutomationCatalogContinuation(
          await updateAutomationEntry(params, toolRequest, selected, catalog, intent),
          null,
        ),
        selectionLead,
      );
    case 'toggle':
      return withAutomationSelectionLead(
        withAutomationCatalogContinuation(
          await toggleAutomationEntry(params, toolRequest, selected, intent.enabled),
          null,
        ),
        selectionLead,
      );
    case 'delete':
      return withAutomationSelectionLead(
        withAutomationCatalogContinuation(
          await deleteAutomationEntry(params, toolRequest, selected),
          null,
        ),
        selectionLead,
      );
    default:
      return null;
  }
}

function toolRequestFor(
  params: AutomationControlPreRouteParams,
): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
  return {
    origin: 'assistant',
    agentId: params.agentId,
    userId: params.message.userId,
    principalId: params.message.principalId,
    principalRole: params.message.principalRole,
    channel: params.message.channel,
    requestId: params.message.id,
    agentContext: params.checkAction ? { checkAction: params.checkAction } : undefined,
  };
}

async function listAutomationCatalog(
  executeTool: AutomationControlPreRouteParams['executeTool'],
  request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
): Promise<AutomationCatalogLookupResult> {
  const result = await executeTool('automation_list', {}, request);
  return parseAutomationListResult(result);
}

function resolveAutomationControlIntent(
  content: string,
  decision?: IntentGatewayDecision | null,
): AutomationControlIntent | null {
  if (decision) {
    const routed = resolveDecisionBackedIntent(decision, content);
    if (routed) return routed;
  }
  return null;
}

function resolveDecisionBackedIntent(
  decision: IntentGatewayDecision,
  content: string,
): AutomationControlIntent | null {
  const route = decision.route;
  const automationsSurface = decision.entities.uiSurface === 'automations';
  if (route !== 'automation_control' && !(route === 'ui_control' && automationsSurface)) {
    return null;
  }

  if (!['delete', 'toggle', 'run', 'inspect', 'read', 'clone', 'update'].includes(decision.operation)) {
    return null;
  }

  const enabled = typeof decision.entities.enabled === 'boolean'
    ? decision.entities.enabled
    : inferExplicitAutomationToggle(content, decision.operation);
  const operation = decision.operation === 'update' && typeof enabled === 'boolean'
    ? 'toggle'
    : decision.operation;

  return {
    operation: operation as AutomationControlIntent['operation'],
    automationName: decision.entities.automationName,
    newAutomationName: decision.entities.newAutomationName,
    readView: decision.entities.automationReadView,
    ...(typeof enabled === 'boolean'
      ? { enabled }
      : {}),
    turnRelation: decision.turnRelation,
  };
}

function inferExplicitAutomationToggle(
  content: string,
  operation: string,
): boolean | undefined {
  if (operation !== 'update') return undefined;
  const text = content.trim().toLowerCase();
  if (!text) return undefined;
  if (/\bdisable\b/.test(text)) return false;
  if (/\benable\b/.test(text)) return true;
  return undefined;
}

function renderAutomationInspectCopy(
  catalog: SavedAutomationCatalogEntry[],
  selected: SavedAutomationCatalogEntry | null,
  error?: string,
  selection?: SavedAutomationCatalogSelection | null,
  requestedName?: string,
  readView?: AutomationControlIntent['readView'],
  listWindow?: PagedListWindow,
): string {
  const lines: string[] = [];
  if (selection && requestedName?.trim() && selection.matchType === 'closest') {
    lines.push(`I couldn't find an exact automation named '${requestedName}'. Closest match: '${selection.entry.name}'.`);
    lines.push('');
  }
  if (selected) {
    lines.push(
      `${selected.name} (${selected.kind === 'workflow' ? 'workflow' : selected.kind === 'assistant_task' ? 'assistant automation' : 'task'})`,
      `Enabled: ${selected.enabled ? 'yes' : 'no'}`,
    );
    if (selected.builtin) {
      lines.push('Catalog: built-in starter example');
    }
    const cron = toString(selected.task?.cron);
    const eventType = readEventType(selected.task);
    if (cron) lines.push(`Schedule: ${cron}`);
    else if (eventType) lines.push(`Trigger: ${eventType}`);
    else lines.push('Schedule: manual');
    if (selected.description) lines.push(`Description: ${selected.description}`);
    if (selected.kind === 'workflow') {
      const steps = Array.isArray(selected.workflow?.steps)
        ? selected.workflow.steps.filter(isRecord).slice(0, 8)
        : [];
      if (steps.length > 0) {
        lines.push('Steps:');
        for (const step of steps) {
          lines.push(`- ${toString(step.name) || toString(step.toolName) || toString(step.id) || 'step'}`);
        }
      }
    }
    return lines.join('\n');
  }

  if (catalog.length === 0) {
    return error
      ? `I could not inspect the automation catalog right now: ${error}`
      : readView === 'count'
        ? 'There are 0 automations currently configured.'
        : 'There are no automations in the catalog.';
  }

  if (readView === 'count') {
    return `There are ${catalog.length} automations currently configured.`;
  }

  const sortedCatalog = sortAutomationCatalogForList(catalog);
  const window = listWindow ?? {
    offset: 0,
    limit: resolveAutomationCatalogDefaultPageSize(sortedCatalog),
    total: sortedCatalog.length,
  };
  const pageEntries = sortedCatalog.slice(window.offset, window.offset + window.limit);
  const rangeStart = pageEntries.length > 0 ? window.offset + 1 : 0;
  const rangeEnd = pageEntries.length > 0 ? window.offset + pageEntries.length : window.offset;
  const listLines = [
    pageEntries.length > 0
      ? `Automation catalog (${catalog.length}): showing ${rangeStart}-${rangeEnd}`
      : `Automation catalog (${catalog.length}):`,
  ];
  if (pageEntries.length === 0 && window.offset >= sortedCatalog.length) {
    listLines.push('- No additional automations remain.');
    return listLines.join('\n');
  }
  for (const entry of pageEntries) {
    listLines.push(formatAutomationCatalogListRow(entry));
  }
  if (window.offset + pageEntries.length < catalog.length) {
    listLines.push(`- ...and ${catalog.length - (window.offset + pageEntries.length)} more`);
  }
  return listLines.join('\n');
}

function resolveAutomationCatalogListWindow(
  catalog: SavedAutomationCatalogEntry[],
  continuityThread: ContinuityThreadRecord | null | undefined,
  intent: AutomationControlIntent,
  content: string,
): PagedListWindow {
  const sortedCatalog = sortAutomationCatalogForList(catalog);
  return resolvePagedListWindow({
    continuityThread,
    continuationKind: AUTOMATION_CATALOG_CONTINUATION_KIND,
    content,
    total: sortedCatalog.length,
    turnRelation: intent.turnRelation,
    defaultPageSize: resolveAutomationCatalogDefaultPageSize(sortedCatalog),
  });
}

function sortAutomationCatalogForList(
  catalog: SavedAutomationCatalogEntry[],
): SavedAutomationCatalogEntry[] {
  return [...catalog].sort((left, right) => {
    const createdDelta = getAutomationCatalogEntryCreatedAt(right) - getAutomationCatalogEntryCreatedAt(left);
    if (createdDelta !== 0) return createdDelta;
    return left.name.localeCompare(right.name);
  });
}

function resolveAutomationCatalogDefaultPageSize(
  sortedCatalog: readonly SavedAutomationCatalogEntry[],
): number {
  return resolveListLimitWithinCharacterBudget(sortedCatalog, {
    header: `Automation catalog (${sortedCatalog.length})`,
    renderItem: formatAutomationCatalogListRow,
    footerForRemaining: (remaining) => `- ...and ${remaining} more`,
    maxChars: DEFAULT_VERBOSE_LIST_CHAR_BUDGET,
    maxItems: sortedCatalog.length,
  });
}

function formatAutomationCatalogListRow(entry: SavedAutomationCatalogEntry): string {
  return `- ${entry.name} - ${entry.enabled ? 'enabled' : 'disabled'}`;
}

function buildAutomationCatalogContinuationState(
  listWindow: PagedListWindow,
): Record<string, unknown> {
  return buildPagedListContinuationState(AUTOMATION_CATALOG_CONTINUATION_KIND, listWindow) as unknown as Record<string, unknown>;
}

function withAutomationCatalogContinuation(
  result: AutomationControlPreRouteResult,
  continuationState: Record<string, unknown> | null,
): AutomationControlPreRouteResult {
  return {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      continuationState,
    },
  };
}

function parseAutomationListResult(result: Record<string, unknown>): AutomationCatalogLookupResult {
  if (!toBoolean(result.success)) {
    return {
      entries: [],
      error: toString(result.message) || 'Automation catalog lookup failed.',
    };
  }
  const entries = extractAutomationListEntries(result);
  if (!entries) {
    return {
      entries: [],
      error: 'Automation catalog returned an invalid response.',
    };
  }
  return {
    entries: entries
      .map(toAutomationCatalogEntry)
      .filter((entry): entry is SavedAutomationCatalogEntry => Boolean(entry)),
  };
}

async function runAutomationEntry(
  params: AutomationControlPreRouteParams,
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  entry: SavedAutomationCatalogEntry,
  selection?: SavedAutomationCatalogSelection | null,
  requestedName?: string,
): Promise<AutomationControlPreRouteResult> {
  if (entry.builtin) {
    return {
      content: `'${entry.name}' is a built-in starter example. Create a copy first, then run the saved automation.`,
    };
  }
  const result = await params.executeTool('automation_run', { automationId: entry.id }, toolRequest);
  const formatted = formatSingleAutomationMutationResult(
    params,
    result,
    'automation_run',
    { automationId: entry.id },
    entry.name,
    `I ran '${entry.name}'.`,
    `I did not run '${entry.name}'.`,
    `I ran '${entry.name}'.`,
  );
  if (selection?.matchType === 'closest' && requestedName?.trim()) {
    return {
      ...formatted,
      content: [
        `I couldn't find an exact automation named '${requestedName}'. I used the closest saved automation: '${entry.name}'.`,
        '',
        formatted.content,
      ].join('\n'),
    };
  }
  return formatted;
}

async function toggleAutomationEntry(
  params: AutomationControlPreRouteParams,
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  entry: SavedAutomationCatalogEntry,
  desiredEnabled?: boolean,
): Promise<AutomationControlPreRouteResult> {
  if (entry.builtin) {
    return {
      content: `'${entry.name}' is a built-in starter example. Create a copy first, then enable or disable the saved automation.`,
    };
  }
  const enabled = typeof desiredEnabled === 'boolean' ? desiredEnabled : !entry.enabled;
  const result = await params.executeTool(
    'automation_set_enabled',
    { automationId: entry.id, enabled },
    toolRequest,
  );
  return formatSingleAutomationMutationResult(
    params,
    result,
    'automation_set_enabled',
    { automationId: entry.id, enabled },
    entry.name,
    enabled ? `I enabled '${entry.name}'.` : `I disabled '${entry.name}'.`,
    enabled ? `I did not enable '${entry.name}'.` : `I did not disable '${entry.name}'.`,
    enabled ? `Enabled '${entry.name}'.` : `Disabled '${entry.name}'.`,
  );
}

async function updateAutomationEntry(
  params: AutomationControlPreRouteParams,
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  entry: SavedAutomationCatalogEntry,
  catalog: SavedAutomationCatalogEntry[],
  intent: AutomationControlIntent,
): Promise<AutomationControlPreRouteResult> {
  if (entry.builtin) {
    return {
      content: `'${entry.name}' is a built-in starter example. Create a copy first, then edit the saved automation.`,
    };
  }

  const update = readAutomationControlUpdateRequest(params.message.content, intent);
  if (!update.nextName && !update.schedule && !update.needsScheduleClarification) {
    return {
      content: `Tell me what you want to change about '${entry.name}'. You can rename it, schedule it, or switch it back to manual run mode.`,
    };
  }

  if (update.needsScheduleClarification) {
    return {
      content: `Tell me when '${entry.name}' should run, for example "daily at 9:00 AM" or "every weekday at 7:30 AM".`,
      metadata: {
        clarification: {
          blockerKind: 'clarification',
          field: 'schedule',
          prompt: `Tell me when '${entry.name}' should run, for example "daily at 9:00 AM" or "every weekday at 7:30 AM".`,
          route: 'automation_control',
          operation: 'update',
          summary: `Choose a schedule for '${entry.name}'.`,
          resolution: 'needs_clarification',
          missingFields: ['schedule'],
          entities: {
            ...buildAutomationControlIntentEntities(intent),
            automationName: entry.name,
          },
        },
      },
    };
  }

  const nextName = update.nextName?.trim() || entry.name;
  const normalizedNextName = normalizeAutomationName(nextName);
  const normalizedCurrentName = normalizeAutomationName(entry.name);
  const hasNameChange = normalizedNextName !== normalizedCurrentName;

  if (hasNameChange) {
    const conflicting = catalog.find((candidate) => (
      candidate.id !== entry.id
      && normalizeAutomationName(candidate.name) === normalizedNextName
    ));
    if (conflicting) {
      return {
        content: `I found another automation already named '${conflicting.name}'. Choose a different name so I don't create an ambiguous catalog entry.`,
      };
    }
  }

  const existingSchedule = readAutomationScheduleFromEntry(entry);
  const nextSchedule = update.schedule ?? existingSchedule;
  const scheduleChanged = hasScheduleChanged(existingSchedule, nextSchedule);
  if (!hasNameChange && !scheduleChanged) {
    return {
      content: `'${entry.name}' is already configured that way.`,
    };
  }

  const saveInput = buildAutomationSaveInputFromEntry(entry, {
    name: nextName,
    schedule: nextSchedule,
  });
  const result = await params.executeTool('automation_save', saveInput as unknown as Record<string, unknown>, toolRequest);
  const copy = describeAutomationUpdateCopy(entry.name, nextName, nextSchedule, hasNameChange, scheduleChanged);
  return formatSingleAutomationMutationResult(
    params,
    result,
    'automation_save',
    saveInput as unknown as Record<string, unknown>,
    nextName,
    copy.approved,
    copy.denied,
    copy.success,
    copy.pending,
  );
}

async function deleteAutomationEntry(
  params: AutomationControlPreRouteParams,
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  entry: SavedAutomationCatalogEntry,
): Promise<AutomationControlPreRouteResult> {
  if (entry.builtin) {
    return {
      content: `'${entry.name}' is a built-in starter example and cannot be deleted from the catalog.`,
    };
  }
  const result = await params.executeTool('automation_delete', { automationId: entry.id }, toolRequest);
  return formatSingleAutomationMutationResult(
    params,
    result,
    'automation_delete',
    { automationId: entry.id },
    entry.name,
    `I deleted '${entry.name}'.`,
    `I did not delete '${entry.name}'.`,
    `Deleted '${entry.name}'.`,
    `I prepared deletion of '${entry.name}'.`,
  );
}

function formatSingleAutomationMutationResult(
  params: AutomationControlPreRouteParams,
  result: Record<string, unknown>,
  toolName: 'automation_save' | 'automation_set_enabled' | 'automation_run' | 'automation_delete',
  args: Record<string, unknown>,
  automationName: string,
  approvedCopy: string,
  deniedCopy: string,
  successCopy: string,
  pendingLeadCopy: string = `I prepared the requested change for '${automationName}'.`,
): AutomationControlPreRouteResult {
  const pendingFallback: AutomationControlPendingApprovalMetadata[] = [];
  const pending = collectPendingMutation(
    params,
    result,
    toolName,
    args,
    approvedCopy,
    deniedCopy,
    pendingFallback,
  );
  if (pending.pendingIds.length > 0) {
    const prompt = params.formatPendingApprovalPrompt
      ? params.formatPendingApprovalPrompt(pending.pendingIds)
      : 'This action needs approval before I can continue.';
    const resolvedPending = params.resolvePendingApprovalMetadata
      ? params.resolvePendingApprovalMetadata(pending.pendingIds, pendingFallback)
      : pendingFallback;
    return {
      content: [
        pendingLeadCopy,
        prompt,
      ].filter(Boolean).join('\n\n'),
      metadata: resolvedPending.length > 0
        ? {
            pendingAction: {
              status: 'pending',
              blocker: {
                kind: 'approval',
                prompt,
                approvalSummaries: resolvedPending,
              },
            },
          }
        : undefined,
    };
  }

  if (!toBoolean(result.success)) {
    return {
      content: pending.message || `I could not update '${automationName}'.`,
    };
  }

  const successMessage = extractSuccessMessage(result);
  return {
    content: toolName === 'automation_save' && (!successMessage || successMessage === 'Saved.')
      ? successCopy
      : successMessage || successCopy,
  };
}

function collectPendingMutation(
  params: AutomationControlPreRouteParams,
  result: Record<string, unknown>,
  toolName: 'automation_save' | 'automation_set_enabled' | 'automation_run' | 'automation_delete',
  args: Record<string, unknown>,
  approvedCopy: string,
  deniedCopy: string,
  fallback: AutomationControlPendingApprovalMetadata[],
): { pendingIds: string[]; message?: string } {
  if (toString(result.status) !== 'pending_approval') {
    if (!toBoolean(result.success)) {
      const msg = extractFailureMessage(result);
      return { pendingIds: [], message: msg ? `Failed: ${msg}` : 'Failed.' };
    }
    return { pendingIds: [] };
  }

  const approvalId = toString(result.approvalId);
  if (!approvalId) {
    return { pendingIds: [], message: 'The request is waiting for approval, but no approval id was returned.' };
  }

  params.trackPendingApproval?.(approvalId);
  params.onPendingApproval?.({
    approvalId,
    approved: approvedCopy,
    denied: deniedCopy,
  });
  fallback.push({
    id: approvalId,
    toolName,
    argsPreview: JSON.stringify(args).slice(0, 160),
  });
  return { pendingIds: [approvalId] };
}

function extractSuccessMessage(result: Record<string, unknown>): string {
  const direct = toString(result.message).trim();
  if (direct) return direct;
  const output = isRecord(result.output) ? result.output : null;
  return output ? toString(output.message).trim() : '';
}

function extractFailureMessage(result: Record<string, unknown>): string {
  const direct = toString(result.message).trim();
  if (direct) return direct;
  const error = toString(result.error).trim();
  if (error) return error;
  const output = isRecord(result.output) ? result.output : null;
  return output ? toString(output.message).trim() : '';
}

function readEventType(task: { eventTrigger?: { eventType: string } } | undefined): string {
  return task?.eventTrigger?.eventType ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toWorkflowSummary(value: Record<string, unknown>): AssistantConnectorPlaybookDefinition | null {
  const id = toString(value.id);
  const name = toString(value.name);
  const mode = toString(value.mode) === 'parallel' ? 'parallel' : 'sequential';
  const steps = Array.isArray(value.steps)
    ? value.steps.filter(isRecord).map(toWorkflowStepSummary).filter((step): step is AssistantConnectorPlaybookStepDefinition => Boolean(step))
    : [];
  if (!id || !name || steps.length === 0) return null;
  return {
    id,
    name,
    enabled: value.enabled !== false,
    mode,
    description: toString(value.description),
    ...(toString(value.schedule) ? { schedule: toString(value.schedule) } : {}),
    ...(toOutputHandling(value.outputHandling) ? { outputHandling: toOutputHandling(value.outputHandling) } : {}),
    steps,
  };
}

function toTaskSummary(value: Record<string, unknown>): ScheduledTaskDefinition | null {
  const id = toString(value.id);
  const name = toString(value.name);
  const typeValue = toString(value.type).toLowerCase();
  const target = toString(value.target);
  if (!id || !name || !target) return null;
  const type: ScheduledTaskDefinition['type'] = typeValue === 'agent'
    ? 'agent'
    : typeValue === 'playbook' || typeValue === 'workflow'
      ? 'playbook'
      : 'tool';
  const eventTrigger = isRecord(value.eventTrigger) && toString(value.eventTrigger.eventType)
    ? {
        eventType: toString(value.eventTrigger.eventType),
      }
    : undefined;
  return {
    id,
    name,
    description: toString(value.description) || undefined,
    type,
    target,
    ...(isRecord(value.args) ? { args: { ...value.args } } : {}),
    ...(toString(value.prompt) ? { prompt: toString(value.prompt) } : {}),
    ...(toString(value.channel) ? { channel: toString(value.channel) } : {}),
    ...(toString(value.userId) ? { userId: toString(value.userId) } : {}),
    ...(typeof value.deliver === 'boolean' ? { deliver: value.deliver } : {}),
    ...(typeof value.runOnce === 'boolean' ? { runOnce: value.runOnce } : {}),
    ...(toString(value.cron) ? { cron: toString(value.cron) } : {}),
    ...(eventTrigger ? { eventTrigger } : {}),
    enabled: value.enabled !== false,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : 0,
    scopeHash: toString(value.scopeHash) || 'unknown',
    maxRunsPerWindow: Number.isFinite(Number(value.maxRunsPerWindow)) ? Number(value.maxRunsPerWindow) : 1,
    dailySpendCap: Number.isFinite(Number(value.dailySpendCap)) ? Number(value.dailySpendCap) : 0,
    providerSpendCap: Number.isFinite(Number(value.providerSpendCap)) ? Number(value.providerSpendCap) : 0,
    consecutiveFailureCount: Number.isFinite(Number(value.consecutiveFailureCount)) ? Number(value.consecutiveFailureCount) : 0,
    consecutiveDeniedCount: Number.isFinite(Number(value.consecutiveDeniedCount)) ? Number(value.consecutiveDeniedCount) : 0,
    ...(Number.isFinite(Number(value.lastRunAt)) ? { lastRunAt: Number(value.lastRunAt) } : {}),
    ...(toString(value.lastRunStatus)
      ? { lastRunStatus: toString(value.lastRunStatus) as ScheduledTaskDefinition['lastRunStatus'] }
      : {}),
    runCount: Number.isFinite(Number(value.runCount)) ? Number(value.runCount) : 0,
    ...(toString(value.emitEvent) ? { emitEvent: toString(value.emitEvent) } : {}),
    ...(toOutputHandling(value.outputHandling) ? { outputHandling: toOutputHandling(value.outputHandling) } : {}),
  };
}

function toAutomationCatalogEntry(value: Record<string, unknown>): SavedAutomationCatalogEntry | null {
  const id = toString(value.id).trim();
  const name = toString(value.name).trim();
  const kindValue = toString(value.kind).trim();
  const kind: SavedAutomationCatalogEntry['kind'] | null = kindValue === 'workflow'
    ? 'workflow'
    : kindValue === 'assistant_task'
      ? 'assistant_task'
      : kindValue === 'task'
        ? 'task'
        : null;
  if (!id || !name || !kind) return null;

  const workflow = isRecord(value.workflow) ? toWorkflowSummary(value.workflow) : null;
  const task = isRecord(value.task) ? toTaskSummary(value.task) : null;
  return {
    id,
    name,
    description: toString(value.description),
    kind,
    enabled: toBoolean(value.enabled),
    ...(typeof value.source === 'string'
      ? { source: value.source as SavedAutomationCatalogEntry['source'] }
      : {}),
    ...(typeof value.builtin === 'boolean' ? { builtin: value.builtin } : {}),
    ...(toString(value.category).trim() ? { category: toString(value.category).trim() } : {}),
    ...(toString(value.templateId).trim() ? { templateId: toString(value.templateId).trim() } : {}),
    ...(toString(value.presetId).trim() ? { presetId: toString(value.presetId).trim() } : {}),
    ...(workflow ? { workflow } : {}),
    ...(task ? { task } : {}),
  };
}

function toWorkflowStepSummary(value: Record<string, unknown>): AssistantConnectorPlaybookStepDefinition | null {
  const id = toString(value.id);
  const typeValue = toString(value.type);
  const type: AssistantConnectorPlaybookStepDefinition['type'] = typeValue === 'instruction' || typeValue === 'delay'
    ? typeValue
    : 'tool';
  if (!id) return null;
  return {
    id,
    name: toString(value.name),
    type,
    packId: toString(value.packId),
    toolName: toString(value.toolName),
    ...(isRecord(value.args) ? { args: { ...value.args } } : {}),
    ...(toString(value.instruction) ? { instruction: toString(value.instruction) } : {}),
    ...(Number.isFinite(Number(value.delayMs)) ? { delayMs: Number(value.delayMs) } : {}),
    ...(Number.isFinite(Number(value.timeoutMs)) ? { timeoutMs: Number(value.timeoutMs) } : {}),
    ...(value.continueOnError === true ? { continueOnError: true } : {}),
    ...(toString(value.evidenceMode) ? { evidenceMode: toString(value.evidenceMode) as AssistantConnectorPlaybookStepDefinition['evidenceMode'] } : {}),
    ...(toString(value.citationStyle) ? { citationStyle: toString(value.citationStyle) as AssistantConnectorPlaybookStepDefinition['citationStyle'] } : {}),
  };
}

function buildAutomationSaveInputFromEntry(
  entry: SavedAutomationCatalogEntry,
  overrides: {
    name?: string;
    schedule?: AutomationScheduleChange;
  },
): AutomationSaveInput {
  const nextName = overrides.name?.trim() || entry.name;
  const schedule = overrides.schedule ?? readAutomationScheduleFromEntry(entry);

  if (entry.workflow) {
    return {
      id: entry.workflow.id || entry.id,
      name: nextName,
      description: entry.workflow.description || entry.description || '',
      enabled: entry.enabled !== false,
      kind: 'workflow',
      sourceKind: 'workflow',
      ...(entry.task?.type === 'playbook' ? { existingTaskId: entry.task.id } : {}),
      mode: entry.workflow.mode === 'parallel' ? 'parallel' : 'sequential',
      steps: entry.workflow.steps.map((step) => ({
        ...step,
        ...(step.args ? { args: { ...step.args } } : {}),
      })),
      schedule: schedule.enabled && schedule.cron
        ? {
            enabled: true,
            cron: schedule.cron,
            runOnce: schedule.runOnce === true,
          }
        : { enabled: false },
      ...(entry.task?.emitEvent ? { emitEvent: entry.task.emitEvent } : {}),
      ...(entry.workflow.outputHandling
        ? { outputHandling: { ...entry.workflow.outputHandling } }
        : entry.task?.outputHandling
          ? { outputHandling: { ...entry.task.outputHandling } }
          : {}),
    };
  }

  if (!entry.task) {
    throw new Error(`Automation '${entry.name}' is missing task data.`);
  }

  if (entry.kind === 'assistant_task') {
    return {
      id: entry.task.id,
      name: nextName,
      description: entry.task.description || entry.description || '',
      enabled: entry.enabled !== false,
      kind: 'assistant_task',
      sourceKind: 'task',
      existingTaskId: entry.task.id,
      task: {
        target: entry.task.target,
        prompt: entry.task.prompt || '',
        channel: entry.task.channel || 'scheduled',
        deliver: entry.task.deliver !== false,
        ...(isRecord(entry.task.args) && typeof entry.task.args.llmProvider === 'string'
          ? { llmProvider: entry.task.args.llmProvider }
          : {}),
      },
      schedule: schedule.enabled && schedule.cron
        ? {
            enabled: true,
            cron: schedule.cron,
            runOnce: schedule.runOnce === true,
          }
        : { enabled: false },
      ...(entry.task.emitEvent ? { emitEvent: entry.task.emitEvent } : {}),
      ...(entry.task.outputHandling ? { outputHandling: { ...entry.task.outputHandling } } : {}),
    };
  }

  return {
    id: entry.task.id,
    name: nextName,
    description: entry.task.description || entry.description || '',
    enabled: entry.enabled !== false,
    kind: 'standalone_task',
    sourceKind: 'task',
    existingTaskId: entry.task.id,
    task: {
      target: entry.task.target,
      ...(isRecord(entry.task.args) ? { args: { ...entry.task.args } } : {}),
    },
    schedule: schedule.enabled && schedule.cron
      ? {
          enabled: true,
          cron: schedule.cron,
          runOnce: schedule.runOnce === true,
        }
      : { enabled: false },
    ...(entry.task.emitEvent ? { emitEvent: entry.task.emitEvent } : {}),
    ...(entry.task.outputHandling ? { outputHandling: { ...entry.task.outputHandling } } : {}),
  };
}

function readAutomationScheduleFromEntry(entry: SavedAutomationCatalogEntry): AutomationScheduleChange {
  if (!entry.task?.cron) {
    return { enabled: false };
  }
  return {
    enabled: true,
    cron: entry.task.cron,
    runOnce: entry.task.runOnce === true,
  };
}

function readAutomationControlUpdateRequest(
  content: string,
  intent: AutomationControlIntent,
  now: Date = new Date(),
): AutomationControlUpdateRequest {
  const nextName = intent.newAutomationName?.trim() || undefined;
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return { ...(nextName ? { nextName } : {}) };
  }

  const scheduleChange = parseAutomationScheduleChange(trimmedContent, now);
  return {
    ...(nextName ? { nextName } : {}),
    ...(scheduleChange ? { schedule: scheduleChange } : {}),
    ...(hasExplicitScheduleRequestWithoutTiming(trimmedContent) && !scheduleChange ? { needsScheduleClarification: true } : {}),
  };
}

function parseAutomationScheduleChange(
  text: string,
  now: Date,
): AutomationScheduleChange | null {
  if (/\b(unschedule|disable (?:the )?schedule|make (?:it|this) manual|manual(?:ly)?(?: run)? only|run (?:it|this) manually|on demand only|do not schedule(?: it| this)?|don't schedule(?: it| this)?)\b/i.test(text)) {
    return {
      enabled: false,
      label: 'Manual',
    };
  }

  const schedule = parseAutomationSchedule(text, now);
  if (!schedule) return null;
  return toAutomationScheduleChange(schedule);
}

function toAutomationScheduleChange(
  schedule: AutomationScheduleSpec,
): AutomationScheduleChange {
  return {
    enabled: true,
    cron: schedule.cron,
    runOnce: schedule.runOnce,
    label: schedule.label,
  };
}

function hasExplicitScheduleRequestWithoutTiming(text: string): boolean {
  if (!/\b(schedule|scheduled)\b/i.test(text)) {
    return false;
  }
  return !parseAutomationScheduleChange(text, new Date());
}

function hasScheduleChanged(
  current: AutomationScheduleChange,
  next: AutomationScheduleChange,
): boolean {
  return current.enabled !== next.enabled
    || (current.enabled && next.enabled && (
      (current.cron || '') !== (next.cron || '')
      || (current.runOnce === true) !== (next.runOnce === true)
    ));
}

function describeAutomationUpdateCopy(
  previousName: string,
  nextName: string,
  schedule: AutomationScheduleChange,
  hasNameChange: boolean,
  scheduleChanged: boolean,
): {
  approved: string;
  denied: string;
  success: string;
  pending: string;
} {
  if (hasNameChange && !scheduleChanged) {
    return {
      approved: `I renamed '${previousName}' to '${nextName}'.`,
      denied: `I did not rename '${previousName}'.`,
      success: `Renamed '${previousName}' to '${nextName}'.`,
      pending: `I prepared renaming '${previousName}' to '${nextName}'.`,
    };
  }

  const targetName = hasNameChange ? nextName : previousName;
  const scheduleSummary = schedule.enabled && schedule.cron
    ? `${schedule.label ? `${schedule.label} ` : ''}schedule (${schedule.cron})`.trim()
    : 'manual run mode';

  return {
    approved: hasNameChange
      ? `I updated '${previousName}' to '${nextName}' and set it to ${scheduleSummary}.`
      : `I updated '${targetName}' to ${scheduleSummary}.`,
    denied: hasNameChange
      ? `I did not update '${previousName}'.`
      : `I did not update '${targetName}'.`,
    success: hasNameChange
      ? `Updated '${previousName}' to '${nextName}' and set it to ${scheduleSummary}.`
      : `Updated '${targetName}' to ${scheduleSummary}.`,
    pending: hasNameChange
      ? `I prepared updating '${previousName}' to '${nextName}'.`
      : `I prepared updating '${targetName}'.`,
  };
}

function buildAutomationClarificationResult(
  prompt: string,
  input: {
    field?: string;
    route: string;
    operation?: string;
    summary: string;
    missingFields?: string[];
    entities?: Record<string, unknown>;
  },
): AutomationControlPreRouteResult {
  return {
    content: prompt,
    metadata: {
      clarification: {
        blockerKind: 'clarification',
        ...(input.field ? { field: input.field } : {}),
        prompt,
        route: input.route,
        ...(input.operation ? { operation: input.operation } : {}),
        summary: input.summary,
        resolution: 'needs_clarification',
        ...(input.missingFields?.length ? { missingFields: [...input.missingFields] } : {}),
        ...(input.entities ? { entities: { ...input.entities } } : {}),
      },
    },
  };
}

function buildAutomationControlIntentEntities(
  intent: AutomationControlIntent,
): Record<string, unknown> {
  return {
    ...(intent.automationName ? { automationName: intent.automationName } : {}),
    ...(intent.newAutomationName ? { newAutomationName: intent.newAutomationName } : {}),
    ...(typeof intent.enabled === 'boolean' ? { enabled: intent.enabled } : {}),
  };
}

function resolveRecentFollowUpAutomationSelection(
  catalog: SavedAutomationCatalogEntry[],
  intent: AutomationControlIntent,
  content: string,
): SavedAutomationCatalogSelection | null {
  if (intent.turnRelation !== 'follow_up' && intent.turnRelation !== 'clarification_answer') {
    return null;
  }
  if (!/\b(that|it|just created|new one|newly created|latest|most recent)\b/i.test(content)) {
    return null;
  }
  const ranked = catalog
    .filter((entry) => !entry.builtin && getAutomationCatalogEntryCreatedAt(entry) > 0)
    .sort((left, right) => getAutomationCatalogEntryCreatedAt(right) - getAutomationCatalogEntryCreatedAt(left));
  const newest = ranked[0];
  const second = ranked[1];
  if (!newest) return null;
  if (second && getAutomationCatalogEntryCreatedAt(second) === getAutomationCatalogEntryCreatedAt(newest)) {
    return null;
  }
  return {
    entry: newest,
    matchType: 'closest',
  };
}

function buildAutomationSelectionLead(
  _selection: SavedAutomationCatalogSelection | null,
  recentFollowUpSelection: SavedAutomationCatalogSelection | null,
  requestedName?: string,
): string {
  if (recentFollowUpSelection) {
    return requestedName?.trim()
      ? `I couldn't find an exact automation named '${requestedName}'. I used the most recently created automation from this conversation: '${recentFollowUpSelection.entry.name}'.`
      : `I used the most recently created automation from this conversation: '${recentFollowUpSelection.entry.name}'.`;
  }
  return '';
}

function withAutomationSelectionLead(
  result: AutomationControlPreRouteResult,
  lead: string,
): AutomationControlPreRouteResult {
  if (!lead.trim()) return result;
  return {
    ...result,
    content: `${lead}\n\n${result.content}`,
  };
}

function getAutomationCatalogEntryCreatedAt(entry: SavedAutomationCatalogEntry): number {
  return Number.isFinite(entry.task?.createdAt)
    ? Number(entry.task?.createdAt)
    : 0;
}

function normalizeAutomationName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toOutputHandling(value: unknown): AutomationOutputHandlingConfig | undefined {
  if (!isRecord(value)) return undefined;
  const notify = toString(value.notify);
  const sendToSecurity = toString(value.sendToSecurity);
  const persistArtifacts = toString(value.persistArtifacts);
  if (!notify || !sendToSecurity || !persistArtifacts) return undefined;
  return {
    notify: notify as AutomationOutputHandlingConfig['notify'],
    sendToSecurity: sendToSecurity as AutomationOutputHandlingConfig['sendToSecurity'],
    persistArtifacts: persistArtifacts as AutomationOutputHandlingConfig['persistArtifacts'],
  };
}
