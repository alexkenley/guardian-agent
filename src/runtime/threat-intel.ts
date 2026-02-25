/**
 * Threat intelligence orchestration for personal-assistant protection.
 *
 * This service is intentionally conservative:
 * - collection and triage can be automated
 * - external response actions remain human-approved by default
 */

import { randomUUID } from 'node:crypto';
import type { ForumConnector, ForumConnectorStatus } from './forum-connector.js';

export type IntelSourceType =
  | 'web'
  | 'news'
  | 'social'
  | 'forum'
  | 'darkweb';

export type IntelContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'mixed';

export type IntelSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IntelStatus = 'new' | 'triaged' | 'actioned' | 'dismissed';
export type IntelActionType = 'report' | 'request_takedown' | 'draft_response' | 'publish_response';
export type IntelActionStatus = 'proposed' | 'approved' | 'executed' | 'blocked';
export type IntelResponseMode = 'manual' | 'assisted' | 'autonomous';

export interface ThreatIntelFinding {
  id: string;
  createdAt: number;
  target: string;
  sourceType: IntelSourceType;
  contentType: IntelContentType;
  severity: IntelSeverity;
  confidence: number;
  summary: string;
  url?: string;
  status: IntelStatus;
  labels: string[];
}

export interface ThreatIntelAction {
  id: string;
  findingId: string;
  createdAt: number;
  type: IntelActionType;
  status: IntelActionStatus;
  requiresApproval: boolean;
  rationale: string;
  targetUrl?: string;
  draftText?: string;
}

export interface ThreatIntelSummary {
  enabled: boolean;
  lastScanAt?: number;
  watchlistCount: number;
  darkwebEnabled: boolean;
  responseMode: IntelResponseMode;
  forumConnectors: ForumConnectorStatus[];
  findings: {
    total: number;
    new: number;
    highOrCritical: number;
  };
}

export interface ThreatIntelPlanItem {
  phase: string;
  objective: string;
  deliverables: string[];
}

export interface ThreatIntelPlan {
  title: string;
  principles: string[];
  phases: ThreatIntelPlanItem[];
}

export interface ThreatIntelScanInput {
  query?: string;
  includeDarkWeb?: boolean;
  sources?: IntelSourceType[];
}

export interface ThreatIntelServiceOptions {
  enabled: boolean;
  allowDarkWeb: boolean;
  responseMode: IntelResponseMode;
  watchlist: string[];
  forumConnectors?: ForumConnector[];
  now?: () => number;
}

const DEFAULT_PLAN: ThreatIntelPlan = {
  title: 'GuardianAgent Threat Intel Operating Plan',
  principles: [
    'Protect users with evidence-based monitoring, not speculation.',
    'Prioritize identity abuse and deepfake risk by severity and confidence.',
    'Keep active response human-approved by default.',
    'Log every response decision for auditability.',
  ],
  phases: [
    {
      phase: 'Phase 1 - Discover',
      objective: 'Continuously monitor configured targets across open sources.',
      deliverables: [
        'Watchlist collection jobs',
        'Deepfake / impersonation classification',
        'Finding queue with severity + confidence',
      ],
    },
    {
      phase: 'Phase 2 - Triage',
      objective: 'Reduce false positives and focus analyst time.',
      deliverables: [
        'Rule-based prioritization',
        'Source reliability scoring',
        'Analyst status workflows (triaged/dismissed/actioned)',
      ],
    },
    {
      phase: 'Phase 3 - Respond',
      objective: 'Generate safe, policy-compliant countermeasures.',
      deliverables: [
        'Takedown/report templates',
        'Forum/social response drafts',
        'Human approval gate before publishing',
      ],
    },
    {
      phase: 'Phase 4 - Learn',
      objective: 'Improve coverage and response outcomes over time.',
      deliverables: [
        'Precision/recall feedback loop',
        'Response success metrics',
        'Playbook versioning per threat category',
      ],
    },
  ],
};

/**
 * In-memory threat intelligence service.
 *
 * Collection connectors (web/news/forum/darkweb) are intentionally abstracted so
 * production implementations can swap in compliant data providers.
 */
export class ThreatIntelService {
  private readonly enabled: boolean;
  private readonly allowDarkWeb: boolean;
  private responseMode: IntelResponseMode;
  private readonly now: () => number;
  private readonly forumConnectors: ForumConnector[];
  private readonly watchlist = new Set<string>();
  private readonly findings: ThreatIntelFinding[] = [];
  private readonly actions: ThreatIntelAction[] = [];
  private lastScanAt?: number;

  constructor(options: ThreatIntelServiceOptions) {
    this.enabled = options.enabled;
    this.allowDarkWeb = options.allowDarkWeb;
    this.responseMode = options.responseMode;
    this.now = options.now ?? Date.now;
    this.forumConnectors = options.forumConnectors ?? [];
    for (const target of options.watchlist) {
      const normalized = normalizeTarget(target);
      if (normalized) this.watchlist.add(normalized);
    }
  }

  getPlan(): ThreatIntelPlan {
    return DEFAULT_PLAN;
  }

  getSummary(): ThreatIntelSummary {
    const newFindings = this.findings.filter((f) => f.status === 'new').length;
    const highOrCritical = this.findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length;
    return {
      enabled: this.enabled,
      lastScanAt: this.lastScanAt,
      watchlistCount: this.watchlist.size,
      darkwebEnabled: this.allowDarkWeb,
      responseMode: this.responseMode,
      forumConnectors: this.forumConnectors.map((connector) => connector.status()),
      findings: {
        total: this.findings.length,
        new: newFindings,
        highOrCritical,
      },
    };
  }

  listWatchlist(): string[] {
    return [...this.watchlist.values()];
  }

  addWatchTarget(target: string): { success: boolean; message: string } {
    const normalized = normalizeTarget(target);
    if (!normalized) {
      return { success: false, message: 'Target cannot be empty.' };
    }
    if (this.watchlist.has(normalized)) {
      return { success: false, message: `Target '${normalized}' is already on watchlist.` };
    }
    this.watchlist.add(normalized);
    return { success: true, message: `Added '${normalized}' to watchlist.` };
  }

  removeWatchTarget(target: string): { success: boolean; message: string } {
    const normalized = normalizeTarget(target);
    if (!normalized) {
      return { success: false, message: 'Target cannot be empty.' };
    }
    const removed = this.watchlist.delete(normalized);
    if (!removed) {
      return { success: false, message: `Target '${normalized}' was not found.` };
    }
    return { success: true, message: `Removed '${normalized}' from watchlist.` };
  }

  setResponseMode(mode: IntelResponseMode): { success: boolean; message: string } {
    this.responseMode = mode;
    if (mode === 'autonomous') {
      return {
        success: true,
        message: 'Response mode set to autonomous. Human approval is still required for publish actions.',
      };
    }
    return { success: true, message: `Response mode set to ${mode}.` };
  }

  async scan(input: ThreatIntelScanInput = {}): Promise<{
    success: boolean;
    message: string;
    findings: ThreatIntelFinding[];
  }> {
    if (!this.enabled) {
      return { success: false, message: 'Threat intel is disabled.', findings: [] };
    }

    const query = input.query ? normalizeTarget(input.query) : undefined;
    const targets = query ? [query] : this.listWatchlist();
    if (targets.length === 0) {
      return {
        success: false,
        message: 'No watch targets configured. Add targets with /intel watch add <target>.',
        findings: [],
      };
    }

    const includeDarkWeb = !!input.includeDarkWeb && this.allowDarkWeb;
    const scanSources = buildSources(input.sources, includeDarkWeb);
    const created: ThreatIntelFinding[] = [];
    const includeForum = scanSources.includes('forum');
    const nonForumSources = scanSources.filter((source) => source !== 'forum');

    for (const target of targets) {
      for (const sourceType of nonForumSources) {
        const severity = classifySeverity(target, sourceType);
        const confidence = classifyConfidence(target, sourceType);
        const finding: ThreatIntelFinding = {
          id: randomUUID(),
          createdAt: this.now(),
          target,
          sourceType,
          contentType: inferContentType(target),
          severity,
          confidence,
          summary: buildSummary(target, sourceType, severity),
          status: 'new',
          labels: buildLabels(target, sourceType),
        };
        this.findings.unshift(finding);
        created.push(finding);
      }
    }

    if (includeForum) {
      const forumFindings = await this.scanForumSources(targets);
      this.findings.unshift(...forumFindings);
      created.push(...forumFindings);
    }

    this.lastScanAt = this.now();
    return {
      success: true,
      message: `Scan completed across ${scanSources.length} source(s) for ${targets.length} target(s).`,
      findings: created,
    };
  }

  listFindings(limit = 50, status?: IntelStatus): ThreatIntelFinding[] {
    const filtered = status
      ? this.findings.filter((finding) => finding.status === status)
      : this.findings;
    return filtered.slice(0, Math.max(1, limit));
  }

  getFinding(id: string): ThreatIntelFinding | null {
    return this.findings.find((finding) => finding.id === id) ?? null;
  }

  updateFindingStatus(id: string, status: IntelStatus): { success: boolean; message: string } {
    const finding = this.findings.find((item) => item.id === id);
    if (!finding) return { success: false, message: `Finding '${id}' not found.` };
    finding.status = status;
    return { success: true, message: `Finding '${id}' marked ${status}.` };
  }

  draftAction(findingId: string, type: IntelActionType): { success: boolean; action?: ThreatIntelAction; message: string } {
    const finding = this.getFinding(findingId);
    if (!finding) {
      return { success: false, message: `Finding '${findingId}' not found.` };
    }

    if (type === 'publish_response' && finding.sourceType === 'forum') {
      const blockingConnector = this.forumConnectors.find(
        (connector) => finding.labels.includes(connector.id) && !connector.allowsActivePublishing(),
      );
      if (blockingConnector) {
        return {
          success: false,
          message: `Publish response blocked for hostile forum '${blockingConnector.id}'. Use draft_response with human approval.`,
        };
      }
    }

    const requiresApproval = type === 'publish_response' || type === 'request_takedown' || type === 'report';
    const action: ThreatIntelAction = {
      id: randomUUID(),
      findingId,
      createdAt: this.now(),
      type,
      status: 'proposed',
      requiresApproval,
      rationale: `Proposed ${type} for ${finding.target} (${finding.severity}).`,
      targetUrl: finding.url,
      draftText: type.includes('response')
        ? `Potential response draft for target '${finding.target}': This content appears misleading or harmful. Please review sources and verify authenticity before sharing.`
        : undefined,
    };
    this.actions.unshift(action);
    return { success: true, action, message: `Action '${type}' drafted.` };
  }

  listActions(limit = 50): ThreatIntelAction[] {
    return this.actions.slice(0, Math.max(1, limit));
  }

  private async scanForumSources(targets: string[]): Promise<ThreatIntelFinding[]> {
    if (this.forumConnectors.length === 0) {
      const fallback: ThreatIntelFinding[] = [];
      for (const target of targets) {
        const severity = classifySeverity(target, 'forum');
        fallback.push({
          id: randomUUID(),
          createdAt: this.now(),
          target,
          sourceType: 'forum',
          contentType: inferContentType(target),
          severity,
          confidence: classifyConfidence(target, 'forum'),
          summary: buildSummary(target, 'forum', severity),
          status: 'new',
          labels: buildLabels(target, 'forum'),
        });
      }
      return fallback;
    }

    const created: ThreatIntelFinding[] = [];
    const dedupe = new Set<string>();

    for (const connector of this.forumConnectors) {
      const findings = await connector.scan(targets);
      for (const connectorFinding of findings) {
        const target = normalizeTarget(connectorFinding.target);
        const severity = connectorFinding.severity ?? classifySeverity(target, 'forum');
        const confidence = connectorFinding.confidence ?? classifyConfidence(target, 'forum');
        const key = `${target}|${connectorFinding.url ?? ''}|${connectorFinding.summary}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);

        const labels = new Set<string>([
          ...buildLabels(target, 'forum'),
          connector.id,
          ...(connectorFinding.labels ?? []),
        ]);

        created.push({
          id: randomUUID(),
          createdAt: this.now(),
          target,
          sourceType: 'forum',
          contentType: connectorFinding.contentType ?? inferContentType(connectorFinding.summary),
          severity,
          confidence,
          summary: connectorFinding.summary,
          url: connectorFinding.url,
          status: 'new',
          labels: [...labels],
        });
      }
    }

    return created;
  }
}

function normalizeTarget(target: string): string {
  return target.trim().toLowerCase();
}

function buildSources(explicitSources: IntelSourceType[] | undefined, includeDarkWeb: boolean): IntelSourceType[] {
  const base: IntelSourceType[] = explicitSources && explicitSources.length > 0
    ? [...new Set(explicitSources)]
    : ['web', 'news', 'social', 'forum'];
  if (includeDarkWeb && !base.includes('darkweb')) {
    base.push('darkweb');
  }
  return base;
}

function inferContentType(target: string): IntelContentType {
  if (target.includes('image') || target.includes('photo') || target.includes('deepfake')) {
    return 'image';
  }
  if (target.includes('video')) return 'video';
  if (target.includes('voice') || target.includes('audio')) return 'audio';
  return 'text';
}

function classifySeverity(target: string, source: IntelSourceType): IntelSeverity {
  const highRiskTerms = ['deepfake', 'impersonation', 'leak', 'dox', 'fraud', 'scam', 'extortion'];
  const criticalTerms = ['sexual', 'ncII', 'revenge', 'blackmail'];
  if (criticalTerms.some((term) => target.includes(term))) return 'critical';
  if (highRiskTerms.some((term) => target.includes(term))) return source === 'darkweb' ? 'critical' : 'high';
  if (source === 'darkweb') return 'high';
  if (source === 'social' || source === 'forum') return 'medium';
  return 'low';
}

function classifyConfidence(target: string, source: IntelSourceType): number {
  let score = 0.45;
  if (source === 'news' || source === 'web') score += 0.2;
  if (source === 'darkweb') score -= 0.1;
  if (target.includes('deepfake') || target.includes('impersonation')) score += 0.2;
  return Math.max(0.1, Math.min(0.99, Number(score.toFixed(2))));
}

function buildSummary(target: string, source: IntelSourceType, severity: IntelSeverity): string {
  return `Potential ${severity} risk signal for '${target}' detected from ${source} source.`;
}

function buildLabels(target: string, source: IntelSourceType): string[] {
  const labels = ['monitoring', source];
  if (target.includes('deepfake')) labels.push('deepfake');
  if (target.includes('impersonation')) labels.push('impersonation');
  if (target.includes('scam') || target.includes('fraud')) labels.push('fraud');
  return labels;
}
