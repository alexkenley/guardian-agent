import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type AssistantCloudConfig } from '../../config/types.js';
import {
  buildRemoteExecutionTargetDiagnostics,
  classifyRemoteExecutionDiagnosticCause,
  listRemoteExecutionTargets,
  prioritizeReadyRemoteExecutionTargets,
  recommendWorkflowIsolation,
} from './policy.js';

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
          baseSnapshotId: 'snap_vercel_base',
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
      snapshotConfigured: true,
      snapshotLabel: 'snap_vercel_base',
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
        snapshot: 'snapshot-main',
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
      snapshotConfigured: true,
      snapshotLabel: 'snapshot-main',
    });
  });

  it('prefers snapshot-backed targets when Guardian auto-selects among ready sandboxes', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-cold',
        name: 'Cold Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: {
          enabled: true,
          projectId: 'prj_123',
          allowNetwork: false,
        },
      }],
      daytonaProfiles: [{
        id: 'daytona-warm',
        name: 'Warm Daytona',
        apiKey: 'daytona-secret',
        enabled: true,
        snapshot: 'snapshot-main',
        allowNetwork: false,
      }],
    }));

    const prioritized = prioritizeReadyRemoteExecutionTargets(targets);

    expect(prioritized[0]?.id).toBe('daytona:daytona-warm');
    expect(prioritized[0]?.snapshotConfigured).toBe(true);
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

  it('reports default target drift and cached unreachable sandbox health', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: { enabled: true, projectId: 'prj_123' },
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

    const diagnostics = buildRemoteExecutionTargetDiagnostics(targets, 'vercel:missing-profile');

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'default_target_missing',
        targetId: 'vercel:missing-profile',
        likelyCause: 'local_profile_config',
      }),
      expect.objectContaining({
        code: 'target_unreachable',
        targetId: 'vercel:vercel-main',
        likelyCause: 'external_service_unreachable',
        nextAction: expect.stringContaining('provider control plane'),
        message: expect.stringContaining('HTTP 502'),
      }),
      expect.objectContaining({
        code: 'no_ready_targets',
      }),
    ]));
  });

  it('classifies remote sandbox diagnostic causes without exposing credential values', () => {
    expect(classifyRemoteExecutionDiagnosticCause('Request failed with status code 502')).toBe('external_service_unreachable');
    expect(classifyRemoteExecutionDiagnosticCause("Host 'sandbox.example.com' is not in allowedDomains.")).toBe('guardian_policy_config');
    expect(classifyRemoteExecutionDiagnosticCause("Daytona profile 'main' does not have a resolved API key.")).toBe('local_profile_config');
    expect(classifyRemoteExecutionDiagnosticCause("Managed Vercel sandbox is stopped (status: stopped).")).toBe('sandbox_lifecycle');
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

  it('routes burst tasks to Vercel and stateful tasks to Daytona when both are available', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: { enabled: true, projectId: 'prj_123' },
      }],
      daytonaProfiles: [{
        id: 'daytona-main',
        name: 'Main Daytona',
        apiKey: 'daytona-secret',
        enabled: true,
      }],
    }));

    const burst = prioritizeReadyRemoteExecutionTargets(targets, [], 'npm install lodash');
    expect(burst[0]?.id).toBe('vercel:vercel-main');

    const stateful = prioritizeReadyRemoteExecutionTargets(targets, [], 'npm run build');
    expect(stateful[0]?.id).toBe('daytona:daytona-main');
  });

  it('vetoes Vercel and prioritizes Daytona when native dependencies are detected', () => {
    const targets = listRemoteExecutionTargets(createCloudConfig({
      enabled: true,
      vercelProfiles: [{
        id: 'vercel-main',
        name: 'Main Vercel',
        apiToken: 'vercel-secret',
        teamId: 'team_123',
        sandbox: { enabled: true, projectId: 'prj_123' },
      }],
      daytonaProfiles: [{
        id: 'daytona-main',
        name: 'Main Daytona',
        apiKey: 'daytona-secret',
        enabled: true,
      }],
    }));

    // Even if it's a burst task (which usually goes to Vercel), native deps should force Daytona
    const result = prioritizeReadyRemoteExecutionTargets(
      targets, 
      [], 
      'npm install lodash', 
      { hasNativeDependencies: true, detectedNativePackages: ['node-pty'] }
    );
    
    expect(result[0]?.id).toBe('daytona:daytona-main');
    expect(result[0]?.routingReason).toBe('build_environment_required');
  });
});
