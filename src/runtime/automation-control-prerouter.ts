import type { AgentContext, UserMessage } from '../agent/types.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { IntentGatewayDecision } from './intent-gateway.js';
import type {
  AssistantConnectorPlaybookDefinition,
  AssistantConnectorPlaybookStepDefinition,
  AutomationOutputHandlingConfig,
} from '../config/types.js';
import type { ScheduledTaskDefinition } from './scheduled-tasks.js';
import {
  selectSavedAutomationCatalogEntry,
  type SavedAutomationCatalogEntry,
} from './automation-catalog.js';
import { extractAutomationListEntries } from './automation-tool-results.js';

export interface AutomationControlPendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
}

export interface AutomationControlPreRouteResult {
  content: string;
  metadata?: {
    pendingApprovals?: AutomationControlPendingApprovalMetadata[];
  };
}

type AutomationControlToolName =
  | 'automation_list'
  | 'automation_set_enabled'
  | 'automation_run'
  | 'automation_delete';

interface AutomationControlPreRouteParams {
  agentId: string;
  message: UserMessage;
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
  operation: 'delete' | 'toggle' | 'run' | 'inspect' | 'clone' | 'unknown';
  automationName?: string;
  enabled?: boolean;
}

interface AutomationCatalogLookupResult {
  entries: SavedAutomationCatalogEntry[];
  error?: string;
}

export async function tryAutomationControlPreRoute(
  params: AutomationControlPreRouteParams,
  options?: { intentDecision?: IntentGatewayDecision | null; allowHeuristicFallback?: boolean },
): Promise<AutomationControlPreRouteResult | null> {
  if (looksLikeAutomationOutputAnalysisRequest(params.message.content)) {
    return null;
  }
  const intent = resolveAutomationControlIntent(
    params.message.content,
    options?.intentDecision,
    options?.allowHeuristicFallback === true,
  );
  if (!intent || intent.operation === 'clone' || intent.operation === 'unknown') return null;

  const toolRequest = toolRequestFor(params);
  const catalogLookup = await listAutomationCatalog(params.executeTool, toolRequest);
  const catalog = catalogLookup.entries;
  const selected = intent.automationName
    ? selectSavedAutomationCatalogEntry(catalog, intent.automationName)
    : null;

  if (intent.operation === 'inspect') {
    return {
      content: renderAutomationInspectCopy(catalog, selected, catalogLookup.error),
    };
  }

  if (!intent.automationName) {
    return {
      content: 'Tell me which automation you want to run, enable, disable, or delete.',
    };
  }

  if (!selected) {
    return {
      content: `I could not find an automation named '${intent.automationName}'.`,
    };
  }

  switch (intent.operation) {
    case 'run':
      return runAutomationEntry(params, toolRequest, selected);
    case 'toggle':
      return toggleAutomationEntry(params, toolRequest, selected, intent.enabled);
    case 'delete':
      return deleteAutomationEntry(params, toolRequest, selected);
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
  allowHeuristicFallback = false,
): AutomationControlIntent | null {
  if (decision) {
    const routed = resolveDecisionBackedIntent(decision);
    if (routed) return routed;
  }
  if (!allowHeuristicFallback) return null;
  return resolveHeuristicAutomationControlIntent(content);
}

function resolveDecisionBackedIntent(
  decision: IntentGatewayDecision,
): AutomationControlIntent | null {
  const route = decision.route;
  const automationsSurface = decision.entities.uiSurface === 'automations';
  if (route !== 'automation_control' && !(route === 'ui_control' && automationsSurface)) {
    return null;
  }

  if (!['delete', 'toggle', 'run', 'inspect', 'clone'].includes(decision.operation)) {
    return null;
  }

  return {
    operation: decision.operation as AutomationControlIntent['operation'],
    automationName: decision.entities.automationName,
    ...(typeof decision.entities.enabled === 'boolean'
      ? { enabled: decision.entities.enabled }
      : {}),
  };
}

function extractAutomationReference(text: string): string | undefined {
  const cleaned = text
    .replace(/\s+\b(?:now|please)\b[.!?]*$/i, '')
    .trim();
  const quoted = cleaned.match(/\b(?:automation|workflow|task)\b[\s\S]{0,40}\b(?:called|named)\s+["'`]([^"'`]+)["'`]/i)
    ?? cleaned.match(/\b(?:delete|remove|run|execute|start|enable|disable|toggle|inspect|show)\s+["'`]([^"'`]+)["'`]/i);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }

  const namedAutomation = cleaned.match(/\b(?:show|inspect|details?|status)\b(?:\s+me)?(?:\s+the)?\s+(?:saved\s+)?(?:automation|workflow|task)\s+([A-Z0-9][A-Za-z0-9]+(?:\s+[A-Z0-9][A-Za-z0-9]+){0,7})\b/i);
  if (namedAutomation?.[1]?.trim()) {
    return namedAutomation[1].trim();
  }

  const titled = cleaned.match(/\b(?:delete|remove|run|execute|start|enable|disable|toggle|inspect|show)\s+([A-Z0-9][A-Za-z0-9]+(?:\s+[A-Z0-9][A-Za-z0-9]+){0,7})\b/i);
  if (titled?.[1]?.trim()) {
    return titled[1].trim();
  }
  return undefined;
}

function renderAutomationInspectCopy(
  catalog: SavedAutomationCatalogEntry[],
  selected: SavedAutomationCatalogEntry | null,
  error?: string,
): string {
  if (selected) {
    const lines = [
      `${selected.name} (${selected.kind === 'workflow' ? 'workflow' : selected.kind === 'assistant_task' ? 'assistant automation' : 'task'})`,
      `Enabled: ${selected.enabled ? 'yes' : 'no'}`,
    ];
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
      : 'There are no automations in the catalog.';
  }

  const lines = [`Automation catalog (${catalog.length}):`];
  for (const entry of catalog.slice(0, 20)) {
    const schedule = toString(entry.task?.cron) || readEventType(entry.task) || 'manual';
    lines.push(`- ${entry.name} [${entry.kind === 'workflow' ? 'workflow' : entry.kind === 'assistant_task' ? 'assistant' : 'task'} · ${entry.builtin ? 'catalog' : (entry.enabled ? 'enabled' : 'disabled')} · ${schedule}]`);
  }
  if (catalog.length > 20) {
    lines.push(`- ...and ${catalog.length - 20} more`);
  }
  return lines.join('\n');
}

function resolveHeuristicAutomationControlIntent(content: string): AutomationControlIntent | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (looksLikeAutomationOutputAnalysisRequest(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const hasAutomationContext = /\b(automations?|automation catalog|workflow(?:s)?|scheduled task|manual assistant automation|assistant automation|assistant task|task)\b/i.test(trimmed);
  if (/\b(list|show|what are)\b/.test(lower) && /\b(automations|automation catalog|workflows|scheduled tasks)\b/.test(lower)) {
    return { operation: 'inspect' };
  }

  const automationName = extractAutomationReference(trimmed);
  if (hasAutomationContext && /\b(delete|remove)\b/i.test(trimmed)) {
    return { operation: 'delete', automationName };
  }
  if (hasAutomationContext && /\b(run|execute|start)\b/i.test(trimmed)) {
    return { operation: 'run', automationName };
  }
  if (hasAutomationContext && /\b(enable|turn on)\b/i.test(trimmed)) {
    return { operation: 'toggle', automationName, enabled: true };
  }
  if (hasAutomationContext && /\b(disable|turn off)\b/i.test(trimmed)) {
    return { operation: 'toggle', automationName, enabled: false };
  }
  if (hasAutomationContext && /\btoggle\b/i.test(trimmed)) {
    return { operation: 'toggle', automationName };
  }
  if (hasAutomationContext && /\b(show|inspect|details?|status)\b/i.test(trimmed)) {
    return { operation: 'inspect', automationName };
  }
  return null;
}

function looksLikeAutomationOutputAnalysisRequest(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (!/\b(automation|workflow|assistant automation|scheduled task|task|run)\b/i.test(trimmed)) {
    return false;
  }
  const analysisIntent = /\b(analy[sz]e|summari[sz]e|explain|review|compare|investigate|interpret|what did(?:\s+it)?\s+find)\b/i.test(trimmed);
  if (!analysisIntent) return false;
  const outputContext = /\b(output|outputs|result|results|findings|history|timeline|step output|run output)\b/i.test(trimmed);
  if (!outputContext) return false;
  return true;
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
): Promise<AutomationControlPreRouteResult> {
  if (entry.builtin) {
    return {
      content: `'${entry.name}' is a built-in starter example. Create a copy first, then run the saved automation.`,
    };
  }
  const result = await params.executeTool('automation_run', { automationId: entry.id }, toolRequest);
  return formatSingleAutomationMutationResult(
    params,
    result,
    'automation_run',
    { automationId: entry.id },
    entry.name,
    `I ran '${entry.name}'.`,
    `I did not run '${entry.name}'.`,
    `I ran '${entry.name}'.`,
  );
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
  toolName: 'automation_set_enabled' | 'automation_run' | 'automation_delete',
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
      metadata: resolvedPending.length > 0 ? { pendingApprovals: resolvedPending } : undefined,
    };
  }

  if (!toBoolean(result.success)) {
    return {
      content: pending.message || `I could not update '${automationName}'.`,
    };
  }

  return {
    content: extractSuccessMessage(result) || successCopy,
  };
}

function collectPendingMutation(
  params: AutomationControlPreRouteParams,
  result: Record<string, unknown>,
  toolName: 'automation_set_enabled' | 'automation_run' | 'automation_delete',
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
