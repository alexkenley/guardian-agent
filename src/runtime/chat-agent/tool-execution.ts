import type { ChatMessage } from '../../llm/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { prepareToolExecutionForIntent } from '../routed-tool-execution.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ToolExecutionRequest } from '../../tools/types.js';
import {
  getMemoryMutationIntentDeniedMessage,
  isMemoryMutationToolName,
} from '../../util/memory-intent.js';

export const DEFERRED_REMOTE_SANDBOX_STEP_STATUS = 'deferred_remote_sandbox_step';

const REMOTE_SANDBOX_SERIAL_TOOL_NAMES = new Set([
  'code_remote_exec',
  'code_test',
  'code_build',
  'code_lint',
]);

export interface ConflictAwareToolCall {
  id: string;
  name: string;
  arguments?: string;
}

interface ConflictAwareToolDeps {
  tools: Pick<ToolExecutor, 'executeModelTool' | 'getToolDefinition'>;
  secondBrainService?: Pick<SecondBrainService, 'getEventById' | 'getTaskById' | 'getPersonById'> | null;
}

export function isSerializedRemoteSandboxToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (!REMOTE_SANDBOX_SERIAL_TOOL_NAMES.has(toolName)) {
    return false;
  }
  if (toolName === 'code_remote_exec') {
    return true;
  }
  const isolation = typeof args.isolation === 'string' ? args.isolation.trim().toLowerCase() : '';
  if (isolation === 'remote_required' || isolation === 'remote_if_available') {
    return true;
  }
  return typeof args.remoteProfile === 'string' && args.remoteProfile.trim().length > 0;
}

export function isDeferredRemoteSandboxToolResult(result: Record<string, unknown>): boolean {
  return typeof result.status === 'string' && result.status.trim() === DEFERRED_REMOTE_SANDBOX_STEP_STATUS;
}

export function pruneDeferredRemoteSandboxToolCalls(
  llmMessages: ChatMessage[],
  deferredToolCallIds: Set<string>,
): void {
  if (deferredToolCallIds.size === 0) {
    return;
  }
  for (let index = llmMessages.length - 1; index >= 0; index -= 1) {
    const message = llmMessages[index];
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      continue;
    }
    const remainingToolCalls = message.toolCalls.filter((toolCall) => !deferredToolCallIds.has(toolCall.id));
    if (remainingToolCalls.length === message.toolCalls.length) {
      return;
    }
    if (remainingToolCalls.length === 0 && !String(message.content ?? '').trim()) {
      llmMessages.splice(index, 1);
      return;
    }
    const { toolCalls: _removedToolCalls, ...rest } = message;
    llmMessages[index] = remainingToolCalls.length > 0
      ? {
          ...rest,
          toolCalls: remainingToolCalls,
        }
      : rest;
    return;
  }
}

export function executeToolsConflictAware(
  input: {
    toolCalls: ConflictAwareToolCall[];
    toolExecOrigin: Omit<ToolExecutionRequest, 'toolName' | 'args'>;
    referenceTime: number;
    intentDecision?: IntentGatewayDecision;
  } & ConflictAwareToolDeps,
): Promise<{ toolCall: ConflictAwareToolCall; result: Record<string, unknown> }>[] {
  const promises: Promise<{ toolCall: ConflictAwareToolCall; result: Record<string, unknown> }>[] = [];
  const locks = new Map<string, Promise<void>>();
  let remoteSandboxStepQueued = false;

  for (const toolCall of input.toolCalls) {
    let parsedArgs: Record<string, unknown> = {};
    if (toolCall.arguments?.trim()) {
      try {
        parsedArgs = JSON.parse(toolCall.arguments) as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }
    }

    if (isMemoryMutationToolName(toolCall.name) && input.toolExecOrigin.allowModelMemoryMutation !== true) {
      promises.push(Promise.resolve({
        toolCall,
        result: {
          success: false,
          status: 'denied',
          message: getMemoryMutationIntentDeniedMessage(toolCall.name),
        },
      }));
      continue;
    }

    const toolDefinition = input.tools.getToolDefinition(toolCall.name);
    const prepared = prepareToolExecutionForIntent({
      toolName: toolCall.name,
      args: parsedArgs,
      requestText: input.toolExecOrigin.requestText,
      referenceTime: input.referenceTime,
      intentDecision: input.intentDecision,
      toolDefinition,
      getEventById: (id) => input.secondBrainService?.getEventById(id) ?? null,
      getTaskById: (id) => input.secondBrainService?.getTaskById(id) ?? null,
      getPersonById: (id) => input.secondBrainService?.getPersonById(id) ?? null,
    });
    parsedArgs = prepared.args;
    if (prepared.immediateResult) {
      promises.push(Promise.resolve({
        toolCall,
        result: prepared.immediateResult,
      }));
      continue;
    }

    const isRemoteSandboxSerializedCall = isSerializedRemoteSandboxToolCall(toolCall.name, parsedArgs);
    if (isRemoteSandboxSerializedCall && remoteSandboxStepQueued) {
      promises.push(Promise.resolve({
        toolCall,
        result: {
          success: false,
          status: DEFERRED_REMOTE_SANDBOX_STEP_STATUS,
          message: 'Another remote sandbox command from this request must finish first. Wait for that result before issuing the next remote sandbox step so the same lease and sandbox state can be reused safely.',
        },
      }));
      continue;
    }
    if (isRemoteSandboxSerializedCall) {
      remoteSandboxStepQueued = true;
    }

    const isMutating = toolDefinition ? toolDefinition.risk !== 'read_only' : true;
    let conflictKey: string | null = null;
    if (isMutating) {
      if (toolCall.name === 'fs_write'
        || toolCall.name === 'fs_delete'
        || toolCall.name === 'fs_move'
        || toolCall.name === 'fs_copy'
        || toolCall.name === 'doc_create') {
        conflictKey = `fs:${parsedArgs.path || parsedArgs.filename || parsedArgs.source}`;
      } else if (toolCall.name.startsWith('browser_')) {
        conflictKey = `browser:${parsedArgs.ref || parsedArgs.url}`;
      } else {
        conflictKey = `global:${toolCall.name}`;
      }
    }

    const executeFn = () => input.tools.executeModelTool(toolCall.name, parsedArgs, input.toolExecOrigin)
      .then((result) => ({ toolCall, result }));

    if (conflictKey) {
      const previous = locks.get(conflictKey) ?? Promise.resolve();
      const current = previous.then(executeFn);
      locks.set(conflictKey, current.then(() => {}).catch(() => {}));
      promises.push(current);
    } else {
      promises.push(executeFn());
    }
  }

  return promises;
}
