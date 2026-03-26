import { randomUUID } from 'node:crypto';
import { buildApprovalInterruptEvents } from './approval-interrupts.js';
import { GraphCheckpointManager } from './graph-checkpoints.js';
import type {
  GraphNodeExecutionResult,
  GraphRunCheckpoint,
  GraphRunResult,
  PlaybookGraphDefinition,
  PlaybookGraphNode,
} from './graph-types.js';
import { createRunEvent } from './run-events.js';
import { InMemoryRunStateStore, type RunStateStore } from './run-state-store.js';

export interface GraphRunnerOptions<TStepResult> {
  now?: () => number;
  runIdFactory?: () => string;
  store?: RunStateStore<TStepResult>;
}

export class GraphRunner<TStepResult> {
  private readonly now: () => number;
  private readonly runIdFactory: () => string;
  private readonly store: RunStateStore<TStepResult>;
  private readonly checkpoints: GraphCheckpointManager<TStepResult>;

  constructor(options: GraphRunnerOptions<TStepResult> = {}) {
    this.now = options.now ?? Date.now;
    this.runIdFactory = options.runIdFactory ?? randomUUID;
    this.store = options.store ?? new InMemoryRunStateStore<TStepResult>();
    this.checkpoints = new GraphCheckpointManager(this.store, this.now);
  }

  getStore(): RunStateStore<TStepResult> {
    return this.store;
  }

  async run(
    graph: PlaybookGraphDefinition,
    handlers: {
      executeStep: (node: Extract<PlaybookGraphNode, { type: 'step' }>, priorResults: TStepResult[]) => Promise<GraphNodeExecutionResult<TStepResult>>;
      executeParallel: (node: Extract<PlaybookGraphNode, { type: 'parallel' }>, priorResults: TStepResult[]) => Promise<GraphNodeExecutionResult<TStepResult>>;
    },
    options: {
      resumeContext?: Record<string, unknown>;
    } = {},
  ): Promise<GraphRunResult<TStepResult>> {
    const runId = this.runIdFactory();
    const automationName = describeAutomation(graph);
    let checkpoint = this.checkpoints.create(runId, graph.id, graph.name, options.resumeContext);
    checkpoint.events = [
      createRunEvent(runId, 'run_created', this.now(), {
        message: `Automation run created for '${automationName}'.`,
      }),
    ];
    checkpoint = this.checkpoints.update(checkpoint, {
      events: checkpoint.events,
      nextNodeId: graph.entryNodeId,
      pendingApprovalIds: [],
    });
    return this.executeFromCheckpoint(graph, checkpoint, handlers);
  }

  async resume(
    graph: PlaybookGraphDefinition,
    runId: string,
    handlers: {
      executeStep: (node: Extract<PlaybookGraphNode, { type: 'step' }>, priorResults: TStepResult[]) => Promise<GraphNodeExecutionResult<TStepResult>>;
      executeParallel: (node: Extract<PlaybookGraphNode, { type: 'parallel' }>, priorResults: TStepResult[]) => Promise<GraphNodeExecutionResult<TStepResult>>;
    },
  ): Promise<GraphRunResult<TStepResult>> {
    const checkpoint = this.store.get(runId);
    if (!checkpoint) {
      throw new Error(`Run '${runId}' was not found.`);
    }
    const resumedEvents = checkpoint.events.map((event) => ({ ...event }));
    resumedEvents.push(createRunEvent(runId, 'run_resumed', this.now(), {
      nodeId: checkpoint.currentNodeId,
      message: `Run '${runId}' resumed.`,
      metadata: {
        nextNodeId: checkpoint.nextNodeId,
      },
    }));
    const nextCheckpoint = this.checkpoints.update(checkpoint, {
      status: 'running',
      events: resumedEvents,
    });
    return this.executeFromCheckpoint(graph, nextCheckpoint, handlers);
  }

  private async executeFromCheckpoint(
    graph: PlaybookGraphDefinition,
    initialCheckpoint: GraphRunCheckpoint<TStepResult>,
    handlers: {
      executeStep: (node: Extract<PlaybookGraphNode, { type: 'step' }>, priorResults: TStepResult[]) => Promise<GraphNodeExecutionResult<TStepResult>>;
      executeParallel: (node: Extract<PlaybookGraphNode, { type: 'parallel' }>, priorResults: TStepResult[]) => Promise<GraphNodeExecutionResult<TStepResult>>;
    },
  ): Promise<GraphRunResult<TStepResult>> {
    const runId = initialCheckpoint.runId;
    const automationName = describeAutomation(graph);
    let checkpoint = initialCheckpoint;
    let nextNodeId: string | undefined = checkpoint.nextNodeId ?? graph.entryNodeId;

    while (nextNodeId) {
      const node = graph.nodes.find((candidate) => candidate.id === nextNodeId);
      if (!node) {
        checkpoint.events.push(createRunEvent(runId, 'run_failed', this.now(), {
          nodeId: nextNodeId,
          message: `Automation step '${nextNodeId}' was not found.`,
        }));
        checkpoint = this.checkpoints.update(checkpoint, {
          status: 'failed',
          events: checkpoint.events,
          nextNodeId: undefined,
        });
        return this.finish(graph, checkpoint, `Automation step '${nextNodeId}' was not found.`);
      }

      checkpoint.events.push(createRunEvent(runId, 'node_started', this.now(), {
        nodeId: node.id,
        message: `Running node '${node.id}'.`,
      }));
      checkpoint = this.checkpoints.update(checkpoint, {
        currentNodeId: node.id,
        nextNodeId: node.id,
        events: checkpoint.events,
      });

      if (node.type === 'start') {
        checkpoint.completedNodeIds.push(node.id);
        checkpoint.events.push(createRunEvent(runId, 'node_completed', this.now(), {
          nodeId: node.id,
          message: 'Start node completed.',
        }));
        checkpoint = this.checkpoints.update(checkpoint, {
          completedNodeIds: checkpoint.completedNodeIds,
          events: checkpoint.events,
          nextNodeId: node.next,
          pendingApprovalIds: [],
        });
        nextNodeId = node.next;
        continue;
      }

      if (node.type === 'end') {
        checkpoint.completedNodeIds.push(node.id);
        checkpoint.events.push(createRunEvent(runId, 'run_completed', this.now(), {
          nodeId: node.id,
          message: `Automation '${automationName}' completed.`,
        }));
        checkpoint = this.checkpoints.update(checkpoint, {
          status: 'succeeded',
          completedNodeIds: checkpoint.completedNodeIds,
          events: checkpoint.events,
          nextNodeId: undefined,
          pendingApprovalIds: [],
        });
        return this.finish(graph, checkpoint, `Automation '${automationName}' completed successfully.`);
      }

      const execution = node.type === 'parallel'
        ? await handlers.executeParallel(node, checkpoint.results)
        : await handlers.executeStep(node, checkpoint.results);

      checkpoint.results.push(...execution.results);
      checkpoint.completedNodeIds.push(node.id);
      checkpoint.events.push(createRunEvent(runId, 'node_completed', this.now(), {
        nodeId: node.id,
        message: execution.message,
        metadata: { status: execution.status },
      }));

      if (execution.status === 'pending_approval') {
        const approvalIds = execution.results
          .map((result) => extractApprovalId(result))
          .filter((value): value is string => Boolean(value));
        checkpoint.events.push(...buildApprovalInterruptEvents(runId, this.now(), {
          nodeId: node.id,
          approvalIds,
          message: execution.message,
        }));
        checkpoint = this.checkpoints.update(checkpoint, {
          status: 'awaiting_approval',
          completedNodeIds: checkpoint.completedNodeIds,
          results: checkpoint.results,
          events: checkpoint.events,
          nextNodeId: node.next,
          pendingApprovalIds: approvalIds,
        });
        return this.finish(graph, checkpoint, execution.message);
      }

      if (execution.status === 'failed' && !(node.type === 'step' && node.step.continueOnError)) {
        checkpoint.events.push(createRunEvent(runId, 'run_failed', this.now(), {
          nodeId: node.id,
          message: execution.message,
        }));
        checkpoint = this.checkpoints.update(checkpoint, {
          status: 'failed',
          completedNodeIds: checkpoint.completedNodeIds,
          results: checkpoint.results,
          events: checkpoint.events,
          nextNodeId: undefined,
          pendingApprovalIds: [],
        });
        return this.finish(graph, checkpoint, execution.message);
      }

      checkpoint = this.checkpoints.update(checkpoint, {
        completedNodeIds: checkpoint.completedNodeIds,
        results: checkpoint.results,
        events: checkpoint.events,
        nextNodeId: node.next,
        pendingApprovalIds: [],
      });
      nextNodeId = node.next;
    }

    checkpoint.events.push(createRunEvent(runId, 'run_completed', this.now(), {
      message: `Automation '${automationName}' completed.`,
    }));
    checkpoint = this.checkpoints.update(checkpoint, {
      status: 'succeeded',
      events: checkpoint.events,
      nextNodeId: undefined,
      pendingApprovalIds: [],
    });
    return this.finish(graph, checkpoint, `Automation '${automationName}' completed successfully.`);
  }

  private finish(
    graph: PlaybookGraphDefinition,
    checkpoint: ReturnType<GraphCheckpointManager<TStepResult>['update']>,
    message: string,
  ): GraphRunResult<TStepResult> {
    return {
      runId: checkpoint.runId,
      graphId: graph.id,
      graphName: graph.name,
      status: checkpoint.status,
      message,
      results: [...checkpoint.results],
      events: checkpoint.events.map((event) => ({ ...event })),
      checkpoint: {
        ...checkpoint,
        completedNodeIds: [...checkpoint.completedNodeIds],
        pendingApprovalIds: checkpoint.pendingApprovalIds ? [...checkpoint.pendingApprovalIds] : undefined,
        results: [...checkpoint.results],
        events: checkpoint.events.map((event) => ({ ...event })),
        resumeContext: checkpoint.resumeContext ? { ...checkpoint.resumeContext } : undefined,
      },
    };
  }
}

function describeAutomation(graph: PlaybookGraphDefinition): string {
  return graph.name?.trim() || graph.playbookId?.trim() || graph.id?.trim() || 'automation';
}

function extractApprovalId<TStepResult>(result: TStepResult): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  return typeof record.approvalId === 'string' && record.approvalId.trim()
    ? record.approvalId.trim()
    : null;
}
