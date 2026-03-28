import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AiSecurityService,
  createAiSecuritySessionSnapshot,
  type AiSecurityRuntimeSnapshot,
} from './ai-security.js';
import { createCodeWorkspaceTrustReview, type CodeWorkspaceTrustAssessment } from './code-workspace-trust.js';
import type { CodeSessionRecord } from './code-sessions.js';

function createRuntimeSnapshot(overrides?: Partial<AiSecurityRuntimeSnapshot>): AiSecurityRuntimeSnapshot {
  return {
    sandbox: {
      enabled: true,
      availability: 'strong',
      enforcementMode: 'strict',
      backend: 'bubblewrap',
      degradedFallbackActive: false,
      degradedFallback: {
        allowNetworkTools: false,
        allowBrowserTools: false,
        allowMcpServers: false,
        allowPackageManagers: false,
        allowManualCodeTerminals: false,
      },
      ...(overrides?.sandbox ?? {}),
    },
    browser: {
      enabled: false,
      allowedDomains: ['github.com'],
      playwrightEnabled: true,
      ...(overrides?.browser ?? {}),
    },
    mcp: {
      enabled: false,
      configuredThirdPartyServerCount: 0,
      connectedThirdPartyServerCount: 0,
      managedProviderIds: [],
      usesDynamicPlaywrightPackage: false,
      thirdPartyServers: [],
      ...(overrides?.mcp ?? {}),
    },
    agentPolicyUpdates: {
      allowedPaths: false,
      allowedCommands: false,
      allowedDomains: false,
      toolPolicies: false,
      ...(overrides?.agentPolicyUpdates ?? {}),
    },
  };
}

function createWorkspaceAssessment(
  overrides?: Partial<CodeWorkspaceTrustAssessment>,
): CodeWorkspaceTrustAssessment {
  return {
    workspaceRoot: '/workspace/demo',
    state: 'trusted',
    summary: 'No suspicious indicators found.',
    assessedAt: 1_000,
    scannedFiles: 10,
    truncated: false,
    findings: [],
    nativeProtection: null,
    ...(overrides ?? {}),
  };
}

function createCodeSession(assessment: CodeWorkspaceTrustAssessment | null, review = null): CodeSessionRecord {
  return {
    id: 'session-1',
    ownerUserId: 'user-1',
    ownerPrincipalId: 'user-1',
    title: 'Repo A',
    workspaceRoot: '/workspace/demo',
    resolvedRoot: '/workspace/demo',
    agentId: 'chat',
    status: 'active',
    attachmentPolicy: 'same_principal',
    createdAt: 1_000,
    updatedAt: 1_000,
    lastActivityAt: 1_000,
    conversationUserId: 'user-1',
    conversationChannel: 'web',
    uiState: {
      currentDirectory: null,
      selectedFilePath: null,
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
      workspaceTrust: assessment,
      workspaceTrustReview: review,
      workspaceMap: null,
      workingSet: null,
      activeSkills: [],
      pendingApprovals: [],
      recentJobs: [],
      changedFiles: [],
      verification: [],
    },
  };
}

describe('AiSecurityService', () => {
  it('detects degraded runtime posture and policy-widening risks', async () => {
    const service = new AiSecurityService({
      enabled: true,
      getRuntimeSnapshot: () => createRuntimeSnapshot({
        sandbox: {
          availability: 'degraded',
          enforcementMode: 'permissive',
          degradedFallbackActive: true,
          degradedFallback: {
            allowNetworkTools: true,
            allowBrowserTools: true,
            allowMcpServers: false,
            allowPackageManagers: false,
            allowManualCodeTerminals: true,
          },
        },
        browser: {
          enabled: true,
          allowedDomains: [],
          playwrightEnabled: true,
        },
        mcp: {
          enabled: true,
          configuredThirdPartyServerCount: 2,
          connectedThirdPartyServerCount: 1,
          managedProviderIds: [],
          usesDynamicPlaywrightPackage: false,
          thirdPartyServers: [
            {
              id: 'dangerous-server',
              name: 'Dangerous Server',
              command: 'dangerous-mcp',
              trustLevel: 'read_only',
              startupApproved: true,
              networkAccess: true,
              inheritEnv: true,
              allowedEnvKeyCount: 4,
              envKeyCount: 2,
              connected: true,
            },
            {
              id: 'blocked-server',
              name: 'Blocked Server',
              command: 'blocked-mcp',
              startupApproved: false,
              networkAccess: false,
              inheritEnv: false,
              allowedEnvKeyCount: 0,
              envKeyCount: 0,
              connected: false,
            },
          ],
        },
        agentPolicyUpdates: {
          allowedPaths: true,
          allowedCommands: false,
          allowedDomains: true,
          toolPolicies: false,
        },
      }),
      listCodeSessions: () => [],
      now: () => 5_000,
    });

    const result = await service.scan({ profileId: 'runtime-hardening' });
    expect(result.success).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('Degraded sandbox fallback'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('Network tools'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('Manual code terminals'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('policy widening'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('Connected third-party MCP servers'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('outbound network access'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('inherit the parent environment'))).toBe(true);
    expect(service.getSummary().findings.highOrCritical).toBeGreaterThan(0);
  });

  it('surfaces blocked workspaces and prompt-injection findings', async () => {
    const assessment = createWorkspaceAssessment({
      state: 'blocked',
      summary: 'Static workspace review found high-risk prompt injection indicators.',
      findings: [
        {
          severity: 'high',
          kind: 'prompt_injection',
          path: 'README.md',
          summary: 'Prompt injection bait was found in a repo instruction file.',
          evidence: 'Ignore previous instructions',
        },
      ],
    });

    const service = new AiSecurityService({
      enabled: true,
      getRuntimeSnapshot: () => createRuntimeSnapshot(),
      listCodeSessions: () => [createAiSecuritySessionSnapshot(createCodeSession(assessment))],
      now: () => 6_000,
    });

    const result = await service.scan({ profileId: 'workspace-boundaries' });
    expect(result.findings.some((finding) => finding.title.includes('Workspace trust is blocked'))).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes('prompt injection'))).toBe(true);
    expect(result.promotedFindings.every((finding) => finding.severity === 'high' || finding.severity === 'critical')).toBe(true);
  });

  it('downgrades blocked workspaces with an active manual review and allows status updates', async () => {
    const assessment = createWorkspaceAssessment({
      state: 'blocked',
      summary: 'Blocked until reviewed.',
      findings: [{
        severity: 'high',
        kind: 'lifecycle_script',
        path: 'package.json',
        summary: 'Package lifecycle script runs during install.',
      }],
    });
    const review = createCodeWorkspaceTrustReview(assessment, 'operator', 7_000);

    const service = new AiSecurityService({
      enabled: true,
      getRuntimeSnapshot: () => createRuntimeSnapshot(),
      listCodeSessions: () => [createAiSecuritySessionSnapshot(createCodeSession(assessment, review))],
      now: () => 7_000,
    });

    const result = await service.scan({ profileId: 'workspace-boundaries' });
    const acceptedFinding = result.findings.find((finding) => finding.title.includes('manually accepted'));
    expect(acceptedFinding?.severity).toBe('medium');

    const update = service.updateFindingStatus(result.findings[0]?.id ?? '', 'triaged');
    expect(update.success).toBe(true);
    expect(service.listFindings(10).some((finding) => finding.status === 'triaged')).toBe(true);
  });

  it('persists runs and findings across restart', async () => {
    const persistRoot = join(tmpdir(), `guardianagent-ai-security-${randomUUID()}`);
    mkdirSync(persistRoot, { recursive: true });
    const persistPath = join(persistRoot, 'assistant-security.json');

    try {
      const first = new AiSecurityService({
        enabled: true,
        getRuntimeSnapshot: () => createRuntimeSnapshot({
          sandbox: {
            availability: 'degraded',
            enforcementMode: 'permissive',
            degradedFallbackActive: true,
            degradedFallback: {
              allowNetworkTools: true,
              allowBrowserTools: false,
              allowMcpServers: false,
              allowPackageManagers: false,
              allowManualCodeTerminals: false,
            },
          },
        }),
        listCodeSessions: () => [],
        now: () => 8_000,
        persistPath,
      });

      const result = await first.scan({ profileId: 'runtime-hardening' });
      expect(result.findings.length).toBeGreaterThan(0);

      const findingId = result.findings[0]?.id ?? '';
      expect(first.updateFindingStatus(findingId, 'triaged').success).toBe(true);
      await first.persist();

      const second = new AiSecurityService({
        enabled: true,
        getRuntimeSnapshot: () => createRuntimeSnapshot(),
        listCodeSessions: () => [],
        now: () => 9_000,
        persistPath,
      });
      await second.load();

      expect(second.getSummary().lastRunAt).toBe(8_000);
      expect(second.listRuns(10)).toHaveLength(1);
      expect(second.listFindings(10).some((finding) => finding.status === 'triaged')).toBe(true);
    } finally {
      rmSync(persistRoot, { recursive: true, force: true });
    }
  });
});
