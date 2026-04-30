import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from './executor.js';
import type { RemoteExecutionServiceLike } from '../runtime/remote-execution/types.js';
import { DEFAULT_CONFIG, type AssistantCloudConfig } from '../config/types.js';

function createCloudConfig(input: Partial<AssistantCloudConfig>): AssistantCloudConfig {
  return {
    ...DEFAULT_CONFIG.assistant.tools.cloud,
    ...input,
  };
}

describe('ToolExecutor Managed Sandbox State', () => {
  const root = '/workspace';
  
  const mockService: RemoteExecutionServiceLike = {
    runBoundedJob: vi.fn(),
    stopLease: vi.fn().mockResolvedValue(undefined),
    resumeLease: vi.fn().mockResolvedValue({
      id: 'lease-1',
      targetId: 'daytona:daytona-main',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
      profileName: 'Daytona Main',
      sandboxId: 'sandbox-1',
      localWorkspaceRoot: root,
      remoteWorkspaceRoot: '/remote/workspace',
      acquiredAt: 1,
      state: 'running',
      lastUsedAt: 123,
      expiresAt: Number.MAX_SAFE_INTEGER,
      trackedRemotePaths: [],
      leaseMode: 'managed',
    }),
    inspectLease: vi.fn().mockResolvedValue({}),
    getKnownTargetHealth: () => ({}),
  };

  const mockStore: any = {
    updateSession: vi.fn(),
    resolveForRequest: () => ({ session: { id: 'session-1', workspaceRoot: root, workState: { managedSandboxes: [] } } }),
    listSessionsForUser: () => [],
  };

  it('stops a managed sandbox', async () => {
    const sandbox: any = {
      leaseId: 'lease-1',
      targetId: 'daytona:daytona-main',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
      profileName: 'Daytona Main',
      sandboxId: 'sandbox-1',
      localWorkspaceRoot: root,
      remoteWorkspaceRoot: '/remote/workspace',
      status: 'active' as const,
      acquiredAt: 1,
      lastUsedAt: 1,
      trackedRemotePaths: [],
    };
    
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_each',
      allowedDomains: ['app.daytona.io'],
      codeSessionStore: mockStore,
      remoteExecutionService: mockService,
      cloudConfig: createCloudConfig({
        enabled: true,
        daytonaProfiles: [{ id: 'daytona-main', name: 'Daytona Main', apiKey: 'secret', enabled: true }],
      }),
    });

    // Mock session with the sandbox
    vi.spyOn(executor as any, 'getCodeSessionRecord').mockReturnValue({
      id: 'session-1',
      ownerUserId: 'user-1',
      resolvedRoot: root,
      workState: { managedSandboxes: [sandbox] },
    });

    const result = await executor.stopManagedSandboxForCodeSession({
      sessionId: 'session-1',
      ownerUserId: 'user-1',
      leaseId: 'lease-1',
    });

    expect(mockService.stopLease).toHaveBeenCalled();
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.state).toBe('stopped');
    expect(mockStore.updateSession).toHaveBeenCalled();
  });

  it('starts a managed sandbox', async () => {
    const sandbox: any = {
      leaseId: 'lease-1',
      targetId: 'daytona:daytona-main',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
      profileName: 'Daytona Main',
      sandboxId: 'sandbox-1',
      localWorkspaceRoot: root,
      remoteWorkspaceRoot: '/remote/workspace',
      status: 'stopped' as const,
      state: 'stopped',
      acquiredAt: 1,
      lastUsedAt: 1,
      trackedRemotePaths: [],
    };
    
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_each',
      allowedDomains: ['app.daytona.io'],
      codeSessionStore: mockStore,
      remoteExecutionService: mockService,
      cloudConfig: createCloudConfig({
        enabled: true,
        daytonaProfiles: [{ id: 'daytona-main', name: 'Daytona Main', apiKey: 'secret', enabled: true }],
      }),
    });

    // Mock session with the sandbox
    vi.spyOn(executor as any, 'getCodeSessionRecord').mockReturnValue({
      id: 'session-1',
      ownerUserId: 'user-1',
      resolvedRoot: root,
      workState: { managedSandboxes: [sandbox] },
    });

    const result = await executor.startManagedSandboxForCodeSession({
      sessionId: 'session-1',
      ownerUserId: 'user-1',
      leaseId: 'lease-1',
    });

    expect(mockService.resumeLease).toHaveBeenCalled();
    expect(sandbox.status).toBe('active');
    expect(sandbox.state).toBe('running');
    expect(mockStore.updateSession).toHaveBeenCalled();
  });

  it('does not silently promote a resumed sandbox with no reported lifecycle state to active', async () => {
    const sandbox: any = {
      leaseId: 'lease-1',
      targetId: 'daytona:daytona-main',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
      profileName: 'Daytona Main',
      sandboxId: 'sandbox-1',
      localWorkspaceRoot: root,
      remoteWorkspaceRoot: '/remote/workspace',
      status: 'stopped' as const,
      state: 'stopped',
      acquiredAt: 1,
      lastUsedAt: 1,
      trackedRemotePaths: [],
    };
    const remoteExecutionService: RemoteExecutionServiceLike = {
      runBoundedJob: vi.fn(),
      stopLease: vi.fn().mockResolvedValue(undefined),
      resumeLease: vi.fn().mockResolvedValue({
        id: 'lease-1',
        targetId: 'daytona:daytona-main',
        backendKind: 'daytona_sandbox',
        profileId: 'daytona-main',
        profileName: 'Daytona Main',
        sandboxId: 'sandbox-1',
        localWorkspaceRoot: root,
        remoteWorkspaceRoot: '/remote/workspace',
        acquiredAt: 1,
        state: undefined,
        lastUsedAt: 123,
        expiresAt: Number.MAX_SAFE_INTEGER,
        trackedRemotePaths: [],
        leaseMode: 'managed',
      }),
      inspectLease: vi.fn().mockResolvedValue({}),
      getKnownTargetHealth: () => ({}),
    };
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_each',
      allowedDomains: ['app.daytona.io'],
      codeSessionStore: mockStore,
      remoteExecutionService,
      cloudConfig: createCloudConfig({
        enabled: true,
        daytonaProfiles: [{ id: 'daytona-main', name: 'Daytona Main', apiKey: 'secret', enabled: true }],
      }),
    });

    vi.spyOn(executor as any, 'getCodeSessionRecord').mockReturnValue({
      id: 'session-1',
      ownerUserId: 'user-1',
      resolvedRoot: root,
      workState: { managedSandboxes: [sandbox] },
    });

    await executor.startManagedSandboxForCodeSession({
      sessionId: 'session-1',
      ownerUserId: 'user-1',
      leaseId: 'lease-1',
    });

    expect(remoteExecutionService.resumeLease).toHaveBeenCalled();
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.state).toBeUndefined();
  });

  it('marks managed sandbox records unreachable when their configured target disappears', async () => {
    const sandbox: any = {
      leaseId: 'lease-1',
      targetId: 'daytona:daytona-main',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
      profileName: 'Daytona Main',
      sandboxId: 'sandbox-1',
      localWorkspaceRoot: root,
      remoteWorkspaceRoot: '/remote/workspace',
      status: 'active' as const,
      state: 'running',
      acquiredAt: 1,
      lastUsedAt: 1,
      trackedRemotePaths: [],
    };
    const session = {
      id: 'session-1',
      ownerUserId: 'user-1',
      resolvedRoot: root,
      workspaceRoot: root,
      workState: { managedSandboxes: [sandbox] },
    };
    const store: any = {
      updateSession: vi.fn(),
      resolveForRequest: () => ({ session }),
      listSessionsForUser: () => [],
    };
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_each',
      allowedDomains: ['app.daytona.io'],
      codeSessionStore: store,
      remoteExecutionService: {
        runBoundedJob: vi.fn(),
        getKnownTargetHealth: () => ({}),
        listActiveLeases: () => [],
      },
      cloudConfig: createCloudConfig({
        enabled: true,
        daytonaProfiles: [],
      }),
    });

    vi.spyOn(executor as any, 'getCodeSessionRecord').mockReturnValue(session);

    const result = await executor.getCodeSessionManagedSandboxStatus({
      sessionId: 'session-1',
      ownerUserId: 'user-1',
    });

    expect(result.sandboxes[0]).toMatchObject({
      status: 'unreachable',
      healthState: 'unreachable',
      healthCause: 'local_profile_config',
      healthReason: expect.stringContaining('can no longer be resolved'),
    });
    expect(store.updateSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      ownerUserId: 'user-1',
      workState: {
        managedSandboxes: [expect.objectContaining({
          status: 'unreachable',
          healthCause: 'local_profile_config',
        })],
      },
    }));
  });
});
