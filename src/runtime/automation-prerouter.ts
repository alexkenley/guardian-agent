import type { AgentContext, UserMessage } from '../agent/types.js';
import {
  compileAutomationAuthoringOutcome,
  isAutomationAuthoringRequest,
  type AutomationAuthoringCompilation,
  type AutomationAuthoringDraft,
} from './automation-authoring.js';
import {
  formatAutomationValidationFailure,
  validateAutomationCompilation,
  type AutomationValidationResult,
} from './automation-validation.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { AutomationSaveInput } from './automation-save.js';
import { extractAutomationListEntries } from './automation-tool-results.js';
import type { IntentGatewayDecision } from './intent-gateway.js';

export interface AutomationPendingApprovalMetadata {
  id: string;
  toolName: string;
  argsPreview: string;
}

export interface AutomationPreRouteResult {
  content: string;
  metadata?: {
    pendingApprovals?: AutomationPendingApprovalMetadata[];
    resumeAutomationAfterApprovals?: boolean;
  };
}

interface AutomationPreRouteParams {
  agentId: string;
  message: UserMessage;
  checkAction?: AgentContext['checkAction'];
  preflightTools?: (requests: Array<{ name: string; args?: Record<string, unknown> }>) => Array<{
    name: string;
    found: boolean;
    decision: 'allow' | 'deny' | 'require_approval';
    reason: string;
    fixes: Array<{ type: 'tool_policy' | 'path' | 'command' | 'domain'; value: string; description: string }>;
  }>;
  workspaceRoot?: string;
  allowedPaths?: string[];
  executeTool: (
    toolName: 'automation_list' | 'automation_save' | 'update_tool_policy',
    args: Record<string, unknown>,
    request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
  ) => Promise<Record<string, unknown>>;
  trackPendingApproval?: (approvalId: string) => void;
  onPendingApproval?: (input: {
    approvalId: string;
    toolName: 'automation_save';
    automationName: string;
    artifactLabel: string;
    verb: 'created' | 'updated';
  }) => void;
  formatPendingApprovalPrompt?: (ids: string[]) => string;
  resolvePendingApprovalMetadata?: (ids: string[], fallback: AutomationPendingApprovalMetadata[]) => AutomationPendingApprovalMetadata[];
}

interface ExistingSavedAutomation {
  id: string;
  name: string;
  builtin: boolean;
  kind: string;
  sourceKind?: string;
  taskId?: string;
}

export async function tryAutomationPreRoute(
  params: AutomationPreRouteParams,
  options?: {
    allowRemediation?: boolean;
    assumeAuthoring?: boolean;
    allowHeuristicFallback?: boolean;
    intentDecision?: IntentGatewayDecision | null;
  },
): Promise<AutomationPreRouteResult | null> {
  const gatewayAuthoring = options?.intentDecision?.route === 'automation_authoring';
  const authoringIntent = options?.assumeAuthoring
    || gatewayAuthoring
    || (options?.allowHeuristicFallback === true && isAutomationAuthoringRequest(params.message.content));
  const outcome = compileAutomationAuthoringOutcome(params.message.content, {
    channel: params.message.channel,
    userId: params.message.userId,
    assumeAuthoring: authoringIntent,
  });
  if (!outcome) {
    if (!authoringIntent) return null;
    return {
      content: 'I recognized this as an automation authoring request, but I could not parse enough structure to turn it into a Guardian automation draft yet. Add the automation goal, schedule, or fixed steps you want.',
    };
  }
  if (outcome.status === 'draft') {
    return {
      content: renderAutomationDraftClarification(outcome.draft),
    };
  }
  const compilation = outcome.compilation;

  if (params.preflightTools) {
    const validation = validateAutomationCompilation(
      compilation,
      params.message.content,
      params.preflightTools,
      { workspaceRoot: params.workspaceRoot, allowedPaths: params.allowedPaths },
    );
    if (!validation.ok) {
      if (options?.allowRemediation !== false) {
        const remediated = await tryAutomationRemediation(params, compilation.name, validation, toolRequestFor(params));
        if (remediated) return remediated;
      }
      return {
        content: formatAutomationValidationFailure(compilation, validation),
      };
    }
  }

  const toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'> = {
    ...toolRequestFor(params),
  };
  const existingAutomations = await listExistingAutomations(params.executeTool, toolRequest);
  const matchedAutomation = findMatchingSavedAutomation(existingAutomations, compilation);
  const saveInput = buildAutomationSaveInput(compilation, matchedAutomation);
  if (!saveInput) return null;

  const toolResult = await params.executeTool(
    'automation_save',
    saveInput as unknown as Record<string, unknown>,
    toolRequest,
  );
  return formatAutomationPreRouteResult({
    toolName: 'automation_save',
    compilation,
    toolResult,
    verb: matchedAutomation ? 'updated' : 'created',
    argsPreview: JSON.stringify(saveInput).slice(0, 160),
    onPendingApproval: params.onPendingApproval,
    trackPendingApproval: params.trackPendingApproval,
    formatPendingApprovalPrompt: params.formatPendingApprovalPrompt,
    resolvePendingApprovalMetadata: params.resolvePendingApprovalMetadata,
  });
}

function renderAutomationDraftClarification(draft: AutomationAuthoringDraft): string {
  const kind = describeAutomationDraft(draft);
  const lines = [
    `I drafted the ${kind.kindLabel} '${draft.name}', but I still need a few details before I can save it.`,
    kind.detailLine,
    '',
    'Missing details:',
  ];
  for (const field of draft.missingFields) {
    lines.push(`- ${field.prompt}`);
  }
  return lines.join('\n');
}

function toolRequestFor(params: AutomationPreRouteParams): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
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

async function listExistingAutomations(
  executeTool: AutomationPreRouteParams['executeTool'],
  request: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
): Promise<ExistingSavedAutomation[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await executeTool('automation_list', {}, request);
    if (!toBoolean(result.success)) return [];
    const entries = extractAutomationListEntries(result);
    if (!entries) return [];
    const automations = entries
      .map((automation) => {
        const task = isRecord(automation.task) ? automation.task : null;
        return {
          id: toString(automation.id),
          name: toString(automation.name),
          builtin: automation.builtin === true,
          kind: toString(automation.kind),
          sourceKind: task ? toString(task.kind) : (isRecord(automation.workflow) ? 'workflow' : undefined),
          taskId: task ? toString(task.id) || undefined : undefined,
        };
      })
      .filter((automation) => Boolean(automation.id && automation.name));
    if (automations.length > 0 || attempt === 2) {
      return automations;
    }
    await sleep(100);
  }
  return [];
}

function findMatchingSavedAutomation(
  automations: ExistingSavedAutomation[],
  compilation: AutomationAuthoringCompilation,
): ExistingSavedAutomation | null {
  const desiredId = normalizeAutomationLookupValue(compilation.id);
  const desiredName = normalizeAutomationLookupValue(compilation.name);
  return automations.find((automation) => {
    if (automation.builtin) return false;
    const kindMatches = compilation.shape === 'workflow'
      ? automation.kind === 'workflow'
      : automation.kind === 'assistant_task';
    if (!kindMatches) return false;
    return normalizeAutomationLookupValue(automation.id) === desiredId
      || normalizeAutomationLookupValue(automation.name) === desiredName;
  }) ?? null;
}

function buildAutomationSaveInput(
  compilation: AutomationAuthoringCompilation,
  existing: ExistingSavedAutomation | null,
): AutomationSaveInput | null {
  if (compilation.shape === 'workflow' && compilation.workflowUpsert) {
    return {
      id: compilation.id,
      name: compilation.name,
      description: compilation.description,
      enabled: true,
      kind: 'workflow',
      ...(existing?.sourceKind ? { sourceKind: existing.sourceKind } : {}),
      ...(existing?.taskId ? { existingTaskId: existing.taskId } : {}),
      mode: compilation.workflowUpsert.mode,
      steps: compilation.workflowUpsert.steps.map((step) => ({
        ...step,
        ...(isRecord(step.args) ? { args: { ...step.args } } : {}),
      })),
      schedule: compilation.schedule
        ? {
            enabled: true,
            cron: compilation.schedule.cron,
            runOnce: compilation.schedule.runOnce,
          }
        : { enabled: false },
      ...(compilation.workflowUpsert.outputHandling ? { outputHandling: { ...compilation.workflowUpsert.outputHandling } } : {}),
    };
  }

  if ((compilation.shape === 'scheduled_agent' || compilation.shape === 'manual_agent') && compilation.taskCreate) {
    return {
      id: compilation.id,
      name: compilation.name,
      description: compilation.description,
      enabled: true,
      kind: 'assistant_task',
      ...(existing?.sourceKind ? { sourceKind: existing.sourceKind } : {}),
      ...(existing?.taskId ? { existingTaskId: existing.taskId } : {}),
      task: {
        target: compilation.taskCreate.target,
        prompt: compilation.taskCreate.prompt,
        channel: compilation.taskCreate.channel,
        deliver: compilation.taskCreate.deliver,
      },
      schedule: compilation.shape === 'scheduled_agent' && compilation.schedule
        ? {
            enabled: true,
            cron: compilation.schedule.cron,
            runOnce: compilation.schedule.runOnce,
          }
        : { enabled: false },
    };
  }

  return null;
}

function formatAutomationPreRouteResult(input: {
  toolName: 'automation_save';
  compilation: AutomationAuthoringCompilation;
  toolResult: Record<string, unknown>;
  verb: 'created' | 'updated';
  argsPreview: string;
  onPendingApproval?: AutomationPreRouteParams['onPendingApproval'];
  trackPendingApproval?: AutomationPreRouteParams['trackPendingApproval'];
  formatPendingApprovalPrompt?: AutomationPreRouteParams['formatPendingApprovalPrompt'];
  resolvePendingApprovalMetadata?: AutomationPreRouteParams['resolvePendingApprovalMetadata'];
}): AutomationPreRouteResult {
  const summary = describeAutomationCompilation(input.compilation);
  if (!toBoolean(input.toolResult.success)) {
    const status = toString(input.toolResult.status);
    if (status === 'pending_approval') {
      const approvalId = toString(input.toolResult.approvalId);
      if (approvalId) {
        input.trackPendingApproval?.(approvalId);
        input.onPendingApproval?.({
          approvalId,
          toolName: input.toolName,
          automationName: input.compilation.name,
          artifactLabel: summary.kindLabel,
          verb: input.verb,
        });
      }
      const pendingSummary = [
        `I prepared the ${summary.kindLabel} '${input.compilation.name}'.`,
        summary.detailLine,
      ].filter(Boolean).join('\n');
      const fallback = approvalId
        ? [{
            id: approvalId,
            toolName: input.toolName,
            argsPreview: input.argsPreview,
          }]
        : [];
      const pendingApprovals = input.resolvePendingApprovalMetadata
        ? input.resolvePendingApprovalMetadata(approvalId ? [approvalId] : [], fallback)
        : fallback;
      const prompt = input.formatPendingApprovalPrompt
        ? input.formatPendingApprovalPrompt(approvalId ? [approvalId] : [])
        : 'This action needs approval before I can continue.';
      return {
        content: [pendingSummary, prompt].filter(Boolean).join('\n\n'),
        metadata: pendingApprovals.length > 0 ? { pendingApprovals } : undefined,
      };
    }
    const msg = toString(input.toolResult.message) || 'Automation change failed.';
    return {
      content: `I tried to ${input.verb === 'updated' ? 'update' : 'create'} '${input.compilation.name}', but it failed: ${msg}`,
    };
  }

  return {
    content: [
      renderAutomationSuccessHeadline(input.compilation, input.verb, input.toolResult),
      summary.detailLine,
    ].filter(Boolean).join('\n'),
  };
}

function describeAutomationCompilation(compilation: AutomationAuthoringCompilation): {
  kindLabel: string;
  detailLine: string;
} {
  if (compilation.shape === 'workflow' && compilation.workflowUpsert) {
    const stepCount = compilation.workflowUpsert.steps.length;
    const outputPaths = compilation.workflowUpsert.steps
      .map((step) => {
        const args = isRecord(step.args) ? step.args : null;
        return step.toolName === 'fs_write' && args && typeof args.path === 'string'
          ? args.path
          : '';
      })
      .filter(Boolean);
    return {
      kindLabel: 'native Guardian step-based automation',
      detailLine: [
        `Mode: ${compilation.workflowUpsert.mode}`,
        `Steps: ${stepCount}`,
        compilation.workflowUpsert.schedule ? `Schedule: ${compilation.workflowUpsert.schedule}` : 'Manual run',
        outputPaths.length > 0 ? `Outputs: ${outputPaths.join(', ')}` : '',
      ].filter(Boolean).join(' · '),
    };
  }

  if (compilation.shape === 'manual_agent') {
    return {
      kindLabel: 'native Guardian manual assistant automation',
      detailLine: 'Runs on demand only · Target: default assistant',
    };
  }

  return {
    kindLabel: 'native Guardian scheduled assistant task',
    detailLine: compilation.schedule?.cron
      ? `Schedule: ${compilation.schedule.cron} · Target: default assistant`
      : 'Target: default assistant',
  };
}

function describeAutomationDraft(draft: AutomationAuthoringDraft): {
  kindLabel: string;
  detailLine: string;
} {
  if (draft.shape === 'workflow') {
    return {
      kindLabel: 'native Guardian step-based automation draft',
      detailLine: [
        'Mode: sequential',
        draft.schedule?.cron ? `Schedule: ${draft.schedule.cron}` : 'Manual run',
      ].join(' · '),
    };
  }

  if (draft.shape === 'manual_agent') {
    return {
      kindLabel: 'native Guardian manual assistant automation draft',
      detailLine: 'Runs on demand only · Target: default assistant',
    };
  }

  return {
    kindLabel: 'native Guardian scheduled assistant task draft',
    detailLine: draft.schedule?.cron
      ? `Schedule: ${draft.schedule.cron} · Target: default assistant`
      : 'Schedule: missing · Target: default assistant',
  };
}

function renderAutomationSuccessHeadline(
  compilation: AutomationAuthoringCompilation,
  verb: 'created' | 'updated',
  toolResult: Record<string, unknown>,
): string {
  const output = isRecord(toolResult.output) ? toolResult.output : null;
  if (compilation.shape === 'workflow') {
    const automationId = output ? toString(output.automationId) || compilation.id : compilation.id;
    return `${capitalize(verb)} step-based automation '${compilation.name}' (id: ${automationId}).`;
  }
  const task = output && isRecord(output.task) ? output.task : null;
  const taskId = task ? toString(task.id) : '';
  if (compilation.shape === 'manual_agent') {
    return `${capitalize(verb)} manual assistant automation '${compilation.name}'${taskId ? ` (id: ${taskId})` : ''}.`;
  }
  return `${capitalize(verb)} scheduled assistant task '${compilation.name}'${taskId ? ` (id: ${taskId})` : ''}.`;
}

async function tryAutomationRemediation(
  params: AutomationPreRouteParams,
  automationName: string,
  validation: AutomationValidationResult,
  toolRequest: Omit<ToolExecutionRequest, 'toolName' | 'args'>,
): Promise<AutomationPreRouteResult | null> {
  const fixes = uniqueAutomationFixes(validation.issues.flatMap((issue) => issue.fixes ?? []));
  const remediationSteps = fixes
    .map((fix) => toPolicyRemediation(fix))
    .filter((fix): fix is { action: string; value: string; description: string } => Boolean(fix));
  if (remediationSteps.length === 0) return null;

  const pendingIds: string[] = [];
  const fallbackMetadata: AutomationPendingApprovalMetadata[] = [];
  let appliedAny = false;

  for (const step of remediationSteps) {
    const result = await params.executeTool(
      'update_tool_policy',
      { action: step.action, value: step.value },
      toolRequest,
    );
    if (!toBoolean(result.success)) {
      const approvalId = toString(result.approvalId);
      const status = toString(result.status);
      if (status === 'pending_approval' && approvalId) {
        pendingIds.push(approvalId);
        params.trackPendingApproval?.(approvalId);
        fallbackMetadata.push({
          id: approvalId,
          toolName: 'update_tool_policy',
          argsPreview: JSON.stringify({ action: step.action, value: step.value }),
        });
        continue;
      }
      continue;
    }
    appliedAny = true;
  }

  if (pendingIds.length > 0) {
    const summary = `I found fixable policy blockers for '${automationName}' and prepared the required policy changes so I can continue once you approve them.`;
    const pendingApprovals = params.resolvePendingApprovalMetadata
      ? params.resolvePendingApprovalMetadata(pendingIds, fallbackMetadata)
      : fallbackMetadata;
    const prompt = params.formatPendingApprovalPrompt
      ? params.formatPendingApprovalPrompt(pendingIds)
      : 'This action needs approval before I can continue.';
    return {
      content: [summary, prompt].filter(Boolean).join('\n\n'),
      metadata: {
        pendingApprovals,
        resumeAutomationAfterApprovals: true,
      },
    };
  }

  if (!appliedAny) return null;

  return tryAutomationPreRoute(params, { allowRemediation: false });
}

function uniqueAutomationFixes(
  fixes: Array<{ type: 'tool_policy' | 'path' | 'command' | 'domain'; value: string; description: string }>,
): Array<{ type: 'tool_policy' | 'path' | 'command' | 'domain'; value: string; description: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ type: 'tool_policy' | 'path' | 'command' | 'domain'; value: string; description: string }> = [];
  for (const fix of fixes) {
    const key = `${fix.type}:${fix.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(fix);
  }
  return deduped;
}

function toPolicyRemediation(
  fix: { type: 'tool_policy' | 'path' | 'command' | 'domain'; value: string; description: string },
): { action: string; value: string; description: string } | null {
  switch (fix.type) {
    case 'path':
      return { action: 'add_path', value: fix.value, description: fix.description };
    case 'domain':
      return { action: 'add_domain', value: fix.value, description: fix.description };
    case 'command':
      return { action: 'add_command', value: fix.value, description: fix.description };
    case 'tool_policy':
      return { action: 'set_tool_policy_auto', value: fix.value, description: fix.description };
    default:
      return null;
  }
}

function normalizeAutomationLookupValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function capitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
