import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type AssistantCloudConfig } from '../../config/types.js';
import { listRemoteExecutionTargets, recommendWorkflowIsolation } from './policy.js';

function createCloudConfig(input: Partial<AssistantCloudConfig>): AssistantCloudConfig {
  return {
    ...DEFAULT_CONFIG.assistant.tools.cloud,
    ...input,
  };
}

describe('remote execution policy', () => {
  it('lists ready Vercel sandbox targets from the existing cloud profile model', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: {
          enabled: true,
          projectId: 'prj_123',
          defaultTimeoutMs: 300_000,
          defaultVcpus: 2,
          allowNetwork: true,
          allowedDomains: ['Registry.Npmjs.org', 'api.anthropic.com'],
        },
      }],
    }));

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: 'vercel:vercel-main',
      capabilityState: 'ready',
      networkMode: 'domain_allowlist',
      allowedDomains: ['registry.npmjs.org', 'api.anthropic.com'],
      defaultTimeoutMs: 300_000,
      defaultVcpus: 2,
    });
  });

  it('reports incomplete Vercel sandbox targets when project or team scope is missing', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        credentialRef: 'cloud.vercel.main',
        sandbox: {
          enabled: true,
        },
      }],
    }));

    expect(targets[0]?.capabilityState).toBe('incomplete');
    expect(targets[0]?.reason).toMatch(/teamId|projectId/i);
  });

  it('lists ready Daytona sandbox targets with CIDR-based network policy', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      daytonaProfiles: [{
        id: 'daytona-main',
        name: 'Daytona Main',
        apiKey: 'daytona-secret',
        enabled: true,
        target: 'us',
        language: 'typescript',
        allowNetwork: true,
        allowedCidrs: ['10.0.0.0/8', '192.168.0.0/16'],
      }],
    }));

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: 'daytona:daytona-main',
      capabilityState: 'ready',
      backendKind: 'daytona_sandbox',
      networkMode: 'cidr_allowlist',
      allowedCidrs: ['10.0.0.0/8', '192.168.0.0/16'],
      target: 'us',
      language: 'typescript',
    });
  });

  it('recommends remote isolation for dependency reviews and caution workspaces', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: {
          enabled: true,
          projectId: 'prj_123',
          allowNetwork: false,
        },
      }],
    }));

    const dependencyReview = recommendWorkflowIsolation('dependency_review', { targets, workspaceTrustState: 'trusted' });
    const cautionImplementation = recommendWorkflowIsolation('implementation', { targets, workspaceTrustState: 'caution' });

    expect(dependencyReview).toMatchObject({
      level: 'recommended',
      backendKind: 'vercel_sandbox',
      networkMode: 'deny_all',
    });
    expect(dependencyReview.candidateOperations).toEqual(['dependency install', 'build', 'test']);

    expect(cautionImplementation.level).toBe('recommended');
    expect(cautionImplementation.reason).toMatch(/off the host|trust/i);
  });

  it('keeps spec-to-plan workflows local', () => {
    const recommendation = recommendWorkflowIsolation('spec_to_plan', { targets: [] });
    expect(recommendation).toMatchObject({
      level: 'none',
      candidateOperations: [],
    });
  });

  it('excludes cached unreachable targets from readiness decisions', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: {
          enabled: true,
          projectId: 'prj_123',
          allowNetwork: false,
        },
      }],
      daytonaProfiles: [{
        id: 'daytona-main',
        name: 'Daytona Main',
        apiKey: 'daytona-secret',
        enabled: true,
        allowNetwork: false,
      }],
    }), {
      healthByTargetId: {
        'vercel:vercel-main': {
          state: 'unreachable',
          reason: 'Vercel sandbox returned HTTP 502.',
          checkedAt: 123,
        },
      },
    });

    const recommendation = recommendWorkflowIsolation('dependency_review', { targets, workspaceTrustState: 'trusted' });

    expect(recommendation).toMatchObject({
      level: 'recommended',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
    });
  });

  it('honors the configured default target without provider-specific workflow heuristics', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: {
          enabled: true,
          projectId: 'prj_123',
          allowNetwork: false,
        },
      }],
      daytonaProfiles: [{
        id: 'daytona-main',
        name: 'Daytona Main',
        apiKey: 'daytona-secret',
        enabled: true,
        allowNetwork: false,
      }],
    }));

    const recommendation = recommendWorkflowIsolation('bug_fix', {
      targets,
      workspaceTrustState: 'trusted',
      defaultRemoteExecutionTargetId: 'daytona:daytona-main',
    });

    expect(recommendation).toMatchObject({
      level: 'available',
      backendKind: 'daytona_sandbox',
      profileId: 'daytona-main',
    });
  });
});
