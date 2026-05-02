import type { AssistantMaintenanceConfig } from '../config/types.js';
import type { AgentMemoryStore, StoredMemoryEntry } from './agent-memory-store.js';
import type { CodeSessionRecord, CodeSessionStore } from './code-sessions.js';
import type { MemoryMutationService, MemoryMutationTarget, MemoryScopeHygieneResult } from './memory-mutation-service.js';
import type {
  CapabilityCandidateActionResult,
  CapabilityCandidateEvidence,
  CapabilityCandidateExpireResult,
  CapabilityCandidateInput,
  CapabilityCandidateStore,
} from './capability-candidate-store.js';
import { createLogger } from '../util/logging.js';
import { redactSensitiveText } from '../util/crypto-guardrails.js';

const log = createLogger('automated-maintenance');

export interface AutomatedMaintenanceActivitySnapshot {
  queuedCount: number;
  runningCount: number;
  lastActivityAt?: number;
}

export interface AutomatedMaintenanceScopeResult {
  scope: 'global' | 'code_session';
  scopeId: string;
  changed: boolean;
  reviewedEntries: number;
  archivedExactDuplicates: number;
  archivedNearDuplicates: number;
  archivedStaleSystemEntries: number;
}

export interface AutomatedMaintenanceSweepResult {
  startedAt: number;
  completedAt: number;
  executedScopes: AutomatedMaintenanceScopeResult[];
  identifiedCandidates: AutomatedMaintenanceCandidateResult[];
  candidateHygiene?: CapabilityCandidateExpireResult;
  failedScopes: Array<{
    scope: 'global' | 'code_session';
    scopeId: string;
    error: string;
  }>;
  failedCandidateReviews: Array<{
    scope: 'global' | 'code_session' | 'system';
    scopeId: string;
    error: string;
  }>;
  skippedReason?: 'disabled' | 'already_running' | 'runtime_busy' | 'not_idle' | 'no_due_scopes';
}

export interface AutomatedMaintenanceCandidateResult {
  candidateId: string;
  kind: string;
  status: string;
  title: string;
  changed: boolean;
  scope?: 'global' | 'code_session' | 'system';
  scopeId?: string;
}

export interface AutomatedMaintenanceServiceOptions {
  getConfig: () => AssistantMaintenanceConfig;
  getRuntimeActivity: () => AutomatedMaintenanceActivitySnapshot;
  getPrincipalMemoryScopeId: () => string;
  globalMemoryStore: AgentMemoryStore;
  codeSessionMemoryStore: AgentMemoryStore;
  codeSessionStore: Pick<CodeSessionStore, 'listAllSessions'>;
  memoryMutationService: Pick<MemoryMutationService, 'runMaintenanceForScope'>;
  capabilityCandidateStore?: Pick<CapabilityCandidateStore, 'upsert' | 'expireStale' | 'buildExpiry'>;
  now?: () => number;
}

interface MaintenanceScopeCandidate {
  target: MemoryMutationTarget;
  dueKey: string;
}

export class AutomatedMaintenanceService {
  private readonly getConfig: () => AssistantMaintenanceConfig;
  private readonly getRuntimeActivity: () => AutomatedMaintenanceActivitySnapshot;
  private readonly getPrincipalMemoryScopeId: () => string;
  private readonly globalMemoryStore: AgentMemoryStore;
  private readonly codeSessionMemoryStore: AgentMemoryStore;
  private readonly codeSessionStore: Pick<CodeSessionStore, 'listAllSessions'>;
  private readonly memoryMutationService: Pick<MemoryMutationService, 'runMaintenanceForScope'>;
  private readonly capabilityCandidateStore?: Pick<CapabilityCandidateStore, 'upsert' | 'expireStale' | 'buildExpiry'>;
  private readonly now: () => number;
  private readonly lastSweepByScope = new Map<string, number>();

  private interval: ReturnType<typeof setInterval> | null = null;
  private sweepRunning = false;

  constructor(options: AutomatedMaintenanceServiceOptions) {
    this.getConfig = options.getConfig;
    this.getRuntimeActivity = options.getRuntimeActivity;
    this.getPrincipalMemoryScopeId = options.getPrincipalMemoryScopeId;
    this.globalMemoryStore = options.globalMemoryStore;
    this.codeSessionMemoryStore = options.codeSessionMemoryStore;
    this.codeSessionStore = options.codeSessionStore;
    this.memoryMutationService = options.memoryMutationService;
    this.capabilityCandidateStore = options.capabilityCandidateStore;
    this.now = options.now ?? Date.now;
  }

  start(): ReturnType<typeof setInterval> | null {
    if (this.interval) return this.interval;
    const config = this.getConfig();
    if (!config.enabled) {
      return null;
    }
    this.interval = setInterval(() => {
      void this.runSweep('interval').catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Automated maintenance sweep failed');
      });
    }, Math.max(10_000, config.sweepIntervalMs));
    return this.interval;
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async runSweep(reason: 'interval' | 'manual' = 'manual'): Promise<AutomatedMaintenanceSweepResult> {
    const startedAt = this.now();
    const config = this.getConfig();
    if (!config.enabled) {
      return this.buildSkippedResult(startedAt, 'disabled');
    }
    if (this.sweepRunning) {
      return this.buildSkippedResult(startedAt, 'already_running');
    }

    const activity = this.getRuntimeActivity();
    if ((activity.runningCount + activity.queuedCount) > 0) {
      return this.buildSkippedResult(startedAt, 'runtime_busy');
    }
    if (activity.lastActivityAt && (startedAt - activity.lastActivityAt) < config.idleAfterMs) {
      return this.buildSkippedResult(startedAt, 'not_idle');
    }

    const candidates = this.collectMemoryHygieneCandidates(startedAt, config);
    const learningReviewCandidates = this.collectLearningReviewCandidates(startedAt, config);
    const runCandidateHygiene = this.isCapabilityCandidateHygieneDue(startedAt, config);
    if (candidates.length === 0 && learningReviewCandidates.length === 0 && !runCandidateHygiene) {
      return this.buildSkippedResult(startedAt, 'no_due_scopes');
    }

    const executedScopes: AutomatedMaintenanceScopeResult[] = [];
    const identifiedCandidates: AutomatedMaintenanceCandidateResult[] = [];
    const failedScopes: AutomatedMaintenanceSweepResult['failedScopes'] = [];
    const failedCandidateReviews: AutomatedMaintenanceSweepResult['failedCandidateReviews'] = [];
    let candidateHygiene: CapabilityCandidateExpireResult | undefined;
    this.sweepRunning = true;

    try {
      for (const candidate of candidates) {
        try {
          const result = this.memoryMutationService.runMaintenanceForScope({
            target: candidate.target,
            maintenanceType: 'idle_sweep',
          });
          executedScopes.push(this.toScopeResult(candidate.target, result));
          this.lastSweepByScope.set(candidate.dueKey, startedAt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failedScopes.push({
            scope: candidate.target.scope,
            scopeId: candidate.target.scopeId,
            error: message,
          });
          log.warn({
            scope: candidate.target.scope,
            scopeId: candidate.target.scopeId,
            reason,
            err: message,
          }, 'Automated maintenance skipped a failing scope');
        }
      }

      const learningReviewConfig = config.jobs.learningReview;
      for (const candidate of learningReviewCandidates) {
        if (identifiedCandidates.length >= learningReviewConfig.maxCandidatesPerSweep) break;
        try {
          const results = this.identifyLearningReviewCandidates(
            candidate.target,
            learningReviewConfig,
            learningReviewConfig.maxCandidatesPerSweep - identifiedCandidates.length,
          );
          identifiedCandidates.push(...results);
          this.lastSweepByScope.set(candidate.dueKey, startedAt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failedCandidateReviews.push({
            scope: candidate.target.scope,
            scopeId: candidate.target.scopeId,
            error: message,
          });
          log.warn({
            scope: candidate.target.scope,
            scopeId: candidate.target.scopeId,
            reason,
            err: message,
          }, 'Automated maintenance skipped a failing learning review scope');
        }
      }

      if (runCandidateHygiene && this.capabilityCandidateStore) {
        const jobConfig = config.jobs.capabilityCandidateHygiene;
        try {
          candidateHygiene = this.capabilityCandidateStore.expireStale(
            jobConfig.expireAfterDays,
            jobConfig.maxCandidatesPerSweep,
          );
          this.lastSweepByScope.set('capability_candidate_hygiene:system', startedAt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failedCandidateReviews.push({
            scope: 'system',
            scopeId: 'capability-candidates',
            error: message,
          });
          log.warn({ reason, err: message }, 'Automated maintenance skipped failing capability candidate hygiene');
        }
      }
    } finally {
      this.sweepRunning = false;
    }

    return {
      startedAt,
      completedAt: this.now(),
      executedScopes,
      identifiedCandidates,
      ...(candidateHygiene ? { candidateHygiene } : {}),
      failedScopes,
      failedCandidateReviews,
    };
  }

  private collectMemoryHygieneCandidates(nowMs: number, config: AssistantMaintenanceConfig): MaintenanceScopeCandidate[] {
    const jobConfig = config.jobs.memoryHygiene;
    if (!jobConfig.enabled) {
      return [];
    }

    const principalMemoryScopeId = this.getPrincipalMemoryScopeId();
    const candidates: MaintenanceScopeCandidate[] = [];

    if (
      jobConfig.includeGlobalScope
      && this.globalMemoryStore.isEnabled()
      && !this.globalMemoryStore.isReadOnly()
      && this.globalMemoryStore.getEntries(principalMemoryScopeId, true).length > 0
      && this.isScopeDue(`memory_hygiene:global:${principalMemoryScopeId}`, nowMs, jobConfig.minIntervalMs)
    ) {
      candidates.push({
        target: {
          scope: 'global',
          scopeId: principalMemoryScopeId,
          store: this.globalMemoryStore,
          auditAgentId: principalMemoryScopeId,
        },
        dueKey: `memory_hygiene:global:${principalMemoryScopeId}`,
      });
    }

    if (jobConfig.includeCodeSessions && this.codeSessionMemoryStore.isEnabled() && !this.codeSessionMemoryStore.isReadOnly()) {
      const idleSessions = this.codeSessionStore
        .listAllSessions()
        .filter((session) => this.isIdleCodeSession(session, nowMs, config.idleAfterMs))
        .sort((left, right) => left.lastActivityAt - right.lastActivityAt);

      for (const session of idleSessions) {
        if (candidates.length >= jobConfig.maxScopesPerSweep) break;
        if (this.codeSessionMemoryStore.getEntries(session.id, true).length === 0) continue;
        const dueKey = `memory_hygiene:code_session:${session.id}`;
        if (!this.isScopeDue(dueKey, nowMs, jobConfig.minIntervalMs)) continue;
        candidates.push({
          target: {
            scope: 'code_session',
            scopeId: session.id,
            store: this.codeSessionMemoryStore,
            auditAgentId: principalMemoryScopeId,
          },
          dueKey,
        });
      }
    }

    return candidates.slice(0, jobConfig.maxScopesPerSweep);
  }

  private collectLearningReviewCandidates(nowMs: number, config: AssistantMaintenanceConfig): MaintenanceScopeCandidate[] {
    const jobConfig = config.jobs.learningReview;
    if (!this.capabilityCandidateStore || !jobConfig.enabled) {
      return [];
    }

    const principalMemoryScopeId = this.getPrincipalMemoryScopeId();
    const candidates: MaintenanceScopeCandidate[] = [];

    if (
      jobConfig.includeGlobalScope
      && this.globalMemoryStore.isEnabled()
      && this.globalMemoryStore.getEntries(principalMemoryScopeId, true).length > 0
      && this.isScopeDue(`learning_review:global:${principalMemoryScopeId}`, nowMs, jobConfig.minIntervalMs)
    ) {
      candidates.push({
        target: {
          scope: 'global',
          scopeId: principalMemoryScopeId,
          store: this.globalMemoryStore,
          auditAgentId: principalMemoryScopeId,
        },
        dueKey: `learning_review:global:${principalMemoryScopeId}`,
      });
    }

    if (jobConfig.includeCodeSessions && this.codeSessionMemoryStore.isEnabled()) {
      const idleSessions = this.codeSessionStore
        .listAllSessions()
        .filter((session) => this.isIdleCodeSession(session, nowMs, config.idleAfterMs))
        .sort((left, right) => left.lastActivityAt - right.lastActivityAt);

      for (const session of idleSessions) {
        if (candidates.length >= jobConfig.maxCandidatesPerSweep) break;
        if (this.codeSessionMemoryStore.getEntries(session.id, true).length === 0) continue;
        const dueKey = `learning_review:code_session:${session.id}`;
        if (!this.isScopeDue(dueKey, nowMs, jobConfig.minIntervalMs)) continue;
        candidates.push({
          target: {
            scope: 'code_session',
            scopeId: session.id,
            store: this.codeSessionMemoryStore,
            auditAgentId: principalMemoryScopeId,
          },
          dueKey,
        });
      }
    }

    return candidates.slice(0, jobConfig.maxCandidatesPerSweep);
  }

  private isCapabilityCandidateHygieneDue(nowMs: number, config: AssistantMaintenanceConfig): boolean {
    const jobConfig = config.jobs.capabilityCandidateHygiene;
    return Boolean(
      this.capabilityCandidateStore
      && jobConfig.enabled
      && this.isScopeDue('capability_candidate_hygiene:system', nowMs, jobConfig.minIntervalMs),
    );
  }

  private identifyLearningReviewCandidates(
    target: MemoryMutationTarget,
    config: AssistantMaintenanceConfig['jobs']['learningReview'],
    remainingBudget: number,
  ): AutomatedMaintenanceCandidateResult[] {
    if (!this.capabilityCandidateStore || remainingBudget <= 0) {
      return [];
    }
    const scopeLabel = target.scope === 'global' ? 'global memory' : `code session ${target.scopeId}`;
    const entries = target.store.getEntries(target.scopeId, true);
    const results: AutomatedMaintenanceCandidateResult[] = [];

    const quarantinedEntries = entries
      .filter((entry) => entry.status === 'quarantined')
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, config.maxEvidenceEntries);
    if (quarantinedEntries.length > 0 && results.length < remainingBudget) {
      results.push(this.recordCandidate({
        kind: 'memory_update',
        risk: 'medium',
        title: `Review quarantined memory in ${scopeLabel}`,
        summary: `${quarantinedEntries.length} quarantined memory entr${quarantinedEntries.length === 1 ? 'y needs' : 'ies need'} operator review before it can become active context.`,
        purpose: 'Keep useful memory available while preserving quarantine-first handling for untrusted or tainted content.',
        source: 'learning_review',
        scope: {
          scope: target.scope,
          scopeId: target.scopeId,
          label: scopeLabel,
        },
        evidence: quarantinedEntries.map((entry) => this.toMemoryEvidence(target, entry, 'Quarantined memory entry')),
        proposedChange: 'Inspect the quarantined entries and either reject them or convert the useful parts into reviewed memory.',
        tags: ['memory', 'quarantine', 'review'],
        dedupeKey: `learning_review:quarantined_memory:${target.scope}:${target.scopeId}:${quarantinedEntries.map((entry) => entry.id).sort().join(',')}`,
        expiresAt: this.capabilityCandidateStore.buildExpiry(config.candidateExpiresAfterDays),
      }));
    }

    const contextFlushEntries = entries
      .filter((entry) => (
        entry.status === 'active'
        && entry.tags?.includes('context_flush') === true
      ))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    if (contextFlushEntries.length >= config.minContextFlushEntries && results.length < remainingBudget) {
      const evidence = contextFlushEntries
        .slice(0, config.maxEvidenceEntries)
        .map((entry) => this.toMemoryEvidence(target, entry, 'Context flush signal'));
      results.push(this.recordCandidate({
        kind: 'workflow',
        risk: 'low',
        title: `Curate recurring context in ${scopeLabel}`,
        summary: `${contextFlushEntries.length} active context-flush entries suggest reusable operating knowledge may be accumulating in ${scopeLabel}.`,
        purpose: 'Turn repeated session context into reviewed memory, a workflow note, or a future skill proposal instead of letting it stay as loose flush history.',
        source: 'learning_review',
        scope: {
          scope: target.scope,
          scopeId: target.scopeId,
          label: scopeLabel,
        },
        evidence,
        proposedChange: 'Review the attached context flushes and consolidate durable patterns into an operator-curated wiki page or a separate skill candidate.',
        tags: ['memory', 'curation', 'workflow'],
        dedupeKey: `learning_review:context_flush_curation:${target.scope}:${target.scopeId}`,
        expiresAt: this.capabilityCandidateStore.buildExpiry(config.candidateExpiresAfterDays),
      }));
    }

    return results;
  }

  private recordCandidate(input: CapabilityCandidateInput): AutomatedMaintenanceCandidateResult {
    const result: CapabilityCandidateActionResult = this.capabilityCandidateStore!.upsert(input);
    return {
      candidateId: result.candidate.id,
      kind: result.candidate.kind,
      status: result.candidate.status,
      title: result.candidate.title,
      changed: result.changed,
      scope: result.candidate.scope?.scope,
      scopeId: result.candidate.scope?.scopeId,
    };
  }

  private toMemoryEvidence(
    target: MemoryMutationTarget,
    entry: StoredMemoryEntry,
    titlePrefix: string,
  ): CapabilityCandidateEvidence {
    const title = redactSensitiveText(this.describeMemoryEntry(entry));
    return {
      type: 'memory_entry',
      title: `${titlePrefix}: ${title}`,
      detail: redactSensitiveText(entry.summary || entry.content.slice(0, 240)),
      scope: target.scope,
      scopeId: target.scopeId,
      entryId: entry.id,
      createdAt: entry.createdAt,
    };
  }

  private describeMemoryEntry(entry: StoredMemoryEntry): string {
    return entry.artifact?.title?.trim()
      || entry.summary?.trim()?.slice(0, 80)
      || entry.content.trim().slice(0, 80)
      || entry.id;
  }

  private isIdleCodeSession(session: CodeSessionRecord, nowMs: number, idleAfterMs: number): boolean {
    return session.lastActivityAt > 0 && (nowMs - session.lastActivityAt) >= idleAfterMs;
  }

  private isScopeDue(key: string, nowMs: number, minIntervalMs: number): boolean {
    const lastRunAt = this.lastSweepByScope.get(key);
    return !lastRunAt || (nowMs - lastRunAt) >= minIntervalMs;
  }

  private toScopeResult(target: MemoryMutationTarget, result: MemoryScopeHygieneResult): AutomatedMaintenanceScopeResult {
    return {
      scope: target.scope,
      scopeId: target.scopeId,
      changed: result.changed,
      reviewedEntries: result.reviewedEntries,
      archivedExactDuplicates: result.archivedExactDuplicates,
      archivedNearDuplicates: result.archivedNearDuplicates,
      archivedStaleSystemEntries: result.archivedStaleSystemEntries,
    };
  }

  private buildSkippedResult(
    startedAt: number,
    skippedReason: AutomatedMaintenanceSweepResult['skippedReason'],
  ): AutomatedMaintenanceSweepResult {
    return {
      startedAt,
      completedAt: this.now(),
      executedScopes: [],
      identifiedCandidates: [],
      failedScopes: [],
      failedCandidateReviews: [],
      skippedReason,
    };
  }
}
