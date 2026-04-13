import type { PlanNode } from './types.js';
import { parseStructuredJsonObject } from '../../util/structured-json.js';

export interface RecoveryPlan {
  success: boolean;
  reason?: string;
  replacementNode?: PlanNode;
}

export class RecoveryPlanner {
  constructor(
    private readonly chatFn: (messages: any[], options?: any) => Promise<any>
  ) {}

  async attemptRecovery(
    objective: string,
    failedNode: PlanNode,
    errorOrReflectionReason: unknown
  ): Promise<RecoveryPlan> {
    const prompt = `
You are the Guardian Agent Recovery Planner.
A sub-task within a complex Execution Plan has failed either technically or semantically.
Your job is to generate a fallback sub-task to replace the failed one, or dynamically draft a sandbox script to unblock the execution.

Overall Objective: ${objective}

Failed Node:
${JSON.stringify(failedNode, null, 2)}

Failure Reason / Result:
${JSON.stringify(errorOrReflectionReason, null, 2)}

If the failure requires parsing a proprietary format or calling an undocumented API, pivot to "Dynamic Skill Creation" by providing a new node with actionType "execute_code" that contains the script needed to solve the problem.

Provide your answer as a JSON object with:
- "success": boolean (true if you have a recovery plan, false if it's unrecoverable)
- "reason": string (explanation of your recovery approach)
- "replacementNode": an optional PlanNode object containing the new fallback action. Ensure it has a unique ID (e.g., "recovered-<original_id>") and lists the same dependencies as the failed node.

PlanNode structure:
{
  "id": "string",
  "description": "string",
  "dependencies": ["string"],
  "actionType": "tool_call" | "skill_delegation" | "routine_execution" | "execute_code" | "delegate_task",
  "target": "string",
  "inputPrompt": "string"
}
`;

    try {
      const response = await this.chatFn([
        { role: 'system', content: 'You are the Guardian Agent Recovery Planner. You recover failed DAG nodes with logical pivots or dynamic sandbox skills.' },
        { role: 'user', content: prompt }
      ], {
        response_format: { type: 'json_object' }
      });

      const content = response?.content;
      if (!content) return { success: false, reason: 'No response from recovery model.' };

      const parsed = parseStructuredJsonObject(content);
      if (!parsed) {
        return { success: false, reason: 'Failed to parse recovery response.' };
      }
      
      if (parsed.success === true && parsed.replacementNode && typeof parsed.replacementNode === 'object') {
        const replacementNode = parsed.replacementNode as PlanNode;
        // Ensure status is pending
        replacementNode.status = 'pending';
        return {
          success: true,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'Recovery plan generated.',
          replacementNode
        };
      }
      return { success: false, reason: typeof parsed.reason === 'string' ? parsed.reason : 'Failed to generate a valid replacement node.' };
    } catch (err) {
      console.error('RecoveryPlanner: Failed to parse recovery plan:', err);
      return { success: false, reason: 'Recovery parsing error.' };
    }
  }
}
