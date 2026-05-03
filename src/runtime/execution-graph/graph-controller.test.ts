import { describe, expect, it } from 'vitest';

import type { SelectedExecutionProfile } from '../execution-profiles.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { DelegatedTaskContract } from '../execution/types.js';
import {
  buildFileReadSetArtifact,
  buildWriteSpecArtifact,
  type ExecutionArtifact,
} from './graph-artifacts.js';
import {
  buildGraphControlledFailureResponse,
  buildGraphControlledTaskRunId,
  buildGraphReadOnlyIntentGatewayRecord,
  createGraphControlledRun,
  runGraphControlledExecution,
  shouldUseGraphControlledExecution,
} from './graph-controller.js';
import type { ExecutionGraphEvent } from './graph-events.js';
import { ExecutionGraphStore } from './graph-store.js';

function baseDecision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'update',
    summary: 'Update the repo with grounded evidence.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'high',
    preferredAnswerPath: 'tool_loop',
    entities: {},
    ...overrides,
  };
}

function taskContract(steps: DelegatedTaskContract['plan']['steps']): DelegatedTaskContract {
  return {
    kind: 'filesystem_mutation',
    route: 'coding_task',
    operation: 'update',
    requiresEvidence: true,
    allowsAnswerFirst: false,
    requireExactFileReferences: true,
    summary: 'Ground then write.',
    plan: {
      planId: 'plan-graph',
      steps,
      allowAdditionalSteps: false,
    },
  };
}

const localProfile: SelectedExecutionProfile = {
  id: 'local_tool',
  providerName: 'local',
  providerType: 'ollama',
  providerLocality: 'local',
  providerTier: 'local',
  requestedTier: 'local',
  preferredAnswerPath: 'tool_loop',
  expectedContextPressure: 'medium',
  contextBudget: 64_000,
  toolContextMode: 'standard',
  maxAdditionalSections: 8,
  maxRuntimeNotices: 4,
  fallbackProviderOrder: [],
  reason: 'test profile',
};

describe('graph-controller boundary', () => {
  it('selects graph control only for concrete read/write mutation contracts', () => {
    const contract = taskContract([
      {
        stepId: 'read-1',
        kind: 'search',
        summary: 'Find the implementation file.',
        expectedToolCategories: ['filesystem.read'],
        required: true,
      },
      {
        stepId: 'write-1',
        kind: 'write',
        summary: 'Patch the implementation file.',
        expectedToolCategories: ['filesystem.write'],
        required: true,
      },
    ]);

    expect(shouldUseGraphControlledExecution({
      taskContract: contract,
      decision: baseDecision(),
      executionProfile: localProfile,
    })).toBe(true);

    expect(shouldUseGraphControlledExecution({
      taskContract: taskContract([contract.plan.steps[0]]),
      decision: baseDecision(),
      executionProfile: localProfile,
    })).toBe(false);

    expect(shouldUseGraphControlledExecution({
      taskContract: contract,
      decision: baseDecision({ confidence: 'low' }),
      executionProfile: localProfile,
    })).toBe(false);
  });

  it('leaves multi-write mutation plans on the delegated worker path', () => {
    const multiWriteContract = taskContract([
      {
        stepId: 'read-1',
        kind: 'read',
        summary: 'Read the source files.',
        expectedToolCategories: ['filesystem.read'],
        required: true,
      },
      {
        stepId: 'write-1',
        kind: 'write',
        summary: 'Write the first output file.',
        expectedToolCategories: ['filesystem.write'],
        required: true,
      },
      {
        stepId: 'write-2',
        kind: 'write',
        summary: 'Write the second output file.',
        expectedToolCategories: ['filesystem.write'],
        required: true,
      },
    ]);

    expect(shouldUseGraphControlledExecution({
      taskContract: multiWriteContract,
      decision: baseDecision(),
      executionProfile: localProfile,
    })).toBe(false);

    expect(shouldUseGraphControlledExecution({
      taskContract: taskContract([
        multiWriteContract.plan.steps[0],
        multiWriteContract.plan.steps[1],
      ]),
      decision: baseDecision({
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Read the source files.',
            required: true,
          },
          {
            kind: 'write',
            summary: 'Write the first output file.',
            required: true,
          },
          {
            kind: 'write',
            summary: 'Write the second output file.',
            required: true,
          },
        ],
      }),
      executionProfile: localProfile,
    })).toBe(false);
  });

  it('leaves inspect/read operations with incidental writes on the delegated worker path', () => {
    const mixedInspectContract = taskContract([
      {
        stepId: 'read-1',
        kind: 'read',
        summary: 'Read the requested source files.',
        expectedToolCategories: ['filesystem.read'],
        required: true,
      },
      {
        stepId: 'write-1',
        kind: 'write',
        summary: 'Write the requested evidence artifacts.',
        expectedToolCategories: ['filesystem.write'],
        required: true,
      },
    ]);

    expect(shouldUseGraphControlledExecution({
      taskContract: mixedInspectContract,
      decision: baseDecision({
        operation: 'inspect',
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Read the requested source files.',
            required: true,
          },
          {
            kind: 'write',
            summary: 'Write the requested evidence artifacts.',
            required: true,
          },
        ],
      }),
      executionProfile: localProfile,
    })).toBe(false);
  });

  it('requires an explicit filesystem mutation contract before graph control', () => {
    const repoInspectionContract: DelegatedTaskContract = {
      ...taskContract([
        {
          stepId: 'read-1',
          kind: 'read',
          summary: 'Read the requested source files.',
          expectedToolCategories: ['filesystem.read'],
          required: true,
        },
        {
          stepId: 'write-1',
          kind: 'write',
          summary: 'Write the requested evidence artifacts.',
          expectedToolCategories: ['filesystem.write'],
          required: true,
        },
      ]),
      kind: 'repo_inspection',
      operation: 'update',
    };

    expect(shouldUseGraphControlledExecution({
      taskContract: repoInspectionContract,
      decision: baseDecision({ operation: 'update' }),
      executionProfile: localProfile,
    })).toBe(false);
  });

  it('derives a read-only gateway decision for the exploration node', () => {
    const contract = taskContract([
      {
        stepId: 'read-1',
        kind: 'read',
        summary: 'Read the target file.',
        required: true,
      },
      {
        stepId: 'write-1',
        kind: 'write',
        summary: 'Update the target file.',
        required: true,
      },
    ]);

    const record = buildGraphReadOnlyIntentGatewayRecord({
      baseRecord: null,
      baseDecision: baseDecision(),
      taskContract: contract,
      originalRequest: 'Update the target file after reading it.',
    });

    expect(record?.model).toBe('execution-graph.readonly');
    expect(record?.decision.operation).toBe('inspect');
    expect(record?.decision.preferredAnswerPath).toBe('tool_loop');
    expect(record?.decision.plannedSteps).toEqual([
      expect.objectContaining({ kind: 'read', summary: 'Read the target file.' }),
    ]);
    expect(record?.decision.resolvedContent).toContain('Do not create, edit, delete, rename, patch, or run shell commands.');
    expect(record?.decision.resolvedContent).toContain('The graph controller will decide and perform these write steps after grounded synthesis:');
    expect(record?.decision.provenance?.operation).toBe('derived.workload');
  });

  it('keeps graph-controlled task run ids deterministic for request ids', () => {
    expect(buildGraphControlledTaskRunId('request-1')).toBe('graph-run:request-1');
  });

  it('builds graph-controlled failure responses with execution metadata', () => {
    expect(buildGraphControlledFailureResponse({
      executionProfile: localProfile,
      reason: 'Read node did not produce evidence.',
      graphId: 'graph-1',
    })).toEqual({
      content: 'Execution graph could not complete the request: Read node did not produce evidence.',
      metadata: {
        executionProfile: localProfile,
        executionGraph: {
          graphId: 'graph-1',
          status: 'failed',
          reason: 'Read node did not produce evidence.',
        },
      },
    });
  });

  it('creates the graph shell and owns graph event/artifact projection', () => {
    const graphStore = new ExecutionGraphStore({ now: () => 1000 });
    const timelineEvents: ExecutionGraphEvent[] = [];
    const run = createGraphControlledRun({
      graphStore,
      runTimeline: {
        ingestExecutionGraphEvent: (event) => {
          timelineEvents.push(event);
        },
      },
      now: () => 2000,
      taskRunId: 'graph-run-request-1',
      requestId: 'request-1',
      gatewayDecision: baseDecision(),
      agentId: 'chat',
      userId: 'owner',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      triggerSourceId: 'message-1',
      codeSessionId: 'code-session-1',
    });

    expect(run.graphId).toBe('graph:graph-run-request-1');
    expect(run.nodeIds).toEqual({
      readNodeId: 'node:graph-run-request-1:explore',
      synthesisNodeId: 'node:graph-run-request-1:synthesize',
      mutationNodeId: 'node:graph-run-request-1:mutate',
      verificationNodeId: 'node:graph-run-request-1:verify',
    });

    run.emitGraphEvent('graph_started', { controller: 'execution_graph' }, 'graph:started');
    const artifact: ExecutionArtifact = buildWriteSpecArtifact({
      graphId: run.graphId,
      nodeId: run.nodeIds.synthesisNodeId,
      artifactId: 'write-spec-1',
      path: 'tmp/example.txt',
      content: 'hello',
      append: false,
      createdAt: 2000,
    });
    run.emitArtifact(artifact, run.nodeIds.synthesisNodeId, 'synthesize');

    const snapshot = graphStore.getSnapshot(run.graphId);
    expect(snapshot?.graph.nodes.map((node) => node.kind)).toEqual([
      'explore_readonly',
      'synthesize',
      'mutate',
      'verify',
    ]);
    expect(snapshot?.events.map((event) => [event.sequence, event.kind, event.nodeId])).toEqual([
      [1, 'graph_started', undefined],
      [2, 'artifact_created', run.nodeIds.synthesisNodeId],
    ]);
    expect(timelineEvents.map((event) => event.eventId)).toEqual(snapshot?.events.map((event) => event.eventId));
    expect(graphStore.getArtifact(run.graphId, 'write-spec-1')?.artifactType).toBe('WriteSpec');
  });

  it('runs graph-controlled read/synthesize/mutate/verify through supervisor callbacks', async () => {
    const graphStore = new ExecutionGraphStore({ now: () => 1000 });
    const timelineEvents: ExecutionGraphEvent[] = [];
    const dispatchModes: string[] = [];
    const result = await runGraphControlledExecution({
      runtime: { getConfigSnapshot: () => ({}) } as never,
      request: {
        sessionId: 'session-1',
        agentId: 'guardian',
        userId: 'owner',
        grantedCapabilities: [],
        message: {
          id: 'message-1',
          userId: 'owner',
          channel: 'web',
          content: 'Read the file and write the summary.',
          timestamp: 100,
        },
        systemPrompt: 'system',
        history: [],
        executionProfile: {
          ...localProfile,
          id: 'managed-cloud-coding',
          providerTier: 'managed_cloud',
          providerName: 'ollama-cloud-coding',
          providerType: 'ollama_cloud',
          providerLocality: 'external',
          requestedTier: 'external',
        },
      },
      target: { agentId: 'guardian' },
      taskContract: taskContract([
        {
          stepId: 'read-1',
          kind: 'read',
          summary: 'Read the source file.',
          required: true,
        },
        {
          stepId: 'write-1',
          kind: 'write',
          summary: 'Write the summary.',
          required: true,
        },
      ]),
      preRoutedGateway: null,
      effectiveIntentDecision: baseDecision(),
      requestId: 'request-runner',
      taskRunId: 'graph-run-request-runner',
      graphStore,
      runTimeline: {
        ingestExecutionGraphEvent: (event) => {
          timelineEvents.push(event);
        },
      },
      now: () => 2000,
      supervisor: {
        getWorker: async () => ({ id: 'worker-1' }),
        hasFallbackProvider: () => false,
        buildCodeSessionRegistrySection: () => null,
        dispatchToWorker: async (_worker, params) => {
          if (params.directReasoningGraphContext) {
            dispatchModes.push('read');
            return {
              content: 'Read src/example.ts.',
              metadata: {
                executionGraphArtifacts: [
                  buildFileReadSetArtifact({
                    graphId: params.directReasoningGraphContext.graphId,
                    nodeId: params.directReasoningGraphContext.nodeId,
                    artifactId: 'file-read-1',
                    path: 'src/example.ts',
                    content: 'export const value = 1;\n',
                    createdAt: 2000,
                  }),
                ],
              },
            };
          }
          dispatchModes.push('synthesize');
          expect(params.groundedSynthesis?.responseFormat?.type).toBe('json_schema');
          return {
            content: JSON.stringify({
              path: 'tmp/graph-controller-runner.txt',
              content: 'graph controller ok',
              append: false,
            }),
          };
        },
        executeTool: async (toolName) => {
          if (toolName === 'fs_write') {
            return { success: true, status: 'succeeded', size: 'graph controller ok'.length };
          }
          if (toolName === 'fs_read') {
            return {
              success: true,
              status: 'succeeded',
              output: { content: 'graph controller ok', truncated: false },
            };
          }
          return { success: false, status: 'failed', error: `Unexpected tool ${toolName}` };
        },
      },
    });

    expect(result?.content).toBe('Wrote tmp/graph-controller-runner.txt and verified the contents.');
    expect(result?.metadata?.executionGraph).toMatchObject({
      graphId: 'graph:graph-run-request-runner',
      status: 'succeeded',
      writeSpecArtifactId: 'graph:graph-run-request-runner:node:graph-run-request-runner:synthesize:write-spec',
    });
    expect(dispatchModes).toEqual(['read', 'synthesize']);
    expect(graphStore.getArtifact('graph:graph-run-request-runner', 'file-read-1')?.artifactType).toBe('FileReadSet');
    expect(timelineEvents.map((event) => event.kind)).toContain('graph_completed');
  });
});
