export interface PlanNode {
  id: string;
  description: string;
  dependencies: string[]; // IDs of nodes that must complete first
  actionType: 'tool_call' | 'skill_delegation' | 'routine_execution' | 'execute_code' | 'delegate_task';
  target: string; // Tool name, skill ID, or routine ID
  inputPrompt: string; // The specific instruction for this node
  status: 'pending' | 'running' | 'success' | 'failed';
  result?: unknown;
  compactedResult?: string; // Phase 4: Dense insight summary of the raw result
}

export interface ExecutionPlan {
  id: string;
  originalObjective: string;
  nodes: Record<string, PlanNode>;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}