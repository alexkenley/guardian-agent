import type { ExecutionPlan, PlanNode } from './types.js';
import type { SemanticReflector } from './reflection.js';
import type { ReflectiveLearningQueue } from './learning-queue.js';
import type { RecoveryPlanner } from './recovery.js';

export class AssistantOrchestrator {
  constructor(
    private readonly executeNode: (node: PlanNode) => Promise<unknown>,
    private readonly reflector?: SemanticReflector,
    private readonly learningQueue?: ReflectiveLearningQueue,
    private readonly recoveryPlanner?: RecoveryPlanner
  ) {}

  async executePlan(plan: ExecutionPlan): Promise<void> {
    plan.status = 'executing';

    let allCompleted = false;
    let hasFailures = false;

    // Simple DAG traversal: execute nodes with no pending dependencies
    while (!allCompleted && !hasFailures) {
      let progressMade = false;
      allCompleted = true;

      const nodes = Object.values(plan.nodes);

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
          let nodeFailed = false;
          try {
            node.result = await this.executeNode(node);

            // Phase 2: Semantic Reflection
            if (this.reflector) {
              const reflection = await this.reflector.evaluateNode(plan.originalObjective, node);
              if (!reflection.success) {
                node.status = 'failed';
                node.result = { originalResult: node.result, reflectionReason: reflection.reason };
                nodeFailed = true;
              }
            }

            if (!nodeFailed) {
              node.status = 'success';
            }
          } catch (err) {
            node.status = 'failed';
            node.result = err;
            nodeFailed = true;
          }

          if (nodeFailed) {
            if (this.recoveryPlanner) {
              console.log(`AssistantOrchestrator: Node ${node.id} failed, attempting recovery...`);
              const recovery = await this.recoveryPlanner.attemptRecovery(plan.originalObjective, node, node.result);
              if (recovery.success && recovery.replacementNode) {
                console.log(`AssistantOrchestrator: Recovery successful, injecting replacement node ${recovery.replacementNode.id}`);
                // Add the replacement node
                plan.nodes[recovery.replacementNode.id] = recovery.replacementNode;
                // Update downstream dependencies to point to the new node instead of the failed one
                for (const otherNode of Object.values(plan.nodes)) {
                  if (otherNode.dependencies.includes(node.id)) {
                    otherNode.dependencies = otherNode.dependencies.map(d => d === node.id ? recovery.replacementNode!.id : d);
                  }
                }
                // Don't set hasFailures = true, let the loop continue with the new node
                nodeFailed = false;
              }
            }
          }

          if (nodeFailed) {
            hasFailures = true;
            break; // Stop on unrecoverable failure
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

    // Phase 2: Post-trajectory evaluation via Learning Queue
    if (this.learningQueue) {
      // Fire and forget, or await depending on whether we want to block response
      await this.learningQueue.evaluateTrajectory(plan).catch(err => {
        console.error('ReflectiveLearningQueue: Failed to evaluate trajectory:', err);
      });
    }
  }
}
