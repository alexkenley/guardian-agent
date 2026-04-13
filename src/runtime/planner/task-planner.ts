import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { ExecutionPlan } from './types.js';

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
      const parsed = JSON.parse(content);
      return {
        id: `plan-${Date.now()}`,
        originalObjective: objective,
        nodes: parsed.nodes ?? {},
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
  actionType: "tool_call" | "skill_delegation" | "routine_execution",
  target: string // The specific tool name or skill ID
  inputPrompt: string // The detailed instruction for this node
}

Remember to delegate complex tasks (like coding) to specific skills rather than trying to micromanage the execution.
Return ONLY valid JSON.
`;
    return prompt;
  }
}
