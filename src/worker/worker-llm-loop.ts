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
  let forcedPolicyRetryUsed = false;

  const allToolDefs = toolCaller ? toolCaller.listAlwaysLoaded() : [];
  
  // Basic mock mapping function since we lack the full toLLMToolDef context here
  const toLLMToolDef = (def: ToolDefinition): import('../llm/types.js').ToolDefinition => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  });

  let llmToolDefs = allToolDefs.map(toLLMToolDef);

  while (rounds < maxRounds) {
    let response = await chatFn(messages, { tools: llmToolDefs });
    finalContent = response.content ?? '';

    if (
      !forcedPolicyRetryUsed
      && (!response.toolCalls || response.toolCalls.length === 0)
      && shouldRetryPolicyUpdateCorrection(messages, finalContent, llmToolDefs)
    ) {
      forcedPolicyRetryUsed = true;
      response = await chatFn(
        [
          ...messages,
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

  if (!finalContent) {
    finalContent = 'I could not generate a final response for that request.';
  }

  return { finalContent, messages, hasPendingApprovals };
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
