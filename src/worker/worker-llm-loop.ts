import type { ChatMessage, ChatResponse, ChatOptions } from '../llm/types.js';
import type { ToolCaller } from '../broker/types.js';
import type { ToolDefinition, ToolRunResponse } from '../tools/types.js';
import { compactMessagesIfOverBudget } from '../util/context-budget.js';
import { getMemoryMutationIntentDeniedMessage, isMemoryMutationToolName } from '../util/memory-intent.js';
import { isResponseDegraded } from '../util/response-quality.js';
import { withTaintedContentSystemPrompt } from '../util/tainted-content.js';

export interface LlmLoopOptions {
  /** When true, model-authored memory mutation tool calls are allowed. */
  allowModelMemoryMutation?: boolean;
  /** Optional fallback chat function for quality-based retry with an external provider. */
  fallbackChatFn?: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>;
}

// Extracted LLM loop, which can run either in-process or in an isolated worker
export async function runLlmLoop(
  messages: ChatMessage[],
  chatFn: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
  toolCaller: ToolCaller | undefined,
  maxRounds: number,
  contextBudget: number,
  onToolCalled?: (toolCall: { id: string; name: string }, result: Record<string, unknown>) => void,
  options?: LlmLoopOptions,
): Promise<{ finalContent: string; messages: ChatMessage[]; hasPendingApprovals: boolean }> {
  let finalContent = '';
  let rounds = 0;
  let hasPendingApprovals = false;
  let forcedPolicyRetryUsed = false;
  let lastToolRoundResults: Array<{ toolName: string; result: Record<string, unknown> }> = [];
  let currentContextTrustLevel: import('../tools/types.js').ContentTrustLevel = 'trusted';
  const currentTaintReasons = new Set<string>();

  const allToolDefs = toolCaller ? toolCaller.listAlwaysLoaded() : [];

  // Basic mock mapping function since we lack the full toLLMToolDef context here
  const toLLMToolDef = (def: ToolDefinition): import('../llm/types.js').ToolDefinition => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  });

  let llmToolDefs = allToolDefs.map(toLLMToolDef);

  while (rounds < maxRounds) {
    // Context window awareness: compact oldest tool results if approaching budget
    compactMessagesIfOverBudget(messages, contextBudget);

    const plannerMessages = withTaintedContentSystemPrompt(
      messages,
      currentContextTrustLevel,
      currentTaintReasons,
    );

    let response = await chatFn(plannerMessages, { tools: llmToolDefs });
    finalContent = response.content ?? '';

    if (
      !forcedPolicyRetryUsed
      && (!response.toolCalls || response.toolCalls.length === 0)
      && shouldRetryPolicyUpdateCorrection(messages, finalContent, llmToolDefs)
    ) {
      forcedPolicyRetryUsed = true;
      response = await chatFn(
        [
          ...plannerMessages,
          { role: 'assistant', content: response.content ?? '' },
          { role: 'user', content: buildPolicyUpdateCorrectionPrompt() },
        ],
        { tools: llmToolDefs },
      );
      finalContent = response.content ?? '';
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      break;
    }

    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      toolCalls: response.toolCalls,
    });

    if (!toolCaller) {
      messages.push({
        role: 'tool',
        toolCallId: response.toolCalls[0].id,
        content: JSON.stringify({ error: 'Tools are not available' }),
      });
      break;
    }

    // Execute tools concurrently
    const toolResults = await Promise.allSettled(
      response.toolCalls.map(async (tc) => {
        let parsedArgs: Record<string, unknown> = {};
        if (tc.arguments?.trim()) {
          try { parsedArgs = JSON.parse(tc.arguments); } catch { /* empty */ }
        }

        if (isMemoryMutationToolName(tc.name) && options?.allowModelMemoryMutation !== true) {
          const denied: ToolRunResponse = {
            success: false,
            status: 'denied',
            jobId: `denied:${tc.id}`,
            message: getMemoryMutationIntentDeniedMessage(tc.name),
          };
          if (onToolCalled) {
            onToolCalled(tc, denied as unknown as Record<string, unknown>);
          }
          return { toolCall: tc, result: denied };
        }

        const res = await toolCaller.callTool({
          origin: 'assistant',
          toolName: tc.name,
          args: parsedArgs,
          principalId: 'worker-session',
          principalRole: 'owner',
          contentTrustLevel: currentContextTrustLevel,
          taintReasons: [...currentTaintReasons],
          derivedFromTaintedContent: currentContextTrustLevel !== 'trusted',
          allowModelMemoryMutation: options?.allowModelMemoryMutation === true,
        });

        if (onToolCalled) {
          onToolCalled(tc, res as unknown as Record<string, unknown>);
        }

        return { toolCall: tc, result: res };
      })
    );
    lastToolRoundResults = toolResults.reduce<Array<{ toolName: string; result: Record<string, unknown> }>>((acc, settled) => {
      if (settled.status !== 'fulfilled') return acc;
      acc.push({
        toolName: settled.value.toolCall.name,
        result: settled.value.result as unknown as Record<string, unknown>,
      });
      return acc;
    }, []);

    let roundHasPending = false;
    for (const settled of toolResults) {
      if (settled.status === 'fulfilled') {
        const { toolCall, result } = settled.value;

        if (result.status === 'pending_approval') {
          roundHasPending = true;
          hasPendingApprovals = true;
        }

        const trustLevel = typeof result.trustLevel === 'string' ? result.trustLevel : 'trusted';
        if (trustLevel === 'quarantined') {
          currentContextTrustLevel = 'quarantined';
        } else if (trustLevel === 'low_trust' && currentContextTrustLevel === 'trusted') {
          currentContextTrustLevel = 'low_trust';
        }
        const taintReasons = Array.isArray(result.taintReasons)
          ? result.taintReasons.filter((value): value is string => typeof value === 'string')
          : [];
        for (const reason of taintReasons) {
          currentTaintReasons.add(reason);
        }

        let resultForLlm = result;
        if (result.status === 'pending_approval') {
           const { approvalId, jobId, ...rest } = result as any;
           resultForLlm = { ...rest, message: 'This action needs your approval.' };
        }

        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify(resultForLlm),
        });

        // Deferred tool loading simulation (simplified)
        if (toolCall.name === 'find_tools' && result.success && (result as any).output) {
           const output = (result as any).output as { tools?: ToolDefinition[] };
           if (output.tools) {
              for (const t of output.tools) {
                 if (!llmToolDefs.some(d => d.name === t.name)) {
                    allToolDefs.push(t);
                    llmToolDefs.push(toLLMToolDef(t));
                 }
              }
           }
        }
      } else {
        const failedTc = response.toolCalls[toolResults.indexOf(settled)];
        messages.push({
          role: 'tool',
          toolCallId: failedTc?.id ?? '',
          content: JSON.stringify({ success: false, error: settled.reason?.message ?? 'Tool execution failed' }),
        });
      }
    }

    // Partial approval handling: only break if EVERY tool in this round is
    // pending approval. When some tools succeeded, the LLM already sees their
    // results alongside the pending status, so it can compose a natural response
    // that acknowledges what's waiting and what it plans to do next.
    if (roundHasPending) {
      const allPending = toolResults.every(
        (s) => s.status === 'fulfilled' && (s.value as any).result?.status === 'pending_approval',
      );
      if (allPending) {
        // Remove the pending tool result messages we just pushed so we don't
        // send duplicate toolCallIds when resuming after approval.
        messages.splice(-toolResults.length, toolResults.length);
        break;
      }
      // Some tools succeeded — continue so LLM can use their results
    }

    rounds += 1;
  }

  // Quality-based fallback: if the primary LLM produced a degraded response
  // and a fallback chat function was provided, retry with it.
  if (isResponseDegraded(finalContent) && options?.fallbackChatFn) {
    try {
      const fbResponse = await options.fallbackChatFn(messages, { tools: llmToolDefs });
      if (fbResponse.content?.trim()) {
        finalContent = fbResponse.content;
      }
    } catch {
      // Fallback also failed, keep original content
    }
  }

  if (!finalContent && lastToolRoundResults.length > 0) {
    finalContent = await tryRecoverDirectAnswer(messages, chatFn, options?.fallbackChatFn);
  }

  if (!finalContent && lastToolRoundResults.length > 0) {
    finalContent = summarizeToolRoundFallback(lastToolRoundResults);
  }

  if (!finalContent) {
    finalContent = 'I could not generate a final response for that request.';
  }

  return { finalContent, messages, hasPendingApprovals };
}

async function tryRecoverDirectAnswer(
  messages: ChatMessage[],
  chatFn: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
  fallbackChatFn?: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
): Promise<string> {
  const recoveryMessages: ChatMessage[] = [
    ...messages,
    {
      role: 'user',
      content: [
        'You already completed tool calls for this request.',
        'Now answer the user directly in plain language using the tool results already in the conversation.',
        'Do not call any more tools.',
      ].join(' '),
    },
  ];

  try {
    const recovery = await chatFn(recoveryMessages, { tools: [] });
    const content = recovery.content?.trim() ?? '';
    if (content && !isResponseDegraded(content)) {
      return content;
    }
  } catch {
    // Fall through to the fallback model or synthesized summary.
  }

  if (!fallbackChatFn) return '';

  try {
    const fallback = await fallbackChatFn(recoveryMessages, { tools: [] });
    return fallback.content?.trim() ?? '';
  } catch {
    return '';
  }
}

function shouldRetryPolicyUpdateCorrection(
  messages: ChatMessage[],
  responseContent: string,
  toolDefs: import('../llm/types.js').ToolDefinition[],
): boolean {
  const lower = responseContent.trim().toLowerCase();
  if (!lower) return false;
  if (!toolDefs.some((tool) => tool.name === 'update_tool_policy')) return false;

  const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content.toLowerCase() ?? '';
  const claimsToolMissing = lower.includes('update_tool_policy') && (
    lower.includes('not available')
    || lower.includes('unavailable')
    || lower.includes('no such tool')
    || lower.includes('no equivalent tool')
    || lower.includes('search returned no results')
    || lower.includes('search returned no matches')
  );
  const pushesManualConfig = lower.includes('manually add')
    || lower.includes('manually update')
    || lower.includes('edit the configuration file')
    || lower.includes('update your guardian agent config')
    || lower.includes('you will need to manually');
  const isPolicyScoped = /(allowlist|allow list|allowed domains|alloweddomains|allowed paths|allowed commands|outside the sandbox|blocked by policy|not in the allowed|not in alloweddomains)/.test(`${latestUser}\n${lower}`);

  return isPolicyScoped && (claimsToolMissing || pushesManualConfig);
}

function buildPolicyUpdateCorrectionPrompt(): string {
  return [
    'System correction: update_tool_policy is available in your current tool list.',
    'Do not tell the user to edit config manually for allowlist changes.',
    'If the block is a filesystem path, call update_tool_policy with action "add_path".',
    'If the block is a hostname/domain, call update_tool_policy with action "add_domain" using the normalized hostname only.',
    'If the block is a command prefix, call update_tool_policy with action "add_command".',
    'Use the tool now if policy is the blocker.',
  ].join(' ');
}

function summarizeToolRoundFallback(results: Array<{ toolName: string; result: Record<string, unknown> }>): string {
  const summaries = results
    .map(({ toolName, result }) => summarizeSingleToolFallback(toolName, result))
    .filter((summary): summary is string => !!summary);
  if (summaries.length === 0) return '';
  if (summaries.length === 1) return summaries[0];
  return `Completed the requested actions:\n${summaries.map((summary) => `- ${summary}`).join('\n')}`;
}

function summarizeSingleToolFallback(toolName: string, result: Record<string, unknown>): string {
  const message = readString(result.message) || extractToolOutputMessage(result);
  if (message) return message;

  const status = readString(result.status).toLowerCase();
  if (status === 'pending_approval') return `${toolName} is awaiting approval.`;
  if (result.success === true || status === 'succeeded' || status === 'completed') return `Completed ${toolName}.`;
  return `Attempted ${toolName}, but it did not complete successfully.`;
}

function extractToolOutputMessage(result: Record<string, unknown>): string {
  const output = result.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
  return readString((output as Record<string, unknown>).message);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
