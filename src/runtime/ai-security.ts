import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  CodeSessionRecord,
} from './code-sessions.js';
import type {
  CodeWorkspaceTrustAssessment,
  CodeWorkspaceTrustReview,
} from './code-workspace-trust.js';
import {
  getCodeWorkspaceTrustAssessmentFingerprint,
} from './code-workspace-trust.js';
import type { SandboxAvailability, SandboxEnforcementMode } from '../sandbox/types.js';
import { writeSecureFile } from '../util/secure-fs.js';

export type AiSecuritySeverity = 'low' | 'medium' | 'high' | 'critical';
export type AiSecurityFindingStatus = 'new' | 'triaged' | 'resolved' | 'suppressed';
export type AiSecurityFindingCategory =
  | 'sandbox'
  | 'policy'
  | 'browser'
  | 'mcp'
  | 'workspace'
  | 'trust_boundary';
export type AiSecurityTargetType = 'runtime' | 'workspace';
export type AiSecurityRunSource = 'manual' | 'scheduled' | 'system';

export interface AiSecurityProfile {
  id: string;
  label: string;
  description: string;
  targetTypes: AiSecurityTargetType[];
  focus: string[];
}

export interface AiSecurityTarget {
  id: string;
  type: AiSecurityTargetType;
  label: string;
  description: string;
  riskLevel: 'normal' | 'elevated' | 'high';
  ready: boolean;
  metadata?: Record<string, unknown>;
}

export interface AiSecurityFindingEvidence {
  kind: 'sandbox' | 'policy' | 'workspace' | 'review';
  summary: string;
  details?: Record<string, unknown>;
}

export interface AiSecurityFinding {
  id: string;
  dedupeKey: string;
  targetId: string;
  targetType: AiSecurityTargetType;
  targetLabel: string;
  category: AiSecurityFindingCategory;
  severity: AiSecuritySeverity;
  confidence: number;
  status: AiSecurityFindingStatus;
  title: string;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  evidence: AiSecurityFindingEvidence[];
}

export interface AiSecurityRun {
  id: string;
  source: AiSecurityRunSource;
  profileId: string;
  profileLabel: string;
  startedAt: number;
  completedAt: number;
  success: boolean;
  message: string;
  targetCount: number;
  findingCount: number;
  highOrCriticalCount: number;
}

export interface AiSecuritySummary {
  enabled: boolean;
  profileCount: number;
  targetCount: number;
  readyTargetCount: number;
  lastRunAt?: number;
  findings: {
    total: number;
    new: number;
    highOrCritical: number;
  };
  posture: {
    availability: SandboxAvailability;
    enforcementMode: SandboxEnforcementMode;
    degradedFallbackActive: boolean;
    confidence: 'bounded' | 'reduced';
  };
}

export interface AiSecurityScanInput {
  profileId?: string;
  targetIds?: string[];
  source?: AiSecurityRunSource;
}

export interface AiSecurityScanResult {
  success: boolean;
  message: string;
  run: AiSecurityRun;
  findings: AiSecurityFinding[];
  promotedFindings: AiSecurityFinding[];
}

export interface AiSecurityRuntimeSnapshot {
  sandbox: {
    enabled: boolean;
    availability: SandboxAvailability;
    enforcementMode: SandboxEnforcementMode;
    backend?: string;
    degradedFallbackActive: boolean;
    degradedFallback: {
      allowNetworkTools: boolean;
      allowBrowserTools: boolean;
      allowMcpServers: boolean;
      allowPackageManagers: boolean;
      allowManualCodeTerminals: boolean;
    };
  };
  browser: {
    enabled: boolean;
    allowedDomains: string[];
    playwrightEnabled: boolean;
  };
  mcp: {
    enabled: boolean;
    configuredThirdPartyServerCount: number;
    connectedThirdPartyServerCount: number;
    managedProviderIds: string[];
    usesDynamicPlaywrightPackage: boolean;
    thirdPartyServers: Array<{
      id: string;
      name: string;
      command: string;
      trustLevel?: string;
      startupApproved: boolean;
      networkAccess: boolean;
      inheritEnv: boolean;
      allowedEnvKeyCount: number;
      envKeyCount: number;
      connected: boolean;
    }>;
  };
  agentPolicyUpdates: {
    allowedPaths: boolean;
    allowedCommands: boolean;
    allowedDomains: boolean;
    toolPolicies: boolean;
  };
}

export interface AiSecuritySessionSnapshot {
  sessionId: string;
  title: string;
  workspaceRoot: string;
  workspaceTrust: CodeWorkspaceTrustAssessment | null;
  workspaceTrustReview: CodeWorkspaceTrustReview | null;
}

export interface AiSecurityServiceOptions {
  enabled: boolean;
  getRuntimeSnapshot: () => AiSecurityRuntimeSnapshot;
  listCodeSessions: () => AiSecuritySessionSnapshot[];
  persistPath?: string;
  now?: () => number;
  maxRuns?: number;
  maxFindings?: number;
}

const DEFAULT_MAX_RUNS = 50;
const DEFAULT_MAX_FINDINGS = 200;
const DEFAULT_PERSIST_PATH = resolve(homedir(), '.guardianagent', 'assistant-security.json');

interface PersistedAiSecurityState {
  lastRunAt?: number;
  runs?: AiSecurityRun[];
  findings?: AiSecurityFinding[];
}

const AI_SECURITY_PROFILES: AiSecurityProfile[] = [
  {
    id: 'quick',
    label: 'Quick Scan',
    description: 'Run posture checks against the current runtime and any tracked coding workspaces.',
    targetTypes: ['runtime', 'workspace'],
    focus: ['sandbox fallback posture', 'workspace trust drift', 'manual review bypasses'],
  },
  {
    id: 'runtime-hardening',
    label: 'Runtime Hardening',
    description: 'Focus on sandbox, browser, and policy-boundary risks in the active Guardian runtime.',
    targetTypes: ['runtime'],
    focus: ['sandbox containment', 'browser exposure', 'policy widening'],
  },
  {
    id: 'workspace-boundaries',
    label: 'Workspace Boundaries',
    description: 'Review coding workspaces for trust-state, prompt-injection, and manual-override risk.',
    targetTypes: ['workspace'],
    focus: ['workspace trust', 'manual acceptance drift', 'repo execution boundary'],
  },
];

export class AiSecurityService {
  private readonly enabled: boolean;
  private readonly getRuntimeSnapshotFn: () => AiSecurityRuntimeSnapshot;
  private readonly listCodeSessionsFn: () => AiSecuritySessionSnapshot[];
  private readonly persistPath: string;
  private readonly now: () => number;
  private readonly maxRuns: number;
  private readonly maxFindings: number;
  private readonly findings: AiSecurityFinding[] = [];
  private readonly runs: AiSecurityRun[] = [];
  private lastRunAt?: number;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: AiSecurityServiceOptions) {
    this.enabled = options.enabled;
    this.getRuntimeSnapshotFn = options.getRuntimeSnapshot;
    this.listCodeSessionsFn = options.listCodeSessions;
    this.persistPath = options.persistPath ?? DEFAULT_PERSIST_PATH;
    this.now = options.now ?? Date.now;
    this.maxRuns = Math.max(10, options.maxRuns ?? DEFAULT_MAX_RUNS);
    this.maxFindings = Math.max(20, options.maxFindings ?? DEFAULT_MAX_FINDINGS);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedAiSecurityState;
      this.findings.length = 0;
      for (const finding of parsed.findings ?? []) {
        const normalized = normalizePersistedFinding(finding);
        if (normalized) {
          this.findings.push(normalized);
        }
      }
      this.findings.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
      if (this.findings.length > this.maxFindings) {
        this.findings.length = this.maxFindings;
      }

      this.runs.length = 0;
      for (const run of parsed.runs ?? []) {
        const normalized = normalizePersistedRun(run);
        if (normalized) {
          this.runs.push(normalized);
        }
      }
      this.runs.sort((left, right) => right.completedAt - left.completedAt);
      if (this.runs.length > this.maxRuns) {
        this.runs.length = this.maxRuns;
      }

      this.lastRunAt = Number.isFinite(parsed.lastRunAt) ? Number(parsed.lastRunAt) : this.runs[0]?.completedAt;
    } catch {
      // First run or unreadable persisted state.
    }
  }

  async persist(): Promise<void> {
    const payload: PersistedAiSecurityState = {
      lastRunAt: this.lastRunAt,
      runs: this.runs.map(cloneRun),
      findings: this.findings.map(cloneFinding),
    };
    const writeOperation = this.persistQueue
      .catch(() => {})
      .then(() => writeSecureFile(this.persistPath, JSON.stringify(payload, null, 2), 'utf8'));
    this.persistQueue = writeOperation.catch(() => {});
    await writeOperation;
  }

  getProfiles(): AiSecurityProfile[] {
    return AI_SECURITY_PROFILES.map((profile) => ({
      ...profile,
      targetTypes: [...profile.targetTypes],
      focus: [...profile.focus],
    }));
  }

  listTargets(): AiSecurityTarget[] {
    const runtime = this.getRuntimeSnapshotFn();
    const sessions = this.listCodeSessionsFn();
    const runtimeTarget: AiSecurityTarget = {
      id: 'runtime:guardian',
      type: 'runtime',
      label: 'Guardian runtime',
      description: 'Current sandbox, browser, and policy posture for the running assistant.',
      riskLevel: deriveRuntimeRisk(runtime),
      ready: this.enabled,
      metadata: {
        sandboxAvailability: runtime.sandbox.availability,
        sandboxEnforcementMode: runtime.sandbox.enforcementMode,
        sandboxBackend: runtime.sandbox.backend,
        degradedFallbackActive: runtime.sandbox.degradedFallbackActive,
      },
    };

    const workspaceTargets = dedupeSessionsByWorkspace(sessions).map((session) => ({
      id: `workspace:${session.sessionId}`,
      type: 'workspace' as const,
      label: session.title || basenamePath(session.workspaceRoot),
      description: session.workspaceRoot,
      riskLevel: deriveWorkspaceRisk(session.workspaceTrust, session.workspaceTrustReview),
      ready: !!session.workspaceTrust,
      metadata: {
        workspaceRoot: session.workspaceRoot,
        trustState: session.workspaceTrust?.state ?? 'pending',
        reviewed: isWorkspaceReviewActive(session.workspaceTrust, session.workspaceTrustReview),
      },
    }));

    return [runtimeTarget, ...workspaceTargets];
  }

  getSummary(): AiSecuritySummary {
    const runtime = this.getRuntimeSnapshotFn();
    const targets = this.listTargets();
    return {
      enabled: this.enabled,
      profileCount: AI_SECURITY_PROFILES.length,
      targetCount: targets.length,
      readyTargetCount: targets.filter((target) => target.ready).length,
      lastRunAt: this.lastRunAt,
      findings: {
        total: this.findings.length,
        new: this.findings.filter((finding) => finding.status === 'new').length,
        highOrCritical: this.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').length,
      },
      posture: {
        availability: runtime.sandbox.availability,
        enforcementMode: runtime.sandbox.enforcementMode,
        degradedFallbackActive: runtime.sandbox.degradedFallbackActive,
        confidence: runtime.sandbox.availability === 'strong' ? 'bounded' : 'reduced',
      },
    };
  }

  listRuns(limit = 20): AiSecurityRun[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    return this.runs.slice(0, safeLimit).map(cloneRun);
  }

  listFindings(limit = 50, status?: AiSecurityFindingStatus): AiSecurityFinding[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50;
    return this.findings
      .filter((finding) => !status || finding.status === status)
      .slice(0, safeLimit)
      .map(cloneFinding);
  }

  updateFindingStatus(findingId: string, status: AiSecurityFindingStatus): { success: boolean; message: string } {
    const finding = this.findings.find((entry) => entry.id === findingId);
    if (!finding) {
      return { success: false, message: `Finding '${findingId}' was not found.` };
    }
    finding.status = status;
    this.persist().catch(() => {});
    return { success: true, message: `Finding '${finding.title}' updated to ${status}.` };
  }

  async scan(input?: AiSecurityScanInput): Promise<AiSecurityScanResult> {
    const now = this.now();
    const profile = resolveProfile(input?.profileId);
    const allTargets = this.listTargets();
    const selectedTargets = filterTargetsForScan(allTargets, profile, input?.targetIds);
    const findings = this.evaluateTargets(selectedTargets, now);
    const promotedFindings = findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical');

    const run: AiSecurityRun = {
      id: randomUUID(),
      source: input?.source ?? 'manual',
      profileId: profile.id,
      profileLabel: profile.label,
      startedAt: now,
      completedAt: now,
      success: true,
      message: findings.length > 0
        ? `Detected ${findings.length} posture finding${findings.length === 1 ? '' : 's'} across ${selectedTargets.length} target${selectedTargets.length === 1 ? '' : 's'}.`
        : `No Assistant Security posture issues were detected across ${selectedTargets.length} target${selectedTargets.length === 1 ? '' : 's'}.`,
      targetCount: selectedTargets.length,
      findingCount: findings.length,
      highOrCriticalCount: promotedFindings.length,
    };

    this.runs.unshift(run);
    if (this.runs.length > this.maxRuns) {
      this.runs.length = this.maxRuns;
    }
    this.lastRunAt = now;
    this.persist().catch(() => {});

    return {
      success: true,
      message: run.message,
      run: cloneRun(run),
      findings: findings.map(cloneFinding),
      promotedFindings: promotedFindings.map(cloneFinding),
    };
  }

  private evaluateTargets(targets: AiSecurityTarget[], observedAt: number): AiSecurityFinding[] {
    const runtime = this.getRuntimeSnapshotFn();
    const sessionsById = new Map<string, AiSecuritySessionSnapshot>(
      this.listCodeSessionsFn().map((session) => [`workspace:${session.sessionId}`, session] as const),
    );
    const findings: AiSecurityFinding[] = [];

    for (const target of targets) {
      if (target.type === 'runtime') {
        findings.push(...this.evaluateRuntimeTarget(target, runtime, observedAt));
        continue;
      }

      const session = sessionsById.get(target.id);
      if (!session) continue;
      findings.push(...this.evaluateWorkspaceTarget(target, session, observedAt));
    }

    return findings.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  }

  private evaluateRuntimeTarget(
    target: AiSecurityTarget,
    runtime: AiSecurityRuntimeSnapshot,
    observedAt: number,
  ): AiSecurityFinding[] {
    const findings: AiSecurityFinding[] = [];
    const degraded = runtime.sandbox.degradedFallbackActive;

    if (!runtime.sandbox.enabled) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:sandbox-disabled`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'sandbox',
        severity: 'critical',
        confidence: 0.98,
        title: 'Sandbox isolation is disabled',
        summary: 'Subprocess-backed assistant work is running without OS sandbox isolation.',
        observedAt,
        evidence: [{
          kind: 'sandbox',
          summary: 'assistant.tools.sandbox.enabled is false',
          details: {
            availability: runtime.sandbox.availability,
            enforcementMode: runtime.sandbox.enforcementMode,
          },
        }],
      }));
    } else if (degraded && runtime.sandbox.enforcementMode !== 'strict') {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:degraded-permissive`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'sandbox',
        severity: 'high',
        confidence: 0.93,
        title: 'Degraded sandbox fallback is active',
        summary: 'The host is not on a strong sandbox backend, so risky AI-driven actions rely on degraded fallback safeguards.',
        observedAt,
        evidence: [{
          kind: 'sandbox',
          summary: 'Sandbox is permissive while availability is not strong',
          details: {
            availability: runtime.sandbox.availability,
            enforcementMode: runtime.sandbox.enforcementMode,
            backend: runtime.sandbox.backend,
          },
        }],
      }));
    }

    if (degraded && runtime.sandbox.degradedFallback.allowNetworkTools) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:degraded-network-tools`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'trust_boundary',
        severity: 'high',
        confidence: 0.91,
        title: 'Network tools are enabled on a degraded backend',
        summary: 'Network and web-search tools remain available even though the host is not on a strong sandbox backend.',
        observedAt,
        evidence: [{
          kind: 'sandbox',
          summary: 'Degraded fallback allows network tools',
          details: {
            availability: runtime.sandbox.availability,
          },
        }],
      }));
    }

    if (degraded && runtime.sandbox.degradedFallback.allowBrowserTools && runtime.browser.enabled) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:degraded-browser-tools`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'browser',
        severity: 'high',
        confidence: 0.9,
        title: 'Browser automation is enabled on a degraded backend',
        summary: 'Browser automation stays available while strong sandbox isolation is unavailable, which widens host and session exposure.',
        observedAt,
        evidence: [{
          kind: 'sandbox',
          summary: 'Degraded fallback allows browser tools',
          details: {
            browserEnabled: runtime.browser.enabled,
            allowedDomains: runtime.browser.allowedDomains,
          },
        }],
      }));
    }

    if (degraded && runtime.sandbox.degradedFallback.allowManualCodeTerminals) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:degraded-manual-terminal`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'trust_boundary',
        severity: 'high',
        confidence: 0.92,
        title: 'Manual code terminals are enabled on a degraded backend',
        summary: 'Manual PTY access is available even though strong sandbox isolation is unavailable on this host.',
        observedAt,
        evidence: [{
          kind: 'sandbox',
          summary: 'Degraded fallback allows manual code terminals',
        }],
      }));
    }

    const connectedThirdPartyServers = runtime.mcp.thirdPartyServers.filter((server) => server.connected);

    if (runtime.mcp.enabled && runtime.mcp.connectedThirdPartyServerCount > 0) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:mcp-third-party-connected`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'mcp',
        severity: degraded ? 'high' : 'medium',
        confidence: 0.84,
        title: 'Connected third-party MCP servers are active',
        summary: `Guardian currently has ${runtime.mcp.connectedThirdPartyServerCount} connected third-party MCP server${runtime.mcp.connectedThirdPartyServerCount === 1 ? '' : 's'}, which expands subprocess, network, and tool-metadata trust surface.`,
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'assistant.tools.mcp.enabled with connected third-party MCP servers',
          details: {
            configuredCount: runtime.mcp.configuredThirdPartyServerCount,
            connectedCount: runtime.mcp.connectedThirdPartyServerCount,
            servers: connectedThirdPartyServers.map((server) => ({
              id: server.id,
              name: server.name,
              command: server.command,
            })),
          },
        }],
      }));
    }

    const networkedServers = connectedThirdPartyServers.filter((server) => server.networkAccess);
    if (networkedServers.length > 0) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:mcp-network-access`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'mcp',
        severity: 'high',
        confidence: 0.9,
        title: 'Third-party MCP servers have outbound network access',
        summary: 'One or more connected third-party MCP servers can make outbound network requests outside the built-in tool allowlist path.',
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'Connected third-party MCP servers with networkAccess: true',
          details: {
            servers: networkedServers.map((server) => ({
              id: server.id,
              name: server.name,
              command: server.command,
            })),
          },
        }],
      }));
    }

    const inheritEnvServers = connectedThirdPartyServers.filter((server) => server.inheritEnv);
    if (inheritEnvServers.length > 0) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:mcp-inherit-env`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'mcp',
        severity: 'high',
        confidence: 0.88,
        title: 'Third-party MCP servers inherit the parent environment',
        summary: 'One or more connected third-party MCP servers inherit Guardian process environment variables, which increases credential and secret exposure risk.',
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'Connected third-party MCP servers with inheritEnv: true',
          details: {
            servers: inheritEnvServers.map((server) => ({
              id: server.id,
              name: server.name,
              allowedEnvKeyCount: server.allowedEnvKeyCount,
            })),
          },
        }],
      }));
    }

    const envScopedServers = connectedThirdPartyServers.filter((server) => server.envKeyCount > 0);
    if (envScopedServers.length > 0) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:mcp-env-exposure`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'mcp',
        severity: 'medium',
        confidence: 0.77,
        title: 'Connected MCP servers receive explicit environment variables',
        summary: 'One or more connected MCP server definitions inject environment variables directly into server subprocesses, which increases credential and secret exposure risk.',
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'Connected MCP servers with explicit env injection',
          details: {
            servers: envScopedServers.map((server) => ({
              id: server.id,
              name: server.name,
              envKeyCount: server.envKeyCount,
            })),
          },
        }],
      }));
    }

    const trustOverrideServers = connectedThirdPartyServers.filter((server) => typeof server.trustLevel === 'string' && server.trustLevel.trim().length > 0);
    if (trustOverrideServers.length > 0) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:mcp-trust-override`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'mcp',
        severity: 'medium',
        confidence: 0.83,
        title: 'Third-party MCP trust overrides are configured',
        summary: 'One or more connected third-party MCP servers use an explicit trust-level override, which can make broad tool surfaces look safer than they really are if set too loosely.',
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'Connected third-party MCP servers with explicit trustLevel overrides',
          details: {
            servers: trustOverrideServers.map((server) => ({
              id: server.id,
              name: server.name,
              trustLevel: server.trustLevel,
            })),
          },
        }],
      }));
    }

    if (runtime.browser.enabled && runtime.browser.playwrightEnabled && runtime.mcp.usesDynamicPlaywrightPackage) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:playwright-mcp-latest`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'browser',
        severity: 'high',
        confidence: 0.9,
        title: 'Playwright MCP uses dynamic package resolution',
        summary: 'The browser MCP startup path uses a dynamically resolved Playwright MCP package instead of a pinned version.',
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'Playwright MCP startup uses dynamic package resolution',
        }],
      }));
    }

    if (runtime.agentPolicyUpdates.allowedPaths || runtime.agentPolicyUpdates.allowedDomains || runtime.agentPolicyUpdates.toolPolicies) {
      const enabledScopes = [
        runtime.agentPolicyUpdates.allowedPaths ? 'allowed paths' : null,
        runtime.agentPolicyUpdates.allowedDomains ? 'allowed domains' : null,
        runtime.agentPolicyUpdates.toolPolicies ? 'tool policies' : null,
      ].filter(Boolean);
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:agent-policy-widening`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'policy',
        severity: enabledScopes.length > 1 ? 'high' : 'medium',
        confidence: 0.88,
        title: 'Agent-initiated policy widening is enabled',
        summary: `The assistant can update ${enabledScopes.join(', ')} from chat, which increases the chance of prompt-driven boundary expansion.`,
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'assistant.tools.agentPolicyUpdates allows boundary changes',
          details: {
            ...runtime.agentPolicyUpdates,
          },
        }],
      }));
    }

    if (runtime.browser.enabled && runtime.browser.allowedDomains.length === 0) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:browser-domain-open`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'browser',
        severity: 'medium',
        confidence: 0.74,
        title: 'Browser tooling has no explicit domain allowlist',
        summary: 'Browser tooling is enabled without configured allowed domains, so browser scope depends on broader runtime policy rather than a local allowlist.',
        observedAt,
        evidence: [{
          kind: 'policy',
          summary: 'assistant.tools.browser.allowedDomains is empty',
        }],
      }));
    }

    return findings;
  }

  private evaluateWorkspaceTarget(
    target: AiSecurityTarget,
    session: AiSecuritySessionSnapshot,
    observedAt: number,
  ): AiSecurityFinding[] {
    const findings: AiSecurityFinding[] = [];
    const assessment = session.workspaceTrust;
    const review = session.workspaceTrustReview;

    if (!assessment) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:trust-pending`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'workspace',
        severity: 'low',
        confidence: 0.66,
        title: 'Workspace trust has not been assessed yet',
        summary: 'This coding workspace does not yet have a recorded trust assessment, so repo-execution safeguards should be treated conservatively.',
        observedAt,
        evidence: [{
          kind: 'workspace',
          summary: session.workspaceRoot,
        }],
      }));
      return findings;
    }

    const reviewActive = isWorkspaceReviewActive(assessment, review);
    if (assessment.state === 'blocked') {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:workspace-blocked`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'workspace',
        severity: reviewActive ? 'medium' : 'high',
        confidence: 0.95,
        title: reviewActive ? 'Blocked workspace was manually accepted' : 'Workspace trust is blocked',
        summary: reviewActive
          ? 'The workspace was flagged as blocked but is currently covered by a manual trust acceptance, so execution boundaries rely on that review remaining valid.'
          : assessment.summary,
        observedAt,
        evidence: [{
          kind: reviewActive ? 'review' : 'workspace',
          summary: reviewActive ? `Accepted by ${review?.reviewedBy ?? 'unknown'} at ${review?.reviewedAt ?? 0}` : assessment.summary,
          details: {
            workspaceRoot: session.workspaceRoot,
            findingCount: assessment.findings.length,
            rawState: assessment.state,
          },
        }],
      }));
    } else if (assessment.state === 'caution' && !reviewActive) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:workspace-caution`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: 'workspace',
        severity: 'medium',
        confidence: 0.84,
        title: 'Workspace trust is in caution state',
        summary: assessment.summary,
        observedAt,
        evidence: [{
          kind: 'workspace',
          summary: assessment.summary,
          details: {
            workspaceRoot: session.workspaceRoot,
            findingCount: assessment.findings.length,
          },
        }],
      }));
    }

    const highRiskFindings = assessment.findings.filter((finding) => finding.severity === 'high').slice(0, 3);
    for (const finding of highRiskFindings) {
      findings.push(this.upsertFinding({
        dedupeKey: `${target.id}:workspace-finding:${finding.kind}:${finding.path}`,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        category: finding.kind === 'prompt_injection' ? 'trust_boundary' : 'workspace',
        severity: 'high',
        confidence: 0.86,
        title: `Workspace contains ${formatWorkspaceFindingKind(finding.kind)}`,
        summary: `${finding.summary} (${finding.path})`,
        observedAt,
        evidence: [{
          kind: 'workspace',
          summary: finding.summary,
          details: {
            path: finding.path,
            evidence: finding.evidence,
          },
        }],
      }));
    }

    return findings;
  }

  private upsertFinding(input: {
    dedupeKey: string;
    targetId: string;
    targetType: AiSecurityTargetType;
    targetLabel: string;
    category: AiSecurityFindingCategory;
    severity: AiSecuritySeverity;
    confidence: number;
    title: string;
    summary: string;
    observedAt: number;
    evidence: AiSecurityFindingEvidence[];
  }): AiSecurityFinding {
    const existing = this.findings.find((finding) => finding.dedupeKey === input.dedupeKey);
    if (existing) {
      existing.lastSeenAt = input.observedAt;
      existing.occurrenceCount += 1;
      existing.severity = input.severity;
      existing.confidence = input.confidence;
      existing.title = input.title;
      existing.summary = input.summary;
      existing.targetLabel = input.targetLabel;
      existing.evidence = input.evidence.map(cloneEvidence);
      return existing;
    }

    const created: AiSecurityFinding = {
      id: randomUUID(),
      dedupeKey: input.dedupeKey,
      targetId: input.targetId,
      targetType: input.targetType,
      targetLabel: input.targetLabel,
      category: input.category,
      severity: input.severity,
      confidence: input.confidence,
      status: 'new',
      title: input.title,
      summary: input.summary,
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
      occurrenceCount: 1,
      evidence: input.evidence.map(cloneEvidence),
    };
    this.findings.unshift(created);
    this.findings.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    if (this.findings.length > this.maxFindings) {
      this.findings.length = this.maxFindings;
    }
    return created;
  }
}

function resolveProfile(profileId?: string): AiSecurityProfile {
  return AI_SECURITY_PROFILES.find((profile) => profile.id === profileId) ?? AI_SECURITY_PROFILES[0];
}

function filterTargetsForScan(
  targets: AiSecurityTarget[],
  profile: AiSecurityProfile,
  targetIds?: string[],
): AiSecurityTarget[] {
  const allowedTypes = new Set(profile.targetTypes);
  const selectedIds = new Set((targetIds ?? []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
  const scoped = targets.filter((target) => allowedTypes.has(target.type));
  if (selectedIds.size === 0) return scoped;
  return scoped.filter((target) => selectedIds.has(target.id));
}

function dedupeSessionsByWorkspace(sessions: AiSecuritySessionSnapshot[]): AiSecuritySessionSnapshot[] {
  const seen = new Set<string>();
  const deduped: AiSecuritySessionSnapshot[] = [];
  for (const session of sessions) {
    const key = `${session.workspaceRoot}::${session.workspaceTrust?.assessedAt ?? 'pending'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(session);
  }
  return deduped;
}

function deriveRuntimeRisk(snapshot: AiSecurityRuntimeSnapshot): AiSecurityTarget['riskLevel'] {
  if (!snapshot.sandbox.enabled || (snapshot.sandbox.degradedFallbackActive && snapshot.sandbox.enforcementMode !== 'strict')) {
    return 'high';
  }
  if (
    snapshot.browser.enabled
    || snapshot.mcp.connectedThirdPartyServerCount > 0
    || snapshot.agentPolicyUpdates.allowedPaths
    || snapshot.agentPolicyUpdates.allowedDomains
    || snapshot.agentPolicyUpdates.toolPolicies
  ) {
    return 'elevated';
  }
  return 'normal';
}

function deriveWorkspaceRisk(
  assessment: CodeWorkspaceTrustAssessment | null,
  review: CodeWorkspaceTrustReview | null,
): AiSecurityTarget['riskLevel'] {
  if (!assessment) return 'elevated';
  if (assessment.state === 'blocked' && !isWorkspaceReviewActive(assessment, review)) return 'high';
  if (assessment.state === 'caution' || isWorkspaceReviewActive(assessment, review)) return 'elevated';
  return 'normal';
}

function isWorkspaceReviewActive(
  assessment: CodeWorkspaceTrustAssessment | null,
  review: CodeWorkspaceTrustReview | null,
): boolean {
  if (!assessment || !review) return false;
  return review.decision === 'accepted'
    && review.assessmentFingerprint === getCodeWorkspaceTrustAssessmentFingerprint(assessment);
}

function cloneFinding(finding: AiSecurityFinding): AiSecurityFinding {
  return {
    ...finding,
    evidence: finding.evidence.map(cloneEvidence),
  };
}

function cloneRun(run: AiSecurityRun): AiSecurityRun {
  return { ...run };
}

function cloneEvidence(evidence: AiSecurityFindingEvidence): AiSecurityFindingEvidence {
  return {
    ...evidence,
    details: evidence.details ? { ...evidence.details } : undefined,
  };
}

function normalizePersistedFinding(value: unknown): AiSecurityFinding | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const severity = typeof record.severity === 'string' && isAiSecuritySeverity(record.severity)
    ? record.severity
    : null;
  const status = typeof record.status === 'string' && isAiSecurityFindingStatus(record.status)
    ? record.status
    : null;
  const category = typeof record.category === 'string' && isAiSecurityFindingCategory(record.category)
    ? record.category
    : null;
  const targetType = typeof record.targetType === 'string' && isAiSecurityTargetType(record.targetType)
    ? record.targetType
    : null;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
  const dedupeKey = typeof record.dedupeKey === 'string' && record.dedupeKey.trim() ? record.dedupeKey.trim() : null;
  const targetId = typeof record.targetId === 'string' && record.targetId.trim() ? record.targetId.trim() : null;
  const targetLabel = typeof record.targetLabel === 'string' && record.targetLabel.trim() ? record.targetLabel.trim() : null;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : null;
  const summary = typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : null;
  const confidence = Number(record.confidence);
  const firstSeenAt = Number(record.firstSeenAt);
  const lastSeenAt = Number(record.lastSeenAt);
  const occurrenceCount = Number(record.occurrenceCount);
  if (!severity || !status || !category || !targetType || !id || !dedupeKey || !targetId || !targetLabel || !title || !summary) {
    return null;
  }
  if (!Number.isFinite(confidence) || !Number.isFinite(firstSeenAt) || !Number.isFinite(lastSeenAt) || !Number.isFinite(occurrenceCount)) {
    return null;
  }
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
      .map(normalizePersistedEvidence)
      .filter((entry): entry is AiSecurityFindingEvidence => entry !== null)
    : [];
  return {
    id,
    dedupeKey,
    targetId,
    targetType,
    targetLabel,
    category,
    severity,
    confidence,
    status,
    title,
    summary,
    firstSeenAt,
    lastSeenAt,
    occurrenceCount,
    evidence,
  };
}

function normalizePersistedRun(value: unknown): AiSecurityRun | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const source = typeof record.source === 'string' && isAiSecurityRunSource(record.source)
    ? record.source
    : null;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
  const profileId = typeof record.profileId === 'string' && record.profileId.trim() ? record.profileId.trim() : null;
  const profileLabel = typeof record.profileLabel === 'string' && record.profileLabel.trim() ? record.profileLabel.trim() : null;
  const message = typeof record.message === 'string' ? record.message : '';
  const startedAt = Number(record.startedAt);
  const completedAt = Number(record.completedAt);
  const targetCount = Number(record.targetCount);
  const findingCount = Number(record.findingCount);
  const highOrCriticalCount = Number(record.highOrCriticalCount);
  const success = record.success === true;
  if (!source || !id || !profileId || !profileLabel) return null;
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || !Number.isFinite(targetCount) || !Number.isFinite(findingCount) || !Number.isFinite(highOrCriticalCount)) {
    return null;
  }
  return {
    id,
    source,
    profileId,
    profileLabel,
    startedAt,
    completedAt,
    success,
    message,
    targetCount,
    findingCount,
    highOrCriticalCount,
  };
}

function normalizePersistedEvidence(value: unknown): AiSecurityFindingEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' && ['sandbox', 'policy', 'workspace', 'review'].includes(record.kind)
    ? record.kind as AiSecurityFindingEvidence['kind']
    : null;
  const summary = typeof record.summary === 'string' ? record.summary : '';
  if (!kind) return null;
  return {
    kind,
    summary,
    details: record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? { ...(record.details as Record<string, unknown>) }
      : undefined,
  };
}

function isAiSecuritySeverity(value: string): value is AiSecuritySeverity {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function isAiSecurityFindingStatus(value: string): value is AiSecurityFindingStatus {
  return value === 'new' || value === 'triaged' || value === 'resolved' || value === 'suppressed';
}

function isAiSecurityFindingCategory(value: string): value is AiSecurityFindingCategory {
  return value === 'sandbox'
    || value === 'policy'
    || value === 'browser'
    || value === 'mcp'
    || value === 'workspace'
    || value === 'trust_boundary';
}

function isAiSecurityTargetType(value: string): value is AiSecurityTargetType {
  return value === 'runtime' || value === 'workspace';
}

function isAiSecurityRunSource(value: string): value is AiSecurityRunSource {
  return value === 'manual' || value === 'scheduled' || value === 'system';
}

function severityRank(severity: AiSecuritySeverity): number {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    default: return 1;
  }
}

function formatWorkspaceFindingKind(kind: string): string {
  return kind.replaceAll('_', ' ');
}

function basenamePath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] || value;
}

export function createAiSecuritySessionSnapshot(session: CodeSessionRecord): AiSecuritySessionSnapshot {
  return {
    sessionId: session.id,
    title: session.title,
    workspaceRoot: session.resolvedRoot,
    workspaceTrust: session.workState.workspaceTrust,
    workspaceTrustReview: session.workState.workspaceTrustReview,
  };
}
