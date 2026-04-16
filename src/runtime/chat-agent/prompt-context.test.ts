import { describe, expect, it } from 'vitest';

import type { CodeSessionRecord } from '../code-sessions.js';
import type { RemoteExecutionTargetDescriptor } from '../remote-execution/policy.js';
import { buildCodeSessionSystemContext } from './prompt-context.js';

function createSession(): CodeSessionRecord {
  return {
    id: 'session-1',
    ownerUserId: 'owner',
    title: 'Guardian Workspace',
    workspaceRoot: '/workspace',
    resolvedRoot: '/workspace',
    agentId: null,
    status: 'active',
    attachmentPolicy: 'explicit_only',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    conversationUserId: 'owner',
    conversationChannel: 'web',
    uiState: {
      currentDirectory: '/workspace',
      selectedFilePath: '/workspace/src/index.ts',
      showDiff: false,
      expandedDirs: [],
      terminalCollapsed: false,
      terminalTabs: [],
    },
    workState: {
      focusSummary: '',
      planSummary: '',
      compactedSummary: '',
      workspaceProfile: null,
      workspaceTrust: null,
      workspaceTrustReview: null,
      workspaceMap: null,
      workingSet: null,
      activeSkills: [],
      pendingApprovals: [],
      recentJobs: [],
      changedFiles: [],
      verification: [],
      managedSandboxes: [
        {
          leaseId: 'lease-daytona',
          targetId: 'daytona:daytona-main',
          backendKind: 'daytona_sandbox',
          profileId: 'daytona-main',
          profileName: 'Daytona Main',
          sandboxId: '6e548f52-9140-444b-bb2a-3e1741103c28',
          localWorkspaceRoot: '/workspace',
          remoteWorkspaceRoot: '/home/daytona/guardian-workspace',
          status: 'active',
          state: 'started',
          acquiredAt: 1,
          lastUsedAt: 1,
          trackedRemotePaths: [],
          healthState: 'healthy',
          healthReason: 'Managed Daytona sandbox is reachable (state: started).',
        },
        {
          leaseId: 'lease-vercel',
          targetId: 'vercel:vercel-prod',
          backendKind: 'vercel_sandbox',
          profileId: 'vercel-prod',
          profileName: 'Vercel Production',
          sandboxId: 'sbx_e1H27tRVq3IhAiIEcMLatVnGcDiy',
          localWorkspaceRoot: '/workspace',
          remoteWorkspaceRoot: '/vercel/sandbox',
          status: 'stopped',
          state: 'stopped',
          acquiredAt: 1,
          lastUsedAt: 1,
          trackedRemotePaths: [],
          healthState: 'unknown',
          healthReason: 'Managed Vercel sandbox is stopped (status: stopped).',
        },
      ],
      workflow: null,
    },
  };
}

describe('buildCodeSessionSystemContext', () => {
  it('includes managed sandboxes and ready remote execution targets in code-session context', () => {
    const remoteExecutionTargets: RemoteExecutionTargetDescriptor[] = [
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
        healthState: 'healthy',
        healthReason: 'Managed Vercel sandbox is stopped (status: stopped).',
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
        healthState: 'healthy',
        healthReason: 'Managed Daytona sandbox is reachable (state: started).',
      },
    ];

    const prompt = buildCodeSessionSystemContext({
      session: createSession(),
      remoteExecutionTargets,
      formatCodeWorkspaceTrustForPrompt: () => 'workspaceTrust: cleared',
      formatCodeWorkspaceProfileForPromptWithTrust: () => 'workspaceProfile: (none)',
    });

    expect(prompt).toContain('managedSandboxes:');
    expect(prompt).toContain('Daytona Main | backend=daytona_sandbox | state=started');
    expect(prompt).toContain('sandboxId=6e548f52-9140-444b-bb2a-3e1741103c28');
    expect(prompt).toContain('canRestart=no');
    expect(prompt).toContain('Vercel Production | backend=vercel_sandbox | state=stopped');
    expect(prompt).toContain('sandboxId=sbx_e1H27tRVq3IhAiIEcMLatVnGcDiy');
    expect(prompt).toContain('remoteExecutionTargets:');
    expect(prompt).toContain('Vercel Production | backend=vercel_sandbox | capability=ready | health=healthy | supportsShortLived=yes | supportsManaged=yes | restartStoppedManaged=no');
    expect(prompt).toContain('Daytona Main | backend=daytona_sandbox | capability=ready | health=healthy | supportsShortLived=yes | supportsManaged=yes | restartStoppedManaged=yes');
    expect(prompt).toContain('attachedManaged=Vercel Production:stopped');
    expect(prompt).toContain('attachedManaged=Daytona Main:started');
    expect(prompt).toContain('When the user asks about available sandboxes, answer from both managedSandboxes and remoteExecutionTargets.');
  });
});
