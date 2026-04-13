import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { ExecutionPlan, PlanNode } from './types.js';
import { parseStructuredJsonObject } from '../../util/structured-json.js';

export class TaskPlanner {
  constructor(
    private readonly chatFn: (messages: any[], options?: any) => Promise<any>
  ) {}

  async plan(objective: string, intentDecision?: IntentGatewayDecision): Promise<ExecutionPlan | null> {
    const prompt = this.buildPlannerPrompt(objective, intentDecision);
    const response = await this.chatFn([
      { role: 'system', content: 'You are the Guardian Agent Meta-Planner. You receive complex objectives and break them down into a precise Directed Acyclic Graph (DAG) of actionable sub-tasks.' },
      { role: 'user', content: prompt }
    ], {
      // Expect JSON output or tools, etc. We'll simplify to JSON for the POC.
      response_format: { type: 'json_object' }
    });

    const content = response?.content;
    if (!content) return null;

    try {
      const parsed = parseStructuredJsonObject(content);
      if (!parsed) return null;
      return {
        id: `plan-${Date.now()}`,
        originalObjective: objective,
        nodes: (parsed.nodes && typeof parsed.nodes === 'object') ? (parsed.nodes as Record<string, PlanNode>) : {},
        status: 'planning',
      };
    } catch (err) {
      console.error('TaskPlanner: Failed to parse DAG plan:', err);
      return null;
    }
  }

  private buildPlannerPrompt(objective: string, intentDecision?: IntentGatewayDecision): string {
    let prompt = `Objective: ${objective}\n`;
    if (intentDecision) {
      prompt += `Context/Intent: ${JSON.stringify(intentDecision)}\n`;
    }
    prompt += `
Please provide a JSON representation of an execution DAG (ExecutionPlan.nodes) to achieve this objective.
Structure the JSON as an object containing a "nodes" key, which is a dictionary of node IDs to PlanNode objects.
PlanNode structure:
{
  id: string,
  description: string,
  dependencies: string[] // Array of node IDs that must complete first
  actionType: "tool_call" | "skill_delegation" | "routine_execution" | "execute_code" | "delegate_task",
  target: string // The specific tool name, skill ID, language runtime (for execute_code), or worker profile (for delegate_task)
  inputPrompt: string // The detailed instruction, code payload, or subagent prompt
}

Remember to delegate complex tasks (like coding) to specific skills via "skill_delegation", or spawn a subagent via "delegate_task" with specific bounds. For programmatic transformations or scripts that call managed tools, use "execute_code" instead of trying to chain dozens of tool calls.
Return ONLY valid JSON.
`;
    return prompt;
  }
}
