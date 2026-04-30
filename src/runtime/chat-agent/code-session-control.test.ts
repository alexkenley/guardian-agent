import { describe, expect, it, vi } from 'vitest';

import { tryDirectCodeSessionControlFromGateway } from './code-session-control.js';
import type { AgentContext, UserMessage } from '../../agent/types.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';

function createMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'msg-1',
    userId: 'owner',
    channel: 'web',
    surfaceId: 'web-guardian-chat',
    content: 'What managed sandboxes are attached to this coding session?',
    timestamp: 1,
    ...overrides,
  };
}

function createCtx(): AgentContext {
  return {
    agentId: 'chat',
    emit: vi.fn(async () => undefined),
    checkAction: vi.fn(),
    capabilities: [],
  };
}

function createDecision(overrides: Partial<IntentGatewayDecision> = {}): IntentGatewayDecision {
  return {
    route: 'coding_session_control',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect the managed sandboxes attached to the current coding session.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'direct_assistant',
    preferredTier: 'local',
    requiresRepoGrounding: false,
    requiresToolSynthesis: false,
    expectedContextPressure: 'low',
    preferredAnswerPath: 'direct',
    simpleVsComplex: 'simple',
    entities: {
      codeSessionResource: 'managed_sandboxes',
    },
    ...overrides,
  };
}

describe('tryDirectCodeSessionControlFromGateway', () => {
  it('returns managed sandboxes instead of falling through to workspace listing', async () => {
    const executeDirectCodeSessionTool = vi.fn(async (toolName: string) => {
      if (toolName === 'code_session_current') {
        return {
          success: true,
          output: {
            session: {
              id: 'session-1',
              ownerUserId: 'owner',
              title: 'Guardian Agent',
              workspaceRoot: 'S:\\Development\\GuardianAgent',
              resolvedRoot: 'S:\\Development\\GuardianAgent',
              workState: {
                managedSandboxes: [],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const getCodeSessionManagedSandboxes = vi.fn(async () => ({
      sandboxes: [
        {
          leaseId: 'lease-1',
          targetId: 'daytona-main',
          profileName: 'Daytona Main',
          backendKind: 'daytona_sandbox',
          sandboxId: 'sandbox-1',
          localWorkspaceRoot: 'S:\\Development\\GuardianAgent',
          remoteWorkspaceRoot: '/home/daytona/guardian-workspace',
          status: 'active',
          state: 'running',
          acquiredAt: 1,
          lastUsedAt: 2,
          trackedRemotePaths: [],
        },
      ],
    }));

    const result = await tryDirectCodeSessionControlFromGateway({
      toolsEnabled: true,
      executeDirectCodeSessionTool,
      getCodeSessionManagedSandboxes,
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      resumeCodingTask: vi.fn(async () => null),
      onMessage: vi.fn(async () => ({ content: 'unexpected' })),
      message: createMessage(),
      ctx: createCtx(),
      decision: createDecision(),
    });

    expect(getCodeSessionManagedSandboxes).toHaveBeenCalledWith('session-1', 'owner');
    expect(result).toEqual({
      content: [
        'This chat is currently attached to:',
        '- CURRENT: Guardian Agent — S:\\Development\\GuardianAgent id=session-1',
        'Managed sandboxes attached to this coding session:',
        '- Daytona Main | backend=daytona_sandbox | state=running | status=active | sandboxId=sandbox-1 | workspace=/home/daytona/guardian-workspace | canRestart=no',
        'Remote sandbox targets: none configured for this session.',
      ].join('\n'),
      metadata: {
        codeSessionResolved: true,
        codeSessionId: 'session-1',
      },
    });
  });

  it('uses structured Daytona status planned steps to refresh managed sandbox state', async () => {
    const executeDirectCodeSessionTool = vi.fn(async (toolName: string) => {
      if (toolName === 'code_session_current') {
        return {
          success: true,
          output: {
            session: {
              id: 'session-1',
              ownerUserId: 'owner',
              title: 'Guardian Agent',
              workspaceRoot: 'S:\\Development\\GuardianAgent',
              resolvedRoot: 'S:\\Development\\GuardianAgent',
              workState: {
                managedSandboxes: [],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const getCodeSessionManagedSandboxes = vi.fn(async () => ({
      defaultTargetId: 'daytona:daytona-main',
      targets: [
        {
          id: 'vercel:vercel-prod',
          profileId: 'vercel-prod',
          profileName: 'Vercel Production',
          providerFamily: 'vercel',
          backendKind: 'vercel_sandbox',
          capabilityState: 'ready',
          reason: 'Ready for bounded remote sandbox execution.',
          networkMode: 'allow_all',
          allowedDomains: [],
          allowedCidrs: [],
        },
        {
          id: 'daytona:daytona-main',
          profileId: 'daytona-main',
          profileName: 'Daytona Main',
          providerFamily: 'daytona',
          backendKind: 'daytona_sandbox',
          capabilityState: 'ready',
          reason: 'Ready for bounded remote sandbox execution.',
          networkMode: 'allow_all',
          allowedDomains: [],
          allowedCidrs: [],
          healthState: 'unreachable',
          healthReason: 'HTTP 502 from Daytona control plane.',
          healthCause: 'external_service_unreachable',
        },
      ],
      targetDiagnostics: [{
        severity: 'warning',
        code: 'target_unreachable',
        targetId: 'daytona:daytona-main',
        profileName: 'Daytona Main',
        likelyCause: 'external_service_unreachable',
        nextAction: 'Retry later or verify the provider control plane/status page before changing local config.',
        message: 'Remote sandbox target \'Daytona Main\' is currently unreachable: HTTP 502 from Daytona control plane.',
      }],
      sandboxes: [
        {
          leaseId: 'lease-vercel',
          targetId: 'vercel:vercel-prod',
          profileName: 'Vercel Production',
          backendKind: 'vercel_sandbox',
          sandboxId: 'sandbox-vercel',
          localWorkspaceRoot: 'S:\\Development\\GuardianAgent',
          remoteWorkspaceRoot: '/vercel/sandbox',
          status: 'active',
          state: 'running',
          acquiredAt: 1,
          lastUsedAt: 2,
          trackedRemotePaths: [],
        },
        {
          leaseId: 'lease-1',
          targetId: 'daytona-main',
          profileName: 'Daytona Main',
          backendKind: 'daytona_sandbox',
          sandboxId: 'sandbox-1',
          localWorkspaceRoot: 'S:\\Development\\GuardianAgent',
          remoteWorkspaceRoot: '/home/daytona/guardian-workspace',
          status: 'unreachable',
          state: 'running',
          healthReason: 'HTTP 502 from Daytona control plane.',
          acquiredAt: 1,
          lastUsedAt: 2,
          trackedRemotePaths: [],
        },
      ],
    }));

    const result = await tryDirectCodeSessionControlFromGateway({
      toolsEnabled: true,
      executeDirectCodeSessionTool,
      getCodeSessionManagedSandboxes,
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      resumeCodingTask: vi.fn(async () => null),
      onMessage: vi.fn(async () => ({ content: 'unexpected' })),
      message: createMessage({
        content: 'Check Daytona status.',
      }),
      ctx: createCtx(),
      decision: createDecision({
        route: 'general_assistant',
        operation: 'inspect',
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        entities: {
          codeSessionSandboxProvider: 'daytona',
        },
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Check Daytona sandbox status and connectivity.',
            expectedToolCategories: ['daytona_status'],
            required: true,
          },
          {
            kind: 'answer',
            summary: 'Report whether the sandbox is reachable.',
            required: true,
          },
        ],
      }),
    });

    expect(getCodeSessionManagedSandboxes).toHaveBeenCalledWith('session-1', 'owner', {
      refreshTargetHealth: 'daytona',
    });
    expect(result?.content).toContain('Managed sandboxes (daytona) attached to this coding session:');
    expect(result?.content).toContain('status=unreachable');
    expect(result?.content).toContain('note=HTTP 502 from Daytona control plane.');
    expect(result?.content).toContain('Remote sandbox targets (daytona):');
    expect(result?.content).toContain('provider=daytona');
    expect(result?.content).not.toContain('provider=vercel');
    expect(result?.content).not.toContain('/vercel/sandbox');
    expect(result?.content).toContain('reachable=no');
    expect(result?.content).toContain('likelyCause=external_service_unreachable');
    expect(result?.content).toContain('Remote sandbox diagnostics (daytona):');
    expect(result?.content).toContain('code=target_unreachable');
    expect(result?.content).toContain('nextAction=Retry later or verify the provider control plane/status page before changing local config.');
  });

  it('reports unknown reachability when a configured remote target has no health probe yet', async () => {
    const executeDirectCodeSessionTool = vi.fn(async (toolName: string) => {
      if (toolName === 'code_session_current') {
        return {
          success: true,
          output: {
            session: {
              id: 'session-1',
              ownerUserId: 'owner',
              title: 'Guardian Agent',
              workspaceRoot: 'S:\\Development\\GuardianAgent',
              resolvedRoot: 'S:\\Development\\GuardianAgent',
              workState: {
                managedSandboxes: [],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });
    const getCodeSessionManagedSandboxes = vi.fn(async () => ({
      defaultTargetId: 'vercel:vercel-prod',
      targets: [
        {
          id: 'vercel:vercel-prod',
          profileId: 'vercel-prod',
          profileName: 'Vercel Production',
          providerFamily: 'vercel',
          backendKind: 'vercel_sandbox',
          capabilityState: 'ready',
          reason: 'Ready for bounded remote sandbox execution.',
          networkMode: 'allow_all',
          allowedDomains: [],
          allowedCidrs: [],
        },
      ],
      sandboxes: [],
    }));

    const result = await tryDirectCodeSessionControlFromGateway({
      toolsEnabled: true,
      executeDirectCodeSessionTool,
      getCodeSessionManagedSandboxes,
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      resumeCodingTask: vi.fn(async () => null),
      onMessage: vi.fn(async () => ({ content: 'unexpected' })),
      message: createMessage({
        content: 'What managed sandboxes are attached to this coding session?',
      }),
      ctx: createCtx(),
      decision: createDecision({
        route: 'general_assistant',
        operation: 'inspect',
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresToolSynthesis: true,
        preferredAnswerPath: 'tool_loop',
        entities: {},
        plannedSteps: [
          {
            kind: 'read',
            summary: 'Check Vercel sandbox status.',
            expectedToolCategories: ['remote_sandbox_status'],
            required: true,
          },
        ],
      }),
    });

    expect(getCodeSessionManagedSandboxes).toHaveBeenCalledWith('session-1', 'owner');
    expect(result?.content).toContain('provider=vercel');
    expect(result?.content).toContain('capability=ready');
    expect(result?.content).toContain('health=unknown');
    expect(result?.content).toContain('reachable=unknown');
  });

  it('reports when the current coding session has no attached managed sandboxes', async () => {
    const executeDirectCodeSessionTool = vi.fn(async () => ({
      success: true,
      output: {
        session: {
          id: 'session-1',
          ownerUserId: 'owner',
          title: 'Guardian Agent',
          workspaceRoot: 'S:\\Development\\GuardianAgent',
          resolvedRoot: 'S:\\Development\\GuardianAgent',
          workState: {
            managedSandboxes: [],
          },
        },
      },
    }));

    const result = await tryDirectCodeSessionControlFromGateway({
      toolsEnabled: true,
      executeDirectCodeSessionTool,
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      resumeCodingTask: vi.fn(async () => null),
      onMessage: vi.fn(async () => ({ content: 'unexpected' })),
      message: createMessage(),
      ctx: createCtx(),
      decision: createDecision(),
    });

    expect(result?.content).toContain('No managed sandboxes are currently attached to this coding session.');
    expect(result?.content).toContain('Remote sandbox targets: none configured for this session.');
    expect(result?.content).not.toContain('Available coding workspaces:');
  });

  it('lists sessions when the resource entity says session_list even if the operation is inspect', async () => {
    const executeDirectCodeSessionTool = vi.fn(async (toolName: string) => {
      if (toolName === 'code_session_list') {
        return {
          success: true,
          output: {
            sessions: [
              {
                id: 'session-1',
                title: 'Harness Session',
                workspaceRoot: 'S:\\Harness',
                resolvedRoot: 'S:\\Harness',
              },
              {
                id: 'session-2',
                title: 'Scoped Session',
                workspaceRoot: 'S:\\Scoped',
                resolvedRoot: 'S:\\Scoped',
              },
            ],
          },
        };
      }
      if (toolName === 'code_session_current') {
        return {
          success: true,
          output: {
            session: {
              id: 'session-1',
              title: 'Harness Session',
              workspaceRoot: 'S:\\Harness',
              resolvedRoot: 'S:\\Harness',
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${toolName}`);
    });

    const result = await tryDirectCodeSessionControlFromGateway({
      toolsEnabled: true,
      executeDirectCodeSessionTool,
      getActivePendingAction: vi.fn(() => null),
      completePendingAction: vi.fn(),
      resumeCodingTask: vi.fn(async () => null),
      onMessage: vi.fn(async () => ({ content: 'unexpected' })),
      message: createMessage({ content: 'List the coding sessions.' }),
      ctx: createCtx(),
      decision: createDecision({
        operation: 'inspect',
        entities: {
          codeSessionResource: 'session_list',
        },
      }),
    });

    expect(result?.content).toContain('Available coding workspaces:');
    expect(result?.content).toContain('CURRENT: Harness Session');
    expect(result?.content).toContain('Scoped Session');
  });
});
