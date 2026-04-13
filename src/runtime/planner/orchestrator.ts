import type { ExecutionPlan, PlanNode } from './types.js';

export class AssistantOrchestrator {
  constructor(
    private readonly executeNode: (node: PlanNode) => Promise<unknown>
  ) {}

  async executePlan(plan: ExecutionPlan): Promise<void> {
    plan.status = 'executing';

    const nodes = Object.values(plan.nodes);
    let allCompleted = false;
    let hasFailures = false;

    // Simple DAG traversal: execute nodes with no pending dependencies
    while (!allCompleted && !hasFailures) {
      let progressMade = false;
      allCompleted = true;

      for (const node of nodes) {
        if (node.status === 'success' || node.status === 'failed') {
          continue; // Already finished
        }

        allCompleted = false;

        if (node.status === 'running') {
          continue; // Currently running (if we were async parallel, but we are simulating sequential here for simplicity)
        }

        // Check if dependencies are met
        const canRun = node.dependencies.every(depId => plan.nodes[depId]?.status === 'success');

        if (canRun) {
          node.status = 'running';
          progressMade = true;
          try {
            node.result = await this.executeNode(node);
            node.status = 'success';
          } catch (err) {
            node.status = 'failed';
            node.result = err;
            hasFailures = true;
            break; // Stop on first failure for now
          }
        }
      }

      if (!progressMade && !allCompleted && !hasFailures) {
        // Deadlock detected
        plan.status = 'failed';
        hasFailures = true;
        break;
      }
    }

    if (hasFailures) {
      plan.status = 'failed';
    } else if (allCompleted) {
      plan.status = 'completed';
    }
  }
}
