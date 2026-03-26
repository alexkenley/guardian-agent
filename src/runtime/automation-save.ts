import type {
  AssistantConnectorPlaybookDefinition,
  AssistantConnectorPlaybookStepDefinition,
  AutomationOutputHandlingConfig,
} from '../config/types.js';
import type {
  ScheduledTaskCreateInput,
  ScheduledTaskDefinition,
  ScheduledTaskUpdateInput,
} from './scheduled-tasks.js';

export type AutomationSaveKind = 'workflow' | 'assistant_task' | 'standalone_task';

export interface AutomationSaveInput {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  kind: AutomationSaveKind;
  sourceKind?: string;
  existingTaskId?: string;
  signature?: string;
  mode?: 'sequential' | 'parallel';
  steps?: AssistantConnectorPlaybookStepDefinition[];
  task?: {
    target: string;
    args?: Record<string, unknown>;
    prompt?: string;
    channel?: string;
    deliver?: boolean;
    llmProvider?: string;
  };
  schedule?: {
    enabled?: boolean;
    cron?: string;
    runOnce?: boolean;
  };
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}

export interface AutomationSaveResult {
  success: boolean;
  message: string;
  automationId?: string;
  taskId?: string;
}

export interface AutomationSaveControlPlane {
  upsertWorkflow(workflow: AssistantConnectorPlaybookDefinition): { success: boolean; message: string };
  createTask(input: ScheduledTaskCreateInput): { success: boolean; message: string; task?: ScheduledTaskDefinition };
  updateTask(id: string, input: ScheduledTaskUpdateInput): { success: boolean; message: string };
  deleteTask(id: string): { success: boolean; message: string };
}

export function saveAutomationDefinition(
  controlPlane: AutomationSaveControlPlane,
  input: AutomationSaveInput,
): AutomationSaveResult {
  const automationId = input.id.trim();
  const name = input.name.trim();
  const description = input.description?.trim() || '';
  const existingTaskId = input.existingTaskId?.trim() || '';
  const signature = input.signature?.trim() || undefined;
  const emitEvent = input.emitEvent?.trim() || undefined;
  const outputHandling = input.outputHandling ? { ...input.outputHandling } : undefined;
  const scheduleEnabled = input.schedule?.enabled === true;
  const cron = input.schedule?.cron?.trim() || '';
  const runOnce = input.schedule?.runOnce === true;

  if (!name) {
    return { success: false, message: 'Automation name is required.' };
  }
  if (scheduleEnabled && !cron) {
    return { success: false, message: 'Choose a valid schedule.' };
  }

  if (input.kind === 'assistant_task') {
    const prompt = input.task?.prompt?.trim() || '';
    if (!prompt) {
      return { success: false, message: 'Assistant prompt is required.' };
    }
    const taskInput = buildAgentTaskInput({
      automationId,
      name,
      description,
      enabled: input.enabled,
      target: input.task?.target?.trim() || 'default',
      prompt,
      channel: input.task?.channel?.trim() || 'scheduled',
      deliver: input.task?.deliver !== false,
      cron: scheduleEnabled ? cron : '',
      runOnce,
      emitEvent,
      outputHandling,
      llmProvider: input.task?.llmProvider?.trim() || '',
    });
    if (existingTaskId && input.sourceKind !== 'preset') {
      const result = controlPlane.updateTask(existingTaskId, taskInput);
      return toMutationResult(result, existingTaskId, existingTaskId);
    }
    const result = controlPlane.createTask(taskInput);
    return toTaskCreateResult(result, existingTaskId);
  }

  if (input.kind === 'standalone_task') {
    const target = input.task?.target?.trim() || '';
    if (!target) {
      return { success: false, message: 'Select a tool.' };
    }
    const taskInput = buildStandaloneTaskInput({
      automationId,
      name,
      description,
      enabled: input.enabled,
      target,
      args: input.task?.args,
      cron: scheduleEnabled ? cron : '',
      runOnce,
      emitEvent,
      outputHandling,
    });
    if (existingTaskId && input.sourceKind !== 'preset') {
      const result = controlPlane.updateTask(existingTaskId, taskInput);
      return toMutationResult(result, existingTaskId, existingTaskId);
    }
    const result = controlPlane.createTask(taskInput);
    return toTaskCreateResult(result, existingTaskId);
  }

  if (!automationId) {
    return { success: false, message: 'Automation ID is required.' };
  }
  const steps = Array.isArray(input.steps) ? input.steps.map(cloneWorkflowStep) : [];
  if (steps.length === 0) {
    return { success: false, message: 'Add at least one step.' };
  }

  const workflowResult = controlPlane.upsertWorkflow({
    id: automationId,
    name,
    enabled: input.enabled,
    mode: input.mode === 'parallel' ? 'parallel' : 'sequential',
    ...(description ? { description } : {}),
    ...(signature ? { signature } : {}),
    ...(outputHandling ? { outputHandling } : {}),
    steps,
  });
  if (!workflowResult.success) {
    return { success: false, message: workflowResult.message || 'Failed to save the automation.' };
  }

  if (!scheduleEnabled) {
    if (existingTaskId) {
      const deleteResult = controlPlane.deleteTask(existingTaskId);
      if (!deleteResult.success) {
        return {
          success: false,
          automationId,
          message: `Automation saved, but removing the linked schedule failed: ${deleteResult.message || 'Unknown error.'}`,
        };
      }
    }
    return { success: true, message: 'Saved.', automationId };
  }

  const taskInput = buildWorkflowScheduleInput({
    name,
    enabled: input.enabled,
    target: automationId,
    cron,
    runOnce,
    emitEvent,
    outputHandling,
  });
  if (existingTaskId) {
    const taskResult = controlPlane.updateTask(existingTaskId, taskInput);
    if (!taskResult.success) {
      return {
        success: false,
        automationId,
        taskId: existingTaskId,
        message: `Automation saved, but the linked schedule could not be updated: ${taskResult.message || 'Unknown error.'}`,
      };
    }
    return { success: true, message: 'Saved.', automationId, taskId: existingTaskId };
  }

  const taskResult = controlPlane.createTask(taskInput);
  if (!taskResult.success) {
    return {
      success: false,
      automationId,
      message: `Automation saved, but the linked schedule could not be created: ${taskResult.message || 'Unknown error.'}`,
    };
  }
  return {
    success: true,
    message: 'Saved.',
    automationId,
    taskId: taskResult.task?.id,
  };
}

function buildAgentTaskInput(input: {
  automationId: string;
  name: string;
  description: string;
  enabled: boolean;
  target: string;
  prompt: string;
  channel: string;
  deliver: boolean;
  cron: string;
  runOnce: boolean;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
  llmProvider?: string;
}): ScheduledTaskCreateInput {
  return {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    type: 'agent',
    target: input.target,
    prompt: input.prompt,
    channel: input.channel,
    deliver: input.deliver,
    ...(input.cron ? { cron: input.cron } : { eventTrigger: buildManualAutomationEventTrigger(input.automationId) }),
    ...(input.runOnce ? { runOnce: true } : {}),
    enabled: input.enabled,
    ...(input.emitEvent ? { emitEvent: input.emitEvent } : {}),
    ...(input.outputHandling ? { outputHandling: { ...input.outputHandling } } : {}),
    ...(input.llmProvider ? { args: { llmProvider: input.llmProvider } } : {}),
  };
}

function buildStandaloneTaskInput(input: {
  automationId: string;
  name: string;
  description: string;
  enabled: boolean;
  target: string;
  args?: Record<string, unknown>;
  cron: string;
  runOnce: boolean;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}): ScheduledTaskCreateInput {
  return {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    type: 'tool',
    target: input.target,
    ...(input.args ? { args: { ...input.args } } : {}),
    ...(input.cron ? { cron: input.cron } : { eventTrigger: buildManualAutomationEventTrigger(input.automationId) }),
    ...(input.runOnce ? { runOnce: true } : {}),
    enabled: input.enabled,
    ...(input.emitEvent ? { emitEvent: input.emitEvent } : {}),
    ...(input.outputHandling ? { outputHandling: { ...input.outputHandling } } : {}),
  };
}

function buildManualAutomationEventTrigger(automationId: string): { eventType: string } {
  return {
    eventType: `automation:manual:${automationId}`,
  };
}

function buildWorkflowScheduleInput(input: {
  name: string;
  enabled: boolean;
  target: string;
  cron: string;
  runOnce: boolean;
  emitEvent?: string;
  outputHandling?: AutomationOutputHandlingConfig;
}): ScheduledTaskCreateInput {
  return {
    name: input.name,
    type: 'playbook',
    target: input.target,
    cron: input.cron,
    ...(input.runOnce ? { runOnce: true } : {}),
    enabled: input.enabled,
    ...(input.emitEvent ? { emitEvent: input.emitEvent } : {}),
    ...(input.outputHandling ? { outputHandling: { ...input.outputHandling } } : {}),
  };
}

function toMutationResult(
  result: { success: boolean; message: string },
  automationId: string,
  taskId: string,
): AutomationSaveResult {
  return {
    success: result.success,
    message: result.success ? 'Saved.' : (result.message || 'Failed to save the automation.'),
    automationId,
    taskId,
  };
}

function toTaskCreateResult(
  result: { success: boolean; message: string; task?: ScheduledTaskDefinition },
  automationId: string,
): AutomationSaveResult {
  return {
    success: result.success,
    message: result.success ? 'Saved.' : (result.message || 'Failed to save the automation.'),
    automationId: result.task?.id || automationId,
    taskId: result.task?.id,
  };
}

function cloneWorkflowStep(
  step: AssistantConnectorPlaybookStepDefinition,
): AssistantConnectorPlaybookStepDefinition {
  return {
    ...step,
    ...(step.args ? { args: { ...step.args } } : {}),
  };
}
