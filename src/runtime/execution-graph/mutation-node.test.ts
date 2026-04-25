import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionRequest } from '../../tools/types.js';
import { buildSearchResultSetArtifact, buildWriteSpecArtifact } from './graph-artifacts.js';
import { executeWriteSpecMutationNode, resumeWriteSpecMutationNodeAfterApproval, type MutationNodeExecutionContext } from './mutation-node.js';

describe('execution graph mutation node', () => {
  it('executes WriteSpec through supervisor ToolExecutor and verifies read-back content', async () => {
    const content = 'direct reasoning tool calls flow into RunTimelineStore\n';
    const writeSpec = buildWriteSpecArtifact({
      graphId: 'graph-1',
      nodeId: 'synthesize-1',
      artifactId: 'write-spec-1',
      path: 'tmp/manual-web/planned-steps-summary.txt',
      content,
      sourceArtifacts: [buildSearchResultArtifact()],
      redactionPolicy: 'no_secret_values',
      createdAt: 100,
    });
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_write') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-write-1',
          message: 'Wrote file.',
          output: {
            path: args.path,
            append: args.append,
            size: Buffer.byteLength(String(args.content), 'utf-8'),
          },
        };
      }
      if (toolName === 'fs_read') {
        return {
          success: true,
          status: 'succeeded',
          jobId: 'job-read-1',
          output: {
            path: args.path,
            bytes: Buffer.byteLength(content, 'utf-8'),
            truncated: false,
            content,
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });

    const result = await executeWriteSpecMutationNode({
      writeSpec,
      executeTool,
      toolRequest: baseToolRequest(),
      context: baseContext(),
    });

    expect(result.status).toBe('succeeded');
    expect(executeTool).toHaveBeenNthCalledWith(1, 'fs_write', {
      path: 'tmp/manual-web/planned-steps-summary.txt',
      content,
      append: false,
    }, baseToolRequest());
    expect(executeTool).toHaveBeenNthCalledWith(2, 'fs_read', {
      path: 'tmp/manual-web/planned-steps-summary.txt',
      maxBytes: Buffer.byteLength(content, 'utf-8') + 1024,
    }, baseToolRequest());
    expect(result.receiptArtifact?.artifactType).toBe('MutationReceipt');
    expect(result.receiptArtifact?.content).toMatchObject({
      toolName: 'fs_write',
      writeSpecArtifactId: 'write-spec-1',
      path: 'tmp/manual-web/planned-steps-summary.txt',
      success: true,
      status: 'succeeded',
      jobId: 'job-write-1',
    });
    expect(result.verificationArtifact?.content.valid).toBe(true);
    expect(result.events.map((event) => event.kind)).toEqual([
      'node_started',
      'tool_call_started',
      'tool_call_completed',
      'artifact_created',
      'tool_call_started',
      'tool_call_completed',
      'artifact_created',
      'verification_completed',
      'node_completed',
    ]);
    const payloadText = JSON.stringify(result.events.map((event) => event.payload));
    expect(payloadText).toContain('contentHash');
    expect(payloadText).not.toContain(content);
  });

  it('can emit read-back verification on a separate verify node', async () => {
    const content = 'verification node content\n';
    const writeSpec = buildWriteSpecArtifact({
      graphId: 'graph-1',
      nodeId: 'synthesize-1',
      artifactId: 'write-spec-verify-node',
      path: 'tmp/manual-web/verify-node.txt',
      content,
      sourceArtifacts: [buildSearchResultArtifact()],
      createdAt: 100,
    });
    const executeTool = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'fs_write') {
        return {
          success: true,
          status: 'succeeded',
          output: {
            path: args.path,
            size: Buffer.byteLength(String(args.content), 'utf-8'),
          },
        };
      }
      if (toolName === 'fs_read') {
        return {
          success: true,
          status: 'succeeded',
          output: {
            path: args.path,
            truncated: false,
            content,
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });

    const result = await executeWriteSpecMutationNode({
      writeSpec,
      executeTool,
      toolRequest: baseToolRequest(),
      context: {
        ...baseContext(),
        verificationNodeId: 'verify-1',
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.verificationArtifact).toMatchObject({
      nodeId: 'verify-1',
      artifactId: 'graph-1:verify-1:verification',
    });
    expect(result.events.map((event) => [event.kind, event.nodeId, event.nodeKind])).toEqual([
      ['node_started', 'mutate-1', 'mutate'],
      ['tool_call_started', 'mutate-1', 'mutate'],
      ['tool_call_completed', 'mutate-1', 'mutate'],
      ['artifact_created', 'mutate-1', 'mutate'],
      ['node_completed', 'mutate-1', 'mutate'],
      ['node_started', 'verify-1', 'verify'],
      ['tool_call_started', 'verify-1', 'verify'],
      ['tool_call_completed', 'verify-1', 'verify'],
      ['artifact_created', 'verify-1', 'verify'],
      ['verification_completed', 'verify-1', 'verify'],
      ['node_completed', 'verify-1', 'verify'],
    ]);
  });

  it('pauses on ToolExecutor approval instead of marking the mutation complete', async () => {
    const writeSpec = buildWriteSpecArtifact({
      graphId: 'graph-1',
      nodeId: 'synthesize-1',
      artifactId: 'write-spec-approval',
      path: 'tmp/manual-web/approval-graph.txt',
      content: 'graph approval ok',
      createdAt: 100,
    });
    const executeTool = vi.fn(async () => ({
      success: false,
      status: 'pending_approval',
      jobId: 'job-pending-1',
      approvalId: 'approval-1',
      message: "Tool 'fs_write' is awaiting approval.",
    }));

    const result = await executeWriteSpecMutationNode({
      writeSpec,
      executeTool,
      toolRequest: baseToolRequest(),
      context: baseContext(),
    });

    expect(result.status).toBe('awaiting_approval');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.receiptArtifact?.content).toMatchObject({
      status: 'pending_approval',
      approvalId: 'approval-1',
      success: false,
    });
    expect(result.events.map((event) => event.kind)).toContain('approval_requested');
    expect(result.events.map((event) => event.kind)).not.toContain('node_completed');
  });

  it('uses a distinct approved mutation receipt artifact when resuming after approval', async () => {
    const content = 'graph approval ok';
    const writeSpec = buildWriteSpecArtifact({
      graphId: 'graph-1',
      nodeId: 'synthesize-1',
      artifactId: 'write-spec-approval',
      path: 'tmp/manual-web/approval-graph.txt',
      content,
      createdAt: 100,
    });
    const executeTool = vi.fn(async (toolName: string) => {
      if (toolName === 'fs_read') {
        return {
          success: true,
          status: 'succeeded',
          output: {
            content,
            truncated: false,
          },
        };
      }
      throw new Error(`unexpected tool ${toolName}`);
    });

    const result = await resumeWriteSpecMutationNodeAfterApproval({
      writeSpec,
      approvedToolResult: {
        success: true,
        status: 'succeeded',
        approvalId: 'approval-1',
        output: {
          size: Buffer.byteLength(content, 'utf-8'),
        },
      },
      executeTool,
      toolRequest: baseToolRequest(),
      context: baseContext(),
      approvalId: 'approval-1',
    });

    expect(result.status).toBe('succeeded');
    expect(result.receiptArtifact?.artifactId).toBe('graph-1:mutate-1:mutation-receipt:approved:approval-1');
    expect(result.receiptArtifact?.artifactId).not.toBe('graph-1:mutate-1:mutation-receipt');
    expect(result.verificationArtifact?.content.valid).toBe(true);
  });

  it('rejects no-secret WriteSpecs before executing a tool when content contains secrets', async () => {
    const writeSpec = buildWriteSpecArtifact({
      graphId: 'graph-1',
      nodeId: 'synthesize-1',
      artifactId: 'write-spec-secret',
      path: 'tmp/manual-web/secret-scan-paths.txt',
      content: 'OPENAI_API_KEY=sk-123456789012345678901234567890',
      redactionPolicy: 'no_secret_values',
      createdAt: 100,
    });
    const executeTool = vi.fn();

    const result = await executeWriteSpecMutationNode({
      writeSpec,
      executeTool,
      toolRequest: baseToolRequest(),
      context: baseContext(),
    });

    expect(result.status).toBe('failed');
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.events.at(-1)?.kind).toBe('node_failed');
    expect(result.events.at(-1)?.payload.reason).toContain('WriteSpec rejected by redaction policy');
  });
});

function buildSearchResultArtifact() {
  return buildSearchResultSetArtifact({
    graphId: 'graph-1',
    nodeId: 'explore-1',
    artifactId: 'search-1',
    query: 'planned_steps',
    matches: [{
      relativePath: 'src/runtime/intent/types.ts',
      line: 12,
      snippet: 'plannedSteps?: IntentGatewayPlannedStep[];',
    }],
    createdAt: 90,
  });
}

function baseToolRequest(): Omit<ToolExecutionRequest, 'toolName' | 'args'> {
  return {
    origin: 'assistant',
    requestId: 'request-1',
    agentId: 'guardian',
    userId: 'user-1',
    channel: 'web',
    codeContext: {
      workspaceRoot: 'S:/Development/GuardianAgent',
      sessionId: 'code-1',
    },
  };
}

function baseContext(): MutationNodeExecutionContext {
  return {
    graphId: 'graph-1',
    executionId: 'exec-1',
    rootExecutionId: 'exec-1',
    requestId: 'request-1',
    runId: 'request-1',
    nodeId: 'mutate-1',
    channel: 'web',
    agentId: 'guardian',
    userId: 'user-1',
    codeSessionId: 'code-1',
    now: (() => {
      let timestamp = 1_000;
      return () => {
        timestamp += 10;
        return timestamp;
      };
    })(),
  };
}
