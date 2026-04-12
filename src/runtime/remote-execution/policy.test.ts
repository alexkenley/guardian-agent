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
});
