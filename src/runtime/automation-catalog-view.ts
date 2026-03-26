import type { AssistantConnectorPlaybookDefinition, AutomationOutputHandlingConfig } from '../config/types.js';
import type { ToolCategory } from '../tools/types.js';
import type { SavedAutomationCatalogEntry, AutomationCatalogSource } from './automation-catalog.js';
import type { ScheduledTaskDefinition } from './scheduled-tasks.js';

export interface AutomationCatalogToolMetadata {
  name: string;
  category?: ToolCategory;
  description?: string;
  shortDescription?: string;
}

export interface AutomationCatalogViewOutputHandling {
  notify: string;
  sendToSecurity: string;
  persistArtifacts: string;
}

export interface AutomationCatalogViewStep {
  id: string;
  name?: string;
  type?: string;
  toolName: string;
  packId?: string | null;
  args?: Record<string, unknown>;
  instruction?: string;
  llmProvider?: string;
}

export interface AutomationCatalogViewEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: 'single' | 'pipeline' | 'assistant';
  mode: string;
  steps: AutomationCatalogViewStep[];
  enabled: boolean;
  cron: string | null;
  runOnce: boolean;
  emitEvent: string;
  outputHandling: AutomationCatalogViewOutputHandling;
  scheduleEnabled: boolean;
  taskId: string | null;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  runCount: number;
  source: AutomationCatalogSource | null;
  sourceKind: 'workflow' | 'task' | 'example';
  builtin: boolean;
  workflow: AssistantConnectorPlaybookDefinition | null;
  task: ScheduledTaskDefinition | null;
  agentPrompt?: string;
  agentChannel?: string;
  agentDeliver?: boolean;
}

export function buildAutomationCatalogViewEntries(
  catalog: SavedAutomationCatalogEntry[],
  tools: AutomationCatalogToolMetadata[] = [],
): AutomationCatalogViewEntry[] {
  const toolMap = new Map<string, AutomationCatalogToolMetadata>();
  for (const tool of tools) {
    if (!tool.name) continue;
    toolMap.set(tool.name, { ...tool });
  }

  return catalog
    .map((entry) => toAutomationCatalogViewEntry(entry, toolMap))
    .filter((entry): entry is AutomationCatalogViewEntry => entry !== null);
}

function toAutomationCatalogViewEntry(
  entry: SavedAutomationCatalogEntry,
  toolMap: Map<string, AutomationCatalogToolMetadata>,
): AutomationCatalogViewEntry | null {
  const workflow = entry.workflow ? cloneWorkflow(entry.workflow) : null;
  const task = entry.task ? cloneTask(entry.task) : null;
  const enabled = entry.enabled !== false;
  const source = entry.source ?? null;
  const sourceKind = source === 'builtin_example'
    ? 'example'
    : workflow
      ? 'workflow'
      : 'task';

  if (workflow) {
    return {
      id: workflow.id || entry.id,
      name: workflow.name || entry.name,
      description: workflow.description || entry.description || '',
      category: entry.category || deriveWorkflowCategory(workflow.steps, toolMap),
      kind: workflow.steps.length <= 1 ? 'single' : 'pipeline',
      mode: workflow.mode || 'sequential',
      steps: cloneWorkflowSteps(workflow.steps),
      enabled,
      cron: task?.cron || null,
      runOnce: task?.runOnce === true,
      emitEvent: task?.emitEvent || '',
      outputHandling: normalizeOutputHandling(workflow.outputHandling || task?.outputHandling),
      scheduleEnabled: task?.enabled === true,
      taskId: task?.id || null,
      lastRunAt: task?.lastRunAt ?? null,
      lastRunStatus: typeof task?.lastRunStatus === 'string' ? task.lastRunStatus : null,
      runCount: asNumber(task?.runCount, 0),
      source,
      sourceKind,
      builtin: entry.builtin === true,
      workflow,
      task,
    };
  }

  if (!task) return null;

  if (task.type === 'agent') {
    return {
      id: task.id,
      name: task.name || task.target,
      description: describeAssistantAutomationTask(task),
      category: 'assistant',
      kind: 'assistant',
      mode: 'assistant',
      steps: [{
        id: `${task.id}-step-1`,
        name: task.target,
        toolName: `agent:${task.target}`,
        packId: null,
        args: {
          prompt: task.prompt || '',
          channel: task.channel || 'scheduled',
          deliver: task.deliver !== false,
        },
      }],
      enabled,
      cron: task.cron || null,
      runOnce: task.runOnce === true,
      emitEvent: task.emitEvent || '',
      outputHandling: normalizeOutputHandling(task.outputHandling),
      scheduleEnabled: task.enabled === true,
      taskId: task.id,
      lastRunAt: task.lastRunAt ?? null,
      lastRunStatus: typeof task.lastRunStatus === 'string' ? task.lastRunStatus : null,
      runCount: asNumber(task.runCount, 0),
      source,
      sourceKind,
      builtin: entry.builtin === true,
      workflow: null,
      task,
      agentPrompt: task.prompt || '',
      agentChannel: task.channel || 'scheduled',
      agentDeliver: task.deliver !== false,
    };
  }

  const tool = toolMap.get(task.target);
  return {
    id: task.id,
    name: task.name || task.target,
    description: describeStandaloneAutomationTask(task, tool),
    category: entry.category || tool?.category || 'uncategorized',
    kind: 'single',
    mode: 'sequential',
    steps: [{
      id: `${task.id}-step-1`,
      name: task.target,
      toolName: task.target,
      packId: null,
      args: cloneArgs(task.args),
    }],
    enabled,
    cron: task.cron || null,
    runOnce: task.runOnce === true,
    emitEvent: task.emitEvent || '',
    outputHandling: normalizeOutputHandling(task.outputHandling),
    scheduleEnabled: task.enabled === true,
    taskId: task.id,
    lastRunAt: task.lastRunAt ?? null,
    lastRunStatus: typeof task.lastRunStatus === 'string' ? task.lastRunStatus : null,
    runCount: asNumber(task.runCount, 0),
    source,
    sourceKind,
    builtin: entry.builtin === true,
    workflow: null,
    task,
  };
}

function deriveWorkflowCategory(
  steps: AssistantConnectorPlaybookDefinition['steps'],
  toolMap: Map<string, AutomationCatalogToolMetadata>,
): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const category = toolMap.get(step.toolName)?.category;
    if (!category) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  let winner = 'uncategorized';
  let max = 0;
  for (const [category, count] of counts.entries()) {
    if (count > max) {
      winner = category;
      max = count;
    }
  }
  return winner;
}

function describeStandaloneAutomationTask(
  task: ScheduledTaskDefinition,
  tool?: AutomationCatalogToolMetadata,
): string {
  if (task.target === 'gws') {
    const summary = summarizeGoogleWorkspaceTask(task.args || {});
    if (summary) return summary;
  }

  if (task.target === 'gmail_send' || task.target === 'gmail_draft') {
    const summary = summarizeDirectEmailTask(task.target, task.args || {});
    if (summary) return summary;
  }

  return tool?.shortDescription || tool?.description || task.description || '';
}

function describeAssistantAutomationTask(task: ScheduledTaskDefinition): string {
  const explicit = String(task.description || '').trim();
  if (explicit) return explicit;

  const prompt = String(task.prompt || '').trim();
  if (!prompt) return 'Scheduled assistant task';

  const operatorRequestMatch = prompt.match(/operator request:\s*([\s\S]+)$/i);
  let summarySource = operatorRequestMatch?.[1] || prompt;
  summarySource = summarySource.replace(/^\[Context:[^\]]+\]\s*/i, '').trim();
  summarySource = summarySource.replace(/\s+/g, ' ').trim();
  return summarySource || 'Scheduled assistant task';
}

function summarizeDirectEmailTask(toolName: string, args: Record<string, unknown>): string {
  const to = asString(args.to);
  const subject = asString(args.subject);
  if (!to && !subject) return '';
  const action = toolName === 'gmail_draft' ? 'Draft Gmail' : 'Send Gmail';
  return `${action}${to ? ` to ${to}` : ''}${subject ? ` with subject "${subject}"` : ''}`;
}

function summarizeGoogleWorkspaceTask(args: Record<string, unknown>): string {
  const service = asString(args.service).toLowerCase();
  const resource = asString(args.resource).toLowerCase();
  const method = asString(args.method).toLowerCase();
  if (!service || !method) return '';

  if (service === 'gmail' && resource === 'users messages' && method === 'send') {
    const summary = extractGoogleWorkspaceMessageSummary(args);
    return summary
      ? `Send Gmail to ${summary.to || '(unknown recipient)'}${summary.subject ? ` with subject "${summary.subject}"` : ''}`
      : 'Send Gmail message';
  }

  if (service === 'gmail' && resource === 'users drafts' && method === 'create') {
    const summary = extractGoogleWorkspaceMessageSummary(args);
    return summary
      ? `Draft Gmail to ${summary.to || '(unknown recipient)'}${summary.subject ? ` with subject "${summary.subject}"` : ''}`
      : 'Create Gmail draft';
  }

  if (service === 'calendar' && resource === 'events' && method === 'list') return 'List calendar events';
  if (service === 'calendar' && resource === 'events' && method === 'create') return 'Create calendar event';
  if (service === 'drive' && resource === 'files' && method === 'list') return 'List Drive files';

  return `${service} ${resource || 'request'} ${method}`.trim();
}

function extractGoogleWorkspaceMessageSummary(args: Record<string, unknown>): { to: string; subject: string } | null {
  const json = isRecord(args.json) ? args.json : {};
  const message = isRecord(json.message) ? json.message : {};
  const raw = asString(json.raw || message.raw);
  if (!raw) return null;

  try {
    const decoded = decodeBase64Url(raw);
    const lines = decoded.split(/\r?\n/);
    const to = lines.find((line) => /^to:/i.test(line))?.replace(/^to:\s*/i, '').trim() || '';
    const subject = lines.find((line) => /^subject:/i.test(line))?.replace(/^subject:\s*/i, '').trim() || '';
    return { to, subject };
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function normalizeOutputHandling(
  outputHandling: AutomationOutputHandlingConfig | Record<string, unknown> | null | undefined,
): AutomationCatalogViewOutputHandling {
  return {
    notify: asString(outputHandling?.notify) || 'off',
    sendToSecurity: asString(outputHandling?.sendToSecurity) || 'off',
    persistArtifacts: asString(outputHandling?.persistArtifacts) || 'run_history_plus_memory',
  };
}

function cloneWorkflow(workflow: AssistantConnectorPlaybookDefinition): AssistantConnectorPlaybookDefinition {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({
      ...step,
      ...(step.args ? { args: cloneArgs(step.args) } : {}),
    })),
    ...(workflow.outputHandling ? { outputHandling: { ...workflow.outputHandling } } : {}),
  };
}

function cloneWorkflowSteps(steps: AssistantConnectorPlaybookDefinition['steps']): AutomationCatalogViewStep[] {
  return steps.map((step) => ({
    id: step.id,
    name: step.name,
    type: step.type,
    toolName: step.toolName,
    packId: step.packId ?? null,
    ...(step.args ? { args: cloneArgs(step.args) } : {}),
    ...(step.instruction ? { instruction: step.instruction } : {}),
    ...(step.llmProvider ? { llmProvider: step.llmProvider } : {}),
  }));
}

function cloneTask(task: ScheduledTaskDefinition): ScheduledTaskDefinition {
  return {
    ...task,
    ...(task.args ? { args: cloneArgs(task.args) } : {}),
    ...(task.eventTrigger ? { eventTrigger: { ...task.eventTrigger } } : {}),
    ...(task.outputHandling ? { outputHandling: { ...task.outputHandling } } : {}),
  };
}

function cloneArgs(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!args) return {};
  return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
