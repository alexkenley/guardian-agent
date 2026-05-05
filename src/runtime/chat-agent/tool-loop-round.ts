import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type {
  ContentTrustLevel,
  ToolCategory,
  ToolDefinition,
  ToolExecutionRequest,
  ToolRisk,
} from '../../tools/types.js';
import { formatToolResultForLLM, toLLMToolDef } from '../../chat-agent-helpers.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import { coalescePackageInstallToolCalls } from '../package-install-tool-coalescing.js';
import {
  executeToolsConflictAware,
  isDeferredRemoteSandboxToolResult,
  type ConflictAwareToolCall,
} from './tool-execution.js';

type LlmToolDefinition = NonNullable<ChatOptions['tools']>[number];

export interface ToolLoopSanitizedResult {
  sanitized: unknown;
  threats: string[];
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
}

export interface ToolLoopRoundState {
  llmMessages: ChatMessage[];
  allToolDefs: ToolDefinition[];
  llmToolDefs: LlmToolDefinition[];
  contentTrustLevel: ContentTrustLevel;
  taintReasons: Set<string>;
}

export interface ToolLoopExecutedResult {
  toolCall: ConflictAwareToolCall;
  result: Record<string, unknown>;
}

export interface ToolLoopRoundResult {
  toolResults: PromiseSettledResult<ToolLoopExecutedResult>[];
  lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }>;
  pendingIds: string[];
  hasPending: boolean;
  allBlocked: boolean;
  deferredRemoteToolCallIds: Set<string>;
  contentTrustLevel: ContentTrustLevel;
  taintReasons: Set<string>;
}

export async function executeToolLoopRound(input: {
  response: ChatResponse & { toolCalls: ConflictAwareToolCall[] };
  state: ToolLoopRoundState;
  toolExecOrigin: Omit<ToolExecutionRequest, 'toolName' | 'args'>;
  referenceTime: number;
  intentDecision?: IntentGatewayDecision;
  tools: Pick<ToolExecutor, 'executeModelTool' | 'getToolDefinition'>;
  secondBrainService?: Pick<SecondBrainService, 'getEventById' | 'getTaskById' | 'getPersonById'> | null;
  toolResultProviderKind: 'local' | 'external';
  sanitizeToolResultForLlm: (
    toolName: string,
    result: unknown,
    providerKind: 'local' | 'external',
  ) => ToolLoopSanitizedResult;
}): Promise<ToolLoopRoundResult> {
  const toolCalls = coalescePackageInstallToolCalls(input.response.toolCalls) ?? input.response.toolCalls;
  input.state.llmMessages.push({
    role: 'assistant',
    content: input.response.content ?? '',
    toolCalls,
  });

  const toolResults = await Promise.allSettled(
    executeToolsConflictAware({
      toolCalls,
      toolExecOrigin: input.toolExecOrigin,
      referenceTime: input.referenceTime,
      intentDecision: input.intentDecision,
      tools: input.tools,
      secondBrainService: input.secondBrainService,
    }),
  );
  const lastToolRoundResults = toolResults.reduce<Array<{ toolName: string; result: Record<string, unknown> }>>(
    (acc, settled) => {
      if (settled.status !== 'fulfilled') return acc;
      acc.push({
        toolName: settled.value.toolCall.name,
        result: settled.value.result,
      });
      return acc;
    },
    [],
  );

  const pendingIds: string[] = [];
  let hasPending = false;
  const deferredRemoteToolCallIds = new Set<string>();
  for (const settled of toolResults) {
    if (settled.status === 'fulfilled') {
      const { toolCall, result: toolResult } = settled.value;
      if (toolResult.status === 'pending_approval' && toolResult.approvalId) {
        pendingIds.push(String(toolResult.approvalId));
        hasPending = true;
      }
      if (isDeferredRemoteSandboxToolResult(toolResult)) {
        deferredRemoteToolCallIds.add(toolCall.id);
      }

      let resultForLlm = toolResult;
      if (toolResult.status === 'pending_approval') {
        const { approvalId: _approvalId, jobId: _jobId, ...rest } = toolResult;
        resultForLlm = {
          ...rest,
          message: 'This action needs your approval. The approval UI is shown to the user automatically.',
        };
      }

      const scannedToolResult = input.sanitizeToolResultForLlm(
        toolCall.name,
        resultForLlm,
        input.toolResultProviderKind,
      );
      if (scannedToolResult.trustLevel === 'quarantined') {
        input.state.contentTrustLevel = 'quarantined';
      } else if (scannedToolResult.trustLevel === 'low_trust' && input.state.contentTrustLevel === 'trusted') {
        input.state.contentTrustLevel = 'low_trust';
      }
      for (const reason of scannedToolResult.taintReasons) {
        input.state.taintReasons.add(reason);
      }

      input.state.llmMessages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: formatToolResultForLLM(
          toolCall.name,
          scannedToolResult.sanitized,
          scannedToolResult.threats,
        ),
      });
      if (toolCall.name === 'find_tools' && toolResult.success) {
        appendDiscoveredToolDefinitions({
          result: toolResult,
          allToolDefs: input.state.allToolDefs,
          llmToolDefs: input.state.llmToolDefs,
          providerKind: input.toolResultProviderKind,
        });
      }
    } else {
      const failedToolCall = toolCalls[toolResults.indexOf(settled)];
      input.state.llmMessages.push({
        role: 'tool',
        toolCallId: failedToolCall?.id ?? '',
        content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
      });
    }
  }

  const allBlocked = hasPending && toolResults.every(
    (settled) => settled.status === 'fulfilled'
      && (
        (settled.value.result as Record<string, unknown>).status === 'pending_approval'
        || isDeferredRemoteSandboxToolResult(settled.value.result as Record<string, unknown>)
      ),
  );

  return {
    toolResults,
    lastToolRoundResults,
    pendingIds,
    hasPending,
    allBlocked,
    deferredRemoteToolCallIds,
    contentTrustLevel: input.state.contentTrustLevel,
    taintReasons: input.state.taintReasons,
  };
}

function appendDiscoveredToolDefinitions(input: {
  result: Record<string, unknown>;
  allToolDefs: ToolDefinition[];
  llmToolDefs: LlmToolDefinition[];
  providerKind: 'local' | 'external';
}): void {
  const searchOutput = input.result.output as {
    tools?: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      risk: string;
      category?: string;
    }>;
  } | undefined;
  if (!searchOutput?.tools) return;
  for (const discovered of searchOutput.tools) {
    if (input.llmToolDefs.some((definition) => definition.name === discovered.name)) {
      continue;
    }
    const toolDefinition = {
      name: discovered.name,
      description: discovered.description,
      risk: discovered.risk as ToolRisk,
      parameters: discovered.parameters,
      category: discovered.category as ToolCategory | undefined,
    };
    input.allToolDefs.push(toolDefinition);
    input.llmToolDefs.push(toLLMToolDef(toolDefinition, input.providerKind));
  }
}
