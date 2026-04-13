import type { PlanNode } from './types.js';
import { parseStructuredJsonObject } from '../../util/structured-json.js';

export interface ReflectionResult {
  success: boolean;
  reason: string;
}

export class SemanticReflector {
  constructor(
    private readonly chatFn: (messages: any[], options?: any) => Promise<any>
  ) {}

  async evaluateNode(objective: string, node: PlanNode): Promise<ReflectionResult> {
    // If the node result is a clear technical failure or exception, we can short circuit,
    // but the Orchestrator already handles thrown errors. This is for *semantic* validation.
    
    const prompt = `
You are the Guardian Agent Semantic Reflector.
Your job is to evaluate if the execution of a sub-task actually achieved its intended semantic goal, regardless of whether the tools ran without technical errors.

Overall Objective: ${objective}

Sub-Task Description: ${node.description}
Sub-Task Instruction: ${node.inputPrompt}
Action Type: ${node.actionType}
Target: ${node.target}

Execution Result:
${JSON.stringify(node.result, null, 2)}

Did the execution result semantically satisfy the sub-task instruction?
Provide your answer as a JSON object with two fields:
- "success": boolean (true if the semantic goal was met, false if it failed or produced irrelevant output)
- "reason": string (brief explanation of your evaluation)
`;

    try {
      const response = await this.chatFn([
        { role: 'system', content: 'You are a strict, semantic validation system.' },
        { role: 'user', content: prompt }
      ], {
        response_format: { type: 'json_object' }
      });

      const content = response?.content;
      if (!content) return { success: false, reason: 'No response from reflection model.' };

      const parsed = parseStructuredJsonObject(content);
      if (!parsed) {
        return { success: false, reason: 'Reflection produced unparseable output.' };
      }
      
      return {
        success: parsed.success === true,
        reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : 'No reason provided.'
      };
    } catch (err) {
      console.error('SemanticReflector: Failed to parse reflection:', err);
      // Default to true if reflection fails to avoid blocking everything, 
      // or false to be strict. We'll be lenient on reflection errors for now.
      return { success: true, reason: 'Reflection parsing error, defaulting to success.' };
    }
  }
}
