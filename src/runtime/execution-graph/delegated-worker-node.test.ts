import { describe, expect, it } from 'vitest';
import {
  buildDelegatedWorkerGraphCompletion,
  buildDelegatedWorkerGraphContext,
  buildDelegatedWorkerGraphFailure,
  buildDelegatedWorkerGraphInput,
  buildDelegatedWorkerRunningMetadata,
  buildDelegatedWorkerStartProjection,
  buildDelegatedWorkerTerminalProjection,
  buildDelegatedTaskContractTraceMetadata,
  normalizeDelegatedGraphBlockerKind,
  startDelegatedWorkerGraphRun,
} from './delegated-worker-node.js';
import type { VerificationDecision } from '../execution/types.js';
import type { ExecutionGraphEvent } from './graph-events.js';
import { buildDelegatedTaskContract } from '../execution/verifier.js';

describe('delegated worker graph node helpers', () => {
  it('builds delegated worker start projection events', () => {
    const context = buildDelegatedWorkerGraphContext({
      graphId: 'execution-graph:delegated-task:start:delegated-worker',
      executionId: 'delegated-task:start',
      rootExecutionId: 'root-start',
      requestId: 'request-start',
      runId: 'request-start',
      channel: 'web',
      title: 'Workspace Implementer',
    });

    const projection = buildDelegatedWorkerStartProjection({
      context,
      sequenceStart: 0,
      timestamp: 1_000,
      summary: 'Delegated to Workspace Implementer.',
      decision: {
        route: 'coding_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect repository.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        entities: {},
      },
      payload: {
        taskContractKind: 'repo_inspection',
      },
    });

    expect(projection.events.map((event) => [event.sequence, event.kind, event.nodeKind])).toEqual([
      [1, 'graph_started', undefined],
      [2, 'node_started', 'delegated_worker'],
    ]);
    expect(projection.events[0]?.payload).toMatchObject({
      route: 'coding_task',
      operation: 'inspect',
      executionClass: 'repo_grounded',
      controller: 'delegated_worker',
      taskContractKind: 'repo_inspection',
    });
    expect(projection.events[1]?.payload).toMatchObject({
      lifecycle: 'running',
      summary: 'Delegated to Workspace Implementer.',
      taskContractKind: 'repo_inspection',
    });
    expect(projection.sequence).toBe(2);
  });

  it('builds delegated worker graph input outside WorkerManager ownership', () => {
    const context = buildDelegatedWorkerGraphContext({
      graphId: 'execution-graph:delegated-task:graph-input:delegated-worker',
      executionId: 'delegated-task:graph-input',
      rootExecutionId: 'root-graph-input',
      parentExecutionId: 'parent-graph-input',
      requestId: 'request-graph-input',
      runId: 'request-graph-input',
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
      codeSessionId: 'code-session-1',
      title: 'Workspace Implementer',
    });

    const graphInput = buildDelegatedWorkerGraphInput({
      context,
      intent: {
        route: 'coding_task',
        confidence: 'high',
        operation: 'modify',
        summary: 'Modify repository.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        entities: {},
      },
      securityContext: {
        agentId: 'agent-1',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'surface-1',
        codeSessionId: 'code-session-1',
      },
      trigger: {
        type: 'user_request',
        source: 'web',
        sourceId: 'message-1',
      },
      ownerAgentId: 'agent-1',
      executionProfileName: 'managed-cloud',
    });

    expect(graphInput).toMatchObject({
      graphId: context.graphId,
      executionId: context.executionId,
      rootExecutionId: context.rootExecutionId,
      parentExecutionId: context.parentExecutionId,
      requestId: context.requestId,
      runId: context.runId,
      securityContext: {
        agentId: 'agent-1',
        userId: 'user-1',
        channel: 'web',
        surfaceId: 'surface-1',
        codeSessionId: 'code-session-1',
      },
      trigger: {
        type: 'user_request',
        source: 'web',
        sourceId: 'message-1',
      },
      nodes: [{
        nodeId: context.nodeId,
        graphId: context.graphId,
        kind: 'delegated_worker',
        ownerAgentId: 'agent-1',
        executionProfileName: 'managed-cloud',
      }],
      edges: [],
    });
  });

  it('builds delegated task-contract trace metadata outside WorkerManager ownership', () => {
    const taskContract = buildDelegatedTaskContract({
      route: 'coding_task',
      confidence: 'high',
      operation: 'inspect',
      summary: 'Inspect repository.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      requireExactFileReferences: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'chat_synthesis',
      entities: {},
    });

    expect(buildDelegatedTaskContractTraceMetadata(taskContract)).toMatchObject({
      taskContractKind: 'repo_inspection',
      taskContractRoute: 'coding_task',
      taskContractOperation: 'inspect',
      taskContractRequiresEvidence: true,
      taskContractRequireExactFileReferences: true,
      taskContractPlanId: taskContract.plan.planId,
      taskContractPlanStepCount: taskContract.plan.steps.length,
      taskContractPlanRequiredStepCount: taskContract.plan.steps.filter((step) => step.required).length,
      taskContractPlanStepIds: taskContract.plan.steps.map((step) => step.stepId),
      taskContractPlanStepKinds: taskContract.plan.steps.map((step) => step.kind),
    });
  });

  it('starts a delegated worker graph run through graph-owned start assembly', () => {
    const createdGraphs: unknown[] = [];
    const appendedEvents: ExecutionGraphEvent[] = [];
    const timelineEvents: ExecutionGraphEvent[] = [];

    const run = startDelegatedWorkerGraphRun({
      graphStore: {
        createGraph: (input) => createdGraphs.push(input),
        appendEvent: (event) => appendedEvents.push(event),
      },
      runTimeline: {
        ingestExecutionGraphEvent: (event) => timelineEvents.push(event),
      },
      context: {
        graphId: 'execution-graph:delegated-task:start-run:delegated-worker',
        executionId: 'delegated-task:start-run',
        rootExecutionId: 'root-start-run',
        requestId: 'request-start-run',
        runId: 'request-start-run',
        channel: 'web',
        agentId: 'agent-1',
        userId: 'user-1',
        title: 'Workspace Implementer',
      },
      intent: {
        route: 'coding_task',
        confidence: 'high',
        operation: 'inspect',
        summary: 'Inspect repository.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'repo_grounded',
        entities: {},
      },
      securityContext: {
        agentId: 'agent-1',
        userId: 'user-1',
        channel: 'web',
      },
      ownerAgentId: 'agent-1',
      executionProfileName: 'managed-cloud',
      summary: 'Delegated to Workspace Implementer.',
      payload: {
        taskContractKind: 'repo_inspection',
      },
      timestamp: 3_456,
    });

    expect(run.sequence).toBe(2);
    expect(run.context.graphId).toBe('execution-graph:delegated-task:start-run:delegated-worker');
    expect(createdGraphs).toHaveLength(1);
    expect(appendedEvents).toHaveLength(2);
    expect(timelineEvents).toEqual(appendedEvents);
    expect(appendedEvents.map((event) => [
      event.kind,
      event.nodeKind,
      event.payload.controller,
      event.payload.taskContractKind,
    ])).toEqual([
      ['graph_started', undefined, 'delegated_worker', 'repo_inspection'],
      ['node_started', 'delegated_worker', undefined, 'repo_inspection'],
    ]);
  });

  it('builds completed terminal verification projection events', () => {
    const context = buildDelegatedWorkerGraphContext({
      graphId: 'execution-graph:delegated-task:1:delegated-worker',
      executionId: 'delegated-task:1',
      rootExecutionId: 'root-1',
      requestId: 'request-1',
      runId: 'request-1',
      channel: 'web',
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'Workspace Implementer',
    });
    const verification: VerificationDecision = {
      decision: 'satisfied',
      reasons: ['Delegated worker satisfied every required planned step.'],
      retryable: false,
    };

    const projection = buildDelegatedWorkerTerminalProjection({
      context,
      sequenceStart: 2,
      timestamp: 1_234,
      lifecycle: 'completed',
      verification,
      payload: {
        lifecycle: 'completed',
        summary: 'Completed.',
      },
    });

    expect(projection.verificationArtifact.content).toMatchObject({
      subjectArtifactId: 'delegated-result:delegated-task:1',
      valid: true,
    });
    expect(projection.events.map((event) => [event.sequence, event.kind, event.nodeKind])).toEqual([
      [3, 'artifact_created', 'delegated_worker'],
      [4, 'verification_completed', 'delegated_worker'],
      [5, 'node_completed', 'delegated_worker'],
      [6, 'graph_completed', undefined],
    ]);
    expect(projection.events[1]?.payload).toMatchObject({
      decision: 'satisfied',
      valid: true,
      failedChecks: [],
    });
    expect(projection.sequence).toBe(6);
  });

  it('maps blocked policy decisions to graph interruptions with verification artifacts', () => {
    const context = buildDelegatedWorkerGraphContext({
      graphId: 'execution-graph:delegated-task:2:delegated-worker',
      executionId: 'delegated-task:2',
      rootExecutionId: 'root-2',
      requestId: 'request-2',
      title: 'Workspace Implementer',
    });
    const verification: VerificationDecision = {
      decision: 'policy_blocked',
      reasons: ['Tool policy blocked the worker.'],
      retryable: false,
      requiredNextAction: 'Resolve the policy blocker.',
      missingEvidenceKinds: ['policy_clearance'],
      unsatisfiedStepIds: ['step_2'],
    };

    const projection = buildDelegatedWorkerTerminalProjection({
      context,
      sequenceStart: 4,
      timestamp: 2_345,
      lifecycle: 'blocked',
      verification,
      payload: {
        lifecycle: 'blocked',
        summary: 'Policy blocked.',
      },
      blockerKind: 'policy_blocked',
      blockerPrompt: 'Resolve the policy blocker.',
    });

    expect(projection.verificationArtifact.content.valid).toBe(false);
    expect(projection.verificationArtifact.content.checks.map((check) => [check.name, check.status])).toEqual([
      ['delegated_worker_sufficiency', 'failed'],
      ['unsatisfied_required_steps', 'failed'],
      ['missing_required_evidence', 'failed'],
    ]);
    expect(projection.events.map((event) => event.kind)).toEqual([
      'artifact_created',
      'verification_completed',
      'interruption_requested',
    ]);
    expect(projection.events[2]?.payload).toMatchObject({
      kind: 'policy',
      prompt: 'Resolve the policy blocker.',
      verificationArtifactId: projection.verificationArtifact.artifactId,
    });
  });

  it('builds terminal graph completion metadata from the delegated node runner', () => {
    const run = {
      context: buildDelegatedWorkerGraphContext({
        graphId: 'execution-graph:delegated-task:completion:delegated-worker',
        executionId: 'delegated-task:completion',
        rootExecutionId: 'root-completion',
        requestId: 'request-completion',
        title: 'Workspace Implementer',
      }),
      sequence: 2,
    };
    const verification: VerificationDecision = {
      decision: 'blocked',
      reasons: ['Approval is required.'],
      retryable: false,
      requiredNextAction: 'Approve the file write.',
    };

    expect(buildDelegatedWorkerRunningMetadata(run)).toMatchObject({
      graphId: run.context.graphId,
      nodeId: run.context.nodeId,
      status: 'running',
      lifecycle: 'running',
    });

    const completion = buildDelegatedWorkerGraphCompletion({
      run,
      timestamp: 3_456,
      lifecycle: 'blocked',
      verification,
      payload: {
        lifecycle: 'blocked',
        summary: 'Approval is required.',
      },
      blockerKind: 'approval',
      blockerPrompt: 'Approve the file write.',
    });

    expect(completion.metadata).toMatchObject({
      graphId: run.context.graphId,
      nodeId: run.context.nodeId,
      status: 'awaiting_approval',
      lifecycle: 'blocked',
      verificationArtifactId: completion.verificationArtifact.artifactId,
    });
    expect(completion.verificationArtifactRef).toMatchObject({
      artifactId: completion.verificationArtifact.artifactId,
      artifactType: 'VerificationResult',
    });
    expect(completion.interruptEvent).toMatchObject({
      kind: 'interruption_requested',
      payload: {
        kind: 'approval',
        prompt: 'Approve the file write.',
      },
    });
    expect(completion.events.map((event) => [event.sequence, event.kind])).toEqual([
      [3, 'artifact_created'],
      [4, 'verification_completed'],
      [5, 'interruption_requested'],
    ]);
    expect(run.sequence).toBe(5);
  });

  it('builds graph failure events without WorkerManager terminal event ownership', () => {
    const run = {
      context: buildDelegatedWorkerGraphContext({
        graphId: 'execution-graph:delegated-task:failure:delegated-worker',
        executionId: 'delegated-task:failure',
        rootExecutionId: 'root-failure',
        requestId: 'request-failure',
        title: 'Workspace Implementer',
      }),
      sequence: 4,
    };

    const failure = buildDelegatedWorkerGraphFailure({
      run,
      timestamp: 4_567,
      payload: {
        lifecycle: 'failed',
        reason: 'Worker crashed.',
      },
    });

    expect(failure.metadata).toMatchObject({
      graphId: run.context.graphId,
      nodeId: run.context.nodeId,
      status: 'failed',
      lifecycle: 'failed',
    });
    expect(failure.events.map((event) => [event.sequence, event.kind, event.nodeKind])).toEqual([
      [5, 'node_failed', 'delegated_worker'],
      [6, 'graph_failed', undefined],
    ]);
    expect(run.sequence).toBe(6);
  });

  it('normalizes unknown graph blocker kinds to missing context', () => {
    expect(normalizeDelegatedGraphBlockerKind('policy_blocked')).toBe('policy');
    expect(normalizeDelegatedGraphBlockerKind('unexpected')).toBe('missing_context');
  });
});
