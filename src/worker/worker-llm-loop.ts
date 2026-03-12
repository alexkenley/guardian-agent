import type { ChatMessage, ChatResponse, ChatOptions } from '../llm/types.js';
import type { ToolCaller } from '../broker/types.js';
import type { ToolDefinition } from '../tools/types.js';

// Extracted LLM loop, which can run either in-process or in an isolated worker
export async function runLlmLoop(
  messages: ChatMessage[],
  chatFn: (msgs: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
  toolCaller: ToolCaller | undefined,
  maxRounds: number,
  _contextBudget: number,
  onToolCalled?: (toolCall: { id: string; name: string }, result: Record<string, unknown>) => void
): Promise<{ finalContent: string; messages: ChatMessage[]; hasPendingApprovals: boolean }> {
  let finalContent = '';
  let rounds = 0;
  let hasPendingApprovals = false;

  const allToolDefs = toolCaller ? toolCaller.listAlwaysLoaded() : [];
  
  // Basic mock mapping function since we lack the full toLLMToolDef context here
  const toLLMToolDef = (def: ToolDefinition): import('../llm/types.js').ToolDefinition => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  });

  let llmToolDefs = allToolDefs.map(toLLMToolDef);

  while (rounds < maxRounds) {
    const response = await chatFn(messages, { tools: llmToolDefs });
    finalContent = response.content ?? '';

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
        
        const res = await toolCaller.callTool({
          origin: 'assistant',
          toolName: tc.name,
          args: parsedArgs,
        });

        if (onToolCalled) {
          onToolCalled(tc, res as any);
        }

        return { toolCall: tc, result: res };
      })
    );

    let roundHasPending = false;
    for (const settled of toolResults) {
      if (settled.status === 'fulfilled') {
        const { toolCall, result } = settled.value;

        if (result.status === 'pending_approval') {
          roundHasPending = true;
          hasPendingApprovals = true;
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
        if (toolCall.name === 'find_tools' && result.success && result.output) {
           const output = result.output as { tools?: ToolDefinition[] };
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

    if (roundHasPending) {
       // Stop the loop if there are pending approvals, yielding control back to user
       break;
    }

    rounds += 1;
  }

  return { finalContent, messages, hasPendingApprovals };
}
