import type {
  AutomationArtifactPersistenceMode,
  AutomationOutputHandlingConfig,
  AutomationOutputRoutingMode,
} from '../../config/types.js';
import type { SavedAutomationCatalogEntry } from '../../runtime/automation-catalog.js';
import type { AutomationOutputStore } from '../../runtime/automation-output-store.js';
import type { AutomationSaveInput } from '../../runtime/automation-save.js';
import type { ScheduledTaskEventTrigger } from '../../runtime/scheduled-tasks.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface AutomationWorkflowSummary {
  id: string;
  name: string;
  enabled: boolean;
  mode: string;
  description?: string;
  schedule?: string;
  steps?: Array<Record<string, unknown>>;
}

interface AutomationTaskSummary {
  id: string;
  name: string;
  description?: string;
  type: 'tool' | 'playbook' | 'agent';
  target: string;
  cron?: string;
  eventTrigger?: ScheduledTaskEventTrigger;
  enabled: boolean;
  args?: Record<string, unknown>;
  prompt?: string;
  channel?: string;
  userId?: string;
  deliver?: boolean;
  runOnce?: boolean;
  approvalExpiresAt?: number;
  approvedByPrincipal?: string;
  scopeHash?: string;
  maxRunsPerWindow?: number;
  dailySpendCap?: number;
  providerSpendCap?: number;
  consecutiveFailureCount?: number;
  consecutiveDeniedCount?: number;
  autoPausedReason?: string;
  emitEvent?: string;
}

interface AutomationControlPlane {
  listAutomations: () => SavedAutomationCatalogEntry[];
  saveAutomation: (input: AutomationSaveInput) => { success: boolean; message: string; automationId?: string; taskId?: string };
  setAutomationEnabled: (automationId: string, enabled: boolean) => { success: boolean; message: string };
  deleteAutomation: (automationId: string) => { success: boolean; message: string };
  runAutomation: (input: {
    automationId: string;
    dryRun?: boolean;
    origin?: ToolExecutionRequest['origin'];
    agentId?: string;
    userId?: string;
    channel?: string;
    requestedBy?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

interface AutomationToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  requireBoolean: (value: unknown, field: string) => boolean;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  getAutomationControlPlane: () => AutomationControlPlane | undefined;
  getAutomationOutputStore: () => AutomationOutputStore | undefined;
  hasTool: (toolName: string) => boolean;
}

export function registerBuiltinAutomationTools(context: AutomationToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'automation_list',
      description: 'List automations from the canonical automation catalog. Includes saved workflows/tasks plus built-in starter examples, with source, enabled status, and scheduling hints.',
      shortDescription: 'List automations from the canonical catalog.',
      risk: 'read_only',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const controlPlane = context.getAutomationControlPlane();
      if (!controlPlane) {
        return { success: false, error: 'Automation control plane is not available.' };
      }
      const automations = controlPlane.listAutomations().map(normalizeAutomationCatalogEntry);
      return {
        success: true,
        output: {
          count: automations.length,
          automations,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'automation_output_search',
      description: 'Search historically stored output from saved automation runs. This only covers automation runs with historical analysis persistence enabled; ad hoc tool runs are excluded.',
      shortDescription: 'Search stored output from saved automation runs.',
      risk: 'read_only',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional text query for run previews and stored step output.' },
          automationId: { type: 'string', description: 'Optional automation id filter.' },
          runId: { type: 'string', description: 'Optional exact run id filter.' },
          status: { type: 'string', description: 'Optional run status filter.' },
          limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
        },
      },
    },
    async (args, request) => {
      const store = context.getAutomationOutputStore();
      if (!store) {
        return { success: false, error: 'Historical automation output is not available.' };
      }
      const query = context.asString(args.query).trim();
      const automationId = context.asString(args.automationId).trim();
      const runId = context.asString(args.runId).trim();
      const status = context.asString(args.status).trim();
      const limit = Math.min(Math.max(context.asNumber(args.limit, 10), 1), 50);
      context.guardAction(request, 'read_file', {
        path: 'automation_output:search',
        query,
        automationId: automationId || undefined,
        runId: runId || undefined,
        status: status || undefined,
      });
      const results = store.search({
        ...(query ? { query } : {}),
        ...(automationId ? { automationId } : {}),
        ...(runId ? { runId } : {}),
        ...(status ? { status } : {}),
        limit,
      });
      return {
        success: true,
        output: {
          resultCount: results.length,
          results,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'automation_output_read',
      description: 'Read historically stored output from a saved automation run. Supports whole-run reads or one specific step, with chunking for large outputs. This is only for saved automation runs, not ad hoc tool usage.',
      shortDescription: 'Read stored output from a saved automation run.',
      risk: 'read_only',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Automation run id to read.' },
          stepId: { type: 'string', description: 'Optional specific step id within the run.' },
          offset: { type: 'number', description: 'Optional character offset for chunked reads.' },
          maxChars: { type: 'number', description: 'Optional character limit for this chunk.' },
        },
        required: ['runId'],
      },
    },
    async (args, request) => {
      const store = context.getAutomationOutputStore();
      if (!store) {
        return { success: false, error: 'Historical automation output is not available.' };
      }
      const runId = context.requireString(args.runId, 'runId').trim();
      const stepId = context.asString(args.stepId).trim();
      const offset = Math.max(0, Math.floor(context.asNumber(args.offset, 0)));
      const maxChars = Math.max(0, Math.floor(context.asNumber(args.maxChars, 0)));
      context.guardAction(request, 'read_file', {
        path: `automation_output:${runId}`,
        ...(stepId ? { stepId } : {}),
      });
      const result = store.read({
        runId,
        ...(stepId ? { stepId } : {}),
        ...(offset > 0 ? { offset } : {}),
        ...(maxChars > 0 ? { maxChars } : {}),
      });
      if (!result) {
        return { success: false, error: `Stored automation output for run '${runId}' was not found.` };
      }
      return {
        success: true,
        output: result,
      };
    },
  );

  context.registry.register(
    {
      name: 'automation_save',
      description: 'Create or update an automation through Guardian\'s canonical automation contract. Supports step-based automations, assistant automations, and manual or scheduled execution. Mutating - requires approval.',
      shortDescription: 'Create or update an automation.',
      risk: 'mutating',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Automation id.' },
          name: { type: 'string', description: 'Automation name.' },
          description: { type: 'string', description: 'Optional automation description.' },
          enabled: { type: 'boolean', description: 'Whether the automation is enabled.' },
          kind: { type: 'string', enum: ['workflow', 'assistant_task', 'standalone_task'], description: 'Automation kind.' },
          sourceKind: { type: 'string', description: 'Optional existing source kind when updating an automation.' },
          existingTaskId: { type: 'string', description: 'Optional linked task id when updating an automation with an existing schedule or saved task.' },
          mode: { type: 'string', enum: ['sequential', 'parallel'], description: 'Execution mode for step-based automations.' },
          steps: {
            type: 'array',
            description: 'Steps for a step-based automation. Each step should include id plus either toolName, instruction, or delayMs.',
            items: { type: 'object' },
          },
          task: {
            type: 'object',
            description: 'Task definition for assistant or standalone tool automations.',
            properties: {
              target: { type: 'string', description: 'Target agent id or tool name.' },
              args: { type: 'object', description: 'Optional tool args for standalone tool automations.' },
              prompt: { type: 'string', description: 'Assistant prompt for assistant automations.' },
              channel: { type: 'string', description: 'Delivery channel for assistant automations.' },
              deliver: { type: 'boolean', description: 'Whether assistant output should be delivered to the channel.' },
              llmProvider: { type: 'string', description: 'Optional explicit LLM provider selector.' },
            },
          },
          schedule: {
            type: 'object',
            description: 'Optional schedule definition. Leave enabled=false or omit cron for manual-only automations.',
            properties: {
              enabled: { type: 'boolean', description: 'Whether a schedule is enabled.' },
              cron: { type: 'string', description: 'Cron expression for scheduled automations.' },
              runOnce: { type: 'boolean', description: 'Whether the schedule should disable itself after a single run.' },
            },
          },
          emitEvent: { type: 'string', description: 'Optional event name to emit when the automation completes.' },
          outputHandling: {
            type: 'object',
            description: 'Optional output routing configuration.',
            properties: {
              notify: { type: 'string', description: 'Notification routing mode.' },
              sendToSecurity: { type: 'string', description: 'Security routing mode.' },
              persistArtifacts: { type: 'string', description: 'Artifact persistence mode.' },
            },
          },
        },
        required: ['id', 'name', 'enabled', 'kind'],
      },
    },
    async (args) => {
      const controlPlane = context.getAutomationControlPlane();
      if (!controlPlane) {
        return { success: false, error: 'Automation control plane is not available.' };
      }
      const input = normalizeAutomationSaveInput(args, context);
      const result = controlPlane.saveAutomation(input);
      return { success: result.success, output: result, error: result.success ? undefined : result.message };
    },
  );

  context.registry.register(
    {
      name: 'automation_set_enabled',
      description: 'Enable or disable a saved automation by id. Built-in starter entries cannot be toggled until you create a saved copy. Mutating - requires approval.',
      shortDescription: 'Enable or disable a saved automation.',
      risk: 'mutating',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          automationId: { type: 'string', description: 'Saved automation id.' },
          enabled: { type: 'boolean', description: 'Desired enabled state.' },
        },
        required: ['automationId', 'enabled'],
      },
    },
    async (args) => {
      const controlPlane = context.getAutomationControlPlane();
      if (!controlPlane) {
        return { success: false, error: 'Automation control plane is not available.' };
      }
      const automationId = context.requireString(args.automationId, 'automationId');
      const enabled = context.requireBoolean(args.enabled, 'enabled');
      const result = controlPlane.setAutomationEnabled(automationId, enabled);
      return { success: result.success, output: result, error: result.success ? undefined : result.message };
    },
  );

  context.registry.register(
    {
      name: 'automation_run',
      description: 'Run a saved automation immediately by id. Built-in starter entries must be turned into a saved automation first. Supports dryRun for step-based automations. Mutating - requires approval.',
      shortDescription: 'Run a saved automation immediately.',
      risk: 'mutating',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          automationId: { type: 'string', description: 'Saved automation id.' },
          dryRun: { type: 'boolean', description: 'Preview without side effects when the automation supports it.' },
        },
        required: ['automationId'],
      },
    },
    async (args, request) => {
      const controlPlane = context.getAutomationControlPlane();
      if (!controlPlane) {
        return { success: false, error: 'Automation control plane is not available.' };
      }
      const automationId = context.requireString(args.automationId, 'automationId');
      const result = await controlPlane.runAutomation({
        automationId,
        dryRun: args.dryRun === true,
        origin: request.origin,
        agentId: request.agentId,
        userId: request.userId,
        channel: request.channel,
        requestedBy: request.userId || request.agentId || request.origin,
      });
      const succeeded = context.isRecord(result) ? result.success === true : false;
      const message = context.isRecord(result) ? context.asString(result.message, '').trim() : '';
      return { success: succeeded, output: result, error: succeeded ? undefined : message || 'Automation run failed.' };
    },
  );

  context.registry.register(
    {
      name: 'automation_delete',
      description: 'Delete a saved automation by id. For workflow-backed automations this also removes any linked schedule. Built-in starter entries cannot be deleted. Mutating - requires approval.',
      shortDescription: 'Delete a saved automation.',
      risk: 'mutating',
      category: 'automation',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          automationId: { type: 'string', description: 'Saved automation id.' },
        },
        required: ['automationId'],
      },
    },
    async (args) => {
      const controlPlane = context.getAutomationControlPlane();
      if (!controlPlane) {
        return { success: false, error: 'Automation control plane is not available.' };
      }
      const automationId = context.requireString(args.automationId, 'automationId');
      const result = controlPlane.deleteAutomation(automationId);
      return { success: result.success, output: result, error: result.success ? undefined : result.message };
    },
  );
}

function normalizeWorkflowSummary(workflow: AutomationWorkflowSummary): AutomationWorkflowSummary & { kind: 'workflow' } {
  return {
    ...workflow,
    kind: 'workflow',
  };
}

function normalizeAutomationCatalogEntry(entry: SavedAutomationCatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kind: entry.kind,
    enabled: entry.enabled,
    source: entry.source,
    builtin: entry.builtin === true,
    category: entry.category,
    templateId: entry.templateId,
    presetId: entry.presetId,
    workflow: entry.workflow ? normalizeWorkflowSummary(entry.workflow as unknown as AutomationWorkflowSummary) : undefined,
    task: entry.task ? normalizeTaskSummary(entry.task as AutomationTaskSummary) : undefined,
  };
}

function normalizeTaskSummary(task: AutomationTaskSummary): Record<string, unknown> {
  return {
    ...task,
    kind: 'task',
    type: task.type === 'playbook' ? 'workflow' : task.type,
    approvalExpired: typeof task.approvalExpiresAt === 'number' ? task.approvalExpiresAt <= Date.now() : true,
  };
}

function normalizeAutomationSaveInput(
  input: Record<string, unknown>,
  context: Pick<AutomationToolRegistrarContext, 'requireString' | 'requireBoolean' | 'asString' | 'isRecord' | 'hasTool'>,
): AutomationSaveInput {
  const kind = context.requireString(input.kind, 'kind').trim();
  if (kind !== 'workflow' && kind !== 'assistant_task' && kind !== 'standalone_task') {
    throw new Error(`Unsupported automation kind '${kind}'.`);
  }

  const normalized: AutomationSaveInput = {
    id: context.requireString(input.id, 'id').trim(),
    name: context.requireString(input.name, 'name').trim(),
    enabled: context.requireBoolean(input.enabled, 'enabled'),
    kind,
    ...(context.asString(input.description).trim() ? { description: context.asString(input.description).trim() } : {}),
    ...(context.asString(input.sourceKind).trim() ? { sourceKind: context.asString(input.sourceKind).trim() } : {}),
    ...(context.asString(input.existingTaskId).trim() ? { existingTaskId: context.asString(input.existingTaskId).trim() } : {}),
    ...(context.asString(input.emitEvent).trim() ? { emitEvent: context.asString(input.emitEvent).trim() } : {}),
  };

  const schedule = context.isRecord(input.schedule) ? input.schedule : null;
  if (schedule) {
    normalized.schedule = {
      enabled: schedule.enabled === true,
      ...(context.asString(schedule.cron).trim() ? { cron: context.asString(schedule.cron).trim() } : {}),
      ...(schedule.runOnce === true ? { runOnce: true } : {}),
    };
  }

  const outputHandling = context.isRecord(input.outputHandling) ? input.outputHandling : null;
  if (outputHandling) {
    normalized.outputHandling = normalizeAutomationOutputHandlingInput(outputHandling, context.asString);
  }

  if (kind === 'workflow') {
    const mode = context.asString(input.mode, 'sequential').trim();
    if (mode !== 'sequential' && mode !== 'parallel') {
      throw new Error('Automation mode must be sequential or parallel.');
    }
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const validationError = validateWorkflowDefinition({ steps }, context.asString, context.isRecord, context.hasTool);
    if (validationError) {
      throw new Error(validationError);
    }
    normalized.mode = mode;
    normalized.steps = steps
      .filter((step): step is Record<string, unknown> => context.isRecord(step))
      .map((step) => ({
        ...step,
        ...(context.isRecord(step.args) ? { args: { ...step.args } } : {}),
      })) as AutomationSaveInput['steps'];
    return normalized;
  }

  const task = context.isRecord(input.task) ? input.task : {};
  normalized.task = {
    target: context.requireString(task.target, 'task.target').trim(),
    ...(context.isRecord(task.args) ? { args: { ...task.args } } : {}),
    ...(context.asString(task.prompt).trim() ? { prompt: context.asString(task.prompt).trim() } : {}),
    ...(context.asString(task.channel).trim() ? { channel: context.asString(task.channel).trim() } : {}),
    ...(typeof task.deliver === 'boolean' ? { deliver: task.deliver } : {}),
    ...(context.asString(task.llmProvider).trim() ? { llmProvider: context.asString(task.llmProvider).trim() } : {}),
  };
  return normalized;
}

function normalizeAutomationOutputHandlingInput(
  input: Record<string, unknown>,
  asString: (value: unknown, fallback?: string) => string,
): AutomationOutputHandlingConfig {
  const notify = asString(input.notify).trim();
  const sendToSecurity = asString(input.sendToSecurity).trim();
  const persistArtifacts = asString(input.persistArtifacts).trim();
  return {
    notify: normalizeAutomationOutputRoutingMode(notify),
    sendToSecurity: normalizeAutomationOutputRoutingMode(sendToSecurity),
    persistArtifacts: normalizeAutomationArtifactPersistenceMode(persistArtifacts),
  };
}

function normalizeAutomationOutputRoutingMode(
  value: string,
): AutomationOutputRoutingMode {
  return value === 'warn_critical' || value === 'all' ? value : 'off';
}

function normalizeAutomationArtifactPersistenceMode(
  value: string,
): AutomationArtifactPersistenceMode {
  return value === 'run_history_only' ? value : 'run_history_plus_memory';
}

function validateWorkflowDefinition(
  args: Record<string, unknown>,
  asString: (value: unknown, fallback?: string) => string,
  isRecord: (value: unknown) => value is Record<string, unknown>,
  hasTool: (toolName: string) => boolean,
): string | null {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  for (const [index, rawStep] of steps.entries()) {
    if (!isRecord(rawStep)) {
      return `Step ${index + 1} is invalid.`;
    }
    const stepId = asString(rawStep.id, `step_${index + 1}`).trim() || `step_${index + 1}`;
    const stepType = inferWorkflowStepType(rawStep, asString);
    if (stepType === 'instruction') {
      if (!asString(rawStep.instruction).trim()) {
        return `Instruction step '${stepId}' is missing instruction text.`;
      }
      continue;
    }
    if (stepType === 'delay') {
      if (typeof rawStep.delayMs !== 'number' || !Number.isFinite(rawStep.delayMs) || rawStep.delayMs < 0) {
        return `Delay step '${stepId}' is missing a valid delayMs value.`;
      }
      continue;
    }

    const toolName = asString(rawStep.toolName).trim();
    if (!toolName) {
      return `Tool step '${stepId}' is missing toolName.`;
    }
    if (!hasTool(toolName)) {
      const browserHint = /^mcp[_-]playwright/i.test(toolName)
        ? ' Use Guardian-native browser wrapper tools (`browser_navigate`, `browser_read`, `browser_links`, `browser_extract`, `browser_state`, `browser_act`, and compatibility `browser_interact`) in saved automations instead of raw MCP browser names.'
        : '';
      return `Unknown tool '${toolName}'.${browserHint}`;
    }
  }
  return null;
}

function inferWorkflowStepType(
  step: Record<string, unknown>,
  asString: (value: unknown, fallback?: string) => string,
): 'tool' | 'instruction' | 'delay' {
  const explicit = asString(step.type).trim().toLowerCase();
  if (explicit === 'instruction' || explicit === 'delay' || explicit === 'tool') {
    return explicit;
  }
  if (typeof step.delayMs === 'number') {
    return 'delay';
  }
  if (asString(step.instruction).trim()) {
    return 'instruction';
  }
  return 'tool';
}
